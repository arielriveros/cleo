import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { collapseFbxPivots, isFbxPivotName, type NodeGraph } from '../src/graphics/utils/fbxPivots';
import type { Animation, Joint } from '../src/animation/animatedModel';

// Assimp's FBX importer preserves pivots, wrapping every bone in `_$AssimpFbx$_Translation/_PreRotation/
// _Rotation/_Scaling` nodes — and it emits each one only when its FBX property is non-default, so two
// files exported from the same rig can get DIFFERENT chains. A retarget then either drops a pre-rotation
// or applies it twice, which shows up as a constant per-bone offset on exactly the pre-rotated bones.
//
// The collapse folds those nodes away. For the REST pose that is an identity by matrix associativity —
// folding `parent * p1 * ... * pn * bone` into the bone changes nothing — so the bind tests below assert
// the world transform is untouched, and that is provable without knowing any FBX semantics.
//
// ANIMATION is not associative here, because assimp does not write what the glTF node hierarchy implies.
// An assimp animation channel carries the node's COMPLETE local, pivot chain included, so the deepest
// keyed node in a chain SUPERSEDES the pivots above it and they must not be multiplied in again. That is
// measured, not assumed: tools/dump-rig.mjs reconstructs every joint's global from a Mixamo character's
// own rest-pose clip and compares it with the bind (the inverse of its inverse-bind matrix). Composing
// the pivots on top of a keyed bone is closer on 0 of 65 joints and wrong by 118 degrees / 146 units on
// average; superseding them is wrong by 11 degrees / 5.5 units, which is the genuine bind-vs-T-pose
// difference. The error lands on whichever bones carry a large FBX PreRotation — for Mixamo, UpLeg (179
// degrees) and Shoulder (129 degrees), exactly the reported symptom.

const qy = (deg: number) => quat.setAxisAngle(quat.create(), [0, 1, 0], deg * Math.PI / 180);
const qx = (deg: number) => quat.setAxisAngle(quat.create(), [1, 0, 0], deg * Math.PI / 180);
const trs = (t: number[], r: quat = quat.create(), s: number[] = [1, 1, 1]) =>
  mat4.fromRotationTranslationScale(mat4.create(), r, t as any, s as any);

type NodeSpec = { name: string; parent?: number; local?: mat4 };

function graphOf(nodes: NodeSpec[]): NodeGraph {
  const nodeParents = new Map<number, number>();
  const nodeTransforms = new Map<number, mat4>();
  const nodeNames = new Map<number, string>();
  nodes.forEach((n, i) => {
    nodeNames.set(i, n.name);
    if (n.parent !== undefined) nodeParents.set(i, n.parent);
    nodeTransforms.set(i, n.local ?? mat4.create());
  });
  return { nodeParents, nodeTransforms, nodeNames };
}

/** A one-track clip: `node` keyed with `rots` at `times`. */
function rotClip(node: number, times: number[], rots: quat[]): Animation {
  return {
    name: 'clip',
    samplers: [{ input: times.slice(), output: rots.flatMap(r => [r[0], r[1], r[2], r[3]]), interpolation: 'LINEAR' }],
    channels: [{ samplerIndex: 0, targetNodeIndex: node, targetPath: 'rotation' }],
  };
}

/**
 * A clip shaped the way assimp actually writes one: all three paths keyed, translation and scale held at
 * the node's own rest. Using a rotation-ONLY clip here would test a shape assimp never emits, and would
 * conflate the superseding rule with the separate "an unkeyed component stays at bind" rule.
 */
function trsClip(graph: NodeGraph, node: number, times: number[], rots: quat[]): Animation {
  const rest = graph.nodeTransforms.get(node) ?? mat4.create();
  const t = mat4.getTranslation(vec3.create(), rest);
  const sc = mat4.getScaling(vec3.create(), rest);
  return {
    name: 'clip',
    samplers: [
      { input: times.slice(), output: rots.flatMap(r => [r[0], r[1], r[2], r[3]]), interpolation: 'LINEAR' },
      { input: times.slice(), output: times.flatMap(() => [t[0], t[1], t[2]]), interpolation: 'LINEAR' },
      { input: times.slice(), output: times.flatMap(() => [sc[0], sc[1], sc[2]]), interpolation: 'LINEAR' },
    ],
    channels: [
      { samplerIndex: 0, targetNodeIndex: node, targetPath: 'rotation' },
      { samplerIndex: 1, targetNodeIndex: node, targetPath: 'translation' },
      { samplerIndex: 2, targetNodeIndex: node, targetPath: 'scale' },
    ],
  };
}

