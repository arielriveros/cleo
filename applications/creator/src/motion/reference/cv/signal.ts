// The reference analysis's curves, one value a frame, and what they tell an animator:
//
//   key poses     the subject's motion energy (how much its pixels change frame to frame) dips where the
//                 action holds or turns -- the extremes and the contacts an animator keys first. Smoothed,
//                 its minima ranked by prominence (how far the curve rises on both sides before going lower)
//                 and kept a minimum gap apart are the candidates: the curve-simplification idea of
//                 key-posture extraction (Lim & Thalmann), on a signal a video gives without a pose model.
//   held frames   a frame no different from the one before: animation drawn "on twos" or "on threes", a
//                 phone repeating frames, a freeze. The usual hold length gives the drawing rate.
//   cuts          a jump in the luminance histogram far above the clip's usual frame-to-frame change: a
//                 shot change, where a reference clip should be trimmed.
//   subject box   per-frame boxes smoothed forward and back (no lag either way), gaps bridged, and their
//                 union for a crop that never moves.

import type { Box } from './image';

/** A signal smoothed with a Gaussian of `sigma` samples (edges clamped). */
export function gaussianSmooth(x: ArrayLike<number>, sigma: number): Float32Array {
  const n = x.length, out = new Float32Array(n);
  if (!(sigma > 0)) { for (let i = 0; i < n; i++) out[i] = x[i]; return out; }
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  for (let i = 0; i < n; i++) {
    let s = 0, wsum = 0;
    for (let j = -r; j <= r; j++) {
      const v = x[Math.min(n - 1, Math.max(0, i + j))];
      if (!Number.isFinite(v)) continue;
      s += v * k[j + r]; wsum += k[j + r];
    }
    out[i] = wsum ? s / wsum : 0;
  }
  return out;
}

export interface Candidate { frame: number; prominence: number; }

/**
 * Local minima of `x` whose prominence is at least `minProminence` (a share of the signal's range), a
 * minimum of `minGap` frames apart (the more prominent kept), in frame order.
 */
export function minimaByProminence(x: ArrayLike<number>, minProminence: number, minGap: number): Candidate[] {
  const n = x.length;
  if (n < 3) return [];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; }
  const range = hi - lo;
  if (!(range > 0)) return [];
  const found: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    const v = x[i];
    // A minimum (a flat bottom counts once, at its first sample).
    if (i > 0 && x[i - 1] <= v) continue;
    let j = i; while (j + 1 < n && x[j + 1] === v) j++;
    if (j + 1 < n && x[j + 1] < v) continue;
    // Prominence: the lower of the two highest points reached before the curve goes below v on each side.
    // A side that reaches the signal's end without going lower is open: the other side alone counts (a hold
    // at the very start or end of the clip is still a hold).
    let left = v, right = v, k = i - 1, m = j + 1;
    for (; k >= 0 && x[k] >= v; k--) left = Math.max(left, x[k]);
    for (; m < n && x[m] >= v; m++) right = Math.max(right, x[m]);
    // Both open: the lowest point of all, as deep as the highest it rises to either side.
    const openL = k < 0, openR = m >= n;
    const prom = (openL && openR ? Math.max(left, right) : openL ? right : openR ? left : Math.min(left, right)) - v;
    if (prom / range < minProminence) continue;
    // The middle of the low stretch around it (within a sixth of its prominence): a hold's middle, a turn's
    // bottom -- not wherever the codec's noise happened to dip lowest.
    const floor = v + prom / 6;
    let a = i, b = j;
    while (a > 0 && x[a - 1] <= floor) a--;
    while (b < n - 1 && x[b + 1] <= floor) b++;
    found.push({ frame: Math.round((a + b) / 2), prominence: prom / range });
  }
  // Keep the most prominent of any that crowd together.
  const kept: Candidate[] = [];
  for (const c of [...found].sort((a, b) => b.prominence - a.prominence)) {
    if (kept.every(k => Math.abs(k.frame - c.frame) >= minGap)) kept.push(c);
  }
  return kept.sort((a, b) => a.frame - b.frame);
}

/**
 * Key-pose candidates from a motion-energy curve: smoothed over about a tenth of a second, its minima of at
 * least `sensitivity`-scaled prominence a fifth of a second apart (at `fps`).
 */
export function keyCandidates(energy: ArrayLike<number>, fps: number, sensitivity = 0.5): Candidate[] {
  const smooth = gaussianSmooth(energy, Math.max(0.5, fps * 0.05));
  const minProminence = 0.02 + (1 - Math.min(1, Math.max(0, sensitivity))) * 0.3;
  return minimaByProminence(smooth, minProminence, Math.max(2, Math.round(fps * 0.2)));
}

