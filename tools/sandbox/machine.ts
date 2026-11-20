// The Sandbox animator: the "Locomotion" blend space and the "Mannequin Locomotion" state machine, as data.
//
// Everything that decides a pose is here, and every number that has to match a clip comes from measuring it
// (clips.ts / measure.ts). The Character node publishes moveDir, isJumping and turnRequest, the engine measures
// planarSpeed, isGrounded, airTime, verticalSpeed and isDecelerating, and SandboxPlayer.ts adds what only the game
// knows (hasMoveInput, sprinting, the lean...); all of them are LINKED parameters, read by the machine itself every
// frame. Nothing here is set from a script.
//
// The shape follows Advanced Locomotion System v4: Idle and a looking-direction locomotion blend while grounded,
// turn-in-place clips while idle, a stop, a jump entered at take-off, a fall loop, and a soft or hard landing
// chosen while still in the air. And the car: getting in, driving and getting out, the one part entered by TRIGGERS
// (EnterCar, ExitCar), which SandboxPlayer fires by name as the Car hands it the seat or takes it back.

import type { AnimationCondition, AnimationConditionGroup, AnimationLayer, AnimationState, AnimationStateMachine, AnimationTransition } from '../../src/animation/animator'
import { poseSampleKey, type AnimationField, type AnimationFieldSample } from '../../src/animation/animationField'
import type { AnimationPose } from '../../src/animation/animationPose'
import type { Skin } from '../../src/animation/animatedModel'
import type { MadeClip } from './clips'
import { LOOK_PITCH, LOOK_SAMPLES, LOOK_YAW } from './clips'
import { AIM_PITCHES, AIM_YAWS } from './weapons/layers'
import type { WeaponKind } from './weapons/models'
import { clipSeconds, impactTime, plants } from './measure'
import { motionConfig } from '../../src/physics/motion'

type Node = AnimationCondition | AnimationConditionGroup
const all = (...children: Node[]): AnimationConditionGroup => ({ op: 'and', children })
const any = (...children: Node[]): AnimationConditionGroup => ({ op: 'or', children })
const gt = (param: string, value: number, hysteresis = 0): AnimationCondition => ({ param, op: 'gt', value, ...(hysteresis ? { hysteresis } : {}) })
const lt = (param: string, value: number, hysteresis = 0): AnimationCondition => ({ param, op: 'lt', value, ...(hysteresis ? { hysteresis } : {}) })
const eq = (param: string, value: number): AnimationCondition => ({ param, op: 'eq', value })
const neq = (param: string, value: number): AnimationCondition => ({ param, op: 'neq', value })
const yes = (param: string): AnimationCondition => ({ param, op: 'true' })
const no = (param: string): AnimationCondition => ({ param, op: 'false' })

interface EdgeOptions { blend: number; stay?: number; exit?: number }
const edge = (from: string, to: string, condition: AnimationConditionGroup | null, o: EdgeOptions): AnimationTransition => ({
    from, to, conditions: [],
    ...(condition ? { condition } : {}),
    blendTime: o.blend,
    ...(o.stay ? { minDwell: o.stay } : {}),
    ...(o.exit !== undefined ? { hasExitTime: true, exitTime: o.exit } : { hasExitTime: false }),
})

/** The triggers that put the character into the car and take it out (SandboxPlayer's enterTrigger and exitTrigger). */
export const CAR_TRIGGERS = { enter: 'EnterCar', exit: 'ExitCar' } as const

/** Speeds the machine's thresholds and the character's tuning are built from, all measured. */
export interface Speeds {
    walk: number
    jog: number
    sprint: number
    /** Share of a gait's speed the character travels at straight back (SandboxPlayer's backScale). */
    back: number
    /** ... and diagonally back, jogging (the back-diagonal clip's own speed) and walking (backDiagonalScale, walkBackDiagonalScale). */
    jogDiagonal: number
    walkDiagonal: number
    /** Seconds of air a level jump at the Character's jumpSpeed lasts. */
    physicsAir: number
    /** The Character's acceleration, m/s2. */
    acceleration: number
    /** The acceleration a sprint takes off at from a standstill (the start clip's own; SandboxPlayer's sprintTakeoff). */
    takeoff?: number
}

/**
 * The hand-over from the start into the run: the clip it would rather leave on a plant with this much of it still
 * to play (seconds), and how long the blend into the run is. The Mixamo start has one plant, 0.12 s from its end,
 * so the blend outlasts the clip and holds its last frame for the rest: measured, that slides the feet no more than a
 * 0.1 s blend does (the planted foot is the one the lock holds), and the start eases into the run instead of
 * cutting to it.
 */
const START_HANDOVER = 0.25, START_HANDOVER_BLEND = 0.3

export const RUN_SPEED_GATE = 2.5

/**
 * The measured speed Idle -> Start waits for, m/s: above what a body pushed along a wall it runs into reads
 * (0.08), so running into a wall does not set the start off and stop it again, over and over.
 */
export const START_GATE = 0.12

/**
 * Seconds from the body setting off to the frame Idle -> Start fires, at 60 frames a second. `planarSpeed` is
 * the body's speed smoothed (the engine's motion time constant), so it crosses the gate a few frames late; the
 * Start state starts its clip that far in, or the clip's push-off would trail the body and its feet slide.
 */
export function startEntryDelay(acceleration: number, fps = 60): number {
    const k = 1 - Math.exp(-1 / fps / motionConfig().tau)
    let v = 0, measured = 0
    for (let n = 1; n < fps; n++) {
        v += acceleration / fps
        measured += (v - measured) * k
        if (measured > START_GATE) return n / fps
    }
    return 0
}

/**
 * A cross-fade out of a clip on one of its plants: short, since the poses match there, and over before the clip
 * runs out (a clip holding its last frame under a moving body slides its feet at the body's speed).
 */
const plantBlend = (exit: number, seconds: number, speed: number) => Math.round(Math.min(0.2, Math.max(0.06, (1 - exit) * seconds / speed)) * 1000) / 1000

