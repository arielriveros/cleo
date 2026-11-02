// The player's two-handed Longsword moveset, made with the Motion Creator.
//
//   npx vite-node --config applications/creator/vitest.config.ts tools/soulsDemo/longsword.ts bake
//   npx vite-node --config applications/creator/vitest.config.ts tools/soulsDemo/longsword.ts author
//   npx vite-node --config applications/creator/vitest.config.ts tools/soulsDemo/longsword.ts dump out.json
//
// `bake` (what the build needs): every Motion Creator document in longsword/*.motion.json is baked with the
// Creator's own baker (applications/creator/src/motion/bakeMotion.ts) on the souls mannequin's skeleton,
// into longswordClips.json -- the same clip shape as soulsClips.json, events included -- which build.mjs
// adds to the mannequin's animations (so the Valley knight plays them retargeted, like every other clip).
//
// The documents are ordinary Creator motions: open one in Cleo Creator ▸ Motion ▸ Clip ▸ Open…, edit the
// poses, keys and blend curves there, Download, and put the .motion.json back here; then `bake` again.
//
// `author` wrote their first version, and rewrites them from the choreography below (overwriting edits
// made in the Creator). Each key pose is described the way a fencer would: where the hilt is, where the
// blade points, which way the edge faces, how far the body has turned, leaned and sunk. From that, the
// right hand gets an IK goal with its rotation held (the blade's angle), the left hand a two-handed GRIP
// on the right (the Creator's IkGoal.grip: it rides the right hand every frame, so the hands never part
// mid-swing), the feet stay planted in a fencing stance, and the spine and hips carry the turn.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quat, vec3, mat3 } from 'gl-matrix';
import { buildRig, modelPose, type MotionRig } from '../../applications/creator/src/motion/motionRig';
import { bakeMotion, poseFromClip, poseLocals, solvedPoseLocals } from '../../applications/creator/src/motion/bakeMotion';
import { rotateBone } from '../../applications/creator/src/motion/poseDrag';
import {
  motionFromFile, normaliseMotion, presetBlend, quatToEuler,
  type IkGrip, type MotionDoc, type MotionKey, type MotionPose, type Vec3,
} from '../../applications/creator/src/motion/motionDoc';
import { exportMotion } from '../../applications/creator/src/motion/exportMotion';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOTIONS = join(HERE, 'longsword');
const OUT = join(HERE, 'longswordClips.json');

// --- The souls mannequin (the skeleton every souls clip is on; node indices must match the build's) ----

const models = JSON.parse(readFileSync(join(HERE, 'seed', 'models.json'), 'utf8'));
const skin = models[0].nodeJson.children[0].model.skin;
const rig: MotionRig = buildRig(skin);
const bone = (slot: string) => {
  const i = rig.bySlot.get(slot);
  if (i === undefined) throw new Error(`the mannequin has no ${slot}`);
  return i;
};

// --- The sword in the hand -----------------------------------------------------------------------
//
// build.mjs seats every weapon with grip(): at the Idle pose (the mannequin's rest), the blade points
// BLADE_OUT and the edge EDGE_DOWN in model space, the grip point sits PALM from the wrist. The same
// numbers here put the hands where that sword's hilt is.

const BLADE_OUT = vec3.normalize(vec3.create(), [0, -0.2, 1]);
const EDGE_DOWN = vec3.fromValues(0, -1, 0);
const PALM = { handR: vec3.fromValues(-0.02, -0.07, 0.03), handL: vec3.fromValues(0.02, -0.07, 0.03) };
/** How far below the right hand (toward the pommel) the left hand holds the grip, metres. */
const HANDS_APART = 0.11;
/** Blade tip from the grip point, metres (for the automatic edge direction). */
const REACH = 1.0;

