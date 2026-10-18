import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { foliageEffectiveCull, foliageLodBands, foliageKeepFraction, type FoliageBand } from '../src/terrain/foliage';

// Foliage pop-in. A 10 m pine with generated LODs had bands at 80/160/320 m while "no cull set" meant
// the scene's 65 m: only LOD0 ever drew, and trees vanished at 65 m without becoming their impostor.
// Mesh layers were also thinned by a quarter at every level switch, new cells waited a frame (and
// trickled in after turning around), and every transition was a whole 13 m cell switching at once.

const pine = (over: Partial<{ cullDistance: number; billboardDistance: number; impostor: boolean }> = {}) => ({
    kind: 'mesh' as const,
    cullDistance: over.cullDistance ?? 0,
    levels: [{ distance: 0 }, { distance: 80 }, { distance: 160 }, { distance: 320 }],
    billboardModel: over.impostor === false ? null : {},
    billboardDistance: over.billboardDistance ?? 640,   // a new bake: twice the last band
});

describe('foliageEffectiveCull', () => {
    it('draws a mesh layer past its impostor band instead of the scene default', () => {
        expect(foliageEffectiveCull(pine(), 65)).toBe(960);
    });
    it('uses the last LOD level when there is no impostor', () => {
        expect(foliageEffectiveCull(pine({ impostor: false }), 65)).toBe(480);
        expect(foliageEffectiveCull({ ...pine({ impostor: false }), levels: [{ distance: 0 }, { distance: 20 }] }, 65)).toBe(65);
    });
    it('an explicit cull wins; grass keeps the scene distance; 0 scene distance = unlimited', () => {
        expect(foliageEffectiveCull(pine({ cullDistance: 120 }), 65)).toBe(120);
        expect(foliageEffectiveCull({ ...pine(), kind: 'billboard' }, 65)).toBe(65);
        expect(foliageEffectiveCull(pine(), 0)).toBe(0);
    });
});

describe('density thinning', () => {
    it('never thins mesh props (trees), only grass', () => {
        for (let b = 0; b <= 4; b++) expect(foliageKeepFraction(b, 4, 0.75, 'mesh')).toBe(1);
        expect(foliageKeepFraction(2, 4, 0.75, 'billboard')).toBeLessThan(1);
    });
});

// The vertex stage's per-instance fade (chunks/instancedVertex.wgsl), mirrored.
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const fade = (band: FoliageBand, d: number) => ({
    in: band.inEnd > band.inStart ? smooth(band.inStart, band.inEnd, d) : 1,
    out: band.outEnd > band.outStart ? 1 - smooth(band.outStart, band.outEnd, d) : 1,
});
// The fragment stage's dither (lodFadeKeeps), mirrored.
const keeps = (f: { in: number; out: number }, t: number) => (1 - t) < f.in && t < f.out;

describe('foliageLodBands: the per-instance crossfade', () => {
    const cull = foliageEffectiveCull(pine(), 65);
    const bands = foliageLodBands(pine(), cull);

    it('gives every level and the impostor a band, each fading out exactly where the next fades in', () => {
        expect(bands.every(Boolean)).toBe(true);
        for (let i = 0; i + 1 < bands.length; i++) {
            expect(bands[i]!.outStart).toBeCloseTo(bands[i + 1]!.inStart, 9);
            expect(bands[i]!.outEnd).toBeCloseTo(bands[i + 1]!.inEnd, 9);
        }
        expect(bands[4]!.outEnd).toBe(cull);   // the impostor dissolves out at the cull
    });

    it('covers every pixel exactly once at every distance up to the cull — no hole, no double', () => {
        const thresholds = Array.from({ length: 16 }, (_, k) => (k + 0.5) / 16);
        // Up to where the last band starts dissolving out at the cull (that ramp is meant to thin).
        for (let d = 0; d < bands[4]!.outStart; d += 0.37) {
            for (const t of thresholds) {
                const drawn = bands.filter(b => keeps(fade(b!, d), t)).length;
                expect(drawn, `d=${d.toFixed(2)} t=${t}`).toBe(1);
            }
        }
    });

    it('dissolves out to nothing at the cull distance', () => {
        const last = bands[4]!;
        expect(fade(last, cull).out).toBe(0);
        expect(fade(last, last.outStart - 1).out).toBe(1);
    });

    it('drops a level that starts beyond the impostor or the cull', () => {
        const b = foliageLodBands({ ...pine(), billboardDistance: 150 }, 225);
        expect(b[3]).toBeNull();           // LOD3 at 320 m never draws: the impostor takes over at 150
        expect(b[4]!.inEnd).toBe(150);
    });
});

describe('renderer wiring', () => {
    const renderer = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8');
    it('admits off-screen in-range cells for free and draws admitted cells the same frame', () => {
        expect(renderer).toContain('if (!p.onScreen) { p.cell.visible = true; continue; }');
        expect(renderer).toMatch(/p\.cell\.visible = true;\s*place\(p\.cell\);/);
    });
    it('uses the effective cull for colour and shadows alike', () => {
        expect(renderer.match(/foliageEffectiveCull\(layer, this\._foliageCullDistance\)/g)?.length).toBe(2);
    });
    it('turns the crossfade off for placed (non-foliage) instanced models', () => {
        expect(renderer.match(/setUniform\('u_lodCamera', Renderer\._LOD_OFF\)/g)?.length).toBe(2);
    });
});
