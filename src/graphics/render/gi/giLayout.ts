/**
 * Where GI Volume data lives, free of GL so every address is unit-tested.
 *
 * THREE KINDS OF TEXTURE, all 2D (WebGL2 and WebGPU alike):
 * - the HIT CACHE, one set per volume: each probe's rays as an octahedral tile (8x8 for 64 rays, 16x16 for
 *   256), 64 probes to a row. What a ray hit (albedo, normal, distance, emissive) — the capture, and the
 *   bytes a bake saves.
 * - the IRRADIANCE atlas, shared by every volume: 8x8 per probe, a 6x6 octahedral interior and a one-texel
 *   border, the irradiance (E/pi) arriving from each direction. What the relight writes and the lighting
 *   reads.
 * - the VISIBILITY atlas, shared: 16x16 per probe (14x14 and a border), the mean and mean square of the
 *   distance to the scene in each direction. What keeps a probe behind a wall from lighting this side
 *   (Chebyshev, DDGI).
 *
 * THE BORDER. Each tile repeats, round its edge, the interior texels just across the octahedron's fold
 * ({@link tileBorderSource}), so one bilinear fetch near an edge blends the right neighbours.
 *
 * A probe has a GLOBAL index in the shared atlases (its volume's base plus its own) and a LOCAL one in its
 * volume's hit cache: probe (i, j, k) is local `i + nx * (j + ny * k)`.
 *
 * Directions use chunks/octNormal.wgsl's octahedral encoding — the G-buffer's and the reflection atlas's
 * (reflectionAtlas.ts `octEncodeDir`, pinned equal by tests/giLayout.test.ts) — so a shader and this file
 * agree on which texel is which direction. The copies here keep this module free of the device.
 */

// --- The octahedral map (chunks/octNormal.wgsl) ---

export type Vec3 = [number, number, number];

/** The fold of chunks/octNormal.wgsl `octWrap`. */
function octWrap(x: number, y: number): [number, number] {
    return [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
}

/** A direction to [-1, 1]^2: chunks/octNormal.wgsl `octEncode`. */
export function giOctEncode(d: ArrayLike<number>): [number, number] {
    const l1 = Math.max(Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]), 1e-6);
    const x = d[0] / l1, y = d[1] / l1;
    return d[2] >= 0 ? [x, y] : octWrap(x, y);
}

/** [-1, 1]^2 to the octahedron's surface, before normalizing: chunks/octNormal.wgsl `octDecode`. */
function octDecodeRaw(u: number, v: number): Vec3 {
    const z = 1 - Math.abs(u) - Math.abs(v);
    if (z < 0) {
        const w = octWrap(u, v);
        return [w[0], w[1], z];
    }
    return [u, v, z];
}

/** [-1, 1]^2 to a unit direction: chunks/octNormal.wgsl `octDecode`. */
export function giOctDecode(u: number, v: number): Vec3 {
    const p = octDecodeRaw(u, v);
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / len, p[1] / len, p[2] / len];
}

/**
 * A point just OUTSIDE [-1, 1]^2 to the point inside it that the octahedron's fold makes its neighbour:
 * past an edge the map continues mirrored along that edge, past a corner at the opposite corner.
 */
export function giOctWrapOutside(u: number, v: number): [number, number] {
    let x = u, y = v;
    if (y > 1) { x = -x; y = 2 - y; } else if (y < -1) { x = -x; y = -2 - y; }
    if (x > 1) { y = -y; x = 2 - x; } else if (x < -1) { y = -y; x = -2 - x; }
    return [x, y];
}

// --- Tiles ---

/** Interior and full side of a probe's irradiance tile. */
export const GI_IRRADIANCE_INTERIOR = 6;
export const GI_IRRADIANCE_TILE = GI_IRRADIANCE_INTERIOR + 2;
/** Interior and full side of a probe's visibility tile. */
export const GI_VISIBILITY_INTERIOR = 14;
export const GI_VISIBILITY_TILE = GI_VISIBILITY_INTERIOR + 2;
/** Probes to a row of a volume's hit cache. */
export const GI_HIT_PROBES_PER_ROW = 64;
/** The texture side WebGL2 guarantees; the atlases fit it unless the device allows more. */
export const GI_MIN_TEXTURE_SIZE = 2048;
/** The largest atlas side used even where the device allows more. */
export const GI_MAX_ATLAS_SIZE = 4096;

/** Side of a probe's hit tile for a ray count (64 -> 8, 256 -> 16). */
export function giRaySide(rays: number): number {
    return rays === 256 ? 16 : 8;
}

/**
 * The interior texel of an `n`-texel octahedral tile that tile texel (`tx`, `ty`) shows — itself inside,
 * its fold neighbour on the one-texel border (0 and n + 1). Coordinates are the tile's, border included:
 * 0..n+1 in, 0..n-1 out.
 */