/** The rotation taking +Y to `along` and +Z to `edge` (made perpendicular). */
function frame(along: ArrayLike<number>, edge: ArrayLike<number>): quat {
  const y = vec3.normalize(vec3.create(), along as vec3);
  const z = vec3.scaleAndAdd(vec3.create(), edge as vec3, y, -vec3.dot(edge as vec3, y));
  vec3.normalize(z, z);
  const x = vec3.cross(vec3.create(), y, z);
  const m = mat3.fromValues(x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]);
  return quat.normalize(quat.create(), quat.fromMat3(quat.create(), m));
}
const WEAPON_AT_REST = frame(BLADE_OUT, EDGE_DOWN);
/** Hand model rotation that holds the sword with blade frame `f`: f · rest⁻¹ · handRest. */
function handFor(limb: 'handR' | 'handL', f: quat): quat {
  const rest = rig.restModel.rot[bone(limb === 'handR' ? 'hand.R' : 'hand.L')];
  const q = quat.multiply(quat.create(), f, quat.invert(quat.create(), WEAPON_AT_REST));
  return quat.normalize(q, quat.multiply(q, q, rest));
}
/** The wrist for a hand of model rotation `r` whose grip point is at `grip`. */
function wristFor(limb: 'handR' | 'handL', r: quat, grip: vec3): vec3 {
  const rest = rig.restModel.rot[bone(limb === 'handR' ? 'hand.R' : 'hand.L')];
  const local = vec3.transformQuat(vec3.create(), PALM[limb], quat.invert(quat.create(), rest));
  return vec3.sub(vec3.create(), grip, vec3.transformQuat(vec3.create(), local, r));
}
/** The left hand's hold on the right, the same in every pose (both hands are on one rigid hilt). */
const GRIP: IkGrip = (() => {
  const f = frame([0, 0, 1], [0, -1, 0]);
  const rR = handFor('handR', f), rL = handFor('handL', f);
  const wR = wristFor('handR', rR, vec3.fromValues(0, 0, 0));
  const wL = wristFor('handL', rL, vec3.fromValues(0, 0, -HANDS_APART));
  const inv = quat.invert(quat.create(), rR);
  const off = vec3.transformQuat(vec3.create(), vec3.sub(vec3.create(), wL, wR), inv);
  const r = (x: number) => Math.round(x * 1e5) / 1e5;
  return { follow: 'handR', offset: [r(off[0]), r(off[1]), r(off[2])], rot: quatToEuler(quat.multiply(quat.create(), inv, rL)) };
})();

// --- Key poses -------------------------------------------------------------------------------------

interface Stance {
  /** Body turn about the vertical, degrees (negative: the right shoulder back). */
  yaw: number;
  /** Lean forward, degrees, spread over the spine. */
  lean: number;
  /** Side bend, degrees (positive: toward the left). */
  side?: number;
  /** How far the hips sink, metres. */
  drop: number;
  /**
   * Where the body stands, [x, z] metres: the hips' travel. The steps of an attack carry it forward, and
   * the game moves the character by it (root motion), so the planted feet stay put on the ground.
   */
  at?: [number, number];
  /**
   * The right hand's grip point, the blade's direction, and the edge's (or 'auto'). The grip point is
   * measured from where the body stands (`at`), so a pose keeps its hands as the body travels.
   */
  hilt: Vec3;
  blade: Vec3;
  edge: Vec3 | 'auto';
  /** Feet (model space): [x, z, toe yaw°, lift m] each; default the guard stance, left foot forward. */
  feet?: { L: Foot; R: Foot };
  /** How far the elbows open out to the sides, metres (default 0.5). */
  elbows?: number;
}
type Foot = [number, number, number, number?];

const STANCE_FEET = { L: [0.13, 0.2, -12] as Foot, R: [-0.17, -0.22, -48] as Foot };
/** The guard stance moved `dz` forward. */
const stanceAt = (dz: number) => ({ L: [0.13, 0.2 + dz, -12] as Foot, R: [-0.17, -0.22 + dz, -48] as Foot });
const DEG = Math.PI / 180;
const yawQ = (d: number) => quat.setAxisAngle(quat.create(), [0, 1, 0], d * DEG);
const pitchQ = (d: number) => quat.setAxisAngle(quat.create(), [1, 0, 0], d * DEG);
const rollQ = (d: number) => quat.setAxisAngle(quat.create(), [0, 0, 1], -d * DEG);