/**
 * Frames that repeat the one before (difference below `eps`, the codec's noise), and the drawing rate they
 * give: the usual number of frames each drawing is held -- 1 for ordinary footage, 2 for animation on twos.
 */
export function heldFrames(diffs: ArrayLike<number>, eps = 0.004): { held: Uint8Array; onEvery: number } {
  const n = diffs.length, held = new Uint8Array(n);
  for (let i = 1; i < n; i++) held[i] = diffs[i] < eps ? 1 : 0;
  // Hold lengths: each changing frame and the held ones after it.
  const lengths: number[] = [];
  let run = 0;
  for (let i = 1; i < n; i++) {
    if (held[i]) run++;
    else { if (i > 1) lengths.push(run + 1); run = 0; }
  }
  if (!lengths.length) return { held, onEvery: 1 };
  const tally = new Map<number, number>();
  for (const l of lengths) if (l <= 6) tally.set(l, (tally.get(l) ?? 0) + 1);
  let onEvery = 1, best = 0;
  for (const [l, c] of tally) if (c > best || (c === best && l < onEvery)) { best = c; onEvery = l; }
  // Most of the clip has to hold that way for it to count (a few still moments are not "on twos").
  return { held, onEvery: best >= lengths.length * 0.5 ? onEvery : 1 };
}

/** Frames where a shot changes: a histogram jump over the median change plus `k` median deviations. */
export function shotCuts(histDist: ArrayLike<number>, k = 8, floor = 0.25): number[] {
  const v = Array.from(histDist).slice(1).filter(Number.isFinite);
  if (!v.length) return [];
  const med = median(v), mad = median(v.map(x => Math.abs(x - med))) || 1e-6;
  const cut = Math.max(floor, med + k * mad * 1.4826);
  const out: number[] = [];
  for (let i = 1; i < histDist.length; i++) if (histDist[i] > cut) out.push(i);
  return out;
}

export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Per-frame boxes (null where nothing was found) smoothed by an exponential average run forward and then
 * backward -- the two lags cancel -- with gaps up to `maxGap` frames bridged by the neighbours.
 */
export function smoothBoxes(boxes: (Box | null)[], alpha = 0.35, maxGap = 12): (Box | null)[] {
  const n = boxes.length;
  const filled: (Box | null)[] = boxes.map(b => b && { ...b });
  // Bridge short gaps linearly.
  for (let i = 0; i < n; i++) {
    if (filled[i]) continue;
    let j = i; while (j < n && !filled[j]) j++;
    const a = filled[i - 1], b = j < n ? filled[j] : null;
    if (a && b && j - i <= maxGap) {
      for (let k = i; k < j; k++) {
        const t = (k - i + 1) / (j - i + 1);
        filled[k] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t };
      }
    }
    i = j;
  }
  const pass = (order: number[]) => {
    let prev: Box | null = null;
    for (const i of order) {
      const b = filled[i];
      if (!b) { prev = null; continue; }
      if (prev) {
        b.x = prev.x + (b.x - prev.x) * alpha; b.y = prev.y + (b.y - prev.y) * alpha;
        b.w = prev.w + (b.w - prev.w) * alpha; b.h = prev.h + (b.h - prev.h) * alpha;
      }
      prev = b;
    }
  };
  const idx = Array.from({ length: n }, (_, i) => i);
  pass(idx);
  pass(idx.reverse());
  return filled;
}

/** The union of the boxes, grown by `pad` (a share of its size) on every side and kept in the frame. */
export function unionBox(boxes: (Box | null)[], pad = 0.12): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (!Number.isFinite(x0)) return null;
  return padBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, pad);
}

/** A box grown by `pad` of its size each side, clamped to the unit square. */
export function padBox(b: Box, pad: number): Box {
  const px = b.w * pad, py = b.h * pad;
  const x0 = Math.max(0, b.x - px), y0 = Math.max(0, b.y - py);
  const x1 = Math.min(1, b.x + b.w + px), y1 = Math.min(1, b.y + b.h + py);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A crop that follows the subject without pumping: every frame the same size (the largest box, padded),
 * centred on that frame's box, kept inside the frame.
 */
export function followCrop(box: Box, size: { w: number; h: number }): Box {
  const w = Math.min(1, size.w), h = Math.min(1, size.h);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h };
}
