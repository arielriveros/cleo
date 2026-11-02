import { describe, expect, it } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { buildRig, modelPose } from '../src/motion/motionRig';
import { bakeMotion, editorPoseBones, gripFrom, limbTip, mirrorPose, poseFromClip, poseLocals, solvedPoseLocals } from '../src/motion/bakeMotion';
import { exportCharacter, newCharacter, normaliseCharacter } from '../src/motion/character';
import { parseRiggedDescriptors, riggedSkeleton } from '../src/core/riggedImport';
import { DEFAULT_MOTION, eulerToQuat, motionFromFile, normaliseMotion, presetBlend, quatToEuler, type MotionDoc, type MotionPose } from '../src/motion/motionDoc';
import { BUILTIN_PRESETS, builtinPreset, evalBlend, normaliseCurve, presetOf, toKeys } from '../src/motion/blendCurve';
import { GLTFLoader } from 'cleo/graphics/utils/gltfLoader';
import { chainOf, dragJoint, fabrik, jointPosition, rotateBone } from '../src/motion/poseDrag';

// A small Mixamo-named humanoid under a 0.01-scale armature (as the mannequin is): hips at 100 cm.
function skin() {
  const bones: [string, number | null, [number, number, number]][] = [
    ['Armature', null, [0, 0, 0]],
    ['mixamorig:Hips', 0, [0, 100, 0]],
    ['mixamorig:Spine', 1, [0, 10, 0]],
    ['mixamorig:Neck', 2, [0, 40, 0]],
    ['mixamorig:Head', 3, [0, 10, 0]],
    ['mixamorig:LeftArm', 2, [20, 30, 0]],
    ['mixamorig:LeftForeArm', 5, [25, 0, 0]],
    ['mixamorig:LeftHand', 6, [25, 0, 0]],
    ['mixamorig:RightArm', 2, [-20, 30, 0]],
    ['mixamorig:RightForeArm', 8, [-25, 0, 0]],
    ['mixamorig:RightHand', 9, [-25, 0, 0]],
    ['mixamorig:LeftUpLeg', 1, [10, -5, 0]],
    ['mixamorig:LeftLeg', 11, [0, -45, 0]],
    ['mixamorig:LeftFoot', 12, [0, -45, 0]],
    ['mixamorig:RightUpLeg', 1, [-10, -5, 0]],
    ['mixamorig:RightLeg', 14, [0, -45, 0]],
    ['mixamorig:RightFoot', 15, [0, -45, 0]],
  ];
  const nodeTransforms = bones.map(([, , t], i) => [i, Array.from(i === 0
    ? mat4.fromScaling(mat4.create(), [0.01, 0.01, 0.01])
    : mat4.fromTranslation(mat4.create(), t))] as [number, number[]]);
  return {
    joints: bones.slice(1).map((_, i) => ({ nodeIndex: i + 1 })),
    nodeParents: bones.flatMap(([, p], i) => (p === null ? [] : [[i, p] as [number, number]])),
    nodeTransforms,
    nodeNames: bones.map(([n], i) => [i, n] as [number, string]),
  };
}

const rig = buildRig(skin());
const pose = (name: string, bones: MotionPose['bones'], ik?: MotionPose['ik']): MotionPose => ({ id: name, name, bones, ...(ik ? { ik } : {}) });
const doc = (poses: MotionPose[], keys: MotionDoc['keys'], extra: Partial<MotionDoc> = {}): MotionDoc =>
  normaliseMotion({ ...DEFAULT_MOTION, poses, keys, overlap: 0, ...extra });
/** A baked rotation channel's quaternion at frame `f`. */
function rotAt(clip: ReturnType<typeof bakeMotion>, boneName: string, f: number): quat {
  const node = rig.bones[rig.byName.get(boneName)!].node;
  const ch = clip.channels.find(c => c.targetNodeIndex === node && c.targetPath === 'rotation')!;
  const o = clip.samplers[ch.samplerIndex].output;
  return quat.fromValues(o[f * 4], o[f * 4 + 1], o[f * 4 + 2], o[f * 4 + 3]);
}

