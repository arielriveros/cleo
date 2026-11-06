import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
    decodePngChannels, weightsToOverAlphas, weightPlanesToAlphaPlanes, readWorldManifest, weightPlanesFromImages,
    resamplePlane, type DecodedPng,
} from '../src/terrain/splatmapIO';
import { decodePng } from '../src/terrain/heightmapIO';
import { compositeWeights, defaultBlendRule } from '../src/terrain/terrainLayers';
import { TerrainLayerStack } from '../src/terrain/terrainLayerStack';
import { Material, TerrainMaterial, type TerrainMaterialSlot } from '../src/graphics/material';

// Reading a texturing export: PNGs with every channel kept, normalized weights turned into the stack's
// over-alphas (and back, exactly), the world manifest, and whole-mask writes into a layer stack.

// --- a tiny PNG writer, any colour type / depth, filter 0 -------------------------------------------

let CRC: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
    if (!CRC) {
        CRC = new Uint32Array(256);
        for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
}
/** `rows`: already-packed scanline bytes (no filter byte). */
function png(width: number, height: number, bitDepth: number, colorType: number, rows: Uint8Array[], extra: [string, Uint8Array][] = []): Uint8Array {
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width); v.setUint32(4, height);
    ihdr[8] = bitDepth; ihdr[9] = colorType;
    const raw = new Uint8Array(rows.reduce((n, r) => n + r.length + 1, 0));
    let o = 0;
    for (const r of rows) { raw[o++] = 0; raw.set(r, o); o += r.length; }
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra.map(([t, b]) => chunk(t, b)),
                   chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
const rowsOf = (data: number[], width: number, ch: number) => {
    const out: Uint8Array[] = [];
    for (let i = 0; i < data.length; i += width * ch) out.push(new Uint8Array(data.slice(i, i + width * ch)));
    return out;
};

describe('decodePngChannels', () => {
    it('keeps every channel of an 8-bit RGBA image, including RGB under alpha 0', async () => {
        const px = [255, 0, 0, 255, 0, 255, 0, 0, 1, 2, 3, 128, 40, 50, 60, 0];
        const img = await decodePngChannels(png(2, 2, 8, 6, rowsOf(px, 2, 4)));
        expect([img.width, img.height, img.channels, img.bitDepth]).toEqual([2, 2, 4, 8]);
        expect(Array.from(img.data)).toEqual(px);
    });

    it('reads grey8, RGB8 and grey + alpha', async () => {
        const grey = await decodePngChannels(png(3, 1, 8, 0, [new Uint8Array([0, 128, 255])]));
        expect([grey.channels, Array.from(grey.data)]).toEqual([1, [0, 128, 255]]);
        const rgb = await decodePngChannels(png(1, 2, 8, 2, [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]));
        expect([rgb.channels, Array.from(rgb.data)]).toEqual([3, [1, 2, 3, 4, 5, 6]]);
        const ga = await decodePngChannels(png(2, 1, 8, 4, [new Uint8Array([10, 20, 30, 40])]));
        expect([ga.channels, Array.from(ga.data)]).toEqual([2, [10, 20, 30, 40]]);
    });

    it('keeps 16 bits for 16-bit files', async () => {
        const img = await decodePngChannels(png(2, 1, 16, 0, [new Uint8Array([0x12, 0x34, 0xff, 0xfe])]));
        expect(img.bitDepth).toBe(16);
        expect(img.data).toBeInstanceOf(Uint16Array);
        expect(Array.from(img.data)).toEqual([0x1234, 0xfffe]);
    });

    it('expands a palette to RGB, or RGBA with tRNS, and sub-byte grey to 0..255', async () => {
        const plte = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]);
        // 4-bit indices 2, 0, 1 packed MSB first.
        const pal = await decodePngChannels(png(3, 1, 4, 3, [new Uint8Array([0x20, 0x10])], [['PLTE', plte]]));
        expect([pal.channels, pal.bitDepth, Array.from(pal.data)]).toEqual([3, 8, [70, 80, 90, 10, 20, 30, 40, 50, 60]]);
        const palA = await decodePngChannels(png(2, 1, 8, 3, [new Uint8Array([1, 2])], [['PLTE', plte], ['tRNS', new Uint8Array([0, 100])]]));
        expect([palA.channels, Array.from(palA.data)]).toEqual([4, [40, 50, 60, 100, 70, 80, 90, 255]]);
        const g2 = await decodePngChannels(png(4, 1, 2, 0, [new Uint8Array([0b00011011])]));
        expect(Array.from(g2.data)).toEqual([0, 85, 170, 255]);
    });

    it('shares the parser with decodePng, whose output is unchanged', async () => {
        const bytes = png(2, 1, 8, 6, [new Uint8Array([200, 1, 2, 3, 100, 4, 5, 6])]);
        const h = await decodePng(bytes);
        expect(Array.from(h.data)).toEqual([Math.fround(200 / 255), Math.fround(100 / 255)]);
        await expect(decodePngChannels(new Uint8Array([1, 2, 3]))).rejects.toThrow('Not a PNG');
    });
});