let poseCount = 0;
function makePose(name: string, s: Stance, edge: vec3): MotionPose {
  let pose: MotionPose = { id: `p${++poseCount}`, name, bones: {} };
  // The hips sink and travel; the body's turn is spread hips 40 %, spine 20 % per bone; the lean over the spine.
  const hips = rig.hips;
  const [sx, sz] = s.at ?? [0, 0];
  pose.bones[rig.bones[hips].name] = { move: [sx, -s.drop, sz] };
  const spine = [bone('spine'), rig.bones.findIndex(b => b.name === 'mixamorig1:Spine1'), bone('chest')];
  const turn = (i: number, yaw: number, lean: number, side: number) => {
    const model = modelPose(rig.bones, solvedPoseLocals(rig, pose)).rot[i];
    const q = quat.multiply(quat.create(), yawQ(yaw), quat.multiply(quat.create(), pitchQ(lean), rollQ(side)));
    pose = rotateBone(rig, pose, i, quat.multiply(q, q, model));
  };
  const side = s.side ?? 0;
  turn(hips, s.yaw * 0.4, 0, 0);
  for (const i of spine) turn(i, s.yaw * 0.2, s.lean / 3, side / 3);
  // The neck and head take the turn and lean back out: the eyes stay on the opponent ahead.
  turn(bone('neck'), -s.yaw * 0.5, -s.lean * 0.5, -side * 0.5);
  turn(bone('head'), -s.yaw * 0.5, -s.lean * 0.5, -side * 0.5);

  // Feet flat, toes turned; a stepping foot off the ground by its lift.
  const feet = s.feet ?? STANCE_FEET;
  const ik: MotionPose['ik'] = {};
  for (const [limb, slot, f] of [['footL', 'foot.L', feet.L], ['footR', 'foot.R', feet.R]] as const) {
    const i = bone(slot);
    const rot = quat.multiply(quat.create(), yawQ(f[2]), rig.restModel.rot[i]);
    ik[limb] = { pos: [f[0], rig.restModel.pos[i][1] + (f[3] ?? 0), f[1]], rot: quatToEuler(rot) };
    // Knees out over the toes.
    const out = vec3.transformQuat(vec3.create(), [limb === 'footL' ? 0.25 : -0.25, 0, 0.6], yawQ(f[2]));
    ik[limb]!.pole = [f[0] + out[0], 0.55, f[1] + out[2]];
  }
  // The hands on the hilt, the elbows open to the sides (turned with the chest).
  const f = frame(s.blade, edge);
  const rR = handFor('handR', f), rL = handFor('handL', f);
  const hilt = vec3.fromValues(s.hilt[0] + sx, s.hilt[1], s.hilt[2] + sz);
  const wrists = () => {
    const wR = wristFor('handR', rR, hilt);
    const lowGrip = vec3.scaleAndAdd(vec3.create(), hilt, vec3.normalize(vec3.create(), s.blade as unknown as vec3), -HANDS_APART);
    return [wR, wristFor('handL', rL, lowGrip)];
  };
  // As far out as the arms reach: a hilt past it comes back toward the chest until both hands make it
  // (with a hair of bend left, so the elbows still point where they are told).
  const body = modelPose(rig.bones, solvedPoseLocals(rig, pose)).pos;
  const arm = (side: 'L' | 'R') => {
    const [a, b, c] = ['upperArm', 'foreArm', 'hand'].map(n => bone(`${n}.${side}`));
    return { shoulder: body[a], reach: vec3.distance(rig.restModel.pos[a], rig.restModel.pos[b]) + vec3.distance(rig.restModel.pos[b], rig.restModel.pos[c]) };
  };
  const armR = arm('R'), armL = arm('L');
  const chestPt = vec3.lerp(vec3.create(), armR.shoulder, armL.shoulder, 0.5);
  let [wR, wL] = wrists();
  for (let k = 0; k < 40; k++) {
    const over = Math.max(vec3.distance(wR, armR.shoulder) / armR.reach, vec3.distance(wL, armL.shoulder) / armL.reach);
    if (over <= 0.96) break;
    vec3.lerp(hilt, hilt, chestPt, 0.03);
    [wR, wL] = wrists();
    if (k === 39) console.warn(`${name}: the hands cannot reach the hilt`);
  }
  const r3 = (v: ArrayLike<number>): Vec3 => [Math.round(v[0] * 1e4) / 1e4, Math.round(v[1] * 1e4) / 1e4, Math.round(v[2] * 1e4) / 1e4];
  const wide = s.elbows ?? 0.5;
  const chest = yawQ(s.yaw * 0.6);
  const elbow = (w: vec3, x: number) => r3(vec3.add(vec3.create(), w, vec3.transformQuat(vec3.create(), [x, -0.12, -0.18], chest)));
  ik.handR = { pos: r3(wR), rot: quatToEuler(rR), pole: elbow(wR, -wide) };
  ik.handL = { pos: r3(wL), rot: quatToEuler(rL), pole: elbow(wL, wide), grip: GRIP };
  return { ...pose, ik };
}

