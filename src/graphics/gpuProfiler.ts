// Per-pass GPU timing, read by the editor's profiler panel and performance HUD. Standalone: it takes
// its device and GL context by injection.
//
// The two backends do not measure the same thing, which is the shape of the whole file. WebGL2 times
// an arbitrary SCOPE the renderer opens and closes; WebGPU can only time a render PASS. The ratios
// between the name spaces are 1:0, 1:1, 1:N and N:1, so `attribution` labels which set the rows are in.

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
 * Every scope the renderer can time, and the key space for `Renderer.passEnabled`. Flat, not nested:
 * WebGL2 allows only one active query per target, so scopes never overlap.
 */
export const RENDER_PASSES = [
    'shadows.cascades',
    'shadows.spot',
    'shadows.point',
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
    'taa',
    'grid',
    'transparent',
    '2d',
    'gizmos',
    // Editor chrome that is neither the grid nor a gizmo: helper wireframes and icon billboards,
    // plus the composite that puts the whole overlay layer onto the resolved image.
    'overlay',
    'outlineMask',
    'velocity',
    'motionBlur',
    'godRays',
    'dof.coc',
    'dof.gather',
    'dof.composite',
    'lensFlare',
    'vignette',
    'filmGrain',
    'exposure',
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

/** Passes the profiler panel offers as on/off switches. Excludes any pass the image cannot do without. */
export const TOGGLEABLE_PASSES: RenderPass[] = [
    'shadows.cascades', 'shadows.spot', 'shadows.point', 'foliage', 'ssao', 'ssao.blur', 'sky', 'clouds', 'skyFog', 'taa', 'grid',
    'transparent', '2d', 'gizmos', 'overlay', 'velocity', 'motionBlur', 'godRays', 'bloom.bright',
    'bloom.blur', 'bloom.composite', 'chromatic', 'screenMaterials',
    // `dof.coc` switches depth of field as a whole. Its other two passes report their own timings
    // but are deliberately NOT switchable: the gather and the composite are halves of one effect,
    // and a composite that did not run would leave the next stage of the chain unwritten.
    'dof.coc', 'lensFlare', 'vignette', 'filmGrain',
];

/**
 * Render-pass LABEL -> the WebGL2 profiler SCOPE containing it. Only exact correspondences and unambiguous
 * sums may be added (tests/gpuProfilerLabels.test.ts); an unmapped label reports as `pass:<label>`.
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
    taa: 'taa',
    exposure: 'exposure',
    godRays: 'godRays',
    'bloom.bright': 'bloom.bright',
    'bloom.blur': 'bloom.blur',
    'bloom.composite': 'bloom.composite',
    chromatic: 'chromatic',
    motionBlur: 'motionBlur',
    'dof.coc': 'dof.coc',
    'dof.gather': 'dof.gather',
    'dof.composite': 'dof.composite',
    lensFlare: 'lensFlare',
    lensFlareComposite: 'lensFlare',
    vignette: 'vignette',
    filmGrain: 'filmGrain',
    present: 'present',
    forwardOpaque: 'forwardOpaque',
    transparent: 'transparent',

    // Renamed but still one-to-one: the pass label and the scope name simply differ.
    cascade: 'shadows.cascades',
    spotShadow: 'shadows.spot',
    pointShadow: 'shadows.point',
    deferredLighting: 'lighting',
    screenMaterial: 'screenMaterials',
    skyAtmosphereBake: 'sky.bake',

    // Unambiguous sums: each runs inside the named scope on WebGL2.
    iblConvolve: 'ibl.bake',
    probeCapture: 'ibl.bake',
    godRaysUpsample: 'godRays',
    // The per-object velocity draws run inside the 'velocity' scope, right after the fullscreen
    // camera-reprojection pass that seeds the same buffer.
    'velocity.objects': 'velocity',
    // The copy back over the scene buffer, which the resolve cannot avoid: it READS that buffer.
    'taa.copy': 'taa',
    'velocity.tile': 'motionBlur',
    'velocity.neighbor': 'motionBlur',
    // The scene -> compose[0] copy; WebGL2 times it under `present`, which is reported twice a frame.
    compose: 'present',
    // The overlay layer's two labels: the helper/icon draws during the scene render, and the
    // composite past the end of the post chain. Both report under the one scope.
    'overlay.helpers': 'overlay',
    'overlay.composite': 'overlay',
};

/** The scope a pass label reports under, or a `pass:` row of its own when there is no honest scope. */
export function scopeForPassLabel(label: string): string {
    return PASS_LABEL_TO_SCOPE[label] ?? `pass:${label}`;
}

// Weight of a new sample in the EMA: a toggle shows within ~1/4 second, one hitch does not dominate.
const EMA_ALPHA = 0.1;

// Frames of timing history kept for the graph — two seconds at 120Hz.
const HISTORY_FRAMES = 240;

// Cap on unresolved frames. Results normally land 1-3 behind; past this the oldest is recycled.
const MAX_PENDING_FRAMES = 8;

// Resolved frames a pass may go unreported before it drops out. Covers the staggered shadow cascades.
const STALE_PASS_FRAMES = 10;

/**
 * Fixed-capacity ring of numbers with percentile/min/max readout. Overwrites oldest on push and never
 * allocates after construction, except in `percentile`.
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

    /** Nearest-rank percentile, `p` in 0..1. Sorts into a preallocated scratch buffer. */
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
 * What the renderer, the HUD and the profiler panel talk to. One backend is live at a time, chosen by
 * {@link initializeGpuProfiler} once the device is known.
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
 * The backend before a device exists, and on any device that cannot time. Every entry point stays
 * callable and does nothing, so no call site needs a guard.
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
 * GPU timer-query profiler over `EXT_disjoint_timer_query_webgl2`. Results are collected frames late
 * and never waited on; frames flagged `GPU_DISJOINT_EXT` are discarded whole.
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

    // Recycled query objects; create/delete per pass per frame would allocate ~25 GL objects a frame.
    private _pool: WebGLQuery[] = [];

    private _lastFrameTotal = 0;
    /** Resolved frames since construction/reset; the clock `PassTiming.lastSeenFrame` is measured on. */
    private _resolvedFrames = 0;

    /** Resolve the timer extension. Called from `initializeGpuProfiler`; safe to call again. */
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
     * Passes that stopped reporting are dropped rather than held at their last average.
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

        // A disjoint anywhere in the window invalidates every timing still in flight.
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
        // Close any active query first: an open query returned to the pool makes the next
        // beginQuery on it an INVALID_OPERATION, which kills all timing from then on.
        this._closeOpenQuery();
        for (const frame of this._pending)
            for (const s of frame.scopes) this._pool.push(s.query);
        this._pending.length = 0;
        // The in-progress frame's queries were opened but its results are now untrustworthy too.
        for (const s of this._current) this._pool.push(s.query);
        this._current.length = 0;
    }
}

// TODO: unify with the equivalent four members on WebGL2GpuProfiler.

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
 * GPU timing over WebGPU timestamp queries; `beginPass`/`endPass` are no-ops and labels come from
 * `RenderPassDescriptor.label`. Biased high: each pass pays a submission's start-up inside its window.
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
     * Pump the drain and close one reported frame. `collectTimestamps` never waits on the GPU, and a
     * call that drains nothing closes no frame — so a stalled driver cannot age every row out.
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
 * The singleton every caller holds, delegating to whichever backend the device chose. A facade
 * because callers capture `gpuProfiler` at import time, long before a device exists.
 */
export class GpuProfilerFacade implements GpuProfilerBackend {
    private _backend: GpuProfilerBackend = new NullGpuProfiler(NO_DEVICE_REASON);

    /** The live backend. For tests, and for anything that needs to know which one is running. */
    public get backend(): GpuProfilerBackend { return this._backend; }

    public useBackend(backend: GpuProfilerBackend): void {
        // Turn the old backend off first: on WebGPU `enabled = false` releases the collection sink.
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
 * Choose and install the backend for the device just acquired. Called once from `Renderer.initialize()`.
 * `glContext` is null on the WebGPU path, which simply leaves the profiler unavailable.
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

