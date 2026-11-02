// The Motion Creator's document: a few key POSES and a timeline of keys that visit them, with the
// parameters that turn them into a clip (Rosen's "few key poses, code does the rest", GDC 2014).
//
// A pose stores, per bone, a rotation DELTA from rest (Euler degrees, the order the sliders edit) and, for
// the hips, an offset in model units; plus optional IK goals for the hands and feet -- where the limb's tip
// should be, in model space -- so a foot can be planted and stay planted while the body moves over it.
//
// PARTS group the bones (body, arms, legs: parts.ts) so each can arrive at a key its own way: the legs
// linear while the arms spring, an arm a little behind the body. A part's `defaults` hold for every key; a
// key's `parts` entry overrides them for the blend into that key. A bone in no part follows the key's blend.

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
  /**
   * The tip's model-space rotation, Euler degrees (X, then Y, then Z): a hand that holds a blade at an
   * angle however the elbow bends, a foot planted flat. Absent: the tip keeps the turn the arm gives it.
   */
  rot?: Vec3;
  /**
   * Where the middle joint points, model space: a point the elbow (or knee) bends toward -- elbows out for
   * a wide guard. Absent: the limb keeps the bend it already has.
   */
  pole?: Vec3;
  /**
   * Hold on to another limb's tip: a two-handed grip. Each frame this tip goes where `offset` (in the lead
   * tip's own frame, model units) puts it, turned by `rot` from the lead tip -- so the hands stay on the
   * hilt between keys, wherever the lead hand goes. `pos` and `rot` above are then only the fallback.
   */
  grip?: IkGrip;
}

export interface IkGrip {
  follow: Limb;
  offset: Vec3;
  rot: Vec3;
}

export interface MotionPose {
  id: string;
  name: string;
  /** By bone name. Absent bones stay at rest. */
  bones: Record<string, PoseBone>;
  ik?: Partial<Record<Limb, IkGoal>>;
  /**
   * The library Pose asset (poseAsset.ts) this pose is: `name`, `bones` and `ik` are then a cached copy of
   * it, kept in step whenever the library changes. Absent: the pose is the motion's own.
   */
  assetId?: string;
}

/** How a part arrives at a key. Every field is optional; an absent one is inherited (parts.ts `resolvePartBlend`). */
export interface PartBlend {
  /** The curve into the key; absent: the key's own blend. */
  blend?: BlendCurve;
  /** The preset the curve was picked from, while it still matches it (a label only). */
  presetId?: string;
  /** Seconds the part arrives late (+) or early (−) against the key. */
  offset?: number;
  /** Seconds per joint the part's bones trail by; absent: the motion's overlap. */
  overlap?: number;
  /** How much of the motion's variation the part takes (1: all of it). */
  variation?: number;
}

/** A named group of bones that blends its own way. */
export interface MotionPart {
  id: string;
  name: string;
  /** CSS colour of its lane on the timeline. */
  color: string;
  /** Bone names. A bone belongs to one part at most: the first that lists it. */
  bones: string[];
  /** How the part arrives at every key, unless a key overrides it. */
  defaults?: PartBlend;
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
  /** Per part (by id): how that part arrives at this key, instead of its defaults. */
  parts?: Record<string, PartBlend>;
}

export interface MotionDoc {
  name: string;
  seed: number;
  poses: MotionPose[];
  keys: MotionKey[];
  /** Body-part groups, each blending its own way (parts.ts). Empty: every bone follows the keys' blends. */
  parts: MotionPart[];
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
    parts: [],
    fps: 30, overlap: 0.02, variation: 0, variationRate: 0.6, loop: false,
  };
})();

