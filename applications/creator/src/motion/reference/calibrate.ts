// Solving the reference video's camera from what is drawn on its frame -- no learning, only the geometry of
// a pinhole camera (the method fSpy and Blender's camera matchers use):
//
//   two vanishing points   two pairs of lines along the ground's two axes (floor tiles, a road, a table's
//                          edges). Their crossings are the axes' vanishing points; for a centred principal
//                          point the focal length is f² = −(v₁−c)·(v₂−c), and the directions to them are
//                          the axes (Caprile & Torre, 1990).
//   one vanishing point    with a known lens: the lines along one axis give it, and a single line along the
//                          other fixes the roll.
//   origin and scale       the subject's ground point puts the world's origin under it; its height (or a
//                          known distance on the ground) sets how far away the camera is.
//   match a pose           pin four or more of the character's joints to where they are in the frame, with
//                          the character posed to match: the camera that projects them there, by
//                          Levenberg–Marquardt on the pins' pixel error (perspective-n-point).
//
// Everything is in the video's own pixels (y down) and the stage's world (metres, +Y up). Pure: the tests
// project known cameras and solve them back.

import { intersectLines, lineThrough, solveLinear } from 'cleo/core/math';
import {
  add3, cameraFromBasis, cross3, dot3, focalPx, forwardOf, groundHit, normalize, pixelRay, projectPoint, rolledUp, scale3,
  sub3, vfovOfFocalPx, cameraBasis, type CameraBasis, type ReferenceCamera, type Vec2, type Vec3,
} from './referenceCamera';

export type Segment = [Vec2, Vec2];

export interface CalibrationDoc {
  mode: '2vp' | '1vp';
  /** Lines along the ground's X axis (1-VP uses the first, for the roll). Video pixels. */
  x: [Segment, Segment];
  /** Lines along the ground's Z axis. */
  z: [Segment, Segment];
  /** The subject's ground point: the world's origin. */
  origin: Vec2;
  /** The top of the subject's head, straight above `origin` (for scale by height). */
  head: Vec2;
  scale: 'subject' | 'ruler';
  /** The subject's height, metres. */
  height: number;
  /** Two ground points a known `length` apart (metres), for scale by ruler. */
  ruler: { a: Vec2; b: Vec2; length: number };
  /** The lens for 1-VP: its vertical field of view, degrees. */
  vfov: number;
  /** Joints pinned to the frame for Match pose: joint name, video pixel. */
  pins: { joint: string; at: Vec2 }[];
}

/** Handles laid out over a `w`×`h` frame where a typical floor shot would put them. */
export function defaultCalibration(w: number, h: number, height = 1.75): CalibrationDoc {
  const p = (x: number, y: number): Vec2 => [x * w, y * h];
  return {
    mode: '2vp',
    x: [[p(0.18, 0.78), p(0.82, 0.74)], [p(0.12, 0.92), p(0.88, 0.87)]],
    z: [[p(0.30, 0.96), p(0.44, 0.58)], [p(0.72, 0.96), p(0.57, 0.58)]],
    origin: p(0.5, 0.84), head: p(0.5, 0.32), scale: 'subject', height,
    ruler: { a: p(0.35, 0.9), b: p(0.65, 0.9), length: 1 }, vfov: 50, pins: [],
  };
}

const pt = (v: unknown): Vec2 | null => (Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [v[0], v[1]] : null);
const seg = (v: unknown): Segment | null => { if (!Array.isArray(v)) return null; const a = pt(v[0]), b = pt(v[1]); return a && b ? [a, b] : null; };

