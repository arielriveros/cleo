/**
 * When GI volumes capture and relight, and how much of each a frame does. Pure: the renderer feeds it
 * what changed and runs the batches it hands back.
 *
 * CAPTURE (rare: geometry). A volume with no saved bake, or whose bake no longer matches the geometry,
 * captures its probes nearest the camera first, a few per frame ({@link nearestUncaptured}), so the
 * place the player stands lights first.
 *
 * RELIGHT (whenever the light changes; nothing at all when it does not). A SWEEP relights every probe of
 * a volume once, in batches sized to the frame's ray budget. A change while a sweep runs does not restart
 * it — a restart would starve the far probes as long as the sun keeps moving — it queues the next one.
 *
 * Each sweep blends into what the probes had with HYSTERESIS: `h` of the old kept, so a step in the sun's
 * shadow fades in over a few sweeps instead of popping. A change therefore runs a few SETTLE sweeps,
 * enough to bring the old light under {@link GI_SETTLE_RESIDUAL}, and then the volume goes idle. A
 * RESET (a scene load, the clock jumping hours, a light many times brighter at once) throws the old
 * light away: one sweep without bounces, so the first light is the direct light's alone and nothing
 * stale bounces into it, then two with, each replacing outright.
 */

// --- Capture order ---

export interface GiCaptureVolume {
    /** World position of every probe, xyz. */
    positions: ArrayLike<number>;
    /** Every probe's state (giClassify.ts); 0 = uncaptured. */
    states: ArrayLike<number>;
}

export interface GiCaptureCandidate {
    volume: number;
    probe: number;
    distance: number;
}

/**
 * The `k` uncaptured probes nearest `camera`, over every volume, nearest first. A bounded max-heap: one
 * pass over the probes, whatever their number.
 */
export function nearestUncaptured(volumes: readonly GiCaptureVolume[], camera: ArrayLike<number>, k: number): GiCaptureCandidate[] {
    const heap: GiCaptureCandidate[] = [];
    if (k <= 0) return heap;
    const up = (i: number) => {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heap[parent].distance >= heap[i].distance) break;
            [heap[parent], heap[i]] = [heap[i], heap[parent]];
            i = parent;
        }
    };
    const down = (i: number) => {
        for (;;) {
            const l = 2 * i + 1, r = l + 1;
            let big = i;
            if (l < heap.length && heap[l].distance > heap[big].distance) big = l;
            if (r < heap.length && heap[r].distance > heap[big].distance) big = r;
            if (big === i) return;
            [heap[big], heap[i]] = [heap[i], heap[big]];
            i = big;
        }
    };
    volumes.forEach((volume, v) => {
        const n = volume.states.length;
        for (let p = 0; p < n; p++) {
            if (volume.states[p] !== 0) continue;
            const dx = volume.positions[p * 3] - camera[0];
            const dy = volume.positions[p * 3 + 1] - camera[1];
            const dz = volume.positions[p * 3 + 2] - camera[2];
            const distance = dx * dx + dy * dy + dz * dz;
            if (heap.length < k) { heap.push({ volume: v, probe: p, distance }); up(heap.length - 1); }
            else if (distance < heap[0].distance) { heap[0] = { volume: v, probe: p, distance }; down(0); }
        }
    });
    heap.sort((a, b) => a.distance - b.distance);
    for (const c of heap) c.distance = Math.sqrt(c.distance);
    return heap;
}

// --- Relight triggers ---

/** What the relight depends on, read once a frame. */
export interface GiLightInputs {
    /** Unit direction TOWARD the key light, or null with none. */
    sunDir: ArrayLike<number> | null;
    /** The key light's illuminance (any consistent unit). */
    sunIntensity: number;
    /** The sky light's L0 luminance. */
    skyL0: number;
    /** A hash of every baked light's state (position, colour, intensity, range...). */
    lightSignature: number;
}