// --- Choreography ------------------------------------------------------------------------------------
//
// The character faces +Z; its right is -X. Heights in metres (the mannequin is 1.8 m; shoulders ~1.4).

/** The guard: middle guard, left foot forward, the hilt held out before the navel, point at the throat. */
const GUARD: Stance = { yaw: -24, lean: 6, drop: 0.07, hilt: [-0.04, 1.04, 0.42], blade: [0.04, 0.5, 0.87], edge: [0, -1, 0] };
/** The guard breathing in. */
const GUARD_IN: Stance = { ...GUARD, drop: 0.06, lean: 5, hilt: [-0.04, 1.055, 0.42], blade: [0.03, 0.53, 0.85] };
/** The guard carried upright, for walking and strafing (only the arms play it). */
const CARRY: Stance = { yaw: 0, lean: 0, drop: 0, hilt: [0.0, 1.02, 0.38], blade: [0.03, 0.5, 0.87], edge: [0, -1, 0] };

interface Beat { at: number; pose: string; blend?: string; event?: string }
interface Move { name: string; loop?: boolean; overlap?: number; variation?: number; poses: Record<string, Stance>; beats: Beat[] }

// The light combo: ONE clip, three attacks. Each ends on a settle key with the event `next` -- where the
// game stops it (one attack) or plays on into the next (a chain). The chain window opens as the blade
// leaves its cut (`combo` with `hitEnd`), so a press any time after the swing lands counts. Every attack steps:
//   1  a diagonal cut from the right shoulder (oberhau), the left foot stepping in        +0.24 m
//   2  the rising answer from below, the right foot passing forward (the stance switches) +0.31 m
//   3  a wide horizontal cut from the right, the left foot passing again, a lunge         +0.30 m
const S1 = 0.24, S2 = 0.55, S3 = 0.85;
const RIGHT_FWD = (dz: number) => ({ L: [0.13, -0.1 + dz, 45] as Foot, R: [-0.15, 0.2 + dz, 12] as Foot });

