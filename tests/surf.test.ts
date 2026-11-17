import { describe, it, expect } from 'vitest';
import { surfAt, surfOf, surfTravelTime, type SurfSample, type SurfWave } from '../src/physics/water/surf';
import { seaState, waveOmega, wavesForWind } from '../src/physics/water/waves';

// The surf over an ocean beach (physics/water/surf.ts, twin of water.wgsl surfAt): breakers at the sea's
// period moving in at the shallow-water speed, growing as the water shoals, breaking at 0.78 of the depth.

const sample = (): SurfSample => ({ height: 0, rate: 0, slopeX: 0, slopeZ: 0, breaking: 0, phase: 0, wavelength: 0 });

/** A planar beach along +x: the shore at x = 100, the bed sloping `slope` down seaward. */
function beach(s: SurfWave, slope: number) {
    const out = sample();
    const at = (x: number, t: number) => {
        const edge = 100 - x, depth = slope * edge;
        // The travel time's gradient along x (it falls toward the shore).
        const d = 0.5;
        const tx = (surfTravelTime(100 - (x + d), slope * (100 - (x + d))) - surfTravelTime(100 - (x - d), slope * (100 - (x - d)))) / (2 * d);
        return { ...surfAt(s, x, 3, t, edge, depth, tx, 0, out) };
    };
    return at;
}

describe('surf', () => {
    it('takes the sea’s energy-weighted period and half its significant height', () => {
        const waves = wavesForWind(8, 90, Infinity);
        const s = surfOf(waves, 1);
        expect(s.amplitude).toBeCloseTo(seaState(8, Infinity).hs / 2, 6);
        const omegas = waves.map(w => waveOmega(2 * Math.PI / w.wavelength));
        expect(s.omega).toBeGreaterThan(Math.min(...omegas));
        expect(s.omega).toBeLessThan(Math.max(...omegas));
        expect(surfOf(waves, 0).amplitude).toBe(0);
    });

    it('is nothing in deep water and grows as the beach shoals, then breaks', () => {
        const s: SurfWave = { omega: 1.3, amplitude: 0.5 };
        const at = beach(s, 0.05);
        const swing = (x: number) => {
            let hi = 0;
            for (let t = 0; t < 60; t += 0.1) hi = Math.max(hi, Math.abs(at(x, t).height));
            return hi;
        };
        expect(swing(100 - 400)).toBe(0);                 // 20 m deep: the open sea's own waves
        const offshore = swing(100 - 80);                  // 4 m: shoaling
        const breaking = swing(100 - 30);                  // 1.5 m: about where a 0.5 m wave breaks
        expect(offshore).toBeGreaterThan(0.1);
        expect(breaking).toBeGreaterThan(offshore);
        // Never taller than 0.78 of the depth allows (plus the run-up at the waterline).
        for (const edge of [2, 5, 10]) expect(swing(100 - edge)).toBeLessThanOrEqual(0.39 * 0.05 * edge + 0.5 * 0.5 + 1e-6);
        expect(at(100 - 10, 3).breaking).toBe(1);
        expect(at(100 - 300, 3).breaking).toBe(0);
    });

    it('runs in toward the shore at the shallow-water speed', () => {
        const s: SurfWave = { omega: 1.3, amplitude: 0.5 };
        const at = beach(s, 0.05);
        // The crest a point climbs to at time t (a crest moves a metre or so in the steps below, well inside
        // the slope of the one it was on).
        const crest = (x0: number, t: number) => {
            let x = x0;
            for (let i = 0; i < 4000; i++) {
                const up = at(x + 0.01, t).height, down = at(x - 0.01, t).height, here = at(x, t).height;
                if (here >= up && here >= down) break;
                x += up > down ? 0.01 : -0.01;
            }
            return x;
        };
        const x0 = crest(100 - 20, 10);   // 1 m deep: in the surf whatever the set
        const x1 = crest(x0, 10.2);
        const speed = (x1 - x0) / 0.2;
        expect(speed).toBeGreaterThan(0);                                  // toward the shore (+x)
        const c = Math.sqrt(9.81 * 0.05 * (100 - x0));
        expect(speed).toBeGreaterThan(c * 0.6);
        expect(speed).toBeLessThan(c * 1.6);
    });

    it('slopes as its height changes across the beach', () => {
        const s: SurfWave = { omega: 1.3, amplitude: 0.5 };
        const at = beach(s, 0.05);
        for (const t of [1, 2.5, 4]) {
            const x = 100 - 40, d = 0.01;
            const numeric = (at(x + d, t).height - at(x - d, t).height) / (2 * d);
            // The analytic slope leaves out how the envelope changes along the beach: close, not exact.
            expect(at(x, t).slopeX).toBeCloseTo(numeric, 1);
        }
    });
});
