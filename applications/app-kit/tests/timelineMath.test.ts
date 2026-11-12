import { describe, it, expect } from 'vitest';
import {
    timeToX, xToTime, snapToFps, clampZoom, zoomStep, fitZoom, rulerTicks, formatTick, formatTimecode,
    passedDragThreshold, snapTime, MIN_PX_PER_SEC, MAX_PX_PER_SEC,
} from '../src/timeline/timelineMath';

describe('timeline math', () => {
    it('maps time to x and back, through the gutter and the scroll', () => {
        expect(timeToX(2, 100, 14)).toBe(214);
        // A pointer 300 px into a scroller scrolled 100 px, with a 14 px gutter, at 100 px/s.
        expect(xToTime(350, 50, 100, 100, 14)).toBeCloseTo(3.86, 6);
        expect(xToTime(0, 50, 0, 100, 14)).toBe(0);
        for (const t of [0, 0.5, 7.25]) expect(xToTime(timeToX(t, 180, 14) + 20, 20, 0, 180, 14)).toBeCloseTo(t, 9);
    });

    it('snaps to frames', () => {
        expect(snapToFps(1.01, 30)).toBeCloseTo(1, 9);
        expect(snapToFps(1.02, 30)).toBeCloseTo(31 / 30, 9);
        expect(snapToFps(1.02, 0)).toBe(1.02);
    });

    it('zooms within its bounds', () => {
        expect(clampZoom(1)).toBe(MIN_PX_PER_SEC);
        expect(clampZoom(1e6)).toBe(MAX_PX_PER_SEC);
        expect(zoomStep(100, -1)).toBeCloseTo(115, 9);
        expect(zoomStep(115, 1)).toBeCloseTo(100, 9);
        expect(fitZoom(840, 10, 0, 40)).toBe(80);
        expect(fitZoom(100, 1000)).toBe(MIN_PX_PER_SEC);
        // A long timeline lowers the floor.
        expect(fitZoom(850, 410, 10, 40, 1)).toBeCloseTo(800 / 410, 9);
        expect(zoomStep(2, 1, 1.15, 1)).toBeCloseTo(2 / 1.15, 9);
    });

    it('lays the ruler out with majors at least 70 px apart', () => {
        const ticks = rulerTicks(0, 10, 100);
        const majors = ticks.filter(t => t.major).map(t => t.t);
        expect(majors.slice(0, 3)).toEqual([0, 1, 2]);
        expect(ticks.length).toBe(51);
        // Only the visible range.
        const late = rulerTicks(100, 102, 100);
        expect(late[0].t).toBeGreaterThanOrEqual(99.8);
        expect(late.at(-1)!.t).toBeLessThanOrEqual(102 + 1e-6);
        // Zoomed far out, the spacing grows.
        expect(rulerTicks(0, 600, 1).filter(t => t.major)[1].t).toBe(60);
    });

    it('labels ticks and timecodes', () => {
        expect(formatTick(2)).toBe('2s');
        expect(formatTick(0.25)).toBe('0.25s');
        expect(formatTick(90)).toBe('1:30');
        expect(formatTimecode(0, 30)).toBe('00:00.00');
        expect(formatTimecode(61.5, 30)).toBe('01:01.15');
        expect(formatTimecode(1 - 1e-9, 30)).toBe('00:00.29');
    });

    it('tells a drag from a click, and snaps to nearby targets before frames', () => {
        expect(passedDragThreshold(2, 0)).toBe(false);
        expect(passedDragThreshold(3, 0)).toBe(true);
        expect(passedDragThreshold(2, 2.5)).toBe(true);
        // 4.03 is 3 px from the target 4 at 100 px/s: it snaps there.
        expect(snapTime(4.03, [4, 10], 100, 6, 30)).toBe(4);
        // Too far from any target: the frame grid.
        expect(snapTime(5.51, [4, 10], 100, 6, 30)).toBeCloseTo(5.5 + 1 / 30 * 0, 6);
        expect(snapTime(5.51, [], 100, 6, 0)).toBe(5.51);
    });
});
