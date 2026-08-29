import { TextureManager } from './textureManager';
import { Logger } from '../../core/logger';

// -------------------------------------------------------------------------------------------------
// Reading a height field on the CPU, for terrain layer displacement.
//
// Terrain can raise its own VERTICES by a paint layer's height map instead of only marching it per
// fragment (`Terrain._rebuildRenderHeights`). That bake runs in JS, so it needs the height map's pixels
// and it needs to sample them the way the GPU does — which is the whole subject of this file.
//
// THE SAMPLE RATE IS THE WHOLE PROBLEM, so it is worth stating up front. Terrain vertex spacing is
// `size / (resolution - 1)`, and a layer height map tiles `tiling` times across the terrain, so the
// number of vertices covering one repeat of the map is `(resolution - 1) / tiling`. At the editor
// defaults — 200 m, resolution 129, tiling 20 — that is 6.4 vertices per tile. A 1024-texel map sampled
// at 6.4 points per tile is undersampled by a factor of 160, and undersampled detail does not
// disappear: it FOLDS DOWN into low-frequency beat patterns. That is what a point sample of a detailed
// height map looks like on terrain — big soft blobs that have nothing to do with the texture.
//
// So the bake must sample band-limited to the vertex spacing, which is what `buildMipPyramid` and
// `sampleHeightLod` are for. Filtering removes the blobs; it cannot invent detail the grid has no
// vertices to carry, and that missing detail is handed back to the parallax march as a residual — see
// `chunks/terrainLayers.wgsl`.
// -------------------------------------------------------------------------------------------------

/** A height field sampled on the CPU: tightly packed RGBA8 rows, as `getImageData` hands them over. */
export interface HeightField {
    data: Uint8Array;
    width: number;
    height: number;
}

/** Bilinear sample of the RED channel, in 0..1, with wrapping. Matches `textureSampleLevel` on repeat. */
export function sampleHeight(field: HeightField, u: number, v: number, invert: boolean): number {
    const { data, width, height } = field;
    // Half-texel offset so integer uv lands on a texel CENTRE, which is where the GPU samples. Without
    // it the whole field shifts by half a texel against every other map on the material.
    const x = u * width - 0.5, y = v * height - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const wrap = (i: number, n: number) => ((i % n) + n) % n;
    const xs = [wrap(x0, width), wrap(x0 + 1, width)];
    const ys = [wrap(y0, height), wrap(y0 + 1, height)];

    const at = (xi: number, yi: number) => data[(yi * width + xi) * 4] / 255;
    const top = at(xs[0], ys[0]) * (1 - fx) + at(xs[1], ys[0]) * fx;
    const bot = at(xs[0], ys[1]) * (1 - fx) + at(xs[1], ys[1]) * fx;
    const h = top * (1 - fy) + bot * fy;
    return invert ? 1 - h : h;
}

/**
 * A mip pyramid of `field`, level 0 being the field itself.
 *
 * REPEATED 2x2 BOX, one level at a time, and that is a hard requirement rather than the obvious
 * implementation. The shader subtracts the GPU's mips of the same map (`Texture.generateMipmaps`, which
 * is a repeated 2x2 box) to get the residual it marches. If this filter were anything else — a one-shot
 * area average over 2^k texels, a Gaussian, a Lanczos — the two halves of the band split would be
 * filtering the same data differently, `low + residual` would stop equalling `full`, and the surface
 * would sit off by a smooth low-frequency error. Which is precisely the "the height does not match the
 * texture" symptom this whole mechanism exists to remove.
 *
 * Odd dimensions round down, matching the usual GL rule; the chain stops at 1x1.
 */
export function buildMipPyramid(field: HeightField): HeightField[] {
    const levels: HeightField[] = [field];
    let current = field;
    while (current.width > 1 || current.height > 1) {
        const w = Math.max(1, current.width >> 1);
        const h = Math.max(1, current.height >> 1);
        const data = new Uint8Array(w * h * 4);
        const src = current;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                // Clamped, so an odd dimension's last column or row averages with itself rather than
                // wrapping into the opposite edge — the same thing the driver does.
                const x0 = Math.min(x * 2, src.width - 1), x1 = Math.min(x * 2 + 1, src.width - 1);
                const y0 = Math.min(y * 2, src.height - 1), y1 = Math.min(y * 2 + 1, src.height - 1);
                const at = (xi: number, yi: number) => src.data[(yi * src.width + xi) * 4];
                data[(y * w + x) * 4] = Math.round((at(x0, y0) + at(x1, y0) + at(x0, y1) + at(x1, y1)) / 4);
            }
        }
        current = { data, width: w, height: h };
        levels.push(current);
    }
    return levels;
}