/**
 * The world transform of `node` at `time`, walking the graph and honouring any channels.
 *
 * Deliberately a separate, naive implementation from the one under test — it is the oracle, so sharing
 * code with the collapse would make the invariant vacuous.
 */
function worldAt(graph: NodeGraph, clip: Animation | null, node: number, time: number): mat4 {
  const chain: number[] = [];
  for (let n: number | undefined = node, guard = 0; n !== undefined && guard < 64; guard++) {
    chain.push(n);
    n = graph.nodeParents.get(n);
  }
  chain.reverse();

  const out = mat4.create();
  for (const n of chain) {
    const rest = graph.nodeTransforms.get(n) ?? mat4.create();
    const t = mat4.getTranslation(vec3.create(), rest);
    const s = mat4.getScaling(vec3.create(), rest);
    const r = quat.normalize(quat.create(), mat4.getRotation(quat.create(), rest));

    for (const ch of clip?.channels ?? []) {
      if (ch.targetNodeIndex !== n) continue;
      const sampler = clip!.samplers[ch.samplerIndex];
      const at = sampleLinear(sampler.input, sampler.output, ch.targetPath === 'rotation' ? 4 : 3, time);
      if (ch.targetPath === 'rotation') quat.normalize(r, quat.fromValues(at[0], at[1], at[2], at[3]));
      else if (ch.targetPath === 'translation') vec3.set(t, at[0], at[1], at[2]);
      else if (ch.targetPath === 'scale') vec3.set(s, at[0], at[1], at[2]);
    }
    mat4.multiply(out, out, mat4.fromRotationTranslationScale(mat4.create(), r, t, s));
  }
  return out;
}

function sampleLinear(input: number[], output: number[], size: number, time: number): number[] {
  if (time <= input[0]) return output.slice(0, size);
  const last = input.length - 1;
  if (time >= input[last]) return output.slice(last * size, last * size + size);
  let i = 0;
  while (i < last && input[i + 1] <= time) i++;
  const f = (time - input[i]) / (input[i + 1] - input[i]);
  const out: number[] = [];
  for (let c = 0; c < size; c++) {
    const a = output[i * size + c], b = output[(i + 1) * size + c];
    out.push(a + (b - a) * f);
  }
  // Quaternions must be compared as rotations, not componentwise — normalize so a lerped key is unit.
  if (size === 4) {
    const q = quat.normalize(quat.create(), quat.fromValues(out[0], out[1], out[2], out[3]));
    return [q[0], q[1], q[2], q[3]];
  }
  return out;
}

/**
 * The oracle for the animated case: the graph and clip a NAIVE walker would need in order to produce the
 * value the collapse should produce. Every pivot superseded by a keyed node below it is neutralised and
 * its own channels dropped. Built by editing rests, not by composing tracks, so it stays an independent
 * check on the resampling, decomposition and quaternion-continuity work `collapseFbxPivots` does.
 */
function superseded(graph: NodeGraph, clip: Animation): { graph: NodeGraph; clip: Animation } {
  const keyed = new Set(clip.channels.map(c => c.targetNodeIndex));
  const isPivot = (n: number) => isFbxPivotName(graph.nodeNames.get(n));
  const nodeTransforms = new Map(graph.nodeTransforms);
  const dead = new Set<number>();

  for (const node of keyed) {
    // Everything strictly above a keyed node, up to the first non-pivot, is already inside its value.
    for (let p = graph.nodeParents.get(node); p !== undefined && isPivot(p); p = graph.nodeParents.get(p)) {
      nodeTransforms.set(p, mat4.create());
      dead.add(p);
    }
  }
  return {
    graph: { ...graph, nodeTransforms },
    clip: { ...clip, channels: clip.channels.filter(c => !dead.has(c.targetNodeIndex)) },
  };
}

/** Two matrices describe the same transform (quaternion double-cover makes componentwise unsafe elsewhere). */
function expectSameTransform(a: mat4, b: mat4, label: string) {
  for (let i = 0; i < 16; i++) expect(a[i], `${label} [${i}]`).toBeCloseTo(b[i], 4);
}