// --- weights <-> over-alphas ----------------------------------------------------------------------

/** A tiny deterministic PRNG (mulberry32). */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('weightsToOverAlphas', () => {
    it('composites back to the weights it was given, for 1..16 layers', () => {
        const rand = rng(7);
        for (let n = 1; n <= 16; n++) {
            for (let trial = 0; trial < 50; trial++) {
                const w = Array.from({ length: n }, () => (rand() < 0.2 ? 0 : rand()));
                if (w.every(x => x === 0)) w[0] = 1;
                const sum = w.reduce((a, b) => a + b, 0);
                const norm = w.map(x => x / sum);
                const alphas = new Float32Array(n);
                weightsToOverAlphas(norm, alphas);
                expect(alphas[0]).toBe(1);
                const back = new Array(n).fill(0);
                compositeWeights(alphas, back);
                for (let i = 0; i < n; i++) expect(back[i]).toBeCloseTo(norm[i], 5);
            }
        }
    });

    it('needs no normalisation, and reports layers nothing shows through', () => {
        const a = new Float32Array(3);
        // The top layer covers everything: what is below it is undefined.
        expect(weightsToOverAlphas([0, 0, 255], a)).toBe(0b010);
        expect(Array.from(a)).toEqual([1, 0, 1]);
        expect(weightsToOverAlphas([2, 2, 0], a)).toBe(0);
        expect(Array.from(a)).toEqual([1, 0.5, 0]);
        expect(weightsToOverAlphas([0, 0, 0], a)).toBe(0b110);
        expect(Array.from(a)).toEqual([1, 0, 0]);
    });
});

describe('weightPlanesToAlphaPlanes', () => {
    it('makes the base 255 and fills undefined texels from their neighbours', () => {
        // 4x1: layer 2 covers texels 2..3 completely, so layer 1 is undefined there.
        const base = new Uint8Array([127, 0, 0, 0]);
        const mid = new Uint8Array([128, 255, 0, 0]);
        const top = new Uint8Array([0, 0, 255, 255]);
        const [a0, a1, a2] = weightPlanesToAlphaPlanes([base, mid, top], 4, 1);
        expect(Array.from(a0)).toEqual([255, 255, 255, 255]);
        expect(Array.from(a2)).toEqual([0, 0, 255, 255]);
        // Defined: 128/255 at texel 0, 255 at texel 1; texels 2 and 3 carry texel 1's 255 outward.
        expect(Array.from(a1)).toEqual([128, 255, 255, 255]);
    });

    it('composites to the source weights wherever the result is visible', () => {
        const rand = rng(3), W = 8, H = 8, n = 5;
        const planes = Array.from({ length: n }, () => new Uint8Array(W * H));
        for (let t = 0; t < W * H; t++) {
            const w = Array.from({ length: n }, () => rand());
            const s = w.reduce((a, b) => a + b, 0);
            let left = 255;
            for (let i = n - 1; i >= 1; i--) { const v = Math.min(left, Math.round(w[i] / s * 255)); planes[i][t] = v; left -= v; }
            planes[0][t] = left;
        }
        const alphas = weightPlanesToAlphaPlanes(planes, W, H);
        for (let t = 0; t < W * H; t++) {
            const back = new Array(n).fill(0);
            compositeWeights(alphas.map(p => p[t] / 255), back);
            for (let i = 0; i < n; i++) expect(Math.abs(back[i] * 255 - planes[i][t])).toBeLessThanOrEqual(2.5);
        }
    });
});

