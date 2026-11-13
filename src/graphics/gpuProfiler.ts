// Per-pass GPU timing, read by the editor's profiler panel and performance HUD. Standalone: it takes its
// device by injection.
//
// Both backends time render PASSES, through the device (`setTimestampCollection`): WebGPU with timestamp
// queries, WebGL2 with a timer query bracketing each pass. A pass's descriptor label reports under the
// renderer SCOPE that contains it (`scopeForPassLabel`), so the GPU rows pair with the CPU profiler's.

import type { Device } from './rhi/device';

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
 * Every scope the renderer opens (`PassEncoder.scope`), and the key space for `Renderer.passEnabled`.
 * Flat, not nested: the CPU profiler times them as a sequence.
 */
export const RENDER_PASSES = [
    'shadows.cascades',
    'shadows.spot',
    'shadows.point',
    // The weather's shelter map: what stands over the ground, seen from straight above (redrawn rarely).
    'weather.shelter',
    // Particle simulation steps: compute dispatches on WebGPU, ping-pong draws on WebGL2.
    'particles.sim',
    'geometry',
    'foliage',
    // GPU occlusion query boxes against the finished G-buffer depth (graphics/gpuOcclusion.ts).
    'occlusion.queries',
    // Decal volumes: the landscape-only receiver depth, then the DBuffer write + its G-buffer resolve.
    'decals.receivers',
    'decals',
    // Screen-space indirect lighting (SSIL), under the scope names its SSAO predecessor had: the trace,
    // its temporal accumulation and blur, and the radiance copy taken at the end of the opaque scene.
    'ssao',
    'ssao.temporal',
    'ssao.blur',
    // Screen-space reflections: the trace, the ray-sharing resolve and the temporal accumulation.
    'ssr',
    'ssr.resolve',
    'ssr.temporal',
    // GI Volumes: the apply, and the capture and relight work (render/gi/giSystem.ts).
    'gi',
    'gi.update',
    'lighting',
    'sky',
    'clouds',
    'clouds.resolve',
    'forwardOpaque',
    // Decal emissive, added to the lit image after the opaque depth snapshot.
    'decals.emissive',
    'skyFog',
    'taa',
    'ssao.history',
    'grid',
    // Smoke-and-fire volumes (FluidVolumeNode), over the resolved image just before the transparents.
    'fluidVolumes',
    // Froxel fog for VolumetricFogNode: lit, integrated and composited over the opaque scene.
    'volumetricFog',
    'transparent',
    'particles',
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
    'fxaa',
    'localExposure',
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
    'shadows.cascades', 'shadows.spot', 'shadows.point', 'weather.shelter', 'foliage', 'decals', 'decals.emissive', 'ssao', 'ssao.temporal', 'ssao.blur', 'ssao.history', 'ssr', 'ssr.temporal', 'sky', 'clouds', 'skyFog', 'taa', 'grid',
    'transparent', 'particles', '2d', 'gizmos', 'overlay', 'velocity', 'motionBlur', 'godRays', 'bloom.bright',
    'bloom.blur', 'bloom.composite', 'chromatic', 'screenMaterials',
    // `dof.coc` switches depth of field as a whole. Its other two passes report their own timings
    // but are deliberately NOT switchable: the gather and the composite are halves of one effect,
    // and a composite that did not run would leave the next stage of the chain unwritten.
    'dof.coc', 'lensFlare', 'vignette', 'filmGrain', 'fxaa', 'localExposure', 'volumetricFog',
];

/**
 * Render-pass LABEL -> the renderer SCOPE containing it. Only exact correspondences and unambiguous
 * sums may be added (tests/gpuProfilerLabels.test.ts); an unmapped label reports as `pass:<label>`.
 */
