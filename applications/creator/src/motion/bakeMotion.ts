// Poses and keys to a clip.
//
// Every frame: find the two keys around the time, blend between their poses (the arriving key's blend curve), with
// each joint sampled a little LATER the further it is from the hips -- overlapping action, so the body
// leads and the extremities follow -- add a seeded drift for life, then pull the hands and feet to their IK
// goals with the engine's analytic two-bone solver. The result is an ordinary glTF-style clip (one rotation
// channel per moving bone, a translation channel for the hips) that the editor and the player already
// play, retarget and edit.
//
// A rotation delta is applied about the bone's OWN axes: local = rest · delta. Pure maths; no engine state.

import { quat, vec3 } from 'gl-matrix';
import { solveTwoBone } from 'cleo/animation/ik';
import { sampleQuat, sampleVec3 } from 'cleo/animation/samplerSample';
import type { Animation } from 'cleo/animation/animatedModel';
import { modelPose, type LocalTRS, type MotionRig } from './motionRig';
import {
  LIMB_CHAINS, LIMB_MIRROR, LIMBS, eulerToQuat, motionDuration, newId, presetBlend, quatToEuler,
  type IkGoal, type Limb, type MotionDoc, type MotionPose, type PoseBone, type Vec3,
} from './motionDoc';
import { evalBlend } from './blendCurve';

/** The clip, in the shape an `.anim` asset stores (`StoredClip`): node-indexed channels, flat samplers. */
export interface BakedClip {
  name: string;
  samplers: { input: number[]; output: number[]; interpolation: 'LINEAR' }[];
  channels: { samplerIndex: number; targetNodeIndex: number; targetPath: 'rotation' | 'translation' }[];
  events?: { time: number; name: string }[];
}

// --- Poses -----------------------------------------------------------------------------------------

/** A bone's local transform for a pose's entry (rest when the pose leaves it alone). */
function boneLocal(rig: MotionRig, i: number, entry: PoseBone | undefined, out: LocalTRS): LocalTRS {
  const b = rig.bones[i];
  vec3.copy(out.t, b.t); vec3.copy(out.s, b.s);
  if (entry?.rot) quat.multiply(out.r, b.r, eulerToQuat(entry.rot)); else quat.copy(out.r, b.r);
  if (entry?.move) vec3.add(out.t, out.t, moveToLocal(rig, entry.move, i));
  return out;
}

/** How many model units one of a bone's local units is (its parents' scale: an Armature's 0.01), or 1. */
function parentScale(rig: MotionRig, bone: number): number {
  const p = rig.bones[bone].parent;
  if (p < 0) return 1;
  const s = vec3.length(vec3.fromValues(rig.restModel.mat[p][0], rig.restModel.mat[p][1], rig.restModel.mat[p][2]));
  return s > 1e-9 && Number.isFinite(s) ? s : 1;
}

/**
 * A bone's model-space offset (`PoseBone.move`: the hips' travel, or a stretched bone), as a change of its
 * local translation. The offset is measured in the parent's REST frame, so it turns with the parent.
 */
export function moveToLocal(rig: MotionRig, move: Vec3, bone = rig.hips): vec3 {
  const p = rig.bones[bone].parent;
  if (p < 0) return vec3.fromValues(move[0], move[1], move[2]);
  const inv = quat.invert(quat.create(), rig.restModel.rot[p]);
  const v = vec3.transformQuat(vec3.create(), move as unknown as vec3, inv);
  // The parent's scale (an Armature's 0.01) divides back out of a model-space length.
  return vec3.scale(v, v, 1 / parentScale(rig, bone));
}

/** The inverse of {@link moveToLocal}: a change of a bone's local translation, as a model-space offset. */
export function localToMove(rig: MotionRig, local: vec3, bone = rig.hips): Vec3 {
  const p = rig.bones[bone].parent;
  const v = vec3.scale(vec3.create(), local, parentScale(rig, bone));
  if (p >= 0) vec3.transformQuat(v, v, rig.restModel.rot[p]);
  const r = (x: number) => Math.round(x * 1e5) / 1e5;
  return [r(v[0]), r(v[1]), r(v[2])];
}