/**
 * Sample a pyramid at a fractional mip level: bilinear within each of the two bracketing levels, then
 * linear between them. The CPU twin of `textureSampleLevel` with trilinear filtering.
 *
 * `lod` below 0 or past the last level clamps, exactly as the sampler does.
 */
export function sampleHeightLod(pyramid: HeightField[], u: number, v: number,
                                lod: number, invert: boolean): number {
    const top = pyramid.length - 1;
    const clamped = Math.max(0, Math.min(top, lod));
    const lo = Math.floor(clamped);
    const t = clamped - lo;

    // Inverted once at the end rather than per level: `1 - mix(a, b)` and `mix(1 - a, 1 - b)` agree, and
    // doing it once here keeps this bit-identical to `sampleHeight` at level 0.
    const a = sampleHeight(pyramid[lo], u, v, false);
    const h = t > 0 ? a + (sampleHeight(pyramid[Math.min(top, lo + 1)], u, v, false) - a) * t : a;
    return invert ? 1 - h : h;
}

/**
 * Smallest tiling a layer may be sampled at. The authoring inputs are unbounded number fields, and a
 * tiling of 0 or below turns `log2(tiling)` in the shader into -inf or NaN and divides by zero here.
 * One constant so the CPU and the shader clamp identically rather than at two different epsilons.
 */
export const TILING_EPSILON = 0.01;

/**
 * The shader's `band()` — a smoothstepped range test — for the CPU side of the automatic height and
 * slope mask. Kept here beside the other JS twins of shader functions rather than in `terrain.ts`, so
 * that "this exists to match a shader" is visible from its home.
 */
export function band(range: readonly number[], v: number, edge: number): number {
    const smoothstep = (a: number, b: number, x: number) => {
        const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-12)));
        return t * t * (3 - 2 * t);
    };
    const lo = smoothstep(range[0] - edge, range[0] + edge, v);
    const hi = 1 - smoothstep(range[1] - edge, range[1] + edge, v);
    return Math.min(1, Math.max(0, lo * hi));
}

/**
 * The average value of a height field, in 0..1.
 *
 * FREE: the top of a mip pyramid is a 1x1 reduction, and a repeated 2x2 box reduction down to one texel
 * IS the arithmetic mean (give or take the rounding at each level, and the clamped duplicate rows an odd
 * dimension introduces). No second pass over the base level.
 *
 * It exists because displacement is CENTRED on it — see `Terrain._displacementAt`. Parallax could only
 * carve INTO a surface, so a height map read as pits below the ground it was painted on. Geometry
 * displacement only adds, so the same map reads as bumps and the painted region steps up against
 * unpainted ground beside it — which is what "I have to invert the height map" actually was. Subtracting
 * the mean puts relief both above and below the sculpted surface and removes the step.
 */
export function pyramidMean(pyramid: HeightField[], invert: boolean): number {
    const top = pyramid[pyramid.length - 1];
    const m = top.data[0] / 255;
    return invert ? 1 - m : m;
}

/**
 * The range of the RESIDUAL — what a height map has left once the band the geometry carries is taken
 * out of it — as `{ top, bot }`, the largest and smallest value of `H_full - H_low` over the map.
 *
 * This is the other half of the split. `displaceSplitLod` says where to cut; the bake takes everything
 * at or below that frequency and turns it into vertices, and the parallax march takes what is left.
 * Without the march the fine half is simply DISCARDED, which at landscape scale is nearly all of it:
 * a 200 m terrain at tiling 20 cuts at mip 5.3, so a 1024 map contributes a 26x26 reduction of itself
 * to the geometry and nothing else reaches the screen.
 *
 * Two numbers rather than one because parallax can only carve INWARD. The bake lifts its surface by
 * `amplitude * top` so the marched field hangs below it, and the march then carves back down through
 * `top - bot`; the two cancel on average, so the shaded surface is exactly `H_full` mean-centred while
 * every step of it stays representable by a technique that only removes material.
 *
 * SUBSAMPLED to at most 256x256 and cached. The extremes of a natural height map are not carried by
 * single texels, and this is called per chunk refresh — a full pass over a 1024 map per chunk would be
 * 16 million samples for a number that changes only when the map or the split level does. An
 * underestimate is harmless: it makes the march marginally shallower, never misaligned.
 */
