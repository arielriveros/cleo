// Procedural placeholder clips for the Hollow Keep example.
//
// The mannequin ships with locomotion only, and a souls-like needs swings, a roll, a drink, flinches and
// a death. These are not meant to look good — they are meant to be DISTINCT, correctly timed, and carry
// the event markers the scripts key off (`hit`, `combo`, `recover`, `drink`, `cast`), so every mechanic
// is testable before the real animations arrive. SOULS_DEMO.md lists every one and what replaces it.
//
// ## How a pose is described
//
// Each clip is a list of keys `{ t, ...pose }`. A pose is written in the CHARACTER's model space — +Y up,
// +Z forward, the character's right is -X — because that is the only frame a person can reason about.
// The skeleton's own frames are whatever the FBX export left (the armature alone is a -90° X rotation at
// 1/100 scale), so every pose is converted here:
//
//   chest: [pitch, yaw, roll]  degrees, spread over Spine/Spine1/Spine2. +pitch bends FORWARD,
//                              +yaw twists to the character's LEFT.
//   head:  [pitch, yaw, roll]
//   aim:   { RightArm: [x,y,z], ... }  point a bone at a model-space direction (it is rotated by the
//                              shortest arc that takes its current direction — toward its child joint —
//                              onto the target). Parents first, so a forearm aims from wherever the
//                              upper arm put it.
//   hips:  [x, y, z]           metres added to the hips position (model space): a crouch is y < 0.
//   spin:  [x, y, z]           degrees applied to the WHOLE body about the hips, after everything else —
//                              the roll's somersault and the death's fall. Applied last so a tucked pose
//                              rotates as one piece.
//
// Every other bone holds its frame-0 Idle pose, so a stub is a full-body clip and plays cleanly as an
// action over locomotion. Keys interpolate linearly (the animator slerps rotations), so the roll's spin is
// keyed in steps well under 180°.

import { mat3, mat4, quat, vec3 } from 'gl-matrix'

const P = 'mixamorig1:'

/** The bone each aimable bone points TOWARD — its "length" axis. */
const AIM_CHILD = {
  RightArm: 'RightForeArm', RightForeArm: 'RightHand', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand',
  RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot',
  RightShoulder: 'RightArm', LeftShoulder: 'LeftArm',
}

const n = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l] }

// ----- reusable pose fragments ---------------------------------------------------------------------

const STANCE = { RightUpLeg: n(-0.12, -1, -0.28), LeftUpLeg: n(0.12, -1, 0.3), RightLeg: n(-0.05, -1, -0.15), LeftLeg: n(0.05, -1, 0.05) }
const LUNGE = { RightUpLeg: n(-0.12, -1, -0.5), LeftUpLeg: n(0.12, -0.85, 0.55), RightLeg: n(-0.05, -1, -0.35), LeftLeg: n(0.05, -1, 0.1) }
const TUCK = { RightUpLeg: n(-0.15, 0.3, 1), LeftUpLeg: n(0.15, 0.3, 1), RightLeg: n(-0.05, -1, -0.1), LeftLeg: n(0.05, -1, -0.1),
  RightArm: n(-0.3, -0.4, 0.85), LeftArm: n(0.3, -0.4, 0.85), RightForeArm: n(-0.1, 0.2, 1), LeftForeArm: n(0.1, 0.2, 1) }
const SIT = { RightUpLeg: n(-0.2, 0.05, 1), LeftUpLeg: n(0.2, 0.05, 1), RightLeg: n(-0.05, -1, 0.1), LeftLeg: n(0.05, -1, 0.1),
  RightArm: n(-0.25, -0.6, 0.75), LeftArm: n(0.25, -0.6, 0.75), RightForeArm: n(-0.1, -0.3, 1), LeftForeArm: n(0.1, -0.3, 1) }
const merge = (...parts) => Object.assign({}, ...parts)
const ev = (name, time) => ({ name, time })

/** Walking legs for the fog walk, alternating. */
const STRIDE_A = { RightUpLeg: n(-0.1, -1, 0.45), LeftUpLeg: n(0.1, -1, -0.35), RightLeg: n(-0.05, -1, 0.1), LeftLeg: n(0.05, -1, -0.4) }
const STRIDE_B = { RightUpLeg: n(-0.1, -1, -0.35), LeftUpLeg: n(0.1, -1, 0.45), RightLeg: n(-0.05, -1, -0.4), LeftLeg: n(0.05, -1, 0.1) }

/**
 * Every placeholder clip. Names carry the `Souls_` prefix so they can never collide with a clip the
 * mannequin already owns — a collision is silent (`addAnimation` de-dupes to `Idle (2)`).
 */
