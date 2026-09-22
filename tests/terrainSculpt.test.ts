import { describe, it, expect } from 'vitest';
import {
    applySculpt, brushWeight, curveWeight, brushRegion, readRegion, writeRegion, terraceHeight, fbm, seededRandom,
    gridElement, type HeightGrid, type BrushSpec,
} from '../src/terrain/sculpt';
import { brushFalloffWeight } from '../src/terrain/brushFalloff';

/** A size x size terrain with `res` samples per side, flat at `h`. */
function grid(res = 33, size = 32, h = 0): HeightGrid {
    return { heights: new Float32Array(res * res).fill(h), resolution: res, size };
}
const at = (g: HeightGrid, c: number, r: number) => g.heights[r * g.resolution + c];
const sum = (g: HeightGrid) => g.heights.reduce((a, b) => a + b, 0);
const brush = (over: Partial<BrushSpec> = {}): BrushSpec => ({ x: 0, z: 0, radius: 6, falloff: 0.5, ...over });

describe('falloff curves', () => {
    it('soft is exactly the brush falloff the decal draws', () => {
        for (const t of [0, 0.2, 0.5, 0.9]) for (const f of [0, 0.3, 1])
            expect(curveWeight(t, f, 'soft')).toBe(brushFalloffWeight(t, f));
    });

    it('the fraction curves are full strength inside 1 - falloff and reach 0 at the rim', () => {
        for (const curve of ['smooth', 'linear', 'sphere', 'tip'] as const) {
            expect(curveWeight(0.3, 0.5, curve)).toBe(1);
            expect(curveWeight(0.5, 0.5, curve)).toBe(1);
            expect(curveWeight(0.999999, 0.5, curve)).toBeLessThan(0.01);
            expect(curveWeight(1.2, 0.5, curve)).toBe(0);
            // Monotone across the fade.
            let prev = 1;
            for (let t = 0.5; t < 1; t += 0.05) {
                const w = curveWeight(t, 0.5, curve);
                expect(w).toBeLessThanOrEqual(prev + 1e-12);
                prev = w;
            }
        }
    });

    it('a zero falloff is a hard disc for every curve', () => {
        for (const curve of ['soft', 'smooth', 'linear', 'sphere', 'tip'] as const)
            expect(curveWeight(0.95, 0, curve)).toBe(1);
    });
});

describe('brush shapes', () => {
    it('a circle and a square differ on the diagonal', () => {
        const d = 5 / Math.SQRT2 + 0.5;
        expect(brushWeight(d, d, brush({ radius: 5, falloff: 0 }))).toBe(0);
        expect(brushWeight(d, d, brush({ radius: 5, falloff: 0, shape: 'square' }))).toBe(1);
    });

    it('rotating a square by 45 degrees turns its corner into an edge', () => {
        const b = brush({ radius: 5, falloff: 0, shape: 'square', rotation: 45 });
        expect(brushWeight(4.9, 0, b)).toBe(1);
        expect(brushWeight(4, 4, b)).toBe(0);
    });

    it('a stamp shapes the brush by its alpha', () => {
        // Left half opaque, right half transparent.
        const data = new Float32Array([1, 0, 1, 0]);
        const b = brush({ radius: 5, falloff: 0, stamp: { data, width: 2, height: 2 } });
        expect(brushWeight(-4.9, 0, b)).toBeGreaterThan(0.95);
        expect(brushWeight(4.9, 0, b)).toBeLessThan(0.05);
    });
});

describe('raise and lower', () => {
    it('change only samples inside the brush, and report exactly that rectangle', () => {
        const g = grid();
        const reg = applySculpt(g, brush({ radius: 4, falloff: 0 }), { tool: 'raise', amount: 2 })!;
        expect(at(g, 16, 16)).toBe(2);
        expect(at(g, 0, 0)).toBe(0);
        // 4 world units at 1 unit per sample: columns 12..20.
        expect(reg).toEqual({ c0: 12, r0: 12, c1: 20, r1: 20 });
        applySculpt(g, brush({ radius: 4, falloff: 0 }), { tool: 'lower', amount: 2 });
        expect(Math.max(...g.heights)).toBe(0);
    });

    it('a brush wholly outside the terrain does nothing', () => {
        const g = grid();
        expect(applySculpt(g, brush({ x: 500 }), { tool: 'raise', amount: 1 })).toBeNull();
    });
});

