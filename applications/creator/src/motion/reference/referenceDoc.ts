// A motion's video reference: which clip, and how its time lines up with the motion's.
//
// The motion's timeline is REAL time, seconds (what the bake samples). The video's own clock is its media
// time. They meet through `offset` (the video time shown at timeline 0) and `speed` (video seconds per real
// second: 1 for ordinary footage, 8 for a phone's 240 fps slow motion stored at 30 fps), and only the
// stretch between `in` and `out` of the video is shown.
//
// What is kept in the motion document is only what defines the reference -- every document change re-hashes
// the motion and re-imports its clip in the editor -- so how it is drawn (opacity, flip, difference) lives
// in the stage settings, and tracks live on the video asset.

import { normaliseCamera, type ReferenceCamera } from './referenceCamera';
import { normaliseCalibration, type CalibrationDoc } from './calibrate';

/** The real-time frame grid: the video's own frames (exact even for variable frame rate), or an even rate. */
export type FrameGrid = { frames: ArrayLike<number> } | { fps: number };

export interface MotionReference {
  /** The Creator library video asset (kind 'video'). */
  videoId: string;
  /** Video seconds shown at timeline 0. */
  offset: number;
  /** Video seconds per real second: the rate it was filmed at over the rate it plays at. */
  speed: number;
  /** The stretch of the video shown, video seconds. */
  in: number;
  out: number;
  /**
   * The camera it was filmed with, in the stage's world (referenceCamera.ts): what Look through frames.
   * Written only by an explicit action (Set from view, a calibration, Match pose).
   */
  camera?: ReferenceCamera;
  /** What was drawn on the frame to solve the camera (calibrate.ts): the lines, origin, scale and pins. */
  calib?: CalibrationDoc;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A stored reference made safe. Undefined when there is none (or it names no video). */
export function normaliseReference(raw: unknown): MotionReference | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<MotionReference>;
  if (typeof r.videoId !== 'string' || !r.videoId) return undefined;
  const speed = finite(r.speed) && r.speed > 0 ? Math.min(64, Math.max(1 / 64, r.speed)) : 1;
  const inT = finite(r.in) ? Math.max(0, r.in) : 0;
  const out = finite(r.out) && r.out > inT ? r.out : inT + 1;
  const camera = normaliseCamera(r.camera);
  // The calibration's own frame size is unknown here: missing fields take a 1080p frame's defaults.
  const calib = normaliseCalibration(r.calib, 1920, 1080);
  return {
    videoId: r.videoId, offset: finite(r.offset) ? Math.min(36000, Math.max(-36000, r.offset)) : inT, speed, in: inT, out,
    ...(camera ? { camera } : {}), ...(calib ? { calib } : {}),
  };
}

/** A new reference over a whole clip: its first frame at timeline 0, played at real time. */
export function newReference(videoId: string, start: number, duration: number): MotionReference {
  return { videoId, offset: start, speed: 1, in: start, out: start + Math.max(1e-3, duration) };
}

/** The video time shown at timeline time `t`. */
export const videoTimeOf = (ref: MotionReference, t: number): number => ref.offset + t * ref.speed;
/** The timeline time at which video time `v` is shown. */
export const timelineTimeOf = (ref: MotionReference, v: number): number => (v - ref.offset) / ref.speed;

/** Where the shown stretch sits on the timeline, real seconds. */
export function referenceSpan(ref: MotionReference): { start: number; end: number } {
  return { start: timelineTimeOf(ref, ref.in), end: timelineTimeOf(ref, ref.out) };
}

/** Whether timeline time `t` shows a frame (inside the in/out stretch). */
export function showsVideoAt(ref: MotionReference, t: number): boolean {
  const v = videoTimeOf(ref, t);
  return v >= ref.in - 1e-6 && v <= ref.out + 1e-6;
}

/** The index of the last timestamp at or before `v` (the frame on screen then), -1 before the first. */
export function frameIndexAt(timestamps: ArrayLike<number>, v: number): number {
  let lo = 0, hi = timestamps.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] <= v + 1e-6) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** The timeline times of the video's frames inside the shown stretch, ascending. */
export function timelineFrames(ref: MotionReference, timestamps: ArrayLike<number>): Float64Array {
  const out: number[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const v = timestamps[i];
    if (v >= ref.in - 1e-6 && v <= ref.out + 1e-6) out.push(timelineTimeOf(ref, v));
  }
  return Float64Array.from(out);
}

/** The nearest grid frame to `t`. */
export function snapToGrid(t: number, grid: FrameGrid): number {
  if ('fps' in grid) return grid.fps > 0 ? Math.round(t * grid.fps) / grid.fps : t;
  const f = grid.frames;
  if (!f.length) return t;
  const i = Math.max(0, frameIndexAt(f, t));
  const next = Math.min(f.length - 1, i + 1);
  return Math.abs(f[next] - t) < Math.abs(f[i] - t) ? f[next] : f[i];
}

/**
 * `n` frames on from `t` (back for negative `n`): from the frame `t` is on, or for an even rate the frame
 * `t` rounds to. Clamped to the grid's ends for the video's frames.
 */
export function stepOnGrid(t: number, n: number, grid: FrameGrid): number {
  if ('fps' in grid) return grid.fps > 0 ? (Math.round(t * grid.fps) + n) / grid.fps : t;
  const f = grid.frames;
  if (!f.length) return t;
  // From the frame on screen: between two frames, back shows the one before it, forward the one after.
  const at = frameIndexAt(f, t);
  const base = at < 0 ? (n > 0 ? -1 : 0) : at;
  return f[Math.min(f.length - 1, Math.max(0, base + n))];
}

/** The frame number (0-based, in the clip) on screen at timeline time `t`, or null outside the stretch. */
export function videoFrameAt(ref: MotionReference, timestamps: ArrayLike<number>, t: number): number | null {
  if (!showsVideoAt(ref, t)) return null;
  const i = frameIndexAt(timestamps, videoTimeOf(ref, t));
  return i < 0 ? null : i;
}
