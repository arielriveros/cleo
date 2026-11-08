import { describe, expect, it } from 'vitest';
import {
    GI_HIT_BACK, GI_HIT_FRONT, GI_HIT_MISS, GI_PROBE_ACTIVE, GI_PROBE_INACTIVE, GI_PROBE_UNCAPTURED,
    classifyHitRows, classifyProbe, countStates, hitKind, isUnderground,
} from '../src/graphics/render/gi/giClassify';
import { hitCacheSize, hitTileOrigin } from '../src/graphics/render/gi/giLayout';

/** A hit cache A readback where probe p's tile has `back[p]` back-face rays (the rest front). */
function hitCache(probes: number, rays: number, back: (p: number) => number): { pixels: Uint8Array; w: number; h: number } {
    const [w, h] = hitCacheSize(probes, rays);
    const side = Math.sqrt(rays);
    const pixels = new Uint8Array(w * h * 4);
    for (let p = 0; p < probes; p++) {
        const [ox, oy] = hitTileOrigin(p, rays);
        let n = back(p);
        for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
            const i = ((oy + y) * w + ox + x) * 4;
            pixels[i + 3] = n-- > 0 ? GI_HIT_BACK : (x === 0 ? GI_HIT_MISS : GI_HIT_FRONT);
        }
    }
    return { pixels, w, h };
}

describe('GI probe classification', () => {
    it('reads the three hit kinds, tolerant of in-between bytes', () => {
        expect(hitKind(0)).toBe('miss');
        expect(hitKind(30)).toBe('miss');
        expect(hitKind(128)).toBe('back');
        expect(hitKind(140)).toBe('back');
        expect(hitKind(255)).toBe('front');
        expect(hitKind(200)).toBe('front');
    });

    it('switches a probe off past a quarter of its rays on back faces', () => {
        expect(classifyProbe(0)).toBe(GI_PROBE_ACTIVE);
        expect(classifyProbe(0.25)).toBe(GI_PROBE_ACTIVE);
        expect(classifyProbe(0.26)).toBe(GI_PROBE_INACTIVE);
    });

    it('classifies probes from a hit cache readback, whole rows at a time', () => {
        const probes = 130, rays = 64;
        const { pixels, h } = hitCache(probes, rays, p => (p % 3 === 0 ? 40 : 3));
        const states = new Uint8Array(probes);
        expect(classifyHitRows(pixels, 0, h, rays, 0, probes, states)).toBe(probes);
        for (let p = 0; p < probes; p++) expect(states[p]).toBe(p % 3 === 0 ? GI_PROBE_INACTIVE : GI_PROBE_ACTIVE);
    });

    it('classifies only the probes whose tiles lie in the rows read', () => {
        const probes = 200, rays = 256;
        const { pixels } = hitCache(probes, rays, () => 200);
        const side = 16, w = 64 * side;
        // The second tile row only (probes 64..127).
        const rows = pixels.subarray(side * w * 4, 2 * side * w * 4);
        const states = new Uint8Array(probes);
        expect(classifyHitRows(rows, side, side, rays, 0, probes, states)).toBe(64);
        expect(states[10]).toBe(GI_PROBE_UNCAPTURED);
        expect(states[64]).toBe(GI_PROBE_INACTIVE);
        expect(states[127]).toBe(GI_PROBE_INACTIVE);
        expect(states[128]).toBe(GI_PROBE_UNCAPTURED);
        expect(countStates(states)).toEqual({ uncaptured: 136, active: 0, inactive: 64, skipped: 0 });
    });

    it('skips a probe under the terrain', () => {
        expect(isUnderground(1, 2)).toBe(true);
        expect(isUnderground(2.01, 2)).toBe(true);
        expect(isUnderground(2.5, 2)).toBe(false);
        expect(isUnderground(-100, null)).toBe(false);
        expect(isUnderground(-100, NaN)).toBe(false);
    });
});