/**
 * The blend space: Direction (moveDir, wrapping) x Speed (planarSpeed). Each sample sits where the character
 * travels when it plays (its gait's speed, eased for the backward direction as SandboxPlayer eases it), plays at
 * the rate that makes its feet cover exactly that (a strafe authored at 4.33 m/s, at a 4.19 jog, plays 3%
 * slower), and is phase-shifted so `phaseFoot` plants at phase 0 in every sample: the phase a clip state enters
 * it at (see MachineTimings).
 */
export function locomotionField(clips: Map<string, MadeClip>, speeds: Speeds, phaseFoot: 'L' | 'R'): AnimationField & { samples: any[] } {
    const heading: Record<string, number> = { F: 0, L: 90, R: -90, B: 180, BL: 135, BR: -135 }
    const gait: Record<string, number> = { Creep: speeds.walk / 2, Walk: speeds.walk, Brisk: speeds.jog * speeds.jogDiagonal, Jog: speeds.jog, Sprint: speeds.sprint }
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    const samples: any[] = []
    for (const [name, made] of clips) {
        const m = /^(Creep|Walk|Brisk|Jog|Sprint)(F|L|R|B|BL|BR)$/.exec(name)
        if (!m) continue
        const share = m[2] === 'B' ? speeds.back : m[2].length === 2 ? (m[1] === 'Jog' ? speeds.jogDiagonal : speeds.walkDiagonal) : 1
        const speed = gait[m[1]] * share
        const rate = speed / made.m.speed
        // Phase 0 of the field is the same foot's plant in every sample.
        const strike = phaseFoot === 'L' ? made.m.strikeL : made.m.strikeR
        const phase = strike === null ? 0 : (strike % 1 + 1) % 1
        samples.push({
            clipName: name, x: heading[m[2]], y: r3(speed),
            ...(Math.abs(rate - 1) > 0.005 ? { rateScale: r3(rate) } : {}),
            ...(phase > 0.01 && phase < 0.99 ? { phaseOffset: r3(phase) } : {}),
        })
    }
    return {
        mode: '2d',
        xAxis: { name: 'Direction', min: -180, max: 180, wrap: true, smoothing: 0.03, deadzone: 0 },
        // GroundSpeed, unsmoothed physics speed: only a touch of smoothing for contact noise, since any lag reads a
        // body speeding up or braking as slower or faster than it is, and its feet slide by the difference.
        yAxis: { name: 'Speed', min: 0, max: Math.ceil(speeds.sprint * 10) / 10, smoothing: 0.03 },
        // The weights follow the probe quickly: every lag between the body's travel and the legs is foot slide.
        weightSmoothing: 0.04,
        samples,
    }
}

/**
 * The stair clips' rate: they are slow, steep climbs (23 cm risers), played a quarter faster, at one step a tread.
 * The Character slows to the pace that gives (SandboxPlayer's stair speeds), so the feet keep to the treads.
 */
export const STAIR_RATE = 1.25

/** The stair paces, horizontal m/s: walking and running, up and down (descending's fallback when its clips fail). */
export interface StairPaces { upWalk: number; upRun: number; downWalk: number; downRun: number }

/**
 * What a flight is walked and run at, horizontally: each stair clip's steps a second at `STAIR_RATE`, one tread a
 * step. A direction whose clips were left out (`stairCheck`) keeps the pace the clips it would have had suggest.
 */
