// The Motion Creator's document: a few key POSES and a timeline of keys that visit them, with the
// parameters that turn them into a clip (Rosen's "few key poses, code does the rest", GDC 2014).
//
// A pose stores, per bone, a rotation DELTA from rest (Euler degrees, the order the sliders edit) and, for
// the hips, an offset in model units; plus optional IK goals for the hands and feet -- where the limb's tip
// should be, in model space -- so a foot can be planted and stay planted while the body moves over it.

import { quat } from 'gl-matrix';
import { builtinPreset, cloneCurve, DEFAULT_BLEND_PRESET, normaliseCurve, type BlendCurve } from './blendCurve';

export type Limb = 'footL' | 'footR' | 'handL' | 'handR';
export const LIMBS: Limb[] = ['footL', 'footR', 'handL', 'handR'];
export const LIMB_LABELS: Record<Limb, string> = { footL: 'Left foot', footR: 'Right foot', handL: 'Left hand', handR: 'Right hand' };
/** The humanoid slots of each limb's chain: root, mid, tip. */
export const LIMB_CHAINS: Record<Limb, [string, string, string]> = {
  footL: ['upLeg.L', 'leg.L', 'foot.L'], footR: ['upLeg.R', 'leg.R', 'foot.R'],
  handL: ['upperArm.L', 'foreArm.L', 'hand.L'], handR: ['upperArm.R', 'foreArm.R', 'hand.R'],
};
export const LIMB_MIRROR: Record<Limb, Limb> = { footL: 'footR', footR: 'footL', handL: 'handR', handR: 'handL' };

export type Vec3 = [number, number, number];

export interface PoseBone {
  /** Rotation from rest, Euler degrees (X, then Y, then Z, about the bone's own axes). */
  rot?: Vec3;
  /**
   * Offset from rest, in model units (measured in the parent's rest frame): the hips' travel, or a bone
   * stretched by dragging its joint with Keep lengths off.
   */
  move?: Vec3;
}

export interface IkGoal {
  /** Where the limb's tip goes, in model space. */
  pos: Vec3;
}

export interface MotionPose {
  id: string;
  name: string;
  /** By bone name. Absent bones stay at rest. */
  bones: Record<string, PoseBone>;
  ik?: Partial<Record<Limb, IkGoal>>;
}

export interface MotionKey {
  id: string;
  poseId: string;
  /** Seconds. */
  time: number;
  /** How the motion arrives at this key from the previous one (blendCurve.ts). Unused on the first key. */
  blend: BlendCurve;
  /** The preset the blend was picked from, while it still matches it (a label only). */
  presetId?: string;
  /** A clip event fired when the clip reaches this key (`onAnimationEvent`), e.g. `hit`. */
  event?: string;
}

export interface MotionDoc {
  name: string;
  seed: number;
  poses: MotionPose[];
  keys: MotionKey[];
  /** Bake rate, frames per second. */
  fps: number;
  /**
   * Overlapping action: each joint further from the hips trails by this many seconds per joint, so the
   * spine leads, the head and the hands follow.
   */
  overlap: number;
  /** Subtle life: seeded noise on the spine, neck, head and arms, in degrees. 0 = exact poses. */
  variation: number;
  /** How fast the variation drifts, in cycles per second. */
  variationRate: number;
  /** Bake the clip to loop (the last key should return to the first pose). */
  loop: boolean;
  /** The Character (Creator library id) this motion animates; absent: the mannequin. */
  characterId?: string;
}

export const newId = () => Math.random().toString(36).slice(2, 10);

/** A key's blend from a preset (built-in id), defaulting to ease in-out. */
export function presetBlend(id: string = DEFAULT_BLEND_PRESET): Pick<MotionKey, 'blend' | 'presetId'> {
  const p = builtinPreset(id) ?? builtinPreset(DEFAULT_BLEND_PRESET)!;
  return { blend: cloneCurve(p.curve), presetId: p.id };
}

export function restPose(name = 'Rest'): MotionPose {
  return { id: newId(), name, bones: {} };
}

export const DEFAULT_MOTION: MotionDoc = (() => {
  const rest = restPose('Rest');
  return {
    name: 'motion', seed: 1, poses: [rest],
    keys: [{ id: newId(), poseId: rest.id, time: 0, ...presetBlend() }, { id: newId(), poseId: rest.id, time: 1, ...presetBlend() }],
    fps: 30, overlap: 0.02, variation: 0, variationRate: 0.6, loop: false,
  };
})();