export function pyramidResidualBounds(pyramid: HeightField[], lod: number,
                                      invert: boolean): { top: number, bot: number } {
    const base = pyramid[0];
    const key = `${base.width}x${base.height}:${lod.toFixed(3)}:${invert ? 1 : 0}`;
    const hit = residuals.get(pyramid);
    const cached = hit?.get(key);
    if (cached) return cached;

    const steps = 256;
    const nx = Math.min(steps, base.width), ny = Math.min(steps, base.height);
    let top = -Infinity, bot = Infinity;
    for (let y = 0; y < ny; y++) {
        const v = (y + 0.5) / ny;
        for (let x = 0; x < nx; x++) {
            const u = (x + 0.5) / nx;
            // Level 0 explicitly, not `sampleHeightLod(.., 0, ..)`, so the full half of the difference
            // is the unfiltered map however the pyramid was built.
            const full = sampleHeight(base, u, v, invert);
            const low = sampleHeightLod(pyramid, u, v, lod, invert);
            const r = full - low;
            if (r > top) top = r;
            if (r < bot) bot = r;
        }
    }
    // A map cut at or below its own resolution has no residual at all; `top === bot === 0` then, and
    // every consumer multiplies by `top - bot`, so the march contributes nothing rather than dividing
    // by zero. Guarded anyway, because a degenerate 1x1 map reaches here.
    const out = isFinite(top) ? { top, bot } : { top: 0, bot: 0 };
    if (hit) hit.set(key, out);
    else residuals.set(pyramid, new Map([[key, out]]));
    return out;
}

/** Residual bounds by pyramid, then by split level — see `pyramidResidualBounds`. */
const residuals: WeakMap<HeightField[], Map<string, { top: number, bot: number }>> = new WeakMap();

/**
 * The mip level of a layer's height map whose texel covers exactly one terrain vertex.
 *
 * Everything finer than this is detail the vertex grid cannot represent, so it is both what the bake
 * samples at and what the shader subtracts to get the residual it marches. The two sides MUST use the
 * same number, or the geometry and the march overlap and the relief is partly applied twice.
 *
 *   texels per tile   = packedWidth
 *   vertices per tile = (resolution - 1) * density / tiling
 *   texels per vertex = packedWidth * tiling / ((resolution - 1) * density)
 *
 * Returns 0 when the grid already out-samples the map — there is nothing to band-limit then, so a
 * caller can read "0 or less" as "not split".
 */
export function displaceSplitLod(packedWidth: number, tiling: number,
                                 resolution: number, density: number = 1): number {
    const perRepeat = vertsPerRepeat(tiling, resolution, density);
    if (perRepeat <= 0) return 0;
    return Math.max(0, Math.log2(Math.max(packedWidth, 1) / perRepeat));
}

/**
 * Terrain vertices across one texture repeat - the single number that decides how much of a height map
 * the geometry can carry, and the one the editor had no way to show.
 *
 * It is dimensionless on purpose: `size / tiling` metres divided by `size / ((resolution-1)*density)`
 * metres cancels the size, so a repeat 12 vertices wide is 12 vertices wide on any terrain that spans
 * it the same way. The editor quotes the two lengths because metres are what an author can picture, but
 * the threshold it warns at is this ratio, read from here rather than re-derived, so the warning and the
 * split can never disagree about when the geometry starts reproducing the texture.
 *
 * Above roughly 4 the vertex grid resolves the map's own features and turns them into ground shape - a
 * brick becomes a plateau. Below 1 the geometry gets nothing and terrain behaves like any other
 * material: all march.
 */