describe('motion rig', () => {
  it('reads the skeleton parents-first, with humanoid slots, depths, mirror partners and the body axis', () => {
    expect(rig.bones[0].name).toBe('Armature');
    expect(rig.bones[rig.hips].name).toBe('mixamorig:Hips');
    expect(rig.bones[rig.byName.get('mixamorig:LeftHand')!].depth).toBe(4);
    expect(rig.bones[rig.mirror[rig.byName.get('mixamorig:LeftArm')!]].name).toBe('mixamorig:RightArm');
    expect(rig.mirrorAxis).toBe(0);
    expect(rig.height).toBeCloseTo(1.8, 1);          // (hips - feet) x 1.9, in metres: the 0.01 armature scale
  });
});

describe('easing and Euler', () => {
  const curve = (id: string) => builtinPreset(id)!.curve;
  const sample = (id: string) => Array.from({ length: 101 }, (_, i) => evalBlend(curve(id), i / 100));

  it('every preset blends from the previous pose (0) to the arriving one (1)', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(evalBlend(p.curve, 0)).toBe(0);
      expect(evalBlend(p.curve, 1)).toBe(1);
    }
  });
  it('linear is the identity, ease in-out is symmetric, cubic beziers match CSS', () => {
    for (const u of [0.1, 0.37, 0.5, 0.9]) expect(evalBlend(curve('linear'), u)).toBeCloseTo(u, 5);
    for (const u of [0.1, 0.25, 0.4]) expect(evalBlend(curve('smooth'), u) + evalBlend(curve('smooth'), 1 - u)).toBeCloseTo(1, 4);
    // CSS `ease` = cubic-bezier(0.25, 0.1, 0.25, 1) at half way.
    expect(evalBlend({ type: 'bezier', p: [0.25, 0.1, 0.25, 1] }, 0.5)).toBeCloseTo(0.8024, 3);
  });
  it('overshoot goes past the pose, anticipate winds up first, springs swing, hold snaps', () => {
    expect(Math.max(...sample('overshoot'))).toBeGreaterThan(1.05);
    expect(Math.min(...sample('anticipate'))).toBeLessThan(-0.05);
    expect(Math.max(...sample('spring'))).toBeGreaterThan(1.05);
    expect(Math.max(...sample('bouncy'))).toBeGreaterThan(Math.max(...sample('spring')));
    expect(evalBlend(curve('hold'), 0.99)).toBe(0);
  });
  it('turns any curve into free-form keys that follow it', () => {
    const keys = toKeys(curve('overshoot'), 17);
    for (const u of [0.25, 0.5, 0.75]) expect(evalBlend(keys, u)).toBeCloseTo(evalBlend(curve('overshoot'), u), 1);
  });
  it('validates stored curves and recognises presets', () => {
    expect(normaliseCurve({ type: 'bezier', p: [2, 0.5, -1, 9] })).toEqual({ type: 'bezier', p: [1, 0.5, 0, 4] });
    expect(normaliseCurve({ type: 'keys', keys: [{ t: 0, v: 0 }] })).toBeNull();
    expect(normaliseCurve({ type: 'nope' })).toBeNull();
    expect(presetOf(structuredClone(curve('spring')), BUILTIN_PRESETS)?.id).toBe('spring');
  });
  it('round-trips Euler degrees', () => {
    const e: [number, number, number] = [30, -20, 45];
    const back = quatToEuler(eulerToQuat(e));
    back.forEach((v, i) => expect(v).toBeCloseTo(e[i], 3));
  });
});

