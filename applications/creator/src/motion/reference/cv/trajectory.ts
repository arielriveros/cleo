// What a tracked point's path says: where it turns (its extremes), where it stops (a foot's contacts), and
// the few points that keep its shape (Ramer–Douglas–Peucker, the curve simplification behind classic
// key-frame extraction from motion capture).

/** A point's path: x, y per frame (NaN where lost), in any one unit. */
export type Path = ArrayLike<number>;

const px = (p: Path, i: number) => p[i * 2], py = (p: Path, i: number) => p[i * 2 + 1];
const ok = (p: Path, i: number) => Number.isFinite(px(p, i)) && Number.isFinite(py(p, i));

/**
 * The frames that keep a path's shape within `epsilon`: Ramer–Douglas–Peucker over (frame, x, y), the frame
 * scaled by `timeScale` so time counts too (a pause is a corner). Its first and last found frames included.
 */
export function rdp(path: Path, epsilon: number, timeScale = 0): number[] {
  const idx: number[] = [];
  for (let i = 0; i < path.length / 2; i++) if (ok(path, i)) idx.push(i);
  if (idx.length < 3) return idx;
  const keep = new Uint8Array(idx.length);
  keep[0] = keep[idx.length - 1] = 1;
  const pt = (k: number) => [idx[k] * timeScale, px(path, idx[k]), py(path, idx[k])];
  const stack: [number, number][] = [[0, idx.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pt(a), B = pt(b);
    const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    let best = -1, bestD = epsilon;
    for (let k = a + 1; k < b; k++) {
      const P = pt(k), ap = [P[0] - A[0], P[1] - A[1], P[2] - A[2]];
      const t = len2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
      const d = Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
      if (d > bestD) { bestD = d; best = k; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return idx.filter((_, k) => keep[k]);
}

/** Speed per frame along a path (NaN where either end is lost). */
export function speeds(path: Path): Float32Array {
  const n = path.length / 2, out = new Float32Array(n).fill(NaN);
  for (let i = 1; i < n; i++) if (ok(path, i) && ok(path, i - 1)) out[i] = Math.hypot(px(path, i) - px(path, i - 1), py(path, i) - py(path, i - 1));
  if (n > 1) out[0] = out[1];
  return out;
}

/**
 * Stretches where the point (stays near) still: speed under `maxSpeed` for at least `minFrames` frames -- a
 * foot planted on the ground. [first, last] frames, inclusive.
 */
export function contacts(path: Path, maxSpeed: number, minFrames: number): [number, number][] {
  const v = speeds(path);
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= v.length; i++) {
    // Still if it arrived still or leaves still: the frame a foot lands on, and the last before it lifts.
    const arrive = v[i], leave = i + 1 < v.length ? v[i + 1] : NaN;
    const slowest = Math.min(Number.isFinite(arrive) ? arrive : Infinity, Number.isFinite(leave) ? leave : Infinity);
    const still = i < v.length && slowest <= maxSpeed;
    if (still && start < 0) start = i;
    if (!still && start >= 0) { if (i - start >= minFrames) out.push([start, i - 1]); start = -1; }
  }
  return out;
}

/**
 * Where a path turns: a frame whose motion reverses along x or y (the velocity's sign changes there, by more
 * than `minSpeed` either side) -- the top of a swing, the back of a wind-up.
 */
export function turns(path: Path, minSpeed: number): number[] {
  const n = path.length / 2, out: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (!ok(path, i - 1) || !ok(path, i) || !ok(path, i + 1)) continue;
    for (const c of [0, 1]) {
      const before = path[i * 2 + c] - path[(i - 1) * 2 + c], after = path[(i + 1) * 2 + c] - path[i * 2 + c];
      if (before * after < 0 && Math.abs(before) > minSpeed && Math.abs(after) > minSpeed) { out.push(i); break; }
    }
  }
  return out;
}

/**
 * A path between seeds: tracked forward from each seed and backward from the next, blended by how far the
 * frame is from each (a correction pulls the whole stretch, not only its own frame). `fwd`/`bwd` hold, per
 * seed index, its forward and backward tracks over every frame (NaN outside their reach).
 */
export function blendSeeded(n: number, seedFrames: number[], fwd: Float32Array[], bwd: Float32Array[]): Float32Array {
  const out = new Float32Array(n * 2).fill(NaN);
  const order = seedFrames.map((f, i) => ({ f, i })).sort((a, b) => a.f - b.f);
  for (let i = 0; i < n; i++) {
    // The seeds on either side.
    let prev: { f: number; i: number } | null = null, next: { f: number; i: number } | null = null;
    for (const s of order) { if (s.f <= i) prev = s; else { next = s; break; } }
    const a = prev ? [fwd[prev.i][i * 2], fwd[prev.i][i * 2 + 1]] : null;
    const b = next ? [bwd[next.i][i * 2], bwd[next.i][i * 2 + 1]] : null;
    const aOk = a && Number.isFinite(a[0]), bOk = b && Number.isFinite(b[0]);
    if (aOk && bOk) {
      const w = (i - prev!.f) / Math.max(1, next!.f - prev!.f);
      out[i * 2] = a![0] * (1 - w) + b![0] * w; out[i * 2 + 1] = a![1] * (1 - w) + b![1] * w;
    } else if (aOk) { out[i * 2] = a![0]; out[i * 2 + 1] = a![1]; }
    else if (bOk) { out[i * 2] = b![0]; out[i * 2 + 1] = b![1]; }
  }
  return out;
}
