// The skeleton the Motion Creator poses and bakes against, read off a skin: every joint plus the non-joint
// nodes above them (an `Armature` root that scales centimetres to metres and turns Z-up to Y-up), in
// parents-first order, each with its rest transform. Pure: gl-matrix and the engine's name helpers only,
// so posing and baking are testable without a GL context.

import { mat4, quat, vec3 } from 'gl-matrix';
import { humanoidSlotOf, mirrorBoneName } from 'cleo/animation/boneNames';

/** A skin as either the engine holds it (Maps, matrices) or as JSON stores it (entry pairs, arrays). */
export interface SkinLike {
  joints: { nodeIndex: number; parentIndex?: number }[];
  nodeParents?: Map<number, number> | [number, number][];
  nodeTransforms?: Map<number, ArrayLike<number>> | [number, ArrayLike<number>][];
  nodeNames?: Map<number, string> | [number, string][];
}

export interface RigBone {
  /** The skin node this bone is; animation channels target it. */
  node: number;
  name: string;
  /** Index into `MotionRig.bones`, or -1 at the top. */
  parent: number;
  /** The rest pose, local to the parent. */
  t: vec3;
  r: quat;
  s: vec3;
  /** Whether the skin skins with it (a joint), rather than only carrying the ones that are. */
  joint: boolean;
  /** Joints between this bone and the hips: the overlap delay counts these. 0 for the hips and above. */
  depth: number;
  /** The humanoid slot (`'upLeg.L'`, `'head'`), or null. */
  slot: string | null;
}

export interface MotionRig {
  bones: RigBone[];
  byName: Map<string, number>;
  bySlot: Map<string, number>;
  /** The bone the hips offset moves, or -1. */
  hips: number;
  /** The model-space axis that points across the body (0 x, 1 y, 2 z): what mirroring flips. */
  mirrorAxis: 0 | 1 | 2;
  /** Mirror partner by bone index (itself for centre bones). */
  mirror: number[];
  /** Rest pose in model space. */
  restModel: { pos: vec3[]; rot: quat[]; mat: mat4[] };
  /** Rough standing height in model units (hips height × 1.9), for sizing sliders. */
  height: number;
}

const entries = <V,>(m: Map<number, V> | [number, V][] | undefined): [number, V][] =>
  m instanceof Map ? [...m.entries()] : Array.isArray(m) ? m.map(e => [Number(e[0]), e[1]] as [number, V]) : [];

