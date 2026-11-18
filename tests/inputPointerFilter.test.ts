import { describe, expect, it } from 'vitest';
import { createPointerSpikeFilter, pointerSpike } from '../src/input/pointerFilter';

describe('pointer-lock spike filter', () => {
    it('drops one huge reading among small ones', () => {
        const f = createPointerSpikeFilter();
        for (let i = 0; i < 5; i++) expect(pointerSpike(f, 3, 1)).toBe(false);
        expect(pointerSpike(f, 900, 0)).toBe(true);
        expect(pointerSpike(f, 3, 0)).toBe(false);
    });

    it('lets a fast flick through as it ramps up', () => {
        const f = createPointerSpikeFilter();
        pointerSpike(f, 2, 0);
        for (const dx of [20, 60, 140, 300, 420, 260, 90]) expect(pointerSpike(f, dx, 0)).toBe(false);
    });

    it('never drops a reading under the absolute floor, however still the mouse was', () => {
        const f = createPointerSpikeFilter();
        expect(pointerSpike(f, 120, 40)).toBe(false);
    });

    it('lets the rest of a flick through when its first reading was dropped', () => {
        const f = createPointerSpikeFilter();
        pointerSpike(f, 1, 0);
        expect(pointerSpike(f, 400, 0)).toBe(true);
        expect(pointerSpike(f, 500, 0)).toBe(false);
    });

    it('drops the first reading after a lock change, and only that one', () => {
        const f = createPointerSpikeFilter();
        f.dropNext = true;
        expect(pointerSpike(f, 40, 0)).toBe(true);
        expect(pointerSpike(f, 40, 0)).toBe(false);
    });

    it('drops a reading that is not a number', () => {
        const f = createPointerSpikeFilter();
        expect(pointerSpike(f, Number.NaN, 0)).toBe(true);
    });
});