export function stairPaces(clips: Map<string, MadeClip>, tread: number): StairPaces {
    const pace = (name: string) => { const c = clips.get(name); return c?.stairs ? r3(STAIR_RATE * c.stairs.stepsPerSecond * tread) : null }
    return {
        upWalk: pace('StairsUpWalk') ?? 0.55, upRun: pace('StairsUpRun') ?? 1.25,
        downWalk: pace('StairsDownWalk') ?? 0.8, downRun: pace('StairsDownRun') ?? 1.88,
    }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000

/**
 * The flights' blend space: 2D, Climb (the script's `stairs`: +1 up, -1 down) x Speed (the body's ground speed). Up
 * and down a creep, a walk and a run, each at the speed its steps cover at one tread a step and `STAIR_RATE`, and
 * phase-shifted so `phaseFoot` plants at phase 0, as in the Locomotion blend space: the two hand over in step (their
 * states share a sync group), and turning round on a flight blends the climb into the descent inside it. Null when
 * no stair clip passed (clips.ts stairCheck); `up` / `down` say which directions it has.
 */
export function stairsField(clips: Map<string, MadeClip>, phaseFoot: 'L' | 'R', tread: number): (AnimationField & { up: boolean; down: boolean }) | null {
    const samples: any[] = []
    const has = { Up: false, Down: false }
    for (const [dir, x] of [['Up', 1], ['Down', -1]] as const) for (const gait of ['Creep', 'Walk', 'Run']) {
        const made = clips.get(`Stairs${dir}${gait}`)
        if (!made?.stairs) continue
        const T = clipSeconds(made.clip)
        // The foot's plant: where a window of it starts, not the one the clip opens inside (a stance carried over its loop).
        const starts = (made.clip.footLocks?.[phaseFoot === 'L' ? 'foot.L' : 'foot.R'] ?? []).map(([a]) => a)
        const plant = starts.find(a => a > 0.01 * T) ?? starts[0] ?? 0
        const phase = ((plant / T) % 1 + 1) % 1
        if (gait !== 'Creep') has[dir] = true
        samples.push({
            clipName: made.clip.name, x, y: r3(STAIR_RATE * made.stairs.stepsPerSecond * tread), rateScale: STAIR_RATE,
            ...(phase > 0.01 && phase < 0.99 ? { phaseOffset: r3(phase) } : {}),
        })
    }
    if (!has.Up && !has.Down) return null
    const top = Math.max(...samples.map(s => s.y))
    return {
        mode: '2d',
        // The climb is -1, 0 or +1: smoothed, so a turn round on the flight blends the one into the other.
        xAxis: { name: 'Climb', min: -1, max: 1, smoothing: 0.15 },
        yAxis: { name: 'Speed', min: 0, max: Math.ceil(top * 10) / 10, smoothing: 0.03 },
        weightSmoothing: 0.04,
        samples,
        up: has.Up, down: has.Down,
    }
}

const variable = (name: string, varName: string, varType: 'number' | 'boolean', source: 'variable' | 'builtin') =>
    ({ name, type: 'variable' as const, default: varType === 'number' ? 0 : false, variable: { nodeRef: 'parent', varName, varType, source } })

/** The bone mask the lean layers play through. */
export interface LeanMask { id: string; weights: Record<string, number> }

/**
 * Where the machine hands over between clips and the blend space, measured off the clips. Normalized clip time
 * unless it says seconds.
 *
 * A clip state always enters the blend space at phase 0, so phase 0 is made one foot's plant in every sample
 * (`phaseFoot`) and a clip hands over to it on that foot's plant: the legs carry straight on instead of swapping
 * under the blend. The foot is the one the start's last stride plants, since the start into the sprint is the
 * hand-over everyone sees.
 */
export interface MachineTimings {
    phaseFoot: 'L' | 'R'
    /** Start -> Locomotion: the start's last plant of `phaseFoot`. */
    startExit: number
    /** RunTurnL/R -> Locomotion: the plant of `phaseFoot` nearest the end of the turn. */
    runTurnExit: Record<string, number>
    /** LandRun -> Locomotion: the first plant of `phaseFoot` after the impact (null: none, wait out the impact). */
    landRunExit: number | null
    /** LandRoll -> Locomotion: where the roll is up enough to run on (`handOver`, measured on the clip). */
    landRollExit: number
    /** Seconds from touchdown to the end of each landing's impact (the hips' lowest point, plus 0.1 s). */
    impact: Record<string, number>
    /** Each stop's settle: its last foot plant plus 0.15 s. */
    settle: Record<string, number>
    /** The stop that plants the OTHER foot first, played in the field's first half (where that foot swings), and its twin. */
    stopEarly: string
    stopLate: string
}

export function machineTimings(clips: Map<string, MadeClip>, skin: Skin): MachineTimings {
    const clip = (name: string) => { const c = clips.get(name); if (!c) throw new Error(`no clip ${name}`); return c }
    const seconds = (name: string) => clipSeconds(clip(name).clip)
    const planted = new Map<string, { L: number[]; R: number[] }>()
    const plantsOf = (name: string) => { if (!planted.has(name)) planted.set(name, plants(skin, clip(name).clip)); return planted.get(name)! }
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    // The start hands over to the run on the latest plant that still leaves START_HANDOVER s of the clip to blend
    // over (the clip must not run out under the blend), of whichever foot: that foot is the field's phase 0. With no
    // such plant, the last one.
    const startPlants = plantsOf('Start'), startT = seconds('Start'), startRate = clip('Start').rate ?? 1
    const latestPlant = (maxShare: number) => {
        let best: { side: 'L' | 'R'; t: number } | null = null
        for (const side of ['L', 'R'] as const) for (const t of startPlants[side])
            if (t / startT >= 0.4 && t / startT <= maxShare && (!best || t > best.t)) best = { side, t }
        return best
    }
    const handOver = latestPlant(1 - START_HANDOVER * startRate / startT) ?? latestPlant(0.97)
    const phaseFoot: 'L' | 'R' = handOver?.side ?? 'R'
    const startLast = handOver?.t ?? -1
    const plantsIn = (name: string, from: number, to: number) => {
        const T = seconds(name)
        return plantsOf(name)[phaseFoot].map(t => t / T).filter(x => x >= from && x <= to)
    }
    const turnExit = (name: string) => Math.min(0.99, clip(name).turnDone ?? 1)
    const impact: Record<string, number> = {}
    for (const [state, name] of [['JumpLand', 'JumpLand'], ['LandRun', 'JumpRunLand'], ['LandSoft', 'LandSoft'], ['LandHard', 'LandHard']])
        impact[state] = r3(Math.min(seconds(name), impactTime(skin, clip(name).clip) + 0.1))
    const settle: Record<string, number> = {}
    for (const name of ['Stop', 'StopMirror']) {
        const p = plantsOf(name), T = seconds(name)
        const last = Math.max(...p.L, ...p.R, 0.7 * T)
        settle[name] = r3(Math.min(0.98, (last + 0.15) / T))
    }
    // In the field's first half the other foot swings: the stop that plants it first.
    const first = (name: string) => { const p = plantsOf(name); return (p.L[0] ?? Infinity) <= (p.R[0] ?? Infinity) ? 'L' : 'R' }
    const stopEarly = first('Stop') !== phaseFoot ? 'Stop' : 'StopMirror'
    const runTurnExit: Record<string, number> = {}
    for (const name of ['RunTurnL', 'RunTurnR']) {
        const done = turnExit(name)
        const near = plantsIn(name, done - 0.2, 0.97).sort((a, b) => Math.abs(a - done) - Math.abs(b - done))[0]
        runTurnExit[name] = r3(near ?? done)
    }
    const landRun = plantsIn('JumpRunLand', impact.LandRun / seconds('JumpRunLand'), 0.97)[0]
    const landRoll = clip('LandRoll').handOver ?? 0.9
    return {
        phaseFoot,
        startExit: r3(startLast >= 0 ? startLast / startT : 0.85),
        runTurnExit,
        landRunExit: landRun === undefined ? null : r3(landRun),
        landRollExit: r3(landRoll),
        impact,
        settle,
        stopEarly,
        stopLate: stopEarly === 'Stop' ? 'StopMirror' : 'Stop',
    }
}

/**
 * The Look blend space: the nine look poses (see `lookClip`) over the aim's yaw off the body (x, left +) and its
 * pitch (y, down +), clamped to the range they span.
 */
export function lookField(): AnimationField {
    return {
        mode: '2d',
        xAxis: { name: 'Yaw', min: -LOOK_YAW, max: LOOK_YAW, smoothing: 0.08 },
        yAxis: { name: 'Pitch', min: -LOOK_PITCH, max: LOOK_PITCH, smoothing: 0.08 },
        weightSmoothing: 0.05,
        // Each pose clip is rest at its first frame (the additive reference) and posed after it: sampled half way
        // in, and never moving on (the state plays at speed 0), so the phase never wraps back to that first frame.
        // Looping, it did, every 2 s, and the head snapped toward centre for three frames.
        samples: LOOK_SAMPLES.map(([clipName, x, y]) => ({ clipName, x, y, phaseOffset: 0.5 })),
    }
}

/** A link to a pose: its Pose asset and its id there. */
export interface PoseLink { assetId: string; poseId: string }
/** A pose sample of a blend space (the editor embeds `pose` from `poseRef`). */
const poseSample = (ref: PoseLink, x: number, y: number): AnimationFieldSample => ({ clipName: poseSampleKey(ref.poseId), x, y, poseRef: { ...ref } })

/**
 * A weapon's carry: a blend space of its POSES over the base layer's walk axes (`field`, the Locomotion one), the
 * Carry pose where the walk plays any clip but the sprint's, the Sprint pose where it sprints, so the weapon goes down
 * as the legs speed up into a sprint. Poses are held: no rate, no phase, nothing to keep in step with the legs. Plus
 * the Carry pose at speed 0 under each direction, where the walk has nothing.
 */
export function poseField(field: AnimationField, carry: PoseLink, sprint: PoseLink, sprintClip = 'SprintF'): AnimationField {
    const xs = [...new Set(field.samples.map(s => s.x))]
    return {
        ...field,
        samples: [
            ...field.samples.map(s => poseSample(s.clipName === sprintClip ? sprint : carry, s.x, s.y ?? 0)),
            ...xs.map(x => poseSample(carry, x, 0)),
        ],
    }
}

/**
 * A weapon's aim blend space: the aim's directions (variants of its Aim pose: weapons/layers.ts) over its yaw off the
 * body (x, left +) and pitch (y, down +). On the additive aim layer each adds what it changes from Aim.
 */
export function aimField(directions: { yaw: number; pitch: number; ref: PoseLink }[]): AnimationField {
    return {
        mode: '2d',
        xAxis: { name: 'Yaw', min: AIM_YAWS[0], max: AIM_YAWS[AIM_YAWS.length - 1], smoothing: 0.05 },
        yAxis: { name: 'Pitch', min: AIM_PITCHES[0], max: AIM_PITCHES[AIM_PITCHES.length - 1], smoothing: 0.05 },
        weightSmoothing: 0.03,
        samples: directions.map(d => poseSample(d.ref, d.yaw, d.pitch)),
    }
}

/** A blend space the machine plays, and its asset's id. */
export interface FieldRef { field: AnimationField; fieldId: string }
/** A pose a state holds: the link, and the pose embedded (resolved). */
export interface PoseStateRef { poseRef: PoseLink; pose: AnimationPose }

/**
 * How Steady (`AnimationState.meshSpace`) each hold is: how much of its own chest turn it keeps over the hips. Carried,
 * the weapon keeps over half the stride's sway and the lean into a run; aimed, it holds nearly still.
 */
export const WEAPON_STEADY = { carry: 0.5, aim: 0.85 }

/** A weapon's layers: carrying and aiming it, its aim, and (the pistol) its support hand. */
export interface WeaponLayerSpec {
    mask: LeanMask
    /** The Carry and Sprint poses over the walk (`poseField`). */
    carry: FieldRef
    /** The poses themselves: Carry (the support hand's layer holds it) and Aim. */
    carryPose: PoseStateRef
    aim: PoseStateRef
    aimOffset: FieldRef
    aimMask: LeanMask
    support?: { mask: LeanMask }
}

/** The stairs' blend space the machine plays (`stairsField`), its asset id, and which directions it has. */
export interface StairField {
    field: AnimationField
    fieldId: string
    up: boolean
    down: boolean
}

/** The sync group the gait cycles hand over in (AnimationState.syncGroup): the walk blend space and the stairs'. */
export const GAIT_SYNC = 'Gait'

export function stateMachine(clips: Map<string, MadeClip>, field: AnimationField, fieldId: string, speeds: Speeds, lean: LeanMask, timing: MachineTimings,
    look: { mask: LeanMask; field: AnimationField; fieldId: string }, stairs: StairField | null = null,
    weapons: Record<WeaponKind, WeaponLayerSpec> | null = null): AnimationStateMachine {
    const clip = (name: string) => { const c = clips.get(name); if (!c) throw new Error(`no clip ${name}`); return c }
    const jumpAir = clip('JumpAir'), runAir = clip('JumpRunAir')
    // Air clips play so their touchdown comes a little after the physics one on level ground: the landing
    // state then always takes over from the same pose, at the moment the feet really touch.
    const airSpeed = (c: MadeClip) => Math.min(1.2, Math.max(0.5, (c.touchdown! - c.takeoff!) / (speeds.physicsAir * 1.1)))
    const turnExit = (name: string) => Math.min(0.99, clip(name).turnDone ?? 1)
    const startRate = Math.round((clip('Start').rate ?? 1) * 1000) / 1000
    const rollRate = clip('LandRoll').rate ?? 1
    const seconds = (name: string) => clipSeconds(clip(name).clip)

    const state = (name: string, clipName: string, x: number, y: number, extra: Partial<AnimationState> = {}): AnimationState =>
        ({ name, clipName, loop: false, speed: 1, x, y, ...extra })

    const states: AnimationState[] = [
        // No foot locking standing still (in Idle and its turns in place): the idle's own small weight shifts are
        // not to be pinned, and a turn's clip plants its own feet. A foot held as a run stops fades back out.
        state('Idle', 'Idle', 300, 260, { loop: true, isEntry: true, footLock: false }),
        // Foot placement at the weight SandboxPlayer writes: full at a walk, light at a run, where the solver would
        // pull the lower foot down to the ground in the flight phase between strides.
        { name: 'Locomotion', clipName: '', fieldId, field, fieldInputs: { x: 'Direction', y: 'GroundSpeed' }, loop: true, speed: 1, ikWeightParam: 'FootPlacement', syncGroup: GAIT_SYNC, x: 640, y: 260 },
        state('Turn90L', 'Turn90L', 60, 60, { footLock: false }), state('Turn90R', 'Turn90R', 300, 40, { footLock: false }),
        state('Turn180L', 'Turn180L', 60, 140, { footLock: false }), state('Turn180R', 'Turn180R', 540, 60, { footLock: false }),
        // The run-to-stop and its mirror: whichever plants the foot that is swinging when the player lets go.
        state('Stop', 'Stop', 520, 420), state('StopMirror', 'StopMirror', 700, 420),
        // The sprint start, played at the rate that matches its push-off to the Character's acceleration, from as
        // far in as the body has got by the time the measured speed lets the state in.
        state('Start', 'Start', 470, 140, { speed: startRate, startTime: Math.round(startRate * startEntryDelay(speeds.takeoff ?? speeds.acceleration) * 1000) / 1000 }),
        // The running turn: its root motion turns the body (the script holds facing still meanwhile).
        state('RunTurnL', 'RunTurnL', 860, 140), state('RunTurnR', 'RunTurnR', 860, 380),
        state('JumpStand', 'JumpAir', 300, 520, { speed: Math.round(airSpeed(jumpAir) * 1000) / 1000, ikWeight: 0 }),
        state('JumpRun', 'JumpRunAir', 760, 520, { speed: Math.round(airSpeed(runAir) * 1000) / 1000, ikWeight: 0 }),
        state('Fall', 'Fall', 540, 680, { loop: true, ikWeight: 0 }),
        state('FallFar', 'Fall', 540, 820, { loop: true, speed: 1.25, ikWeight: 0 }),
        state('JumpLand', 'JumpLand', 120, 680),
        state('LandRun', 'JumpRunLand', 900, 680),
        state('LandSoft', 'LandSoft', 300, 820),
        state('LandHard', 'LandHard', 760, 900, { holdMovement: true }),
        // A far fall while running rolls instead, carried on by the run's own speed.
        state('LandRoll', 'LandRoll', 940, 900, { speed: rollRate }),
        // The car. Entered by its triggers from whatever is playing; getting in and out are root motion (they carry the
        // Character from the door to the Seat and back, its body out of the world meanwhile), driving holds still on
        // the Seat. No feet planted or placed: the car's floor is not the ground the feet would look for.
        state('CarEnter', 'CarEnter', 1300, 120, { triggers: [{ trigger: CAR_TRIGGERS.enter, blendTime: 0.3 }], footLock: false, ikWeight: 0, holdMovement: true }),
        state('CarDrive', 'CarDrive', 1300, 260, { loop: true, footLock: false, ikWeight: 0, holdMovement: true }),
        state('CarExit', 'CarExit', 1300, 400, { triggers: [{ trigger: CAR_TRIGGERS.exit, blendTime: 0.25 }], footLock: false, ikWeight: 0, holdMovement: true }),
    ]
    // Up and down a flight: the stairs' blend space (Climb x Speed), in step with the walk's (one sync group), the
    // feet on the treads at full weight whatever the pace and planted by the clips' windows at any height (the upper
    // foot stands a riser above the lower one), and played a little faster while the body still slows onto the
    // flight (StairRate, SandboxPlayer), so the steps keep up with it.
    if (stairs) states.push({
        name: 'Stairs', clipName: '', fieldId: stairs.fieldId, field: stairs.field, fieldInputs: { x: 'Stairs', y: 'GroundSpeed' }, loop: true, speed: 1,
        speedScaleParam: 'StairRate', ikWeight: 1, plantInWindows: true, syncGroup: GAIT_SYNC, x: 1080, y: 260,
    })
    // On a flight the way its blend space has clips for: up and down, or the one direction that passed.
    const onFlight = !stairs ? null : stairs.up && stairs.down ? neq('Stairs', 0) : eq('Stairs', stairs.up ? 1 : -1)
    const offFlight = !stairs ? null : stairs.up && stairs.down ? eq('Stairs', 0) : neq('Stairs', stairs.up ? 1 : -1)

    const moving = gt('Speed', 0.15, 0.2)
    const stopped = lt('Speed', 0.15, 0.2)
    const fast = gt('Speed', RUN_SPEED_GATE)
    const leftGround = all(no('Grounded'), gt('AirTime', 0.1))
    const T: AnimationTransition[] = []
    const grounded = ['Idle', 'Locomotion', 'Stop', 'StopMirror', 'Start', 'RunTurnL', 'RunTurnR', 'Turn90L', 'Turn90R', 'Turn180L', 'Turn180R', 'JumpLand', 'LandRun', 'LandSoft', 'LandHard', 'LandRoll', ...(stairs ? ['Stairs'] : [])]
    const forward = all(gt('MoveAngle', -45), lt('MoveAngle', 45))
    const turns: [string, number][] = [['Turn90R', 1], ['Turn180R', 2], ['Turn90L', -1], ['Turn180L', -2]]
    /** Every grounded state's way into the air: a jump (running or standing) or a fall, blended in gently. */
    const airborne = (from: string, stay = 0) => {
        T.push(edge(from, 'JumpRun', all(yes('Jumping'), fast), { blend: 0.08, stay }))
        T.push(edge(from, 'JumpStand', all(yes('Jumping')), { blend: 0.08, stay }))
        T.push(edge(from, 'Fall', leftGround, { blend: 0.35 }))
    }

    // Idle
    T.push(edge('Idle', 'JumpStand', all(yes('Jumping')), { blend: 0.08 }))
    T.push(edge('Idle', 'Fall', leftGround, { blend: 0.35 }))
    // Setting off on a flight: straight up or down it (Stairs is the script's climb direction while on one).
    if (onFlight) T.push(edge('Idle', 'Stairs', all(yes('MoveInput'), moving, onFlight), { blend: 0.25 }))
    // A sprint set off roughly the way the body faces, and really moving (not pushing against a wall), starts with
    // the start clip; a walk or a jog, or a sprint off to the side or back, goes straight into the blend. Never on
    // a flight, which is climbed at the stairs' pace.
    T.push(edge('Idle', 'Start', all(yes('Sprinting'), forward, gt('Speed', START_GATE), no('OnStairs')), { blend: 0.25 }))
    // ALS's "should move": asking to move, and moving. (Not "or moving fast": a teleport reads as a burst of speed.)
    T.push(edge('Idle', 'Locomotion', all(yes('MoveInput'), moving), { blend: 0.25 }))
    // Not before a blend into Idle (out of a stop or a landing) is over: a turn cutting it would pop.
    for (const [t, code] of turns) T.push(edge('Idle', t, all(eq('Turn', code)), { blend: 0.25, stay: 0.4 }))

    // Locomotion
    airborne('Locomotion')
    // Onto a flight, up or down it: in step, the stride carried across (the sync group).
    if (onFlight) T.push(edge('Locomotion', 'Stairs', all(onFlight), { blend: 0.3 }))
    // The running turn: the script holds RunTurn (-1 left, +1 right) while a sprint reverses.
    T.push(edge('Locomotion', 'RunTurnL', all(eq('RunTurn', -1)), { blend: 0.12 }))
    T.push(edge('Locomotion', 'RunTurnR', all(eq('RunTurn', 1)), { blend: 0.12 }))
    // The stop, from a jog (a sprint brakes through the blend space to a jog first, so the clip's travel fits), on
    // the foot that is swinging: phase 0 is one foot's plant, so in the field's first half the other foot swings.
    const stop = all(no('MoveInput'), yes('Decelerating'), fast, lt('Speed', speeds.jog * 1.1), gt('Direction', -45), lt('Direction', 45), no('OnStairs'))
    T.push(edge('Locomotion', timing.stopLate, stop, { blend: 0.25, stay: 0.25, exit: 0.5 }))
    T.push(edge('Locomotion', timing.stopEarly, stop, { blend: 0.25, stay: 0.25 }))
    T.push(edge('Locomotion', 'Idle', all(stopped), { blend: 0.35, stay: 0.1 }))

    // Turns (the Turning group): each plays its turn out; the group's ways out, a jump or a fall or moving off,
    // interrupt any of them.
    for (const [t] of turns) T.push(edge(t, 'Idle', null, { blend: 0.25, exit: turnExit(t) }))
    T.push(edge('Turning', 'JumpStand', all(yes('Jumping')), { blend: 0.08 }))
    T.push(edge('Turning', 'Fall', leftGround, { blend: 0.35 }))
    if (onFlight) T.push(edge('Turning', 'Stairs', all(yes('MoveInput'), moving, onFlight), { blend: 0.2 }))
    T.push(edge('Turning', 'Locomotion', all(yes('MoveInput'), moving), { blend: 0.2 }))

    // Start: into the run on its last plant (of the field's phase-0 foot), or out of it as soon as the player lets go,
    // stops sprinting or is stopped by a wall, or reaches a flight.
    airborne('Start')
    if (onFlight) T.push(edge('Start', 'Stairs', all(onFlight), { blend: 0.25 }))
    T.push(edge('Start', timing.stopEarly, all(no('MoveInput'), fast), { blend: 0.25 }))
    T.push(edge('Start', 'Idle', all(no('MoveInput')), { blend: 0.3 }))
    T.push(edge('Start', 'Idle', all(lt('Speed', 0.3)), { blend: 0.3, stay: 0.25 }))
    T.push(edge('Start', 'Locomotion', all(no('Sprinting')), { blend: 0.25 }))
    // On the hand-over plant, easing into the run (START_HANDOVER_BLEND) rather than cutting to it.
    T.push(edge('Start', 'Locomotion', null, { blend: START_HANDOVER_BLEND, exit: timing.startExit }))

    // Running turns (the Running Turn group): back into the run on a plant as each turn ends; the group's ways out,
    // the air, a stop, the script letting go, for both.
    for (const t of ['RunTurnL', 'RunTurnR'])
        T.push(edge(t, 'Locomotion', null, { blend: plantBlend(timing.runTurnExit[t], seconds(t), 1), exit: timing.runTurnExit[t] }))
    airborne('Running Turn')
    T.push(edge('Running Turn', 'Idle', all(no('MoveInput'), stopped), { blend: 0.3 }))
    T.push(edge('Running Turn', 'Locomotion', all(eq('RunTurn', 0)), { blend: 0.25, stay: 0.25 }))

    // Stops (the Stopping group): back into the run if the player pushes again; else they plant and settle, then
    // cross-fade into Idle, or straight into a turn in place if the camera is already round.
    for (const s of ['Stop', 'StopMirror']) {
        T.push(edge(s, 'Locomotion', all(yes('MoveInput')), { blend: 0.3, stay: 0.15 }))
        for (const [t, code] of turns) T.push(edge(s, t, all(eq('Turn', code)), { blend: 0.3, exit: timing.settle[s] }))
        T.push(edge(s, 'Idle', null, { blend: 0.4, exit: timing.settle[s] }))
    }
    airborne('Stopping')

    // In the air. Never land on Grounded straight out of a jump: the ground still reads as touched for a moment
    // after take-off. `Jumping` goes false only once the feet are really down. A jump that outlasts its clip (off
    // a ledge) blends into the fall from the clip's last frames.
    T.push(edge('JumpStand', 'JumpLand', all(no('Jumping')), { blend: 0.08, stay: 0.15 }))
    T.push(edge('JumpStand', 'Fall', null, { blend: 0.4, exit: 0.97 }))
    T.push(edge('JumpRun', 'LandRun', all(no('Jumping')), { blend: 0.08, stay: 0.15 }))
    T.push(edge('JumpRun', 'Fall', null, { blend: 0.4, exit: 0.97 }))
    // Every fall lands with a landing clip: the running one when it lands moving, the soft one standing.
    T.push(edge('Fall', 'LandRun', all(yes('Grounded'), gt('Speed', 1.5)), { blend: 0.1, stay: 0.1 }))
    T.push(edge('Fall', 'LandSoft', all(yes('Grounded')), { blend: 0.1, stay: 0.1 }))
    // Decided in the air: the measured vertical speed is smoothed, so its value on the landing frame is not a
    // fair reading. No way back, or the smoothed speed decaying after impact would pick the soft landing.
    T.push(edge('Fall', 'FallFar', all(lt('VerticalSpeed', -6.2, 0.6)), { blend: 0.4 }))
    // A far fall lands hard, unless the player is still running: then it rolls (tried first).
    T.push(edge('FallFar', 'LandRoll', all(yes('Grounded'), yes('Running'), gt('Speed', 1.5)), { blend: 0.08 }))
    T.push(edge('FallFar', 'LandHard', all(yes('Grounded')), { blend: 0.08 }))

    // Landings (the Landing group): each plays through its impact before a move can take over; the hard one holds
    // the character still until the player pushes the stick (its speed is 0 meanwhile, so speed cannot say). The
    // way back into the air is the group's.
    for (const l of ['JumpLand', 'LandRun', 'LandSoft', 'LandHard']) {
        // The running landing is short (the running jump's last 0.3 s): out of it before it runs out.
        const runOut = Math.max(0.1, Math.min(timing.impact.LandRun, seconds('JumpRunLand') - 0.1))
        const out = l === 'LandHard' ? { blend: 0.3, stay: Math.max(0.6, timing.impact[l]) }
            : l === 'LandRun' && timing.landRunExit !== null ? { blend: plantBlend(timing.landRunExit, seconds('JumpRunLand'), 1), exit: timing.landRunExit }
            : l === 'LandRun' ? { blend: 0.1, stay: runOut }
            : { blend: 0.3, stay: timing.impact[l] }
        T.push(edge(l, 'Locomotion', l === 'LandHard' ? all(yes('MoveInput')) : all(gt('Speed', 0.5, 0.4)), out))
        T.push(edge(l, 'Idle', null, { blend: 0.3, exit: 1 }))
    }
    // The roll: back into the run as it gets up, while the stick is pushed (a blend long enough to stand it up into
    // the stride); else it plays out into Idle.
    const rollExit = timing.landRollExit
    T.push(edge('LandRoll', 'Locomotion', all(yes('MoveInput')), { blend: 0.3, exit: rollExit }))
    T.push(edge('LandRoll', 'Idle', null, { blend: 0.3, exit: 1 }))
    airborne('Landing', 0.1)

    // Stairs: off the flight at the top or the bottom, or crossing it (or going a way its blend space has no clips
    // for), back into the walk blend in step; stopped on it (its way along it kept), Idle. Turning round on it stays
    // in the state: its blend space turns the climb into the descent. Into the air like any.
    if (stairs) {
        T.push(edge('Stairs', 'Idle', all(stopped), { blend: 0.35, stay: 0.1 }))
        T.push(edge('Stairs', 'Locomotion', all(offFlight!), { blend: 0.3, stay: 0.2 }))
        airborne('Stairs')
    }
    // The car: seated once in (at the clip's very end, so all of its travel has carried the Character), and back on
    // its feet once out. Nothing else leaves these states: their group (Car) has no transitions of its own, and the
    // machine has no Any State.
    T.push(edge('CarEnter', 'CarDrive', null, { blend: 0.4, exit: 1 }))
    T.push(edge('CarExit', 'Idle', null, { blend: 0.3, exit: 1 }))
    for (const s of grounded) if (!states.some(x => x.name === s)) throw new Error(`no state ${s}`)

    return {
        parameters: [
            variable('Direction', 'moveDir', 'number', 'variable'),
            variable('Speed', 'planarSpeed', 'number', 'builtin'),
            variable('GroundSpeed', 'groundSpeed', 'number', 'variable'),
            variable('Turn', 'turnRequest', 'number', 'variable'),
            variable('Jumping', 'isJumping', 'boolean', 'variable'),
            variable('MoveInput', 'hasMoveInput', 'boolean', 'variable'),
            { ...variable('FootPlacement', 'footPlacement', 'number', 'variable'), default: 1 },
            variable('Running', 'running', 'boolean', 'variable'),
            variable('Sprinting', 'sprinting', 'boolean', 'variable'),
            variable('MoveAngle', 'moveAngle', 'number', 'variable'),
            variable('RunTurn', 'runTurn', 'number', 'variable'),
            variable('LeanLeft', 'leanLeft', 'number', 'variable'),
            variable('LeanRight', 'leanRight', 'number', 'variable'),
            variable('LeanForward', 'leanForward', 'number', 'variable'),
            variable('LookYaw', 'lookYaw', 'number', 'variable'),
            variable('LookPitch', 'lookPitch', 'number', 'variable'),
            variable('LookWeight', 'lookWeight', 'number', 'variable'),
            ...(weapons ? [
                variable('PistolWeight', 'pistolWeight', 'number', 'variable'),
                variable('PistolSupport', 'pistolSupport', 'number', 'variable'),
                variable('RifleWeight', 'rifleWeight', 'number', 'variable'),
                variable('PistolAimWeight', 'pistolAimWeight', 'number', 'variable'),
                variable('RifleAimWeight', 'rifleAimWeight', 'number', 'variable'),
                variable('Aiming', 'aiming', 'boolean', 'variable'),
                variable('AimYaw', 'aimYaw', 'number', 'variable'),
                variable('AimPitch', 'aimPitch', 'number', 'variable'),
            ] : []),
            variable('Grounded', 'isGrounded', 'boolean', 'builtin'),
            variable('AirTime', 'airTime', 'number', 'builtin'),
            variable('VerticalSpeed', 'verticalSpeed', 'number', 'builtin'),
            variable('Decelerating', 'isDecelerating', 'boolean', 'builtin'),
            variable('OnStairs', 'onStairs', 'boolean', 'variable'),
            variable('Stairs', 'stairs', 'number', 'variable'),
            { ...variable('StairRate', 'stairRate', 'number', 'variable'), default: 1 },
            { name: CAR_TRIGGERS.enter, type: 'trigger', default: false },
            { name: CAR_TRIGGERS.exit, type: 'trigger', default: false },
        ] as any,
        states,
        transitions: T,
        // The graph's groups: each drawn as one node; a transition from a group fires from any of its states.
        groups: [
            { name: 'Turning', states: turns.map(([t]) => t), x: 80, y: 120 },
            { name: 'Stopping', states: ['Stop', 'StopMirror'], x: 470, y: 440 },
            { name: 'Running Turn', states: ['RunTurnL', 'RunTurnR'], x: 880, y: 260 },
            { name: 'Air', states: ['JumpStand', 'JumpRun', 'Fall', 'FallFar'], x: 300, y: 620 },
            { name: 'Landing', states: ['JumpLand', 'LandRun', 'LandSoft', 'LandHard', 'LandRoll'], x: 680, y: 620 },
            // Getting in, driving, getting out: drawn as one node (its triggers enter it from anywhere).
            { name: 'Car', states: ['CarEnter', 'CarDrive', 'CarExit'], x: 1080, y: 520 },
        ],
        events: [],
        // Weight shifting into a change of direction (ALS's lean): an additive tilt of the whole body about the
        // ground under it, masked to the bones it moves, one layer each way, their weights written by SandboxPlayer
        // from the sideways acceleration. Under them the weapons held (their override goes first, so the lean tilts
        // the weapon with the body), and over them the weapons' aims and the look.
        layers: [
            ...(weapons ? weaponHolds(weapons) : []),
            ...['Left', 'Right', 'Forward'].map(side => ({
                name: `Lean ${side}`, blend: 'additive' as const, weightParam: `Lean${side}`,
                maskId: lean.id, mask: { ...lean.weights },
                states: [{ name: `Lean ${side}`, clipName: `Lean${side}`, loop: false, speed: 1, isEntry: true, x: 300, y: 200 }],
                transitions: [],
            })),
            ...(weapons ? (['pistol', 'rifle'] as const).map(kind => weaponAim(kind, weapons[kind])) : []),
            // ALS's look-at: the trunk and head turned toward where the camera faces, a blend space of look poses
            // added over the pose, at the weight SandboxPlayer writes (up while idle, down while moving).
            {
                name: 'Look', blend: 'additive' as const, weightParam: 'LookWeight',
                maskId: look.mask.id, mask: { ...look.mask.weights },
                // Speed 0: a blend of held poses, not a cycle (see lookField).
                states: [{ name: 'Look', clipName: '', fieldId: look.fieldId, field: look.field, fieldInputs: { x: 'LookYaw', y: 'LookPitch' }, loop: true, speed: 0, isEntry: true, x: 300, y: 200 }],
                transitions: [],
            },
        ],
    }
}

const WEAPON_LAYER = { pistol: 'Pistol', rifle: 'Rifle' } as const
/** The cross-fades into and out of aiming, seconds. */
export const AIM_BLEND = { in: 0.2, out: 0.25 }

/**
 * The weapons held: one override layer each, at the weight SandboxPlayer writes (only the weapon in the hands has
 * any), and the pistol's support hand on its own layer (it lets go at a sprint). Each holds its POSES (Pose assets,
 * edited in the editor): carried, the Carry and Sprint poses over the walk (`poseField`); aimed, the Aim pose. Steady
 * keeps the chest the pose's over whatever the legs do (walking, running, on a flight), and the hand IK keeps the
 * left hand where the pose has it on the weapon whatever the aim layer above does to the right.
 */
function weaponHolds(weapons: Record<WeaponKind, WeaponLayerSpec>): AnimationLayer[] {
    const out: AnimationLayer[] = []
    const holding = (name: string, ref: PoseStateRef, y: number, steady: number, extra: Partial<AnimationState> = {}): AnimationState => ({
        name, clipName: '', poseRef: { ...ref.poseRef }, pose: ref.pose, loop: true, speed: 1, ...(steady > 0 ? { meshSpace: steady } : {}), x: 300, y, ...extra,
    })
    const aiming = (): AnimationTransition[] => [
        edge('Carry', 'Aim', all(yes('Aiming')), { blend: AIM_BLEND.in }),
        edge('Aim', 'Carry', all(no('Aiming')), { blend: AIM_BLEND.out }),
    ]
    for (const kind of ['pistol', 'rifle'] as const) {
        const w = weapons[kind]
        const states: AnimationState[] = [
            {
                name: 'Carry', clipName: '', fieldId: w.carry.fieldId, field: w.carry.field, fieldInputs: { x: 'Direction', y: 'GroundSpeed' },
                loop: true, speed: 1, meshSpace: WEAPON_STEADY.carry, isEntry: true, x: 300, y: 160,
            },
            holding('Aim', w.aim, 320, WEAPON_STEADY.aim),
        ]
        out.push({
            name: WEAPON_LAYER[kind], blend: 'override', weightParam: `${WEAPON_LAYER[kind]}Weight`, maskId: w.mask.id, mask: { ...w.mask.weights },
            states, transitions: aiming(),
            // The rifle is held in both hands by this layer: its left hand is kept on it.
            ...(w.support ? {} : { handIk: { hand: 'left' as const } }),
        })
        if (w.support) {
            // The pistol's support hand: its own layer, holding the same poses (the left arm is all its mask lets
            // through), so its hand IK measures the left hand on the pistol as those poses have it.
            out.push({
                name: 'Pistol Support', blend: 'override', weightParam: 'PistolSupport', maskId: w.support.mask.id, mask: { ...w.support.mask.weights },
                states: [holding('Carry', w.carryPose, 160, 0, { isEntry: true }), holding('Aim', w.aim, 320, 0)],
                transitions: aiming(),
                handIk: { hand: 'left' },
            })
        }
    }
    return out
}

/** A weapon's aim: its aim directions added over the hold (each what it changes from Aim), at the weight SandboxPlayer writes. */
function weaponAim(kind: WeaponKind, w: WeaponLayerSpec): AnimationLayer {
    return {
        name: `${WEAPON_LAYER[kind]} Aim`, blend: 'additive', weightParam: `${WEAPON_LAYER[kind]}AimWeight`,
        maskId: w.aimMask.id, mask: { ...w.aimMask.weights },
        states: [{ name: 'Aim', clipName: '', fieldId: w.aimOffset.fieldId, field: w.aimOffset.field, fieldInputs: { x: 'AimYaw', y: 'AimPitch' }, loop: true, speed: 0, isEntry: true, x: 300, y: 200 }],
        transitions: [],
    }
}
