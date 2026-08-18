// Per-pass GPU timing for the render pipeline, read by the editor's profiler panel and performance
// HUD. Standalone (imports nothing engine-specific, takes its GL context by injection) so it can be
// used from anywhere without a circular import, and so the ring-buffer/percentile maths is testable
// in the DOM-free vitest suite — same arrangement as renderStats.ts / sceneStats.ts / physicsStats.ts.
//
// WHY THIS EXISTS: `frameStats.frameMs` measures wall-clock inside Renderer.render(), but WebGL is
// asynchronous — render() returns as soon as the commands are queued, long before the GPU has drawn
// anything. On a fill-rate-bound frame the CPU numbers all look healthy and the entire cost lands in
// the HUD's "Unattributed" row. Timer queries are the only way to see it from inside the page.

/** Timings for one named pass. `ms` is the most recent completed frame; `avgMs` is smoothed. */
export interface PassTiming {
    name: string;
    /** GPU time for the most recently resolved frame, in milliseconds. */
    ms: number;
    /** Exponential moving average over resolved frames, in milliseconds. */
    avgMs: number;
    /** Largest single-frame value since the last `reset()`. */
    maxMs: number;
    /** Number of resolved frames this pass has been timed in. */
    samples: number;
    /** Resolved-frame counter when this pass last reported. Used to drop passes that stopped running. */
    lastSeenFrame: number;
}

/**
 * Every scope the renderer can time. Also the key space for `Renderer.passEnabled`, so the profiler
 * panel can show a pass's cost and switch that same pass off from one row.
 *
 * Kept flat rather than nested: WebGL2 allows only ONE active query per target, so scopes cannot
 * overlap and a tree would be a lie. `bloom.blur` covers all of the ping-pong iterations together.
 */
export const RENDER_PASSES = [
    'shadows.cascades',
    'shadows.single',
    'geometry',
    'foliage',
    'ssao',
    'lighting',
    'sky',
    'clouds',
    'clouds.resolve',
    'forwardOpaque',
    'skyFog',
    'grid',
    'transparent',
    '2d',
    'gizmos',
    'outlineMask',
    'velocity',
    'motionBlur',
    'godRays',
    'bloom.bright',
    'bloom.blur',
    'bloom.composite',
    'chromatic',
    'screenMaterials',
    'present',
    'ibl.bake',
    'sky.bake',
    'frameEnd',
] as const;

export type RenderPass = typeof RENDER_PASSES[number];

/** Passes the profiler panel offers as on/off switches. Excludes the ones that would leave the
 *  pipeline in a broken state (you cannot skip `geometry` or `present` and still have an image). */
export const TOGGLEABLE_PASSES: RenderPass[] = [
    'shadows.cascades', 'shadows.single', 'foliage', 'ssao', 'sky', 'clouds', 'skyFog', 'grid',
    'transparent', '2d', 'gizmos', 'velocity', 'motionBlur', 'godRays', 'bloom.bright',
    'bloom.blur', 'bloom.composite', 'chromatic', 'screenMaterials',
];

// How much weight a new sample carries in the EMA. Low enough that a single hitching frame does not
// dominate the readout, high enough that toggling a pass off is visibly reflected within ~1/4 second.
const EMA_ALPHA = 0.1;

// Frames of timing history kept for the graph. At 120Hz this is two seconds — enough to see a hitch
// pattern without making the percentile sort expensive.
const HISTORY_FRAMES = 240;

// Hard cap on frames whose queries have not resolved yet. Results normally land 1-3 frames behind;
// anything beyond this means the driver has stopped answering, so the oldest frame is recycled
// rather than growing the pool without bound.
const MAX_PENDING_FRAMES = 8;

// Resolved frames a pass may go unreported before it drops out of the readout. Generous enough to
// cover passes that legitimately run intermittently (the staggered shadow cascades update every 2nd
// and 4th frame, the IBL/sky bakes far more rarely) without holding a switched-off pass on screen.
const STALE_PASS_FRAMES = 10;

/**
 * Fixed-capacity ring of numbers with percentile/min/max readout. Overwrites oldest on push, never
 * allocates after construction except in `percentile` (which the UI calls a few times a second, not
 * per frame).
 */
export class Ring {
    private _data: Float64Array;
    private _next = 0;
    private _count = 0;
    private _scratch: Float64Array;

    constructor(capacity: number) {
        this._data = new Float64Array(capacity);
        this._scratch = new Float64Array(capacity);
    }

    public get length(): number { return this._count; }
    public get capacity(): number { return this._data.length; }

    public push(v: number): void {
        this._data[this._next] = v;
        this._next = (this._next + 1) % this._data.length;
        if (this._count < this._data.length) this._count++;
    }

    public clear(): void { this._next = 0; this._count = 0; }