const freshLocals = (rig: MotionRig): LocalTRS[] => rig.bones.map(b => ({ t: vec3.clone(b.t), r: quat.clone(b.r), s: vec3.clone(b.s) }));

/** A pose's local transforms (IK goals not applied). */
export function poseLocals(rig: MotionRig, pose: MotionPose): LocalTRS[] {
  const out = freshLocals(rig);
  rig.bones.forEach((b, i) => boneLocal(rig, i, pose.bones[b.name], out[i]));
  return out;
}

/** A pose with its IK goals solved: what the viewport shows for it. */
export function solvedPoseLocals(rig: MotionRig, pose: MotionPose): LocalTRS[] {
  const local = poseLocals(rig, pose);
  for (const limb of LIMBS) {
    const goal = pose.ik?.[limb];
    if (goal) solveLimb(rig, local, limb, goal.pos as unknown as vec3, 1);
  }
  return local;
}

/** Where a limb's tip is in a pose, in model space (to plant an IK goal where the limb already is). */
export function limbTip(rig: MotionRig, pose: MotionPose, limb: Limb): Vec3 | null {
  const tip = rig.bySlot.get(LIMB_CHAINS[limb][2]);
  if (tip === undefined) return null;
  const p = modelPose(rig.bones, solvedPoseLocals(rig, pose)).pos[tip];
  return [p[0], p[1], p[2]];
}

/** Reflect a model-space rotation across the plane the mirror axis is normal to. */
function reflect(q: quat, axis: 0 | 1 | 2): quat {
  const out = quat.clone(q);
  for (let a = 0; a < 3; a++) if (a !== axis) out[a] = -out[a];
  return out;
}

/**
 * The pose mirrored left to right: each bone takes its partner's model-space rotation, reflected across
 * the body's centre plane and corrected for the two sides' rest orientations (which are reflections of
 * each other only up to the exporter's bone rolls). Offsets (hips travel, stretches) and IK goals reflect with it.
 */
export function mirrorPose(rig: MotionRig, pose: MotionPose, name = `${pose.name} (mirrored)`): MotionPose {
  const a = rig.mirrorAxis;
  const model = modelPose(rig.bones, poseLocals(rig, pose));
  const newModel: quat[] = [];
  const bones: Record<string, PoseBone> = {};
  rig.bones.forEach((b, j) => {
    const i = rig.mirror[j];
    // desired_j = M(posed_i) · M(rest_i)^-1 · rest_j
    const desired = quat.multiply(quat.create(), reflect(model.rot[i], a), quat.invert(quat.create(), reflect(rig.restModel.rot[i], a)));
    quat.multiply(desired, desired, rig.restModel.rot[j]);
    quat.normalize(desired, desired);
    newModel.push(desired);
    if (!b.joint || j === rig.hips && b.parent < 0) return;
    const parent = b.parent >= 0 ? newModel[b.parent] : quat.create();
    const local = quat.multiply(quat.create(), quat.invert(quat.create(), parent), desired);
    const delta = quat.multiply(quat.create(), quat.invert(quat.create(), b.r), local);
    if (Math.abs(delta[3]) > 0.99999) return;
    bones[b.name] = { rot: quatToEuler(delta) };
  });
  // Offsets (the hips' travel, stretched bones) go to the partner, reflected.
  rig.bones.forEach((b, j) => {
    const move = pose.bones[rig.bones[rig.mirror[j]].name]?.move;
    if (!move) return;
    const m: Vec3 = [...move];
    m[a] = -m[a];
    bones[b.name] = { ...(bones[b.name] ?? {}), move: m };
  });
  let ik: MotionPose['ik'];
  if (pose.ik) {
    ik = {};
    const centre = rig.hips >= 0 ? rig.restModel.pos[rig.hips][a] : 0;
    for (const limb of LIMBS) {
      const g = pose.ik[limb];
      if (!g) continue;
      const pos: Vec3 = [...g.pos];
      pos[a] = 2 * centre - pos[a];
      ik[LIMB_MIRROR[limb]] = { pos };
    }
  }
  return { id: newId(), name, bones, ...(ik && Object.keys(ik).length ? { ik } : {}) };
}

// --- IK --------------------------------------------------------------------------------------------

