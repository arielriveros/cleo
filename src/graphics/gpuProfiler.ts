// Per-pass GPU timing for the render pipeline, read by the editor's profiler panel and performance
// HUD. Standalone (imports nothing engine-specific beyond the RHI's types, takes its device and its
// GL context by injection) so it can be used from anywhere without a circular import, and so the
// ring-buffer/percentile maths is testable in the DOM-free vitest suite — same arrangement as
// renderStats.ts / sceneStats.ts / physicsStats.ts.
//
// WHY THIS EXISTS: `frameStats.frameMs` measures wall-clock inside Renderer.render(), but a graphics
// API is asynchronous — render() returns as soon as the commands are queued, long before the GPU has
// drawn anything. On a fill-rate-bound frame the CPU numbers all look healthy and the entire cost
// lands in the HUD's "Unattributed" row. GPU timers are the only way to see it from inside the page.
//
// TWO BACKENDS THAT DO NOT MEASURE THE SAME THING. This is the fact the whole file is shaped around:
//
//  - WebGL2 (`EXT_disjoint_timer_query_webgl2`) times an arbitrary SCOPE: a `TIME_ELAPSED` window the
//    renderer opens and closes around whatever it likes. The 29 names in `RENDER_PASSES` are those
//    windows, and several of them span many render passes (`bloom.blur` covers the whole ping-pong
//    chain) while others span none at all (`frameEnd` deliberately wraps nothing but the drain).
//  - WebGPU times exactly one thing: a render PASS, through `timestampWrites` in the pass descriptor.
//    There is no way to open a timer around a span of the frame that is not a pass.
//
// The ratios between the two name spaces are 1:0, 1:1, 1:N and N:1, so the readouts are labelled as
// two different row sets rather than pretending to be one — see `attribution` and
// `PASS_LABEL_TO_SCOPE`. Anything else would put a WebGL2 scope's name on a WebGPU pass's cost.

import type { Device } from './rhi/device';
import { timerQueryExtension } from './rhi/webgl2/capabilities';

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
    'shadows.spot',
    'geometry',
    'foliage',
    'ssao',
    'ssao.blur',
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
    'shadows.cascades', 'shadows.spot', 'foliage', 'ssao', 'ssao.blur', 'sky', 'clouds', 'skyFog', 'grid',
    'transparent', '2d', 'gizmos', 'velocity', 'motionBlur', 'godRays', 'bloom.bright',
    'bloom.blur', 'bloom.composite', 'chromatic', 'screenMaterials',
];

/**
 * Render-pass LABEL (`RenderPassDescriptor.label`) -> the WebGL2 profiler SCOPE that contains it.
 *
 * The two name spaces are not the same list and never were: the renderer passes ~40 distinct labels
 * and `RENDER_PASSES` holds 29 scopes, with roughly 20 names in common. `types.ts` used to claim they
 * matched; the vitest in tests/gpuProfilerLabels.test.ts is what makes this table's half of that claim
 * true, by scanning renderer.ts's source for the literals it actually passes.
 *
 * Only two kinds of entry are allowed, and the test enforces the second half of each:
 *
 *  - an EXACT correspondence — one pass, one scope, same cost (`geometry`, `ssao.blur`, `present`);
 *  - an UNAMBIGUOUS SUM — every pass mapped to a scope lies inside that scope on WebGL2, so adding
 *    them up reproduces what the scope already measured (`velocity.tile` + `velocity.neighbor` +
 *    `motionBlur` are the three passes inside the `motionBlur` scope).
 *
 * A label that is NOT here is reported as `pass:<label>` rather than guessed at. That is deliberate:
 * several passes (`brdf`, `outline`, `probePreview`, `cloudTrace`, `shadow.clear`) sit in no WebGL2
 * scope at all, so there is no scope name that could honestly carry their cost. They show up as new
 * rows on WebGPU that WebGL2 never had — extra information, not a mislabelled one.
 */
