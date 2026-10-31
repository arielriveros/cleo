import { describe, it, expect } from 'vitest';
import {
    brushDab, clothFromWeights, fillPiece, fillRange, neighboursOf, settingsOf, twinsOf, weightsFromCloth, DEFAULT_CLOTH_SETTINGS,
} from '../src/physics/cloth/clothPaint';

// The editor's Cloth brush, its pure half (src/physics/cloth/clothPaint.ts).

/** Two quads side by side, the middle edge duplicated (a UV seam): vertices 1/4 and 2/5 are twins. */
function seamed() {
    const positions = [
        0, 0, 0, 1, 0, 0, 1, 1, 0,  // left quad: 0 1 2 (+ 3)
        0, 1, 0,
        1, 0, 0, 1, 1, 0,           // right quad's own copies of the seam: 4 5
        2, 0, 0, 2, 1, 0,           // 6 7
    ];
    const indices = [0, 1, 2, 0, 2, 3, 4, 6, 7, 4, 7, 5];
    return { positions, indices };
}

describe('cloth painting', () => {
    it('round-trips weights through the stored form, and drops what is unpainted', () => {
        const w = new Float32Array([0, 0.5, 0, 1]);
        const cloth = clothFromWeights(w, { ...DEFAULT_CLOTH_SETTINGS, maxDistance: 0.4 })!;
        expect(cloth.vertices).toEqual([1, 3]);
        expect(cloth.weights).toEqual([0.5, 1]);
        expect(cloth.maxDistance).toBe(0.4);
        expect(Array.from(weightsFromCloth(cloth, 4))).toEqual([0, 0.5, 0, 1]);
        expect(settingsOf(cloth).maxDistance).toBe(0.4);
        expect(clothFromWeights(new Float32Array(3), DEFAULT_CLOTH_SETTINGS)).toBeNull();
        // A new object every time: the runtime rebuilds on identity.
        expect(clothFromWeights(w, DEFAULT_CLOTH_SETTINGS)).not.toBe(clothFromWeights(w, DEFAULT_CLOTH_SETTINGS));
    });

    it('paints a vertex and its twins together, with falloff, and erases', () => {
        const { positions } = seamed();
        const twins = twinsOf(positions);
        expect(twins[1].sort()).toEqual([1, 4]);
        const w = new Float32Array(8);
        brushDab(positions, w, twins, { center: [1, 0, 0], radius: 0.5, strength: 1, falloff: 0, mode: 'paint', value: 0.8 });
        expect(w[1]).toBeCloseTo(0.8);
        expect(w[4]).toBeCloseTo(0.8);
        expect(w[0]).toBe(0);
        // Feathered: weaker toward the rim.
        const f = new Float32Array(8);
        brushDab(positions, f, twins, { center: [0.6, 0, 0], radius: 1, strength: 1, falloff: 1, mode: 'paint', value: 1 });
        expect(f[1]).toBeGreaterThan(f[0]);
        brushDab(positions, w, twins, { center: [1, 0, 0], radius: 0.5, strength: 1, falloff: 0, mode: 'erase', value: 0 });
        expect(w[1]).toBe(0);
        expect(w[4]).toBe(0);
    });

    it('smooths toward the neighbours across a seam', () => {
        const { positions, indices } = seamed();
        const twins = twinsOf(positions);
        const ring = neighboursOf(indices, twins);
        const w = new Float32Array([0, 1, 1, 0, 1, 1, 0, 0]);
        brushDab(positions, w, twins, { center: [1, 0.5, 0], radius: 0.8, strength: 1, falloff: 0, mode: 'smooth', value: 0 }, ring);
        expect(w[1]).toBeLessThan(1);
        expect(w[1]).toBe(w[4]);
    });

    it('fills a welded piece, or a whole material range', () => {
        const { positions, indices } = seamed();
        const twins = twinsOf(positions);
        const w = new Float32Array(8);
        // The two quads are one piece through the seam's twins.
        expect(fillPiece(indices, twins, w, 0, 0.7).length).toBe(8);
        expect(Array.from(w).every(x => Math.abs(x - 0.7) < 1e-6)).toBe(true);
        const r = new Float32Array(8);
        fillRange(indices, twins, r, 0, 6, 1);
        expect(r[0]).toBe(1);
        expect(r[4]).toBe(1);   // twin of 1
        expect(r[6]).toBe(0);   // right quad only
    });
});
