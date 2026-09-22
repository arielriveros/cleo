import { describe, it, expect } from 'vitest';
import {
    decodePng, encodePng16, decodeRaw16, encodeRaw16, decodeHeightmap, sampleHeight, heightsFromImage,
    imageFromHeights, isPng, type HeightImage,
} from '../src/terrain/heightmapIO';

// Heightmaps at full precision. The canvas path the editor used gives 8 bits whatever the file holds;
// these pin that 16 bits survive, that RAW works, and that the orientation matches the old import.

const ramp = (w: number, h: number): HeightImage => {
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = (y * w + x) / (w * h - 1);
    return { width: w, height: h, data, bitDepth: 16 };
};

describe('16-bit PNG', () => {
    it('round-trips at 16-bit precision', async () => {
        const img = ramp(37, 21);
        const png = await encodePng16(img);
        expect(isPng(png)).toBe(true);
        const back = await decodePng(png);
        expect([back.width, back.height, back.bitDepth]).toEqual([37, 21, 16]);
        let worst = 0;
        for (let i = 0; i < img.data.length; i++) worst = Math.max(worst, Math.abs(back.data[i] - img.data[i]));
        expect(worst).toBeLessThanOrEqual(0.5 / 65535 + 1e-9);
        // 8 bits could not tell these two apart; 16 can.
        expect(back.data[1]).not.toBe(back.data[0]);
    });

    it('decodes an 8-bit greyscale PNG and every filter type', async () => {
        // Hand-built: 4x5, 8-bit grey, one row per filter type 0..4.
        const w = 4, h = 5;
        const pixels = [[10, 20, 30, 40], [50, 60, 70, 80], [90, 100, 110, 120], [130, 140, 150, 160], [170, 180, 190, 200]];
        const raw: number[] = [];
        for (let y = 0; y < h; y++) {
            const filter = y; // 0 none, 1 sub, 2 up, 3 average, 4 paeth
            raw.push(filter);
            for (let x = 0; x < w; x++) {
                const a = x > 0 ? pixels[y][x - 1] : 0;
                const b = y > 0 ? pixels[y - 1][x] : 0;
                const c = x > 0 && y > 0 ? pixels[y - 1][x - 1] : 0;
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
                raw.push((pixels[y][x] - pred) & 255);
            }
        }
        const png = await encodeWith(w, h, 8, 0, new Uint8Array(raw));
        const img = await decodePng(png);
        expect(img.bitDepth).toBe(8);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
            expect(Math.round(img.data[y * w + x] * 255)).toBe(pixels[y][x]);
    });

    it('reads the RED channel of a colour PNG', async () => {
        const raw = new Uint8Array([0, 200, 1, 2, 50, 3, 4]); // 2x1 RGB, filter 0
        const img = await decodePng(await encodeWith(2, 1, 8, 2, raw));
        expect(Math.round(img.data[0] * 255)).toBe(200);
        expect(Math.round(img.data[1] * 255)).toBe(50);
    });

    it('refuses what it cannot decode rather than decoding it wrong', async () => {
        await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow(/Not a PNG/);
        const interlaced = await encodeWith(1, 1, 8, 0, new Uint8Array([0, 0]), 1);
        await expect(decodePng(interlaced)).rejects.toThrow(/Interlaced/);
    });
});

describe('RAW R16', () => {
    it('round-trips a square little-endian file', () => {
        const img = ramp(9, 9);
        const back = decodeRaw16(encodeRaw16(img));
        expect([back.width, back.height]).toEqual([9, 9]);
        for (let i = 0; i < 81; i++) expect(back.data[i]).toBeCloseTo(img.data[i], 4);
    });

    it('needs a width for a non-square file', () => {
        const bytes = encodeRaw16(ramp(8, 4));
        expect(() => decodeRaw16(bytes)).toThrow(/give its width/);
        expect(decodeRaw16(bytes, { width: 8 }).height).toBe(4);
    });

    it('decodeHeightmap picks the format by signature', async () => {
        const img = ramp(4, 4);
        expect((await decodeHeightmap(await encodePng16(img))).width).toBe(4);
        expect((await decodeHeightmap(encodeRaw16(img))).width).toBe(4);
    });
});

describe('sampling into a height grid', () => {
    it('is bilinear and hits the corners exactly', () => {
        const img: HeightImage = { width: 2, height: 2, data: new Float32Array([0, 1, 0, 1]), bitDepth: 16 };
        expect(sampleHeight(img, 0.5, 0.5)).toBeCloseTo(0.5, 9);
        const g = heightsFromImage(img, 3, { min: 10, max: 30 });
        expect(Array.from(g)).toEqual([10, 20, 30, 10, 20, 30, 10, 20, 30]);
    });

    it('keeps the old orientation: image row 0 is the -Z edge, column 0 the -X edge', () => {
        const img: HeightImage = { width: 2, height: 2, data: new Float32Array([1, 0, 0, 0]), bitDepth: 16 };
        const g = heightsFromImage(img, 2, { min: 0, max: 1 });
        expect(g[0]).toBe(1); // row 0, column 0
    });

    it('flips and rotates', () => {
        const img: HeightImage = { width: 2, height: 2, data: new Float32Array([1, 0, 0, 0]), bitDepth: 16 };
        expect(heightsFromImage(img, 2, { min: 0, max: 1, flipX: true })[1]).toBe(1);
        expect(heightsFromImage(img, 2, { min: 0, max: 1, flipY: true })[2]).toBe(1);
        // 90 clockwise: the top-left corner moves to the top-right.
        expect(heightsFromImage(img, 2, { min: 0, max: 1, rotate: 90 })[1]).toBe(1);
        expect(heightsFromImage(img, 2, { min: 0, max: 1, rotate: 180 })[3]).toBe(1);
    });

    it('export then import restores absolute heights', () => {
        const heights = new Float32Array([-12.5, 0, 40, 7.25]);
        const { image, min, max } = imageFromHeights(heights, 2);
        const back = heightsFromImage(image, 2, { min, max });
        for (let i = 0; i < 4; i++) expect(back[i]).toBeCloseTo(heights[i], 6);
    });
});

/** A minimal PNG around pre-filtered scanlines, for decoder tests. */
async function encodeWith(w: number, h: number, bitDepth: number, colorType: number, raw: Uint8Array, interlace = 0): Promise<Uint8Array> {
    const deflate = async (d: Uint8Array) => new Uint8Array(await new Response(
        new Blob([d as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const chunk = (type: string, body: Uint8Array) => {
        const out = new Uint8Array(12 + body.length);
        new DataView(out.buffer).setUint32(0, body.length);
        for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(body, 8);
        return out; // CRC left zero: the decoder does not check it
    };
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, w);
    new DataView(ihdr.buffer).setUint32(4, h);
    ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[12] = interlace;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array())];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