const COMBO: Move = {
  name: 'Souls_LS_Combo', overlap: 0.01,
  poses: {
    'Guard': GUARD,
    // 1 -- oberhau, left foot steps in
    'Wind-up 1': { yaw: -54, lean: -3, drop: 0.05, at: [0, -0.02], hilt: [-0.26, 1.4, 0.06], blade: [0.25, 0.5, -0.83], edge: [0, 1, 0.2] },
    'Cut 1': { yaw: -32, lean: 4, drop: 0.08, at: [0, 0.06], hilt: [-0.2, 1.44, 0.3], blade: [-0.2, 0.96, 0.15], edge: 'auto',
      feet: { L: [0.13, 0.32, -12, 0.08], R: STANCE_FEET.R } },
    'Strike 1': { yaw: 2, lean: 15, drop: 0.12, at: [0, 0.16], hilt: [0.0, 1.16, 0.58], blade: [-0.45, 0.25, 0.86], edge: 'auto',
      feet: { L: [0.13, 0.44, -12], R: STANCE_FEET.R } },
    'Follow-through 1': { yaw: 26, lean: 20, drop: 0.12, at: [0, 0.21], hilt: [0.28, 0.9, 0.36], blade: [0.6, -0.4, 0.5], edge: 'auto',
      feet: { L: [0.13, 0.44, -12], R: [-0.17, -0.1, -48, 0.05] } },
    'Settle 1': { yaw: 0, lean: 10, drop: 0.09, at: [0, S1], hilt: [0.08, 1.0, 0.44], blade: [0.2, 0.25, 0.95], edge: [0.2, -1, 0], feet: stanceAt(S1) },
    // 2 -- rising cut, right foot passes forward
    'Wind-up 2': { yaw: 36, lean: 12, drop: 0.1, at: [0, S1 - 0.02], hilt: [0.22, 0.96, 0.24], blade: [0.5, -0.5, -0.7], edge: [0, -1, 0.3], feet: stanceAt(S1) },
    'Cut 2': { yaw: 16, lean: 12, drop: 0.09, at: [0, S1 + 0.1], hilt: [0.14, 0.92, 0.44], blade: [0.3, -0.4, 0.86], edge: 'auto',
      feet: { L: stanceAt(S1).L, R: [-0.16, S1 + 0.18, -20, 0.1] } },
    'Strike 2': { yaw: -12, lean: 8, drop: 0.11, at: [0, S1 + 0.22], hilt: [-0.08, 1.18, 0.56], blade: [-0.55, 0.3, 0.78], edge: 'auto',
      feet: RIGHT_FWD(S2) },
    'Follow-through 2': { yaw: -42, lean: 0, drop: 0.09, at: [0, S2 - 0.03], hilt: [-0.28, 1.46, 0.3], blade: [-0.6, 0.75, -0.1], edge: 'auto', feet: RIGHT_FWD(S2) },
    'Settle 2': { yaw: -32, lean: 4, drop: 0.09, at: [0, S2], hilt: [-0.14, 1.22, 0.36], blade: [-0.2, 0.8, 0.55], edge: [0.2, 0, 1], feet: RIGHT_FWD(S2) },
    // 3 -- horizontal cut from the right, left foot passes forward into a lunge
    'Wind-up 3': { yaw: -70, lean: 2, drop: 0.09, at: [0, S2 - 0.03], hilt: [-0.34, 1.3, 0.02], blade: [0.15, 0.08, -1], edge: [-1, 0, 0], feet: RIGHT_FWD(S2) },
    'Cut 3': { yaw: -36, lean: 6, drop: 0.1, at: [0, S2 + 0.1], hilt: [-0.3, 1.26, 0.4], blade: [-0.85, 0.06, 0.5], edge: 'auto',
      feet: { L: [0.14, S2 + 0.08, -12, 0.1], R: RIGHT_FWD(S2).R } },
    'Strike 3': { yaw: 0, lean: 12, drop: 0.15, at: [0, S3 - 0.04], hilt: [0.0, 1.2, 0.6], blade: [0, 0.06, 1], edge: 'auto',
      feet: { L: [0.14, S3 + 0.22, -12], R: [-0.15, S2 + 0.2, -30] } },
    'Follow-through 3': { yaw: 38, lean: 12, drop: 0.15, at: [0, S3], hilt: [0.3, 1.14, 0.38], blade: [0.85, -0.05, 0.5], edge: 'auto',
      feet: { L: [0.14, S3 + 0.22, -12], R: [-0.17, S3 - 0.14, -48, 0.05] } },
    'Settle 3': { yaw: 18, lean: 8, drop: 0.11, at: [0, S3], hilt: [0.16, 1.06, 0.44], blade: [0.4, 0.22, 0.9], edge: [0.6, -0.8, 0],
      feet: { L: [0.14, S3 + 0.22, -12], R: [-0.17, S3 - 0.22, -48] } },
    'Guard (end)': { ...GUARD, at: [0, S3 + 0.02], feet: { L: [0.14, S3 + 0.22, -12], R: [-0.17, S3 - 0.22, -48] } },
  },
  beats: [
    { at: 0, pose: 'Guard' },
    { at: 0.28, pose: 'Wind-up 1', blend: 'easeOut' },
    { at: 0.38, pose: 'Cut 1', blend: 'easeIn', event: 'hit' },
    { at: 0.48, pose: 'Strike 1', blend: 'linear' },
    { at: 0.58, pose: 'Follow-through 1', blend: 'easeOut', event: 'hitEnd, combo' },
    { at: 0.8, pose: 'Settle 1', blend: 'smooth', event: 'recover' },
    { at: 0.9, pose: 'Settle 1', blend: 'smooth', event: 'next' },
    { at: 1.14, pose: 'Wind-up 2', blend: 'easeOut' },
    { at: 1.24, pose: 'Cut 2', blend: 'easeIn', event: 'hit' },
    { at: 1.34, pose: 'Strike 2', blend: 'linear' },
    { at: 1.44, pose: 'Follow-through 2', blend: 'easeOut', event: 'hitEnd, combo' },
    { at: 1.64, pose: 'Settle 2', blend: 'smooth', event: 'recover' },
    { at: 1.74, pose: 'Settle 2', blend: 'smooth', event: 'next' },
    { at: 2.06, pose: 'Wind-up 3', blend: 'anticipate' },
    { at: 2.2, pose: 'Cut 3', blend: 'easeIn', event: 'hit' },
    { at: 2.3, pose: 'Strike 3', blend: 'linear' },
    { at: 2.4, pose: 'Follow-through 3', blend: 'easeOut', event: 'hitEnd, combo' },
    { at: 2.64, pose: 'Settle 3', blend: 'overshoot', event: 'recover' },
    { at: 3.0, pose: 'Guard (end)', blend: 'smooth' },
  ],
};

