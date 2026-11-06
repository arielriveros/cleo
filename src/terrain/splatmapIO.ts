// Splatmaps, weightmaps and the world manifest: reading a texturing export (the Cleo Creator's World, or
// any tool that writes the same industry-standard files) into what a landscape's layer stack paints with.
//
// Two layouts carry the same thing, NORMALIZED WEIGHTS (each texel's layers sum to one):
//   - splatmaps: RGBA8 PNGs, four layers per image (Unity alphamaps, Godot, custom shaders);
//   - weightmaps: one 8-bit grey PNG per layer (Unreal weight-blended layers, Gaea, Blender).
// The engine's stack composites front-to-back "over" instead (terrainLayers.ts `compositeWeights`), so
// weights are turned into over-alphas here. Normalized weights do not depend on any layer order, which is
// why they are the interchange format: the importer picks the order (the landscape material's slots).
//
// Texels are CENTRED: texel (c, r) covers the square around (c + 0.5, r + 0.5) / res of the landscape,
// row 0 at the -Z edge and column 0 at -X — the same convention as the paint masks (terrainMasks.ts).
//
// Shader-free and DOM-free (the PNG inflate is the platform's DecompressionStream), so a worker can import
// it as `cleo/terrain/splatmapIO`.

import { parsePng } from './heightmapIO';

/** A PNG with every channel kept, at the file's depth. */
export interface DecodedPng {
    width: number;
    height: number;
    /** 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA. A palette image expands to 3, or 4 with a tRNS chunk. */
    channels: 1 | 2 | 3 | 4;
    /** 16 only for 16-bit grey/RGB files; sub-byte and palette images come out as 8. */
    bitDepth: 8 | 16;
    /** Interleaved samples, row 0 at the top. */
    data: Uint8Array | Uint16Array;
}