describe('bake', () => {
  const raise = pose('raise', { 'mixamorig:LeftArm': { rot: [0, 0, 60] } });
  const rest = pose('rest', {});

  it('starts at the first pose and ends at the last, with events at the keys', () => {
    const clip = bakeMotion(rig, doc([rest, raise], [
      { id: 'a', poseId: 'rest', time: 0, ...presetBlend('linear') }, { id: 'b', poseId: 'raise', time: 1, ...presetBlend('smooth'), event: 'up' },
    ]));
    const restR = rig.bones[rig.byName.get('mixamorig:LeftArm')!].r;
    expect(quat.getAngle(rotAt(clip, 'mixamorig:LeftArm', 0), restR)).toBeLessThan(1e-4);
    const last = clip.samplers[0].input.length - 1;
    expect(quat.getAngle(rotAt(clip, 'mixamorig:LeftArm', last), quat.multiply(quat.create(), restR, eulerToQuat([0, 0, 60])))).toBeLessThan(1e-3);
    expect(clip.events).toEqual([{ time: 1, name: 'up' }]);
    expect(clip.samplers[0].input[last]).toBeCloseTo(1, 6);
  });

  it('lets the extremities trail the body (overlap) and settles after the last key', () => {
    const both = pose('both', { 'mixamorig:Spine': { rot: [20, 0, 0] }, 'mixamorig:LeftHand': { rot: [40, 0, 0] } });
    const clip = bakeMotion(rig, doc([rest, both], [
      { id: 'a', poseId: 'rest', time: 0, ...presetBlend('linear') }, { id: 'b', poseId: 'both', time: 1, ...presetBlend('linear') },
    ], { overlap: 0.05 }));
    const f = 15;   // 0.5 s
    const spine = quat.getAngle(rotAt(clip, 'mixamorig:Spine', f), rig.bones[rig.byName.get('mixamorig:Spine')!].r) / (20 * Math.PI / 180);
    const hand = quat.getAngle(rotAt(clip, 'mixamorig:LeftHand', f), rig.bones[rig.byName.get('mixamorig:LeftHand')!].r) / (40 * Math.PI / 180);
    expect(hand).toBeLessThan(spine - 0.05);
    const input = clip.samplers[0].input;
    expect(input[input.length - 1]).toBeCloseTo(1 + 0.05 * 4, 5);
  });

  it('plants an IK foot where its goal is', () => {
    const goal: [number, number, number] = [0.15, 0.2, 0.25];
    const lifted = pose('lift', {}, { footL: { pos: goal } });
    const tip = limbTip(rig, lifted, 'footL')!;
    expect(vec3.distance(tip as unknown as vec3, goal as unknown as vec3)).toBeLessThan(1e-3);
  });

  it('mirrors a pose left to right', () => {
    const left = pose('l', { 'mixamorig:LeftArm': { rot: [10, 20, 60] }, 'mixamorig:Hips': { move: [0.1, 0, 0] } });
    const right = mirrorPose(rig, left);
    const a = modelPose(rig.bones, poseLocals(rig, left)), b = modelPose(rig.bones, poseLocals(rig, right));
    const lh = a.pos[rig.byName.get('mixamorig:LeftHand')!], rh = b.pos[rig.byName.get('mixamorig:RightHand')!];
    expect(rh[0]).toBeCloseTo(-lh[0], 4);
    expect(rh[1]).toBeCloseTo(lh[1], 4);
    expect(rh[2]).toBeCloseTo(lh[2], 4);
    expect(right.bones['mixamorig:Hips'].move).toEqual([-0.1, 0, 0]);
    // The mirror of the mirror is the original.
    const back = modelPose(rig.bones, solvedPoseLocals(rig, mirrorPose(rig, right)));
    expect(vec3.distance(back.pos[rig.byName.get('mixamorig:LeftHand')!], lh)).toBeLessThan(1e-4);
  });

  it('normalises a junk document into something bakeable', () => {
    const d = normaliseMotion({ poses: [{ id: 'x', name: '', bones: { a: { rot: [1, 2, 'q'] } } }] as any, keys: [{ poseId: 'nope' }] as any, fps: 999 });
    expect(d.poses[0].bones).toEqual({});
    expect(d.keys).toHaveLength(1);
    expect(d.fps).toBe(120);
    expect(() => bakeMotion(rig, d)).not.toThrow();
  });
});