/** Bend a limb so its tip reaches `target` (model space), blended in by `weight`. Keeps the tip's model orientation. */
function solveLimb(rig: MotionRig, local: LocalTRS[], limb: Limb, target: vec3, weight: number): void {
  if (weight <= 1e-4) return;
  const [rs, ms, ts] = LIMB_CHAINS[limb];
  const r = rig.bySlot.get(rs), m = rig.bySlot.get(ms), t = rig.bySlot.get(ts);
  if (r === undefined || m === undefined || t === undefined) return;
  const model = modelPose(rig.bones, local);
  const res = solveTwoBone({ root: model.pos[r], mid: model.pos[m], tip: model.pos[t], target });
  const newRoot = quat.multiply(quat.create(), res.rootDelta, model.rot[r]);
  const newMid = quat.multiply(quat.create(), quat.multiply(quat.create(), res.midDelta, res.rootDelta), model.rot[m]);
  const parentRot = rig.bones[r].parent >= 0 ? model.rot[rig.bones[r].parent] : quat.create();
  const inv = (q: quat) => quat.invert(quat.create(), q);
  const rootLocal = quat.multiply(quat.create(), inv(parentRot), newRoot);
  // The mid joint's parent may not be the root joint (a twist bone between): go through its own parent.
  const midParentModel = rig.bones[m].parent === r ? newRoot : model.rot[rig.bones[m].parent];
  const midLocal = quat.multiply(quat.create(), inv(midParentModel), newMid);
  const tipParentModel = rig.bones[t].parent === m ? newMid : model.rot[rig.bones[t].parent];
  const tipLocal = quat.multiply(quat.create(), inv(tipParentModel), model.rot[t]);
  const blend = (i: number, q: quat) => quat.normalize(local[i].r, quat.slerp(local[i].r, local[i].r, q, Math.min(1, weight)));
  blend(r, rootLocal); blend(m, midLocal); blend(t, tipLocal);
}

// --- Life ------------------------------------------------------------------------------------------