export const CLIP_SPECS = [
  // ----- straight sword: quick horizontal slashes, an overhead, a thrust ---------------------------
  {
    name: 'Souls_Sword_L1', length: 0.9,
    events: [ev('hit', 0.38), ev('combo', 0.45), ev('recover', 0.62)],
    keys: [
      { t: 0 },
      { t: 0.18, chest: [5, -40, 0], aim: merge(STANCE, { RightArm: n(-0.8, 0.3, -0.35), RightForeArm: n(-0.3, 0.6, 0.2) }) },
      { t: 0.38, chest: [10, 35, 0], aim: merge(LUNGE, { RightArm: n(0.4, 0.15, 0.9), RightForeArm: n(0.7, 0.1, 0.7) }) },
      { t: 0.55, chest: [8, 45, 0], aim: merge(LUNGE, { RightArm: n(0.9, 0, 0.3), RightForeArm: n(0.8, -0.2, -0.2) }) },
      { t: 0.9 },
    ],
  },
  {
    name: 'Souls_Sword_L2', length: 0.9,
    events: [ev('hit', 0.36), ev('combo', 0.45), ev('recover', 0.62)],
    keys: [
      { t: 0, chest: [8, 30, 0] },
      { t: 0.16, chest: [5, 40, 0], aim: merge(STANCE, { RightArm: n(0.75, 0.4, 0.3), RightForeArm: n(0.5, 0.5, -0.4) }) },
      { t: 0.36, chest: [10, -35, 0], aim: merge(LUNGE, { RightArm: n(-0.6, 0.1, 0.8), RightForeArm: n(-0.8, 0, 0.5) }) },
      { t: 0.55, chest: [8, -45, 0], aim: merge(LUNGE, { RightArm: n(-0.95, 0, 0.1), RightForeArm: n(-0.6, -0.3, -0.5) }) },
      { t: 0.9 },
    ],
  },
  {
    name: 'Souls_Sword_L3', length: 1.1,
    events: [ev('hit', 0.52), ev('combo', 0.6), ev('recover', 0.8)],
    keys: [
      { t: 0 },
      { t: 0.3, chest: [-15, -10, 0], head: [-10, 0, 0], aim: merge(STANCE, { RightArm: n(-0.2, 0.95, -0.15), RightForeArm: n(-0.1, 0.6, -0.8) }) },
      { t: 0.52, chest: [28, 0, 0], hips: [0, -0.12, 0], aim: merge(LUNGE, { RightArm: n(-0.1, -0.2, 1), RightForeArm: n(-0.05, -0.6, 0.8) }) },
      { t: 0.75, chest: [25, 0, 0], hips: [0, -0.1, 0], aim: merge(LUNGE, { RightArm: n(-0.1, -0.6, 0.8), RightForeArm: n(0, -0.9, 0.4) }) },
      { t: 1.1 },
    ],
  },
  {
    name: 'Souls_Sword_Heavy', length: 1.4,
    events: [ev('hit', 0.78), ev('recover', 1.05)],
    keys: [
      { t: 0 },
      { t: 0.5, chest: [0, -30, 0], hips: [0, -0.08, -0.05], aim: merge(STANCE, { RightArm: n(-0.45, -0.1, -0.9), RightForeArm: n(-0.1, 0.1, 1) }) },
      { t: 0.62, chest: [0, -32, 0], hips: [0, -0.1, -0.05], aim: merge(STANCE, { RightArm: n(-0.5, -0.1, -0.85), RightForeArm: n(-0.1, 0.1, 1) }) },
      { t: 0.78, chest: [15, 15, 0], hips: [0, -0.15, 0.1], aim: merge(LUNGE, { RightArm: n(-0.15, 0.05, 1), RightForeArm: n(0, 0, 1) }) },
      { t: 1.05, chest: [12, 12, 0], hips: [0, -0.12, 0.08], aim: merge(LUNGE, { RightArm: n(-0.15, 0, 1), RightForeArm: n(0, -0.1, 1) }) },
      { t: 1.4 },
    ],
  },
  // ----- greatsword: two-handed, slow and wide ------------------------------------------------------
  {
    name: 'Souls_GS_L1', length: 1.4,
    events: [ev('hit', 0.7), ev('combo', 0.85), ev('recover', 1.0)],
    keys: [
      { t: 0 },
      { t: 0.45, chest: [0, -55, 0], hips: [0, -0.08, 0], aim: merge(STANCE, {
        RightArm: n(-0.8, 0.4, -0.4), RightForeArm: n(-0.5, 0.7, -0.2), LeftArm: n(-0.6, 0.3, 0.1), LeftForeArm: n(-0.8, 0.5, 0) }) },
      { t: 0.7, chest: [12, 40, 0], hips: [0, -0.15, 0], aim: merge(LUNGE, {
        RightArm: n(0.3, 0, 1), RightForeArm: n(0.7, 0, 0.7), LeftArm: n(0.5, 0, 0.8), LeftForeArm: n(0.8, 0, 0.5) }) },
      { t: 0.95, chest: [10, 55, 0], hips: [0, -0.12, 0], aim: merge(LUNGE, {
        RightArm: n(0.9, -0.1, 0.3), RightForeArm: n(0.8, -0.3, -0.3), LeftArm: n(0.9, -0.2, -0.1), LeftForeArm: n(0.6, -0.4, -0.5) }) },
      { t: 1.4 },
    ],
  },
  {
    name: 'Souls_GS_L2', length: 1.4,
    events: [ev('hit', 0.7), ev('combo', 0.85), ev('recover', 1.0)],
    keys: [
      { t: 0, chest: [8, 40, 0] },
      { t: 0.45, chest: [0, 55, 0], hips: [0, -0.08, 0], aim: merge(STANCE, {
        RightArm: n(0.7, 0.45, 0.2), RightForeArm: n(0.6, 0.6, -0.3), LeftArm: n(0.85, 0.4, -0.2), LeftForeArm: n(0.5, 0.7, -0.4) }) },
      { t: 0.7, chest: [12, -40, 0], hips: [0, -0.15, 0], aim: merge(LUNGE, {
        RightArm: n(-0.6, 0, 0.8), RightForeArm: n(-0.8, 0, 0.5), LeftArm: n(-0.3, 0, 1), LeftForeArm: n(-0.7, 0, 0.7) }) },
      { t: 0.95, chest: [10, -55, 0], hips: [0, -0.12, 0], aim: merge(LUNGE, {
        RightArm: n(-0.95, -0.2, -0.1), RightForeArm: n(-0.6, -0.4, -0.5), LeftArm: n(-0.9, -0.1, 0.3), LeftForeArm: n(-0.8, -0.3, -0.3) }) },
      { t: 1.4 },
    ],
  },
  {
    name: 'Souls_GS_Heavy', length: 2.0,
    events: [ev('hit', 1.15), ev('recover', 1.55)],
    keys: [
      { t: 0 },
      { t: 0.8, chest: [-20, -10, 0], head: [-10, 0, 0], hips: [0, -0.05, 0], aim: merge(STANCE, {
        RightArm: n(-0.15, 1, -0.25), RightForeArm: n(0, 0.5, -0.9), LeftArm: n(0.15, 1, -0.2), LeftForeArm: n(-0.1, 0.5, -0.9) }) },
      { t: 0.95, chest: [-22, -10, 0], head: [-10, 0, 0], hips: [0, -0.05, 0], aim: merge(STANCE, {
        RightArm: n(-0.15, 1, -0.3), RightForeArm: n(0, 0.4, -0.95), LeftArm: n(0.15, 1, -0.25), LeftForeArm: n(-0.1, 0.4, -0.95) }) },
      { t: 1.15, chest: [40, 0, 0], hips: [0, -0.3, 0.1], aim: merge(LUNGE, {
        RightArm: n(-0.05, -0.4, 1), RightForeArm: n(0, -0.8, 0.5), LeftArm: n(0.1, -0.4, 1), LeftForeArm: n(-0.05, -0.8, 0.5) }) },
      { t: 1.55, chest: [35, 0, 0], hips: [0, -0.25, 0.08], aim: merge(LUNGE, {
        RightArm: n(-0.05, -0.6, 0.8), RightForeArm: n(0, -0.95, 0.2), LeftArm: n(0.1, -0.6, 0.8), LeftForeArm: n(-0.05, -0.95, 0.2) }) },
      { t: 2.0 },
    ],
  },
  // ----- evasion ------------------------------------------------------------------------------------
  {
    name: 'Souls_Roll', length: 0.7,
    events: [],
    keys: [
      { t: 0 },
      { t: 0.08, chest: [30, 0, 0], head: [25, 0, 0], hips: [0, -0.25, 0], spin: [20, 0, 0], aim: TUCK },
      { t: 0.18, chest: [40, 0, 0], head: [30, 0, 0], hips: [0, -0.45, 0], spin: [100, 0, 0], aim: TUCK },
      { t: 0.28, chest: [40, 0, 0], head: [30, 0, 0], hips: [0, -0.5, 0], spin: [180, 0, 0], aim: TUCK },
      { t: 0.38, chest: [40, 0, 0], head: [30, 0, 0], hips: [0, -0.45, 0], spin: [260, 0, 0], aim: TUCK },
      { t: 0.48, chest: [35, 0, 0], head: [25, 0, 0], hips: [0, -0.35, 0], spin: [330, 0, 0], aim: TUCK },
      { t: 0.58, chest: [20, 0, 0], hips: [0, -0.2, 0], spin: [360, 0, 0], aim: STANCE },
      { t: 0.7 },
    ],
  },
  {
    name: 'Souls_Backstep', length: 0.45,
    events: [],
    keys: [
      { t: 0 },
      { t: 0.12, chest: [-10, 0, 0], hips: [0, 0.05, 0], aim: { RightUpLeg: n(-0.1, -1, 0.3), LeftUpLeg: n(0.1, -1, 0.25), RightArm: n(-0.5, -0.8, 0.2), LeftArm: n(0.5, -0.8, 0.2) } },
      { t: 0.28, chest: [5, 0, 0], hips: [0, -0.1, 0], aim: STANCE },
      { t: 0.45 },
    ],
  },
  // ----- items and reactions --------------------------------------------------------------------------
  {
    name: 'Souls_Drink', length: 1.4,
    events: [ev('drink', 0.85)],
    keys: [
      { t: 0 },
      { t: 0.45, aim: { LeftArm: n(0.35, -0.2, 0.9), LeftForeArm: n(-0.3, 0.7, 0.5) } },
      { t: 0.85, head: [-30, 0, 0], chest: [-8, 0, 0], aim: { LeftArm: n(0.3, 0.1, 0.95), LeftForeArm: n(-0.45, 0.85, 0.1) } },
      { t: 1.05, head: [-25, 0, 0], chest: [-6, 0, 0], aim: { LeftArm: n(0.3, 0.05, 0.95), LeftForeArm: n(-0.4, 0.8, 0.2) } },
      { t: 1.4 },
    ],
  },
  {
    name: 'Souls_HitLight', length: 0.45,
    events: [],
    keys: [
      { t: 0 },
      { t: 0.1, chest: [-22, 8, 0], head: [-15, 0, 0], aim: { RightArm: n(-0.7, -0.5, -0.2), LeftArm: n(0.7, -0.5, -0.2) } },
      { t: 0.45 },
    ],
  },
  {
    name: 'Souls_HitHeavy', length: 0.9,
    events: [],
    keys: [
      { t: 0 },
      { t: 0.12, chest: [-35, -10, 5], head: [-20, 0, 0], hips: [0, -0.1, -0.1], aim: merge(STANCE, { RightArm: n(-0.8, 0.3, -0.2), LeftArm: n(0.8, 0.4, -0.2) }) },
      { t: 0.45, chest: [25, 0, 0], head: [10, 0, 0], hips: [0, -0.25, 0], aim: merge(LUNGE, { RightArm: n(-0.3, -0.8, 0.4), LeftArm: n(0.3, -0.8, 0.4) }) },
      { t: 0.9 },
    ],
  },
  {
    name: 'Souls_Swap', length: 0.4,
    events: [],
    keys: [{ t: 0 }, { t: 0.2, chest: [10, 20, 0], aim: { RightArm: n(0.45, -0.75, 0.45), RightForeArm: n(0.6, -0.6, -0.3) } }, { t: 0.4 }],
  },
  {
    name: 'Souls_Rest', length: 1.2,
    events: [],
    keys: [
      { t: 0, chest: [15, 0, 0], head: [10, 0, 0], hips: [0, -0.55, -0.1], aim: SIT },
      { t: 1.2, chest: [15, 0, 0], head: [10, 0, 0], hips: [0, -0.55, -0.1], aim: SIT },
    ],
  },
  {
    name: 'Souls_Interact', length: 0.9,
    events: [],
    keys: [
      { t: 0 },
      { t: 0.4, chest: [30, 0, 0], aim: { RightArm: n(-0.2, -0.5, 0.85), RightForeArm: n(-0.1, -0.4, 0.9) } },
      { t: 0.6, chest: [30, 0, 0], aim: { RightArm: n(-0.2, -0.75, 0.6), RightForeArm: n(-0.1, -0.8, 0.5) } },
      { t: 0.9 },
    ],
  },
  {
    name: 'Souls_Pickup', length: 0.8,
    events: [],
    keys: [
      { t: 0 },
      { t: 0.35, chest: [45, 0, 0], hips: [0, -0.35, -0.05], aim: merge(STANCE, { RightArm: n(-0.15, -0.8, 0.55), RightForeArm: n(-0.05, -0.9, 0.3) }) },
      { t: 0.5, chest: [45, 0, 0], hips: [0, -0.35, -0.05], aim: merge(STANCE, { RightArm: n(-0.15, -0.8, 0.55), RightForeArm: n(-0.05, -0.9, 0.3) }) },
      { t: 0.8 },
    ],
  },
  {
    name: 'Souls_FogWalk', length: 1.5,
    events: [],
    keys: [
      { t: 0, aim: { RightArm: n(-0.25, 0.1, 1), RightForeArm: n(-0.1, 0.2, 1) } },
      { t: 0.375, aim: merge(STRIDE_A, { RightArm: n(-0.25, 0.1, 1), RightForeArm: n(-0.1, 0.2, 1) }) },
      { t: 0.75, aim: merge(STRIDE_B, { RightArm: n(-0.25, 0.15, 1), RightForeArm: n(-0.1, 0.25, 1) }) },
      { t: 1.125, aim: merge(STRIDE_A, { RightArm: n(-0.25, 0.1, 1), RightForeArm: n(-0.1, 0.2, 1) }) },
      { t: 1.5 },
    ],
  },
  {
    name: 'Souls_Death', length: 1.5,
    events: [],
    keys: [
      { t: 0 },
      { t: 0.25, chest: [-25, 10, 0], head: [-20, 0, 0], hips: [0, -0.15, 0], aim: { RightArm: n(-0.8, 0.4, 0), LeftArm: n(0.8, 0.4, 0) } },
      { t: 0.7, chest: [-10, 0, 0], hips: [0, -0.55, -0.3], spin: [-50, 0, 0], aim: merge(TUCK, { RightArm: n(-0.9, 0, -0.2), LeftArm: n(0.9, 0, -0.2) }) },
      { t: 1.1, chest: [0, 0, 0], hips: [0, -0.82, -0.6], spin: [-88, 0, 0], aim: { RightArm: n(-0.9, 0, 0.2), LeftArm: n(0.9, 0, 0.3), RightUpLeg: n(-0.15, -1, 0.1), LeftUpLeg: n(0.2, -1, 0.2) } },
      { t: 1.5, chest: [0, 0, 0], hips: [0, -0.85, -0.6], spin: [-90, 0, 0], aim: { RightArm: n(-0.9, 0, 0.2), LeftArm: n(0.9, 0, 0.3), RightUpLeg: n(-0.15, -1, 0.1), LeftUpLeg: n(0.2, -1, 0.2) } },
    ],
  },
  // ----- enemies --------------------------------------------------------------------------------------
  {
    name: 'Souls_Enemy_Swing', length: 1.2,
    events: [ev('hit', 0.62)],
    keys: [
      { t: 0 },
      { t: 0.42, chest: [-15, -15, 0], aim: merge(STANCE, { RightArm: n(-0.3, 0.95, -0.2), RightForeArm: n(-0.1, 0.4, -0.9) }) },
      { t: 0.62, chest: [30, 5, 0], hips: [0, -0.12, 0], aim: merge(LUNGE, { RightArm: n(-0.1, -0.3, 1), RightForeArm: n(0, -0.7, 0.7) }) },
      { t: 0.85, chest: [25, 5, 0], hips: [0, -0.1, 0], aim: merge(LUNGE, { RightArm: n(-0.1, -0.7, 0.7), RightForeArm: n(0, -1, 0.2) }) },
      { t: 1.2 },
    ],
  },
  {
    name: 'Souls_Enemy_Sweep', length: 1.3,
    events: [ev('hit', 0.7)],
    keys: [
      { t: 0 },
      { t: 0.45, chest: [5, -55, 0], hips: [0, -0.1, 0], aim: merge(STANCE, { RightArm: n(-0.85, 0.3, -0.4), RightForeArm: n(-0.5, 0.5, -0.3) }) },
      { t: 0.7, chest: [10, 45, 0], hips: [0, -0.15, 0], aim: merge(LUNGE, { RightArm: n(0.4, 0, 0.95), RightForeArm: n(0.8, 0, 0.6) }) },
      { t: 0.9, chest: [8, 60, 0], hips: [0, -0.12, 0], aim: merge(LUNGE, { RightArm: n(0.95, 0, 0.2), RightForeArm: n(0.7, -0.2, -0.4) }) },
      { t: 1.3 },
    ],
  },
  {
    name: 'Souls_Enemy_Overhead', length: 1.7,
    events: [ev('hit', 1.05)],
    keys: [
      { t: 0 },
      { t: 0.45, chest: [-20, -5, 0], head: [-10, 0, 0], aim: merge(STANCE, { RightArm: n(-0.2, 1, -0.3), RightForeArm: n(0, 0.4, -0.9), LeftArm: n(0.2, 1, -0.25), LeftForeArm: n(0, 0.4, -0.9) }) },
      { t: 0.9, chest: [-25, -5, 0], head: [-12, 0, 0], aim: merge(STANCE, { RightArm: n(-0.2, 1, -0.35), RightForeArm: n(0, 0.35, -0.95), LeftArm: n(0.2, 1, -0.3), LeftForeArm: n(0, 0.35, -0.95) }) },
      { t: 1.05, chest: [40, 0, 0], hips: [0, -0.3, 0.1], aim: merge(LUNGE, { RightArm: n(-0.1, -0.4, 1), RightForeArm: n(0, -0.8, 0.5), LeftArm: n(0.1, -0.4, 1), LeftForeArm: n(0, -0.8, 0.5) }) },
      { t: 1.35, chest: [35, 0, 0], hips: [0, -0.25, 0.1], aim: merge(LUNGE, { RightArm: n(-0.1, -0.7, 0.7), RightForeArm: n(0, -1, 0.1), LeftArm: n(0.1, -0.7, 0.7), LeftForeArm: n(0, -1, 0.1) }) },
      { t: 1.7 },
    ],
  },
  {
    name: 'Souls_Enemy_Thrust', length: 1.2,
    events: [ev('hit', 0.55)],
    keys: [
      { t: 0 },
      { t: 0.3, chest: [0, -30, 0], hips: [0, -0.1, -0.05], aim: merge(STANCE, { RightArm: n(-0.5, -0.1, -0.85), RightForeArm: n(-0.1, 0.1, 1) }) },
      { t: 0.55, chest: [15, 15, 0], hips: [0, -0.18, 0.12], aim: merge(LUNGE, { RightArm: n(-0.1, 0.05, 1), RightForeArm: n(0, 0, 1) }) },
      { t: 0.85, chest: [12, 12, 0], hips: [0, -0.15, 0.1], aim: merge(LUNGE, { RightArm: n(-0.1, 0, 1), RightForeArm: n(0, -0.1, 1) }) },
      { t: 1.2 },
    ],
  },
  {
    name: 'Souls_Cast', length: 1.2,
    events: [ev('cast', 0.7)],
    keys: [
      { t: 0 },
      { t: 0.4, chest: [-8, 25, 0], aim: merge(STANCE, { LeftArm: n(0.45, 0.8, -0.35), LeftForeArm: n(0.2, 0.9, 0.2) }) },
      { t: 0.7, chest: [10, -12, 0], aim: merge(LUNGE, { LeftArm: n(0.15, 0.25, 1), LeftForeArm: n(0.05, 0.15, 1) }) },
      { t: 0.95, chest: [8, -10, 0], aim: merge(LUNGE, { LeftArm: n(0.15, 0.15, 1), LeftForeArm: n(0.05, 0.05, 1) }) },
      { t: 1.2 },
    ],
  },
  {
    name: 'Souls_Roar', length: 2.0,
    events: [],
    keys: [
      { t: 0 },
      { t: 0.4, chest: [-28, 0, 0], head: [-30, 0, 0], hips: [0, -0.12, 0], aim: merge(STANCE, { RightArm: n(-0.9, 0.35, 0.1), LeftArm: n(0.9, 0.35, 0.1), RightForeArm: n(-0.7, 0.7, 0), LeftForeArm: n(0.7, 0.7, 0) }) },
      { t: 1.6, chest: [-30, 0, 0], head: [-32, 0, 0], hips: [0, -0.12, 0], aim: merge(STANCE, { RightArm: n(-0.9, 0.4, 0.1), LeftArm: n(0.9, 0.4, 0.1), RightForeArm: n(-0.7, 0.7, 0), LeftForeArm: n(0.7, 0.7, 0) }) },
      { t: 2.0 },
    ],
  },
  {
    name: 'Souls_Leap', length: 1.8,
    events: [ev('hit', 1.25)],
    keys: [
      { t: 0 },
      { t: 0.4, chest: [30, 0, 0], hips: [0, -0.4, 0], aim: merge(TUCK, { RightUpLeg: n(-0.2, -0.6, 0.8), LeftUpLeg: n(0.2, -0.6, 0.8), RightArm: n(-0.4, -0.3, -0.85), LeftArm: n(0.4, -0.3, -0.85) }) },
      { t: 0.75, chest: [-15, 0, 0], hips: [0, 0.6, 0], aim: merge(TUCK, { RightArm: n(-0.1, 1, 0.1), LeftArm: n(0.1, 1, 0.1), RightForeArm: n(0, 1, -0.2), LeftForeArm: n(0, 1, -0.2) }) },
      { t: 1.05, chest: [-10, 0, 0], hips: [0, 0.5, 0], aim: merge(TUCK, { RightArm: n(-0.1, 1, -0.1), LeftArm: n(0.1, 1, -0.1), RightForeArm: n(0, 0.8, -0.5), LeftForeArm: n(0, 0.8, -0.5) }) },
      { t: 1.25, chest: [45, 0, 0], hips: [0, -0.4, 0.15], aim: merge(LUNGE, { RightArm: n(-0.2, -0.7, 0.7), LeftArm: n(0.2, -0.7, 0.7), RightForeArm: n(0, -1, 0.2), LeftForeArm: n(0, -1, 0.2) }) },
      { t: 1.5, chest: [40, 0, 0], hips: [0, -0.35, 0.1], aim: merge(LUNGE, { RightArm: n(-0.2, -0.8, 0.6), LeftArm: n(0.2, -0.8, 0.6) }) },
      { t: 1.8 },
    ],
  },
]