describe('poses from clips, and for the editor', () => {
  const posed = pose('posed', {
    'mixamorig:Spine': { rot: [12, -8, 5] }, 'mixamorig:LeftArm': { rot: [20, 10, 55] },
    'mixamorig:Hips': { move: [0.05, -0.1, 0.02] },
  });
  const held = bakeMotion(rig, doc([posed], [{ id: 'a', poseId: 'posed', time: 0, ...presetBlend('linear') }, { id: 'b', poseId: 'posed', time: 1, ...presetBlend('linear') }]));

  it('reads a clip frame back as the pose it was baked from', () => {
    const back = poseFromClip(rig, held as any, 0.5);
    const a = modelPose(rig.bones, poseLocals(rig, posed)), b = modelPose(rig.bones, poseLocals(rig, back));
    rig.bones.forEach((_, i) => expect(vec3.distance(a.pos[i], b.pos[i]), rig.bones[i].name).toBeLessThan(1e-4));
    expect(back.bones['mixamorig:Hips'].move!.map(v => +v.toFixed(3))).toEqual([0.05, -0.1, 0.02]);
    expect(back.bones['mixamorig:Head']).toBeUndefined();          // left at rest: left out
  });

  it('writes poses in the editor convention (delta x rest, parent space)', () => {
    const bones = editorPoseBones(rig, posed);
    const arm = rig.bones[rig.byName.get('mixamorig:LeftArm')!];
    const ours = quat.multiply(quat.create(), arm.r, eulerToQuat([20, 10, 55]));
    const e = bones.find(b => b.name === 'mixamorig:LeftArm')!.rotation!;
    const theirs = quat.multiply(quat.create(), quat.fromValues(e[0], e[1], e[2], e[3]), arm.r);
    expect(quat.getAngle(ours, theirs)).toBeLessThan(2e-3);   // 0.1 deg: getAngle is ill-conditioned near 0 in float32
    // The hips move is in the hips' local units: 0.05 m under a 0.01 armature is 5.
    expect(bones.find(b => b.name === 'mixamorig:Hips')!.translation![0]).toBeCloseTo(5, 3);
  });

  it('exports a character: kept, renamed clips with the skeleton, and its pose library', () => {
    const anims = [{ ...held, name: 'Idle' }, { ...held, name: 'Wave' }, { ...held, name: 'T-Pose' }] as any[];
    const c = newCharacter('Hero', ['hero.glb'], anims);
    c.clips = c.clips.map(x => x.source === 'Wave' ? { ...x, name: 'Hello' } : x.source === 'T-Pose' ? { ...x, hidden: true } : x);
    c.poses = [posed];
    const files = exportCharacter(c, rig, skin() as any, anims);
    const read = (n: string) => JSON.parse(new TextDecoder().decode(files.find(f => f.name === n)!.bytes));
    const anim = read('Hero.anim.json');
    expect(anim.clips.map((x: any) => x.name)).toEqual(['Idle', 'Hello']);
    expect(anim.rigName).toBe('Hero');
    expect(anim.sourceSkin.nodeNames.length).toBeGreaterThan(10);
    expect(read('Hero.poses.json').poses[0].bones.length).toBe(3);
    expect(read('Hero.character.json').output.anim).toBe('Hero.anim.json');
    expect(normaliseCharacter(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });
});

describe('rigged upload', () => {
  it('reads a rigged glTF\'s skeleton and clips without the GPU (the mannequin)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const bytes = readFileSync(join(__dirname, '..', '..', 'editor', 'public', 'assets', 'mannequin.gltf'));
    const parsed = await parseRiggedDescriptors([new File([bytes], 'mannequin.gltf')]);
    const { skin: s, animations } = riggedSkeleton(parsed, 'mannequin.gltf');
    expect(s.joints.length).toBeGreaterThan(20);
    expect(animations.length).toBeGreaterThan(0);
    const r = buildRig(s as any);
    expect(r.bySlot.has('upLeg.L') && r.bySlot.has('hand.R')).toBe(true);
  }, 60000);
});

describe('motion documents', () => {
  it('migrate a phase-1 key ease to the matching preset curve', () => {
    const d = normaliseMotion({ ...DEFAULT_MOTION, keys: [
      { id: 'a', poseId: DEFAULT_MOTION.poses[0].id, time: 0, ease: 'linear' } as any,
      { id: 'b', poseId: DEFAULT_MOTION.poses[0].id, time: 1, ease: 'overshoot' } as any,
    ] });
    expect(d.keys[1].presetId).toBe('overshoot');
    expect(d.keys[1].blend).toEqual(builtinPreset('overshoot')!.curve);
    expect((d.keys[1] as any).ease).toBeUndefined();
  });
});

describe('unskinned parts of a rigged glTF', () => {
  it('know the bone they hang from, and their offset from it', async () => {
    // A two-joint skeleton (root, hand at y=1), a skinned triangle, and an unskinned triangle under the hand.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const joints = new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const ibm = new Float32Array([...mat4.create(), ...mat4.fromTranslation(mat4.create(), [0, -1, 0])]);
    const chunks = [pos, joints, weights, ibm].map(a => new Uint8Array(a.buffer));
    const offsets: number[] = [];
    let len = 0;
    for (const c of chunks) { offsets.push(len); len += c.byteLength; }
    const bin = new Uint8Array(len);
    chunks.forEach((c, i) => bin.set(c, offsets[i]));
    const gltf = {
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 3] }],
      nodes: [
        { name: 'Root', children: [1] },
        { name: 'Hand', translation: [0, 1, 0], children: [2] },
        { name: 'Sword', mesh: 1, translation: [0, 0.5, 0] },
        { name: 'Body', mesh: 0, skin: 0 },
      ],
      skins: [{ joints: [0, 1], inverseBindMatrices: 4 }],
      meshes: [
        { name: 'Body', primitives: [{ attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 } }] },
        { name: 'Sword', primitives: [{ attributes: { POSITION: 1 } }] },
      ],
      buffers: [{ byteLength: len, uri: 'data:application/octet-stream;base64,' + Buffer.from(bin).toString('base64') }],
      bufferViews: [
        { buffer: 0, byteOffset: offsets[0], byteLength: 36 },
        { buffer: 0, byteOffset: offsets[1], byteLength: 24 },
        { buffer: 0, byteOffset: offsets[2], byteLength: 48 },
        { buffer: 0, byteOffset: offsets[3], byteLength: 128 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 3, type: 'VEC4' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
        { bufferView: 3, componentType: 5126, count: 2, type: 'MAT4' },
      ],
    };
    const parsed = await new GLTFLoader().parseDescriptorsFromFiles([new File([JSON.stringify(gltf)], 'rig.gltf')], true);
    const sword = parsed.meshes.find(m => m.name === 'Sword')!;
    const body = parsed.meshes.find(m => m.name === 'Body')!;
    expect(body.bone).toBeUndefined();
    expect(sword.bone?.node).toBe(1);
    expect(sword.bone?.name).toBe('Hand');
    // Half a unit above the hand.
    expect(sword.bone?.offset[13]).toBeCloseTo(0.5, 6);
  });
});

