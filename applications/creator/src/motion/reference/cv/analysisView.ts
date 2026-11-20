// What the analysis says, read with the panel's settings (main thread, instant): key-pose candidates, held
// frames and the drawing rate, cuts, the subject's smoothed box per frame and the union of them, and whether
// the camera moved (a background model then fails: most of every frame "moves").

import type { AnalysisResult } from './analysisJob';
import { gaussianSmooth, heldFrames, keyCandidates, shotCuts, smoothBoxes, unionBox, type Candidate } from './signal';
import type { Box } from './image';

export interface AnalysisView {
  /** Key-pose candidates: frame indices (into `times`) and how sure (prominence, 0..1). */
  candidates: Candidate[];
  held: Uint8Array;
  /** 1: every frame its own; 2: on twos; 3: on threes. */
  onEvery: number;
  cuts: number[];
  /** The subject's box per frame, smoothed (null where none). */
  boxes: (Box | null)[];
  /** All of them, padded: a crop that never moves. */
  union: Box | null;
  /** The largest box, padded: a following crop's size. */
  followSize: { w: number; h: number } | null;
  /** Most frames differ from the background over much of their area: a moving camera. */
  cameraMoves: boolean;
  /** The curve the candidates come from (the subject's energy where there is one, else the frame's), smoothed. */
  curve: Float32Array;
}

export function readAnalysis(a: AnalysisResult, fps: number, sensitivity: number): AnalysisView {
  const n = a.times.length;
  const raw: (Box | null)[] = Array.from({ length: n }, (_, i) => {
    const x = a.boxes[i * 4];
    return Number.isFinite(x) ? { x, y: a.boxes[i * 4 + 1], w: a.boxes[i * 4 + 2], h: a.boxes[i * 4 + 3] } : null;
  });
  const boxes = smoothBoxes(raw);
  const withSubject = raw.filter(Boolean).length;
  // The subject's energy where it was found, the frame's elsewhere (scaled to match), so the curve has no holes.
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Number.isFinite(a.subjectEnergy[i]) ? a.subjectEnergy[i] : a.energy[i];
  const moving = Array.from(a.foreground).filter(f => f > 0.45).length;
  let fw = 0, fh = 0;
  for (const b of boxes) if (b) { fw = Math.max(fw, b.w * 1.3); fh = Math.max(fh, b.h * 1.3); }
  const followSize = fw > 0 && fh > 0 ? { w: fw, h: fh } : null;
  const { held, onEvery } = heldFrames(a.energy);
  const source = withSubject > n * 0.3 ? curve : a.energy;
  return {
    candidates: keyCandidates(source, fps, sensitivity),
    held, onEvery, cuts: shotCuts(a.histDist), boxes, union: unionBox(boxes), followSize,
    // Drawn as the candidates see it: smoothed the same way (animation on twos zig-zags otherwise).
    cameraMoves: moving > n * 0.5, curve: gaussianSmooth(source, Math.max(0.5, fps * 0.05)),
  };
}

/** The frame index on screen at video time `v` (the last at or before it), -1 before the first. */
export function analysisFrameAt(times: ArrayLike<number>, v: number): number {
  let lo = 0, hi = times.length - 1, found = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= v + 1e-6) { found = m; lo = m + 1; } else hi = m - 1; }
  return found;
}