// =====================================================================================================
// The solver
// =====================================================================================================

/**
 * Build every clip in CLIP_SPECS against a skin (the mannequin's serialized skin) and its Idle clip.
 * Returns clips in the engine's `{ name, samplers, channels, events }` shape.
 */
export function buildPlaceholderClips(skin, idleClip) {
  const rig = describeRig(skin, idleClip)
  return CLIP_SPECS.map(spec => buildClip(rig, idleClip, spec))
}

function describeRig(skin, idle) {
  const names = new Map(skin.nodeNames)
  const parents = new Map(skin.nodeParents)
  const byName = new Map([...names].map(([i, name]) => [name, i]))

  // Rest local TRS for every node, overridden by Idle frame 0 where Idle animates it.
  const local = new Map()
  for (const [i, m] of skin.nodeTransforms) {
    const t = vec3.create(), r = quat.create(), s = vec3.create()
    mat4.getTranslation(t, m); mat4.getScaling(s, m)
    const pure = mat4.clone(m)
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= s[c]
    mat4.getRotation(r, pure); quat.normalize(r, r)
    local.set(i, { t, r, s })
  }
  for (const channel of idle.channels) {
    const sampler = idle.samplers[channel.samplerIndex]
    const entry = local.get(channel.targetNodeIndex)
    if (!entry) continue
    const o = sampler.output
    if (channel.targetPath === 'translation') vec3.set(entry.t, o[0], o[1], o[2])
    else if (channel.targetPath === 'rotation') quat.normalize(entry.r, quat.set(entry.r, o[0], o[1], o[2], o[3]))
    else if (channel.targetPath === 'scale') vec3.set(entry.s, o[0], o[1], o[2])
  }

  // Parents before children.
  const depth = (i) => { let d = 0; let p = parents.get(i); while (p !== undefined) { d++; p = parents.get(p) } return d }
  const order = [...local.keys()].sort((a, b) => depth(a) - depth(b))
  const id = (bone) => {
    const i = byName.get(P + bone)
    if (i === undefined) throw new Error(`the mannequin has no bone ${P + bone}`)
    return i
  }
  return { names, parents, local, order, id }
}

