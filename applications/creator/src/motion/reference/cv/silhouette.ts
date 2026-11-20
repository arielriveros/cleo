// A body's ends from its silhouette alone -- head, hands, feet, a tail -- for any creature, with no model of
// a body: the "star skeleton" (Fujiyoshi & Lipton). Walk round the outline of the largest region, measure
// each outline point's distance from the region's centre, smooth that signal, and its peaks are the
// extremities: the points sticking out furthest in their part of the outline. They are only suggestions
// (seeds for the tracker); an animator names them.

import { connectedComponents, type Mask } from './image';

/**
 * The outline of the region labelled `label` in `labels` (Moore-neighbour tracing, clockwise from its
 * top-left pixel), as pixel points.
 */
export function traceContour(labels: Int32Array, w: number, h: number, label: number): [number, number][] {
  let start = -1;
  for (let i = 0; i < labels.length; i++) if (labels[i] === label) { start = i; break; }
  if (start < 0) return [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === label;
  // Neighbours clockwise from west: W, NW, N, NE, E, SE, S, SW.
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1], DY = [0, -1, -1, -1, 0, 1, 1, 1];
  const sx = start % w, sy = (start / w) | 0;
  const out: [number, number][] = [[sx, sy]];
  let x = sx, y = sy, dir = 0;   // came from the west (the scan reached it moving right)
  for (let guard = 0; guard < w * h * 4; guard++) {
    let found = false;
    // Search clockwise starting just after the backtrack direction.
    for (let k = 0; k < 8; k++) {
      const d = (dir + 1 + k) % 8;
      const nx = x + DX[d], ny = y + DY[d];
      if (inside(nx, ny)) { x = nx; y = ny; dir = (d + 4) % 8; found = true; break; }
    }
    if (!found) break;                                   // a single pixel
    if (x === sx && y === sy) break;
    out.push([x, y]);
  }
  return out;
}

export interface Extremity { x: number; y: number; reach: number; }

/**
 * The silhouette's extremities, in its picture's unit square, furthest-reaching first: peaks of the smoothed
 * distance-from-centre along the outline that stand out by `minProminence` of the largest distance, at
 * most `max` of them.
 */
export function extremities(mask: Mask, opts: { max?: number; minProminence?: number } = {}): Extremity[] {
  const { labels, blobs } = connectedComponents(mask);
  const body = blobs[0];
  if (!body || body.area < 8) return [];
  const contour = traceContour(labels, mask.w, mask.h, body.label);
  const n = contour.length;
  if (n < 8) return [];
  const d = contour.map(([x, y]) => Math.hypot(x - body.cx, y - body.cy));
  // Smooth round the loop.
  const r = Math.max(1, Math.round(n / 60));
  const s = d.map((_, i) => { let t = 0; for (let k = -r; k <= r; k++) t += d[(i + k + n) % n]; return t / (2 * r + 1); });
  const top = Math.max(...s);
  const minProm = (opts.minProminence ?? 0.12) * top;
  const peaks: { i: number; prom: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!(s[i] >= s[(i - 1 + n) % n] && s[i] > s[(i + 1) % n])) continue;
    // Prominence round a loop: how far it falls on both sides before rising above it again.
    let lo1 = s[i], lo2 = s[i];
    for (let k = 1; k < n; k++) { const v = s[(i - k + n) % n]; if (v > s[i]) break; lo1 = Math.min(lo1, v); }
    for (let k = 1; k < n; k++) { const v = s[(i + k) % n]; if (v > s[i]) break; lo2 = Math.min(lo2, v); }
    const prom = s[i] - Math.max(lo1, lo2);
    if (prom >= minProm || s[i] === top) peaks.push({ i, prom });
  }
  return peaks
    .sort((a, b) => s[b.i] - s[a.i])
    .slice(0, opts.max ?? 6)
    .map(p => ({ x: (contour[p.i][0] + 0.5) / mask.w, y: (contour[p.i][1] + 0.5) / mask.h, reach: s[p.i] / top }));
}
