import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const GRADE = readFileSync(join(__dirname, '../src/graphics/shaders/wgsl/chunks/grade.wgsl'), 'utf-8');

/** The night tint, read out of the shader so this emulation cannot drift from it. */
const TINT = (() => {
    const m = /PURKINJE_NIGHT_TINT: vec3<f32> = vec3<f32>\(([^)]+)\)/.exec(GRADE);
    if (!m) throw new Error('PURKINJE_NIGHT_TINT not found in grade.wgsl');
    return m[1].split(',').map(Number) as [number, number, number];
})();

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** A line-for-line JS twin of chunks/grade.wgsl `purkinjeShift`, with colours in cd/m2 (nitsPerUnit 1). */
function purkinjeShift(rgb: number[], strength = 1): number[] {
    const c = rgb.map(v => Math.max(v, 0));
    const X = 0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2];
    const Y = lum(c);
    const Z = 0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2];
    if (Y <= 0) return rgb;
    const V = Math.max(Y * (1.33 * (1 + (Y + Z) / Math.max(X, 1e-12)) - 1.68), 0) / 2.573;
    const w = (1 - smoothstep(-2.3, 0.7, Math.log10(Math.max(Y, 1e-12)))) * strength;
    return rgb.map((v, i) => v + (V * TINT[i] - v) * w);
}

/**
 * Night vision: below a few cd/m2 the rods take over — no colour, blue-green favoured, red lost — and above
 * the mesopic range nothing changes. These pin the behaviour, not the constants.
 */
describe('Purkinje shift', () => {
    it('leaves a daylit or lamp-lit pixel exactly as it is', () => {
        for (const c of [[100, 80, 60], [10, 10, 10], [30, 10, 4]]) {
            const out = purkinjeShift(c);
            for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(c[i], 9);
        }
    });

    it('keeps a white surface at night just as bright, and turns it bluish', () => {
        const white = [0.01, 0.01, 0.01];   // 0.01 cd/m2: a white wall under starlight
        const out = purkinjeShift(white);
        expect(lum(out) / lum(white)).toBeGreaterThan(0.95);
        expect(lum(out) / lum(white)).toBeLessThan(1.05);
        expect(out[2]).toBeGreaterThan(out[0]);
    });

    it('darkens reds and lifts blues in the dark, as rods see them', () => {
        const red = purkinjeShift([0.02, 0, 0]), blue = purkinjeShift([0, 0, 0.02]);
        expect(lum(red) / lum([0.02, 0, 0])).toBeLessThan(0.3);
        expect(lum(blue) / lum([0, 0, 0.02])).toBeGreaterThan(1.5);
    });

    it('drains colour progressively across the mesopic range, and not at all at strength 0', () => {
        const sat = (c: number[]) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
        const orange = (L: number) => [L * 2.2, L * 0.9, L * 0.3];
        const s = [3, 0.3, 0.03].map(L => sat(purkinjeShift(orange(L))));
        expect(s[0]).toBeGreaterThan(s[1]);
        expect(s[1]).toBeGreaterThan(s[2]);
        const off = purkinjeShift(orange(0.03), 0);
        expect(off).toEqual(orange(0.03));
    });
});

describe('the display resolves', () => {
    it('both apply night vision, local exposure and the dither', () => {
        for (const file of ['present.wgsl', 'outlinePost.wgsl']) {
            const src = readFileSync(join(__dirname, '../src/graphics/shaders/wgsl', file), 'utf-8');
            expect(src, file).toContain('purkinjeShift(');
            expect(src, file).toContain('localExposureStops(');
            expect(src, file).toContain('displayDither(');
        }
    });
});