/** Solve one pose to a map node -> { r: quat, t: vec3 } of LOCAL values. */
function solvePose(rig, pose) {
  const loc = new Map()
  for (const [i, e] of rig.local) loc.set(i, { t: vec3.clone(e.t), r: quat.clone(e.r), s: vec3.clone(e.s) })
  const world = new Map()

  const localMat = (i) => {
    const e = loc.get(i)
    return mat4.fromRotationTranslationScale(mat4.create(), e.r, e.t, e.s)
  }
  const parentWorld = (i) => {
    const p = rig.parents.get(i)
    return p === undefined ? mat4.create() : world.get(p)
  }
  const rotOf = (m) => {
    const s = vec3.create(); mat4.getScaling(s, m)
    const pure = mat4.clone(m)
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= s[c]
    return quat.normalize(quat.create(), mat4.getRotation(quat.create(), pure))
  }
  /** Rotate node `i` by a MODEL-space delta, given its parent's world matrix. */
  const applyDelta = (i, delta) => {
    const pw = rotOf(parentWorld(i))
    const e = loc.get(i)
    // newLocal = inv(Pw) * D * Pw * local
    const q = quat.multiply(quat.create(), quat.invert(quat.create(), pw), delta)
    quat.multiply(q, q, pw)
    quat.multiply(e.r, q, e.r)
    quat.normalize(e.r, e.r)
  }

  const deltaEuler = (deg) => quat.fromEuler(quat.create(), deg[0], deg[1], deg[2])
  const chest = pose.chest ?? null
  const head = pose.head ?? null
  const aims = pose.aim ?? {}
  const spineIds = new Set(['Spine', 'Spine1', 'Spine2'].map(rig.id))
  const headId = rig.id('Head')
  const hipsId = rig.id('Hips')
  const aimIds = new Map(Object.keys(aims).map(bone => [rig.id(bone), bone]))

  // Hips offset first: a model-space vector converted into the hips' parent space.
  if (pose.hips) {
    const pw = mat4.invert(mat4.create(), worldOfChain(rig, loc, rig.parents.get(hipsId)))
    const v = vec3.transformMat3(vec3.create(), vec3.fromValues(...pose.hips), mat3.fromMat4(mat3.create(), pw))
    vec3.add(loc.get(hipsId).t, loc.get(hipsId).t, v)
  }

  for (const i of rig.order) {
    world.set(i, mat4.multiply(mat4.create(), parentWorld(i), localMat(i)))
    let changed = false
    if (chest && spineIds.has(i)) { applyDelta(i, deltaEuler(chest.map(x => x / 3))); changed = true }
    if (head && i === headId) { applyDelta(i, deltaEuler(head)); changed = true }
    if (aimIds.has(i)) {
      const bone = aimIds.get(i)
      const childId = rig.id(AIM_CHILD[bone])
      if (changed) world.set(i, mat4.multiply(mat4.create(), parentWorld(i), localMat(i)))
      const childT = loc.get(childId).t
      const current = vec3.transformMat3(vec3.create(), childT, mat3.fromMat4(mat3.create(), world.get(i)))
      vec3.normalize(current, current)
      const target = vec3.normalize(vec3.create(), vec3.fromValues(...aims[bone]))
      applyDelta(i, quat.rotationTo(quat.create(), current, target))
      changed = true
    }
    if (changed) world.set(i, mat4.multiply(mat4.create(), parentWorld(i), localMat(i)))
  }

  // The whole-body spin, last, about the hips.
  if (pose.spin) {
    world.clear()
    const pwm = worldOfChain(rig, loc, rig.parents.get(hipsId))
    const pw = rotOf(pwm)
    const e = loc.get(hipsId)
    const q = quat.multiply(quat.create(), quat.invert(quat.create(), pw), deltaEuler(pose.spin))
    quat.multiply(q, q, pw)
    quat.multiply(e.r, q, e.r)
    quat.normalize(e.r, e.r)
  }
  return loc
}

