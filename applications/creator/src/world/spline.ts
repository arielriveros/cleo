// Splines for the linear landforms (ridges, valleys, rivers, roads), in normalised map coordinates
// (0..1 across the world). A Catmull-Rom curve through the control points, flattened to a polyline once
// per evaluation; each sample then asks for its distance to that polyline and the parameter there.

export type Point2 = [number, number];

/** Catmull-Rom through `pts`, `perSegment` samples per span. Endpoints are duplicated so the curve reaches them. */
export function flattenSpline(pts: readonly Point2[], perSegment = 16): Point2[] {
  if (pts.length < 2) return pts.map(p => [p[0], p[1]] as Point2);
  const out: Point2[] = [];
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < perSegment; s++) {
      const t = s / perSegment, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const last = pts[pts.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

/** A flattened spline with cumulative arc length, ready for distance queries. */
export interface Polyline {
  pts: Point2[];
  /** Arc length at each point, normalised so the last is 1. */
  along: Float64Array;
  /** Bounding box, padded by the caller's reach, to skip far samples cheaply. */
  min: Point2;
  max: Point2;
}

export function polyline(pts: readonly Point2[], perSegment = 16): Polyline {
  const flat = flattenSpline(pts, perSegment);
  const along = new Float64Array(flat.length);
  let total = 0;
  for (let i = 1; i < flat.length; i++) {
    total += Math.hypot(flat[i][0] - flat[i - 1][0], flat[i][1] - flat[i - 1][1]);
    along[i] = total;
  }
  if (total > 0) for (let i = 0; i < along.length; i++) along[i] /= total;
  const min: Point2 = [Infinity, Infinity], max: Point2 = [-Infinity, -Infinity];
  for (const p of flat) {
    min[0] = Math.min(min[0], p[0]); min[1] = Math.min(min[1], p[1]);
    max[0] = Math.max(max[0], p[0]); max[1] = Math.max(max[1], p[1]);
  }
  return { pts: flat, along, min, max };
}

/** Distance from (x, y) to the polyline, and the normalised arc length of the closest point. */
export function closest(line: Polyline, x: number, y: number): { distance: number; t: number } {
  let best = Infinity, bestT = 0;
  const p = line.pts;
  if (p.length === 1) return { distance: Math.hypot(x - p[0][0], y - p[0][1]), t: 0 };
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], ay = p[i][1];
    const dx = p[i + 1][0] - ax, dy = p[i + 1][1] - ay;
    const len2 = dx * dx + dy * dy;
    const s = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const qx = ax + dx * s - x, qy = ay + dy * s - y;
    const d2 = qx * qx + qy * qy;
    if (d2 < best) { best = d2; bestT = line.along[i] + (line.along[i + 1] - line.along[i]) * s; }
  }
  return { distance: Math.sqrt(best), t: bestT };
}