export function vertsPerRepeat(tiling: number, resolution: number, density: number = 1): number {
    return ((resolution - 1) * Math.max(1, density)) / Math.max(tiling, 1e-6);
}

/** Above this many vertices per repeat the geometry half carves the texture into terrain. */
export const CARVE_VERTS_PER_REPEAT = 4;

// -------------------------------------------------------------------------------------------------
// Height pixels, through a canvas.
// -------------------------------------------------------------------------------------------------

/** Decoded height pixels by texture id; a null marks a read that failed and must not be retried. */
const fields: Map<string, HeightField | null> = new Map();
/** Pyramids, built lazily beside the field they came from. */
const pyramids: Map<string, HeightField[]> = new Map();

/**
 * A height map's pixels, or null while the image has not decoded.
 *
 * `Terrain.importHeightmap` and `Loader.ImageToArray` are this operation already written; this is a
 * third caller with a cache, because the read is the expensive part of the bake and a height map is
 * typically shared by every layer that uses it.
 *
 * RETRY, DON'T WAIT. `TextureManager` registers an id synchronously and fills the pixels later, with no
 * event and no promise, so a zero width means "not yet", never "broken". Callers draw undisplaced and
 * ask again next frame — the same idiom `TexturePacker` uses.
 */
export function heightField(id: string): HeightField | null {
    const cached = fields.get(id);
    if (cached !== undefined) return cached;

    const image = TextureManager.Instance.getTexture(id)?.data;
    if (!image || !(image instanceof HTMLImageElement) || image.width === 0) return null;

    try {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;

        // DRAWN UPSIDE DOWN, ON PURPOSE — so the rows come out in TEXTURE order, not image order.
        //
        // `getImageData` hands back row 0 = the TOP of the image, but every `HTMLImageElement` upload in
        // this engine is flipped: `Texture._flipY` defaults to false and both backends negate it
        // (`gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, !this._flipY)`, and WebGPU's
        // `flipY: !(config.flipY ?? true)`). So on the GPU `v = 0` is the image's LAST row. Reading the
        // pixels straight meant the CPU bake displaced at `v` while the shader shaded at `1 - v`: a
        // height map's relief came out mirrored about each tile's V centre, and a rock in the corner of
        // the texture raised the ground in a different corner.
        //
        // Flipping HERE rather than inside `sampleHeight` is deliberate. Everything downstream —
        // `sampleHeightLod`, `buildMipPyramid`'s 2x2 reduction, `pyramidMean` — then operates in texture
        // space with no per-reader correction to remember, and the WebGPU compute bake, which already
        // works in texture space, agrees with the JS one for free. A `1 - v` in the sampler would have
        // had to be repeated in the pyramid and the mean, and re-derived by every future reader.
        //
        // The splat map is the counter-example that proves the rule: it is uploaded through
        // `uploadBytes`, which explicitly disables the flip, so `Terrain._splatAt` indexes it top-down.
        ctx.translate(0, image.height);
        ctx.scale(1, -1);
        ctx.drawImage(image, 0, 0);

        const pixels = ctx.getImageData(0, 0, image.width, image.height);
        const field: HeightField = {
            data: new Uint8Array(pixels.data.buffer.slice(0)),
            width: image.width,
            height: image.height,
        };
        fields.set(id, field);
        return field;
    } catch (e) {
        // A cross-origin image taints the canvas and getImageData throws. Cache the FAILURE rather than
        // retrying it every frame for the life of the scene.
        fields.set(id, null);
        Logger.warn(`Cannot read height map ${id} for displacement: ${e}`, 'displacement');
        return null;
    }
}

/** {@link heightField}'s pixels as a mip pyramid, built once and cached. */
export function heightPyramid(id: string): HeightField[] | null {
    const hit = pyramids.get(id);
    if (hit) return hit;
    const field = heightField(id);
    if (!field) return null;
    const built = buildMipPyramid(field);
    pyramids.set(id, built);
    return built;
}

/** Drop a texture's pixels, so a re-imported height map re-reads rather than reusing stale bytes. */
export function invalidateHeightField(id: string): void {
    fields.delete(id);
    pyramids.delete(id);
}