describe('posing in the viewport', () => {
  const idx = (n: string) => rig.byName.get(`mixamorig:${n}`)!;
  const len = (p: MotionPose, a: string, b: string) => vec3.distance(jointPosition(rig, p, idx(a)), jointPosition(rig, p, idx(b)));
  const rest = pose('rest', {});

  it('FABRIK keeps lengths, reaches a reachable target and straightens toward one out of reach', () => {
    const pts = [vec3.fromValues(0, 0, 0), vec3.fromValues(1, 0, 0), vec3.fromValues(2, 0, 0)];
    const near = fabrik(pts, [1, 1], vec3.fromValues(1, 1, 0));
    expect(vec3.distance(near[2], [1, 1, 0])).toBeLessThan(1e-3);
    expect(vec3.distance(near[0], near[1])).toBeCloseTo(1, 4);
    expect(vec3.distance(near[1], near[2])).toBeCloseTo(1, 4);
    const far = fabrik(pts, [1, 1], vec3.fromValues(0, 5, 0));
    expect(far[2][1]).toBeCloseTo(2, 5);
    expect(vec3.equals(far[0], [0, 0, 0])).toBe(true);
  });

  it('bends the arm to put the hand on the target, lengths kept, nothing else turned', () => {
    expect(chainOf(rig, idx('LeftHand'), 2).map(i => rig.bones[i].name)).toEqual(['mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand']);
    const hand = jointPosition(rig, rest, idx('LeftHand'));
    const target = vec3.add(vec3.create(), hand, [-0.1, -0.15, 0.1]);
    const posed = dragJoint(rig, rest, idx('LeftHand'), target, { chain: 0, keepLengths: true });
    expect(vec3.distance(jointPosition(rig, posed, idx('LeftHand')), target)).toBeLessThan(2e-3);
    expect(len(posed, 'LeftArm', 'LeftForeArm')).toBeCloseTo(len(rest, 'LeftArm', 'LeftForeArm'), 4);
    expect(len(posed, 'LeftForeArm', 'LeftHand')).toBeCloseTo(len(rest, 'LeftForeArm', 'LeftHand'), 4);
    expect(Object.keys(posed.bones).sort()).toEqual(['mixamorig:LeftArm', 'mixamorig:LeftForeArm']);
  });

  it('with Keep lengths off puts the joint exactly on the target and bakes the stretch', () => {
    const hand = jointPosition(rig, rest, idx('LeftHand'));
    const target = vec3.add(vec3.create(), hand, [0.1, 0.05, 0]);
    const posed = dragJoint(rig, rest, idx('LeftHand'), target, { chain: 0, keepLengths: false });
    expect(vec3.distance(jointPosition(rig, posed, idx('LeftHand')), target)).toBeLessThan(1e-4);
    expect(posed.bones['mixamorig:LeftHand'].move).toBeDefined();
    const clip = bakeMotion(rig, doc([posed], [{ id: 'a', poseId: posed.id, time: 0, ...presetBlend('linear') }, { id: 'b', poseId: posed.id, time: 1, ...presetBlend('linear') }]));
    expect(clip.channels.some(c => c.targetNodeIndex === rig.bones[idx('LeftHand')].node && c.targetPath === 'translation')).toBe(true);
    // The stretch reaches the editor and mirrors to the other hand.
    expect(editorPoseBones(rig, posed).find(b => b.name === 'mixamorig:LeftHand')?.translation).toBeDefined();
    expect(mirrorPose(rig, posed).bones['mixamorig:RightHand']?.move).toBeDefined();
  });

  it('a stretch follows its parent when the parent turns', () => {
    const hand = jointPosition(rig, rest, idx('LeftHand'));
    const stretched = dragJoint(rig, rest, idx('LeftHand'), vec3.add(vec3.create(), hand, [0.1, 0, 0]), { chain: 0, keepLengths: false });
    const turned = { ...stretched, bones: { ...stretched.bones, 'mixamorig:LeftForeArm': { rot: [0, 0, 90] as [number, number, number] } } };
    expect(len(turned, 'LeftForeArm', 'LeftHand')).toBeCloseTo(len(stretched, 'LeftForeArm', 'LeftHand'), 4);
  });

  it('dragging the hips moves the body; dragging a planted hand moves its goal', () => {
    const hips = jointPosition(rig, rest, rig.hips);
    const target = vec3.add(vec3.create(), hips, [0, -0.2, 0.05]);
    const crouched = dragJoint(rig, rest, rig.hips, target, { chain: 0, keepLengths: true });
    expect(vec3.distance(jointPosition(rig, crouched, rig.hips), target)).toBeLessThan(1e-4);
    const planted = pose('p', {}, { handL: { pos: [0.3, 1.2, 0.2] } });
    const moved = dragJoint(rig, planted, idx('LeftHand'), vec3.fromValues(0.35, 1.1, 0.25), { chain: 0, keepLengths: true });
    [0.35, 1.1, 0.25].forEach((v, i) => expect(moved.ik!.handL!.pos[i]).toBeCloseTo(v, 5));
    expect(moved.bones).toEqual({});
  });

  it('turns a bone to a model rotation (the rotate rings)', () => {
    const want = quat.setAxisAngle(quat.create(), [0, 0, 1], 0.6);
    const fore = idx('LeftForeArm');
    quat.multiply(want, want, rig.restModel.rot[fore]);
    const posed = rotateBone(rig, rest, fore, want);
    const got = modelPose(rig.bones, poseLocals(rig, posed)).rot[fore];
    // 2·acos|dot|, clamped: getAngle is NaN when float error puts the dot a hair over 1.
    expect(2 * Math.acos(Math.min(1, Math.abs(quat.dot(got, want))))).toBeLessThan(1e-3);
  });
});