export const PASS_LABEL_TO_SCOPE: Readonly<Record<string, RenderPass>> = {
    // Exact: the label and the scope are the same span of work.
    geometry: 'geometry',
    foliage: 'foliage',
    ssao: 'ssao',
    'ssao.blur': 'ssao.blur',
    sky: 'sky',
    clouds: 'clouds',
    'clouds.resolve': 'clouds.resolve',
    skyFog: 'skyFog',
    grid: 'grid',
    '2d': '2d',
    gizmos: 'gizmos',
    outlineMask: 'outlineMask',
    velocity: 'velocity',
    godRays: 'godRays',
    'bloom.bright': 'bloom.bright',
    'bloom.blur': 'bloom.blur',
    'bloom.composite': 'bloom.composite',
    chromatic: 'chromatic',
    motionBlur: 'motionBlur',
    present: 'present',
    forwardOpaque: 'forwardOpaque',
    transparent: 'transparent',

    // Renamed but still one-to-one: the pass label and the scope name simply differ.
    cascade: 'shadows.cascades',
    spotShadow: 'shadows.spot',
    deferredLighting: 'lighting',
    screenMaterial: 'screenMaterials',
    skyAtmosphereBake: 'sky.bake',

    // Unambiguous sums. Each of these runs inside the named scope on WebGL2, so N passes add up to
    // the one number that scope already reported.
    iblConvolve: 'ibl.bake',
    probeCapture: 'ibl.bake',
    godRaysUpsample: 'godRays',
    'velocity.tile': 'motionBlur',
    'velocity.neighbor': 'motionBlur',
    // The scene -> compose[0] copy. It is the only remaining `compose` label (the three ambiguous ones
    // became `bloom.composite`, `chromatic` and `motionBlur`), and on WebGL2 it is timed under a
    // `present` scope opened immediately before it — `present` is already reported twice per frame
    // there, once for this copy and once for the display resolve.
    compose: 'present',
};

/** The scope a pass label reports under, or a `pass:` row of its own when there is no honest scope. */
export function scopeForPassLabel(label: string): string {
    return PASS_LABEL_TO_SCOPE[label] ?? `pass:${label}`;
}

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
 * What the renderer, the HUD and the profiler panel talk to. One of these is live at a time, chosen
 * by {@link initializeGpuProfiler} once the device is known.
 *
 * The two extra members beyond "today's profiler" are the ones that stop the UI from lying:
 *
 *  - `attribution` says which name space the rows are in. `'scopes'` are the renderer-defined
 *    `RENDER_PASSES` windows; `'passes'` are real render passes, mapped onto a scope name where the
 *    correspondence is honest and reported as `pass:<label>` where it is not.
 *  - `unavailableReason` says why `available` is false, in words a user can act on. There are now
 *    three distinct reasons (no device yet, no extension, no `timestamp-query` feature) and the panel
 *    used to hardcode one extension name for all of them.
 */
export interface GpuProfilerBackend {
    readonly available: boolean;
    enabled: boolean;
    readonly totalMs: number;
    readonly passes: PassTiming[];
    readonly attribution: 'scopes' | 'passes';
    readonly unavailableReason: string | null;
    historyFor(name: string): Ring | null;
    beginPass(name: RenderPass | string): void;
    endPass(): void;
    endFrame(): void;
    reset(): void;
}

/**
 * The backend before a device exists, and the backend on any device that cannot time anything.
 *
 * Not a special case anywhere else in the file: every entry point stays callable and does nothing, so
 * the renderer's ~30 call sites need no guard and the panel's fallback (A/B pass bisection through
 * `Renderer.passEnabled`, which needs no GPU timer at all) is reached through the ordinary
 * `available === false` path.
 */
export class NullGpuProfiler implements GpuProfilerBackend {
    public enabled = false;
    public readonly available = false;
    public readonly attribution = 'scopes' as const;

    constructor(public readonly unavailableReason: string) {}

    public get totalMs(): number { return 0; }
    public get passes(): PassTiming[] { return []; }
    public historyFor(_name: string): Ring | null { return null; }
    public beginPass(_name: RenderPass | string): void {}
    public endPass(): void {}
    public endFrame(): void {}
    public reset(): void {}
}

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
export class WebGL2GpuProfiler implements GpuProfilerBackend {
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

    /**
     * Called once from `initializeGpuProfiler`, itself called from `Renderer.initialize()` (NOT from
     * `preInitialize`, which is what this used to say). Safe to call again — it re-resolves the
     * extension, and `getExtension` returns the same object for the same context.
     *
     * The extension comes from `timerQueryExtension` rather than a `getExtension` call of its own:
     * `detectWebGL2Capabilities` already asks the same question to fill `hasTimestampQuery`, and two
     * independent lookups are two things that can disagree about whether timing is possible.
     */
    public initialize(context: WebGL2RenderingContext): void {
        this._gl = context;
        this._ext = timerQueryExtension(context);
    }

    /** True when timer queries can actually be issued. False means the UI must fall back to bisection. */
    public get available(): boolean { return this._ext !== null && this._gl !== null; }