/** A stored calibration made safe, filling what is missing from the defaults for this frame size. */
export function normaliseCalibration(raw: unknown, w: number, h: number): CalibrationDoc | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<CalibrationDoc>, d = defaultCalibration(w, h);
  const pair = (v: unknown, fallback: [Segment, Segment]): [Segment, Segment] =>
    Array.isArray(v) ? [seg(v[0]) ?? fallback[0], seg(v[1]) ?? fallback[1]] : fallback;
  const num = (v: unknown, lo: number, hi: number, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb);
  return {
    mode: r.mode === '1vp' ? '1vp' : '2vp',
    x: pair(r.x, d.x), z: pair(r.z, d.z),
    origin: pt(r.origin) ?? d.origin, head: pt(r.head) ?? d.head,
    scale: r.scale === 'ruler' ? 'ruler' : 'subject',
    height: num(r.height, 0.05, 50, d.height),
    ruler: { a: pt(r.ruler?.a) ?? d.ruler.a, b: pt(r.ruler?.b) ?? d.ruler.b, length: num(r.ruler?.length, 0.01, 1000, 1) },
    vfov: num(r.vfov, 1, 170, 50),
    pins: (Array.isArray(r.pins) ? r.pins : []).flatMap(p => (p && typeof p.joint === 'string' && pt(p.at) ? [{ joint: p.joint, at: pt(p.at)! }] : [])),
  };
}

export interface Solve {
  camera: ReferenceCamera;
  /** The axes' vanishing points (video pixels), for drawing; null at infinity. */
  vanishing: { x: Vec2 | null; z: Vec2 | null };
  /** The horizon through the frame, two points, or null. */
  horizon: Segment | null;
}

export type SolveResult = { ok: true; solve: Solve } | { ok: false; error: string };

const vanishing = (pair: [Segment, Segment]): Vec2 | null =>
  intersectLines(lineThrough(pair[0][0], pair[0][1]), lineThrough(pair[1][0], pair[1][1]));

/**
 * A pixel as a direction in the camera's own frame -- right, up, BACK (it looks along −back), so the frame is
 * right-handed and cross products of components mean what they say -- for a focal length in pixels.
 */
const camDir = (px: Vec2, w: number, h: number, f: number): Vec3 => normalize([px[0] - w / 2, -(px[1] - h / 2), -f]);

/**
 * The camera from the ground's axes as seen in its own frame (their directions, unit, in right/up/forward)
 * and a focal length, with the world's origin under `origin` and a provisional height of 1, then scaled.
 */
function finish(cal: CalibrationDoc, w: number, h: number, f: number, dX: Vec3, dZ: Vec3, vp: Solve['vanishing']): SolveResult {
  // Z toward the camera (the subject, which faces +Z, faces it); X so that Y = Z × X points up the frame.
  let z = dZ[2] < 0 ? scale3(dZ, -1) : dZ;
  let x = normalize(sub3(dX, scale3(z, dot3(dX, z))));
  let y = cross3(z, x);
  if (y[1] < 0) { x = scale3(x, -1); y = scale3(y, -1); }
  z = cross3(x, y);
  // The camera's axes in the world: the rows of [x y z] (each column a world axis in camera coordinates).
  const right: Vec3 = [x[0], y[0], z[0]], up: Vec3 = [x[1], y[1], z[1]], forward: Vec3 = [-x[2], -y[2], -z[2]];
  const vfov = vfovOfFocalPx(f, h);
  const toWorld = (c: Vec3): Vec3 => normalize(add3(add3(scale3(right, c[0]), scale3(up, c[1])), scale3(forward, -c[2])));
  const o = toWorld(camDir(cal.origin, w, h, f));
  if (o[1] > -1e-6) return { ok: false, error: 'The origin is above the horizon: put it on the ground, where the subject stands.' };
  // Height 1 first: the camera over the origin's ray.
  let position = scale3(o, 1 / o[1]);
  const basis = (pos: Vec3): CameraBasis => ({ position: pos, forward, right, up });
  let k = 1;
  if (cal.scale === 'ruler') {
    const a = groundHit(position, toWorld(camDir(cal.ruler.a, w, h, f))), b = groundHit(position, toWorld(camDir(cal.ruler.b, w, h, f)));
    if (!a || !b) return { ok: false, error: 'A ruler end is above the horizon: put both on the ground.' };
    const m = Math.hypot(a[0] - b[0], a[2] - b[2]);
    if (m < 1e-9) return { ok: false, error: 'The ruler’s ends are on the same spot.' };
    k = cal.ruler.length / m;
  } else {
    // Where the head's ray passes the vertical through the origin.
    const d = toWorld(camDir(cal.head, w, h, f)), C = position;
    const t = (C[1] - d[1] * dot3(d, C)) / Math.max(1e-9, 1 - d[1] * d[1]);
    if (!(t > 1e-6)) return { ok: false, error: 'The head is not above the origin in this view: move it up the frame.' };
    k = cal.height / t;
  }
  position = scale3(position, k);
  const camera = cameraFromBasis(position, forward, up, vfov);
  // The horizon: the vanishing line of the ground, through the frame's width.
  const hz = horizonOf(basis(position), vfov, w, h);
  return { ok: true, solve: { camera, vanishing: vp, horizon: hz } };
}