export function tileBorderSource(n: number, tx: number, ty: number): [number, number] {
    const inX = tx >= 1 && tx <= n, inY = ty >= 1 && ty <= n;
    if (inX && inY) return [tx - 1, ty - 1];
    if (inX) return [n - tx, ty === 0 ? 0 : n - 1];          // top/bottom edge: mirrored along it
    if (inY) return [tx === 0 ? 0 : n - 1, n - ty];          // left/right edge
    return [tx === 0 ? n - 1 : 0, ty === 0 ? n - 1 : 0];     // corner: the opposite interior corner
}

/** The direction at the centre of interior texel (`x`, `y`) of an `n`-texel octahedral tile. */
export function tileTexelDirection(n: number, x: number, y: number): Vec3 {
    return giOctDecode(((x + 0.5) / n) * 2 - 1, ((y + 0.5) / n) * 2 - 1);
}

/** Every interior texel's direction, row-major, xyz interleaved. */
export function tileDirections(n: number): Float32Array {
    const out = new Float32Array(n * n * 3);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const d = tileTexelDirection(n, x, y);
            out.set(d, (y * n + x) * 3);
        }
    }
    return out;
}

const _solidAngleCache = new Map<number, Float32Array>();

/**
 * The solid angle each interior texel of an `n`-texel octahedral tile covers, row-major, summing to 4 pi.
 *
 * The map is not equal-area: a texel at a face centre, where the octahedron passes nearest the origin,
 * covers up to 3 sqrt 3 times the sphere a texel at a vertex does. On the uv square the area element is du dv / |p|^3, p the octahedron point (each face's area
 * is sqrt 3 times its shadow on uv, and a patch of it at p subtends cos / r^2 = 1 / (sqrt 3 |p|^3)), so a
 * texel's share is that integrated over it — numerically here, 16x16 points a texel, then scaled so the
 * whole sphere is exactly 4 pi. These are the weights the relight integrates a probe's rays with.
 */
export function tileSolidAngles(n: number): Float32Array {
    const cached = _solidAngleCache.get(n);
    if (cached) return cached;
    const sub = 16;
    const out = new Float32Array(n * n);
    const step = 2 / n, d = step / sub;
    let total = 0;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            let sum = 0;
            for (let sy = 0; sy < sub; sy++) {
                for (let sx = 0; sx < sub; sx++) {
                    const u = -1 + x * step + (sx + 0.5) * d, v = -1 + y * step + (sy + 0.5) * d;
                    const p = octDecodeRaw(u, v);
                    const r = Math.hypot(p[0], p[1], p[2]);
                    sum += 1 / (r * r * r);
                }
            }
            const omega = sum * d * d;
            out[y * n + x] = omega;
            total += omega;
        }
    }
    const k = (4 * Math.PI) / total;
    for (let i = 0; i < out.length; i++) out[i] *= k;
    _solidAngleCache.set(n, out);
    return out;
}

/** The un-normalized integral of {@link tileSolidAngles} (should be 4 pi): what the test checks the map with. */
export function tileSolidAngleIntegral(n: number, sub: number = 16): number {
    const step = 2 / n, d = step / sub;
    let sum = 0;
    for (let y = 0; y < n * sub; y++) {
        for (let x = 0; x < n * sub; x++) {
            const p = octDecodeRaw(-1 + (x + 0.5) * d, -1 + (y + 0.5) * d);
            const r = Math.hypot(p[0], p[1], p[2]);
            sum += 1 / (r * r * r);
        }
    }
    return sum * d * d;
}

// --- Grids ---

/** A probe's local index in its volume from its grid coordinates. */
export function gridIndex(i: number, j: number, k: number, counts: ArrayLike<number>): number {
    return i + counts[0] * (j + counts[1] * k);
}

/** A probe's grid coordinates from its local index. */
export function gridCoords(index: number, counts: ArrayLike<number>): [number, number, number] {
    const nx = counts[0], ny = counts[1];
    const i = index % nx;
    const j = Math.floor(index / nx) % ny;
    const k = Math.floor(index / (nx * ny));
    return [i, j, k];
}

/**
 * The eight probes round a fractional grid point and their trilinear weights: the cage the lighting
 * blends. The point is clamped into the grid, so a point on the box's faces still has a whole cage.
 * `outIndex` receives local probe indices, `outWeight` the weights (summing to 1), in the order
 * (di, dj, dk) = bits 0, 1, 2 of the slot.
 */
export function gridCage(g: ArrayLike<number>, counts: ArrayLike<number>,
                         outIndex: Int32Array | number[], outWeight: Float32Array | number[]): void {
    const base = [0, 0, 0], frac = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
        const n = counts[a];
        const c = Math.min(n - 1, Math.max(0, g[a]));
        const b = Math.min(n - 2, Math.floor(c));
        base[a] = b;
        frac[a] = c - b;
    }
    for (let s = 0; s < 8; s++) {
        const di = s & 1, dj = (s >> 1) & 1, dk = (s >> 2) & 1;
        outIndex[s] = gridIndex(base[0] + di, base[1] + dj, base[2] + dk, counts);
        outWeight[s] = (di ? frac[0] : 1 - frac[0]) * (dj ? frac[1] : 1 - frac[1]) * (dk ? frac[2] : 1 - frac[2]);
    }
}