export const PASS_LABEL_TO_SCOPE: Readonly<Record<string, RenderPass>> = {
    // Exact: the label and the scope are the same span of work.
    geometry: 'geometry',
    foliage: 'foliage',
    occlusionQueries: 'occlusion.queries',
    decals: 'decals',
    'decals.emissive': 'decals.emissive',
    decalReceivers: 'decals.receivers',
    ssao: 'ssao',
    'ssao.temporal': 'ssao.temporal',
    'ssao.blur': 'ssao.blur',
    'ssao.history': 'ssao.history',
    ssr: 'ssr',
    'ssr.resolve': 'ssr.resolve',
    'ssr.temporal': 'ssr.temporal',
    gi: 'gi',
    sky: 'sky',
    clouds: 'clouds',
    'clouds.resolve': 'clouds.resolve',
    skyFog: 'skyFog',
    grid: 'grid',
    '2d': '2d',
    // The flat 2D frame's background clear (render/frame2d.ts), before its one 2D pass.
    '2d.clear': '2d',
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
    localExposure: 'localExposure',
    'volumetricFog.inject': 'volumetricFog',
    'volumetricFog.integrate': 'volumetricFog',
    'volumetricFog.apply': 'volumetricFog',
    vignette: 'vignette',
    filmGrain: 'filmGrain',
    fxaa: 'fxaa',
    present: 'present',
    forwardOpaque: 'forwardOpaque',
    transparent: 'transparent',
    particles: 'particles',
    // The simulation step: a compute pass on WebGPU, the ping-pong render pass on WebGL2 — the same span.
    'particles.sim': 'particles.sim',

    // Renamed but still one-to-one: the pass label and the scope name simply differ.
    cascade: 'shadows.cascades',
    spotShadow: 'shadows.spot',
    pointShadow: 'shadows.point',
    shelter: 'weather.shelter',
    deferredLighting: 'lighting',
    screenMaterial: 'screenMaterials',
    skyAtmosphereBake: 'sky.bake',

    // Unambiguous sums: each runs inside the named scope.
    'decals.resolve': 'decals',
    iblConvolve: 'ibl.bake',
    // A light probe's bake steps (render/probeBaker.ts): its G-buffer faces, sky, relight, forward-only
    // models and atlas filter, all inside the ibl.bake scope.
    probeGBuffer: 'ibl.bake',
    probeSky: 'ibl.bake',
    probeRelight: 'ibl.bake',
    probeForward: 'ibl.bake',
    probeFilter: 'ibl.bake',
    // GI Volumes' capture and relight, all inside the gi.update scope.
    giCapture: 'gi.update',
    giBackface: 'gi.update',
    giClear: 'gi.update',
    giReduce: 'gi.update',
    giVisibility: 'gi.update',
    giRadiance: 'gi.update',
    giIntegrate: 'gi.update',
    giAmbientCube: 'gi.update',
    giRescale: 'gi.update',
    giStateStamp: 'gi.update',
    godRaysUpsample: 'godRays',
    // The per-object velocity draws run inside the 'velocity' scope, right after the fullscreen
    // camera-reprojection pass that seeds the same buffer.
    'velocity.objects': 'velocity',
    // The copy back over the scene buffer, which the resolve cannot avoid: it READS that buffer.
    'taa.copy': 'taa',
    // The same copy, RCAS-sharpened on the way when `taaSharpness` > 0.
    'taa.sharpen': 'taa',
    'velocity.tile': 'motionBlur',
    'velocity.neighbor': 'motionBlur',
    // The scene -> compose[0] copy, which runs inside the `present` scope.
    compose: 'present',
    // The overlay layer's two labels: the helper/icon draws during the scene render, and the
    // composite past the end of the post chain. Both report under the one scope.
    'overlay.helpers': 'overlay',
    'overlay.giProbes': 'overlay',
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

/**
 * What the renderer, the HUD and the profiler panel talk to. One backend is live at a time, chosen by
 * {@link initializeGpuProfiler} once the device is known.
 */
export interface GpuProfilerBackend {
    readonly available: boolean;
    enabled: boolean;
    readonly totalMs: number;
    readonly passes: PassTiming[];
    readonly unavailableReason: string | null;
    historyFor(name: string): Ring | null;
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

    constructor(public readonly unavailableReason: string) {}

    public get totalMs(): number { return 0; }
    public get passes(): PassTiming[] { return []; }
    public historyFor(_name: string): Ring | null { return null; }
    public endFrame(): void {}
    public reset(): void {}
}


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
 * GPU timing per render pass, through the device's `setTimestampCollection` / `collectTimestamps` —
 * WebGPU timestamp queries, or WebGL2 timer queries bracketing each pass. Labels come from
 * `RenderPassDescriptor.label` and report under `scopeForPassLabel`'s scope.
 */
export class PassGpuProfiler implements GpuProfilerBackend {
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
            : 'This graphics device cannot time GPU passes (no WebGPU timestamp-query feature, or no ' +
              'EXT_disjoint_timer_query_webgl2).';
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
        // Turn the old backend off first: `enabled = false` releases the device's collection sink.
        const wasEnabled = this._backend.enabled;
        this._backend.enabled = false;
        this._backend = backend;
        backend.enabled = wasEnabled;
    }

    public get available(): boolean { return this._backend.available; }
    public get unavailableReason(): string | null { return this._backend.unavailableReason; }

    public get enabled(): boolean { return this._backend.enabled; }
    public set enabled(v: boolean) { this._backend.enabled = v; }

    public get totalMs(): number { return this._backend.totalMs; }
    public get passes(): PassTiming[] { return this._backend.passes; }
    public historyFor(name: string): Ring | null { return this._backend.historyFor(name); }
    public endFrame(): void { this._backend.endFrame(); }
    public reset(): void { this._backend.reset(); }
}

export const gpuProfiler = new GpuProfilerFacade();

/**
 * Choose and install the backend for the device just acquired. Called once from `Renderer.initialize()`.
 */
export function initializeGpuProfiler(device: Device): void {
    gpuProfiler.useBackend(new PassGpuProfiler(device));
}

