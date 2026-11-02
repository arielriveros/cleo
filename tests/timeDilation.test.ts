import { describe, it, expect } from 'vitest';
import { TimeDilation } from '../src/core/timeDilation';

// The game clock's speed (src/core/timeDilation.ts): a base time scale times a brief dilation (a hit-stop)
// that counts down in REAL time.

/** Run `frames` frames of `dt` real seconds; the game time they add up to. */
function run(d: TimeDilation, frames: number, dt = 1 / 60): number {
    let game = 0;
    for (let i = 0; i < frames; i++) game += dt * d.update(dt);
    return game;
}

describe('time dilation', () => {
    it('runs at the base scale, clamped to non-negative', () => {
        const d = new TimeDilation();
        expect(d.update(1 / 60)).toBe(1);
        d.base = 0.5;
        expect(d.update(1 / 60)).toBe(0.5);
        d.base = -3;
        expect(d.base).toBe(0);
        d.base = NaN;
        expect(d.base).toBe(0);
    });

    it('holds a hit-stop for its real duration, then returns to the base scale exactly', () => {
        const d = new TimeDilation();
        d.dilate(0.2, 0.1, { easeOut: 0 });
        // 6 frames of 1/60 s = 0.1 s at 0.2, then real time again.
        const scales = Array.from({ length: 8 }, () => d.update(1 / 60));
        expect(scales.slice(0, 6).every(s => s === 0.2)).toBe(true);
        expect(scales[6]).toBe(1);
        expect(d.active).toBe(false);
    });

    it('slows the game clock by the asked amount over the hold', () => {
        const d = new TimeDilation();
        d.dilate(0.2, 0.5, { easeOut: 0 });
        expect(run(d, 30)).toBeCloseTo(0.5 * 0.2, 9);
        expect(run(d, 60)).toBeCloseTo(1, 9);
    });

    it('eases back to full speed over the last share, never overshooting', () => {
        const d = new TimeDilation();
        d.dilate(0.2, 0.1, { easeOut: 0.5 });
        const scales = Array.from({ length: 7 }, () => d.update(1 / 60));
        expect(scales[0]).toBe(0.2);
        for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1]);
        expect(scales.every(s => s >= 0.2 && s <= 1)).toBe(true);
        expect(scales[6]).toBe(1);
    });

    it('multiplies with the base scale', () => {
        const d = new TimeDilation();
        d.base = 0.5;
        d.dilate(0.2, 1, { easeOut: 0 });
        expect(d.update(1 / 60)).toBeCloseTo(0.1, 12);
        d.clear();
        expect(d.update(1 / 60)).toBe(0.5);
    });

    it('merges overlapping dilations: the slower scale and the later end win', () => {
        const d = new TimeDilation();
        d.dilate(0.5, 0.2, { easeOut: 0 });
        d.update(0.1);                       // 0.1 s left
        d.dilate(0.2, 0.05, { easeOut: 0 }); // deeper but shorter: deepens, keeps the end
        expect(d.dilation).toBe(0.2);
        d.update(0.06);
        expect(d.active).toBe(true);         // still 0.04 s of the first one
        d.update(0.05);
        expect(d.active).toBe(false);
    });

    it('ignores a dilation of no length', () => {
        const d = new TimeDilation();
        d.dilate(0.2, 0);
        d.dilate(0.2, -1);
        expect(d.active).toBe(false);
        expect(d.update(1 / 60)).toBe(1);
    });
});

describe('time dilation on a slow machine', () => {
    it('holds at least `minFrames` frames at the slow scale, however long the frames', () => {
        const d = new TimeDilation();
        d.dilate(0.2, 0.08, { minFrames: 2 });
        // 15 fps: the 0.08 s are gone after one frame, but two frames run slowed.
        const scales = Array.from({ length: 4 }, () => d.update(1 / 15));
        expect(scales).toEqual([0.2, 0.2, 1, 1]);
    });

    it('lets a fast frame rate run the full duration with its ease-out', () => {
        const d = new TimeDilation();
        d.dilate(0.2, 0.1, { minFrames: 2, easeOut: 0.5 });
        const scales = Array.from({ length: 8 }, () => d.update(1 / 60));
        expect(scales.slice(0, 3).every(s => s === 0.2)).toBe(true);
        expect(scales[4]).toBeGreaterThan(0.2);
        expect(scales[6]).toBe(1);
    });
});
