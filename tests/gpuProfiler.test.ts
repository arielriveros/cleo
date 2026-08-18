import { describe, it, expect } from 'vitest';
import { Ring, frameHistory, gpuProfiler, RENDER_PASSES, TOGGLEABLE_PASSES } from '../src/graphics/gpuProfiler';

// The profiler's GL half needs a real context and so is deliberately out of scope for this suite
// (see the policy note in vitest.config.ts). What IS testable here is the part that decides what the
// profiler panel displays: the ring buffer's wraparound, the percentile maths behind the p50/p95
// readouts, and the pass-name tables the renderer and UI both key off.

describe('Ring', () => {
    it('reports nothing before any samples arrive', () => {
        const r = new Ring(4);
        expect(r.length).toBe(0);
        expect(r.last).toBe(0);
        expect(r.max).toBe(0);
        expect(r.mean).toBe(0);
        expect(r.percentile(0.5)).toBe(0);
        expect(r.toArray()).toEqual([]);
    });

    it('fills without wrapping', () => {
        const r = new Ring(4);
        r.push(1); r.push(2); r.push(3);
        expect(r.length).toBe(3);
        expect(r.toArray()).toEqual([1, 2, 3]);
        expect(r.last).toBe(3);
    });

    it('overwrites oldest-first once full, and reports values oldest-first', () => {
        const r = new Ring(4);
        for (const v of [1, 2, 3, 4, 5, 6]) r.push(v);
        expect(r.length).toBe(4);
        expect(r.capacity).toBe(4);
        // 1 and 2 have been overwritten by 5 and 6; the readout must still be chronological.
        expect(r.toArray()).toEqual([3, 4, 5, 6]);
        expect(r.last).toBe(6);
        expect(r.max).toBe(6);
    });

    it('max and mean ignore the unfilled tail', () => {
        // A naive implementation reading the whole backing array would average in the zeros.
        const r = new Ring(10);
        r.push(4); r.push(6);
        expect(r.max).toBe(6);
        expect(r.mean).toBe(5);
    });

    it('computes nearest-rank percentiles', () => {
        const r = new Ring(10);
        for (let v = 1; v <= 10; v++) r.push(v);
        expect(r.percentile(0)).toBe(1);
        expect(r.percentile(1)).toBe(10);
        expect(r.percentile(0.5)).toBe(6);   // round(0.5 * 9) = 5 -> sorted[5]
        expect(r.percentile(0.95)).toBe(10); // round(0.95 * 9) = 9 -> sorted[9]
    });

    it('sorts numerically, not lexicographically, when computing percentiles', () => {
        // The classic Array.prototype.sort trap: [2, 10] would order as [10, 2] lexicographically.
        const r = new Ring(4);
        r.push(10); r.push(2); r.push(100); r.push(9);
        expect(r.percentile(1)).toBe(100);
        expect(r.percentile(0)).toBe(2);
    });

    it('percentile does not disturb the stored series', () => {
        // percentile() sorts into a scratch buffer; sorting in place would silently reorder history.
        const r = new Ring(5);
        for (const v of [5, 1, 4, 2, 3]) r.push(v);
        r.percentile(0.5);
        expect(r.toArray()).toEqual([5, 1, 4, 2, 3]);
    });

    it('clear() resets to empty and reuses the buffer', () => {
        const r = new Ring(3);
        r.push(1); r.push(2);
        r.clear();
        expect(r.length).toBe(0);
        expect(r.toArray()).toEqual([]);
        r.push(7);
        expect(r.toArray()).toEqual([7]);
    });
});

describe('frameHistory', () => {
    it('pushes each sample onto its matching series', () => {
        frameHistory.clear();
        frameHistory.push({ frameMs: 8.3, cpuRenderMs: 1.2, gpuMs: 6.0 });
        frameHistory.push({ frameMs: 12.5, cpuRenderMs: 1.4, gpuMs: 9.5 });
        expect(frameHistory.frame.toArray()).toEqual([8.3, 12.5]);
        expect(frameHistory.cpuRender.toArray()).toEqual([1.2, 1.4]);
        expect(frameHistory.gpu.toArray()).toEqual([6, 9.5]);
        frameHistory.clear();
        expect(frameHistory.frame.length).toBe(0);
    });
});

describe('pass tables', () => {
    it('has no duplicate pass names', () => {
        expect(new Set(RENDER_PASSES).size).toBe(RENDER_PASSES.length);
    });

    it('only offers switches for passes the renderer actually times', () => {
        // The profiler panel keys its toggles off TOGGLEABLE_PASSES and writes them into a record
        // built from RENDER_PASSES, so a name in one and not the other would silently do nothing.
        for (const p of TOGGLEABLE_PASSES) expect(RENDER_PASSES).toContain(p);
    });

    it('never offers to disable a pass the image cannot be produced without', () => {
        for (const required of ['geometry', 'lighting', 'present', 'forwardOpaque'])
            expect(TOGGLEABLE_PASSES).not.toContain(required as any);
    });
});

describe('gpuProfiler without a GL context', () => {
    it('reports unavailable and no-ops rather than throwing', () => {
        // The extension is gated by driver and browser flags, so "absent" is a supported state, not
        // an error path: every entry point must stay callable so the renderer needs no guards.
        expect(gpuProfiler.available).toBe(false);
        expect(() => {
            gpuProfiler.enabled = true;
            gpuProfiler.beginPass('geometry');
            gpuProfiler.endPass();
            gpuProfiler.endFrame();
            gpuProfiler.enabled = false;
        }).not.toThrow();
        expect(gpuProfiler.passes).toEqual([]);
        expect(gpuProfiler.totalMs).toBe(0);
    });
});