    /** WebGL2 times renderer-defined scopes, not render passes. See the file header. */
    public readonly attribution = 'scopes' as const;

    public get unavailableReason(): string | null {
        if (this.available) return null;
        return this._gl === null
            ? 'The profiler has no WebGL2 context yet.'
            : 'EXT_disjoint_timer_query_webgl2 is unavailable on this driver/browser.';
    }

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

/**
 * Pass-timing bookkeeping, shared by nothing.
 *
 * A near-copy of the four members `WebGL2GpuProfiler` keeps for the same job. That duplication is
 * deliberate and temporary: the WebGL2 class's body was carried across the two-backend split
 * BYTE-IDENTICAL, so that a WebGL2 regression could not possibly originate in this change. Unifying
 * the two is a follow-up with its own gate run, not a free-rider on this one.
 */
class PassTimingTable {
    private _timings = new Map<string, PassTiming>();
    private _history = new Map<string, Ring>();
    private _resolvedFrames = 0;

    public get passes(): PassTiming[] {
        const cutoff = this._resolvedFrames - STALE_PASS_FRAMES;
        return [...this._timings.values()]
            .filter(t => t.lastSeenFrame >= cutoff)
            .sort((a, b) => b.avgMs - a.avgMs);
    }

    public historyFor(name: string): Ring | null { return this._history.get(name) ?? null; }

    /** Close one resolved frame: `samples` is scope -> summed milliseconds for that frame. */
    public recordFrame(samples: Map<string, number>): void {
        this._resolvedFrames++;
        for (const [name, ms] of samples) {
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
    }

    public reset(): void {
        this._timings.clear();
        for (const ring of this._history.values()) ring.clear();
        this._history.clear();
        this._resolvedFrames = 0;
    }
}

/**
 * GPU timing over WebGPU timestamp queries.
 *
 * Everything API-specific — the `GPUQuerySet`, the `QUERY_RESOLVE` buffer, the `MAP_READ` staging
 * ring — is inside `WebGPUDevice`, behind exactly two RHI methods. This class is only the frame
 * bookkeeping: turn collection on, pump the drain once a frame, and fold whatever came back into the
 * same `PassTiming` rows the panel already knows how to draw.
 *
 * `beginPass`/`endPass` are NO-OPS here, and that is the whole shape of the mismatch. A WebGPU
 * timestamp can only be attached to a render pass, so the renderer's scope calls have nothing to
 * attach to; the labels come from `RenderPassDescriptor.label` instead, and `PASS_LABEL_TO_SCOPE`
 * turns them back into scope names where that is honest.
 *
 * WHAT IS LOST relative to WebGL2, stated plainly because the panel says the same thing:
 *
 *  - `frameEnd` — a sacrificial scope that exists only to absorb the driver's end-of-frame drain out
 *    of `present`. Per-pass timestamps already exclude the drain, so there is nothing to absorb. A
 *    gain, not a gap.
 *  - Every scope with no render pass under it produces no row. Today that is only `frameEnd`:
 *    `forwardOpaque` and `transparent` DO open passes of those names (`_runForwardQueue` labels its
 *    pass with the queue name), so they survive — including in `_renderForward`, the forward
 *    pipeline's path, which has no profiler scope calls at all and therefore reports MORE here than
 *    on WebGL2.
 *
 * KNOWN MEASUREMENT BIAS, do not "correct" it with a subtracted constant. `_beginFullscreenPass`
 * creates one `CommandEncoder` per pass, so a frame is ~35 separate submissions and every pass pays a
 * submission's start-up at both ends of its own timestamp window. The honest fix is the encoder-per-
 * frame change `renderer.ts:_beginFullscreenPass` already flags in its docstring — one encoder opened
 * at the top of `_render` and finished after the present pass — at which point these numbers become
 * comparable to the WebGL2 ones without anything here changing.
 */
export class WebGPUGpuProfiler implements GpuProfilerBackend {
    public readonly attribution = 'passes' as const;

    private _table = new PassTimingTable();
    private _enabled = false;
    private _lastFrameTotal = 0;
    /** Scope -> summed ms drained since the last `endFrame`. Reused rather than reallocated. */
    private _accumulated = new Map<string, number>();

    constructor(private readonly _device: Device) {}

    public get available(): boolean { return this._device.capabilities.hasTimestampQuery; }

    public get unavailableReason(): string | null {
        return this.available
            ? null
            : 'The WebGPU adapter does not offer the timestamp-query feature.';
    }

