// Per-pass CPU timing: the missing half of the profiler panel.
//
// `Render (CPU)` was a single wall-clock number for the whole frame body, with no way to say which
// pass spent it — the same failure mode as the physics/scene rows that silently read 0. A GPU pass
// table without a CPU one sends you looking at the GPU when the cost is submission.
//
// The scopes are EXACTLY the GPU ones: `GpuProfilerFacade` drives this timer from the same
// `beginPass`/`endPass`/`endFrame` calls, so the two tables line up row for row and a pass cannot be
// timed on one side and not the other. Flat, not nested, for the same reason — WebGL2 allows one
// active query at a time, so a scope always closes the previous one.
//
// Unlike the GPU side there is nothing to wait for: `performance.now()` resolves in the frame that
// measured it, so `passes` describes the frame that just ran rather than one three frames back.

import { Ring, type PassTiming, type RenderPass } from './gpuProfiler';

// Weight of a new sample in the EMA. Matches the GPU profiler's, so the two columns settle together.
const EMA_ALPHA = 0.1;

// Frames of history kept per scope — two seconds at 120Hz, as on the GPU side.
const HISTORY_FRAMES = 240;

// Frames a scope may go unreported before it drops out of the table. Covers the staggered cascades.
const STALE_PASS_FRAMES = 10;

/**
 * CPU time spent inside each render scope, in milliseconds.
 *
 * A scope that opens twice in one frame is SUMMED, not replaced — `present` legitimately does, and the
 * question the row answers is "how much of this frame went here", not "how long was the last one".
 */
class CpuProfiler {
    /** On by default: two `performance.now()` calls per scope is ~30 a frame, far below the noise. */
    public enabled = true;

    private _timings = new Map<string, PassTiming>();
    private _history = new Map<string, Ring>();

    /** This frame's totals per scope, reused across frames rather than reallocated. */
    private _current = new Map<string, number>();
    private _openName: string | null = null;
    private _openAt = 0;

    private _lastFrameTotal = 0;
    private _frames = 0;

    /** Sum of every scope's CPU time in the frame just ended. */
    public get totalMs(): number { return this._lastFrameTotal; }

    /** Timed scopes, largest average first. Allocates — call at UI refresh rate, not per frame. */
    public get passes(): PassTiming[] {
        const cutoff = this._frames - STALE_PASS_FRAMES;
        return [...this._timings.values()]
            .filter(t => t.lastSeenFrame >= cutoff)
            .sort((a, b) => b.avgMs - a.avgMs);
    }

    /** Rolling history for one scope, or null if it has never been timed. */
    public historyFor(name: string): Ring | null { return this._history.get(name) ?? null; }

    /** Open a scope, implicitly closing the previous one. Mirrors the GPU profiler's flat model. */
    public beginPass(name: RenderPass | string): void {
        if (!this.enabled) return;
        this._close();
        this._openName = name;
        this._openAt = performance.now();
    }

    /** Close the open scope without opening another. Optional — `endFrame` closes it anyway. */
    public endPass(): void {
        if (!this.enabled) return;
        this._close();
    }

    /** Close the frame: bank the open scope, publish the totals, and clear for the next one. */
    public endFrame(): void {
        this._close();
        if (!this.enabled) { this._current.clear(); return; }
        this._frames++;
        let total = 0;
        for (const [name, ms] of this._current) {
            total += ms;
            this._record(name, ms);
        }
        this._lastFrameTotal = total;
        this._current.clear();
    }

    public reset(): void {
        this._timings.clear();
        for (const ring of this._history.values()) ring.clear();
        this._history.clear();
        this._current.clear();
        this._openName = null;
        this._lastFrameTotal = 0;
        this._frames = 0;
    }

    private _close(): void {
        if (this._openName === null) return;
        const ms = performance.now() - this._openAt;
        this._current.set(this._openName, (this._current.get(this._openName) ?? 0) + ms);
        this._openName = null;
    }

    private _record(name: string, ms: number): void {
        let t = this._timings.get(name);
        if (!t) {
            t = { name, ms, avgMs: ms, maxMs: ms, samples: 0, lastSeenFrame: this._frames };
            this._timings.set(name, t);
            this._history.set(name, new Ring(HISTORY_FRAMES));
        }
        t.ms = ms;
        t.avgMs = t.avgMs + (ms - t.avgMs) * EMA_ALPHA;
        if (ms > t.maxMs) t.maxMs = ms;
        t.samples++;
        t.lastSeenFrame = this._frames;
        this._history.get(name)!.push(ms);
    }
}

export const cpuProfiler = new CpuProfiler();