describe('two-handed holds', () => {
  const idx = (n: string) => rig.byName.get(`mixamorig:${n}`)!;
  const model = (p: MotionPose) => modelPose(rig.bones, solvedPoseLocals(rig, p));
  const angle = (a: quat, b: quat) => 2 * Math.acos(Math.min(1, Math.abs(quat.dot(a, b))));
  /** Model space at time t of a baked clip. */
  const frameAt = (clip: ReturnType<typeof bakeMotion>, t: number) => modelPose(rig.bones, poseLocals(rig, poseFromClip(rig, clip as any, t)));

  it('an IK goal with a rotation gives the hand that model rotation', () => {
    const want = quat.setAxisAngle(quat.create(), [0, 1, 0], 0.8);
    quat.multiply(want, want, rig.restModel.rot[idx('RightHand')]);
    const p = pose('p', {}, { handR: { pos: [-0.35, 1.25, 0.25], rot: quatToEuler(want) } });
    const m = model(p);
    expect(vec3.distance(m.pos[idx('RightHand')], [-0.35, 1.25, 0.25])).toBeLessThan(1e-3);
    expect(angle(m.rot[idx('RightHand')], want)).toBeLessThan(1e-3);
  });

  it('a gripping hand rides the lead hand through every baked frame, between the keys too', () => {
    const lead = (pos: [number, number, number], yaw: number) => ({ pos, rot: quatToEuler(quat.multiply(quat.create(), quat.setAxisAngle(quat.create(), [0, 1, 0], yaw), rig.restModel.rot[idx('RightHand')])) });
    const a = pose('a', {}, { handR: lead([-0.3, 1.2, 0.3], 0) });
    const grip = gripFrom(rig, { ...a, ik: { ...a.ik, handL: { pos: [-0.2, 1.1, 0.3] } } }, 'handL', 'handR')!;
    expect(grip.follow).toBe('handR');
    const held = (p: MotionPose): MotionPose => ({ ...p, ik: { ...p.ik, handL: { pos: [0, 1, 0], grip } } });
    const b = pose('b', {}, { handR: lead([-0.1, 1.35, 0.2], 1.2) });
    const d = doc([held(a), held(b)], [{ id: 'k1', poseId: 'a', time: 0, ...presetBlend('linear') }, { id: 'k2', poseId: 'b', time: 1, ...presetBlend('smooth') }]);
    const clip = bakeMotion(rig, d);
    const R = idx('RightHand'), L = idx('LeftHand');
    for (let t = 0; t <= 1; t += 0.1) {
      const m = frameAt(clip, t);
      const want = vec3.add(vec3.create(), m.pos[R], vec3.transformQuat(vec3.create(), grip.offset as unknown as vec3, m.rot[R]));
      expect(vec3.distance(m.pos[L], want)).toBeLessThan(0.01);
    }
  });

  it('dragging or turning the gripping hand moves the hand it holds', () => {
    const p = pose('p', {}, { handR: { pos: [-0.3, 1.2, 0.3] }, handL: { pos: [0, 1, 0], grip: { follow: 'handR', offset: [0, 0.1, 0], rot: [0, 0, 0] } } });
    const now = jointPosition(rig, p, idx('LeftHand'));
    const dragged = dragJoint(rig, p, idx('LeftHand'), vec3.add(vec3.create(), now, [0, 0.1, 0]), { chain: 0, keepLengths: true });
    expect(dragged.ik!.handR!.pos[1]).toBeCloseTo(1.3, 4);
    expect(dragged.ik!.handL!.grip).toEqual(p.ik!.handL!.grip);
    const turned = rotateBone(rig, p, idx('LeftHand'), quat.setAxisAngle(quat.create(), [1, 0, 0], 0.5));
    expect(turned.ik!.handR!.rot).toBeDefined();
  });

  it('mirrors a held pose onto the other side', () => {
    const p = pose('p', {}, {
      handR: { pos: [-0.3, 1.2, 0.3], rot: quatToEuler(rig.restModel.rot[idx('RightHand')]) },
      handL: { pos: [0, 1, 0], grip: { follow: 'handR', offset: [0.02, 0.1, 0.01], rot: [0, 10, 0] } },
    });
    const m = mirrorPose(rig, p);
    expect(m.ik!.handL!.pos[0]).toBeCloseTo(0.3, 4);
    expect(m.ik!.handR!.grip!.follow).toBe('handL');
    // The mirrored hold puts the right hand where the mirrored left hand was.
    const a = model(p), b = model(m);
    const mirrored = vec3.clone(a.pos[idx('LeftHand')]); mirrored[0] = -mirrored[0];
    expect(vec3.distance(b.pos[idx('RightHand')], mirrored)).toBeLessThan(0.01);
  });

  it('a key may fire several events; a sidecar opens as its motion', () => {
    const p = pose('p', {});
    const d = doc([p], [{ id: 'a', poseId: 'p', time: 0, ...presetBlend() }, { id: 'b', poseId: 'p', time: 0.5, ...presetBlend(), event: 'combo, recover' }]);
    expect(bakeMotion(rig, d).events).toEqual([{ time: 0.5, name: 'combo' }, { time: 0.5, name: 'recover' }]);
    expect(motionFromFile({ generator: 'motion', creatorVersion: 1, seed: 1, params: d, output: {} })).toEqual(d);
    expect(motionFromFile(d)).toEqual(d);
    expect(motionFromFile({ generator: 'terrain', params: {} })).toBeNull();
  });
});