const MOVES: Move[] = [
  {
    name: 'Souls_LS_Stance', loop: true, variation: 1.2, overlap: 0.02,
    poses: { Guard: GUARD, 'Guard (in)': GUARD_IN },
    beats: [{ at: 0, pose: 'Guard' }, { at: 1.2, pose: 'Guard (in)', blend: 'smooth' }, { at: 2.4, pose: 'Guard', blend: 'smooth' }],
  },
  {
    name: 'Souls_LS_Guard', loop: true, variation: 0.8, overlap: 0.02,
    poses: { Carry: CARRY, 'Carry (in)': { ...CARRY, hilt: [0.0, 1.032, 0.38] } },
    beats: [{ at: 0, pose: 'Carry' }, { at: 0.9, pose: 'Carry (in)', blend: 'smooth' }, { at: 1.8, pose: 'Carry', blend: 'smooth' }],
  },
  COMBO,
  {
    // Heavy: from the high guard over the head, a vertical cut straight down, the left foot stepping in deep.
    name: 'Souls_LS_Heavy', overlap: 0.012,
    poses: {
      'Guard': GUARD,
      'High guard': { yaw: -18, lean: -6, drop: 0.05, at: [0, -0.04], hilt: [-0.1, 1.6, 0.0], blade: [0.05, 0.55, -0.83], edge: [0, 1, 0.3], elbows: 0.6 },
      'Gather': { yaw: -20, lean: -9, drop: 0.07, at: [0, -0.06], hilt: [-0.1, 1.64, -0.04], blade: [0.03, 0.32, -0.95], edge: [0, 1, 0.3], elbows: 0.6 },
      'Cut': { yaw: -12, lean: 2, drop: 0.08, at: [0, 0.1], hilt: [-0.05, 1.6, 0.28], blade: [0, 1, 0.05], edge: 'auto',
        feet: { L: [0.13, 0.4, -12, 0.1], R: STANCE_FEET.R } },
      'Strike': { yaw: -4, lean: 20, drop: 0.15, at: [0, 0.3], hilt: [-0.01, 1.22, 0.6], blade: [0, 0.15, 1], edge: 'auto',
        feet: { L: [0.13, 0.65, -12], R: STANCE_FEET.R } },
      'Follow-through': { yaw: 0, lean: 30, drop: 0.19, at: [0, 0.38], hilt: [0.01, 0.82, 0.46], blade: [0.05, -0.75, 0.66], edge: 'auto',
        feet: { L: [0.13, 0.65, -12], R: [-0.17, -0.05, -48, 0.05] } },
      'Recover': { yaw: -8, lean: 24, drop: 0.16, at: [0, 0.42], hilt: [-0.01, 0.88, 0.44], blade: [0.04, -0.55, 0.83], edge: [0, -0.8, -0.6], feet: stanceAt(0.45) },
      'Guard (end)': { ...GUARD, at: [0, 0.45], feet: stanceAt(0.45) },
    },
    beats: [
      { at: 0, pose: 'Guard' },
      { at: 0.45, pose: 'High guard', blend: 'smooth' },
      { at: 0.62, pose: 'Gather', blend: 'smooth' },
      { at: 0.74, pose: 'Cut', blend: 'easeIn', event: 'hit' },
      { at: 0.84, pose: 'Strike', blend: 'linear' },
      { at: 0.94, pose: 'Follow-through', blend: 'easeOut', event: 'hitEnd' },
      { at: 1.3, pose: 'Recover', blend: 'smooth', event: 'combo, recover' },
      { at: 1.7, pose: 'Guard (end)', blend: 'smooth' },
    ],
  },
];

