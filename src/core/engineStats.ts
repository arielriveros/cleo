// What one turn of the engine loop spent, timed by the loop itself, and a running account of it for the
// Performance panel. Standalone (no engine imports) like sceneStats and physicsStats, so engine.ts can
// fill it without a cycle.
//
// Why the loop times itself: the panel used to take its own rAF interval, AVERAGED over a quarter
// second, and subtract the LAST frame's render, physics and scene figures from it. That "Unattributed"
// row therefore mixed three different things — the wait for the next display refresh (most of it in a
// parked editor), the renderer's own prologue that the Render figure leaves out on purpose (probe and
// sky bakes, the shader compile queue, the frame's submit), and snapshot-vs-average noise — and it
// peaked at 5 ms on a frame that had no untimed work at all. Measured per frame, each is its own row.

/** One loop turn, in milliseconds. */
export interface EngineFrame {
    /** Since the previous turn started: the real frame interval. */
    periodMs: number;
    /** This turn, start to end — the main thread's work for the frame. */
    loopMs: number;
    /** Input: gamepad poll, gestures, action resolution. */
    inputMs: number;
    /** `PhysicsSystem.update`, plus `endFrame` (the physics worker's send half). */
    physicsMs: number;
    /** `Scene.update`. */
    sceneMs: number;
    /** `Renderer.render`, whole: the passes AND the prologue, bakes and submit `frameStats.frameMs` leaves out. */
    renderMs: number;
}

/** The last loop turn. */
export const engineStats: EngineFrame = { periodMs: 0, loopMs: 0, inputMs: 0, physicsMs: 0, sceneMs: 0, renderMs: 0 };

/** Averages and peaks over the turns since the last {@link FrameAccount.drain}. */
export interface FrameSummary {
    frames: number;
    periodMs: number;
    loopMs: number;
    inputMs: number;
    physicsMs: number;
    sceneMs: number;
    renderMs: number;
    /** The render passes alone (`frameStats.frameMs`), so `renderMs - renderPassesMs` is the prologue. */
    renderPassesMs: number;
    /** Inside the loop but in none of the phases above. Near zero; a peak here is real untimed work. */
    untimedMs: number;
    untimedPeakMs: number;
    /** Between the end of one turn and the start of the next: display wait, GPU back-pressure, browser work. */
    outsideMs: number;
    outsidePeakMs: number;
    /** The renderer's prologue, bakes and submit, and its worst turn. */
    renderExtraMs: number;
    renderExtraPeakMs: number;
}

/**
 * Turns accumulated as they happen, summarised on demand. The engine adds every turn; whoever reads it
 * drains it, so each turn is counted exactly once whatever order the reader's own rAF runs in.
 */
export class FrameAccount {
    private _n = 0;
    private _period = 0; private _loop = 0; private _input = 0; private _physics = 0; private _scene = 0;
    private _render = 0; private _passes = 0; private _untimed = 0; private _outside = 0; private _extra = 0;
    private _untimedPeak = 0; private _outsidePeak = 0; private _extraPeak = 0;

    /** Account one turn. `renderPassesMs` is the frame's `frameStats.frameMs`. */
    public add(f: EngineFrame, renderPassesMs: number): void {
        const untimed = Math.max(0, f.loopMs - f.inputMs - f.physicsMs - f.sceneMs - f.renderMs);
        const outside = Math.max(0, f.periodMs - f.loopMs);
        const extra = Math.max(0, f.renderMs - renderPassesMs);
        this._n++;
        this._period += f.periodMs; this._loop += f.loopMs; this._input += f.inputMs;
        this._physics += f.physicsMs; this._scene += f.sceneMs; this._render += f.renderMs;
        this._passes += renderPassesMs; this._untimed += untimed; this._outside += outside; this._extra += extra;
        if (untimed > this._untimedPeak) this._untimedPeak = untimed;
        if (outside > this._outsidePeak) this._outsidePeak = outside;
        if (extra > this._extraPeak) this._extraPeak = extra;
    }

    /** The averages and peaks since the last drain, and start again. Zeros when no turn ran. */
    public drain(): FrameSummary {
        const n = Math.max(1, this._n);
        const s: FrameSummary = {
            frames: this._n,
            periodMs: this._period / n, loopMs: this._loop / n, inputMs: this._input / n,
            physicsMs: this._physics / n, sceneMs: this._scene / n, renderMs: this._render / n,
            renderPassesMs: this._passes / n,
            untimedMs: this._untimed / n, untimedPeakMs: this._untimedPeak,
            outsideMs: this._outside / n, outsidePeakMs: this._outsidePeak,
            renderExtraMs: this._extra / n, renderExtraPeakMs: this._extraPeak,
        };
        this._n = 0;
        this._period = this._loop = this._input = this._physics = this._scene = this._render = 0;
        this._passes = this._untimed = this._outside = this._extra = 0;
        this._untimedPeak = this._outsidePeak = this._extraPeak = 0;
        return s;
    }
}

/** Every engine loop turn, for the Performance panel to drain at each refresh. */
export const frameAccount = new FrameAccount();
