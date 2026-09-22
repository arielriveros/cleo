import { describe, it, expect } from 'vitest';
import { MaskGrid, maskSlicesFor } from '../src/terrain/terrainMasks';

// Paint masks: one channel per paint layer, independent of each other (the stack composites them; it
// never normalises), at a resolution of their own, sampled at texel centres like the GPU does.

const grid = (res = 16, size = 16, channels = 4) => new MaskGrid(res, size, channels);
const brush = (x = 0, z = 0, radius = 3, falloff = 0) => ({ x, z, radius, falloff });

describe('mask grid', () => {
    it('starts empty and grows in whole RGBA slices', () => {
        const g = grid(8, 8, 1);
        expect(g.slices).toBe(1);
        expect(g.capacity).toBe(4);
        expect(g.isEmpty(0)).toBe(true);
        expect(maskSlicesFor(5)).toBe(2);
        g.fill(2, 1);
        expect(g.ensureChannels(6)).toBe(true);
        expect(g.slices).toBe(2);
        expect(g.value(2, 3, 3)).toBe(1); // kept across the reallocation
        expect(g.ensureChannels(8)).toBe(false);
    });

    it('painting one channel never touches another', () => {
        const g = grid();
        g.fill(1, 0.5);
        g.paint(0, { brush: brush(), amount: 1, target: 1 });
        expect(g.value(0, 8, 8)).toBe(1);
        expect(g.value(1, 8, 8)).toBeCloseTo(128 / 255, 6);
    });

    it('moves toward the target and stops there; erase moves toward zero', () => {
        const g = grid();
        g.paint(0, { brush: brush(), amount: 0.5, target: 0.6 });
        const once = g.value(0, 8, 8);
        expect(once).toBeGreaterThan(0.25);
        expect(once).toBeLessThan(0.6);
        for (let i = 0; i < 20; i++) g.paint(0, { brush: brush(), amount: 0.5, target: 0.6 });
        expect(g.value(0, 8, 8)).toBeCloseTo(0.6, 2);
        for (let i = 0; i < 20; i++) g.paint(0, { brush: brush(), amount: 0.5, target: 0 });
        expect(g.value(0, 8, 8)).toBe(0);
    });

    it('reports exactly the rectangle it changed, inside the brush', () => {
        const g = grid();
        const reg = g.paint(0, { brush: brush(0, 0, 2.2), amount: 1, target: 1 })!;
        // Texel centres at -7.5..7.5; within 2.2 of the origin: centres -1.5..1.5 -> texels 6..9.
        expect(reg).toEqual({ c0: 6, r0: 6, c1: 9, r1: 9 });
        expect(g.value(0, 0, 0)).toBe(0);
    });

    it('samples what a linearly filtered texture would, clamped at the edge', () => {
        const g = grid(4, 4, 4);
        // Texel centres at -1.5, -0.5, 0.5, 1.5. Set column 2 to 1.
        for (let r = 0; r < 4; r++) g.paint(0, { brush: { x: 0.5, z: -1.5 + r, radius: 0.4, falloff: 0 }, amount: 1, target: 1 });
        expect(g.sample(0, 0.5, 0)).toBeCloseTo(1, 6);
        expect(g.sample(0, 0, 0)).toBeCloseTo(0.5, 6);   // halfway between centres -0.5 and 0.5
        expect(g.sample(0, -1.5, 0)).toBeCloseTo(0, 6);
        expect(g.sample(0, 99, 0)).toBeCloseTo(0, 6);     // clamped to the last column (x = 1.5)
    });

    it('fill, invert and coverage', () => {
        const g = grid();
        expect(g.fill(0, 1)).toEqual(g.fullRegion());
        expect(g.fill(0, 1)).toBeNull(); // already full
        expect(g.coverage(0)).toBe(1);
        g.invert(0);
        expect(g.coverage(0)).toBe(0);
        expect(g.isEmpty(0)).toBe(true);
    });

    it('a saved patch restores exactly (undo)', () => {
        const g = grid();
        const reg = { c0: 4, r0: 4, c1: 11, r1: 11 };
        const before = g.readPatch(0, reg);
        g.paint(0, { brush: brush(), amount: 1, target: 1 });
        expect(g.isEmpty(0)).toBe(false);
        g.writePatch(before);
        expect(g.isEmpty(0)).toBe(true);
    });

    it('slice rectangles are tightly packed RGBA rows', () => {
        const g = grid(4, 4, 4);
        g.fill(3, 1);
        const rect = g.sliceRect(0, { c0: 1, r0: 1, c1: 2, r1: 2 });
        expect(rect.length).toBe(2 * 2 * 4);
        expect(Array.from(rect.subarray(0, 4))).toEqual([0, 0, 0, 255]);
    });

    it('copies a channel (layer reorder)', () => {
        const g = grid();
        g.paint(0, { brush: brush(), amount: 1, target: 1 });
        g.copyChannel(0, 5);
        expect(g.capacity).toBe(4); // out of range: ignored
        g.ensureChannels(6);
        g.copyChannel(0, 5);
        expect(g.value(5, 8, 8)).toBe(1);
    });

    it('resamples across a resolution change, stretching with the landscape', () => {
        const a = grid(8, 100, 4);
        a.paint(0, { brush: { x: -25, z: 0, radius: 20, falloff: 0 }, amount: 1, target: 1 });
        const b = new MaskGrid(32, 400, 4);
        b.resampleFrom(a);
        // The painted left half of `a` lands on the left half of `b`, scaled 4x.
        expect(b.sample(0, -100, 0)).toBeGreaterThan(0.9);
        expect(b.sample(0, 100, 0)).toBeLessThan(0.1);
    });
});