describe('resamplePlane', () => {
    it('copies at the same size and keeps a constant constant', () => {
        const src = new Uint8Array([1, 2, 3, 4]);
        const same = resamplePlane(src, 2, 2);
        expect(Array.from(same)).toEqual([1, 2, 3, 4]);
        expect(same).not.toBe(src);
        expect(Array.from(resamplePlane(new Uint8Array(9).fill(77), 3, 7)).every(v => v === 77)).toBe(true);
    });

    it('is texel-centred: a 2x2 doubled keeps each quadrant\'s corner value', () => {
        const up = resamplePlane(new Uint8Array([0, 200, 100, 40]), 2, 4);
        expect([up[0], up[3], up[12], up[15]]).toEqual([0, 200, 100, 40]);
        expect(up[1]).toBe(50); // a quarter of the way from 0 to 200
    });
});

// --- the manifest ----------------------------------------------------------------------------------

const V1 = {
    generator: 'world', creatorVersion: 1, seed: 1, params: {},
    output: {
        resolution: 513, size: 2048, minHeight: -10, maxHeight: 590, seaLevel: 60,
        files: ['world_height.png', 'world_height.r16', 'world_slope.png', 'world_curvature.png', 'world_flow.png', 'world_wetness.png', 'world.json'],
        orientation: 'row 0 is the -Z edge',
    },
};

const V2_OUTPUT = {
    format: 'cleo-world', version: 2, resolution: 513, size: 2048, minHeight: -12.3, maxHeight: 580.1, seaLevel: 60,
    files: ['world_height.png'], orientation: 'row 0 is the -Z edge, column 0 the -X edge (the engine heightmap convention)',
    heightmap: { png: 'world_height.png', raw: 'world_height.r16', exr: 'world_height.exr', bits: 16, min: -12.3, max: 580.1 },
    splat: { resolution: 4, files: ['world_splat_0.png'], weights: 'normalized', sampling: 'texel-centred; row 0 is the -Z edge, column 0 the -X edge' },
    layers: [
        { id: 's-sand', name: 'Sand', index: 1, splat: { file: 'world_splat_0.png', channel: 'g' }, weightmap: 'world_weight_01_sand.png', coverage: 0.12, kind: 'sand', color: [0.8, 0.7, 0.5] },
        { id: 's-grass', name: 'Grass', index: 0, splat: { file: 'world_splat_0.png', channel: 'r' }, weightmap: 'world_weight_00_grass.png' },
        { id: 's-rock', name: 'Rock', index: 2, splat: { file: 'world_splat_0.png', channel: 'b' }, weightmap: 'world_weight_02_rock.png' },
    ],
    masks: { slope: { file: 'world_slope.png', bits: 8 }, wetness: { file: 'world_wetness.png', bits: 8 } },
    water: { seaLevel: 60, lakes: [{ level: 210.5, area: 35000, bounds: [-100, 20, 50, 160] }] },
    exportHash: '1a2b3c4d',
};

describe('readWorldManifest', () => {
    it('reads a v1 sidecar: heightmap and masks from the file list, no layers', () => {
        const m = readWorldManifest(V1)!;
        expect(m.version).toBe(1);
        expect([m.resolution, m.size, m.minHeight, m.maxHeight, m.seaLevel]).toEqual([513, 2048, -10, 590, 60]);
        expect(m.heightmap).toEqual({ png: 'world_height.png', raw: 'world_height.r16', exr: undefined });
        expect(m.masks).toEqual({ slope: 'world_slope.png', curvature: 'world_curvature.png', flow: 'world_flow.png', wetness: 'world_wetness.png' });
        expect(m.layers).toEqual([]);
    });

    it('reads a v2 manifest, wrapped in its sidecar or alone, layers bottom to top', () => {
        for (const json of [{ generator: 'world', creatorVersion: 1, seed: 1, params: {}, output: V2_OUTPUT }, V2_OUTPUT]) {
            const m = readWorldManifest(json)!;
            expect(m.version).toBe(2);
            expect(m.heightmap.exr).toBe('world_height.exr');
            expect(m.splat).toEqual({ resolution: 4, files: ['world_splat_0.png'] });
            expect(m.layers.map(l => [l.name, l.index, l.splat?.channel])).toEqual([['Grass', 0, 0], ['Sand', 1, 1], ['Rock', 2, 2]]);
            expect(m.layers[1]).toMatchObject({ coverage: 0.12, kind: 'sand', color: [0.8, 0.7, 0.5], weightmap: 'world_weight_01_sand.png' });
            expect(m.masks).toEqual({ slope: 'world_slope.png', wetness: 'world_wetness.png' });
            expect(m.water).toEqual({ seaLevel: 60, lakes: [{ level: 210.5, area: 35000, bounds: [-100, 20, 50, 160] }] });
            expect(m.exportHash).toBe('1a2b3c4d');
        }
    });

    it('refuses what is not a world', () => {
        expect(readWorldManifest(null)).toBeNull();
        expect(readWorldManifest({ generator: 'foliage', output: { resolution: 1, size: 1, minHeight: 0, maxHeight: 1 } })).toBeNull();
        expect(readWorldManifest({ generator: 'world', output: { size: 1 } })).toBeNull();
    });
});