    public get enabled(): boolean { return this._enabled; }
    public set enabled(v: boolean) {
        if (this._enabled === v) return;
        this._enabled = v;
        this._device.setTimestampCollection(v && this.available, (label, ms) => {
            const scope = scopeForPassLabel(label);
            this._accumulated.set(scope, (this._accumulated.get(scope) ?? 0) + ms);
        });
        if (!v) this._accumulated.clear();
    }

    public get totalMs(): number { return this._lastFrameTotal; }
    public get passes(): PassTiming[] { return this._table.passes; }
    public historyFor(name: string): Ring | null { return this._table.historyFor(name); }

    public beginPass(_name: RenderPass | string): void {}
    public endPass(): void {}

    /**
     * Pump the drain and close one reported frame.
     *
     * `collectTimestamps` never waits on the GPU — it maps whatever has already finished and returns
     * — so what arrives during any one call is "the passes that completed since last time", lagging
     * the frame that issued them by one to three frames exactly as the WebGL2 path does. A call that
     * drains nothing closes no frame, which is what keeps a stalled driver from ageing every row out
     * of the readout via `STALE_PASS_FRAMES` while the picture is still being drawn.
     */
    public endFrame(): void {
        if (!this._enabled || !this.available) return;
        this._device.collectTimestamps();
        if (this._accumulated.size === 0) return;

        let total = 0;
        for (const ms of this._accumulated.values()) total += ms;
        this._lastFrameTotal = total;
        this._table.recordFrame(this._accumulated);
        this._accumulated.clear();
    }

    public reset(): void {
        this._table.reset();
        this._accumulated.clear();
        this._lastFrameTotal = 0;
    }
}

const NO_DEVICE_REASON = 'No graphics device has been acquired yet.';

/**
 * The singleton every caller holds, delegating to whichever backend the device chose.
 *
 * A facade rather than a re-exported variable because the ~30 renderer call sites, `engine.ts` and
 * the editor panel all captured `gpuProfiler` at import time, long before a device exists. Swapping
 * the object they hold is not possible; swapping what it forwards to is.
 */
export class GpuProfilerFacade implements GpuProfilerBackend {
    private _backend: GpuProfilerBackend = new NullGpuProfiler(NO_DEVICE_REASON);

    /** The live backend. For tests, and for anything that needs to know which one is running. */
    public get backend(): GpuProfilerBackend { return this._backend; }

    public useBackend(backend: GpuProfilerBackend): void {
        // Carry the switch across, and turn the OLD one off first. On WebGPU `enabled = false` is what
        // releases the device's collection sink, and a backend left enabled behind the facade would go
        // on filling a map nothing reads.
        const wasEnabled = this._backend.enabled;
        this._backend.enabled = false;
        this._backend = backend;
        backend.enabled = wasEnabled;
    }

    public get available(): boolean { return this._backend.available; }
    public get attribution(): 'scopes' | 'passes' { return this._backend.attribution; }
    public get unavailableReason(): string | null { return this._backend.unavailableReason; }

    public get enabled(): boolean { return this._backend.enabled; }
    public set enabled(v: boolean) { this._backend.enabled = v; }

    public get totalMs(): number { return this._backend.totalMs; }
    public get passes(): PassTiming[] { return this._backend.passes; }
    public historyFor(name: string): Ring | null { return this._backend.historyFor(name); }
    public beginPass(name: RenderPass | string): void { this._backend.beginPass(name); }
    public endPass(): void { this._backend.endPass(); }
    public endFrame(): void { this._backend.endFrame(); }
    public reset(): void { this._backend.reset(); }
}

export const gpuProfiler = new GpuProfilerFacade();

/**
 * Choose and install the backend for the device that was just acquired. Called once, from
 * `Renderer.initialize()`.
 *
 * `glContext` is separate from `device` rather than read off it because a canvas hosts exactly one
 * context type: on the WebGPU path there IS no `WebGL2RenderingContext` anywhere, and null is the
 * accurate thing to pass rather than a stub to reach through. Passing null with a WebGL2 device is
 * not an error either — it simply leaves the profiler unavailable with a reason that says so.
 */
export function initializeGpuProfiler(device: Device,
                                      glContext: WebGL2RenderingContext | null): void {
    if (device.backend === 'webgpu') {
        gpuProfiler.useBackend(new WebGPUGpuProfiler(device));
        return;
    }
    if (!glContext) {
        gpuProfiler.useBackend(new NullGpuProfiler('The profiler has no WebGL2 context yet.'));
        return;
    }
    const backend = new WebGL2GpuProfiler();
    backend.initialize(glContext);
    gpuProfiler.useBackend(backend);
}