/** A move as a Motion Creator document. An 'auto' edge faces the way the blade's tip is travelling. */
function author(m: Move): MotionDoc {
  const tip = (s: Stance) => vec3.scaleAndAdd(vec3.create(), vec3.fromValues(s.hilt[0] + (s.at?.[0] ?? 0), s.hilt[1], s.hilt[2] + (s.at?.[1] ?? 0)), vec3.normalize(vec3.create(), s.blade as unknown as vec3), REACH);
  const order = m.beats.map(b => b.pose);
  const poses: MotionPose[] = [];
  const ids = new Map<string, string>();
  for (const [name, s] of Object.entries(m.poses)) {
    let edge: vec3;
    if (s.edge === 'auto') {
      const k = order.indexOf(name);
      const prev = m.poses[order[Math.max(0, k - 1)]], next = m.poses[order[Math.min(order.length - 1, k + 1)]];
      edge = vec3.sub(vec3.create(), tip(next), tip(prev));
    } else edge = vec3.fromValues(...s.edge);
    const p = makePose(name, s, edge);
    ids.set(name, p.id);
    poses.push(p);
  }
  const keys: MotionKey[] = m.beats.map((b, i) => ({
    id: `k${i + 1}`, poseId: ids.get(b.pose)!, time: b.at, ...presetBlend(b.blend ?? 'smooth'), ...(b.event ? { event: b.event } : {}),
  }));
  return normaliseMotion({ name: m.name, seed: 7, poses, keys, fps: 30, overlap: m.overlap ?? 0.03, variation: m.variation ?? 0, variationRate: 0.5, loop: !!m.loop });
}

// --- How well the hands hold the hilt ------------------------------------------------------------------

/** Per baked frame, how far the left hand is from where the grip puts it, and the right from its goal. */
function check(doc: MotionDoc): { grip: number; reachR: number; worst: string } {
  let grip = 0, reachR = 0, worst = '';
  for (const p of doc.poses) {
    const before = Math.max(grip, reachR);
    const m = modelPose(rig.bones, solvedPoseLocals(rig, p));
    const R = bone('hand.R'), L = bone('hand.L');
    const goalR = p.ik?.handR?.pos;
    if (goalR) reachR = Math.max(reachR, vec3.distance(m.pos[R], goalR as unknown as vec3));
    const held = vec3.add(vec3.create(), m.pos[R], vec3.transformQuat(vec3.create(), GRIP.offset as unknown as vec3, m.rot[R]));
    grip = Math.max(grip, vec3.distance(held, m.pos[L]));
    if (Math.max(grip, reachR) > before + 1e-4) worst = p.name;
  }
  return { grip, reachR, worst };
}

// --- Commands ------------------------------------------------------------------------------------------

