import { describe, expect, it } from 'vitest';
import {
    GI_BAKE_VERSION, GiBakeFormatError, GiSignature, decodeGiBake, encodeGiBake, giBakeByteLength,
    sameGiSignature, type GiBake,
} from '../src/graphics/render/gi/giBakeFormat';
import { hitCacheSize } from '../src/graphics/render/gi/giLayout';

function makeBake(counts: [number, number, number], rays: number): GiBake {
    const probes = counts[0] * counts[1] * counts[2];
    const [w, h] = hitCacheSize(probes, rays);
    const fill = (seed: number) => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < a.length; i++) a[i] = (i * seed + 7) & 0xff; return a; };
    const probeData = new Float32Array(probes * 4);
    for (let p = 0; p < probes; p++) probeData[p * 4 + 3] = p % 4;
    return {
        counts, rays, captureResolution: 32, maxRayDistance: 42.5, size: [12, 3.5, 9],
        signature: new GiSignature().addString('room').addNumbers([1, 2, 3]).value,
        probeData, hitA: fill(3), hitB: fill(5), hitC: fill(11),
    };
}

describe('GI bake format', () => {
    it('round-trips a bake exactly', () => {
        const bake = makeBake([5, 3, 7], 256);
        const bytes = encodeGiBake(bake);
        expect(bytes.byteLength).toBe(giBakeByteLength(bake.counts, bake.rays));
        const back = decodeGiBake(bytes);
        expect(back.counts).toEqual(bake.counts);
        expect(back.rays).toBe(256);
        expect(back.captureResolution).toBe(32);
        expect(back.maxRayDistance).toBeCloseTo(42.5);
        expect(back.size).toEqual([12, 3.5, 9]);
        expect(sameGiSignature(back.signature, bake.signature)).toBe(true);
        expect([...back.probeData]).toEqual([...bake.probeData]);
        // Buffer.equals, not toEqual: a deep compare of 128 KB takes seconds.
        expect(Buffer.from(back.hitA).equals(Buffer.from(bake.hitA))).toBe(true);
        expect(Buffer.from(back.hitB).equals(Buffer.from(bake.hitB))).toBe(true);
        expect(Buffer.from(back.hitC).equals(Buffer.from(bake.hitC))).toBe(true);
    });

    it('reads from an ArrayBuffer and from a misaligned chunk of a bigger file', () => {
        const bytes = encodeGiBake(makeBake([2, 2, 2], 64));
        expect(decodeGiBake(bytes.slice().buffer).counts).toEqual([2, 2, 2]);
        const file = new Uint8Array(bytes.byteLength + 3);
        file.set(bytes, 3);
        const back = decodeGiBake(file.subarray(3));
        expect(back.probeData[7]).toBe(1);
    });

    it('refuses what it cannot read, by name', () => {
        const bytes = encodeGiBake(makeBake([2, 2, 2], 64));
        expect(() => decodeGiBake(bytes.subarray(0, 50))).toThrow(GiBakeFormatError);
        const bad = bytes.slice(); bad[0] ^= 0xff;
        expect(() => decodeGiBake(bad)).toThrow(/magic/);
        const newer = bytes.slice(); new DataView(newer.buffer).setUint32(4, GI_BAKE_VERSION + 1, true);
        expect(() => decodeGiBake(newer)).toThrow(/version/);
        const grid = bytes.slice(); new DataView(grid.buffer).setUint32(12, 9, true);
        expect(() => decodeGiBake(grid)).toThrow(GiBakeFormatError);
        expect(() => decodeGiBake(bytes.subarray(0, bytes.byteLength - 4))).toThrow(/outside/);
    });

    it('refuses to write mismatched sections', () => {
        const bake = makeBake([2, 2, 2], 64);
        expect(() => encodeGiBake({ ...bake, hitB: new Uint8Array(4) })).toThrow(/hit cache B/);
        expect(() => encodeGiBake({ ...bake, probeData: new Float32Array(4) })).toThrow(/probe data/);
    });
});

describe('GI geometry signature', () => {
    it('is stable for the same input and changes with any of it', () => {
        const s = (name: string, x: number) => new GiSignature().addString(name).addNumber(x).addNumbers([1, 2]).value;
        expect(s('a', 1)).toEqual(s('a', 1));
        expect(sameGiSignature(s('a', 1), s('b', 1))).toBe(false);
        expect(sameGiSignature(s('a', 1), s('a', 1.001))).toBe(false);
        // Float noise under the quantum is not a change.
        expect(sameGiSignature(s('a', 1), s('a', 1 + 1e-7))).toBe(true);
        expect(sameGiSignature(s('ab', 1), s('a', 1))).toBe(false);
    });
});