describe('collapseFbxPivots — the world-transform invariant', () => {
  // Hips -> _Translation -> _PreRotation(180 about X) -> _Rotation(animated) -> LeftUpLeg
  const pivotChain = () => graphOf([
    { name: 'mixamorig:Hips', local: trs([0, 1, 0]) },
    { name: 'mixamorig:LeftUpLeg_$AssimpFbx$_Translation', parent: 0, local: trs([0.1, 0, 0]) },
    { name: 'mixamorig:LeftUpLeg_$AssimpFbx$_PreRotation', parent: 1, local: trs([0, 0, 0], qx(180)) },
    { name: 'mixamorig:LeftUpLeg_$AssimpFbx$_Rotation', parent: 2, local: trs([0, 0, 0], qy(10)) },
    { name: 'mixamorig:LeftUpLeg', parent: 3, local: trs([0, -0.4, 0]) },
  ]);

  it('preserves the bind-pose world transform of the bone', () => {
    const before = pivotChain();
    const expected = worldAt(before, null, 4, 0);

    const after = collapseFbxPivots(pivotChain(), []);
    expectSameTransform(worldAt(after, null, 4, 0), expected, 'bind');
  });

  it('removes the pivots and re-parents the bone onto the real parent bone', () => {
    const after = collapseFbxPivots(pivotChain(), []);
    expect([...after.nodeNames.values()]).toEqual(['mixamorig:Hips', 'mixamorig:LeftUpLeg']);
    expect(after.nodeParents.get(4)).toBe(0);       // straight onto Hips
    expect(after.removed).toEqual(new Set([1, 2, 3]));
  });

  it('reproduces the keyed value at every keyframe, superseding the pivots above it', () => {
    const times = [0, 0.5, 1];
    const rots = [qy(10), qy(70), qy(-35)];
    const clip = trsClip(pivotChain(), 3, times, rots);    // the _Rotation pivot carries the curve
    const ref = superseded(pivotChain(), clip);
    const expected = times.map(t => worldAt(ref.graph, ref.clip, 4, t));

    const after = collapseFbxPivots(pivotChain(), [trsClip(pivotChain(), 3, times, rots)]);
    times.forEach((t, i) =>
      expectSameTransform(worldAt(after, after.animations[0], 4, t), expected[i], `key ${t}`));
  });

  it('holds midway BETWEEN keyframes too', () => {
    // The composed track is resampled, so interpolation has to survive the rewrite as well.
    const times = [0, 1];
    const rots = [qy(0), qy(90)];
    const clip = trsClip(pivotChain(), 3, times, rots);
    const ref = superseded(pivotChain(), clip);
    const after = collapseFbxPivots(pivotChain(), [trsClip(pivotChain(), 3, times, rots)]);

    for (const t of [0.25, 0.5, 0.75])
      expectSameTransform(worldAt(after, after.animations[0], 4, t), worldAt(ref.graph, ref.clip, 4, t), `t=${t}`);
  });

  it('handles the animated node in any position in the chain', () => {
    for (const animated of [1, 2, 3]) {
      const times = [0, 1];
      const rots = [qy(15), qy(-60)];
      const clip = trsClip(pivotChain(), animated, times, rots);
      const ref = superseded(pivotChain(), clip);
      const after = collapseFbxPivots(pivotChain(), [trsClip(pivotChain(), animated, times, rots)]);
      for (const t of times)
        expectSameTransform(worldAt(after, after.animations[0], 4, t), worldAt(ref.graph, ref.clip, 4, t), `node ${animated} @ ${t}`);
    }
  });

  it('lets the DEEPER of two animated nodes in one chain win, on its own keyframe times', () => {
    // Node 3 sits below node 2, so node 3's value already contains node 2's — applying both would be the
    // double-application this whole rule exists to prevent.
    const a = trsClip(pivotChain(), 2, [0, 1], [qy(0), qy(40)]);
    const b = trsClip(pivotChain(), 3, [0, 0.5, 1], [qx(0), qx(20), qx(-20)]);
    const combined: Animation = {
      name: 'both',
      samplers: [...a.samplers, ...b.samplers],
      channels: [...a.channels, ...b.channels.map(c => ({ ...c, samplerIndex: c.samplerIndex + a.samplers.length }))],
    };
    const ref = superseded(pivotChain(), combined);
    const after = collapseFbxPivots(pivotChain(), [{ ...combined, samplers: combined.samplers.map(s => ({ ...s })) }]);

    for (const t of [0, 0.5, 1])
      expectSameTransform(worldAt(after, after.animations[0], 4, t), worldAt(ref.graph, ref.clip, 4, t), `t=${t}`);
    expect(after.animations[0].samplers[0].input).toEqual([0, 0.5, 1]);
  });

  it('does not double-apply a large PreRotation the keyed bone already carries', () => {
    // The real-file case, reduced: the pivot holds the whole bind orientation and the bone's own rest is
    // identity, exactly as assimp writes a Mixamo UpLeg. A rest-pose clip keys the BONE with that same
    // orientation. Composing would give ~360 degrees of twist; superseding gives the bind back.
    const g = () => graphOf([
      { name: 'mixamorig:Hips', local: trs([0, 1, 0]) },
      { name: 'mixamorig:LeftUpLeg_$AssimpFbx$_PreRotation', parent: 0, local: trs([0, 0, 0], qx(179)) },
      { name: 'mixamorig:LeftUpLeg', parent: 1, local: trs([0, -0.4, 0]) },
    ]);
    const bind = worldAt(g(), null, 2, 0);
    const clip = rotClip(2, [0, 1], [qx(179), qx(179)]);

    const after = collapseFbxPivots(g(), [clip]);
    const posed = worldAt(after, after.animations[0], 2, 0);
    expectSameTransform(posed, bind, 'rest-pose clip must be a no-op');
  });

  it('emits only the components that actually move', () => {
    // On the retarget's raw path a translation channel passes straight through, so emitting one for a
    // rotation-only clip overwrote the target character's bone offsets with the animation file's.
    const after = collapseFbxPivots(pivotChain(), [rotClip(3, [0, 1], [qy(0), qy(45)])]);
    const paths = after.animations[0].channels.map(c => c.targetPath).sort();
    expect(paths).toEqual(['rotation']);
  });

  it('keeps a quaternion track continuous across keys', () => {
    // Independent per-key decomposition can flip the sign of a quaternion; slerp would then take the long
    // way round and the bone would visibly spin.
    const times = [0, 1, 2];
    const rots = [qy(0), qy(170), qy(340)];
    const after = collapseFbxPivots(pivotChain(), [rotClip(3, times, rots)]);
    const rot = after.animations[0].channels.find(c => c.targetPath === 'rotation')!;
    const out = after.animations[0].samplers[rot.samplerIndex].output;

    for (let k = 1; k * 4 < out.length; k++) {
      const dot = out[(k - 1) * 4] * out[k * 4] + out[(k - 1) * 4 + 1] * out[k * 4 + 1]
        + out[(k - 1) * 4 + 2] * out[k * 4 + 2] + out[(k - 1) * 4 + 3] * out[k * 4 + 3];
      expect(dot, `key ${k} flipped`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('collapseFbxPivots — joints and pass-through', () => {
  it('leaves a graph with no pivots completely untouched', () => {
    const plain = graphOf([
      { name: 'Hips', local: trs([0, 1, 0]) },
      { name: 'Spine', parent: 0, local: trs([0, 0.2, 0]) },
    ]);
    const clip = rotClip(1, [0, 1], [qy(0), qy(30)]);
    const after = collapseFbxPivots(plain, [clip]);

    expect(after.nodeNames).toBe(plain.nodeNames);      // same objects: a true no-op
    expect(after.animations[0]).toBe(clip);
    expect(after.removed.size).toBe(0);
  });

  it('re-points joint parents without reordering the joint list', () => {
    // The order is the per-vertex JOINTS_0 index space — reordering it would rebind every vertex.
    const graph = graphOf([
      { name: 'Hips' },
      { name: 'Spine_$AssimpFbx$_Rotation', parent: 0 },
      { name: 'Spine', parent: 1 },
    ]);
    const joints: Joint[] = [
      { nodeIndex: 0, inverseBindMatrix: mat4.create(), parentIndex: undefined },
      { nodeIndex: 2, inverseBindMatrix: mat4.create(), parentIndex: 1 },
    ];
    collapseFbxPivots(graph, [], joints);

    expect(joints.map(j => j.nodeIndex)).toEqual([0, 2]); // unchanged order
    expect(joints[1].parentIndex).toBe(0);               // Spine now hangs off Hips directly
  });

  it('does not fold a pivot that has more than one child', () => {
    // Not assimp's linear decomposition; folding it would drag its siblings with it.
    const graph = graphOf([
      { name: 'Hips' },
      { name: 'Odd_$AssimpFbx$_Rotation', parent: 0, local: trs([0, 0, 0], qy(30)) },
      { name: 'A', parent: 1 },
      { name: 'B', parent: 1 },
    ]);
    const after = collapseFbxPivots(graph, []);
    expect(after.nodeNames.has(1)).toBe(true);
    expect(after.nodeParents.get(2)).toBe(1);
  });

  it('recognises assimp pivot names', () => {
    expect(isFbxPivotName('mixamorig:Hips_$AssimpFbx$_PreRotation')).toBe(true);
    expect(isFbxPivotName('mixamorig:Hips')).toBe(false);
    expect(isFbxPivotName(undefined)).toBe(false);
  });
});