/** A smooth seeded 1D noise in -1..1. */
function noise1(seed: number, x: number): number {
  const h = (n: number) => {
    let v = Math.imul(n ^ seed, 0x27d4eb2d);
    v ^= v >>> 15; v = Math.imul(v, 0x85ebca6b); v ^= v >>> 13;
    return ((v >>> 0) / 0xffffffff) * 2 - 1;
  };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

/** How much of the variation each body part takes. */
const LIFE_WEIGHT: Record<string, number> = {
  spine: 0.5, chest: 0.5, neck: 0.7, head: 1, shoulder: 0.4, upperArm: 0.8, foreArm: 0.6, hand: 0.5,
};
const lifeWeight = (slot: string | null) => (slot ? LIFE_WEIGHT[slot.replace(/\.[LR]$/, '')] ?? 0 : 0);

// --- Bake ------------------------------------------------------------------------------------------

/** The motion as a clip: `doc.fps` frames per second over its keys, plus the settle of the overlap. */
export function bakeMotion(rig: MotionRig, doc: MotionDoc, name = doc.name): BakedClip {
  const keys = doc.keys;
  const poses = new Map(doc.poses.map(p => [p.id, p]));
  const duration = motionDuration(doc);
  const maxDepth = Math.max(0, ...rig.bones.map(b => b.depth));
  // A one-shot keeps playing until the last joint has arrived; a loop wraps instead.
  const length = doc.loop ? duration : duration + doc.overlap * maxDepth;
  const frames = Math.max(2, Math.round(length * doc.fps) + 1);
  const times = Array.from({ length: frames }, (_, f) => Math.min(length, f / doc.fps));
  if (times[frames - 1] < length) times.push(length);

  // Each key's pose as local rotations, once.
  const keyLocals = keys.map(k => poseLocals(rig, poses.get(k.poseId)!));
  const keyIk = keys.map(k => poses.get(k.poseId)!.ik ?? {});

  // Bones that move: posed in some key, on an IK chain, carrying variation, or the hips.
  const moving = new Set<number>();
  for (const p of doc.poses) for (const n of Object.keys(p.bones)) { const i = rig.byName.get(n); if (i !== undefined) moving.add(i); }
  for (const limb of LIMBS) if (doc.poses.some(p => p.ik?.[limb])) for (const s of LIMB_CHAINS[limb]) { const i = rig.bySlot.get(s); if (i !== undefined) moving.add(i); }
  if (doc.variation > 0) rig.bones.forEach((b, i) => { if (lifeWeight(b.slot) > 0) moving.add(i); });
  // Bones some pose offsets (the hips' travel, a stretched bone) also get a translation channel.
  const translated = new Set<number>();
  for (const p of doc.poses) for (const [n, e] of Object.entries(p.bones)) { const i = rig.byName.get(n); if (i !== undefined && e.move) { translated.add(i); moving.add(i); } }
  // A motion that only holds the rest pose still drives the hips: a clip with no channels is not a clip.
  if (!moving.size && rig.hips >= 0) moving.add(rig.hips);

  /** The segment and eased share at time `t` on the key timeline. */
  const at = (t: number): { a: number; b: number; w: number } => {
    if (keys.length === 1 || t <= keys[0].time) return { a: 0, b: 0, w: 0 };
    for (let k = 1; k < keys.length; k++) {
      if (t <= keys[k].time) {
        const span = keys[k].time - keys[k - 1].time;
        return { a: k - 1, b: k, w: span > 1e-9 ? evalBlend(keys[k].blend, (t - keys[k - 1].time) / span) : 1 };
      }
    }
    return { a: keys.length - 1, b: keys.length - 1, w: 0 };
  };
  const wrap = (t: number) => (doc.loop && duration > 0 ? ((t % duration) + duration) % duration : Math.max(0, Math.min(duration, t)));

  const rotOut = new Map<number, number[]>(), posOut = new Map<number, number[]>();
  for (const i of moving) rotOut.set(i, []);
  for (const i of translated) posOut.set(i, []);
  const local = freshLocals(rig);
  const tmp = quat.create();
  for (const t of times) {
    // Every bone at its own delayed time.
    for (let i = 0; i < rig.bones.length; i++) {
      const b = rig.bones[i];
      vec3.copy(local[i].t, b.t); vec3.copy(local[i].s, b.s); quat.copy(local[i].r, b.r);
      if (!moving.has(i) && i !== rig.hips) continue;
      const s = at(wrap(t - doc.overlap * b.depth));
      quat.slerp(local[i].r, keyLocals[s.a][i].r, keyLocals[s.b][i].r, s.w);
      if (translated.has(i)) vec3.lerp(local[i].t, keyLocals[s.a][i].t, keyLocals[s.b][i].t, s.w);
      const life = doc.variation * lifeWeight(b.slot);
      if (life > 0) {
        const x = t * doc.variationRate;
        const e: Vec3 = [noise1(doc.seed + i * 3, x) * life, noise1(doc.seed + i * 3 + 1, x + 17) * life, noise1(doc.seed + i * 3 + 2, x + 31) * life];
        quat.multiply(local[i].r, local[i].r, eulerToQuat(e, tmp));
      }
    }
    // IK goals, eased between the keys' goals at the limb root's time. A goal only one side has fades in or out.
    for (const limb of LIMBS) {
      const root = rig.bySlot.get(LIMB_CHAINS[limb][0]);
      if (root === undefined || !doc.poses.some(p => p.ik?.[limb])) continue;
      const s = at(wrap(t - doc.overlap * rig.bones[root].depth));
      const ga: IkGoal | undefined = keyIk[s.a][limb], gb: IkGoal | undefined = keyIk[s.b][limb];
      if (!ga && !gb) continue;
      const pa = (ga ?? gb)!.pos, pb = (gb ?? ga)!.pos;
      const target = vec3.lerp(vec3.create(), pa as unknown as vec3, pb as unknown as vec3, s.w);
      const weight = (ga ? 1 - s.w : 0) + (gb ? s.w : 0);
      solveLimb(rig, local, limb, target, Math.min(1, Math.max(0, ga && gb ? 1 : weight)));
    }
    for (const [i, out] of rotOut) { const r = quat.normalize(tmp, local[i].r); out.push(r[0], r[1], r[2], r[3]); }
    for (const [i, out] of posOut) { const p = local[i].t; out.push(p[0], p[1], p[2]); }
  }

  const clip: BakedClip = { name, samplers: [], channels: [] };
  for (const [i, output] of rotOut) {
    clip.channels.push({ samplerIndex: clip.samplers.length, targetNodeIndex: rig.bones[i].node, targetPath: 'rotation' });
    clip.samplers.push({ input: times, output, interpolation: 'LINEAR' });
  }
  for (const [i, output] of posOut) {
    clip.channels.push({ samplerIndex: clip.samplers.length, targetNodeIndex: rig.bones[i].node, targetPath: 'translation' });
    clip.samplers.push({ input: times, output, interpolation: 'LINEAR' });
  }
  const events = keys.filter(k => k.event).map(k => ({ time: k.time, name: k.event! }));
  if (events.length) clip.events = events;
  return clip;
}

/** One pose held still, as a clip: what the viewport plays while a pose is being edited. */
export function bakePose(rig: MotionRig, pose: MotionPose): BakedClip {
  return bakeMotion(rig, {
    name: 'pose', seed: 0, poses: [pose],
    keys: [{ id: 'a', poseId: pose.id, time: 0, ...presetBlend('linear') }, { id: 'b', poseId: pose.id, time: 0.1, ...presetBlend('linear') }],
    fps: 10, overlap: 0, variation: 0, variationRate: 1, loop: false,
  }, 'pose');
}

// --- Poses from clips, and poses for the editor -------------------------------------------------------

/**
 * The pose a clip holds at `t` seconds, as an editable pose: each animated joint's rotation as a turn from
 * rest (Euler degrees about its own axes), and the hips' travel as a model-space offset. Bones the clip
 * leaves at rest are left out. What "Pose from frame" makes from an imported clip.
 */
export function poseFromClip(rig: MotionRig, clip: Pick<Animation, 'samplers' | 'channels'>, t: number, name = 'Pose'): MotionPose {
  const bones: Record<string, PoseBone> = {};
  const byNode = new Map(rig.bones.map((b, i) => [b.node, i]));
  for (const ch of clip.channels) {
    const i = byNode.get(ch.targetNodeIndex);
    const sampler = clip.samplers[ch.samplerIndex];
    if (i === undefined || !sampler || !rig.bones[i].joint) continue;
    const b = rig.bones[i];
    if (ch.targetPath === 'rotation') {
      const local = sampleQuat(sampler, t);
      const delta = quat.multiply(quat.create(), quat.invert(quat.create(), b.r), local);
      quat.normalize(delta, delta);
      if (Math.abs(delta[3]) > 0.99999) continue;
      bones[b.name] = { ...(bones[b.name] ?? {}), rot: quatToEuler(delta) };
    } else if (ch.targetPath === 'translation') {
      const local = vec3.sub(vec3.create(), sampleVec3(sampler, t), b.t);
      const move = localToMove(rig, local, i);
      if (move.every(v => Math.abs(v) < 1e-4)) continue;
      bones[b.name] = { ...(bones[b.name] ?? {}), move };
    }
  }
  return { id: newId(), name, bones };
}

/** A pose bone in the editor's Pose asset convention (`StoredPoseBone`). */
export interface EditorPoseBone { name: string; rotation?: number[]; translation?: number[] }

/**
 * A pose in the editor's convention: the editor applies a rotation as `delta × rest` (a turn in the
 * parent's space) and adds a translation to the rest one, where these poses turn about the bone's own
 * axes (`rest · delta`). So the turn is re-expressed: `delta = (rest · own) · rest⁻¹`.
 */
export function editorPoseBones(rig: MotionRig, pose: MotionPose): EditorPoseBone[] {
  const out: EditorPoseBone[] = [];
  for (const [name, entry] of Object.entries(pose.bones)) {
    const i = rig.byName.get(name);
    if (i === undefined) continue;
    const b = rig.bones[i];
    const bone: EditorPoseBone = { name };
    if (entry.rot) {
      const local = quat.multiply(quat.create(), b.r, eulerToQuat(entry.rot));
      const delta = quat.multiply(quat.create(), local, quat.invert(quat.create(), b.r));
      quat.normalize(delta, delta);
      bone.rotation = [delta[0], delta[1], delta[2], delta[3]];
    }
    if (entry.move) { const l = moveToLocal(rig, entry.move, i); bone.translation = [l[0], l[1], l[2]]; }
    if (bone.rotation || bone.translation) out.push(bone);
  }
  return out;
}