/** The ground's vanishing line across the frame (left and right edges), or null when it is vertical. */
export function horizonOf(b: CameraBasis, vfov: number, w: number, h: number): Segment | null {
  // Pixels whose ray is horizontal: up·ray = 0 in world, i.e. (r·x + u·y + f·F)_y = 0.
  const f = focalPx(vfov, h);
  const ry = b.right[1], uy = b.up[1], fy = b.forward[1];
  if (Math.abs(uy) < 1e-9) return null;
  const yAt = (px: number) => { const x = px - w / 2; const yc = -(ry * x + fy * f) / uy; return h / 2 - yc; };
  return [[0, yAt(0)], [w, yAt(w)]];
}

/** Solve with two vanishing points (lines along both ground axes), the principal point at the centre. */
export function solveTwoPoint(cal: CalibrationDoc, w: number, h: number): SolveResult {
  const vx = vanishing(cal.x), vz = vanishing(cal.z);
  if (!vx || !vz) return { ok: false, error: 'A pair of lines is parallel in the frame: tilt them toward where they meet.' };
  const ax = vx[0] - w / 2, ay = -(vx[1] - h / 2), bx = vz[0] - w / 2, by = -(vz[1] - h / 2);
  const f2 = -(ax * bx + ay * by);
  if (!(f2 > 1)) return { ok: false, error: 'The two vanishing points are on the same side of the frame’s centre: check that one pair runs along each axis.' };
  const f = Math.sqrt(f2);
  return finish(cal, w, h, f, normalize([ax, ay, -f]), normalize([bx, by, -f]), { x: vx, z: vz });
}

/** Solve with one vanishing point (the Z lines), a known lens, and the first X line for the roll. */
export function solveOnePoint(cal: CalibrationDoc, w: number, h: number): SolveResult {
  const vz = vanishing(cal.z);
  if (!vz) return { ok: false, error: 'The Z lines are parallel in the frame: tilt them toward where they meet.' };
  const f = focalPx(cal.vfov, h);
  const dZ = normalize([vz[0] - w / 2, -(vz[1] - h / 2), -f]);
  // The X line's plane through the camera; X lies in it, square to Z.
  const n = cross3(camDir(cal.x[0][0], w, h, f), camDir(cal.x[0][1], w, h, f));
  if (Math.hypot(...n) < 1e-9) return { ok: false, error: 'Draw the X line longer.' };
  const dX = normalize(cross3(normalize(n), dZ));
  return finish(cal, w, h, f, dX, dZ, { x: null, z: vz });
}

export function solveCalibration(cal: CalibrationDoc, w: number, h: number): SolveResult {
  return cal.mode === '1vp' ? solveOnePoint(cal, w, h) : solveTwoPoint(cal, w, h);
}

// --- Match a pose (perspective-n-point) ----------------------------------------------------------------

export interface PnpResult {
  camera: ReferenceCamera;
  /** Root-mean-square distance between the pins and where the solved camera puts their joints, pixels. */
  rms: number;
  iterations: number;
}

/**
 * The camera that projects each joint (world point) onto its pin (video pixel), from `start`, by
 * Levenberg–Marquardt. With `solveLens` the field of view is solved too (needs five pins or more).
 * Null when there are too few pins or it does not converge to anything in front of the camera.
 */