/** Decode a PNG keeping every channel (the canvas path premultiplies alpha, which destroys splat RGB). */
export async function decodePngChannels(bytes: Uint8Array): Promise<DecodedPng> {
    const { width, height, bitDepth, colorType, channels, stride, rows, palette, transparency } = await parsePng(bytes);
    const texels = width * height;

    if (colorType === 3) {
        if (!palette) throw new Error('Palette PNG has no PLTE chunk');
        const outCh = transparency ? 4 : 3;
        const out = new Uint8Array(texels * outCh);
        const mask = (1 << bitDepth) - 1;
        for (let y = 0; y < height; y++) {
            const row = y * stride;
            for (let x = 0; x < width; x++) {
                const bit = x * bitDepth;
                const index = bitDepth === 8 ? rows[row + x] : (rows[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & mask;
                const o = (y * width + x) * outCh;
                out[o] = palette[index * 3] ?? 0;
                out[o + 1] = palette[index * 3 + 1] ?? 0;
                out[o + 2] = palette[index * 3 + 2] ?? 0;
                if (outCh === 4) out[o + 3] = transparency![index] ?? 255;
            }
        }
        return { width, height, channels: outCh, bitDepth: 8, data: out };
    }

    const ch = channels as 1 | 2 | 3 | 4;
    if (bitDepth === 16) {
        const out = new Uint16Array(texels * ch);
        for (let y = 0; y < height; y++) {
            const row = y * stride;
            for (let i = 0; i < width * ch; i++) out[y * width * ch + i] = (rows[row + i * 2] << 8) | rows[row + i * 2 + 1];
        }
        return { width, height, channels: ch, bitDepth: 16, data: out };
    }
    if (bitDepth === 8) {
        const out = new Uint8Array(texels * ch);
        for (let y = 0; y < height; y++) out.set(rows.subarray(y * stride, y * stride + width * ch), y * width * ch);
        return { width, height, channels: ch, bitDepth: 8, data: out };
    }
    // Sub-byte greyscale (1/2/4-bit): scaled up to 0..255 exactly (255 is a multiple of 1, 3 and 15).
    const out = new Uint8Array(texels);
    const maxValue = (1 << bitDepth) - 1, scale = 255 / maxValue;
    for (let y = 0; y < height; y++) {
        const row = y * stride;
        for (let x = 0; x < width; x++) {
            const bit = x * bitDepth;
            out[y * width + x] = ((rows[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & maxValue) * scale;
        }
    }
    return { width, height, channels: 1, bitDepth: 8, data: out };
}

// --- weights -> over-alphas ---------------------------------------------------------------------

const EPS = 1e-6;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * One texel's weights, bottom to top (any scale; divided by their sum first), as the over-alphas that
 * composite to exactly those weights: `a_i = w_i / Σ_{j≤i} w_j`, peeled from the top with a running
 * remainder — the same arithmetic as `legacySplatAlphas`, generalised to N layers. `out[0]` is 1 (the
 * bottom layer covers what is left).
 *
 * Returns a bitmask of the layers whose alpha is UNDEFINED (nothing at or below them is visible, so any
 * alpha composites to the same result); those get 0. Bit i is layer i. A texel with no weight at all
 * reports every layer above the bottom.
 */
export function weightsToOverAlphas(weights: ArrayLike<number>, out: Float32Array): number {
    const n = weights.length;
    if (n === 0) return 0;
    out[0] = 1;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.max(0, weights[i]);
    let undefinedMask = 0;
    if (sum <= 0) {
        for (let i = 1; i < n; i++) { out[i] = 0; undefinedMask |= 1 << i; }
        return undefinedMask;
    }
    let rem = 1;
    for (let i = n - 1; i >= 1; i--) {
        const w = Math.max(0, weights[i]) / sum;
        if (rem > EPS) out[i] = clamp01(w / rem);
        else { out[i] = 0; undefinedMask |= 1 << i; }
        rem -= w;
    }
    return undefinedMask;
}

/**
 * Weight planes (bottom to top, one byte per texel, `width * height` each) as alpha planes for the paint
 * masks; plane 0 is all 255. Where a layer's alpha is undefined it is filled from the nearest defined
 * texels, ring by ring (each filled texel takes the mean of its already-defined 8-neighbours): masks are
 * filtered linearly on the GPU, and a 0 left there would show a third layer in a one-texel fringe along
 * every boundary where it is covered.
 */
export function weightPlanesToAlphaPlanes(planes: readonly Uint8Array[], width: number, height: number): Uint8Array[] {
    const n = planes.length;
    const texels = width * height;
    const out = planes.map(() => new Uint8Array(texels));
    if (n === 0) return out;
    out[0].fill(255);
    if (n === 1) return out;
    const w = new Float32Array(n);
    const a = new Float32Array(n);
    // One "undefined" flag plane per layer above the bottom.
    const undef = planes.map(() => new Uint8Array(texels));
    for (let t = 0; t < texels; t++) {
        for (let i = 0; i < n; i++) w[i] = planes[i][t];
        const mask = weightsToOverAlphas(w, a);
        for (let i = 1; i < n; i++) {
            out[i][t] = Math.round(a[i] * 255);
            if (mask & (1 << i)) undef[i][t] = 1;
        }
    }
    for (let i = 1; i < n; i++) fillUndefined(out[i], undef[i], width, height);
    return out;
}

/** Breadth-first fill of `undef` texels from defined neighbours; deterministic (row-major frontier order). */
function fillUndefined(values: Uint8Array, undef: Uint8Array, width: number, height: number): void {
    const texels = width * height;
    let any = false, anyDefined = false;
    for (let t = 0; t < texels; t++) { if (undef[t]) any = true; else anyDefined = true; }
    if (!any || !anyDefined) return;
    // `state`: 0 defined, 1 undefined, 2 queued for the current ring.
    const state = undef;
    let frontier: number[] = [];
    const neighbours = (t: number, visit: (j: number) => void) => {
        const r = (t / width) | 0, c = t - r * width;
        for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= height) continue;
            for (let dc = -1; dc <= 1; dc++) {
                if (!dr && !dc) continue;
                const cc = c + dc;
                if (cc < 0 || cc >= width) continue;
                visit(rr * width + cc);
            }
        }
    };
    for (let t = 0; t < texels; t++) {
        if (state[t] !== 1) continue;
        let touches = false;
        neighbours(t, j => { if (state[j] === 0) touches = true; });
        if (touches) { state[t] = 2; frontier.push(t); }
    }
    while (frontier.length) {
        const ring = frontier;
        const filled = new Uint8Array(ring.length);
        for (let k = 0; k < ring.length; k++) {
            let sum = 0, count = 0;
            neighbours(ring[k], j => { if (state[j] === 0) { sum += values[j]; count++; } });
            filled[k] = count ? Math.round(sum / count) : 0;
        }
        for (let k = 0; k < ring.length; k++) { values[ring[k]] = filled[k]; state[ring[k]] = 0; }
        frontier = [];
        for (const t of ring) neighbours(t, j => { if (state[j] === 1) { state[j] = 2; frontier.push(j); } });
        frontier.sort((x, y) => x - y);
    }
}

/** Bilinear resample of a square texel-centred byte plane (`srcRes`²) to `dstRes`² (a copy when equal). */
export function resamplePlane(src: Uint8Array, srcRes: number, dstRes: number): Uint8Array {
    if (srcRes === dstRes) return src.slice();
    const out = new Uint8Array(dstRes * dstRes);
    const scale = srcRes / dstRes, last = srcRes - 1;
    for (let r = 0; r < dstRes; r++) {
        const y = Math.min(Math.max((r + 0.5) * scale - 0.5, 0), last);
        const y0 = Math.floor(y), y1 = Math.min(y0 + 1, last), fy = y - y0;
        for (let c = 0; c < dstRes; c++) {
            const x = Math.min(Math.max((c + 0.5) * scale - 0.5, 0), last);
            const x0 = Math.floor(x), x1 = Math.min(x0 + 1, last), fx = x - x0;
            const top = src[y0 * srcRes + x0] + (src[y0 * srcRes + x1] - src[y0 * srcRes + x0]) * fx;
            const bottom = src[y1 * srcRes + x0] + (src[y1 * srcRes + x1] - src[y1 * srcRes + x0]) * fx;
            out[r * dstRes + c] = Math.round(top + (bottom - top) * fy);
        }
    }
    return out;
}

// --- the manifest -------------------------------------------------------------------------------

export interface WorldManifestLayer {
    id: string;
    name: string;
    /** Stack position, 0 = the base (bottom). */
    index: number;
    /** Where the layer's weight sits in the splatmaps: file and channel (0..3 = r, g, b, a). */
    splat?: { file: string; channel: 0 | 1 | 2 | 3 };
    /** Its grey weightmap. */
    weightmap?: string;
    /** Fraction of the map it covers, a hint for the importer. */
    coverage?: number;
    /** What it represents in the tool that made it ("sand", "rock") — a hint only, never a material. */
    kind?: string;
    /** Linear RGB swatch, a hint only. */
    color?: [number, number, number];
}

export interface WorldManifest {
    version: 1 | 2;
    /** Height samples per side. */
    resolution: number;
    /** World units across the map. */
    size: number;
    /** World heights of a 0 and of a 1 heightmap sample. */
    minHeight: number;
    maxHeight: number;
    seaLevel?: number;
    heightmap: { png?: string; raw?: string; exr?: string };
    splat?: { resolution: number; files: string[] };
    /** Bottom to top (sorted by `index`); empty for a v1 sidecar, which has no surfaces. */
    layers: WorldManifestLayer[];
    /** Data mask name -> file. */
    masks: Record<string, string>;
    /** Hash of what the files were made from; changes only when the export does. */
    exportHash?: string;
    water?: { seaLevel: number; lakes: { level: number; area: number; bounds: [number, number, number, number] }[] };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const CHANNELS: Record<string, 0 | 1 | 2 | 3> = { r: 0, g: 1, b: 2, a: 3, '0': 0, '1': 1, '2': 2, '3': 3 };

function channelOf(v: unknown): 0 | 1 | 2 | 3 | undefined {
    if (typeof v === 'number') return CHANNELS[String(v)];
    if (typeof v === 'string') return CHANNELS[v.toLowerCase()];
    return undefined;
}

/** File names by role, read off a v1 file list (`<name>_height.png`, `<name>_slope.png`, ...). */
function filesByRole(files: unknown): { png?: string; raw?: string; masks: Record<string, string> } {
    const out: { png?: string; raw?: string; masks: Record<string, string> } = { masks: {} };
    if (!Array.isArray(files)) return out;
    for (const f of files) {
        if (typeof f !== 'string') continue;
        if (/_height\.png$/i.test(f)) out.png = f;
        else if (/_height\.r16$/i.test(f)) out.raw = f;
        else {
            const m = /_([a-z0-9]+)\.png$/i.exec(f);
            if (m && !/^\d+$/.test(m[1])) out.masks[m[1].toLowerCase()] = f;
        }
    }
    return out;
}

/**
 * Read a world manifest: the sidecar JSON a World export writes (`{generator: 'world', ..., output}`), or
 * its `output` object alone. A v1 sidecar (heightmap + masks, no surfaces) and a v2 manifest
 * (`output.format === 'cleo-world'`, with splatmaps and layers) are both accepted; anything else is null.
 */
export function readWorldManifest(json: unknown): WorldManifest | null {
    if (!isObj(json)) return null;
    const output = isObj(json.output) ? json.output : json;
    const isV2 = output.format === 'cleo-world' && num(output.version) === 2;
    const isV1 = !isV2 && json.generator === 'world' && isObj(json.output);
    if (!isV1 && !isV2) return null;

    const resolution = num(output.resolution), size = num(output.size);
    const minHeight = num(output.minHeight) ?? (isObj(output.heightmap) ? num(output.heightmap.min) : undefined);
    const maxHeight = num(output.maxHeight) ?? (isObj(output.heightmap) ? num(output.heightmap.max) : undefined);
    if (resolution === undefined || size === undefined || minHeight === undefined || maxHeight === undefined) return null;

    const derived = filesByRole(output.files);
    const hm = isObj(output.heightmap) ? output.heightmap : {};
    const manifest: WorldManifest = {
        version: isV2 ? 2 : 1,
        resolution, size, minHeight, maxHeight,
        seaLevel: num(output.seaLevel),
        heightmap: { png: str(hm.png) ?? derived.png, raw: str(hm.raw) ?? derived.raw, exr: str(hm.exr) },
        layers: [],
        masks: {},
    };
    if (!isV2) { manifest.masks = derived.masks; return manifest; }

    if (isObj(output.masks)) {
        for (const [key, v] of Object.entries(output.masks)) {
            const file = typeof v === 'string' ? v : isObj(v) ? str(v.file) : undefined;
            if (file) manifest.masks[key] = file;
        }
    } else manifest.masks = derived.masks;

    if (isObj(output.splat) && Array.isArray(output.splat.files)) {
        const files = output.splat.files.filter((f): f is string => typeof f === 'string' && !!f);
        const res = num(output.splat.resolution);
        if (files.length && res !== undefined) manifest.splat = { resolution: res, files };
    }

    if (Array.isArray(output.layers)) {
        output.layers.forEach((l, k) => {
            if (!isObj(l)) return;
            const layer: WorldManifestLayer = {
                id: str(l.id) ?? `layer-${k}`,
                name: str(l.name) ?? `Layer ${k}`,
                index: num(l.index) ?? k,
            };
            if (isObj(l.splat)) {
                const file = str(l.splat.file), channel = channelOf(l.splat.channel);
                if (file && channel !== undefined) layer.splat = { file, channel };
            }
            const weightmap = str(l.weightmap);
            if (weightmap) layer.weightmap = weightmap;
            const coverage = num(l.coverage);
            if (coverage !== undefined) layer.coverage = coverage;
            const kind = str(l.kind);
            if (kind) layer.kind = kind;
            if (Array.isArray(l.color) && l.color.length >= 3 && l.color.slice(0, 3).every(c => num(c) !== undefined))
                layer.color = [l.color[0] as number, l.color[1] as number, l.color[2] as number];
            manifest.layers.push(layer);
        });
        manifest.layers.sort((x, y) => x.index - y.index);
    }

    const exportHash = str(output.exportHash);
    if (exportHash) manifest.exportHash = exportHash;
    if (isObj(output.water)) {
        const lakes = Array.isArray(output.water.lakes) ? output.water.lakes.flatMap(l => {
            if (!isObj(l)) return [];
            const level = num(l.level), area = num(l.area);
            const b = Array.isArray(l.bounds) && l.bounds.length === 4 && l.bounds.every(v => num(v) !== undefined)
                ? l.bounds as [number, number, number, number] : null;
            return level !== undefined && area !== undefined && b ? [{ level, area, bounds: [b[0], b[1], b[2], b[3]] as [number, number, number, number] }] : [];
        }) : [];
        manifest.water = { seaLevel: num(output.water.seaLevel) ?? manifest.seaLevel ?? 0, lakes };
    }
    return manifest;
}

/** One channel of an image as bytes (16-bit samples rounded down to 8). */
function channelPlane(img: DecodedPng, channel: number): Uint8Array {
    const texels = img.width * img.height;
    const out = new Uint8Array(texels);
    const d = img.data, ch = img.channels;
    if (img.bitDepth === 16) for (let t = 0; t < texels; t++) out[t] = Math.round(d[t * ch + channel] * 255 / 65535);
    else for (let t = 0; t < texels; t++) out[t] = d[t * ch + channel];
    return out;
}

/**
 * The layers' weight planes, in manifest layer order: from the splatmaps when every layer names its
 * channel, otherwise from the per-layer weightmaps. `images` is keyed by file name. Nothing is resampled:
 * every image must be square and the same size. Throws an Error naming what is missing or mismatched.
 */
export function weightPlanesFromImages(manifest: WorldManifest, images: ReadonlyMap<string, DecodedPng>): { size: number; planes: Uint8Array[] } {
    const layers = manifest.layers;
    if (!layers.length) throw new Error('The manifest lists no surface layers');
    const get = (file: string): DecodedPng => {
        const img = images.get(baseName(file)) ?? images.get(file);
        if (!img) throw new Error(`Missing ${baseName(file)}`);
        if (img.width !== img.height) throw new Error(`${baseName(file)} is ${img.width}x${img.height}; splat and weight maps must be square`);
        return img;
    };
    const useSplat = layers.every(l => l.splat);
    let size = 0;
    const planes = layers.map(l => {
        let img: DecodedPng, channel: number, file: string;
        if (useSplat) { file = l.splat!.file; channel = l.splat!.channel; img = get(file); }
        else if (l.weightmap) { file = l.weightmap; channel = 0; img = get(file); }
        else throw new Error(`The manifest gives no splatmap channel or weightmap for layer "${l.name}"`);
        if (channel >= img.channels) throw new Error(`${baseName(file)} has ${img.channels} channel(s); layer "${l.name}" reads channel ${channel}`);
        if (!size) size = img.width;
        else if (img.width !== size) throw new Error(`${baseName(file)} is ${img.width}x${img.width}, not ${size}x${size} like the other maps`);
        return channelPlane(img, channel);
    });
    return { size, planes };
}