const cmd = process.argv[2] ?? 'bake';
if (cmd === 'author') {
  mkdirSync(MOTIONS, { recursive: true });
  // Motions no longer authored here go (the old one-clip-per-attack L1-L3).
  const names = new Set(MOVES.map(m => `${m.name}.motion.json`));
  for (const f of readdirSync(MOTIONS)) if (f.endsWith('.motion.json') && !names.has(f)) unlinkSync(join(MOTIONS, f));
  for (const m of MOVES) {
    const doc = author(m);
    const c = check(doc);
    const files = exportMotion(doc, bakeMotion(rig, doc), skin, 'Mannequin');
    const side = files.find(f => f.name.endsWith('.motion.json'))!;
    writeFileSync(join(MOTIONS, side.name), new TextDecoder().decode(side.bytes) + '\n');
    console.log(`${m.name}: ${doc.poses.length} poses, ${doc.keys.length} keys; right hand off its goal ≤ ${(c.reachR * 100).toFixed(1)} cm, left hand off the grip ≤ ${(c.grip * 100).toFixed(1)} cm${c.worst && Math.max(c.grip, c.reachR) > 0.005 ? ` (worst: ${c.worst})` : ''}`);
  }
}
if (cmd === 'author' || cmd === 'bake') {
  const clips = readdirSync(MOTIONS).filter(f => f.endsWith('.motion.json')).sort().map(f => {
    const doc = motionFromFile(JSON.parse(readFileSync(join(MOTIONS, f), 'utf8')));
    if (!doc) throw new Error(`${f} is not a Motion Creator motion`);
    const clip = bakeMotion(rig, doc);
    // Four decimals: a tenth of a millimetre, a hundredth of a degree -- and a quarter of the file.
    const round = (v: number[]) => v.map(x => Math.round(x * 1e4) / 1e4);
    return { name: doc.name, samplers: clip.samplers.map(s => ({ ...s, input: round(s.input), output: round(s.output) })), channels: clip.channels, events: clip.events ?? [] };
  });
  writeFileSync(OUT, JSON.stringify(clips));
  console.log(`baked ${clips.length} clips into ${OUT}: ${clips.map(c => `${c.name} ${c.samplers[0].input.at(-1)!.toFixed(2)} s`).join(', ')}`);
}

if (cmd === 'dump') {
  // Every baked clip sampled at 15 fps: the main joints and the blade (grip point to tip), model space --
  // to look at the swings from any side without the game (a plot, a spreadsheet).
  const JOINTS = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulder.L', 'upperArm.L', 'foreArm.L', 'hand.L', 'shoulder.R', 'upperArm.R', 'foreArm.R', 'hand.R',
    'upLeg.L', 'leg.L', 'foot.L', 'toe.L', 'upLeg.R', 'leg.R', 'foot.R', 'toe.R'];
  const out: Record<string, { t: number; joints: Record<string, number[]>; blade: number[][] }[]> = {};
  for (const f of readdirSync(MOTIONS).filter(f => f.endsWith('.motion.json')).sort()) {
    const doc = motionFromFile(JSON.parse(readFileSync(join(MOTIONS, f), 'utf8')))!;
    const clip = bakeMotion(rig, doc);
    const end = clip.samplers[0].input.at(-1)!;
    const frames = [];
    for (let t = 0; t <= end + 1e-6; t += 1 / 15) {
      const m = modelPose(rig.bones, poseLocals(rig, poseFromClip(rig, clip as any, t)));
      const joints: Record<string, number[]> = {};
      for (const j of JOINTS) { const i = rig.bySlot.get(j); if (i !== undefined) joints[j] = Array.from(m.pos[i]); }
      const h = bone('hand.R'), rest = rig.restModel.rot[h];
      const toWeapon = quat.multiply(quat.create(), m.rot[h], quat.invert(quat.create(), rest));
      const grip = vec3.add(vec3.create(), m.pos[h], vec3.transformQuat(vec3.create(), PALM.handR, toWeapon));
      const along = vec3.transformQuat(vec3.create(), vec3.transformQuat(vec3.create(), [0, 1, 0], WEAPON_AT_REST), toWeapon);
      frames.push({ t, joints, blade: [Array.from(vec3.scaleAndAdd(vec3.create(), grip, along, -0.2)), Array.from(grip), Array.from(vec3.scaleAndAdd(vec3.create(), grip, along, 1.03))] });
    }
    out[doc.name] = frames;
  }
  writeFileSync(process.argv[3] ?? 'longsword-dump.json', JSON.stringify(out));
}