export interface GiTriggerOptions {
    /** Degrees the sun turns in ONE frame for the old light to be thrown away. */
    resetAngle: number;
    /** Ratio of the sun's or sky's brightness frame to frame for the same. */
    resetRatio: number;
    /** Relative change of the sky's L0 that calls a relight. */
    skyChange: number;
}

export const GI_TRIGGERS: GiTriggerOptions = { resetAngle: 10, resetRatio: 2, skyChange: 0.02 };

/** The angle between two unit directions, degrees. */
export function angleBetween(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    return Math.acos(d) * 180 / Math.PI;
}

function ratioOver(a: number, b: number, limit: number): boolean {
    const lo = Math.min(Math.abs(a), Math.abs(b)), hi = Math.max(Math.abs(a), Math.abs(b));
    if (hi <= 1e-12) return false;
    return lo <= 1e-12 ? true : hi / lo > limit;
}

/**
 * Whether this frame's light, against LAST frame's, is a jump the hysteresis must not blend across: the
 * sun turned more than `resetAngle` (the clock jumped), appeared or went, or the sun or sky changed
 * brightness by more than `resetRatio`.
 */
export function isLightJump(prev: GiLightInputs | null, now: GiLightInputs, o: GiTriggerOptions = GI_TRIGGERS): boolean {
    if (!prev) return true;
    if (!!prev.sunDir !== !!now.sunDir) return true;
    if (prev.sunDir && now.sunDir && angleBetween(prev.sunDir, now.sunDir) > o.resetAngle) return true;
    return ratioOver(prev.sunIntensity, now.sunIntensity, o.resetRatio) || ratioOver(prev.skyL0, now.skyL0, o.resetRatio);
}

/**
 * Whether the light has changed since the volume was last relit (`lit`, the inputs its last sweep began
 * with) enough to relight it: a baked light changed, or the sky moved by more than `skyChange`. The SUN is
 * not compared here — its direction is the shadow map's business ({@link needsShadowRender}), and a
 * re-rendered map is what calls the relight.
 */
export function needsRelight(lit: GiLightInputs | null, now: GiLightInputs, o: GiTriggerOptions = GI_TRIGGERS): boolean {
    if (!lit) return true;
    if (lit.lightSignature !== now.lightSignature) return true;
    if (Math.abs(now.sunIntensity - lit.sunIntensity) > o.skyChange * Math.max(Math.abs(lit.sunIntensity), 1e-12)) return true;
    const base = Math.max(Math.abs(lit.skyL0), 1e-12);
    return Math.abs(now.skyL0 - lit.skyL0) > o.skyChange * base;
}

/** Whether a volume's sun shadow map, drawn with the sun at `drawnDir`, must be drawn again for `sunDir`. */
export function needsShadowRender(drawnDir: ArrayLike<number> | null, sunDir: ArrayLike<number> | null, thresholdDeg: number): boolean {
    if (!sunDir) return false;
    if (!drawnDir) return true;
    return angleBetween(drawnDir, sunDir) > thresholdDeg;
}

/** A hash of numbers, for the baked lights' signature: equal inputs give equal numbers, without allocating. */
export function hashNumbers(values: ArrayLike<number>, seed: number = 0x811c9dc5): number {
    let h = seed >>> 0;
    for (let i = 0; i < values.length; i++) {
        const q = Number.isFinite(values[i]) ? Math.round(values[i] * 1e4) : 0;
        h = Math.imul(h ^ (q & 0xffff), 0x01000193);
        h = Math.imul(h ^ ((q >>> 16) & 0xffff), 0x01000193);
    }
    return h >>> 0;
}

// --- Sweeps ---

/** Of the old light kept by each normal sweep. */
export const GI_HYSTERESIS = 0.3;
/** Settle sweeps run until less than this much of the light before the change is left. */
export const GI_SETTLE_RESIDUAL = 0.05;