const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const vec = (v: unknown): Vec3 | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(x => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : undefined;

/** One stored pose made safe: bad numbers dropped, a grip on a limb that itself grips let go. */
export function normalisePose(p: Partial<MotionPose> & { id: string }): MotionPose {
  const bones: Record<string, PoseBone> = {};
  for (const [name, b] of Object.entries(p.bones ?? {})) {
    const rot = vec(b?.rot), move = vec(b?.move);
    if (rot || move) bones[name] = { ...(rot ? { rot } : {}), ...(move ? { move } : {}) };
  }
  const ik: Partial<Record<Limb, IkGoal>> = {};
  for (const limb of LIMBS) {
    const g = p.ik?.[limb];
    const pos = vec(g?.pos);
    if (!pos) continue;
    const rot = vec(g?.rot), pole = vec(g?.pole), off = vec(g?.grip?.offset), grot = vec(g?.grip?.rot);
    const follow = g?.grip?.follow;
    const grip = follow && follow !== limb && LIMBS.includes(follow) && off && grot ? { follow, offset: off, rot: grot } : undefined;
    ik[limb] = { pos, ...(rot ? { rot } : {}), ...(pole ? { pole } : {}), ...(grip ? { grip } : {}) };
  }
  // A grip on a limb that itself follows another would chase its own tail: only one level is kept.
  for (const limb of LIMBS) { const f = ik[limb]?.grip?.follow; if (f && ik[f]?.grip) delete ik[limb]!.grip; }
  return {
    id: p.id, name: typeof p.name === 'string' && p.name ? p.name : 'Pose', bones, ...(Object.keys(ik).length ? { ik } : {}),
    ...(typeof p.assetId === 'string' && p.assetId ? { assetId: p.assetId } : {}),
  };
}

/** A part blend made safe: a valid curve, numbers clamped. Undefined when nothing is left. */
export function normalisePartBlend(raw: unknown): PartBlend | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as PartBlend;
  const blend = normaliseCurve(r.blend);
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const out: PartBlend = {
    ...(blend ? { blend, ...(typeof r.presetId === 'string' ? { presetId: r.presetId } : {}) } : {}),
    ...(finite(r.offset) ? { offset: num(r.offset, -2, 2, 0) } : {}),
    ...(finite(r.overlap) ? { overlap: num(r.overlap, 0, 0.2, 0) } : {}),
    ...(finite(r.variation) ? { variation: num(r.variation, 0, 3, 1) } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** The lane colours new parts take, in turn. */
export const PART_COLORS = ['#e0b354', '#5fa8e8', '#e8746a', '#6cc47a', '#b38be0', '#e08bc4', '#5fc7c0', '#c7a26a'];

/** Stored parts made safe: ids unique, every bone in one part only (the first that lists it). */
function normaliseParts(raw: unknown): MotionPart[] {
  const taken = new Set<string>(), ids = new Set<string>();
  return (Array.isArray(raw) ? raw : []).filter(p => p && typeof p === 'object').map((p: Partial<MotionPart>, i): MotionPart => {
    let id = typeof p.id === 'string' && p.id ? p.id : newId();
    while (ids.has(id)) id = newId();
    ids.add(id);
    const bones = (Array.isArray(p.bones) ? p.bones : []).filter((b): b is string => typeof b === 'string' && !taken.has(b) && (taken.add(b), true));
    const defaults = normalisePartBlend(p.defaults);
    return {
      id, name: typeof p.name === 'string' && p.name.trim() ? p.name : `Part ${i + 1}`,
      color: typeof p.color === 'string' && p.color ? p.color : PART_COLORS[i % PART_COLORS.length],
      bones, ...(defaults ? { defaults } : {}),
    };
  });
}

/** A stored or edited document made safe: fields defaulted, numbers clamped, keys sorted, dangling keys dropped. */
export function normaliseMotion(raw: Partial<MotionDoc> | null | undefined): MotionDoc {
  const d = raw ?? {};
  const poses: MotionPose[] = (Array.isArray(d.poses) ? d.poses : []).filter(p => p && typeof p.id === 'string').map(normalisePose);
  if (!poses.length) poses.push(restPose());
  const ids = new Set(poses.map(p => p.id));
  const parts = normaliseParts(d.parts);
  const partIds = new Set(parts.map(p => p.id));
  const keys: MotionKey[] = (Array.isArray(d.keys) ? d.keys : [])
    .filter(k => k && ids.has(k.poseId))
    .map(k => {
      // A stored curve, else the preset a phase-1 document named as its `ease`.
      const blend = normaliseCurve(k.blend);
      const legacy = (k as { ease?: unknown }).ease;
      const picked = blend ? { blend, ...(typeof k.presetId === 'string' ? { presetId: k.presetId } : {}) }
        : presetBlend(typeof legacy === 'string' ? legacy : undefined);
      // Overrides of parts that still exist. A stored `event` is dropped: clip events are set on the clip,
      // in the editor, not here.
      const over: Record<string, PartBlend> = {};
      for (const [id, pb] of Object.entries(k.parts ?? {})) {
        const n = partIds.has(id) ? normalisePartBlend(pb) : undefined;
        if (n) over[id] = n;
      }
      return {
        id: typeof k.id === 'string' ? k.id : newId(), poseId: k.poseId, time: num(k.time, 0, 600, 0),
        ...picked, ...(Object.keys(over).length ? { parts: over } : {}),
      };
    })
    .sort((a, b) => a.time - b.time);
  if (!keys.length) keys.push({ id: newId(), poseId: poses[0].id, time: 0, ...presetBlend() });
  return {
    name: typeof d.name === 'string' && d.name.trim() ? d.name : 'motion',
    seed: Math.floor(num(d.seed, 0, 0x7fffffff, 1)),
    poses, keys, parts,
    fps: Math.round(num(d.fps, 10, 120, 30)),
    overlap: num(d.overlap, 0, 0.2, 0.02),
    variation: num(d.variation, 0, 20, 0),
    variationRate: num(d.variationRate, 0.05, 5, 0.6),
    loop: !!d.loop,
    ...(typeof d.characterId === 'string' && d.characterId ? { characterId: d.characterId } : {}),
  };
}

/**
 * A motion read from a file: a `.motion.json` sidecar (the Creator's own export, which carries the
 * document) or a bare document. Null when it is neither.
 */
export function motionFromFile(json: unknown): MotionDoc | null {
  const j = json as { generator?: string; params?: unknown } | null;
  const raw = j && typeof j === 'object' ? (j.generator === 'motion' && j.params ? j.params : j) : null;
  if (!raw || !Array.isArray((raw as { poses?: unknown }).poses)) return null;
  return normaliseMotion(raw as Partial<MotionDoc>);
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
