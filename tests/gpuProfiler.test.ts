import { describe, it, expect } from 'vitest';
import {
    Ring, frameHistory, gpuProfiler, RENDER_PASSES, TOGGLEABLE_PASSES,
    NullGpuProfiler, WebGPUGpuProfiler, initializeGpuProfiler,
} from '../src/graphics/gpuProfiler';
import type { Device } from '../src/graphics/rhi/device';

// The profiler's GL half needs a real context and so is deliberately out of scope for this suite
// (see the policy note in vitest.config.ts). What IS testable here is the part that decides what the
// profiler panel displays: the ring buffer's wraparound, the percentile maths behind the p50/p95
// readouts, the pass-name tables the renderer and UI both key off, and — since the profiler grew a
// second backend — the facade's dispatch and the WebGPU backend's frame bookkeeping, both of which
// are plain object graphs once the device is a stub. The WebGPU half's *device* side (query sets,
// staging maps) is driver work and lives in tools/harness/pages/webgpu/entry.ts instead.

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

// ------------------------------------------------------------------------------------------------
// The two-backend facade
// ------------------------------------------------------------------------------------------------

/**
 * A `Device` that records what the profiler asked of it and can hand back timings on cue.
 *
 * Only the four members the profiler touches are real; everything else would be dead weight and a
 * second thing to keep in step with the interface.
 */
function stubDevice(hasTimestampQuery: boolean) {
    const state = {
        enabled: false,
        sink: null as null | ((label: string, ms: number) => void),
        collects: 0,
        /** Queued (label, ms) pairs, delivered on the next `collectTimestamps()`. */
        pending: [] as [string, number][],
    };
    const device = {
        backend: 'webgpu' as const,
        capabilities: { backend: 'webgpu', hasTimestampQuery } as any,
        setTimestampCollection(enabled: boolean, sink: (label: string, ms: number) => void) {
            state.enabled = enabled;
            state.sink = sink;
        },
        collectTimestamps() {
            state.collects++;
            if (!state.enabled) return;
            for (const [label, ms] of state.pending) state.sink?.(label, ms);
            state.pending.length = 0;
        },
    } as unknown as Device;
    return { device, state };
}

describe('NullGpuProfiler', () => {
    it('is unavailable with a reason, and every entry point is callable', () => {
        const p = new NullGpuProfiler('no device yet');
        expect(p.available).toBe(false);
        expect(p.unavailableReason).toBe('no device yet');
        expect(p.attribution).toBe('scopes');
        expect(() => { p.beginPass('geometry'); p.endPass(); p.endFrame(); p.reset(); }).not.toThrow();
        expect(p.historyFor('geometry')).toBeNull();
    });
});

describe('WebGPUGpuProfiler', () => {
    it('turns collection on and off through the device, never behind its back', () => {
        const { device, state } = stubDevice(true);
        const p = new WebGPUGpuProfiler(device);
        expect(p.available).toBe(true);
        expect(p.attribution).toBe('passes');
        expect(p.unavailableReason).toBeNull();

        p.enabled = true;
        expect(state.enabled).toBe(true);
        p.enabled = false;
        expect(state.enabled).toBe(false);
    });

    it('reports unavailable, and stays inert, without the timestamp-query feature', () => {
        // An adapter is allowed not to offer it, and asking for timestamps anyway is a validation
        // error rather than a downgrade — so nothing may reach the device in this state.
        const { device, state } = stubDevice(false);
        const p = new WebGPUGpuProfiler(device);
        expect(p.available).toBe(false);
        expect(p.unavailableReason).toMatch(/timestamp-query/);

        p.enabled = true;
        expect(state.enabled).toBe(false);
        state.pending.push(['geometry', 1]);
        p.endFrame();
        expect(state.collects).toBe(0);
        expect(p.passes).toEqual([]);
    });

    it('maps a pass label onto its scope, and an unmapped one onto a pass: row', () => {
        const { device, state } = stubDevice(true);
        const p = new WebGPUGpuProfiler(device);
        p.enabled = true;
        state.pending.push(['deferredLighting', 2], ['brdf', 0.5]);
        p.endFrame();

        const names = p.passes.map(t => t.name);
        expect(names).toContain('lighting');       // renamed, one-to-one
        expect(names).toContain('pass:brdf');      // in no WebGL2 scope at all
        expect(names).not.toContain('brdf');
        expect(p.totalMs).toBeCloseTo(2.5);
    });

    it('sums the N passes that share one scope into one row', () => {
        // `bloom.blur` is a whole ping-pong chain on WebGL2 and one TIME_ELAPSED window; the same
        // chain is 8+ separate render passes here. Reporting them individually under one name would
        // make the row read as the LAST blur step rather than the chain.
        const { device, state } = stubDevice(true);
        const p = new WebGPUGpuProfiler(device);
        p.enabled = true;
        state.pending.push(['bloom.blur', 1], ['bloom.blur', 2], ['bloom.blur', 3]);
        p.endFrame();

        const blur = p.passes.find(t => t.name === 'bloom.blur');
        expect(blur?.ms).toBeCloseTo(6);
        expect(blur?.samples).toBe(1);   // one FRAME, not three
    });

    it('closes no frame when the drain comes back empty', () => {
        // Results lag by one to three frames and are never waited on, so an empty drain is the
        // ordinary case. Counting it as a resolved frame would age every row towards STALE_PASS_FRAMES
        // while the picture is still being drawn.
        const { device, state } = stubDevice(true);
        const p = new WebGPUGpuProfiler(device);
        p.enabled = true;
        state.pending.push(['geometry', 4]);
        p.endFrame();
        for (let i = 0; i < 30; i++) p.endFrame();

        expect(state.collects).toBe(31);
        expect(p.passes.map(t => t.name)).toEqual(['geometry']);
        expect(p.totalMs).toBeCloseTo(4);
    });

    it('reset() clears the rows and the total', () => {
        const { device, state } = stubDevice(true);
        const p = new WebGPUGpuProfiler(device);
        p.enabled = true;
        state.pending.push(['geometry', 4]);
        p.endFrame();
        p.reset();
        expect(p.passes).toEqual([]);
        expect(p.totalMs).toBe(0);
    });
});