describe('weightPlanesFromImages', () => {
    const S = 4, T = S * S;
    // Three layers as normalized weights.
    const grass = new Uint8Array(T), sand = new Uint8Array(T), rock = new Uint8Array(T);
    for (let t = 0; t < T; t++) { rock[t] = t * 8; sand[t] = (T - t) * 4; grass[t] = 255 - rock[t] - sand[t]; }
    const splat: DecodedPng = { width: S, height: S, channels: 4, bitDepth: 8, data: new Uint8Array(T * 4) };
    for (let t = 0; t < T; t++) { splat.data[t * 4] = grass[t]; splat.data[t * 4 + 1] = sand[t]; splat.data[t * 4 + 2] = rock[t]; }
    const grey = (p: Uint8Array): DecodedPng => ({ width: S, height: S, channels: 1, bitDepth: 8, data: p });
    const manifest = readWorldManifest(V2_OUTPUT)!;

    it('reads the splatmap channels and the weightmaps alike', () => {
        const fromSplat = weightPlanesFromImages(manifest, new Map([['world_splat_0.png', splat]]));
        expect(fromSplat.size).toBe(S);
        expect(fromSplat.planes.map(p => Array.from(p))).toEqual([grass, sand, rock].map(p => Array.from(p)));

        const noSplat = { ...manifest, layers: manifest.layers.map(({ splat: _, ...l }) => l) };
        const fromWeights = weightPlanesFromImages(noSplat, new Map([
            ['world_weight_00_grass.png', grey(grass)], ['world_weight_01_sand.png', grey(sand)], ['world_weight_02_rock.png', grey(rock)],
        ]));
        expect(fromWeights.planes.map(p => Array.from(p))).toEqual(fromSplat.planes.map(p => Array.from(p)));
    });

    it('names a missing file', () => {
        expect(() => weightPlanesFromImages(manifest, new Map())).toThrow('world_splat_0.png');
    });
});

// --- whole-mask writes ---------------------------------------------------------------------------------

describe('TerrainLayerStack.writeChannel', () => {
    const slot = (id: string): TerrainMaterialSlot => ({
        id, name: id, material: Material.Basic({ color: [0.5, 0.4, 0.3] }), surfaceMaterialId: null, tiling: 20,
        rule: defaultBlendRule(), allowFoliage: false, manual: true,
    });

    it('resamples into the slot\'s channel and marks the whole mask dirty', () => {
        const s = new TerrainLayerStack(16, 8);
        const tm = TerrainMaterial.Create('basic', { color: [1, 1, 1] });
        tm.slots.push(slot('sand'), slot('rock'));
        s.setBase(tm);
        (s as any)._maskDirty.clear();
        expect(s.writeChannel('rock', new Uint8Array(16).fill(200), 4)).toBe(true);
        const ch = s.slotChannel('rock')!;
        const patch = s.readMaskPatches(s.masks.fullRegion()).find(p => p.channel === ch)!;
        expect(patch.data.length).toBe(64);
        expect(Array.from(patch.data).every(v => v === 200)).toBe(true);
        const other = s.readMaskPatches(s.masks.fullRegion()).find(p => p.channel === s.slotChannel('sand'))!;
        expect(Array.from(other.data).every(v => v === 0)).toBe(true);
        expect((s as any)._maskDirty.get(0)).toEqual({ c0: 0, r0: 0, c1: 7, r1: 7 });
    });

    it('refuses a slot without a channel and data of the wrong size', () => {
        const s = new TerrainLayerStack(16, 8);
        const tm = TerrainMaterial.Create('basic', { color: [1, 1, 1] });
        tm.slots.push(slot('sand'));
        s.setBase(tm);
        expect(s.writeChannel('nope', new Uint8Array(16), 4)).toBe(false);
        expect(s.writeChannel('sand', new Uint8Array(15), 4)).toBe(false);
    });
});