describe('the Valley Longsword motions (tools/soulsDemo/longsword)', () => {
  it('bake on the souls mannequin with the hands on the hilt and the events inside the clip', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..', '..', '..', 'tools', 'soulsDemo');
    const models = JSON.parse(readFileSync(join(root, 'seed', 'models.json'), 'utf8'));
    const r = buildRig(models[0].nodeJson.children[0].model.skin);
    const files = readdirSync(join(root, 'longsword')).filter(f => f.endsWith('.motion.json'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain('Souls_LS_Combo.motion.json');
    const R = r.bySlot.get('hand.R')!, L = r.bySlot.get('hand.L')!;
    for (const f of files) {
      const d = motionFromFile(JSON.parse(readFileSync(join(root, 'longsword', f), 'utf8')))!;
      const clip = bakeMotion(r, d);
      const end = clip.samplers[0].input.at(-1)!;
      expect(clip.samplers.every(s => s.output.every(Number.isFinite))).toBe(true);
      for (const e of clip.events ?? []) expect(e.time).toBeLessThanOrEqual(end);
      if (!d.loop) {
        // Each attack (a combo's segments, between its `next` events): hit, then hitEnd, then combo and recover.
        const ev = clip.events ?? [];
        const cuts = [0, ...ev.filter(e => e.name === 'next').map(e => e.time), end + 1];
        for (let k = 0; k + 1 < cuts.length; k++) {
          const seg = ev.filter(e => e.time > cuts[k] - 1e-6 && e.time < cuts[k + 1] - 1e-6 && e.name !== 'next');
          const at = (n: string) => seg.find(e => e.name === n)?.time ?? NaN;
          expect(at('hit'), `${d.name} attack ${k + 1}`).toBeLessThan(at('hitEnd'));
          expect(at('hitEnd')).toBeLessThanOrEqual(at('combo'));
          expect(at('recover')).toBeGreaterThanOrEqual(at('combo'));
        }
      }
      if (d.name === 'Souls_LS_Combo') {
        // The attacks step: the body ends the combo well forward, and a foot leaves the ground on the way.
        const hipsZ = (t: number) => modelPose(r.bones, poseLocals(r, poseFromClip(r, clip as any, t))).pos[r.hips][2];
        expect(hipsZ(end) - hipsZ(0)).toBeGreaterThan(0.7);
        const footL = r.bySlot.get('foot.L')!;
        const lifts = Array.from({ length: Math.ceil(end * 15) }, (_, k) => modelPose(r.bones, poseLocals(r, poseFromClip(r, clip as any, k / 15))).pos[footL][1]);
        expect(Math.max(...lifts) - Math.min(...lifts)).toBeGreaterThan(0.05);
      }
      const grip = d.poses[0].ik!.handL!.grip!;
      for (let t = 0; t <= end; t += 1 / 15) {
        const m = modelPose(r.bones, poseLocals(r, poseFromClip(r, clip as any, t)));
        const want = vec3.add(vec3.create(), m.pos[R], vec3.transformQuat(vec3.create(), grip.offset as unknown as vec3, m.rot[R]));
        expect(vec3.distance(m.pos[L], want), `${d.name} at ${t.toFixed(2)} s`).toBeLessThan(0.02);
      }
    }
  }, 60000);
});

describe('elbow and knee poles', () => {
  it('bends the elbow toward its pole', () => {
    const idx = (n: string) => rig.byName.get(`mixamorig:${n}`)!;
    const goal = { pos: [0.35, 1.05, 0.25] as [number, number, number] };
    const elbowX = (pole?: [number, number, number]) =>
      modelPose(rig.bones, solvedPoseLocals(rig, pose('p', {}, { handL: { ...goal, ...(pole ? { pole } : {}) } }))).pos[idx('LeftForeArm')];
    const out = elbowX([1.2, 1.2, -0.2]), down = elbowX([0.3, 0.2, 0.1]);
    expect(out[0]).toBeGreaterThan(down[0] + 0.05);
    expect(out[1]).toBeGreaterThan(down[1]);
    // Mirrored with the pose.
    const m = mirrorPose(rig, pose('p', {}, { handL: { ...goal, pole: [1.2, 1.2, -0.2] } }));
    expect(m.ik!.handR!.pole![0]).toBeCloseTo(-1.2, 4);
  });
});