function worldOfChain(rig, loc, index) {
  if (index === undefined) return mat4.create()
  const e = loc.get(index)
  const m = mat4.fromRotationTranslationScale(mat4.create(), e.r, e.t, e.s)
  return mat4.multiply(mat4.create(), worldOfChain(rig, loc, rig.parents.get(index)), m)
}

function buildClip(rig, idle, spec) {
  const poses = spec.keys.map(k => ({ t: k.t, loc: solvePose(rig, k) }))
  const times = poses.map(p => +p.t.toFixed(4))
  const samplers = []
  const channels = []
  const hipsId = rig.id('Hips')

  for (const channel of idle.channels) {
    const node = channel.targetNodeIndex
    if (!rig.local.has(node)) continue
    let input, output
    if (channel.targetPath === 'rotation') {
      input = times
      output = []
      let prev = null
      for (const p of poses) {
        const q = quat.clone(p.loc.get(node).r)
        // Keep consecutive keys in the same hemisphere so the slerp takes the short way.
        if (prev && quat.dot(prev, q) < 0) quat.scale(q, q, -1)
        output.push(...round(q))
        prev = q
      }
    } else if (channel.targetPath === 'translation') {
      if (node === hipsId) {
        input = times
        output = poses.flatMap(p => round(p.loc.get(node).t))
      } else {
        input = [0, spec.length]
        const t = round(rig.local.get(node).t)
        output = [...t, ...t]
      }
    } else if (channel.targetPath === 'scale') {
      input = [0, spec.length]
      const s = round(rig.local.get(node).s)
      output = [...s, ...s]
    } else continue
    samplers.push({ input, output, interpolation: 'LINEAR' })
    channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: node, targetPath: channel.targetPath })
  }

  const clip = { name: spec.name, samplers, channels }
  if (spec.events.length) clip.events = spec.events.map(e => ({ time: e.time, name: e.name }))
  return clip
}

function round(values) {
  return Array.from(values, v => Math.round(v * 1e6) / 1e6)
}
