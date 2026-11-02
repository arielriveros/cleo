// Body-part groups ("parts"): named sets of bones that each arrive at a key their own way -- the legs
// linear while the arms spring, the arms a beat behind the body (motionDoc.ts `MotionPart`, `PartBlend`).
//
// The default parts are the humanoid's body, arms and legs, found by slot (cleo/animation/boneNames): every
// joint goes with the nearest of its ancestors (or itself) that one of them names, so the fingers follow
// their hand, the toes their foot, a twist bone its arm. The Pose tab lists its bones by the same groups.

import type { BlendCurve } from './blendCurve';
import { PART_COLORS, type MotionKey, type MotionPart } from './motionDoc';
import type { MotionRig } from './motionRig';

/** The humanoid groups by slot, in body order: the default parts, and the Pose tab's bone list. */
export const BONE_GROUPS: { id: string; title: string; slots: string[] }[] = [
  { id: 'body', title: 'Body', slots: ['hips', 'spine', 'chest', 'neck', 'head'] },
  { id: 'armL', title: 'Left arm', slots: ['shoulder.L', 'upperArm.L', 'foreArm.L', 'hand.L'] },
  { id: 'armR', title: 'Right arm', slots: ['shoulder.R', 'upperArm.R', 'foreArm.R', 'hand.R'] },
  { id: 'legL', title: 'Left leg', slots: ['upLeg.L', 'leg.L', 'foot.L', 'toe.L'] },
  { id: 'legR', title: 'Right leg', slots: ['upLeg.R', 'leg.R', 'foot.R', 'toe.R'] },
];

/** Every bone of a slot: each humanoid "spine" and "chest" in the chain, not only the first. */
function slotBones(rig: MotionRig, slot: string): number[] {
  if (slot === 'spine' || slot === 'chest') return rig.bones.flatMap((b, i) => (b.slot === slot ? [i] : []));
  const i = rig.bySlot.get(slot);
  return i === undefined ? [] : [i];
}

/** The slotted bones of each group (the Pose tab's lists), by name; groups the rig has none of left out. */
export function boneGroups(rig: MotionRig): { id: string; title: string; bones: string[] }[] {
  return BONE_GROUPS.map(g => ({ id: g.id, title: g.title, bones: g.slots.flatMap(s => slotBones(rig, s)).map(i => rig.bones[i].name) }))
    .filter(g => g.bones.length);
}

/** The parts a new motion starts with: Body, Left arm, Right arm, Left leg, Right leg (see the header). */
export function defaultParts(rig: MotionRig): MotionPart[] {
  const groupOf = new Map<number, number>();
  BONE_GROUPS.forEach((g, gi) => { for (const s of g.slots) for (const i of slotBones(rig, s)) if (!groupOf.has(i)) groupOf.set(i, gi); });
  const members: string[][] = BONE_GROUPS.map(() => []);
  rig.bones.forEach((b, i) => {
    if (!b.joint) return;
    for (let p = i; p >= 0; p = rig.bones[p].parent) {
      const g = groupOf.get(p);
      if (g !== undefined) { members[g].push(b.name); return; }
    }
  });
  return BONE_GROUPS.map((g, gi) => ({ id: g.id, name: g.title, color: PART_COLORS[gi % PART_COLORS.length], bones: members[gi] }))
    .filter(p => p.bones.length);
}

/** Per rig bone, the index of the part it belongs to (the first that lists it), or -1. */
export function partIndexOf(rig: MotionRig, parts: readonly MotionPart[]): Int16Array {
  const out = new Int16Array(rig.bones.length).fill(-1);
  parts.forEach((p, pi) => {
    for (const name of p.bones) {
      const i = rig.byName.get(name);
      if (i !== undefined && out[i] < 0) out[i] = pi;
    }
  });
  return out;
}

/** A part's blend into a key, everything inherited filled in. */
export interface ResolvedPartBlend {
  blend: BlendCurve;
  presetId?: string;
  /** Seconds late (+) or early (−) against the key. */
  offset: number;
  /** Seconds per joint; undefined: the motion's overlap. */
  overlap?: number;
  /** Share of the motion's variation. */
  variation: number;
  /** The key overrides the part's defaults (anything at all). */
  overridden: boolean;
}

/**
 * How `part` arrives at `key`: the key's override over the part's defaults, the curve falling back to the
 * key's own blend. No part: the key's blend, as it is.
 */
export function resolvePartBlend(key: MotionKey, part: MotionPart | null | undefined): ResolvedPartBlend {
  const own = part ? key.parts?.[part.id] : undefined;
  const base = part?.defaults;
  const curve = own?.blend ? own : base?.blend ? base : key;
  const overlap = own?.overlap ?? base?.overlap;
  return {
    blend: curve.blend!, ...(curve.presetId ? { presetId: curve.presetId } : {}),
    offset: own?.offset ?? base?.offset ?? 0,
    ...(overlap !== undefined ? { overlap } : {}),
    variation: own?.variation ?? base?.variation ?? 1,
    overridden: !!own,
  };
}
