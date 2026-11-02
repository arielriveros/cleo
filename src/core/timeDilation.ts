// The game clock's speed: a base time scale the game sets (slow motion for a whole sequence, 0.5 for a
// "bullet time" power-up) times any brief dilation running on top of it (a hit-stop). The engine loop
// multiplies each frame's delta by it before physics, scripts, timers, animators and particles see it,
// so everything that simulates slows together. Input, camera rigs and UI keep real time.
//
// A dilation counts down in REAL (unscaled) seconds: a 0.08 s hit-stop lasts 0.08 s on the wall clock
// whatever the scale, which is what makes it read as an impact rather than as lag.

/** Options for {@link TimeDilation.dilate}. */
export interface DilateOptions {
    /**
     * The share of the duration, at its end, spent easing back to full speed (0..1). 0 snaps back. Default 0.3:
     * a hit-stop that releases over its last third reads as weight, not as a stutter.
     */
    easeOut?: number;
    /**
     * Frames that run at the full slow scale whatever the frame rate, before any ease-out. A 0.08 s hit-stop is
     * five frames at 60 fps but one at 15; holding it for at least two keeps it visible on a slow machine.
     * Default 0.
     */
    minFrames?: number;
}

export class TimeDilation {
    private _base = 1;
    /** The running dilation's scale, real seconds left, and how long its ease-out is (seconds). */
    private _scale = 1;
    private _left = 0;
    private _ease = 0;
    /** Frames still to run at the full slow scale (see DilateOptions.minFrames). */
    private _holdFrames = 0;

    /** The game's own time scale, ≥ 0: 1 is real time, 0 freezes the simulation (unlike pause, scripts still get onUpdate). */
    public get base(): number { return this._base; }
    public set base(scale: number) {
        if (Number.isFinite(scale)) this._base = Math.max(0, scale);
    }

    /** Whether a dilation is running. */
    public get active(): boolean { return this._left > 0 || this._holdFrames > 0; }

    /** The dilation's own factor right now (1 when none runs), before the base scale. */
    public get dilation(): number {
        if (this._holdFrames > 0) return this._scale;
        if (this._left <= 0) return 1;
        if (this._ease > 0 && this._left < this._ease) {
            // Ease back: smoothstep from the dilated scale to 1 across the ease-out window.
            const t = 1 - this._left / this._ease;
            const s = t * t * (3 - 2 * t);
            return this._scale + (1 - this._scale) * s;
        }
        return this._scale;
    }

    /** The scale this frame's delta is multiplied by: base × dilation. */
    public get scale(): number { return this._base * this.dilation; }

    /**
     * Run game time at `scale` (0..1) for `seconds` of real time. Overlapping dilations merge: the slower
     * scale and the later end win, so a heavy hit landing during a light one's hit-stop deepens it.
     */
    public dilate(scale: number, seconds: number, options: DilateOptions = {}): void {
        if (!(seconds > 0) || !Number.isFinite(scale)) return;
        const s = Math.min(1, Math.max(0, scale));
        const ease = Math.min(1, Math.max(0, options.easeOut ?? 0.3)) * seconds;
        const frames = Math.max(0, Math.floor(options.minFrames ?? 0));
        this._holdFrames = Math.max(this._holdFrames, frames);
        if (this.active && this._left > 0) {
            this._scale = Math.min(this._scale, s);
            if (seconds >= this._left) { this._left = seconds; this._ease = ease; }
        } else {
            this._scale = s;
            this._left = seconds;
            this._ease = ease;
        }
    }

    /** End any running dilation now. The base scale stays. */
    public clear(): void {
        this._left = 0;
        this._scale = 1;
        this._ease = 0;
        this._holdFrames = 0;
    }

    /**
     * Advance by one frame of REAL time and return the scale for that frame. The frame is charged at the
     * scale it starts with, then the dilation counts down.
     */
    public update(unscaledDelta: number): number {
        const scale = this.scale;
        if (this.active && unscaledDelta > 0) {
            this._left -= unscaledDelta;
            if (this._holdFrames > 0) this._holdFrames--;
            // A hair of float left over from summing frame deltas is not another frame of hit-stop.
            if (this._left <= 1e-6 && this._holdFrames <= 0) this.clear();
        }
        return scale;
    }
}
