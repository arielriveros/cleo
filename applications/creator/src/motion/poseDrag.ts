// Posing by hand in the viewport: drag a joint and the limb above it follows (FABRIK, bone lengths kept),
// or -- with Keep lengths off -- the joint goes exactly where it is dragged and the bone above stretches;
// turn a bone with the rotate rings. Pure maths on the rig and the pose document: what is written back is
// what the sliders edit (Euler turns from rest, `move` offsets, IK goals), so nothing here is lossy.
//
// Everything is in the character's MODEL space (the space `modelPose` and the IK goals use); the stage
// converts to and from the scene, where a centimetre model is shown at a hundredth.

import { quat, vec3 } from 'gl-matrix';
import { localToMove, solvedPoseLocals } from './bakeMotion';
import { LIMB_CHAINS, LIMBS, eulerToQuat, quatToEuler, type MotionPose, type PoseBone, type Vec3 } from './motionDoc';
import { modelPose, type MotionRig } from './motionRig';

export interface DragOptions {
  /** Bones above the dragged joint that bend to follow it; 0 or less: the joint's default. */
  chain: number;
  /** Bend the chain, lengths kept (true), or put the joint exactly on the target and stretch (false). */
  keepLengths: boolean;
}

/**
 * Forward-And-Backward Reaching IK: `points` from the chain's root to its tip, `lengths[i]` the distance
 * from point i to i+1. The root stays put; a target out of reach straightens the chain toward it.
 */
export function fabrik(points: readonly vec3[], lengths: readonly number[], target: vec3, iterations = 12, tolerance = 1e-5): vec3[] {
  const p = points.map(v => vec3.clone(v));
  const n = p.length;
  if (n < 2) return p;
  const root = vec3.clone(p[0]);
  const reach = lengths.reduce((a, b) => a + b, 0);
  const place = (from: vec3, toward: vec3, len: number, out: vec3) => {
    const d = vec3.sub(vec3.create(), toward, from);
    const l = vec3.length(d);
    if (l < 1e-12) return;
    vec3.scaleAndAdd(out, from, d, len / l);
  };
  if (vec3.distance(root, target) >= reach) {
    // Out of reach: every bone points at the target.
    for (let i = 0; i < n - 1; i++) place(p[i], target, lengths[i], p[i + 1]);
    return p;
  }
  for (let it = 0; it < iterations; it++) {
    // Backward: the tip on the target, each joint pulled after it.
    vec3.copy(p[n - 1], target);
    for (let i = n - 2; i >= 0; i--) place(p[i + 1], p[i], lengths[i], p[i]);
    // Forward: the root back home, each joint pulled after it.
    vec3.copy(p[0], root);
    for (let i = 0; i < n - 1; i++) place(p[i], p[i + 1], lengths[i], p[i + 1]);
    if (vec3.distance(p[n - 1], target) < tolerance) break;
  }
  return p;
}

/** How many bones above a joint bend when it is dragged, by default: two for a hand, a foot or the head. */
export function defaultChain(rig: MotionRig, joint: number): number {
  const slot = rig.bones[joint].slot?.replace(/\.[LR]$/, '');
  return slot === 'hand' || slot === 'foot' || slot === 'head' || slot === 'toe' ? 2 : 1;
}

/**
 * The chain a drag bends: joints from the topmost that turns down to the dragged one. Links of no length
 * (twist and helper bones sitting on their parent) are passed over, so `bones` counts bones you can see;
 * it never climbs to the hips or above (turning those moves the whole body -- drag the hips for that).
 */
export function chainOf(rig: MotionRig, joint: number, bones: number): number[] {
  const pos = rig.restModel.pos;
  const eps = Math.max(1e-6, rig.height * 1e-4);
  const out = [joint];
  let cur = joint;
  for (let p = rig.bones[joint].parent; p >= 0 && out.length <= bones; p = rig.bones[p].parent) {
    if (p === rig.hips || isAbove(rig, p, rig.hips)) break;
    if (!rig.bones[p].joint) continue;
    if (vec3.distance(pos[p], pos[cur]) < eps) continue;
    out.unshift(p);
    cur = p;
  }
  return out;
}

/** Whether bone `a` is an ancestor of bone `b`. */
function isAbove(rig: MotionRig, a: number, b: number): boolean {
  for (let p = b >= 0 ? rig.bones[b].parent : -1; p >= 0; p = rig.bones[p].parent) if (p === a) return true;
  return false;
}

/** The pose with one bone's entry replaced (dropped when it is back at rest). */
function withBone(pose: MotionPose, name: string, entry: PoseBone): MotionPose {
  const bones = { ...pose.bones };
  const tiny = (v?: Vec3) => !v || v.every(x => Math.abs(x) < 1e-5);
  const clean: PoseBone = { ...(tiny(entry.rot) ? {} : { rot: entry.rot }), ...(tiny(entry.move) ? {} : { move: entry.move }) };
  if (clean.rot || clean.move) bones[name] = clean; else delete bones[name];
  return { ...pose, bones };
}

/** A bone's turn from rest for a model-space rotation, given its parent's model rotation. */
function turnFor(rig: MotionRig, bone: number, parentModel: quat, modelRot: quat): Vec3 {
  const local = quat.multiply(quat.create(), quat.invert(quat.create(), parentModel), modelRot);
  const delta = quat.multiply(quat.create(), quat.invert(quat.create(), rig.bones[bone].r), local);
  quat.normalize(delta, delta);
  return quatToEuler(delta);
}

/**
 * Turn a bone so its model-space rotation is `modelRot` (the rotate rings). The tip of a planted limb turns
 * its goal instead (the goal's rotation is what holds it); a gripping tip turns the hand it holds with it.
 */