// Last in the file on purpose: these install a backend on the shared singleton, and the "without a
// GL context" case above is asserting on the default one.
describe('the gpuProfiler facade', () => {
    it('forwards to the installed backend and carries the switch across a swap', () => {
        const { device, state } = stubDevice(true);
        try {
            gpuProfiler.enabled = true;                 // switched on before any device exists
            expect(gpuProfiler.available).toBe(false);  // the Null backend, still

            initializeGpuProfiler(device, null);
            expect(gpuProfiler.attribution).toBe('passes');
            expect(gpuProfiler.available).toBe(true);
            // The panel's checkbox is set before boot as often as after it; a swap that dropped it
            // would leave the UI showing an enabled profiler that is collecting nothing.
            expect(gpuProfiler.enabled).toBe(true);
            expect(state.enabled).toBe(true);

            state.pending.push(['geometry', 3]);
            gpuProfiler.endFrame();
            expect(gpuProfiler.totalMs).toBeCloseTo(3);
            expect(gpuProfiler.historyFor('geometry')?.last).toBeCloseTo(3);

            // beginPass/endPass are no-ops on this backend rather than errors: the renderer's ~30 call
            // sites are unconditional and must stay that way.
            expect(() => { gpuProfiler.beginPass('geometry'); gpuProfiler.endPass(); }).not.toThrow();
        } finally {
            gpuProfiler.enabled = false;
            gpuProfiler.useBackend(new NullGpuProfiler('test teardown'));
        }
    });

    it('turns the outgoing backend off before swapping it out', () => {
        // On WebGPU `enabled = false` is what releases the device's sink. A backend left enabled
        // behind the facade would go on filling a map nothing reads, for the life of the page.
        const first = stubDevice(true);
        const second = stubDevice(true);
        try {
            initializeGpuProfiler(first.device, null);
            gpuProfiler.enabled = true;
            expect(first.state.enabled).toBe(true);

            initializeGpuProfiler(second.device, null);
            expect(first.state.enabled).toBe(false);
            expect(second.state.enabled).toBe(true);
        } finally {
            gpuProfiler.enabled = false;
            gpuProfiler.useBackend(new NullGpuProfiler('test teardown'));
        }
    });

    it('installs a Null backend for a WebGL2 device with no context to time', () => {
        const device = { backend: 'webgl2', capabilities: { backend: 'webgl2' } } as unknown as Device;
        try {
            initializeGpuProfiler(device, null);
            expect(gpuProfiler.available).toBe(false);
            expect(gpuProfiler.attribution).toBe('scopes');
            expect(gpuProfiler.unavailableReason).toMatch(/WebGL2 context/);
        } finally {
            gpuProfiler.useBackend(new NullGpuProfiler('test teardown'));
        }
    });
});
