// The camera the reference video was filmed with, as the stage sees it: where it stands, where it looks, its
// roll and its lens. Kept as an orbit (a target, a distance and the angles), so looking through it and then
// orbiting from there is the stage's own orbit camera, and the target stays near the subject.
//
// The model is the engine's: forward = (cos p·sin y, −sin p, cos p·cos y) for pitch p (down positive) and
// yaw y; the view is a lookAt along forward with the camera's `up` (the roll lives there, not in the node's
// rotation); screen right = forward × up. A pinhole with square pixels and the principal point at the
// frame's centre, so a vertical field of view says everything about the lens.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface ReferenceCamera {
  target: Vec3;
  distance: number;
  /** Degrees, down positive. */
  pitch: number;
  /** Degrees about +Y; 0 looks along +Z. */
  yaw: number;
  /** Degrees about the view axis, the picture turning counter-clockwise for positive. */
  roll: number;
  /** Vertical field of view of the video's frame, degrees. */
  vfov: number;
}

export interface CameraBasis { position: Vec3; forward: Vec3; right: Vec3; up: Vec3; }

const DEG = Math.PI / 180;
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: ArrayLike<number>, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const normalize = (a: ArrayLike<number>): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export { dot as dot3, cross as cross3, add as add3, sub as sub3, scale as scale3 };

/** The forward of pitch/yaw (degrees). */
export function forwardOf(pitch: number, yaw: number): Vec3 {
  const p = pitch * DEG, y = yaw * DEG;
  return [Math.cos(p) * Math.sin(y), -Math.sin(p), Math.cos(p) * Math.cos(y)];
}

/** The un-rolled right and up for a forward (world up +Y). Looking straight up or down: +X as the right. */
function unrolled(forward: Vec3): { right: Vec3; up: Vec3 } {
  let right = cross(forward, [0, 1, 0]);
  if (Math.hypot(...right) < 1e-9) right = [1, 0, 0];
  right = normalize(right);
  return { right, up: normalize(cross(right, forward)) };
}

/** The camera's `up` for a forward and a roll (what the engine's lookAt is given). */
export function rolledUp(forward: Vec3, roll: number): Vec3 {
  const { right, up } = unrolled(forward);
  const r = roll * DEG;
  return normalize(add(scale(up, Math.cos(r)), scale(right, -Math.sin(r))));
}

export function cameraBasis(c: ReferenceCamera): CameraBasis {
  const forward = forwardOf(c.pitch, c.yaw);
  const up = rolledUp(forward, c.roll);
  const right = normalize(cross(forward, up));
  return { position: sub(c.target, scale(forward, c.distance)), forward, right, up: normalize(cross(right, forward)) };
}

/**
 * The orbit camera for a position and orientation (forward and up, world), its target `distance` ahead (by
 * default where the view passes closest to `pivot`, the subject's ground point).
 */
export function cameraFromBasis(position: Vec3, forward: Vec3, up: Vec3, vfov: number, pivot: Vec3 = [0, 0, 0], distance?: number): ReferenceCamera {
  const f = normalize(forward);
  const pitch = -Math.asin(Math.max(-1, Math.min(1, f[1]))) / DEG;
  const yaw = Math.atan2(f[0], f[2]) / DEG;
  const base = unrolled(f);
  const u = normalize(up);
  const roll = Math.atan2(-dot(u, base.right), dot(u, base.up)) / DEG;
  const d = distance ?? Math.max(0.25, dot(sub(pivot, position), f));
  return { target: add(position, scale(f, d)), distance: d, pitch, yaw, roll, vfov };
}

/** Focal length in pixels for a frame `height` pixels tall. */
export const focalPx = (vfov: number, height: number) => (height / 2) / Math.tan((vfov * DEG) / 2);
export const vfovOfFocalPx = (f: number, height: number) => (2 * Math.atan((height / 2) / f)) / DEG;

/** A world point in the video's pixels (y down) and its depth along the view; null behind the camera. */
export function projectPoint(b: CameraBasis, vfov: number, width: number, height: number, p: ArrayLike<number>): { px: Vec2; depth: number } | null {
  const d = sub(p, b.position);
  const z = dot(d, b.forward);
  if (z <= 1e-9) return null;
  const f = focalPx(vfov, height);
  return { px: [width / 2 + (f * dot(d, b.right)) / z, height / 2 - (f * dot(d, b.up)) / z], depth: z };
}

/** The world direction through a pixel of the video (y down). */
export function pixelRay(b: CameraBasis, vfov: number, width: number, height: number, px: ArrayLike<number>): Vec3 {
  const f = focalPx(vfov, height);
  const x = (px[0] - width / 2) / f, y = -(px[1] - height / 2) / f;
  return normalize(add(add(b.forward, scale(b.right, x)), scale(b.up, y)));
}

/** Where a ray meets the ground (y = 0); null when it never does. */
export function groundHit(origin: Vec3, dir: Vec3): Vec3 | null {
  if (dir[1] > -1e-9) return null;
  const s = -origin[1] / dir[1];
  return s > 0 ? add(origin, scale(dir, s)) : null;
}

/**
 * The stage camera's vertical field of view that frames the video's exactly: the video, contain-fit,
 * covers `gateH` of the viewport's `viewH` pixels, centred, with the same pixels per radian.
 */
export function viewportFov(videoVfov: number, gateH: number, viewH: number): number {
  const t = Math.tan((videoVfov * DEG) / 2) * (viewH / Math.max(1e-6, gateH));
  return (2 * Math.atan(t)) / DEG;
}

/** The video's field of view that a viewport camera's `viewFov` frames, with the gate `gateH` of `viewH` tall. */
export function videoFovOfView(viewFov: number, gateH: number, viewH: number): number {
  const t = Math.tan((viewFov * DEG) / 2) * (gateH / Math.max(1e-6, viewH));
  return (2 * Math.atan(t)) / DEG;
}

/** Sensor heights (mm), for a focal length in the units the camera's spec sheet gives. */
export const SENSORS: readonly { id: string; label: string; height: number }[] = [
  { id: 'ff', label: 'Full frame (35 mm)', height: 24 },
  { id: 'apsc', label: 'APS-C', height: 15.6 },
  { id: 'm43', label: 'Micro Four Thirds', height: 13 },
  { id: 's35', label: 'Super 35', height: 13.9 },
  { id: 'phone', label: 'Phone (35 mm equivalent)', height: 24 },
];

/** A frame's vertical field of view for a focal length on a sensor `sensorH` mm tall (in the frame's direction). */
export const vfovOfFocal = (mm: number, sensorH: number) => (2 * Math.atan(sensorH / (2 * Math.max(0.1, mm)))) / DEG;
export const focalOfVfov = (vfov: number, sensorH: number) => sensorH / (2 * Math.tan((vfov * DEG) / 2));

/** A camera made safe from storage. Undefined when there is none. */
export function normaliseCamera(raw: unknown): ReferenceCamera | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<ReferenceCamera>;
  const fin = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const t = Array.isArray(c.target) && c.target.length >= 3 && c.target.slice(0, 3).every(v => typeof v === 'number' && Number.isFinite(v))
    ? [c.target[0], c.target[1], c.target[2]] as Vec3 : undefined;
  if (!t) return undefined;
  return {
    target: t, distance: fin(c.distance, 0.05, 10000, 3), pitch: fin(c.pitch, -89.9, 89.9, 10), yaw: fin(c.yaw, -360, 360, 180),
    roll: fin(c.roll, -180, 180, 0), vfov: fin(c.vfov, 1, 170, 50),
  };
}