export function rotateBone(rig: MotionRig, pose: MotionPose, bone: number, modelRot: quat): MotionPose {
  for (const limb of LIMBS) {
    const goal = pose.ik?.[limb];
    if (!goal || rig.bySlot.get(LIMB_CHAINS[limb][2]) !== bone) continue;
    if (goal.grip) {
      // The lead tip's rotation that puts this one at modelRot: lead = modelRot * inv(grip.rot).
      const lead = pose.ik?.[goal.grip.follow];
      if (!lead) return pose;
      const leadRot = quat.multiply(quat.create(), modelRot, quat.invert(quat.create(), eulerToQuat(goal.grip.rot)));
      return { ...pose, ik: { ...pose.ik, [goal.grip.follow]: { ...lead, rot: quatToEuler(quat.normalize(leadRot, leadRot)) } } };
    }
    return { ...pose, ik: { ...pose.ik, [limb]: { ...goal, rot: quatToEuler(quat.normalize(quat.create(), modelRot)) } } };
  }
  const model = modelPose(rig.bones, solvedPoseLocals(rig, pose));
  const p = rig.bones[bone].parent;
  const parentRot = p >= 0 ? model.rot[p] : quat.create();
  const name = rig.bones[bone].name;
  return withBone(pose, name, { ...pose.bones[name], rot: turnFor(rig, bone, parentRot, modelRot) });
}

/** The joint's position in the pose as shown (IK goals solved), model space. */
export function jointPosition(rig: MotionRig, pose: MotionPose, joint: number): vec3 {
  return modelPose(rig.bones, solvedPoseLocals(rig, pose)).pos[joint];
}

/** Move a joint by a model-space offset by changing its own translation (the hips' travel, a stretch). */
function offsetJoint(rig: MotionRig, pose: MotionPose, joint: number, by: vec3): MotionPose {
  const model = modelPose(rig.bones, solvedPoseLocals(rig, pose));
  const p = rig.bones[joint].parent;
  // The offset into the parent's posed frame, then back into the rest-frame model offset `move` stores.
  const local = p >= 0 ? vec3.transformQuat(vec3.create(), by, quat.invert(quat.create(), model.rot[p])) : vec3.clone(by);
  if (p >= 0) {
    const m = model.mat[p];
    const scale = Math.hypot(m[0], m[1], m[2]) || 1;
    vec3.scale(local, local, 1 / scale);
  }
  const add = localToMove(rig, local, joint);
  const name = rig.bones[joint].name;
  const prev = pose.bones[name]?.move ?? [0, 0, 0];
  return withBone(pose, name, { ...pose.bones[name], move: [prev[0] + add[0], prev[1] + add[1], prev[2] + add[2]] });
}

/**
 * Drag `joint` to `target` (model space), from `pose`. In order: the hips move the body; a limb tip planted
 * with IK moves its goal; otherwise the chain above bends to reach (lengths kept) or the joint is put on
 * the target and the bone above stretches.
 */
export function dragJoint(rig: MotionRig, pose: MotionPose, joint: number, target: vec3, opts: DragOptions): MotionPose {
  const now = jointPosition(rig, pose, joint);
  if (joint === rig.hips) return offsetJoint(rig, pose, joint, vec3.sub(vec3.create(), target, now));

  for (const limb of LIMBS) {
    const goal = pose.ik?.[limb];
    if (!goal || rig.bySlot.get(LIMB_CHAINS[limb][2]) !== joint) continue;
    // A hand gripping the other one (a two-handed hilt) carries the lead hand's goal with it.
    const lead = goal.grip ? pose.ik?.[goal.grip.follow] : undefined;
    if (goal.grip && lead) {
      const by = vec3.sub(vec3.create(), target, now);
      return { ...pose, ik: { ...pose.ik, [goal.grip.follow]: { ...lead, pos: [lead.pos[0] + by[0], lead.pos[1] + by[1], lead.pos[2] + by[2]] } } };
    }
    return { ...pose, ik: { ...pose.ik, [limb]: { ...goal, pos: [target[0], target[1], target[2]] } } };
  }

  if (!opts.keepLengths) return offsetJoint(rig, pose, joint, vec3.sub(vec3.create(), target, now));

  const chain = chainOf(rig, joint, opts.chain > 0 ? opts.chain : defaultChain(rig, joint));
  if (chain.length < 2) return pose;
  let local = solvedPoseLocals(rig, pose);
  let model = modelPose(rig.bones, local);
  const points = chain.map(i => model.pos[i]);
  const lengths = chain.slice(1).map((i, k) => vec3.distance(model.pos[chain[k]], model.pos[i]));
  const solved = fabrik(points, lengths, target);

  let next = pose;
  // Root down: turn each chain joint so its link points at the solved next joint, then re-pose.
  for (let k = 0; k < chain.length - 1; k++) {
    const i = chain[k];
    const from = vec3.sub(vec3.create(), model.pos[chain[k + 1]], model.pos[i]);
    const to = vec3.sub(vec3.create(), solved[k + 1], model.pos[i]);
    if (vec3.length(from) < 1e-9 || vec3.length(to) < 1e-9) continue;
    vec3.normalize(from, from); vec3.normalize(to, to);
    const swing = quat.rotationTo(quat.create(), from, to);
    const modelRot = quat.multiply(quat.create(), swing, model.rot[i]);
    const p = rig.bones[i].parent;
    const parentRot = p >= 0 ? model.rot[p] : quat.create();
    const name = rig.bones[i].name;
    next = withBone(next, name, { ...next.bones[name], rot: turnFor(rig, i, parentRot, modelRot) });
    local = solvedPoseLocals(rig, next);
    model = modelPose(rig.bones, local);
  }
  return next;
}