    /** Values oldest-first. Allocates — for rendering a graph, not for the frame loop. */
    public toArray(): number[] {
        const out: number[] = [];
        const cap = this._data.length;
        const start = this._count < cap ? 0 : this._next;
        for (let i = 0; i < this._count; i++) out.push(this._data[(start + i) % cap]);
        return out;
    }

    public get last(): number {
        if (this._count === 0) return 0;
        return this._data[(this._next - 1 + this._data.length) % this._data.length];
    }

    public get max(): number {
        let m = 0;
        for (let i = 0; i < this._count; i++) if (this._data[i] > m) m = this._data[i];
        return m;
    }

    public get mean(): number {
        if (this._count === 0) return 0;
        let s = 0;
        for (let i = 0; i < this._count; i++) s += this._data[i];
        return s / this._count;
    }

    /**
     * Nearest-rank percentile, `p` in 0..1. Sorts into a preallocated scratch buffer so repeated
     * calls (p50 + p95 + max, several times a second) do not churn the heap.
     */
    public percentile(p: number): number {
        if (this._count === 0) return 0;
        const scratch = this._scratch.subarray(0, this._count);
        scratch.set(this._data.subarray(0, this._count));
        scratch.sort();
        const idx = Math.min(this._count - 1, Math.max(0, Math.round(p * (this._count - 1))));
        return scratch[idx];
    }
}

/** One frame's worth of timing samples, for the profiler graph. */
export interface FrameSample {
    /** Wall-clock between consecutive frames (the real frame time the display sees). */
    frameMs: number;
    /** CPU time inside Renderer.render(). */
    cpuRenderMs: number;
    /** Sum of all GPU pass timings for that frame — 0 when timer queries are unavailable. */
    gpuMs: number;
}

/** Rolling frame-time history. Fed by the editor HUD (which owns the rAF that measures frame time). */
export const frameHistory = {
    frame: new Ring(HISTORY_FRAMES),
    cpuRender: new Ring(HISTORY_FRAMES),
    gpu: new Ring(HISTORY_FRAMES),

    push(s: FrameSample): void {
        this.frame.push(s.frameMs);
        this.cpuRender.push(s.cpuRenderMs);
        this.gpu.push(s.gpuMs);
    },

    clear(): void { this.frame.clear(); this.cpuRender.clear(); this.gpu.clear(); },
};

interface Scope { name: string; query: WebGLQuery; }
interface PendingFrame { scopes: Scope[]; }

/**
 * GPU timer-query profiler over `EXT_disjoint_timer_query_webgl2`.
 *
 * Results are collected N frames late and never waited on: reading a query result in the frame that
 * issued it would stall the CPU on the GPU, which is precisely the cost we are trying to measure.
 * Frames flagged `GPU_DISJOINT_EXT` (the GPU was preempted or clock-shifted mid-measurement) are
 * discarded wholesale — a disjoint timing is not merely noisy, it is meaningless.
 *
 * The extension is not universally available (drivers and browser flags both gate it, and it is
 * commonly off in cross-origin or low-privilege contexts). When absent, `available` is false and
 * every method is a no-op; the profiler UI falls back to A/B pass bisection via
 * `Renderer.passEnabled`, which needs no extension.
 */
export class GpuProfiler {
    private _gl: WebGL2RenderingContext | null = null;
    private _ext: any = null;
    private _enabled = false;

    private _timings = new Map<string, PassTiming>();
    private _history = new Map<string, Ring>();

    // Frames whose queries have been issued but not yet read back.
    private _pending: PendingFrame[] = [];
    // Scopes opened during the frame currently being recorded.
    private _current: Scope[] = [];
    private _openQuery: WebGLQuery | null = null;

    // Recycled query objects — createQuery/deleteQuery per pass per frame would allocate ~25 GL
    // objects a frame and defeat the point.
    private _pool: WebGLQuery[] = [];

    private _lastFrameTotal = 0;
    /** Resolved frames since construction/reset; the clock `PassTiming.lastSeenFrame` is measured on. */
    private _resolvedFrames = 0;

    /** Called once from Renderer.preInitialize. Safe to call again (re-resolves the extension). */
    public initialize(context: WebGL2RenderingContext): void {
        this._gl = context;
        this._ext = context.getExtension('EXT_disjoint_timer_query_webgl2');
    }

    /** True when timer queries can actually be issued. False means the UI must fall back to bisection. */
    public get available(): boolean { return this._ext !== null && this._gl !== null; }

    public get enabled(): boolean { return this._enabled; }
    public set enabled(v: boolean) {
        if (this._enabled === v) return;
        this._enabled = v;
        if (!v) this._discardPending();
    }

    /** Sum of the most recently resolved frame's pass timings, in ms. */
    public get totalMs(): number { return this._lastFrameTotal; }