const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const vec = (v: unknown): Vec3 | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(x => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : undefined;

/** A stored or edited document made safe: fields defaulted, numbers clamped, keys sorted, dangling keys dropped. */
export function normaliseMotion(raw: Partial<MotionDoc> | null | undefined): MotionDoc {
  const d = raw ?? {};
  const poses: MotionPose[] = (Array.isArray(d.poses) ? d.poses : []).filter(p => p && typeof p.id === 'string').map(p => {
    const bones: Record<string, PoseBone> = {};
    for (const [name, b] of Object.entries(p.bones ?? {})) {
      const rot = vec(b?.rot), move = vec(b?.move);
      if (rot || move) bones[name] = { ...(rot ? { rot } : {}), ...(move ? { move } : {}) };
    }
    const ik: Partial<Record<Limb, IkGoal>> = {};
    for (const limb of LIMBS) { const pos = vec(p.ik?.[limb]?.pos); if (pos) ik[limb] = { pos }; }
    return { id: p.id, name: typeof p.name === 'string' && p.name ? p.name : 'Pose', bones, ...(Object.keys(ik).length ? { ik } : {}) };
  });
  if (!poses.length) poses.push(restPose());
  const ids = new Set(poses.map(p => p.id));
  const keys: MotionKey[] = (Array.isArray(d.keys) ? d.keys : [])
    .filter(k => k && ids.has(k.poseId))
    .map(k => {
      // A stored curve, else the preset a phase-1 document named as its `ease`.
      const blend = normaliseCurve(k.blend);
      const legacy = (k as { ease?: unknown }).ease;
      const picked = blend ? { blend, ...(typeof k.presetId === 'string' ? { presetId: k.presetId } : {}) }
        : presetBlend(typeof legacy === 'string' ? legacy : undefined);
      return {
        id: typeof k.id === 'string' ? k.id : newId(), poseId: k.poseId, time: num(k.time, 0, 600, 0),
        ...picked, ...(k.event ? { event: String(k.event) } : {}),
      };
    })
    .sort((a, b) => a.time - b.time);
  if (!keys.length) keys.push({ id: newId(), poseId: poses[0].id, time: 0, ...presetBlend() });
  return {
    name: typeof d.name === 'string' && d.name.trim() ? d.name : 'motion',
    seed: Math.floor(num(d.seed, 0, 0x7fffffff, 1)),
    poses, keys,
    fps: Math.round(num(d.fps, 10, 120, 30)),
    overlap: num(d.overlap, 0, 0.2, 0.02),
    variation: num(d.variation, 0, 20, 0),
    variationRate: num(d.variationRate, 0.05, 5, 0.6),
    loop: !!d.loop,
    ...(typeof d.characterId === 'string' && d.characterId ? { characterId: d.characterId } : {}),
  };
}

/** The clip's length: the last key's time. */
export function motionDuration(doc: MotionDoc): number {
  return doc.keys.length ? doc.keys[doc.keys.length - 1].time : 0;
}

// --- Euler <-> quaternion --------------------------------------------------------------------------

const DEG = Math.PI / 180;

/** Euler degrees (applied X, then Y, then Z) to a quaternion: q = qz · qy · qx. */
export function eulerToQuat(e: Vec3, out = quat.create()): quat {
  const qx = quat.setAxisAngle(quat.create(), [1, 0, 0], e[0] * DEG);
  const qy = quat.setAxisAngle(quat.create(), [0, 1, 0], e[1] * DEG);
  const qz = quat.setAxisAngle(quat.create(), [0, 0, 1], e[2] * DEG);
  quat.multiply(out, qz, qy);
  return quat.multiply(out, out, qx);
}

/** The inverse of {@link eulerToQuat}, in degrees. */
export function quatToEuler(q: quat): Vec3 {
  const [x, y, z, w] = q;
  const sx = 2 * (w * x + y * z), cx = 1 - 2 * (x * x + y * y);
  const sy = Math.min(1, Math.max(-1, 2 * (w * y - z * x)));
  const sz = 2 * (w * z + x * y), cz = 1 - 2 * (y * y + z * z);
  const r = (v: number) => Math.round(v / DEG * 1000) / 1000;
  return [r(Math.atan2(sx, cx)), r(Math.asin(sy)), r(Math.atan2(sz, cz))];
}