/** Normal sweeps one change runs: enough for the old light to fall under the residual. */
export function settleSweeps(hysteresis: number = GI_HYSTERESIS, residual: number = GI_SETTLE_RESIDUAL): number {
    if (hysteresis <= 0) return 1;
    return Math.max(1, Math.ceil(Math.log(residual) / Math.log(hysteresis)));
}

/** One sweep's settings. */
interface Pass { bounce: boolean; hysteresis: number }

/** A slice of one volume's relight for one frame: probes [first, first + count). */
export interface GiRelightBatch {
    first: number;
    count: number;
    /** Light the hits with the volume's own previous result (the bounces after the first). */
    bounce: boolean;
    /** Of the probes' old light kept. */
    hysteresis: number;
    /** The batch finishes its sweep. */
    endsSweep: boolean;
}

/**
 * One volume's relight queue. `request('relight')` when its light changed, `request('reset')` when the
 * old light must go; `take(maxProbes)` hands out the next batch, null when the volume is idle.
 */
export class GiSweepState {
    private _queue: Pass[] = [];
    private _cursor = 0;
    private _pending = false;

    constructor(public probeCount: number, public multiBounce: boolean = true,
                private readonly _hysteresis: number = GI_HYSTERESIS) {}

    /** Nothing to do. */
    public get idle(): boolean { return this._queue.length === 0 && !this._pending; }

    /** A sweep is half done. */
    public get sweeping(): boolean { return this._cursor > 0; }

    public request(kind: 'relight' | 'reset'): void {
        if (kind === 'reset') {
            this._cursor = 0;
            this._pending = false;
            this._queue = this.multiBounce
                ? [{ bounce: false, hysteresis: 0 }, { bounce: true, hysteresis: 0 }, { bounce: true, hysteresis: 0 }]
                : [{ bounce: false, hysteresis: 0 }];
            return;
        }
        if (this._queue.length === 0) this._queue = this._settle();
        else this._pending = true;
    }

    /** The next batch of at most `maxProbes`, or null when idle. */
    public take(maxProbes: number): GiRelightBatch | null {
        if (this._queue.length === 0) {
            if (!this._pending) return null;
            this._pending = false;
            this._queue = this._settle();
        }
        const pass = this._queue[0];
        const first = this._cursor;
        const count = Math.max(1, Math.min(Math.floor(maxProbes), this.probeCount - first));
        this._cursor += count;
        const endsSweep = this._cursor >= this.probeCount;
        if (endsSweep) {
            this._cursor = 0;
            this._queue.shift();
        }
        return { first, count, bounce: pass.bounce && this.multiBounce, hysteresis: pass.hysteresis, endsSweep };
    }

    private _settle(): Pass[] {
        return Array.from({ length: settleSweeps(this._hysteresis) }, () => ({ bounce: this.multiBounce, hysteresis: this._hysteresis }));
    }
}

/** A batch with the volume it belongs to. */
export interface GiFrameBatch extends GiRelightBatch { volume: number }

/**
 * The relight batches for one frame over every volume, within `raysPerFrame`: volumes in the order given
 * (nearest the camera first), each taking what its sweep needs of the budget left. At least one batch runs
 * when any volume has work, so a budget smaller than one probe still progresses.
 */
export function planRelightFrame(sweeps: readonly { state: GiSweepState; rays: number }[], raysPerFrame: number): GiFrameBatch[] {
    const out: GiFrameBatch[] = [];
    let budget = raysPerFrame;
    for (let v = 0; v < sweeps.length; v++) {
        const { state, rays } = sweeps[v];
        while (!state.idle) {
            const maxProbes = Math.floor(budget / rays);
            if (maxProbes < 1 && out.length > 0) return out;
            const batch = state.take(Math.max(1, maxProbes));
            if (!batch) break;
            out.push({ ...batch, volume: v });
            budget -= batch.count * rays;
            if (budget <= 0) return out;
        }
    }
    return out;
}