    /**
     * Timed passes, largest average first. Allocates — call at UI refresh rate, not per frame.
     *
     * Passes that have stopped reporting are dropped rather than shown with their last average. A
     * disabled or skipped pass otherwise sits in the list at its old cost forever, which reads as
     * "still running, still expensive" — the exact opposite of what just happened, and enough to
     * make an A/B comparison of a toggle look like it did nothing.
     */
    public get passes(): PassTiming[] {
        const cutoff = this._resolvedFrames - STALE_PASS_FRAMES;
        return [...this._timings.values()]
            .filter(t => t.lastSeenFrame >= cutoff)
            .sort((a, b) => b.avgMs - a.avgMs);
    }

    /** Rolling history for one pass, or null if it has never been timed. */
    public historyFor(name: string): Ring | null { return this._history.get(name) ?? null; }

    /**
     * Open a timing scope. Implicitly closes the previous one — WebGL2 permits only one active
     * TIME_ELAPSED query, so scopes are a flat sequence rather than a stack.
     */
    public beginPass(name: RenderPass | string): void {
        if (!this._enabled || !this._ext) return;
        this._closeOpenQuery();

        const gl = this._gl!;
        const query = this._pool.pop() ?? gl.createQuery();
        if (!query) return;

        gl.beginQuery(this._ext.TIME_ELAPSED_EXT, query);
        this._openQuery = query;
        this._current.push({ name, query });
    }

    /** Close the open scope without opening another. Optional — `endFrame` closes it anyway. */
    public endPass(): void {
        if (!this._enabled || !this._ext) return;
        this._closeOpenQuery();
    }

    /** Close the frame: end any open scope, queue it for readback, and collect resolved frames. */
    public endFrame(): void {
        if (!this._enabled || !this._ext) { this._current.length = 0; return; }
        this._closeOpenQuery();

        if (this._current.length > 0) {
            this._pending.push({ scopes: this._current });
            this._current = [];
        }

        // Bound the queue: if the driver has stopped resolving, recycle the oldest rather than grow.
        while (this._pending.length > MAX_PENDING_FRAMES) {
            const dropped = this._pending.shift()!;
            for (const s of dropped.scopes) this._pool.push(s.query);
        }

        this._collect();
    }

    /** Zero every accumulator and history. Timings restart from the next resolved frame. */
    public reset(): void {
        this._timings.clear();
        for (const ring of this._history.values()) ring.clear();
        this._history.clear();
        this._lastFrameTotal = 0;
        this._resolvedFrames = 0;
    }

    private _closeOpenQuery(): void {
        if (!this._openQuery) return;
        this._gl!.endQuery(this._ext.TIME_ELAPSED_EXT);
        this._openQuery = null;
    }

    /**
     * Read back every pending frame whose queries have all resolved. Queries complete in submission
     * order, so testing the last one is enough to know the whole frame is ready.
     */
    private _collect(): void {
        const gl = this._gl!;

        // A disjoint anywhere in the measured window invalidates every timing still in flight: the
        // GPU clock changed or the context was preempted, so the elapsed values are not comparable.
        if (gl.getParameter(this._ext.GPU_DISJOINT_EXT)) { this._discardPending(); return; }

        while (this._pending.length > 0) {
            const frame = this._pending[0];
            const lastQuery = frame.scopes[frame.scopes.length - 1].query;
            if (!gl.getQueryParameter(lastQuery, gl.QUERY_RESULT_AVAILABLE)) break;

            this._pending.shift();
            this._resolvedFrames++;
            let total = 0;
            for (const scope of frame.scopes) {
                // Nanoseconds -> milliseconds.
                const ms = gl.getQueryParameter(scope.query, gl.QUERY_RESULT) / 1e6;
                total += ms;
                this._record(scope.name, ms);
                this._pool.push(scope.query);
            }
            this._lastFrameTotal = total;
        }
    }

    private _record(name: string, ms: number): void {
        let t = this._timings.get(name);
        if (!t) {
            t = { name, ms, avgMs: ms, maxMs: ms, samples: 0, lastSeenFrame: this._resolvedFrames };
            this._timings.set(name, t);
            this._history.set(name, new Ring(HISTORY_FRAMES));
        }
        t.lastSeenFrame = this._resolvedFrames;
        t.ms = ms;
        t.avgMs += (ms - t.avgMs) * EMA_ALPHA;
        if (ms > t.maxMs) t.maxMs = ms;
        t.samples++;
        this._history.get(name)!.push(ms);
    }

    private _discardPending(): void {
        // Close any still-active query first. Returning an *open* query to the pool would make the
        // next beginQuery on it an INVALID_OPERATION and silently kill all timing from then on.
        this._closeOpenQuery();
        for (const frame of this._pending)
            for (const s of frame.scopes) this._pool.push(s.query);
        this._pending.length = 0;
        // The in-progress frame's queries were opened but its results are now untrustworthy too.
        for (const s of this._current) this._pool.push(s.query);
        this._current.length = 0;
    }
}

export const gpuProfiler = new GpuProfiler();