describe('smooth', () => {
    it('reduces a spike toward its neighbourhood without moving far-away ground', () => {
        const g = grid();
        g.heights[16 * 33 + 16] = 10;
        applySculpt(g, brush({ radius: 3, falloff: 0 }), { tool: 'smooth', amount: 1 });
        expect(at(g, 16, 16)).toBeLessThan(10);
        expect(at(g, 16, 16)).toBeGreaterThan(0);
        expect(at(g, 30, 30)).toBe(0);
    });

    it('does not depend on scan order (it reads a snapshot)', () => {
        const a = grid(), b = grid();
        for (let i = 0; i < a.heights.length; i++) a.heights[i] = b.heights[i] = Math.sin(i * 0.37) * 3;
        applySculpt(a, brush({ radius: 5 }), { tool: 'smooth', amount: 0.8 });
        // Mirror b, smooth, mirror back: same result iff no scan-order dependence.
        const R = 33;
        const mirror = (h: Float32Array) => {
            const out = new Float32Array(h.length);
            for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) out[r * R + c] = h[r * R + (R - 1 - c)];
            return out;
        };
        b.heights.set(mirror(b.heights));
        applySculpt(b, brush({ radius: 5 }), { tool: 'smooth', amount: 0.8 });
        const back = mirror(b.heights);
        for (let i = 0; i < back.length; i++) expect(back[i]).toBeCloseTo(a.heights[i], 5);
    });
});

describe('flatten and set height', () => {
    it('both mode meets the target from above and below', () => {
        const g = grid();
        g.heights.fill(4, 0, 33 * 16);
        applySculpt(g, brush({ radius: 40, falloff: 0 }), { tool: 'flatten', amount: 1, target: 2 });
        expect(Math.max(...g.heights)).toBe(2);
        expect(Math.min(...g.heights)).toBe(2);
    });

    it('raise-only never lowers and lower-only never raises', () => {
        const g = grid();
        for (let i = 0; i < g.heights.length; i++) g.heights[i] = i % 2 ? 5 : -5;
        const up = grid(); up.heights.set(g.heights);
        applySculpt(up, brush({ radius: 40, falloff: 0 }), { tool: 'flatten', amount: 1, target: 0, flattenMode: 'raise' });
        expect(Math.max(...up.heights)).toBe(5);
        expect(Math.min(...up.heights)).toBe(0);
        const down = grid(); down.heights.set(g.heights);
        applySculpt(down, brush({ radius: 40, falloff: 0 }), { tool: 'flatten', amount: 1, target: 0, flattenMode: 'lower' });
        expect(Math.max(...down.heights)).toBe(0);
        expect(Math.min(...down.heights)).toBe(-5);
    });

    it('set height moves toward an explicit value', () => {
        const g = grid();
        applySculpt(g, brush({ radius: 3, falloff: 0 }), { tool: 'setHeight', amount: 1, target: 7 });
        expect(at(g, 16, 16)).toBe(7);
    });
});

describe('ramp', () => {
    it('lays a straight slope from one end to the other within its width', () => {
        const g = grid();
        applySculpt(g, brush({ radius: 2, falloff: 0 }), {
            tool: 'ramp', amount: 1, rampFrom: { x: -10, z: 0, h: 0 }, rampTo: { x: 10, z: 0, h: 10 },
        });
        expect(at(g, 16 - 10, 16)).toBeCloseTo(0, 6);
        expect(at(g, 16, 16)).toBeCloseTo(5, 6);
        expect(at(g, 16 + 10, 16)).toBeCloseTo(10, 6);
        expect(at(g, 16, 16 + 5)).toBe(0); // outside the half-width
    });
});

