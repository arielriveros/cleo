// Point tracking without learning: pyramidal Lucas–Kanade (Bouguet's formulation, the tracker in OpenCV and,
// with variations, in every match-mover). A small window around the point is assumed to move as one; the
// shift that best explains the change in brightness is solved from the window's image gradients, refined
// a few times, coarse level to fine, so it follows moves larger than the window.
//
// Each step is checked forward–backward: the point tracked from A to B is tracked back from B to A, and when
// it does not come home (an occlusion, a limb crossing another, motion blur) it is marked lost rather than
// drifting on with confidence.

import type { Gray } from './image';

/** One level of a pyramid: float pixels and their x and y gradients. */
export interface Level { w: number; h: number; img: Float32Array; gx: Float32Array; gy: Float32Array; }
export type Pyramid = Level[];

function level(w: number, h: number, img: Float32Array): Level {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const xl = x > 0 ? i - 1 : i, xr = x < w - 1 ? i + 1 : i, yu = y > 0 ? i - w : i, yd = y < h - 1 ? i + w : i;
    gx[i] = (img[xr] - img[xl]) * 0.5;
    gy[i] = (img[yd] - img[yu]) * 0.5;
  }
  return { w, h, img, gx, gy };
}

/** A picture's pyramid: each level half the last (a 2×2 box average). */
export function pyramid(g: Gray, levels = 3): Pyramid {
  let w = g.w, h = g.h;
  let img = Float32Array.from(g.data);
  const out: Pyramid = [level(w, h, img)];
  for (let l = 1; l < levels && w >= 16 && h >= 16; l++) {
    const nw = w >> 1, nh = h >> 1, next = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = 2 * y * w + 2 * x;
      next[y * nw + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) * 0.25;
    }
    w = nw; h = nh; img = next;
    out.push(level(w, h, img));
  }
  return out;
}

/** Bilinear sample (edges clamped). */
function at(a: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = Math.min(w - 1.001, Math.max(0, x)), cy = Math.min(h - 1.001, Math.max(0, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), fx = cx - x0, fy = cy - y0;
  const i = y0 * w + x0;
  return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + w] * (1 - fx) + a[i + w + 1] * fx) * fy;
}

export interface LkOptions { window?: number; iterations?: number; epsilon?: number; }

/**
 * Where point `p` (pixels of the finest level) of `a` moved to in `b`, or null when the window has too little
 * texture to say (the gradient matrix near singular) or it left the frame.
 */
export function trackPoint(a: Pyramid, b: Pyramid, p: readonly [number, number], opts: LkOptions = {}): [number, number] | null {
  const half = Math.max(2, Math.floor((opts.window ?? 15) / 2));
  const iters = opts.iterations ?? 20, eps = opts.epsilon ?? 0.01;
  const levels = Math.min(a.length, b.length);
  let gx = 0, gy = 0;   // the guess, carried from coarse to fine
  for (let l = levels - 1; l >= 0; l--) {
    const A = a[l], B = b[l];
    const s = 1 / (1 << l);
    const px = p[0] * s, py = p[1] * s;
    // The window's structure tensor, from A's gradients.
    let gxx = 0, gxy = 0, gyy = 0;
    const n = (2 * half + 1) ** 2;
    const ix = new Float32Array(n), iy = new Float32Array(n), ia = new Float32Array(n);
    let k = 0;
    for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++, k++) {
      const x = px + dx, y = py + dy;
      ix[k] = at(A.gx, A.w, A.h, x, y); iy[k] = at(A.gy, A.w, A.h, x, y); ia[k] = at(A.img, A.w, A.h, x, y);
      gxx += ix[k] * ix[k]; gxy += ix[k] * iy[k]; gyy += iy[k] * iy[k];
    }
    const det = gxx * gyy - gxy * gxy;
    // The smaller eigenvalue, per pixel: a flat or one-directional window cannot be tracked.
    const minEig = (gxx + gyy - Math.sqrt((gxx - gyy) ** 2 + 4 * gxy * gxy)) / (2 * n);
    if (det < 1e-9 || minEig < 1e-3) return null;
    let vx = 0, vy = 0;
    for (let it = 0; it < iters; it++) {
      let bx = 0, by = 0;
      k = 0;
      for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++, k++) {
        const diff = ia[k] - at(B.img, B.w, B.h, px + gx + vx + dx, py + gy + vy + dy);
        bx += diff * ix[k]; by += diff * iy[k];
      }
      const ex = (gyy * bx - gxy * by) / det, ey = (gxx * by - gxy * bx) / det;
      vx += ex; vy += ey;
      if (ex * ex + ey * ey < eps * eps) break;
    }
    if (l > 0) { gx = 2 * (gx + vx); gy = 2 * (gy + vy); } else { gx += vx; gy += vy; }
  }
  const q: [number, number] = [p[0] + gx, p[1] + gy];
  const f = a[0];
  if (!Number.isFinite(q[0]) || !Number.isFinite(q[1]) || q[0] < 0 || q[1] < 0 || q[0] > f.w - 1 || q[1] > f.h - 1) return null;
  return q;
}

/**
 * Track forward–backward: the point's place in `b` and how far tracking it back misses where it started
 * (pixels). Null when either way fails.
 */
export function trackChecked(a: Pyramid, b: Pyramid, p: readonly [number, number], opts?: LkOptions): { at: [number, number]; error: number } | null {
  const q = trackPoint(a, b, p, opts);
  if (!q) return null;
  const back = trackPoint(b, a, q, opts);
  if (!back) return null;
  return { at: q, error: Math.hypot(back[0] - p[0], back[1] - p[1]) };
}
