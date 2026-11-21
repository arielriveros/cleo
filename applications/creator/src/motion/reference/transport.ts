// The Motion timeline's clock, while the whole motion plays (the Motion view): play, pause, a speed (negative
// plays backwards), a loop range, and frame steps on the active grid -- the reference video's own frames
// when one is linked, else the motion's bake rate.
//
// The animator does not run the clock in that view: the stage pauses it and seeks it to `motionClipTime` of
// the transport's time every frame, so the timeline can run past the clip's last frame to the end of a
// longer video (the character holds its last pose, or cycles when the motion loops). Plain TS: the stage's
// frame callback advances it; React reads it through `subscribe` (state changes only, never per frame).

import { snapToGrid, stepOnGrid, type FrameGrid } from './referenceDoc';

export interface TransportState {
  playing: boolean;
  rate: number;
  loop: boolean;
  /** The loop range, seconds; null: the whole timeline. */
  range: [number, number] | null;
}

export class MotionTransport {
  /** Seconds on the motion's timeline. */
  time = 0;
  /** The timeline's length (the clip, or the video's out-point if later). */
  end = 1;
  grid: FrameGrid = { fps: 30 };
  private state: TransportState = { playing: true, rate: 1, loop: true, range: null };
  private readonly listeners = new Set<() => void>();

  get playing(): boolean { return this.state.playing; }
  get rate(): number { return this.state.rate; }
  get loop(): boolean { return this.state.loop; }
  get range(): [number, number] | null { return this.state.range; }
  /** The stretch played: the loop range when set, clamped to the timeline. */
  span(): [number, number] {
    const r = this.state.range;
    const lo = r ? Math.max(0, Math.min(r[0], this.end)) : 0;
    const hi = r ? Math.max(lo, Math.min(r[1], this.end)) : this.end;
    return hi - lo > 1e-6 ? [lo, hi] : [0, this.end];
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private set(patch: Partial<TransportState>): void {
    const next = { ...this.state, ...patch };
    if (next.playing === this.state.playing && next.rate === this.state.rate && next.loop === this.state.loop
        && next.range?.[0] === this.state.range?.[0] && next.range?.[1] === this.state.range?.[1]) return;
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  play(): void { this.set({ playing: true }); }
  pause(): void { this.set({ playing: false }); }
  toggle(): void { this.set({ playing: !this.state.playing }); }
  setRate(rate: number): void { this.set({ rate: Number.isFinite(rate) && rate !== 0 ? Math.max(-8, Math.min(8, rate)) : 1 }); }
  setLoop(loop: boolean): void { this.set({ loop }); }
  setRange(range: [number, number] | null): void {
    this.set({ range: range && range[1] - range[0] > 1e-6 ? [Math.max(0, range[0]), range[1]] : null });
  }
  /** Set the loop range's start (I) or end (O) at the playhead. */
  markIn(): void { const [, hi] = this.span(); this.setRange([this.time, this.state.range ? hi : this.end]); }
  markOut(): void { const [lo] = this.span(); this.setRange([this.state.range ? lo : 0, this.time]); }

  /** Jump to `t`, clamped to the timeline (it keeps playing if it was). */
  seek(t: number): void { this.time = Math.min(this.end, Math.max(0, Number.isFinite(t) ? t : 0)); }
  /** Pause and move `n` frames on the active grid. */
  step(n: number): void { this.pause(); this.seek(stepOnGrid(this.time, n, this.grid)); }
  toStart(): void { this.pause(); this.seek(this.span()[0]); }
  toEnd(): void { this.pause(); this.seek(this.span()[1]); }
  snap(t: number): number { return snapToGrid(t, this.grid); }

  /**
   * Move the clock on by `dt` real seconds of wall time, if playing. At an end of the played stretch it
   * wraps when looping, else stops there. Returns whether the time moved.
   */
  advance(dt: number): boolean {
    if (!this.state.playing || !(dt > 0)) return false;
    const [lo, hi] = this.span();
    const len = hi - lo;
    let t = this.time + Math.min(dt, 0.25) * this.state.rate;
    if (this.time < lo - 1e-6 || this.time > hi + 1e-6) t = this.state.rate > 0 ? lo : hi;   // outside: start over
    else if (t > hi || t < lo) {
      if (!this.state.loop || len <= 1e-6) { this.time = t > hi ? hi : lo; this.pause(); return true; }
      t = lo + ((((t - lo) % len) + len) % len);
    }
    this.time = t;
    return true;
  }
}

/**
 * The time in the baked clip for timeline time `t`: cycling when the motion loops, else held on its last
 * frame past the end.
 */
export function motionClipTime(t: number, clipLength: number, loop: boolean): number {
  if (!(clipLength > 0)) return 0;
  if (t <= clipLength) return Math.max(0, t);
  return loop ? t % clipLength : clipLength;
}