describe('noise', () => {
    it('is deterministic, and zero-mean-ish over an area', () => {
        const a = grid(), b = grid();
        applySculpt(a, brush({ radius: 12, falloff: 0 }), { tool: 'noise', amount: 1, noiseScale: 3, noiseSeed: 4 });
        applySculpt(b, brush({ radius: 12, falloff: 0 }), { tool: 'noise', amount: 1, noiseScale: 3, noiseSeed: 4 });
        expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
        let s = 0, n = 0;
        for (let i = 0; i < a.heights.length; i++) if (a.heights[i] !== 0) { s += a.heights[i]; n++; }
        expect(Math.abs(s / n)).toBeLessThan(0.35);
    });

    it('fbm stays within -1..1', () => {
        for (let i = 0; i < 300; i++) {
            const v = fbm(i * 0.731, i * -0.419, 2);
            expect(v).toBeGreaterThanOrEqual(-1);
            expect(v).toBeLessThanOrEqual(1);
        }
    });
});

describe('terrace', () => {
    it('keeps each step boundary fixed and flattens the tread', () => {
        expect(terraceHeight(4, 2, 1)).toBeCloseTo(4, 9);
        expect(terraceHeight(4.5, 2, 1)).toBeLessThan(4.1);
        expect(terraceHeight(-3, 2, 0)).toBeCloseTo(-3, 9); // sharpness 0 is linear
    });

    it('turns a slope into steps', () => {
        const g = grid();
        for (let r = 0; r < 33; r++) for (let c = 0; c < 33; c++) g.heights[r * 33 + c] = c * 0.25;
        applySculpt(g, brush({ radius: 40, falloff: 0 }), { tool: 'terrace', amount: 1, terraceStep: 2, terraceSharpness: 1 });
        // Within one tread the height barely changes.
        expect(Math.abs(at(g, 9, 5) - at(g, 11, 5))).toBeLessThan(0.1);
    });
});

describe('thermal erosion', () => {
    it('conserves mass and softens a cliff', () => {
        const g = grid();
        for (let r = 0; r < 33; r++) for (let c = 17; c < 33; c++) g.heights[r * 33 + c] = 10;
        const before = sum(g);
        const e = gridElement(g);
        const steep = () => { let m = 0; for (let c = 10; c < 22; c++) m = Math.max(m, Math.abs(at(g, c + 1, 16) - at(g, c, 16)) / e); return m; };
        const s0 = steep();
        applySculpt(g, brush({ radius: 8, falloff: 0 }), { tool: 'erode', amount: 1, talusDegrees: 30, iterations: 20 });
        expect(sum(g)).toBeCloseTo(before, 2);
        expect(steep()).toBeLessThan(s0);
    });
});

describe('hydraulic erosion', () => {
    it('conserves mass, stays inside its region and is reproducible with a seed', () => {
        const make = () => {
            const g = grid(65, 64);
            for (let r = 0; r < 65; r++) for (let c = 0; c < 65; c++)
                g.heights[r * 65 + c] = 20 - Math.hypot(c - 32, r - 32) * 0.6 + Math.sin(c * 0.9) * 0.4;
            return g;
        };
        const a = make(), b = make();
        const before = sum(a);
        const reg = brushRegion(a, brush({ radius: 10 }))!;
        const outside = readRegion(a, { c0: 0, r0: 0, c1: 5, r1: 5 });
        const ra = applySculpt(a, brush({ radius: 10 }), { tool: 'hydro', amount: 1, iterations: 2, random: seededRandom(7) });
        applySculpt(b, brush({ radius: 10 }), { tool: 'hydro', amount: 1, iterations: 2, random: seededRandom(7) });
        expect(ra).not.toBeNull();
        expect(sum(a)).toBeCloseTo(before, 1);
        expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
        expect(ra!.c0).toBeGreaterThanOrEqual(reg.c0);
        expect(ra!.c1).toBeLessThanOrEqual(reg.c1);
        expect(Array.from(readRegion(a, { c0: 0, r0: 0, c1: 5, r1: 5 }))).toEqual(Array.from(outside));
    });
});

describe('region copies', () => {
    it('read and write are inverse', () => {
        const g = grid();
        for (let i = 0; i < g.heights.length; i++) g.heights[i] = i;
        const reg = { c0: 3, r0: 4, c1: 9, r1: 6 };
        const saved = readRegion(g, reg);
        applySculpt(g, brush({ x: -10, z: -12, radius: 5 }), { tool: 'raise', amount: 9 });
        writeRegion(g, reg, saved);
        expect(Array.from(readRegion(g, reg))).toEqual(Array.from(saved));
    });
});