// --- Atlas addressing ---

/** How the shared atlases are laid out on a device: tiles to a row, and how many probes they hold. */
export interface GiAtlasLayout {
    /** The atlas side the device allows, capped at {@link GI_MAX_ATLAS_SIZE}. */
    maxSize: number;
    irradiancePerRow: number;
    visibilityPerRow: number;
    /** Probe-data texels to a row (one texel a probe). */
    probeDataPerRow: number;
    /** Probes the atlases can hold at most (the visibility atlas is the one that fills first). */
    capacity: number;
}

export function giAtlasLayout(maxTextureSize: number): GiAtlasLayout {
    const maxSize = Math.min(GI_MAX_ATLAS_SIZE, Math.max(GI_MIN_TEXTURE_SIZE, Math.floor(maxTextureSize) || GI_MIN_TEXTURE_SIZE));
    const irradiancePerRow = Math.floor(maxSize / GI_IRRADIANCE_TILE);
    const visibilityPerRow = Math.floor(maxSize / GI_VISIBILITY_TILE);
    const capacity = Math.min(irradiancePerRow * irradiancePerRow, visibilityPerRow * visibilityPerRow);
    return { maxSize, irradiancePerRow, visibilityPerRow, probeDataPerRow: maxSize, capacity };
}

/** Texel origin (top-left of the border) of global probe `g`'s irradiance tile. */
export function irradianceTileOrigin(layout: GiAtlasLayout, g: number): [number, number] {
    return [(g % layout.irradiancePerRow) * GI_IRRADIANCE_TILE, Math.floor(g / layout.irradiancePerRow) * GI_IRRADIANCE_TILE];
}

/** Texel origin of global probe `g`'s visibility tile. */
export function visibilityTileOrigin(layout: GiAtlasLayout, g: number): [number, number] {
    return [(g % layout.visibilityPerRow) * GI_VISIBILITY_TILE, Math.floor(g / layout.visibilityPerRow) * GI_VISIBILITY_TILE];
}

/** Texel of global probe `g` in the probe-data texture. */
export function probeDataTexel(layout: GiAtlasLayout, g: number): [number, number] {
    return [g % layout.probeDataPerRow, Math.floor(g / layout.probeDataPerRow)];
}

/** Size of the three shared atlases for `probes` probes (whole rows, at least one). */
export function giAtlasSizes(layout: GiAtlasLayout, probes: number): {
    irradiance: [number, number]; visibility: [number, number]; probeData: [number, number];
} {
    const n = Math.max(1, Math.ceil(probes));
    const rows = (perRow: number) => Math.max(1, Math.ceil(n / perRow));
    return {
        irradiance: [layout.irradiancePerRow * GI_IRRADIANCE_TILE, rows(layout.irradiancePerRow) * GI_IRRADIANCE_TILE],
        visibility: [layout.visibilityPerRow * GI_VISIBILITY_TILE, rows(layout.visibilityPerRow) * GI_VISIBILITY_TILE],
        probeData: [layout.probeDataPerRow, rows(layout.probeDataPerRow)],
    };
}

/** Size of a volume's hit cache: 64 probes to a row, one ray-side tile each. */
export function hitCacheSize(probes: number, rays: number): [number, number] {
    const side = giRaySide(rays);
    return [GI_HIT_PROBES_PER_ROW * side, Math.max(1, Math.ceil(probes / GI_HIT_PROBES_PER_ROW)) * side];
}

/** Texel origin of local probe `p`'s tile in its volume's hit cache. */
export function hitTileOrigin(p: number, rays: number): [number, number] {
    const side = giRaySide(rays);
    return [(p % GI_HIT_PROBES_PER_ROW) * side, Math.floor(p / GI_HIT_PROBES_PER_ROW) * side];
}

/** The most probes one volume may have for its hit cache to fit a `maxTextureSize` texture. */
export function maxProbesPerVolume(rays: number, maxTextureSize: number): number {
    const side = giRaySide(rays);
    const size = Math.max(GI_MIN_TEXTURE_SIZE, Math.floor(maxTextureSize) || GI_MIN_TEXTURE_SIZE);
    return GI_HIT_PROBES_PER_ROW * Math.floor(size / side);
}

/** GPU bytes one probe costs: its hit tile (3 x rgba8), irradiance and visibility (rgba16f), probe data (rgba32f). */
export function giProbeBytes(rays: number): number {
    return rays * 12 + GI_IRRADIANCE_TILE * GI_IRRADIANCE_TILE * 8 + GI_VISIBILITY_TILE * GI_VISIBILITY_TILE * 8 + 16;
}