export function buildRig(skin: SkinLike): MotionRig {
  const parents = new Map(entries(skin.nodeParents));
  const transforms = new Map(entries(skin.nodeTransforms));
  const names = new Map(entries(skin.nodeNames));
  const joints = new Set(skin.joints.map(j => j.nodeIndex));

  // Every joint and every ancestor of one: an ancestor's transform reaches every joint below it.
  const nodes = new Set<number>();
  for (const j of joints) {
    let n: number | undefined = j;
    const guard = new Set<number>();
    while (n !== undefined && !guard.has(n)) {
      guard.add(n);
      nodes.add(n);
      n = parents.get(n);
    }
  }
  // Parents first.
  const ordered: number[] = [];
  const placed = new Set<number>();
  const place = (n: number) => {
    if (placed.has(n)) return;
    const p = parents.get(n);
    if (p !== undefined && nodes.has(p)) place(p);
    placed.add(n);
    ordered.push(n);
  };
  for (const n of [...nodes].sort((a, b) => a - b)) place(n);

  const index = new Map<number, number>();
  const bones: RigBone[] = ordered.map((node, i) => {
    index.set(node, i);
    const m = transforms.get(node);
    const t = vec3.create(), r = quat.create(), s = vec3.fromValues(1, 1, 1);
    if (m && m.length >= 16) {
      const mm = mat4.clone(m as unknown as mat4);
      mat4.getTranslation(t, mm);
      mat4.getScaling(s, mm);
      mat4.getRotation(r, mm);
      quat.normalize(r, r);
    }
    const name = names.get(node) ?? `node${node}`;
    const p = parents.get(node);
    return { node, name, parent: p !== undefined && index.has(p) ? index.get(p)! : -1, t, r, s, joint: joints.has(node), depth: 0, slot: humanoidSlotOf(name) };
  });

  const byName = new Map(bones.map((b, i) => [b.name, i]));
  const bySlot = new Map<string, number>();
  bones.forEach((b, i) => { if (b.slot && !bySlot.has(b.slot)) bySlot.set(b.slot, i); });
  const hips = bySlot.get('hips') ?? bones.findIndex(b => b.joint);

  // Depth below the hips, counted in joints.
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    b.depth = b.parent < 0 || i === hips || !isBelow(bones, i, hips) ? 0 : bones[b.parent].depth + (b.joint ? 1 : 0);
  }

  const restModel = modelPose(bones, bones.map(b => ({ t: b.t, r: b.r, s: b.s })));

  // Across-the-body axis: the widest of the upper arms' (or legs') separation.
  const pairs: [string, string][] = [['upperArm.L', 'upperArm.R'], ['upLeg.L', 'upLeg.R'], ['shoulder.L', 'shoulder.R']];
  let mirrorAxis: 0 | 1 | 2 = 0;
  for (const [l, r] of pairs) {
    const a = bySlot.get(l), b = bySlot.get(r);
    if (a === undefined || b === undefined) continue;
    const d = vec3.sub(vec3.create(), restModel.pos[a], restModel.pos[b]);
    const ax = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
    mirrorAxis = (ax[0] >= ax[1] && ax[0] >= ax[2] ? 0 : ax[1] >= ax[2] ? 1 : 2) as 0 | 1 | 2;
    break;
  }
  const mirror = bones.map((b, i) => {
    const other = mirrorBoneName(b.name);
    return other !== null && byName.has(other) ? byName.get(other)! : i;
  });

  // Standing height: the hips sit at a little over half of it. A skeleton without recognisable hips
  // (no humanoid names) is measured instead: the tallest extent of its joints at rest.
  let height = Math.max(0.01, ...[0, 1, 2].map(k => {
    const v = restModel.pos.map(p => p[k]);
    return v.length ? Math.max(...v) - Math.min(...v) : 1.8;
  }));
  if (hips >= 0) {
    const feet = ['foot.L', 'foot.R', 'toe.L'].map(s => bySlot.get(s)).filter((v): v is number => v !== undefined);
    const up = upAxisOf(restModel, hips, feet);
    const floor = feet.length ? Math.min(...feet.map(f => restModel.pos[f][up])) : 0;
    height = Math.max(0.01, (restModel.pos[hips][up] - floor) * 1.9);
  }

  return { bones, byName, bySlot, hips, mirrorAxis, mirror, restModel, height };
}

function isBelow(bones: RigBone[], i: number, ancestor: number): boolean {
  let p = bones[i].parent;
  while (p >= 0) { if (p === ancestor) return true; p = bones[p].parent; }
  return false;
}

/** The model-space axis from the feet up to the hips. */
export function upAxisOf(model: { pos: vec3[] }, hips: number, feet: number[]): 0 | 1 | 2 {
  if (hips < 0 || !feet.length) return 1;
  const d = vec3.sub(vec3.create(), model.pos[hips], model.pos[feet[0]]);
  const a = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
  return (a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2) as 0 | 1 | 2;
}

export interface LocalTRS { t: vec3; r: quat; s: vec3 }

/** Model-space position and rotation of every bone, from local transforms (forward kinematics). */
export function modelPose(bones: RigBone[], local: LocalTRS[]): { pos: vec3[]; rot: quat[]; mat: mat4[] } {
  const mat: mat4[] = [], pos: vec3[] = [], rot: quat[] = [];
  for (let i = 0; i < bones.length; i++) {
    const l = local[i];
    const m = mat4.fromRotationTranslationScale(mat4.create(), l.r, l.t, l.s);
    const p = bones[i].parent;
    if (p >= 0) mat4.multiply(m, mat[p], m);
    mat.push(m);
    pos.push(mat4.getTranslation(vec3.create(), m));
    // Rotation alone, scale divided out (getRotation does).
    const r = mat4.getRotation(quat.create(), m);
    rot.push(quat.normalize(r, r));
  }
  return { pos, rot, mat };
}