export function solvePnp(points: Vec3[], pins: Vec2[], w: number, h: number, start: ReferenceCamera,
                         opts: { solveLens?: boolean; iterations?: number } = {}): PnpResult | null {
  const n = Math.min(points.length, pins.length);
  const lens = !!opts.solveLens && n >= 5;
  if (n < (lens ? 5 : 4)) return null;
  const b0 = cameraBasis(start);
  // Parameters: yaw, pitch, roll (degrees), position xyz, and the field of view.
  let theta = [start.yaw, start.pitch, start.roll, ...b0.position, start.vfov];
  const residuals = (t: number[]): number[] => {
    const forward = forwardOf(t[1], t[0]);
    const up = rolledUp(forward, t[2]);
    const right = normalize(cross3(forward, up));
    const basis: CameraBasis = { position: [t[3], t[4], t[5]], forward, right, up: normalize(cross3(right, forward)) };
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = projectPoint(basis, t[6], w, h, points[i]);
      if (!p) { out.push(1e4, 1e4); continue; }
      out.push(p.px[0] - pins[i][0], p.px[1] - pins[i][1]);
    }
    return out;
  };
  const cost = (r: number[]) => r.reduce((s, v) => s + v * v, 0);
  const free = lens ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5];
  const spread = Math.max(1e-3, ...points.map(p => Math.hypot(p[0] - points[0][0], p[1] - points[0][1], p[2] - points[0][2])));
  const step = [1e-3, 1e-3, 1e-3, spread * 1e-5, spread * 1e-5, spread * 1e-5, 1e-3];
  let r = residuals(theta), c = cost(r), lambda = 1e-3, it = 0;
  const maxIt = opts.iterations ?? 200;
  for (; it < maxIt; it++) {
    // The Jacobian, by central differences.
    const J = r.map(() => new Array<number>(free.length).fill(0));
    free.forEach((k, j) => {
      const tp = [...theta], tm = [...theta];
      tp[k] += step[k]; tm[k] -= step[k];
      const rp = residuals(tp), rm = residuals(tm);
      for (let i = 0; i < r.length; i++) J[i][j] = (rp[i] - rm[i]) / (2 * step[k]);
    });
    const JtJ = free.map((_, a) => free.map((__, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
    const Jtr = free.map((_, a) => J.reduce((s, row, i) => s + row[a] * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10 && !improved; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v + lambda * Math.max(v, 1e-9) : v)));
      const delta = solveLinear(A, Jtr.map(v => -v));
      if (!delta) { lambda *= 10; continue; }
      const next = [...theta];
      free.forEach((k, j) => { next[k] += delta[j]; });
      next[6] = Math.min(170, Math.max(1, next[6]));
      const rn = residuals(next), cn = cost(rn);
      if (cn < c) {
        const gain = c - cn;
        theta = next; r = rn; c = cn; lambda = Math.max(1e-9, lambda / 3); improved = true;
        if (gain < 1e-10 * Math.max(1, c)) it = maxIt;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  if (r.some(v => Math.abs(v) >= 1e4)) return null;
  const forward = forwardOf(theta[1], theta[0]);
  const camera = cameraFromBasis([theta[3], theta[4], theta[5]], forward, rolledUp(forward, theta[2]), theta[6],
    centroid(points));
  return { camera, rms: Math.sqrt(c / n), iterations: it };
}

function centroid(points: Vec3[]): Vec3 {
  const s = points.reduce<Vec3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  return scale3(s, 1 / Math.max(1, points.length));
}

/** Turn a camera about the vertical through `pivot` by `degrees`: the subject faces another way in the shot. */
export function turnCamera(c: ReferenceCamera, degrees: number, pivot: Vec3 = [0, 0, 0]): ReferenceCamera {
  const a = (degrees * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  const rot = (v: Vec3): Vec3 => [v[0] * cs + v[2] * sn, v[1], -v[0] * sn + v[2] * cs];
  const t = add3(rot(sub3(c.target, pivot)), pivot);
  return { ...c, target: t, yaw: c.yaw + degrees };
}

export { pixelRay };
