import { mat4, quat, vec3 } from 'gl-matrix';
import { AnimatedModel, Animation, AnimationSampler, AnimationChannel, Skin } from './animatedModel';
import {
    AnimationField, AnimationFieldAxis, FieldWeight, fieldWeights, rateScaleOf, phaseOffsetOf,
    axisSmoothing, axisDeadzone, axisWrapSpan, weightSmoothing,
} from './animationField';
import { clamp, dampTime, dampWrapped, decomposeTRS, wrapSpan } from '../core/math';
import { skeletonTopology, SkeletonTopology, isAncestorJoint, subtreeOrder } from './skeletonTopology';
import { findKey, findKeyLinear, isSorted } from './keyframes';
import { bakeCubicSpline } from './samplerBake';
import { solveTwoBone, kneePole, ikTuning, validateIkRig, swingReleaseWeight, IkFootChain, IkRig, IkRigValidation } from './ik';
import { Node } from '../core/scene/nodes/node';
import { ModelNode } from '../core/scene/nodes/modelNode';
import { canAccessVariable } from '../core/scene/nodes/nodeVariables';
import { InputSystem } from '../input/inputSystem';
import { Logger } from '../core/logger';
import { rootMotionNodeOf, rootParentRotation, rootParentScale } from './clipEdit';
// The condition model and evaluator live in core/conditions.ts — they read a table of named values and
// answer yes or no, which has nothing to do with animation, and the behavior state machine needs the
// same latching. See that module for why the band is centred and why latches refresh machine-wide.
import {
    ConditionContext, conditionMet, consumeTriggers, forEachCondition, gateMet, isConditionGroup, updateLatch,
} from '../core/conditions';
import type { Condition, ConditionGroup, ConditionNode, ConditionOp } from '../core/conditions';

/** Structural view of a physics body driving a ragdoll bone, so the physics layer stays unimported. */
export interface RagdollBodyRef {
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
}

/** Trigger-based animation playback. Superseded by the state machine below. */
export interface AnimationMapping {
    animationName: string;
    trigger: string;
    triggerType: 'key' | 'direction' | 'speed' | 'custom';
    keyCode?: string;
    direction?: [number, number, number]; // 3D vector (x, y, z) ranging from 0 to 1
    directionThreshold?: number; // Dot product threshold for direction matching (default: 0.8)
    speedThreshold?: number; // For 'speed' trigger type
    customCondition?: string;
}

// ---------------------------------------------------------------------------
// Animation State Machine + Events. Named States bound to clips, Transitions whose Conditions compare
// typed Parameters, and per-clip timeline Event markers. Plain serializable data on the Animator.
// ---------------------------------------------------------------------------

export type AnimationParameterType = 'bool' | 'float' | 'trigger' | 'variable';

/**
 * Engine-provided node values a 'variable' parameter can bind to. A curated list, because the ordinary
 * lookup's `hasOwnProperty` guard cannot see a prototype getter. All of them are MEASURED state.
 */
export const NODE_BUILTINS: Record<string, {
    type: 'number' | 'boolean';
    /** True when this value can go below zero. A state's Speed parameter clamps at 0 and freezes the clip. */
    signed?: boolean;
    read: (node: Node) => number | boolean;
}> = {
    currentSpeed:     { type: 'number',  read: n => n.currentSpeed },
    rawSpeed:         { type: 'number',  read: n => n.rawSpeed },
    planarSpeed:      { type: 'number',  read: n => n.planarSpeed },
    verticalSpeed:    { type: 'number',  signed: true, read: n => n.verticalSpeed },
    planarAngle:      { type: 'number',  signed: true, read: n => n.planarAngle },
    worldPlanarAngle: { type: 'number',  signed: true, read: n => n.worldPlanarAngle },
    isGrounded:       { type: 'boolean', read: n => n.isGrounded },

    // The only SIGNED speeds. Every other speed above is a magnitude, so a blend-space sample authored
    // at a negative coordinate on one of those axes is unreachable.
    forwardSpeed:     { type: 'number',  signed: true, read: n => n.forwardSpeed },
    lateralSpeed:     { type: 'number',  signed: true, read: n => n.lateralSpeed },

    // Rate of change, not state: what makes a START and a STOP expressible. Speed alone cannot tell a
    // character breaking into a run from one already running.
    planarAcceleration: { type: 'number',  signed: true, read: n => n.planarAcceleration },
    isAccelerating:     { type: 'boolean', read: n => n.isAccelerating },
    isDecelerating:     { type: 'boolean', read: n => n.isDecelerating },
    isMoving:           { type: 'boolean', read: n => n.isMoving },
    movingTime:         { type: 'number',  read: n => n.movingTime },
    stillTime:          { type: 'number',  read: n => n.stillTime },
    turnRate:           { type: 'number',  signed: true, read: n => n.turnRate },
    // NOT signed: a hypot of the angular velocity, so it has no direction to be negative about.
    angularSpeed:       { type: 'number',  read: n => n.angularSpeed },

    // Air / ground, for jump and land states.
    isFalling:      { type: 'boolean', read: n => n.isFalling },
    airTime:        { type: 'number',  read: n => n.airTime },
    groundedTime:   { type: 'number',  read: n => n.groundedTime },
    groundDistance: { type: 'number',  read: n => n.groundDistance },
    slopeAngle:     { type: 'number',  read: n => n.slopeAngle },
};

/** Name of a built-in node value. */
export type NodeBuiltinName = keyof typeof NODE_BUILTINS;

/**
 * Binds a 'variable' parameter to a node custom variable or a {@link NODE_BUILTINS} entry, read each
 * frame. Prefer a relative `nodeRef` over a node id — ids are regenerated and the binding then dangles.
 */
export interface AnimationVariableBinding {
    nodeRef: 'self' | 'parent' | 'bodied' | string;
    varName: string;
    /** Whether the bound variable reads as a number or boolean (decides which condition ops apply). */
    varType: 'number' | 'boolean';
    /** Where `varName` is read from. Absent means 'variable'. */
    source?: 'variable' | 'builtin';
}

export interface AnimationParameter {
    name: string;
    type: AnimationParameterType;
    /** Default value: number for 'float', boolean for 'bool'/'trigger'; fallback for 'variable'. */
    default: number | boolean;
    /** Present only when type === 'variable': the node variable this parameter reads from. */
    variable?: AnimationVariableBinding;
}

export interface AnimationState {
    name: string;
    /** Name of the animation clip this state plays (empty = hold bind pose). Ignored when `field` is set. */
    clipName: string;
    /** Link to the Animation Field asset this state plays. Authoring-side only; the runtime reads `field`. */
    fieldId?: string;
    /**
     * Resolved copy of the field, embedded by the editor on Apply. This is what plays, and being embedded
     * is what carries it through saves, templates, bundles and the published game.
     */
    field?: AnimationField;
    /** Names of the machine parameters feeding the field's axes. */
    fieldInputs?: { x?: string; y?: string };
    loop: boolean;
    speed: number;
    /**
     * How many times to play the clip when `loop` is set; 0 or undefined is forever. After the last pass
     * the clip holds on its final frame, which is what an exit-time transition waits on.
     */
    loopCount?: number;
    /** Parameter to read the playback rate from, re-read every frame. Overrides `speed`. */
    speedParam?: string;
    /**
     * How strongly foot IK applies while this state plays, 0..1. Absent means 1 — a foot whose ground ray
     * finds nothing already fades itself out, so this is for states whose animation is trusted verbatim.
     */
    ikWeight?: number;
    /**
     * Parameter to read {@link ikWeight} from, re-read every frame. Overrides `ikWeight`. A missing
     * parameter keeps the static weight rather than reading 0.
     */
    ikWeightParam?: string;
    /** Link to the Pose asset (and pose within it) this state holds. Authoring-side only, like `fieldId`. */
    poseRef?: { assetId: string; poseId: string };
    /**
     * A static POSE to hold instead of a clip, embedded by the editor on Apply. Bones not listed are left
     * to whatever is beneath — in a masked layer that is how a hand grip sits on top of locomotion.
     */
    pose?: AnimationPose;
    /** The state the machine starts in. Exactly one state should be the entry. */
    isEntry?: boolean;
    /** Graph-editor layout coordinates (authoring only — ignored at runtime). */
    x?: number;
    y?: number;
}

// The condition model is `core/conditions.ts`'s, aliased here under its historical names. These four
// aliases and the `isConditionGroup` re-export are what let `src/cleo.ts`, the editor's ConditionTree and
// every authored state machine keep compiling unchanged after the extraction.

/** Comparison operator for a transition condition (interpreted per parameter type). */
export type AnimationConditionOp = ConditionOp;
export type AnimationCondition = Condition;
/** An AND/OR gate over conditions and nested gates. See {@link AnimationTransition.condition}. */
export type AnimationConditionGroup = ConditionGroup;
export type AnimationConditionNode = ConditionNode;
export { isConditionGroup };

export interface AnimationTransition {
    /** Source state name, or '*' to match any state. */
    from: string;
    to: string;
    /** Flat, implicitly-ANDed conditions. Superseded by `condition`, and ignored whenever it is present. */
    conditions: AnimationCondition[];
    /** Compound condition tree. When present it is the only thing consulted; `conditions` is ignored. */
    condition?: AnimationConditionGroup;
    /** When true, the transition only fires once the clip reaches exitTime. */
    hasExitTime?: boolean;
    /** Normalized clip time (0..1) the transition waits for when hasExitTime is set. */
    exitTime?: number;
    /** Seconds to cross-fade over when this transition fires. Undefined uses {@link Animator.blendTime}. */
    blendTime?: number;
    /**
     * Seconds the machine must have spent in `from` before this transition may fire — the guard against a
     * ping-ponging state pair. Real seconds from entry, unlike `hasExitTime`'s normalized clip time.
     */
    minDwell?: number;
}

export interface AnimationEventMarker {
    clipName: string;
    /** Time in seconds within the clip. */
    time: number;
    eventName: string;
}

export interface AnimationStateMachine {
    parameters: AnimationParameter[];
    /** The BASE layer's states. */
    states: AnimationState[];
    /** The BASE layer's transitions. */
    transitions: AnimationTransition[];
    events: AnimationEventMarker[];
    /**
     * Layers ABOVE the base, applied in order. Each runs its own states and transitions over the shared
     * parameters, and is blended onto everything beneath it through an optional bone mask — the upper body
     * aiming while the legs keep walking. Absent on every machine authored before layers existed, which
     * is exactly a one-layer controller.
     */
    layers?: AnimationLayer[];
    /** Action slots a script plays one-shots into — see {@link Animator.playAction}. */
    slots?: AnimationSlotDef[];
    /** The Animation Controller asset this machine was resolved from. Authoring-side only. */
    controllerId?: string;
    /**
     * This character's clip swaps over its controller (clip name -> clip name), already applied to the
     * states above. Kept so a re-embed after a controller edit can apply them again. Authoring-side only.
     */
    clipOverrides?: Record<string, string>;
}

/** How a layer or slot combines with the pose beneath it. */
export type AnimationBlendMode = 'override' | 'additive';

/**
 * One layer of a controller. `override` replaces the pose beneath (by `weight` x mask); `additive` adds
 * the layer's motion RELATIVE TO ITS CLIP'S FIRST FRAME, which is what lets one breathing or recoil clip
 * sit on top of any pose.
 */
export interface AnimationLayer {
    name: string;
    states: AnimationState[];
    transitions: AnimationTransition[];
    /** 0..1, default 1. */
    weight?: number;
    /** Parameter to read the weight from each frame. Overrides `weight`. */
    weightParam?: string;
    blend?: AnimationBlendMode;
    /** Link to the Bone Mask asset. Authoring-side only; the runtime reads `mask`. */
    maskId?: string;
    /** Bone NAME -> weight 0..1, embedded on Apply. Absent = the whole body; a bone not listed = 0. */
    mask?: Record<string, number>;
}

/** A named slot actions play into. Placed after layer `afterLayer` (0 = right above the base). */
export interface AnimationSlotDef {
    name: string;
    /** Index into [base, ...layers] the slot sits above. Default: above every layer. */
    afterLayer?: number;
    blend?: AnimationBlendMode;
    maskId?: string;
    mask?: Record<string, number>;
}

/** One bone of a pose, as a delta from its REST — the same form a rig pose stores. */
export interface AnimationPoseBone {
    name: string;
    /** Rotation delta, quaternion [x,y,z,w], applied as `delta x rest`. */
    rotation?: number[];
    /** Translation delta added to the rest translation. */
    translation?: number[];
}

export interface AnimationPose {
    name?: string;
    bones: AnimationPoseBone[];
}

/** Options for {@link Animator.playAction}. */
export interface AnimationActionOptions {
    /** Slot to play in. Default: the controller's first slot, else an implicit full-body one. */
    slot?: string;
    /** Seconds to fade in. Default 0.15. */
    blendIn?: number;
    /** Seconds to fade out at the end (or on stop). Default 0.2. */
    blendOut?: number;
    /** Playback rate. Default 1. */
    speed?: number;
    /** Loop until stopped. Default false. */
    loop?: boolean;
    /**
     * Foot-IK weight while this action plays, 0..1, faded in and out with it. Default 1 (unchanged). A
     * roll, a dive or a knockdown passes 0: planting feet on the ground mid-tumble bends the legs wrong.
     */
    ikWeight?: number;
    /**
     * Extract the clip's root-bone travel instead of letting it move the mesh: the bone is pinned in place
     * and the travel collects for {@link Animator.consumeRootMotion}, so a SCRIPT moves the body by it (a
     * roll that covers exactly the ground the animation does, through the character's own collision).
     * Actions never move the character themselves -- only the base layer drives root motion directly.
     */
    rootMotion?: boolean;
}

/** A playing action. `finished` resolves once it has faded fully out, however it ended. */
export interface AnimationActionHandle {
    readonly slot: string;
    readonly clipName: string;
    readonly done: boolean;
    readonly finished: Promise<void>;
    /** Fade the action out now. */
    stop(blendOut?: number): void;
}

// A layer or slot: a child Animator that plays into a pose the parent blends in. Reusing a whole Animator
// rather than extracting a playback core means layers get clips, fields, cross-fades, exit times, events
// and every fix ever made to them, for free.
interface Overlay {
    kind: 'layer' | 'slot';
    name: string;
    animator: Animator;
    blend: AnimationBlendMode;
    /** Bone name -> weight as authored; resolved lazily into `mask` against this skin. */
    maskSpec: Record<string, number> | null;
    /** Node index -> weight. Null = the whole body at 1. */
    mask: Map<number, number> | null;
    weight: number;
    weightParam?: string;
    /** Where it sits: layers at their own index (1..n), slots at afterLayer + 0.5. */
    order: number;
    /** How present the overlay's pose is, 0..1: a layer fading in and out of its empty states, an action in and out of its slot. */
    presence: number;
    presenceTarget: number;
    /** Seconds the presence takes to cross the full 0..1 range. */
    fadeSeconds: number;
    action: ActionState | null;
}

interface ActionState {
    clipName: string;
    loop: boolean;
    blendOut: number;
    stopping: boolean;
    done: boolean;
    resolve: () => void;
    /** Foot-IK weight while it plays (see AnimationActionOptions.ikWeight). */
    ikWeight: number;
}

/**
 * One channel's keyframes: the times, and each key's value as a view into ONE packed buffer (a view per
 * key, so the gl-matrix lerp/slerp read them exactly as they read the per-key vec3/quat objects this
 * replaced). `cursor` is where the last lookup landed (see keyframes.ts); `constant` marks a channel
 * whose keys are all equal, which samples as its first key without a lookup.
 */
interface Channel {
    times: number[];
    keys: Float32Array[];
    cursor: number;
    constant: boolean;
    sorted: boolean;
    /** STEP interpolation: hold each key until the next one instead of blending toward it. */
    step: boolean;
}

const NO_CHANNEL: Channel = { times: [], keys: [], cursor: 0, constant: false, sorted: true, step: false };

function makeChannel(source: AnimationSampler, stride: 3 | 4, normalize: boolean): Channel {
    // CUBICSPLINE stores in-tangent/value/out-tangent per key; resolve it to LINEAR keys first (normally
    // already done at load — this catches clips built some other way).
    const sampler = bakeCubicSpline(source);
    const count = sampler.input.length;
    const packed = new Float32Array(count * stride);
    const keys: Float32Array[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const key = packed.subarray(i * stride, i * stride + stride);
        for (let c = 0; c < stride; c++) key[c] = sampler.output[i * stride + c];
        if (normalize) quat.normalize(key as unknown as quat, key as unknown as quat);
        keys[i] = key;
    }
    let constant = count > 1;
    for (let i = stride; constant && i < packed.length; i++) if (packed[i] !== packed[i % stride]) constant = false;
    const times = Array.from(sampler.input as ArrayLike<number>);
    return { times, keys, cursor: 0, constant, sorted: isSorted(times), step: sampler.interpolation === 'STEP' };
}

/** Keyframe interpolation for a single bone. */
class Bone {
    private _name: string;
    private _id: number;
    private _localTransform: mat4;

    private _positions: Channel = NO_CHANNEL;
    private _rotations: Channel = NO_CHANNEL;
    private _scales: Channel = NO_CHANNEL;

    // The bone's REST pose, used for any channel it has no keyframes for. Rotation-only bones would
    // otherwise fall back to a zero translation and collapse onto their parent's origin.
    private _restT: vec3 = vec3.create();
    private _restR: quat = quat.create();
    private _restS: vec3 = vec3.fromValues(1, 1, 1);

    constructor(name: string, id: number) {
        this._name = name;
        this._id = id;
        this._localTransform = mat4.create();
    }

    /** Seed the bone's rest pose from its skin bind transform (decomposed T/R/S). */
    public setRest(rest: mat4): void {
        mat4.getTranslation(this._restT, rest);
        mat4.getRotation(this._restR, rest);
        quat.normalize(this._restR, this._restR);
        mat4.getScaling(this._restS, rest);
    }

    /** Add position channel data. */
    public addPositionChannel(sampler: AnimationSampler): void {
        this._positions = makeChannel(sampler, 3, false);
    }

    /** Add rotation channel data. */
    public addRotationChannel(sampler: AnimationSampler): void {
        this._rotations = makeChannel(sampler, 4, true);
    }

    /** Add scale channel data. */
    public addScaleChannel(sampler: AnimationSampler): void {
        this._scales = makeChannel(sampler, 3, false);
    }

    // Per-bone scratch for the sampled T/R/S. update() runs for every bone of every clip of every
    // animated model each frame; a fresh vec3/quat/vec3 per bone was a large share of the engine's garbage.
    private readonly _tScratch = vec3.create();
    private readonly _rScratch = quat.create();
    private readonly _sScratch = vec3.create();

    // The T/R/S the last update() sampled. Blends read these directly rather than decomposing the
    // composed matrix back into them.
    private _t: vec3 = this._restT;
    private _r: quat = this._restR;
    private _s: vec3 = this._restS;

    /** Recompute the bone's local transform at `animationTime`. */
    public update(animationTime: number): void {
        this._t = this._interpolatePosition(animationTime, this._tScratch);
        this._r = this._interpolateRotation(animationTime, this._rScratch);
        this._s = this._interpolateScale(animationTime, this._sScratch);

        // Combine transformations: T * R * S
        mat4.fromRotationTranslationScale(this._localTransform, this._r, this._t, this._s);
    }

    /** The translation/rotation/scale the last {@link update} sampled. Read-only views. */
    public get translation(): vec3 { return this._t; }
    public get rotation(): quat { return this._r; }
    public get scale(): vec3 { return this._s; }

    // The segment `animationTime` falls in. See keyframes.ts.
    private static _index(channel: Channel, animationTime: number): number {
        const i = channel.sorted ? findKey(channel.times, animationTime, channel.cursor)
                                 : findKeyLinear(channel.times, animationTime);
        channel.cursor = i;
        return i;
    }

    // Interpolation factor between two keyframes. Must stay CLAMPED: the index lookup returns `length - 2`
    // past the last keyframe, and an unclamped factor would extrapolate along the final segment's slope.
    private _getScaleFactor(lastTimeStamp: number, nextTimeStamp: number, animationTime: number, step: boolean): number {
        // STEP holds key i across the whole segment; it only reaches key i+1 once time does (index lookup
        // returns length - 2 past the end, where the factor clamps to 1 and lands on the last key).
        if (step) return animationTime >= nextTimeStamp ? 1 : 0;
        const framesDiff = nextTimeStamp - lastTimeStamp;
        if (!(framesDiff > 0)) return 0;
        const midWayLength = animationTime - lastTimeStamp;
        return clamp(midWayLength / framesDiff, 0, 1);
    }

    // Position at `animationTime`.
    private _interpolatePosition(animationTime: number, out: vec3): vec3 {
        const ch = this._positions;
        if (ch.keys.length === 0) return this._restT; // no channel: hold the bind offset, not the origin (only read)
        if (ch.keys.length === 1 || ch.constant) return ch.keys[0] as unknown as vec3;
        const i = Bone._index(ch, animationTime);
        const f = this._getScaleFactor(ch.times[i], ch.times[i + 1], animationTime, ch.step);
        return vec3.lerp(out, ch.keys[i] as unknown as vec3, ch.keys[i + 1] as unknown as vec3, f);
    }

    // Rotation at `animationTime`, slerped. Keys are normalized when the channel is built.
    private _interpolateRotation(animationTime: number, out: quat): quat {
        const ch = this._rotations;
        if (ch.keys.length === 0) return this._restR; // no channel: hold the bind rotation (only read)
        if (ch.keys.length === 1 || ch.constant) return ch.keys[0] as unknown as quat;
        const i = Bone._index(ch, animationTime);
        const f = this._getScaleFactor(ch.times[i], ch.times[i + 1], animationTime, ch.step);
        quat.slerp(out, ch.keys[i] as unknown as quat, ch.keys[i + 1] as unknown as quat, f);
        return quat.normalize(out, out);
    }

    // Scale at `animationTime`.
    private _interpolateScale(animationTime: number, out: vec3): vec3 {
        const ch = this._scales;
        if (ch.keys.length === 0) return this._restS; // no channel: hold the bind scale (only read)
        if (ch.keys.length === 1 || ch.constant) return ch.keys[0] as unknown as vec3;
        const i = Bone._index(ch, animationTime);
        const f = this._getScaleFactor(ch.times[i], ch.times[i + 1], animationTime, ch.step);
        return vec3.lerp(out, ch.keys[i] as unknown as vec3, ch.keys[i + 1] as unknown as vec3, f);
    }

    /**
     * Sample translation and rotation at an arbitrary time without touching `_localTransform`. Root-motion
     * extraction reads the root bone at two times per frame through this.
     */
    public sampleTR(time: number): { t: vec3; r: quat } {
        return { t: vec3.clone(this._interpolatePosition(time, vec3.create())),
                 r: quat.clone(this._interpolateRotation(time, quat.create())) };
    }

    /**
     * {@link sampleTR} into caller-owned storage, allocation-free. Its own scratch, never the T/R/S that
     * {@link update} sampled: a root-motion read between the update and the pose must not change the pose.
     */
    public sampleTRInto(time: number, t: vec3, r: quat): void {
        vec3.copy(t, this._interpolatePosition(time, t));
        quat.copy(r, this._interpolateRotation(time, r));
    }

    // The clip's first frame, for an additive layer's reference. Fixed for the channels' lifetime.
    private _startTR: { t: vec3; r: quat } | null = null;
    public startTR(): { t: vec3; r: quat } {
        return this._startTR ??= this.sampleTR(0);
    }

    /** Overwrite the local transform directly — root motion locks the root bone to a fixed pose with this. */
    public setLocalTransform(m: mat4): void {
        mat4.copy(this._localTransform, m);
        // Keep the T/R/S the blends read in step with the matrix they now stand for.
        this._t = mat4.getTranslation(this._tScratch, m);
        this._s = mat4.getScaling(this._sScratch, m);
        this._r = quat.normalize(this._rScratch, mat4.getRotation(this._rScratch, m));
    }

    public get localTransform(): mat4 { return this._localTransform; }
    public get name(): string { return this._name; }
    public get id(): number { return this._id; }
}

// --- Pose scratch ----------------------------------------------------------------------------------
//
// Posing a skeleton used to allocate several vec3/quat/mat4 per bone per blend, every frame, for every
// character — the bulk of the engine's garbage. Blended locals now come from POSE_ARENA, a pool reset at
// the start of each top-level `_recomputePose`: a matrix handed out stays valid until the next pose begins,
// which is all `_recomputePose` (and foot IK inside it) needs. Anything kept longer is cloned (see
// `boneLocalTransform`). Posing is never re-entrant across animators: a layer's animator only ever hands
// its locals to the parent posing it.

const POSE_ARENA: mat4[] = [];
let poseArenaUsed = 0;

/** A scratch matrix valid until the next top-level pose. */
function arenaMat(): mat4 {
    // A caller outside any pose (an editor reading bones every frame) only ever clones what it gets, so
    // wrapping is safe there; inside a pose this cap is far above any skeleton's needs.
    if (poseArenaUsed >= 16384) poseArenaUsed = 0;
    return POSE_ARENA[poseArenaUsed++] ??= mat4.create();
}

/** `bone_${n}`, without building the string per bone per frame. */
const BONE_KEYS: string[] = [];
function boneKey(nodeIndex: number): string {
    return BONE_KEYS[nodeIndex] ??= `bone_${nodeIndex}`;
}

/** Read-only identity, for a node with neither a pose source nor a rest transform. */
const IDENTITY: mat4 = mat4.create();

// Blend scratch. Every helper below fully consumes its inputs before returning.
const MIX_BONES: Bone[] = [];
const MIX_WEIGHTS: number[] = [];
const MIX_T = vec3.create(), MIX_S = vec3.create(), MIX_R = quat.create();
const BL_T0 = vec3.create(), BL_R0 = quat.create(), BL_S0 = vec3.create();
const BL_T1 = vec3.create(), BL_R1 = quat.create(), BL_S1 = vec3.create();
const ADD_INV = quat.create(), ADD_DELTA = quat.create(), ADD_ID = quat.create();

// Foot IK scratch: the solve runs per character per frame and used to allocate ~60 vectors and matrices.
const IK_WORLD_TO_MODEL = mat4.create();
const IK_UP = vec3.create(), IK_ORIGIN = vec3.create(), IK_FORWARD = vec3.create(), IK_ZERO = vec3.create();
const IK_ANKLE_WORLD = vec3.create(), IK_FROM = vec3.create(), IK_TO = vec3.create();
const IK_HIT_MODEL = vec3.create(), IK_TMP = vec3.create(), IK_SHIFT = vec3.create(), IK_O = vec3.create();
const IK_INV = mat4.create(), IK_FRAME = mat4.create(), IK_ROT = mat4.create(), IK_AROUND = mat4.create();
const IK_NEW_GLOBAL = mat4.create();
const IK_HIP = vec3.create(), IK_KNEE = vec3.create(), IK_ANKLE = vec3.create(), IK_EASED = vec3.create();
const IK_ALIGN = quat.create(), IK_PARTIAL = quat.create(), IK_COUNTER = quat.create(), IK_HALF = quat.create();
const IK_QID = quat.create();

/** One foot's plan for this frame, pooled per animator. See `_applyFootIk`. */
interface FootPlan {
    chain: IkFootChain;
    ankle: vec3;         // model space, as animated
    target: vec3;        // model space, on the ground
    normal: vec3;        // model space, of the surface
    weight: number;      // this foot's damped contribution
    /** Signed distance from the animated ankle to its target along `up`. Negative = the foot must drop. */
    along: number;
}

// One clip contributing to a field blend. `bones` is SHARED with the Animator's per-clip cache and must
// never be mutated per-entry, only advanced.
interface FieldEntry {
    clipName: string;
    animation: Animation;
    bones: Map<string, Bone>;
    duration: number;
    weight: number;
    rateScale: number;
    /** Fraction of a cycle this clip is shifted by. See {@link AnimationFieldSample.phaseOffset}. */
    phaseOffset: number;
}

// Damped weight below which a fading clip stops being posed. Larger than animationField's own epsilon:
// this one terminates a decaying exponential, which never actually reaches zero.
const WEIGHT_FADE_EPSILON = 1e-3;

// How far a rival must lead before the dominant clip changes hands. Affects event-marker ownership and
// `currentAnimation` only, never the blend.
const DOMINANT_SWITCH_MARGIN = 0.05;

// State changes per second that mean the machine is fighting itself. Real play peaks around four;
// sustained thrashing runs at the frame rate.
const PING_PONG_FLIPS_PER_SEC = 6;

/** Skeletal animation playback: clips, cross-fades, the state machine, blend fields, ragdoll and foot IK. */
export class Animator {
    private _currentAnimation: Animation | null = null;
    private _animatedModel: AnimatedModel | null = null;
    private _currentTime: number = 0;
    // CLOCK time: frame time scaled by playback speed. Advances phase, clip time and cross-fades.
    private _deltaTime: number = 0;
    // FILTER time: unscaled wall-clock frame time. Must stay distinct from `_deltaTime` — every damping
    // constant here is authored in seconds, and at speed 0 a scaled dt would disable filtering entirely.
    // Assigned in lockstep with `_deltaTime` so both go stale together on an early return.
    private _frameDelta: number = 0;
    private _finalBoneMatrices: mat4[] = [];
    /**
     * Each joint's MODEL-space transform from the last pose (parent-accumulated, before the inverse bind),
     * indexed like `skin.joints`. Kept because sockets need exactly this, and recovering it from the
     * final matrices costs an inverse-bind inversion per joint per query.
     */
    private _jointModelMatrices: mat4[] = [];
    // ---- Layers and action slots ----
    /** True for a layer's or slot's child animator: it produces a pose, never skinning matrices. */
    private _isOverlay: boolean = false;
    /** A layer's child is in a state with nothing to play: its pose fades out rather than snapping to rest. */
    private _overlayEmpty: boolean = false;
    /** Event markers a slot's child fires — the parent machine's list, since a slot has no machine. */
    private _externalEvents: AnimationEventMarker[] | null = null;
    /** Layers and slots, in the order they apply over the base. */
    private _overlays: Overlay[] = [];
    /** Set by `_recomputePose`, so `update` can tell whether the overlays still need a pose this frame. */
    private _posedThisFrame: boolean = false;
    /** Pose states turned into clips, keyed by the state object. */
    private _poseClips: WeakMap<AnimationState, Animation> = new WeakMap();
    private _bones: Map<string, Bone> = new Map();
    private _skin: Skin | null = null;
    private _playing: boolean = false;
    private _loop: boolean = true;
    private _speed: number = 1.0;
    /** Whether the outgoing clip of the current blend was still running when the blend started. */
    private _previousAdvancing: boolean = false;
    /** Whether the outgoing clip of the current blend was looping. */
    private _previousLoop: boolean = false;
    /** Duration of the blend in flight. Normally _blendTime, but a transition may override it per-edge. */
    private _activeBlendTime: number = 0.3;
    /** Passes the clip has completed since it started; counts toward _loopLimit. */
    private _loopsPlayed: number = 0;
    /** Times to play the clip before holding the last frame. 0 = forever. From AnimationState.loopCount. */
    private _loopLimit: number = 0;
    private _nodeIndexToJointIndex: Map<number, number> = new Map();
    private _animationMappings: AnimationMapping[] = [];
    private _node: Node | null = null;
    private _lastPosition: vec3 = vec3.create();
    private _currentSpeed: number = 0;
    
    // Animation blending properties
    private _previousAnimation: Animation | null = null;
    private _previousBones: Map<string, Bone> = new Map();
    private _previousTime: number = 0;
    private _blendTime: number = 0.3; // Default blend time in seconds
    private _currentBlendTime: number = 0;
    private _isBlending: boolean = false;

    // Ragdoll: bone matrices come from physics bodies instead of animation, each joint driven by the
    // nearest ancestor bone that owns one. finalBoneMatrix = inv(nodeWorld) * bodyWorld * offset, where
    // the constant offset holds the bone's full start pose, so only RIGID motion is followed.
    private _ragdollActive: boolean = false;
    private _ragdollDrive: Map<number, { body: RagdollBodyRef, offset: mat4 }> | null = null;

    // When set, drives playback each frame instead of the AnimationMapping list. Parameter values are
    // live; triggers are consumed when a transition using them fires.
    private _stateMachine: AnimationStateMachine | null = null;
    private _paramValues: Map<string, number | boolean> = new Map();
    private _currentStateName: string | null = null;
    private _eventCallbacks: ((eventName: string, clipName: string) => void)[] = [];
    private _prevEventTime: number = 0;
    // Real seconds in the current state, what `minDwell` measures against. Not derived from
    // `_currentTime`, which a field re-scales and a looping state wraps.
    private _stateTime: number = 0;
    // Latch state for hysteresis conditions, keyed by the condition's TERMS: a leaf is plain serialized
    // data with no stable identity, and identical leaves should share one band.
    private _condLatch: Map<string, boolean> = new Map();

    // ---- Animation field (blend space) playback ----
    // An active field REPLACES _bones as the pose source: several clips posed at a shared normalized
    // phase and mixed by weight. _currentTime/duration read the weighted duration and stay meaningful.
    private _fieldDef: AnimationField | null = null;
    private _fieldInputs: { x?: string; y?: string } | null = null;
    private _fieldEntries: FieldEntry[] | null = null;
    // SMOOTHED probe coordinates, what the field is sampled at. Set directly by the editor preview,
    // damped towards _fieldTargetX/Y when a machine drives the axes.
    private _fieldX: number = 0;
    private _fieldY: number = 0;
    // The probe the parameters ask for, after the deadband. Separate from _fieldX/_fieldY so the damping
    // has a fixed target — damping towards its own result would stall.
    private _fieldTargetX: number = 0;
    private _fieldTargetY: number = 0;
    /** False until the first parameter read, which snaps the probe instead of damping in from 0. */
    private _fieldProbeSeeded: boolean = false;
    /** Shared normalized playback position (0..1) across every contributing clip — the anti-foot-slide. */
    private _fieldPhase: number = 0;
    /** Phase at the START of this frame, so event markers get a monotonic window (see _fireDueEvents). */
    private _prevFieldPhase: number = 0;
    // Damped weight per clip name, surviving between frames. This is what keeps the contributing SET
    // continuous: fieldWeights drops a clip outright, and a set that changes changes _mixTransforms'
    // result. Holding a departing clip at a decaying weight turns that step into a fade.
    private _fieldWeightState: Map<string, number> = new Map();
    // Last seen rate scale and phase offset per clip, so a FADING OUT clip whose sample the field no
    // longer returns keeps being posed as it was.
    private _fieldSampleMeta: Map<string, { rateScale: number; phaseOffset: number }> = new Map();
    /** False until the first weight evaluation of a field, which snaps rather than fading up from nothing. */
    private _fieldWeightsSeeded: boolean = false;
    /** Clip names already reported as missing, so the warning does not repeat every frame. */
    private _warnedMissingClips: Set<string> = new Set();
    /** Parameter names already reported as having a dangling node reference. Same reason. */
    private _warnedBindings: Set<string> = new Set();
    /** "state param" pairs already reported as driving playback negative. See _warnNegativeSpeed. */
    private _warnedNegativeSpeed: Set<string> = new Set();
    /** Recent state changes, for the ping-pong report. See _noteStateChange. */
    private _stateFlips: { at: number; pair: string }[] = [];
    private _warnedPingPong: boolean = false;
    /** Accumulated frame time, purely so the ping-pong window has a clock that is not the wall. */
    private _animatorClock: number = 0;
    // Clip currently treated as dominant, held with a margin so the identity cannot flicker around a
    // 50/50 crossing and fire event markers at random.
    private _fieldDominant: string | null = null;
    /** Bone maps per clip, built once. Weights change every frame; bone maps must not be rebuilt with them. */
    private _fieldBoneCache: Map<string, { bones: Map<string, Bone>; duration: number; animation: Animation }> = new Map();
    /** Cached skeleton hierarchy; see _topology(). */
    private _topologyCache: SkeletonTopology | null = null;
    private _topologySkin: Skin | null = null;

    // ---- Foot IK state ----
    // Both are damped across frames — a foot crossing a ledge lip would otherwise snap between planted
    // and free on consecutive frames.
    /** Per foot (keyed by its ankle's node index): how much of the IK correction is currently applied. */
    private _ikFootWeights: Map<number, number> = new Map();
    // Per foot: the last surface its ray found, so a foot losing its ground has something to fade towards.
    // WORLD space, re-transformed each frame — a model-space memory would be carried by the character.
    private _ikFootHits: Map<number, { point: vec3; normal: vec3 }> = new Map();
    /** Foot plans, pooled across frames. */
    private readonly _ikPlans: FootPlan[] = [];
    /**
     * Whether foot IK may query the ground this frame. The LOD tier clears it for a character nobody can
     * see; its feet then fade out as over a missed ray.
     */
    private _ikAllowed = true;
    /** The last validated rig and its result, so validation and its warning happen once per rig, not per frame. */
    private _validatedRigRef: IkRig | null = null;
    private _rigValidation: IkRigValidation | null = null;
    /** How far the pelvis is currently lowered, in model units along "up". Never positive. */
    private _ikHipOffset: number = 0;
    /** The field being cross-faded OUT of, mirroring _previousBones for the single-clip path. */
    private _previousFieldEntries: FieldEntry[] | null = null;
    private _previousFieldPhase: number = 0;

    // ---- Root motion ----
    // For a clip flagged `rootMotion`, the root bone's per-frame delta drives the character and the bone
    // is locked to its clip-start pose. Single-clip playback only — a field has no single root.
    private _rootMotionActive: boolean = false;
    /** Units of the root bone's channels -> model units (a Mixamo armature's 0.01). See rootParentScale. */
    private _rootParentScale: number = 1;
    /** A slot playing an action with `rootMotion`: extract the travel (see AnimationActionOptions). */
    private _extractRoot: boolean = false;
    /** Model-space root travel an action has extracted and nobody has consumed yet. */
    private readonly _rootDelta = vec3.create();
    /** The root channel's vertical axis (0/1/2), for extraction: only the GROUND-PLANE travel is taken. */
    private _rootUpAxis = 1;
    private _rootBoneName: string | null = null;
    /**
     * Editor-only per-bone local overrides, or null when there are none. Null rather than an empty Map so
     * the check in `resolveLocal` — which runs per bone per frame for every character in the scene — is a
     * single null test in the overwhelmingly common case.
     */
    private _boneOverrides: Map<number, mat4> | null = null;
    private _rootRefT: vec3 = vec3.create();
    private _rootRefR: quat = quat.create();
    private _rootRefS: vec3 = vec3.fromValues(1, 1, 1);
    // The OUTGOING clip's root pin, held for the length of a cross-fade out of a root-motion clip. The
    // character already carries that clip's motion, so the fading-out pose must keep its root bone at
    // the reference too — sampled raw, a 90-degree turn clip would show its hips at +90 ON TOP of the
    // +90 the node now has, and the blend would swing the mesh in from the wrong side.
    private _prevRootBoneName: string | null = null;
    private _prevRootRefT: vec3 = vec3.create();
    private _prevRootRefR: quat = quat.create();
    private _prevRootRefS: vec3 = vec3.fromValues(1, 1, 1);
    // Rotation of the root bone's parent chain (the static armature), which carries the rig's
    // authoring-to-engine axis conversion. The root delta must be brought through it, or an authored yaw
    // comes out as roll or pitch in world space.
    private _rootParentRot: quat = quat.create();

    constructor(animatedModel: AnimatedModel, node?: Node, options?: { overlay?: boolean }) {
        this._animatedModel = animatedModel;
        this._node = node || null;
        this._isOverlay = !!options?.overlay;
        
        // Initialize last position if node is provided
        if (this._node) {
            vec3.copy(this._lastPosition, this._node.position);
        }
        
        // Initialize bone matrices array with identity matrices
        for (let i = 0; i < 100; i++) {
            this._finalBoneMatrices.push(mat4.create());
        }
        
        // Store skin data
        this._skin = animatedModel.skin;
        
        // Build node index to joint index mapping
        if (this._skin) {
            for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
                const nodeIndex = this._skin.joints[jointIndex].nodeIndex;
                this._nodeIndexToJointIndex.set(nodeIndex, jointIndex);
            }
        }
        // A layer's animator starts empty and silent: it plays only what its own states tell it to.
        if (this._isOverlay) return;
        if (this._skin) {
            Logger.info(`Animator initialized with ${this._skin.joints.length} joints`, 'Animation');
            Logger.print('info', ['Joint node indices:', Array.from(this._nodeIndexToJointIndex.keys())], 'Animation');
        }

        // If model has animations, set the first one as default
        if (animatedModel.animations.length > 0) {
            Logger.info(`Found ${animatedModel.animations.length} animations`, 'Animation');
            animatedModel.animations.forEach((anim, i) => {
                Logger.info(`  Animation ${i}: "${anim.name}" with ${anim.channels.length} channels`, 'Animation');
            });
            this.playAnimation(0);
        } else {
            Logger.warn('AnimatedModel has no animations', 'Animation');
        }
    }
    
    /** Play the animation at `animationIndex`. */
    public playAnimation(animationIndex: number, loop: boolean = true, blend: boolean = true): void {
        if (!this._animatedModel || animationIndex < 0 || animationIndex >= this._animatedModel.animations.length) {
            Logger.warn(`Animation index ${animationIndex} out of range`, 'Animation');
            return;
        }
        
        this._playClip(this._animatedModel.animations[animationIndex], loop, blend);
    }

    // Play a clip object — one of the model's, or a synthesized one such as a pose state's.
    private _playClip(animation: Animation, loop: boolean, blend: boolean): void {
        this._overlayEmpty = false;
        // Must NOT test `_playing`: a finished non-looping clip holds its last frame with _playing false,
        // and that is exactly when a machine wants to cross-fade away from it. `_currentAnimation` being
        // null already covers the first play, the only case that must not blend.
        const blendOut = blend && (this._fieldEntries !== null
            || (!!this._currentAnimation && this._currentAnimation !== animation));

        if (blendOut) {
            // Store current animation state for blending
            this._previousAnimation = this._currentAnimation;
            this._previousBones = new Map(this._bones);
            this._capturePreviousField();
            this._capturePreviousRootPin();
            this._previousTime = this._currentTime;
            // Read BEFORE _playing/_loop are overwritten: a finished clip must hold its final pose under
            // the cross-fade, not restart.
            this._previousAdvancing = this._playing;
            this._previousLoop = this._loop;
            this._isBlending = true;
            this._currentBlendTime = 0;
            this._activeBlendTime = this._blendTime; // a transition may override this right after
        } else {
            // No blending - instant switch
            this._isBlending = false;
            this._previousAnimation = null;
            this._previousFieldEntries = null;
        }

        this._clearField();

        this._currentAnimation = animation;
        this._currentTime = 0;
        this._loop = loop;
        this._playing = true;
        // Fresh clip, fresh budget: `_enterState` re-applies its own limit right after this.
        this._loopsPlayed = 0;
        this._loopLimit = 0;

        // Build bone map from animation channels
        this._buildBoneMap(animation);

        // Arm root motion if this clip carries it.
        this._setupRootMotion(animation);
    }

    /** Play the animation clip called `name`. */
    public playAnimationByName(name: string, loop: boolean = true, blend: boolean = true): void {
        if (!this._animatedModel) return;
        
        const animationIndex = this._animatedModel.animations.findIndex(anim => anim.name === name);
        if (animationIndex === -1) {
            Logger.warn(`Animation "${name}" not found`, 'Animation');
            return;
        }
        
        this.playAnimation(animationIndex, loop, blend);
    }
    
    // Build a FRESH bone map from an animation's channels. Every live pose source needs its own Bone
    // objects: a Bone holds the time it was last posed at, so two sources sharing one clobber each other.
    private _buildBoneMapFor(animation: Animation): Map<string, Bone> {
        const bones = new Map<string, Bone>();

        // Group channels by target node
        for (const channel of animation.channels) {
            const nodeIndex = channel.targetNodeIndex;
            const boneName = `bone_${nodeIndex}`;

            // Get or create bone
            let bone = bones.get(boneName);
            if (!bone) {
                bone = new Bone(boneName, nodeIndex);
                // Seed the rest pose so a missing channel falls back to the bind offset, as _recomputePose does.
                const rest = this._skin?.nodeTransforms?.get(nodeIndex);
                if (rest) bone.setRest(rest);
                bones.set(boneName, bone);
            }

            // Add channel data based on target path
            const sampler = animation.samplers[channel.samplerIndex];
            if (channel.targetPath === 'translation') {
                bone.addPositionChannel(sampler);
            } else if (channel.targetPath === 'rotation') {
                bone.addRotationChannel(sampler);
            } else if (channel.targetPath === 'scale') {
                bone.addScaleChannel(sampler);
            }
        }

        return bones;
    }

    // Rebuild `_bones` from an animation's channels.
    private _buildBoneMap(animation: Animation): void {
        this._bones = this._buildBoneMapFor(animation);

        let animatedCount = 0;
        if (this._skin) {
            for (let i = 0; i < this._skin.joints.length; i++) {
                if (this._bones.has(`bone_${this._skin.joints[i].nodeIndex}`)) animatedCount++;
            }
        }

        // One FLUSH line: this runs on every state entry, and a thrashing machine would otherwise evict
        // the log ring and bury the very warnings that explain the thrashing.
        Logger.print('info', [
            `Bound "${animation.name}": ${this._bones.size} bones, `
            + `${animatedCount}/${this._skin?.joints.length ?? 0} skin joints animated.`,
            Array.from(this._bones.values()).map(b => b.id),
        ], 'Animation', { flush: 'animator:boneMap' });

        if (this._skin) {

            // If no joints have animation data, this animation is likely invalid or targets the wrong nodes
            if (animatedCount === 0) {
                Logger.warn(`⚠️ Animation "${animation.name}" has no channels targeting the skin joints. This animation may not work correctly.`, 'Animation');
                Logger.print('warn', ['Animation channels target nodes:', animation.channels.map(c => c.targetNodeIndex)], 'Animation');
                Logger.print('warn', ['Skin joint nodes:', this._skin.joints.map(j => j.nodeIndex)], 'Animation');
            }
        }
    }

    // ---- Animation field (blend space) playback ---------------------------------------------------
    // A field poses several clips at one shared phase and mixes them by weight, replacing _bones as the
    // pose source. _recomputePose reads both through _currentLocal/_previousLocal.

    /** Drop the active field. The caller decides separately what becomes the new pose source. */
    private _clearField(): void {
        this._fieldDef = null;
        this._fieldInputs = null;
        this._fieldEntries = null;
        this._fieldPhase = 0;
        this._prevFieldPhase = 0;
        this._fieldWeightState.clear();
        this._fieldSampleMeta.clear();
        this._fieldWeightsSeeded = false;
        this._warnedMissingClips.clear();
        this._fieldDominant = null;
        this._fieldProbeSeeded = false;
    }

    // Move the active field into the outgoing slot for a cross-fade, with bone maps of its OWN — the two
    // sides advance to different times, and shared Bone objects would overwrite each other.
    private _capturePreviousField(): void {
        if (!this._fieldEntries) { this._previousFieldEntries = null; return; }
        this._previousFieldEntries = this._fieldEntries.map(e => ({
            ...e,
            bones: this._buildBoneMapFor(e.animation),
        }));
        this._previousFieldPhase = this._fieldPhase;
    }

    // Start playing a field, cross-fading out of whatever is posed. A different field starts at phase 0;
    // re-entering the SAME field object carries its phase, so a ping-ponging state does not stutter.
    // Identity is by reference: each state embeds its own copy, so two states never share one.
    private _startField(
        field: AnimationField,
        inputs: { x?: string; y?: string } | undefined,
        loop: boolean,
        blend: boolean,
        blendOverride?: number,
    ): void {
        if (!this._animatedModel) return;

        const hadSource = this._fieldEntries !== null || this._currentAnimation !== null;
        if (blend && hadSource) {
            this._previousAnimation = this._currentAnimation;
            this._previousBones = new Map(this._bones);
            this._capturePreviousField();
            this._capturePreviousRootPin();
            this._previousTime = this._currentTime;
            this._previousAdvancing = this._playing;
            this._previousLoop = this._loop;
            this._isBlending = true;
            this._currentBlendTime = 0;
            this._activeBlendTime = blendOverride !== undefined ? Math.max(0, blendOverride) : this._blendTime;
        } else {
            this._isBlending = false;
            this._previousAnimation = null;
            this._previousFieldEntries = null;
        }

        const sameField = field === this._fieldDef;

        // A different field means different clips; the cached bone maps are for the old set.
        if (!sameField) this._fieldBoneCache.clear();

        // A field has no single root to extract, so a clip's root motion must not linger.
        this._rootMotionActive = false;
        this._rootBoneName = null;

        this._fieldDef = field;
        this._fieldInputs = inputs ?? null;
        this._fieldEntries = null;    // rebuilt by the refresh below
        if (!sameField) {
            this._fieldPhase = 0;
            this._fieldWeightState.clear();
            this._fieldSampleMeta.clear();
            this._fieldWeightsSeeded = false;
            this._warnedMissingClips.clear();
            this._fieldDominant = null;
            this._fieldProbeSeeded = false;
        }
        this._prevFieldPhase = this._fieldPhase;
        this._bones.clear();          // the field owns the pose now; stale clip bones must not leak through
        this._currentAnimation = null;
        this._currentTime = 0;
        this._loop = loop;
        this._playing = true;
        this._loopsPlayed = 0;
        this._loopLimit = 0;

        this._refreshFieldWeights();
        // After the refresh: the weighted duration is only known once the entries exist.
        this._currentTime = this._fieldPhase * this._fieldDuration(this._fieldEntries);
        this._prevEventTime = this._currentTime;
    }

    /** The bone map + duration for a clip in the active field, built once and cached by clip name. */
    private _fieldClip(clipName: string): { bones: Map<string, Bone>; duration: number; animation: Animation } | null {
        const animation = this._animatedModel?.animations.find(a => a.name === clipName);
        if (!animation) return null;

        // Keyed by NAME, so the cached entry must be checked against the clip that name resolves to now:
        // a re-imported clip is a new Animation object under the same name.
        const cached = this._fieldBoneCache.get(clipName);
        if (cached && cached.animation === animation) return cached;

        let duration = 0;
        for (const sampler of animation.samplers) {
            if (sampler.input.length > 0) duration = Math.max(duration, sampler.input[sampler.input.length - 1]);
        }
        const entry = { bones: this._buildBoneMapFor(animation), duration, animation };
        this._fieldBoneCache.set(clipName, entry);
        return entry;
    }

    // Re-sample the field and rebuild the contributing entries. Runs every frame; bone maps come from
    // _fieldBoneCache, so a weight change never rebuilds one.
    private _refreshFieldWeights(): void {
        const field = this._fieldDef;
        if (!field) { this._fieldEntries = null; return; }

        this._advanceFieldProbe(field);

        const weights: FieldWeight[] = fieldWeights(field, this._fieldX, this._fieldY);
        const damped = this._dampFieldWeights(field, weights);
        if (damped.size === 0) { this._fieldEntries = []; this._fieldDominant = null; return; }

        const entries: FieldEntry[] = [];
        for (const w of weights) {
            const weight = damped.get(w.sample.clipName);
            if (weight === undefined) continue;   // damped out, or already emitted for a duplicated clip
            damped.delete(w.sample.clipName);
            const clip = this._fieldClip(w.sample.clipName);
            if (!clip) {
                // Skipping keeps the rest of the blend alive, but a field where EVERY sample is
                // unresolvable holds the bind pose silently. Warn once per clip name.
                this._warnMissingFieldClip(w.sample.clipName);
                continue;
            }
            const meta = { rateScale: rateScaleOf(w.sample), phaseOffset: phaseOffsetOf(w.sample) };
            this._fieldSampleMeta.set(w.sample.clipName, meta);
            entries.push({
                clipName: w.sample.clipName,
                animation: clip.animation,
                bones: clip.bones,
                duration: clip.duration,
                weight,
                ...meta,
            });
        }

        // Whatever is LEFT in `damped` is fading out and must still be posed. Its sample is gone, so rate
        // scale and phase offset come from the remembered meta — defaulting the offset to 0 would jog it.
        for (const [clipName, weight] of damped) {
            const clip = this._fieldClip(clipName);
            if (!clip) continue;
            const meta = this._fieldSampleMeta.get(clipName);
            entries.push({
                clipName, animation: clip.animation, bones: clip.bones,
                duration: clip.duration, weight,
                rateScale: meta?.rateScale ?? 1,
                phaseOffset: meta?.phaseOffset ?? 0,
            });
        }

        // Dropped samples leave the remainder summing below 1, which would fade towards the bind pose.
        const total = entries.reduce((sum, e) => sum + e.weight, 0);
        if (total > 0 && Math.abs(total - 1) > 1e-6) for (const e of entries) e.weight /= total;

        // Heaviest first, for the debug readout. _mixTransforms is order-independent.
        entries.sort((a, b) => b.weight - a.weight);

        this._fieldEntries = entries;

        // _currentAnimation follows the dominant clip, because event markers are authored per clip. It is
        // NOT used for timing — _getAnimationDuration is field-aware.
        const dominant = this._resolveFieldDominant(entries);
        this._currentAnimation = dominant ? dominant.animation : null;
    }

    // Move the probe towards what the parameters ask for: deadband first (below it the probe does not
    // follow at all), then damp over the axis's smoothing time, along the shortest arc when wrapping.
    // Filtering is runtime-only — the editor preview writes _fieldX/_fieldY directly and skips this.
    private get _fieldFiltering(): boolean { return this._fieldInputs !== null; }

    private _advanceFieldProbe(field: AnimationField): void {
        if (!this._fieldFiltering || !this._fieldInputs) return;

        const read = (name: string | undefined, fallback: number): number => {
            if (!name) return fallback;
            const v = this._paramValues.get(name);
            if (typeof v === 'number') return v;
            if (typeof v === 'boolean') return v ? 1 : 0;
            // Parameter renamed or deleted: hold the last probe rather than snapping the blend to 0.
            return fallback;
        };

        const rawX = read(this._fieldInputs.x, this._fieldTargetX);
        const rawY = read(this._fieldInputs.y, this._fieldTargetY);
        const spanX = axisWrapSpan(field.xAxis);
        const spanY = axisWrapSpan(field.yAxis);

        // Against the committed TARGET, not the damped probe: the probe would let the target creep.
        const dzX = axisDeadzone(field.xAxis);
        const dzY = axisDeadzone(field.yAxis);
        if (Math.abs(this._wrappedGap(rawX, this._fieldTargetX, spanX)) > dzX) this._fieldTargetX = rawX;
        if (Math.abs(this._wrappedGap(rawY, this._fieldTargetY, spanY)) > dzY) this._fieldTargetY = rawY;

        // The first read snaps: damping in from 0 would sweep the blend through every clip on the way.
        if (!this._fieldProbeSeeded) {
            this._fieldProbeSeeded = true;
            this._fieldX = this._fieldTargetX;
            this._fieldY = this._fieldTargetY;
            return;
        }

        // Wall-clock, not playback-scaled: `smoothing` is authored in seconds. See _frameDelta.
        const dt = this._frameDelta;
        this._fieldX = this._dampAxis(this._fieldX, this._fieldTargetX, field.xAxis, spanX, dt);
        this._fieldY = this._dampAxis(this._fieldY, this._fieldTargetY, field.yAxis, spanY, dt);
    }

    /** Signed gap from `b` to `a`, along the shortest arc when the axis wraps (`span <= 0` = straight line). */
    private _wrappedGap(a: number, b: number, span: number): number {
        return wrapSpan(a - b, span);
    }

    private _dampAxis(current: number, target: number, axis: AnimationFieldAxis | undefined, span: number, dt: number): number {
        const seconds = axisSmoothing(axis);
        if (seconds <= 0 || dt <= 0) return target;
        return span > 0
            ? dampWrapped(current, target, span, seconds, dt)
            : dampTime(current, target, seconds, dt);
    }

    // Damp each clip's weight towards the field's, keeping departing clips alive until negligible.
    // Duplicate clip names collapse: one Bone map cannot be posed at two weights.
    private _dampFieldWeights(field: AnimationField, weights: FieldWeight[]): Map<string, number> {
        const targets = new Map<string, number>();
        for (const w of weights) targets.set(w.sample.clipName, (targets.get(w.sample.clipName) ?? 0) + w.weight);

        const seconds = weightSmoothing(field);
        const dt = this._frameDelta;   // wall-clock; see _frameDelta

        // The FIRST evaluation must snap: a zero-weight pose is the bind pose, so damping up from empty
        // would unfold the character into its blend on every state entry.
        const seed = !this._fieldWeightsSeeded;
        this._fieldWeightsSeeded = true;

        if (seed || !this._fieldFiltering || seconds <= 0 || dt <= 0) {
            this._fieldWeightState = targets;
            return new Map(targets);
        }

        const next = new Map<string, number>();
        // The union of what the field wants and what is still fading: a clip missing from `targets` is
        // damped towards 0 rather than dropped.
        const names = new Set<string>([...this._fieldWeightState.keys(), ...targets.keys()]);
        for (const name of names) {
            const target = targets.get(name) ?? 0;
            const current = this._fieldWeightState.get(name) ?? 0;
            const w = dampTime(current, target, seconds, dt);
            if (w <= WEIGHT_FADE_EPSILON && target <= 0) continue;   // faded out; stop posing it
            next.set(name, w);
        }

        this._fieldWeightState = next;
        return new Map(next);
    }

    // The dominant entry, switching only when a rival leads by a margin: _currentAnimation decides which
    // clip's event markers are live, so a flickering dominant fires or drops them at random.
    private _resolveFieldDominant(entries: FieldEntry[]): FieldEntry | null {
        if (entries.length === 0) { this._fieldDominant = null; return null; }

        let best: FieldEntry | null = null;
        for (const e of entries) if (!best || e.weight > best.weight) best = e;

        const held = this._fieldDominant ? entries.find(e => e.clipName === this._fieldDominant) ?? null : null;
        if (held && best && best.weight - held.weight < DOMINANT_SWITCH_MARGIN) return held;

        this._fieldDominant = best ? best.clipName : null;
        return best;
    }

    // Name a field clip the model does not have, once per clip name. The set clears when the field
    // changes, so the warning fires again after a re-import if it is still wrong.
    private _warnMissingFieldClip(clipName: string): void {
        if (this._warnedMissingClips.has(clipName)) return;
        this._warnedMissingClips.add(clipName);
        const available = this._animatedModel?.animations.map(a => a.name).join(', ') || '(none)';
        Logger.warn(
            `Animation field references clip "${clipName}", which this model does not have. That sample is `
            + `skipped; if every sample is missing the field holds the bind pose. Available clips: ${available}`,
            'Animation');
    }

    /** Weighted duration of the active field: what one full cycle of the blended motion lasts. */
    private _fieldDuration(entries: FieldEntry[] | null): number {
        if (!entries || entries.length === 0) return 0;
        let d = 0;
        for (const e of entries) d += e.weight * (e.duration / e.rateScale);
        return d;
    }

    // Pose every contributing clip at the shared phase, scaled to its own length and shifted by its own
    // offset.
    private _poseFieldAt(entries: FieldEntry[], phase: number): void {
        for (const e of entries) {
            // Wrapped, not clamped: the offset moves a clip around its cycle. Strictly greater, not a
            // modulo — phase 1.0 is a real terminal state, and `1 % 1` would snap it back to frame 0.
            let p = phase + e.phaseOffset;
            if (p > 1) p -= 1;
            for (const bone of e.bones.values()) bone.update(p * e.duration);
        }
    }

    // The field-blended local transform for a bone, or null when no contributing clip animates it.
    // `dominantClip` names the entry whose rotation anchors the hemisphere.
    //
    // A weighted mix, ORDER-INDEPENDENT: rotations flatten into one reference hemisphere, sum, and
    // normalize. The reference must be stable frame to frame, or the bug comes back. Reads each clip's
    // sampled T/R/S directly — decomposing the matrix it was just composed into was pure overhead.
    private _fieldLocal(entries: FieldEntry[] | null, key: string, dominantClip?: string | null): mat4 | null {
        if (!entries || entries.length === 0) return null;
        let count = 0;
        let reference: quat | null = null;
        for (const e of entries) {
            const bone = e.bones.get(key);
            if (!bone) continue;
            MIX_BONES[count] = bone;
            MIX_WEIGHTS[count] = e.weight;
            count++;
            // The dominant clip may not animate this bone; the heaviest part anchors it then.
            if (dominantClip && e.clipName === dominantClip) reference = bone.rotation;
        }
        // Partial coverage is left to the caller's bind-pose fallback: mixing against an implicit
        // identity would drag the bone towards the origin.
        if (count === 0) return null;
        if (count === 1) return MIX_BONES[0].localTransform;

        // No dominant: the heaviest part, deterministic for a given set. Its own sign does not matter —
        // negating it negates the whole sum, and q and -q are the same rotation.
        if (!reference) {
            let best = 0;
            for (let i = 1; i < count; i++) if (MIX_WEIGHTS[i] > MIX_WEIGHTS[best]) best = i;
            reference = MIX_BONES[best].rotation;
        }

        vec3.set(MIX_T, 0, 0, 0);
        vec3.set(MIX_S, 0, 0, 0);
        quat.set(MIX_R, 0, 0, 0, 0);   // an accumulator, not a rotation yet
        let total = 0;
        for (let i = 0; i < count; i++) {
            const w = MIX_WEIGHTS[i];
            if (w <= 0) continue;
            const bone = MIX_BONES[i];
            vec3.scaleAndAdd(MIX_T, MIX_T, bone.translation, w);
            vec3.scaleAndAdd(MIX_S, MIX_S, bone.scale, w);
            // Into the reference hemisphere: a quaternion on the far side would cancel rather than add.
            const r = bone.rotation;
            const signed = quat.dot(reference, r) < 0 ? -w : w;
            MIX_R[0] += r[0] * signed;
            MIX_R[1] += r[1] * signed;
            MIX_R[2] += r[2] * signed;
            MIX_R[3] += r[3] * signed;
            total += w;
        }
        if (total === 0) return MIX_BONES[0].localTransform;
        vec3.scale(MIX_T, MIX_T, 1 / total);
        vec3.scale(MIX_S, MIX_S, 1 / total);
        // A zero sum would normalize to NaN and collapse the skeleton.
        if (quat.length(MIX_R) < 1e-8) quat.copy(MIX_R, reference);
        quat.normalize(MIX_R, MIX_R);
        return mat4.fromRotationTranslationScale(arenaMat(), MIX_R, MIX_T, MIX_S);
    }

    /** Local transform of a bone in the CURRENT pose source (field when one is active, else the clip). */
    private _currentLocal(key: string): mat4 | null {
        if (this._fieldEntries) return this._fieldLocal(this._fieldEntries, key, this._fieldDominant);
        return this._bones.get(key)?.localTransform ?? null;
    }

    // Local transform of a bone in the OUTGOING pose source during a cross-fade. Its weights are a
    // frozen snapshot, so they cannot cross and no dominant clip is tracked.
    private _previousLocal(key: string): mat4 | null {
        if (this._previousFieldEntries) return this._fieldLocal(this._previousFieldEntries, key, null);
        return this._previousBones.get(key)?.localTransform ?? null;
    }

    /** {@link playField} under the name the editor uses: play a blend space directly, outside any state. */
    public playBlendSpace(field: AnimationField, x: number, y?: number, loop: boolean = true): void {
        this.playField(field, x, y, loop);
    }

    /** Play a field directly, outside any state machine. Used by the Blend Space editor's preview. */
    public playField(field: AnimationField, x: number, y?: number, loop: boolean = true): void {
        this._fieldX = x;
        this._fieldY = y ?? 0;
        this._startField(field, undefined, loop, false);
    }

    /**
     * Swap in a new definition for the field already playing, without restarting it, so an edit takes
     * effect mid-stride. Falls back to {@link playField} when nothing is playing.
     */
    public updateField(field: AnimationField): void {
        if (!this._fieldDef) { this.playField(field, this._fieldX, this._fieldY); return; }
        this._fieldDef = field;
        this._refreshFieldWeights();
        if (this._fieldEntries) {
            this._poseFieldAt(this._fieldEntries, this._fieldPhase);
            this._recomputePose();
        }
    }

    /** Move the probe of the field currently playing. No-op when no field is active. */
    public setFieldProbe(x: number, y?: number): void {
        if (!this._fieldDef) return;
        this._fieldX = x;
        if (y !== undefined) this._fieldY = y;
        this._refreshFieldWeights();
        // Re-pose immediately so a paused editor preview responds to the probe without needing a tick.
        if (this._fieldEntries) {
            this._poseFieldAt(this._fieldEntries, this._fieldPhase);
            this._recomputePose();
        }
    }

    /** True while a field (rather than a single clip) is producing the pose. */
    public get isPlayingField(): boolean { return this._fieldEntries !== null; }

    /** The clips contributing to the active field right now, for the editor's weight readout. */
    public get activeFieldWeights(): { clipName: string; weight: number }[] {
        return (this._fieldEntries ?? []).map(e => ({ clipName: e.clipName, weight: e.weight }));
    }

    /**
     * Every link between a machine parameter and the pose in one snapshot — raw value, deadbanded target,
     * damped probe, weights — for diagnosing a blend that will not sit still. Allocates; not a per-frame path.
     */
    public get fieldDebug(): {
        active: boolean;
        /** Straight from the machine parameters, before any filtering. Null when an axis is unbound. */
        rawX: number | null; rawY: number | null;
        /** After the axis deadband: what the damping is currently heading towards. */
        targetX: number; targetY: number;
        /** After damping: where the field is actually being sampled. */
        probeX: number; probeY: number;
        weights: { clipName: string; weight: number; phaseOffset: number }[];
        dominant: string | null;
        phase: number;
        /** Weighted cycle length in seconds; moves as the blend shifts. */
        duration: number;
        stateName: string | null;
        /** Seconds since the current state was entered — what a minDwell gate is measured against. */
        stateTime: number;
        /**
         * Every live machine parameter, not only the two bound to the axes — a state change is driven by a
         * parameter on a transition condition, which may be neither of them.
         */
        params: { name: string; value: number | boolean }[];
        /** True when the current state is meant to play a field — so "no field" can be told from "not a field state". */
        stateWantsField: boolean;
    } {
        const raw = (name: string | undefined): number | null => {
            if (!name) return null;
            const v = this._paramValues.get(name);
            if (typeof v === 'number') return v;
            if (typeof v === 'boolean') return v ? 1 : 0;
            return null;
        };
        return {
            active: this._fieldEntries !== null,
            rawX: raw(this._fieldInputs?.x),
            rawY: raw(this._fieldInputs?.y),
            targetX: this._fieldTargetX, targetY: this._fieldTargetY,
            probeX: this._fieldX, probeY: this._fieldY,
            weights: (this._fieldEntries ?? []).map(e => ({
                clipName: e.clipName, weight: e.weight, phaseOffset: e.phaseOffset,
            })),
            dominant: this._fieldDominant,
            phase: this._fieldPhase,
            duration: this._fieldDuration(this._fieldEntries),
            stateName: this._currentStateName,
            stateTime: this._stateTime,
            params: (this._stateMachine?.parameters ?? []).map(p => ({
                name: p.name,
                value: this._paramValues.get(p.name) ?? p.default,
            })),
            stateWantsField: !!this._currentState?.fieldId || !!this._currentState?.field,
        };
    }

    /** The AnimationState the machine is currently in, or null. */
    private get _currentState(): AnimationState | null {
        const sm = this._stateMachine;
        if (!sm || !this._currentStateName) return null;
        return this._stateByName(sm, this._currentStateName);
    }

    /**
     * A state by name, through a lookup rebuilt only when the machine or its state list changes. Asked
     * for several times per frame per character; a linear `find` each time added up. A machine edited in
     * place (a renamed state) is caught by the name check and rebuilt.
     */
    private _stateByName(sm: AnimationStateMachine, name: string): AnimationState | null {
        let lookup = this._stateLookup;
        if (!lookup || lookup.sm !== sm || lookup.states !== sm.states || lookup.length !== sm.states.length) {
            lookup = this._stateLookup = { sm, states: sm.states, length: sm.states.length, map: new Map() };
            for (const state of sm.states) if (!lookup.map.has(state.name)) lookup.map.set(state.name, state);
        }
        const state = lookup.map.get(name);
        if (state && state.name === name) return state;
        // Missing or renamed since the lookup was built: answer exactly, and rebuild next time.
        this._stateLookup = null;
        return sm.states.find(s => s.name === name) ?? null;
    }
    private _stateLookup: { sm: AnimationStateMachine; states: AnimationState[]; length: number;
                            map: Map<string, AnimationState> } | null = null;

    /** Advance playback by `deltaTime` seconds and recompute the pose. */
    public update(deltaTime: number): void {
        // Ragdoll takes over: drive bones from physics bodies, skip all animation.
        if (this._ragdollActive) {
            this._updateRagdollMatrices();
            return;
        }
        this._capturePreviousPose(deltaTime);
        // A layer's animator poses whenever the animator it belongs to does; see _skipPose.
        if (!this._isOverlay) {
            this._skipPose = false;
            if (this._lodStride > 1) {
                this._lodCountdown--;
                if (this._lodCountdown > 0) this._skipPose = true;
                else this._lodCountdown = this._lodStride;
            }
        }
        this._ikDelta += Math.max(0, deltaTime);
        if (this._overlays.length) {
            for (const o of this._overlays) o.animator._skipPose = this._skipPose;
            this._updateOverlays(deltaTime);
        }
        this._posedThisFrame = false;
        this._advance(deltaTime);
        // The base can be idle (a finished one-shot, a bind pose) while a layer or an action still moves.
        if (!this._posedThisFrame && !this._skipPose) {
            for (const o of this._overlays) if (o.presence > 0) { this._recomputePose(); break; }
        }
    }

    // ---- Animation LOD ------------------------------------------------------------------------------
    //
    // A character nobody can see, or one far away, does not need a fresh pose every frame. Its clock,
    // state machine, field weights, event markers and root motion still advance EVERY frame — gameplay
    // reads those — but sampling, blending, skinning and foot IK run every `_lodStride` frames. Sockets
    // and hitboxes on such a character therefore refresh at that rate too.

    /** Tunables, shared by every animator. `enabled: false` poses every character every frame. */
    public static lod = {
        enabled: true,
        /** Visible and nearer than this (metres, to its bounds): full rate, foot IK on. */
        fullDistance: 25,
        /** Off-screen but nearer than this: every 2nd frame, no foot IK. Beyond: every 4th. */
        offscreenNear: 15,
    };

    /** Never reduce this animator: a character whose pose must be exact every frame (set from scripts). */
    public lodExempt = false;

    /** Frames between poses: 1 = every frame. */
    private _lodStride = 1;
    private _lodCountdown = 0;
    /** This frame's pose is skipped (stride). A layer inherits it from the animator it belongs to. */
    private _skipPose = false;
    /** Wall-clock time since foot IK last ran, so its smoothing keeps real time across skipped frames. */
    private _ikDelta = 0;

    /** Pick the LOD tier from what the camera saw last frame. Called by ModelNode before each update. */
    public setLod(visible: boolean, distance: number): void {
        const lod = Animator.lod;
        let stride = 1;
        let ik = true;
        if (lod.enabled && !this.lodExempt) {
            if (visible) {
                if (distance > lod.fullDistance) stride = 2;
            } else {
                stride = distance > lod.offscreenNear ? 4 : 2;
                ik = false;
            }
        }
        if (stride !== this._lodStride) {
            this._lodStride = stride;
            // Pose on the very next frame after a tier change: a character stepping into view must not
            // show a pose that is several frames old.
            this._lodCountdown = 1;
        }
        this._ikAllowed = ik;
    }

    private _advance(deltaTime: number): void {

        // Above every early return: a finished clip sets _playing false, and freezing the clock a
        // minDwell gate waits on would lock the machine in that state permanently.
        if (deltaTime > 0) this._stateTime += deltaTime;
        // Same placement, same reason: a machine bouncing between two finished clips would otherwise
        // measure its own flip rate as infinite.
        if (deltaTime > 0) this._animatorClock += deltaTime;

        // Prefer the nearest bodied ancestor's measured speed: the fallback reads `this._node.position`,
        // a LOCAL offset, which is pinned at 0 for the standard character rig.
        if (this._node && deltaTime > 0) {
            const bodied = this._nearestBodiedNode();
            if (bodied) {
                this._currentSpeed = bodied.currentSpeed;
            } else {
                const currentPosition = this._node.position;
                const distance = vec3.distance(currentPosition, this._lastPosition);
                this._currentSpeed = distance / deltaTime;
                vec3.copy(this._lastPosition, currentPosition);
            }
        }
        
        if (!this._skin || !this._playing) {
            return;
        }
        // A field poses several clips and has no single _currentAnimation to gate on; either source will do.
        if (!this._currentAnimation && !this._fieldEntries) {
            return;
        }

        this._deltaTime = deltaTime * this._speed;
        this._frameDelta = deltaTime;

        // Update blend time if blending
        if (this._isBlending) {
            this._currentBlendTime += this._deltaTime;
            if (this._currentBlendTime >= this._activeBlendTime) {
                // Blend complete
                this._isBlending = false;
                this._previousAnimation = null;
                this._previousBones.clear();
                this._previousFieldEntries = null;
            }
        }

        // A field's weights track the probe continuously, so they are re-sampled before this frame is posed.
        if (this._fieldDef) this._refreshFieldWeights();

        // Get animation duration (assuming it's the max timestamp in samplers)
        const duration = this._getAnimationDuration();

        // Update current time (remember the pre-advance time for event-marker crossing)
        const prevTime = this._currentTime;
        let looped = false;

        if (this._fieldEntries) {
            // Advance the normalized PHASE, then project onto the weighted duration — never the reverse.
            // The duration moves as the blend shifts, so a wall-clock phase would jog the pose.
            this._prevFieldPhase = this._fieldPhase;
            if (duration > 0) this._fieldPhase += this._deltaTime / duration;
            if (this._fieldPhase >= 1) {
                this._loopsPlayed++;
                if (this._loop && (this._loopLimit === 0 || this._loopsPlayed < this._loopLimit)) {
                    this._fieldPhase = this._fieldPhase % 1;
                    looped = true;
                } else {
                    this._fieldPhase = 1;
                    this._playing = false;
                    this._finishBlend();
                }
            }
            this._currentTime = this._fieldPhase * duration;
        } else {
            this._currentTime += this._deltaTime;

            // Handle looping or stopping
            if (this._currentTime >= duration) {
                this._loopsPlayed++;
                // _loopLimit counts PLAYS, so the pass just finished counts; 0 means forever. Once spent,
                // the clip holds its last frame like a non-looping one.
                if (this._loop && (this._loopLimit === 0 || this._loopsPlayed < this._loopLimit)) {
                    this._currentTime = this._currentTime % duration;
                    looped = true;
                } else {
                    this._currentTime = duration;
                    this._playing = false;
                    // Finish any blend still in flight: update() returns early from here on, so the pose
                    // would otherwise be stuck at a partial mix. Reachable when a clip is shorter than the blend.
                    this._finishBlend();
                }
            }
        }

        // A field's `_currentTime` is not monotonic — the weighted duration moves — so both phases are
        // projected through the SAME duration before the markers are compared.
        if (this._fieldEntries) {
            this._fireDueEvents(this._prevFieldPhase * duration, this._fieldPhase * duration, duration, looped);
        } else {
            this._fireDueEvents(prevTime, this._currentTime, duration, looped);
        }

        // Update all bones with current animation time — unless the LOD skips this frame's pose, in which
        // case only what gameplay reads (time, events above, root motion below) moves on.
        const pose = !this._skipPose;
        if (this._fieldEntries) {
            if (pose) this._poseFieldAt(this._fieldEntries, this._fieldPhase);
        } else {
            if (pose) for (const bone of this._bones.values()) bone.update(this._currentTime);
            // After the pose loop: it drives the character, then pins the root bone to the locked reference.
            // Every frame: root motion samples the root bone on its own, and it is what moves the character.
            if (this._rootMotionActive) this._applyRootMotion(prevTime, this._currentTime, duration, looped);
        }

        // The outgoing motion keeps playing under the cross-fade; freezing it stops the legs mid-stride.
        if (this._isBlending && this._previousFieldEntries) {
            if (this._previousAdvancing) {
                const previousDuration = this._fieldDuration(this._previousFieldEntries);
                if (previousDuration > 0) this._previousFieldPhase += this._deltaTime / previousDuration;
                if (this._previousFieldPhase >= 1) {
                    this._previousFieldPhase = this._previousLoop ? this._previousFieldPhase % 1 : 1;
                }
            }
            // The outgoing field keeps its snapshot weights; the live probe must not steer it.
            if (pose) this._poseFieldAt(this._previousFieldEntries, this._previousFieldPhase);
        } else if (this._isBlending && this._previousAnimation) {
            if (this._previousAdvancing) {
                const previousDuration = this._getPreviousAnimationDuration();
                this._previousTime += this._deltaTime;
                if (this._previousTime >= previousDuration) {
                    // Only a looping clip wraps; wrapping a finished one restarts it under the blend.
                    this._previousTime = this._previousLoop ? this._previousTime % previousDuration : previousDuration;
                }
            }
            // Not advancing means the clip finished before the blend began; it holds its last pose.
            if (pose) {
                for (const bone of this._previousBones.values()) bone.update(this._previousTime);
                // The re-sample above overwrote the outgoing clip's root pin; put it back.
                this._pinPreviousRoot();
            }
        }

        // Turn the current bone local transforms into final skinning matrices.
        if (pose) this._recomputePose();
    }

    // ---- Root motion -----------------------------------------------------------------------------

    // Arm or disarm root motion for the clip that just started, capturing the pose the extraction will
    // lock the mesh to.
    private _setupRootMotion(animation: Animation): void {
        this._rootMotionActive = false;
        this._rootBoneName = null;
        // Only the base layer moves the character: two layers both driving it would double the motion.
        // An action may ask for its travel to be EXTRACTED (pinned and handed to a script) -- even on a clip
        // not flagged root-motion, which is how an in-place import would otherwise carry its travel.
        if (this._isOverlay ? !this._extractRoot : !animation.rootMotion) return;

        const rootName = this._findRootMotionBone(animation);
        const bone = rootName ? this._bones.get(rootName) : null;
        if (!bone) return;

        const ref = bone.sampleTR(0);
        vec3.copy(this._rootRefT, ref.t);
        quat.copy(this._rootRefR, ref.r);
        // Scale comes from the bind pose, so the locked matrix keeps the rig's own scale.
        vec3.set(this._rootRefS, 1, 1, 1);
        const rest = this._skin?.nodeTransforms?.get(bone.id);
        if (rest) mat4.getScaling(this._rootRefS, rest);

        this._rootParentRot = this._rootParentRotation(bone.id);
        this._rootParentScale = this._skin ? rootParentScale(this._skin, bone.id, this._topology()) : 1;
        // The axis the root sits up along at rest (a metre up one axis, near zero on the others) -- the
        // same rule the offline in-place hold uses, so it holds whether the rig is Y-up or Z-up.
        if (rest) {
            const t = mat4.getTranslation(vec3.create(), rest);
            this._rootUpAxis = [0, 1, 2].reduce((best, a) => (Math.abs(t[a]) > Math.abs(t[best]) ? a : best), 1);
        }
        this._rootBoneName = rootName;
        this._rootMotionActive = true;
    }

    // Accumulated rotation of the joints ABOVE `rootNodeIndex`, in the model node's local space — the
    // axis basis the root bone's channels are expressed in. Those joints are static, so bind is live.
    //
    // Delegated to `clipEdit.ts` so the runtime and the editor's in-place BAKE share one definition. They
    // have to: the bake strips exactly the motion this term describes, and a disagreement would leave
    // residual travel that the editor cannot show — it drives the animator directly, so a baked clip would
    // look correct there and drift only in the published game.
    private _rootParentRotation(rootNodeIndex: number): quat {
        if (!this._skin) return quat.create();
        return rootParentRotation(this._skin, rootNodeIndex, this._topology());
    }

    /**
     * Pin one bone's LOCAL transform, overriding whatever is posing it. `null` releases it.
     *
     * For the clip editor's gizmo. The honest way to show a posed bone would be to write the key and re-bind
     * the clip, but `playAnimation` re-transcodes every channel into fresh `Bone` objects — `O(bones × keys)`
     * plus a log line — which is far too much for a 60 Hz drag. An override is read straight out of
     * `_recomputePose`, so a drag costs one map lookup per bone per frame.
     *
     * Survives a `seek`, deliberately: scrubbing while holding a bone in place is how you check a pose
     * against the frames around it. `showBindPose` clears them, since nothing should still be pinned once
     * the character is back at rest.
     */
    public setBoneLocalOverride(nodeIndex: number, local: mat4 | null): void {
        if (!local) {
            this._boneOverrides?.delete(nodeIndex);
            if (this._boneOverrides?.size === 0) this._boneOverrides = null;
        } else {
            // A NaN pin would poison this bone and every descendant for as long as it is held.
            for (let i = 0; i < 16; i++) {
                if (!Number.isFinite(local[i])) {
                    Logger.warn(`Ignored a non-finite pose for bone node ${nodeIndex}`, 'Animation');
                    return;
                }
            }
            (this._boneOverrides ??= new Map()).set(nodeIndex, mat4.clone(local));
        }
        this._recomputePose();
    }

    /** Release every pinned bone. */
    public clearBoneLocalOverrides(): void {
        if (!this._boneOverrides) return;
        this._boneOverrides = null;
        this._recomputePose();
    }

    /** The transform pinned on a bone, or null. */
    public boneLocalOverride(nodeIndex: number): mat4 | null {
        return this._boneOverrides?.get(nodeIndex) ?? null;
    }

    /**
     * The LOCAL transform posing one bone right now — an editor override, the clip or field under the
     * playhead, or the bone's rest when nothing drives it.
     *
     * The same answer `_recomputePose` uses, minus the cross-fade: a blend is a transient between two
     * clips, and an editor reading a bone in order to key it wants the pose the CURRENT clip holds, not a
     * frame of the transition into it.
     */
    public boneLocalTransform(nodeIndex: number): mat4 | null {
        if (!this._skin) return null;
        const override = this._boneOverrides?.get(nodeIndex);
        if (override) return mat4.clone(override);
        const current = this._currentLocal(boneKey(nodeIndex));
        if (current) return mat4.clone(current);
        const rest = this._skin.nodeTransforms?.get(nodeIndex);
        return rest ? mat4.clone(rest) : mat4.create();
    }

    /** A bone's REST transform, for an editor that needs to express a pose as a delta from it. */
    public boneRestTransform(nodeIndex: number): mat4 | null {
        if (!this._skin) return null;
        const rest = this._skin.nodeTransforms?.get(nodeIndex);
        return rest ? mat4.clone(rest) : mat4.create();
    }

    // The clip's root-motion bone: the HIGHEST joint it actually animates, so a static-armature rig works
    // as well as one whose root bone carries the motion. Null when the clip animates no joints.
    //
    // The rule itself lives in `clipEdit.ts` — see `_rootParentRotation` above for why there is exactly one
    // of it. This wrapper only turns the node index into the `bone_N` key `_bones` is filled with.
    private _findRootMotionBone(animation: Animation): string | null {
        if (!this._skin) return null;
        const node = rootMotionNodeOf(animation, this._skin, this._topology());
        return node === null ? null : `bone_${node}`;
    }

    // Apply this frame's root-bone delta to the character, then pin the bone to its clip-start reference.
    // The local delta is brought into world space through `Wp = nodeWorldRotation · armatureParentRotation`;
    // omitting the armature term turns an authored yaw into a roll.
    private _applyRootMotion(prevTime: number, curTime: number, duration: number, looped: boolean): void {
        const bone = this._rootBoneName ? this._bones.get(this._rootBoneName) : null;
        if (!bone) return;

        const deltaT = vec3.create();
        const deltaR = quat.create();
        const cur = bone.sampleTR(curTime);
        const prev = bone.sampleTR(prevTime);

        if (this._isOverlay) { this._extractRootTravel(bone, cur, prev, curTime, duration, looped); return; }

        if (looped && duration > 0) {
            // Two spans across the loop point: prev→end and start→cur.
            const end = bone.sampleTR(duration);
            const start = bone.sampleTR(0);
            vec3.sub(deltaT, end.t, prev.t);
            const seg2 = vec3.create();
            vec3.sub(seg2, cur.t, start.t);
            vec3.add(deltaT, deltaT, seg2);

            const spanEnd = quat.create();
            quat.multiply(spanEnd, end.r, quat.invert(quat.create(), prev.r));
            const spanStart = quat.create();
            quat.multiply(spanStart, cur.r, quat.invert(quat.create(), start.r));
            quat.multiply(deltaR, spanStart, spanEnd);
        } else {
            vec3.sub(deltaT, cur.t, prev.t);
            quat.multiply(deltaR, cur.r, quat.invert(quat.create(), prev.r));
        }
        quat.normalize(deltaR, deltaR);

        // Rotate the translation by Wp, and CONJUGATE the rotation by it, so a yaw about the armature's
        // up-axis becomes a yaw about world up. (An action's slot animator has no node: Wp is then the
        // armature's alone, and the delta stays in MODEL space for consumeRootMotion to place.)
        const wp = quat.multiply(
            quat.create(),
            this._node ? this._node.worldQuaternion : quat.create(),
            this._rootParentRot);
        quat.normalize(wp, wp);
        const wpInv = quat.invert(quat.create(), wp);
        // Into metres: the armature's own scale (bones in centimetres under a 0.01 armature) and the
        // character node's. Without them a Mixamo death clip's one-metre fall moved the body 100 m.
        const nw = this._node?.worldTransform;
        const nodeScale = nw ? Math.cbrt(Math.abs(mat4.determinant(nw as mat4))) || 1 : 1;
        vec3.scale(deltaT, deltaT, this._rootParentScale * nodeScale);
        const worldT = vec3.transformQuat(vec3.create(), deltaT, wp);

        if (this._isOverlay) {
            // An action's travel: collected for the script (consumeRootMotion), never applied here.
            vec3.add(this._rootDelta, this._rootDelta, worldT);
        } else {
            const target = this._nearestBodiedNode() ?? this._node;
            if (target) {
                target.setPosition(vec3.add(vec3.create(), target.position, worldT));
                // World-space rotation delta, so it LEFT-multiplies the target's (world = local) orientation.
                const worldR = quat.multiply(quat.create(), quat.multiply(quat.create(), wp, deltaR), wpInv);
                const newQ = quat.normalize(quat.create(), quat.multiply(quat.create(), worldR, target.quaternion));
                target.setQuaternion(newQ);
                // setQuaternion does not push into the body, so a bodied target needs it set explicitly.
                if (target.body) target.body.setQuaternion(newQ);
            }
        }

        // Pin the root bone to its start pose: the character carries the motion, the mesh renders in place.
        const locked = mat4.create();
        mat4.fromRotationTranslationScale(locked, this._rootRefR, this._rootRefT, this._rootRefS);
        bone.setLocalTransform(locked);
    }

    /**
     * An action's root motion (AnimationActionOptions.rootMotion): take only the GROUND-PLANE travel and
     * leave everything else animating. A roll or a dive tumbles its hips through a full turn and bobs them
     * up and down -- pinning the whole root as the base layer does would freeze the tumble.
     */
    private _extractRootTravel(bone: { setLocalTransform(m: mat4): void; sampleTR(t: number): { t: vec3; r: quat } },
                               cur: { t: vec3; r: quat }, prev: { t: vec3; r: quat },
                               curTime: number, duration: number, looped: boolean): void {
        const up = this._rootUpAxis;
        const deltaT = vec3.create();
        if (looped && duration > 0) {
            const end = bone.sampleTR(duration), start = bone.sampleTR(0);
            vec3.add(deltaT, vec3.sub(vec3.create(), end.t, prev.t), vec3.sub(vec3.create(), cur.t, start.t));
        } else {
            vec3.sub(deltaT, cur.t, prev.t);
        }
        deltaT[up] = 0;
        vec3.scale(deltaT, deltaT, this._rootParentScale);
        vec3.transformQuat(deltaT, deltaT, this._rootParentRot);   // model space; consumeRootMotion places it
        vec3.add(this._rootDelta, this._rootDelta, deltaT);

        // Pin the horizontal position to the start; keep the clip's own rotation and height.
        const t = vec3.clone(cur.t);
        for (let a = 0; a < 3; a++) if (a !== up) t[a] = this._rootRefT[a];
        const pinned = mat4.fromRotationTranslationScale(mat4.create(), cur.r, t, this._rootRefS);
        bone.setLocalTransform(pinned);
        void curTime;
    }

    // Remember the current clip's root pin as the outgoing one. Called as a cross-fade starts, BEFORE the
    // incoming clip re-arms (and overwrites) the root-motion reference.
    private _capturePreviousRootPin(): void {
        if (!this._rootMotionActive || !this._rootBoneName) { this._prevRootBoneName = null; return; }
        this._prevRootBoneName = this._rootBoneName;
        vec3.copy(this._prevRootRefT, this._rootRefT);
        quat.copy(this._prevRootRefR, this._rootRefR);
        vec3.copy(this._prevRootRefS, this._rootRefS);
    }

    // Lock the outgoing clip's root bone to its reference, exactly as `_applyRootMotion` does for the
    // current clip.
    private _pinPreviousRoot(): void {
        const bone = this._prevRootBoneName ? this._previousBones.get(this._prevRootBoneName) : null;
        if (!bone) return;
        const locked = mat4.create();
        mat4.fromRotationTranslationScale(locked, this._prevRootRefR, this._prevRootRefT, this._prevRootRefS);
        bone.setLocalTransform(locked);
    }

    /** Drop a cross-fade in flight and everything it was fading out of. */
    private _finishBlend(): void {
        if (!this._isBlending) return;
        this._isBlending = false;
        this._previousAnimation = null;
        this._previousBones.clear();
        this._previousFieldEntries = null;
    }

    // This skin's topology, keyed on the Skin OBJECT: a hierarchy is fixed once parsed, so identity is
    // the whole invalidation rule.
    private _topology(): SkeletonTopology {
        if (!this._topologyCache || this._topologySkin !== this._skin) {
            this._topologySkin = this._skin;
            this._topologyCache = skeletonTopology(this._skin!);
            // A different skeleton means the damped IK state describes bones that may no longer exist.
            this._ikFootWeights.clear();
            this._ikFootHits.clear();
            this._ikHipOffset = 0;
        }
        return this._topologyCache;
    }

    // Recompute _finalBoneMatrices from the bones' current local transforms. Separate from update() so
    // seek() can pose at an arbitrary time without advancing the clock or running triggers.
    /**
     * This animator's own local pose for one bone — the clip or field, cross-faded with the outgoing one —
     * or null when nothing it plays drives that bone. No editor override, no rest fallback, no overlays.
     */
    private _sourceLocal(nodeIndex: number): mat4 | null {
        const key = boneKey(nodeIndex);
        const current = this._currentLocal(key);
        if (!current) return null;
        const previous = this._isBlending ? this._previousLocal(key) : null;
        if (!previous) return current;
        // A zero blend duration is legal and means "instant"; dividing by it would give NaN.
        const blendFactor = this._activeBlendTime > 0
            ? Math.min(this._currentBlendTime / this._activeBlendTime, 1.0)
            : 1.0;
        return this._blendTransforms(previous, current, blendFactor);
    }

    // Reused by _recomputePose every frame, so posing a skeleton allocates nothing: it used to build two
    // Maps and a fresh mat4 per joint per frame for every animated model.
    private readonly _poseLocals = new Map<number, mat4>();
    private readonly _poseGlobals = new Map<number, mat4>();
    private readonly _globalPool = new Map<number, mat4>();

    private _recomputePose(): void {
        // A layer's animator hands its pose to the parent; skinning matrices are the parent's job.
        if (this._isOverlay) return;
        this._posedThisFrame = true;
        if (!this._skin) return;
        // Every blended local of the previous pose is dead now; see POSE_ARENA.
        poseArenaUsed = 0;

        const skin = this._skin;
        const localTransforms = this._poseLocals;
        localTransforms.clear();
        for (let jointIndex = 0; jointIndex < skin.joints.length; jointIndex++) {
            const nodeIndex = skin.joints[jointIndex].nodeIndex;
            localTransforms.set(nodeIndex, this._resolveLocal(nodeIndex));
        }

        // The nodes BETWEEN joints are animated too: an assimp-converted FBX puts a bone's rotation curve
        // on a `$AssimpFbx$` pivot, so reading only joints leaves every such bone in its bind orientation.
        const topo = this._topology();
        for (const chain of topo.parentChain)
            for (const nodeIndex of chain)
                if (!localTransforms.has(nodeIndex)) localTransforms.set(nodeIndex, this._resolveLocal(nodeIndex));

        // Accumulate global transforms down the hierarchy. A flat loop, because `topo.order` guarantees a
        // parent is finished before any child asks for it.
        const globalTransforms = this._poseGlobals;
        globalTransforms.clear();
        for (const jointIndex of topo.order) {
            const nodeIndex = skin.joints[jointIndex].nodeIndex;
            let global = this._globalPool.get(nodeIndex);
            if (!global) { global = mat4.create(); this._globalPool.set(nodeIndex, global); }
            this._accumulate(global, jointIndex, topo);
            globalTransforms.set(nodeIndex, global);
        }

        // After the pose is accumulated and before the bind matrices fold in: IK needs to know where the
        // feet ended up, and writing corrected LOCALS lets the loop above be re-run verbatim.
        // Each IK change re-accumulates the subtree it moved, so nothing is left to redo afterwards.
        this._applyFootIk(localTransforms, globalTransforms, topo);
        this._ikDelta = 0;

        // finalMatrix = globalTransform × inverseBindMatrix. NO `inverse(globalTransform(meshNode))` term:
        // glTF includes one only for implementations that also apply the mesh node's transform, and this
        // engine ignores it. Adding it back scales every skinned model by its inverse.
        for (let jointIndex = 0; jointIndex < skin.joints.length; jointIndex++) {
            const joint = skin.joints[jointIndex];
            const globalTransform = globalTransforms.get(joint.nodeIndex) ?? IDENTITY;
            mat4.multiply(this._finalBoneMatrices[jointIndex], globalTransform, joint.inverseBindMatrix);
            mat4.copy(this._jointModelMatrices[jointIndex] ??= mat4.create(), globalTransform);
        }
    }

    /** Whatever is posing this node right now — a clip, a weighted field blend, or its rest transform. */
    private _resolveLocal(nodeIndex: number): mat4 {
        // An editor override outranks every pose source. Checked FIRST so a bone being dragged holds
        // still while the clip underneath keeps playing on every other bone — which is what makes it
        // possible to pose an arm against the walk cycle it will be keyed into.
        const override = this._boneOverrides?.get(nodeIndex);
        if (override) return override;
        // Nothing playing drives the bone: use the initial node transform from GLTF, or identity.
        const base = this._sourceLocal(nodeIndex) ?? this._skin!.nodeTransforms?.get(nodeIndex) ?? IDENTITY;
        return this._overlays.length ? this._applyOverlays(nodeIndex, base) : base;
    }

    /**
     * parentGlobal x (the non-joint nodes between) x local, into `out` — the one accumulation the pose and
     * foot IK share. Never caches the skin's rest matrix by reference: globals are written in place.
     */
    private _accumulate(out: mat4, jointIndex: number, topo: SkeletonTopology): void {
        const skin = this._skin!;
        const parentJoint = topo.parentJoint[jointIndex];
        if (parentJoint >= 0) mat4.copy(out, this._poseGlobals.get(skin.joints[parentJoint].nodeIndex)!);
        else mat4.identity(out);
        for (const nodeIndex of topo.parentChain[jointIndex]) {
            const local = this._poseLocals.get(nodeIndex) ?? skin.nodeTransforms?.get(nodeIndex);
            if (local) mat4.multiply(out, out, local);
        }
        const nodeIndex = skin.joints[jointIndex].nodeIndex;
        mat4.multiply(out, out, this._poseLocals.get(nodeIndex) ?? skin.nodeTransforms?.get(nodeIndex) ?? IDENTITY);
    }

    // ---- Foot IK ----------------------------------------------------------------------------------
    // Plant each foot on whatever is under it and lower the pelvis when a leg cannot reach. Works in the
    // MODEL-space pose; the ground query is a world raycast brought back through inverse(worldTransform).
    // A no-op without a rig, without physics, or at zero weight.

    // The IK weight this frame: the current state's, or the parameter it names. A missing parameter
    // keeps the static weight rather than reading 0.
    private _stateIkWeight(): number {
        // An action that turns IK off (a roll) eases it out as the action fades in, and back as it fades out.
        let actions = 1;
        for (const o of this._overlays) {
            if (o.kind === 'slot' && o.action && o.action.ikWeight < 1) actions *= 1 + (o.action.ikWeight - 1) * o.presence;
        }
        return actions * this._stateIkWeightOfState();
    }

    private _stateIkWeightOfState(): number {
        const sm = this._stateMachine;
        const state = sm && this._currentStateName ? this._stateByName(sm, this._currentStateName) : null;
        if (!state) return 1;
        if (state.ikWeightParam) {
            const v = this._paramValues.get(state.ikWeightParam);
            if (typeof v === 'number') return clamp(v, 0, 1);
            if (typeof v === 'boolean') return v ? 1 : 0;
        }
        return typeof state.ikWeight === 'number' ? clamp(state.ikWeight, 0, 1) : 1;
    }

    // The rig's usable chains, validated once per rig object and warned about once. A rig is replaced
    // wholesale when edited, so identity is the invalidation rule.
    private _validatedRig(rig: IkRig, topo: SkeletonTopology): IkRigValidation {
        if (this._rigValidation && this._validatedRigRef === rig) return this._rigValidation;
        this._validatedRigRef = rig;
        this._rigValidation = validateIkRig(rig, topo, isAncestorJoint,
            node => this._skin?.nodeNames?.get(node) ?? `node ${node}`);

        for (const p of this._rigValidation.problems) {
            const where = p.leg >= 0 ? `Foot IK leg ${p.leg + 1}` : 'Foot IK';
            Logger.warn(`${where}: ${p.message}. That part of the rig is ignored.`, 'Animation');
        }
        return this._rigValidation;
    }

    // Solve foot placement into `localTransforms`; true means the caller must re-accumulate. A stance/swing
    // split — deciding which feet are planted needs every foot's clearance, hence the separate passes.
    private _applyFootIk(
        localTransforms: Map<number, mat4>,
        globalTransforms: Map<number, mat4>,
        topo: SkeletonTopology,
    ): boolean {
        const rig = this._skin?.ikRig;
        if (!rig || !rig.feet?.length || !this._node) return false;

        const physics = this._node.scene?.physics;
        if (!physics) return false;

        // Only the chains the skeleton supports: a rig can name the right bones and still not be a leg.
        const checked = this._validatedRig(rig, topo);
        if (checked.feet.length === 0) return false;

        const weight = this._stateIkWeight();
        const tuning = ikTuning(rig);
        // Wall-clock, not playback-scaled: a foot easing onto a step reacts to the ground, not to the
        // clip. dt is 0 on a scrub, which resolves targets without advancing the smoothing.
        // Real time since IK last ran: equal to the frame delta at full rate, several frames under the LOD.
        const dt = Math.min(this._ikDelta, this._frameDelta * Math.max(1, this._lodStride));

        const nodeWorld = this._node.worldTransform;
        const worldToModel = IK_WORLD_TO_MODEL;
        // A degenerate world transform has no inverse and nothing to place a foot against.
        if (!mat4.invert(worldToModel, nodeWorld)) return false;
        // Gravity-up in MODEL space: a direction, so translation is dropped, and renormalized because a
        // scaled character's model space is not metric.
        const upWorld = physics.up;
        const up = vec3.transformMat4(IK_UP, upWorld, worldToModel);
        const originModel = vec3.transformMat4(IK_ORIGIN, vec3.set(IK_ZERO, 0, 0, 0), worldToModel);
        vec3.sub(up, up, originModel);
        if (vec3.length(up) < 1e-8) return false;
        vec3.normalize(up, up);
        // The character's facing in MODEL space, flattened onto the ground plane: where a knee should point
        // when the clip itself does not say (a leg animated near-straight has no bend plane of its own).
        // A node faces its local +Z (Node.worldForward), and model space IS the node's local space.
        const forward = vec3.set(IK_FORWARD, 0, 0, 1);
        vec3.scaleAndAdd(forward, forward, up, -vec3.dot(forward, up));
        if (vec3.length(forward) > 1e-8) vec3.normalize(forward, forward);

        const ownBody = this._nearestBodiedNode()?.body ?? null;
        // No ground query at all while the character is in the air (a jump, a fall, a dodge off a ledge):
        // the feet fade out exactly as they do over a ray that misses, without paying for the ray. Only a
        // DYNAMIC body is asked — a kinematic or scripted one has no contacts to be grounded by.
        const airborne = !!ownBody && (ownBody as { mass?: number }).mass! > 0
            && typeof (physics as { isGrounded?: unknown }).isGrounded === 'function'
            && !(physics as { isGrounded(b: unknown): boolean }).isGrounded(ownBody);
        // The LOD tier can withhold the query too: see `_ikAllowed`.
        const query = !airborne && this._ikAllowed;

        // ---- Pass 1a: where does each foot want to be? -------------------------------------------------
        // Only where it WANTS to be — whether it goes there is pass 1b's job, and that needs every
        // foot's clearance, so it cannot be decided inside this loop.
        const plans = this._ikPlans;
        let planCount = 0;

        for (const chain of checked.feet) {
            // A half-assigned chain is normal while authoring; skip it rather than throwing.
            const ankleGlobal = globalTransforms.get(chain.foot);
            if (!ankleGlobal || !globalTransforms.get(chain.thigh) || !globalTransforms.get(chain.shin)) continue;

            const key = chain.foot;
            let hit: { point: vec3; normal: vec3 } | null = null;
            if (query) {
                const ankle = mat4.getTranslation(IK_TMP, ankleGlobal);
                const ankleWorld = vec3.transformMat4(IK_ANKLE_WORLD, ankle, nodeWorld);
                const from = vec3.scaleAndAdd(IK_FROM, ankleWorld, upWorld, tuning.traceUp);
                const to = vec3.scaleAndAdd(IK_TO, ankleWorld, upWorld, -tuning.traceDown);
                // Ground only: another character's capsule, a ragdoll limb or a loose prop under a foot is
                // not something to plant on, and skipping dynamic bodies before any shape test is most of
                // what a foot ray used to cost.
                hit = physics.raycast(from, to, { ignore: ownBody, groundOnly: true });
            }

            const prev = this._ikFootWeights.get(key) ?? 0;
            // No ground: fade out rather than switch off, or a ledge lip snaps the foot on and off.
            const target = hit ? weight : 0;
            const next = tuning.smoothing > 0 && dt > 0 ? dampTime(prev, target, tuning.smoothing, dt) : target;
            this._ikFootWeights.set(key, next);

            // Fading out needs somewhere to fade TO: with no hit there is no target, and the correction
            // would simply vanish on the frame the ray first misses.
            if (hit) {
                let memo = this._ikFootHits.get(key);
                if (!memo) { memo = { point: vec3.create(), normal: vec3.create() }; this._ikFootHits.set(key, memo); }
                vec3.copy(memo.point, hit.point);
                vec3.copy(memo.normal, hit.normal);
            }
            const ground = this._ikFootHits.get(key);
            if (!ground || next <= 1e-3) {
                // Spent: drop the memory rather than leave a stale point to be resurrected after a teleport.
                this._ikFootHits.delete(key);
                continue;
            }

            const plan = plans[planCount] ??= { chain, ankle: vec3.create(), target: vec3.create(),
                                                normal: vec3.create(), weight: 0, along: 0 };
            planCount++;
            plan.chain = chain;
            const ankle = mat4.getTranslation(plan.ankle, ankleGlobal);
            const hitModel = vec3.transformMat4(IK_HIT_MODEL, ground.point, worldToModel);
            const normalModel = vec3.transformMat4(plan.normal, ground.normal, worldToModel);
            vec3.sub(normalModel, normalModel, originModel);
            if (vec3.length(normalModel) > 1e-8) vec3.normalize(normalModel, normalModel);

            // The ankle sits a foot's height above the sole, or the whole foot sinks through the ground.
            const desired = vec3.scaleAndAdd(plan.target, hitModel, up, tuning.footHeight);
            plan.along = vec3.dot(vec3.sub(IK_TMP, desired, ankle), up);
            plan.weight = next;
        }

        // ---- Pass 1b: let go of the feet that are mid-swing --------------------------------------------
        // `-along` is a foot's CLEARANCE above where it would be planted, measured against the LOWEST
        // foot: absolutely it cannot distinguish a mid-stride lift from ground lower than the animation
        // assumed. One foot with a plan is its own reference and keeps the full correction.
        let ref = Infinity;
        for (let i = 0; i < planCount; i++) ref = Math.min(ref, -plans[i].along);
        // Clamped at 0 so a foot THROUGH the ground cannot lift the reference and release the other leg.
        ref = planCount ? Math.max(0, ref) : 0;

        // A released foot must not be solved AT ALL: `solveTwoBone` clamps to `maxReach`, so even an
        // identity solve pulls a straight leg in by a couple of millimetres. Compacted in place.
        let activeCount = 0;
        for (let i = 0; i < planCount; i++) {
            const plan = plans[i];
            plan.weight *= swingReleaseWeight(-plan.along - ref, tuning.swingRelease);
            if (plan.weight > 1e-3) {
                if (activeCount !== i) { plans[i] = plans[activeCount]; plans[activeCount] = plan; }
                activeCount++;
            }
        }

        // The deepest a foot needs to go, WEIGHTED by how much of its correction is applied. Unweighted,
        // a released swing foot would dip the pelvis by the stride height once per step.
        let lowest = 0;
        for (let i = 0; i < activeCount; i++) lowest = Math.min(lowest, Math.min(0, plans[i].along) * plans[i].weight);

        // ---- Pass 2: lower the pelvis ------------------------------------------------------------------
        // Only ever DOWN: a foot that needs to rise is a step the knee can bend for.
        // With no foot on the ground the target is 0, and this must NOT return early — a pelvis still
        // lowered from a previous frame has to rise back over the smoothing time.
        const hipTarget = activeCount > 0 ? Math.max(-tuning.maxHipDrop, Math.min(0, lowest)) : 0;
        this._ikHipOffset = tuning.smoothing > 0 && dt > 0
            ? dampTime(this._ikHipOffset, hipTarget, tuning.smoothing, dt)
            : hipTarget;
        // Snap the tail of the exponential to zero so a released pelvis stops costing a re-accumulation.
        if (Math.abs(this._ikHipOffset) < 1e-5) this._ikHipOffset = 0;

        if (activeCount === 0 && this._ikHipOffset === 0) return false;

        const hipsLocal = checked.hips !== undefined ? localTransforms.get(checked.hips) : undefined;
        if (hipsLocal && this._ikHipOffset !== 0) {
            // Applied to the hips' LOCAL translation, so ordinary accumulation carries it down the skeleton.
            const shift = vec3.scale(IK_SHIFT, up, this._ikHipOffset);
            // Into the frame the hips' LOCAL lives in — the parent joint AND any non-joint wrappers between
            // (a Mixamo `Armature` at 0.01 scale, rotated Z-up to Y-up). Skipping the wrappers turned a
            // model-space drop into a hundredth of a step sideways: the pelvis never lowered, so the foot
            // over the lower ground stayed straight and hovering while the other knee bent.
            const parentFrame = this._parentFrameOf(checked.hips!, localTransforms, globalTransforms, topo);
            if (parentFrame) {
                const inv = IK_INV;
                if (mat4.invert(inv, parentFrame)) {
                    // A direction, so the parent's translation must not come with it.
                    const o = vec3.transformMat4(IK_O, vec3.set(IK_ZERO, 0, 0, 0), inv);
                    vec3.transformMat4(shift, shift, inv);
                    vec3.sub(shift, shift, o);
                }
            }
            const moved = mat4.copy(arenaMat(), hipsLocal);
            moved[12] += shift[0]; moved[13] += shift[1]; moved[14] += shift[2];
            localTransforms.set(checked.hips!, moved);

            // Re-accumulate so the leg solve below sees where the feet actually are AFTER the drop.
            this._reaccumulate(localTransforms, globalTransforms, topo, checked.hips!);
        }

        // ---- Pass 3: solve each leg --------------------------------------------------------------------
        for (let i = 0; i < activeCount; i++) {
            const plan = plans[i];
            this._solveLeg(plan.chain, plan.target, plan.normal, plan.weight, up, forward, tuning,
                localTransforms, globalTransforms, topo);
        }
        // Every change above re-accumulated what it moved, so the globals are already final.
        return true;
    }

    /**
     * The model-space frame a joint's LOCAL transform is expressed in: its parent joint's global times every
     * non-joint node between them (`parentChain`), exactly as `_reaccumulate` builds it. Null for a joint
     * with neither — its local IS model space.
     */
    private _parentFrameOf(
        nodeIndex: number,
        localTransforms: Map<number, mat4>,
        globalTransforms: Map<number, mat4>,
        topo: SkeletonTopology,
    ): mat4 | null {
        const jointIndex = topo.jointOfNode.get(nodeIndex);
        if (jointIndex === undefined) return null;
        const parentJoint = topo.parentJoint[jointIndex];
        const chain = topo.parentChain[jointIndex] ?? [];
        if (parentJoint < 0 && chain.length === 0) return null;
        // Scratch: every caller consumes the frame before asking for another.
        const frame = mat4.identity(IK_FRAME);
        if (parentJoint >= 0) {
            const parentGlobal = globalTransforms.get(this._skin!.joints[parentJoint].nodeIndex);
            if (parentGlobal) mat4.copy(frame, parentGlobal);
        }
        for (const chainNode of chain) {
            const chainLocal = localTransforms.get(chainNode) ?? this._skin!.nodeTransforms?.get(chainNode);
            if (chainLocal) mat4.multiply(frame, frame, chainLocal);
        }
        return frame;
    }

    /**
     * Re-run the parent-to-child accumulation in place for `fromNode` and everything beneath it — the only
     * globals a change to that joint's local can move. Each leg step used to re-accumulate the WHOLE
     * skeleton, four to ten times per character per frame.
     */
    private _reaccumulate(
        localTransforms: Map<number, mat4>,
        globalTransforms: Map<number, mat4>,
        topo: SkeletonTopology,
        fromNode: number,
    ): void {
        const joint = topo.jointOfNode.get(fromNode);
        if (joint === undefined) return;
        for (const jointIndex of subtreeOrder(topo, joint)) {
            const nodeIndex = this._skin!.joints[jointIndex].nodeIndex;
            const local = localTransforms.get(nodeIndex);
            const global = globalTransforms.get(nodeIndex);
            if (!local || !global) continue;

            // Must match _recomputePose's accumulation exactly, parentChain included, or a leg solve
            // drags the pose away from where the first pass put it.
            const parentJoint = topo.parentJoint[jointIndex];
            if (parentJoint >= 0) mat4.copy(global, globalTransforms.get(this._skin!.joints[parentJoint].nodeIndex)!);
            else mat4.identity(global);
            for (const chainNode of topo.parentChain[jointIndex]) {
                const chainLocal = localTransforms.get(chainNode) ?? this._skin!.nodeTransforms?.get(chainNode);
                if (chainLocal) mat4.multiply(global, global, chainLocal);
            }
            mat4.multiply(global, global, local);
        }
    }

    // Bend one leg onto its target and roll the foot onto the surface. Each step writes a LOCAL and
    // re-accumulates before the next reads a global.
    private _solveLeg(
        chain: IkFootChain,
        target: vec3,
        normal: vec3,
        weight: number,
        up: vec3,
        forward: vec3,
        tuning: ReturnType<typeof ikTuning>,
        localTransforms: Map<number, mat4>,
        globalTransforms: Map<number, mat4>,
        topo: SkeletonTopology,
    ): void {
        const hipG = globalTransforms.get(chain.thigh), kneeG = globalTransforms.get(chain.shin);
        const ankleG = globalTransforms.get(chain.foot);
        if (!hipG || !kneeG || !ankleG) return;
        const hip = mat4.getTranslation(IK_HIP, hipG);
        const knee = mat4.getTranslation(IK_KNEE, kneeG);
        const ankle = mat4.getTranslation(IK_ANKLE, ankleG);

        // Ease by the foot's weight rather than snapping: ikWeight = 0 is exactly the animated pose.
        const eased = vec3.lerp(IK_EASED, ankle, target, weight);

        const solve = solveTwoBone({ root: hip, mid: knee, tip: ankle, target: eased,
                                     pole: kneePole(hip, knee, ankle, forward) });
        this._rotateGlobal(chain.thigh, solve.rootDelta, localTransforms, globalTransforms, topo);
        this._reaccumulate(localTransforms, globalTransforms, topo, chain.thigh);
        this._rotateGlobal(chain.shin, solve.midDelta, localTransforms, globalTransforms, topo);
        this._reaccumulate(localTransforms, globalTransforms, topo, chain.shin);

        // Clamped: past maxSlope the foot keeps its animated orientation rather than reading as broken.
        const slope = Math.acos(clamp(vec3.dot(normal, up), -1, 1)) * 180 / Math.PI;
        if (slope > 1e-3 && slope <= tuning.maxSlopeDeg) {
            const align = quat.rotationTo(IK_ALIGN, up, normal);
            // Scaled by weight, so a fading foot un-rolls as smoothly as it un-plants.
            const partial = quat.slerp(IK_PARTIAL, quat.identity(IK_QID), align, weight);
            this._rotateGlobal(chain.foot, partial, localTransforms, globalTransforms, topo);
            this._reaccumulate(localTransforms, globalTransforms, topo, chain.foot);

            // Counter-rotate the inherited roll so the ball stays flat instead of being levered off.
            if (chain.toe !== undefined && globalTransforms.has(chain.toe)) {
                const counter = quat.invert(IK_COUNTER, partial);
                const half = quat.slerp(IK_HALF, quat.identity(IK_QID), counter, 0.5);
                this._rotateGlobal(chain.toe, half, localTransforms, globalTransforms, topo);
                this._reaccumulate(localTransforms, globalTransforms, topo, chain.toe);
            }
        }
    }

    // Apply a MODEL-space rotation to one joint by rewriting its LOCAL transform
    // (`local = inverse(parentGlobal) * newGlobal`), so one re-accumulation carries it to every descendant.
    private _rotateGlobal(
        nodeIndex: number,
        delta: quat,
        localTransforms: Map<number, mat4>,
        globalTransforms: Map<number, mat4>,
        topo: SkeletonTopology,
    ): void {
        const global = globalTransforms.get(nodeIndex);
        if (!global) return;

        // Rotate about the joint's own origin: translate to it, apply, translate back.
        const origin = mat4.getTranslation(IK_TMP, global);
        const rot = mat4.fromQuat(IK_ROT, delta);
        const around = mat4.fromTranslation(IK_AROUND, origin);
        mat4.multiply(around, around, rot);
        mat4.translate(around, around, vec3.negate(IK_O, origin));

        const newGlobal = mat4.multiply(IK_NEW_GLOBAL, around, global);

        // The frame the LOCAL lives in, wrappers included — must match `_reaccumulate`, or the rotation is
        // written in one frame and read back in another.
        const parentGlobal = this._parentFrameOf(nodeIndex, localTransforms, globalTransforms, topo);

        // A fresh pose-arena matrix: the old local may be a clip bone's own transform, never to be written.
        const local = arenaMat();
        if (parentGlobal) {
            mat4.invert(IK_INV, parentGlobal);
            mat4.multiply(local, IK_INV, newGlobal);
        } else mat4.copy(local, newGlobal);
        localTransforms.set(nodeIndex, local);
        mat4.copy(global, newGlobal);
    }

    /**
     * Pose the skeleton at an explicit time on the current animation, for editor scrubbing. Does not
     * change play/pause state and does not advance time.
     */
    public seek(time: number): void {
        if (this._ragdollActive || !this._skin) return;
        if (!this._currentAnimation && !this._fieldEntries) return;
        const duration = this._getAnimationDuration();
        this._currentTime = Math.max(0, Math.min(time, duration));
        this._isBlending = false;
        if (this._fieldEntries) {
            // A field's clock is its normalized phase; the caller's seconds are relative to the
            // current weighted duration.
            this._fieldPhase = duration > 0 ? this._currentTime / duration : 0;
            this._prevFieldPhase = this._fieldPhase;   // a scrub is not playback; it must not fire events
            this._poseFieldAt(this._fieldEntries, this._fieldPhase);
        } else {
            for (const bone of this._bones.values()) {
                bone.update(this._currentTime);
            }
        }
        this._recomputePose();
    }

    // Decompose, lerp/slerp and recompose two transforms, into a pose-arena matrix.
    private _blendTransforms(from: mat4, to: mat4, factor: number): mat4 {
        mat4.getTranslation(BL_T0, from);
        mat4.getRotation(BL_R0, from);
        mat4.getScaling(BL_S0, from);
        mat4.getTranslation(BL_T1, to);
        mat4.getRotation(BL_R1, to);
        mat4.getScaling(BL_S1, to);
        vec3.lerp(BL_T0, BL_T0, BL_T1, factor);
        quat.slerp(BL_R0, BL_R0, BL_R1, factor);
        vec3.lerp(BL_S0, BL_S0, BL_S1, factor);
        return mat4.fromRotationTranslationScale(arenaMat(), BL_R0, BL_T0, BL_S0);
    }

    // Duration of the outgoing pose source, for the cross-fade.
    private _getPreviousAnimationDuration(): number {
        if (!this._previousAnimation) return 0;
        
        let maxTime = 0;
        for (const sampler of this._previousAnimation.samplers) {
            if (sampler.input.length > 0) {
                const lastTime = sampler.input[sampler.input.length - 1];
                maxTime = Math.max(maxTime, lastTime);
            }
        }
        return maxTime;
    }
    
    // Duration of the current pose source, in seconds.
    private _getAnimationDuration(): number {
        // The weighted average of the contributing clips, NOT the dominant clip's own length.
        if (this._fieldEntries) return this._fieldDuration(this._fieldEntries);
        if (!this._currentAnimation) return 0;

        let maxTime = 0;
        for (const sampler of this._currentAnimation.samplers) {
            if (sampler.input.length > 0) {
                const lastTime = sampler.input[sampler.input.length - 1];
                maxTime = Math.max(maxTime, lastTime);
            }
        }
        return maxTime;
    }
    
    /**
     * A joint's MODEL-space transform in the current pose — relative to the model node, so a world
     * matrix is `modelNode.worldTransform x this`. Null for an out-of-range joint or a skinless animator.
     * Live: the returned matrix is overwritten by the next pose, so clone it to keep it.
     */
    public getJointModelMatrix(jointIndex: number): mat4 | null {
        if (!this._skin || jointIndex < 0 || jointIndex >= this._skin.joints.length) return null;
        if (!this._jointModelMatrices[jointIndex]) this._recomputePose();
        return this._jointModelMatrices[jointIndex] ?? null;
    }

    /** The final bone matrices for rendering. */
    public getFinalBoneMatrices(): mat4[] {
        return this._finalBoneMatrices;
    }
    
    /** The final bone matrices flattened for a shader uniform. */
    public getFinalBoneMatricesFlat(): number[] {
        const flat: number[] = [];
        for (const matrix of this._finalBoneMatrices) {
            for (let i = 0; i < 16; i++) {
                flat.push(matrix[i]);
            }
        }
        return flat;
    }
    
    // Control methods
    public play(): void { this._playing = true; }
    public pause(): void { this._playing = false; }
    public stop(): void {
        this._playing = false;
        this._currentTime = 0;
        this._fieldPhase = 0;
        this._prevFieldPhase = 0;
    }
    public reset(): void { this._currentTime = 0; this._fieldPhase = 0; this._prevFieldPhase = 0; }

    /** Force the skeleton to its bind pose and stop playback. */
    public showBindPose(): void { this._setTPose(); }

    // ---- Animation state machine (action/event-driven playback) ----

    /** The current state machine, or null if none is assigned. */
    public getStateMachine(): AnimationStateMachine | null { return this._stateMachine; }
    public get hasStateMachine(): boolean { return this._stateMachine !== null; }
    /** Name of the state currently active in the machine (null when no machine / no entry). */
    public get currentStateName(): string | null { return this._currentStateName; }

    /**
     * Assign or clear the state machine, resetting parameters to their defaults and entering the entry
     * state. Null falls back to the mapping list, else the bind pose.
     */
    public setStateMachine(sm: AnimationStateMachine | null): void {
        this._stateMachine = sm;
        this._paramValues.clear();
        this._currentStateName = null;
        // Anything cached belongs to the old machine. This is also what makes an editor field edit take.
        this._fieldBoneCache.clear();
        this._clearField();
        // Bands belong to the machine that authored them; an old latch would hold past a new release point.
        this._condLatch.clear();
        // Re-arm the dangling-binding reports: a re-apply is when someone has just fixed one.
        this._warnedBindings.clear();
        this._warnedNegativeSpeed.clear();
        // And the ping-pong report, for the same reason.
        this._stateFlips.length = 0;
        this._warnedPingPong = false;
        this._overlays = [];
        if (!sm) return;
        for (const p of sm.parameters) this._paramValues.set(p.name, p.default);
        this._buildOverlays(sm);
        this.resetStateMachine();
    }

    /** Re-enter the entry state and reset triggers to their defaults. */
    public resetStateMachine(): void {
        if (!this._stateMachine) return;
        // Reset triggers (bool/float keep their last set value; triggers are momentary).
        for (const p of this._stateMachine.parameters) {
            if (p.type === 'trigger') this._paramValues.set(p.name, false);
        }
        const entry = this._stateMachine.states.find(s => s.isEntry) ?? this._stateMachine.states[0];
        if (entry) this._enterState(entry.name);
        else if (this._isOverlay) { this._currentStateName = null; this._overlayEmpty = true; }
        else { this._currentStateName = null; this._setTPose(); }
        for (const o of this._overlays) if (o.kind === 'layer') o.animator.resetStateMachine();
    }

    // Parameter setters/getters used by scripts to drive the machine.
    public setFloat(name: string, value: number): void { this._paramValues.set(name, value); }
    public setBool(name: string, value: boolean): void { this._paramValues.set(name, value); }
    /** Fire a momentary trigger; it is consumed when a transition that uses it fires. */
    public setTrigger(name: string): void { this._paramValues.set(name, true); }
    public resetTrigger(name: string): void { this._paramValues.set(name, false); }
    public getParam(name: string): number | boolean | undefined { return this._paramValues.get(name); }

    // Hand-set values for LINKED ('variable') parameters, which otherwise re-read their source every frame.
    private _paramOverrides = new Map<string, number | boolean>();
    /**
     * Pin a linked parameter to a value, or pass null to follow its link again. For the editor's preview,
     * where nothing moves, so a parameter linked to the character's speed would otherwise always read 0.
     */
    public setParamOverride(name: string, value: number | boolean | null): void {
        if (value === null) this._paramOverrides.delete(name);
        else { this._paramOverrides.set(name, value); this._paramValues.set(name, value); }
    }
    public getParamOverride(name: string): number | boolean | undefined { return this._paramOverrides.get(name); }

    /** Subscribe to animation events fired by clip event markers. Returns an unsubscribe fn. */
    public onAnimationEvent(cb: (eventName: string, clipName: string) => void): () => void {
        this._eventCallbacks.push(cb);
        return () => { this._eventCallbacks = this._eventCallbacks.filter(c => c !== cb); };
    }

    // Record a state change and report the machine if it is thrashing, naming the PAIR — on screen a
    // ping-pong reads as the character vibrating, not as a state-machine fault. Timed off accumulated
    // frame time, so a stepped or slow-motion animator measures its own clock.
    private _noteStateChange(from: string | null, to: string): void {
        if (from === null || from === to) return;
        this._stateFlips.push({ at: this._animatorClock, pair: `${from} -> ${to}` });
        while (this._stateFlips.length && this._animatorClock - this._stateFlips[0].at > 1) this._stateFlips.shift();
        if (this._stateFlips.length < PING_PONG_FLIPS_PER_SEC || this._warnedPingPong) return;

        this._warnedPingPong = true;
        // Most frequent pair in the window: with three states churning, the one that repeats is the culprit.
        const counts = new Map<string, number>();
        for (const f of this._stateFlips) counts.set(f.pair, (counts.get(f.pair) ?? 0) + 1);
        let worst = '';
        let worstN = 0;
        for (const [pair, n] of counts) if (n > worstN) { worstN = n; worst = pair; }

        const [a, b] = worst.split(' -> ');
        Logger.warn(
            `Animation state machine is ping-ponging: ${this._stateFlips.length} state changes in one second, `
            + `mostly "${worst}". The pose is restarted every frame, which looks like the blend vibrating `
            + `rather than like a state problem.\n`
            + `  ${this._describeTransitions(a, b)}\n`
            + `  parameters: ${this._describeParams()}\n`
            + `  A transition with NO conditions always fires. Otherwise give the condition a hysteresis band `
            + `(the ± box) or the transition a minimum dwell.`,
            'Animation');
    }

    // Both transitions between a pair of states, with every condition's live value and whether it is met.
    // Almost every ping-pong is an empty condition list or a `>`/`<` pair both currently met.
    private _describeTransitions(from: string, to: string): string {
        const sm = this._stateMachine;
        if (!sm) return '';
        const lines: string[] = [];
        for (const [a, b] of [[from, to], [to, from]]) {
            const t = sm.transitions.find(x => x.from === a && x.to === b)
                ?? sm.transitions.find(x => x.from === '*' && x.to === b);
            if (!t) { lines.push(`${a} -> ${b}: (no transition)`); continue; }
            const parts: string[] = [];
            forEachCondition(t.condition, t.conditions, c => parts.push(this._describeCondition(c)));
            const gates = [
                t.minDwell ? `minDwell ${t.minDwell}s` : null,
                t.hasExitTime ? `exitTime ${t.exitTime ?? 1}` : null,
            ].filter(Boolean).join(', ');
            lines.push(
                `${a} -> ${b}: ${parts.length ? parts.join(' AND ') : '(NO CONDITIONS - fires unconditionally)'}`
                + (gates ? ` | ${gates}` : ' | no dwell/exit-time gate'));
        }
        return lines.join('\n  ');
    }

    /** One condition as authored, with the value it is reading and whether it currently passes. */
    private _describeCondition(c: AnimationCondition): string {
        const v = this._paramValues.get(c.param);
        const shown = typeof v === 'number' ? v.toFixed(3) : String(v);
        const target = (c.op === 'gt' || c.op === 'lt' || c.op === 'eq' || c.op === 'neq') ? ` ${c.value ?? 0}` : '';
        const band = c.hysteresis ? ` ±${c.hysteresis}` : '';
        return `[${c.param} ${c.op}${target}${band} | ${c.param}=${shown} | ${conditionMet(this._conditionCtx, c) ? 'MET' : 'not met'}]`;
    }

    /** Every parameter and its live value, so a condition reading a stale or defaulted one is visible. */
    private _describeParams(): string {
        const sm = this._stateMachine;
        if (!sm) return '';
        return sm.parameters
            .map(p => {
                const v = this._paramValues.get(p.name) ?? p.default;
                return `${p.name}=${typeof v === 'number' ? v.toFixed(3) : String(v)}`;
            })
            .join(', ');
    }

    // Make a state current and play its bound clip. `blendOverride` is the firing transition's own
    // cross-fade duration, if it set one.
    private _enterState(name: string, blendOverride?: number): void {
        if (!this._stateMachine) return;
        const state = this._stateMachine.states.find(s => s.name === name);
        const wasEmpty = this._overlayEmpty || !this._currentAnimation;
        this._noteStateChange(this._currentStateName, name);
        this._currentStateName = name;
        this._prevEventTime = 0;
        this._stateTime = 0;

        // A field state blends several clips instead of playing one; _startField arms the cross-fade itself.
        if (state?.field) {
            this._startField(state.field, state.fieldInputs, state.loop, true, blendOverride);
            this._loopLimit = Math.max(0, Math.floor(state.loopCount ?? 0));
            this._loopsPlayed = 0;
            this._speed = state.speed ?? 1.0;
            this._applyStateSpeed(state);
            return;
        }

        if (state?.pose) {
            this._playClip(this._poseClip(state), true, !(this._isOverlay && wasEmpty));
            if (blendOverride !== undefined) this._activeBlendTime = Math.max(0, blendOverride);
            this._speed = 1;
            return;
        }

        if (this._isOverlay && (!state || !state.clipName)) {
            // An empty state on a LAYER means "add nothing": fade the layer out, holding its last pose
            // while it goes, rather than snapping the bones to rest.
            this._overlayEmpty = true;
            if (blendOverride !== undefined) this._activeBlendTime = Math.max(0, blendOverride);
            return;
        }

        if (!state || !state.clipName) {
            // Nothing to play: hold the bind pose. Legitimate for an empty state, but also where a field
            // state lands when `reembedFields` dropped a field whose asset id no longer resolves.
            if (state?.fieldId) {
                Logger.warn(
                    `Animation state "${name}" plays a blend field whose asset is missing, so it has nothing `
                    + `to play and holds the bind pose. Re-pick the field on that state and Apply.`,
                    'Animation');
            }
            this._setTPose();
            return;
        }
        // A layer coming out of an empty state fades in through its presence; cross-fading from whatever
        // stale clip it last held would replay that clip first.
        this.playAnimationByName(state.clipName, state.loop, !(this._isOverlay && wasEmpty));
        // playAnimation just armed the blend with the animator-wide default; the transition gets the last word.
        if (blendOverride !== undefined) this._activeBlendTime = Math.max(0, blendOverride);
        this._loopLimit = Math.max(0, Math.floor(state.loopCount ?? 0));
        this._loopsPlayed = 0;
        this._speed = state.speed ?? 1.0;
        this._applyStateSpeed(state);
    }

    // Report a Speed parameter that has gone negative, once per state. There is no reverse playback, so
    // it clamps to 0 and the clip FREEZES — usually a signed built-in bound where a magnitude was meant.
    private _warnNegativeSpeed(state: AnimationState, value: number): void {
        const key = `${state.name} ${state.speedParam}`;
        if (this._warnedNegativeSpeed.has(key)) return;
        this._warnedNegativeSpeed.add(key);
        Logger.warn(
            `Animation state "${state.name}": its Speed parameter "${state.speedParam}" read ${value.toFixed(3)}. `
            + `There is no reverse playback, so the rate is pinned to 0 and the clip freezes while that value `
            + `stays negative. Bind Speed to a magnitude such as planarSpeed or currentSpeed, or remove the `
            + `Speed parameter and set the rate per sample with the field's Rate column.`,
            'Animation');
    }

    // Drive the playback rate from the parameter a state names, on entry and every frame after. Falls
    // back to the state's fixed `speed`.
    private _applyStateSpeed(state: AnimationState | undefined): void {
        if (!state?.speedParam) return;
        const v = this._paramValues.get(state.speedParam);
        // Parameter renamed or deleted: keep the fixed speed. Reading it as 0 would freeze the clip.
        if (v === undefined) return;
        // A bool reads as 1/0 so a flag can halt motion. The setter's clamp is mirrored here, since this
        // bypasses it — there is no reverse playback.
        const raw = typeof v === 'number' ? v : (v ? 1 : 0);
        if (raw < 0) this._warnNegativeSpeed(state, raw);
        this._speed = Math.max(0, raw);
    }

    // This node or the nearest ancestor with a rigid body — whatever is actually being moved. An
    // animator lives on the skinned ModelNode, but the body sits on the root above it.
    private _nearestBodiedNode(): Node | null {
        let n: Node | null = this._node;
        while (n) {
            if (n.body) return n;
            n = n.parent;
        }
        return null;
    }

    /** Resolve the node a 'variable' parameter reads from, relative to this animator's model node. */
    private _resolveVarNode(ref: string): Node | null {
        if (ref === 'self') return this._node;
        if (ref === 'parent') return this._node?.parent ?? null;
        // A RELATIONSHIP, not an identity: in `Playable(body) -> holder -> ModelNode(animator)` the moving
        // thing is neither self nor parent, and a node id would break on re-creation.
        if (ref === 'bodied') return this._nearestBodiedNode();
        return this._node?.scene?.getNodeById(ref) ?? null;
    }

    // Report a binding whose node has gone missing, once per parameter: a parameter reading its default
    // is otherwise indistinguishable from one legitimately reading zero.
    private _warnDanglingBinding(paramName: string, message: string): void {
        if (this._warnedBindings.has(paramName)) return;
        this._warnedBindings.add(paramName);
        Logger.warn(`Animation parameter "${paramName}": ${message}`, 'Animation');
    }

    // Pull every 'variable' parameter's live value into _paramValues, honouring the access model. Reads
    // the `variables` Map first, then a native own property — `hasOwnProperty` guards real Node members.
    private _refreshVariableParams(): void {
        const sm = this._stateMachine;
        if (!sm || !this._node) return;
        for (const p of sm.parameters) {
            if (p.type !== 'variable' || !p.variable) continue;
            const pinned = this._paramOverrides.get(p.name);
            if (pinned !== undefined) { this._paramValues.set(p.name, pinned); continue; }
            let src = this._resolveVarNode(p.variable.nodeRef);
            let val: number | boolean = p.default;

            // A dangling `nodeRef` id — every re-instantiation regenerates ids. A BUILT-IN can be
            // repaired: the picker only offers self, parent, or the bodied ancestor, and only the last
            // can dangle. A user variable on an arbitrary node gets no such guess.
            if (!src) {
                const isId = p.variable.nodeRef !== 'self' && p.variable.nodeRef !== 'parent'
                    && p.variable.nodeRef !== 'bodied';
                if (isId && p.variable.source === 'builtin') src = this._nearestBodiedNode();
                if (src) {
                    this._warnDanglingBinding(p.name,
                        `its node no longer exists (it was re-created, which changes node ids). Re-bound to `
                        + `"${src.name}", the nearest parent with a rigid body. Re-pick it in the Variables `
                        + `panel to make this permanent.`);
                } else {
                    this._warnDanglingBinding(p.name,
                        `its node no longer exists, so it is stuck at its default (${String(p.default)}) and `
                        + `no transition using it can ever fire. Re-pick it in the Variables panel.`);
                }
            }

            // Built-ins are engine state, so they skip the access model. An unrecognized name falls back
            // to the default rather than throwing — a machine from a newer engine must not kill the frame.
            if (p.variable.source === 'builtin') {
                const builtin = NODE_BUILTINS[p.variable.varName];
                if (src && builtin) {
                    const v = builtin.read(src);
                    val = p.variable.varType === 'boolean' ? !!v : Number(v);
                }
                this._paramValues.set(p.name, val);
                continue;
            }

            if (src && canAccessVariable(src, this._node, p.variable.varName)) {
                const name = p.variable.varName;
                let v: any = src.getVariable(name);
                if (v === undefined && Object.prototype.hasOwnProperty.call(src, name)) v = (src as any)[name];
                // Coerce to the declared type: the number ops require `typeof === 'number'` and would
                // silently never match a numeric string.
                if (v !== undefined) val = p.variable.varType === 'boolean' ? !!v : Number(v);
            }
            this._paramValues.set(p.name, val);
        }
    }

    /** Evaluate the active state's outgoing transitions and switch state when one fires. */
    private _evaluateStateMachine(): void {
        const sm = this._stateMachine;
        if (!sm) return;
        this._refreshVariableParams(); // variable-bound params track their node variable each frame
        this._refreshConditionLatches();
        // Before any transition is considered, and for EVERY transition: a band that only advances while
        // its own state is active does not work.
        if (!this._currentStateName) { this.resetStateMachine(); return; }

        // Re-read a parameter-driven playback rate: the state is already entered, so nothing else would.
        this._applyStateSpeed(sm.states.find(s => s.name === this._currentStateName));

        const duration = this._getAnimationDuration();
        for (const t of sm.transitions) {
            if (t.from !== '*' && t.from !== this._currentStateName) continue;
            if (t.to === this._currentStateName) continue;

            // Before the conditions, so a trigger is not consumed by a transition that cannot fire yet.
            if (t.minDwell && this._stateTime < t.minDwell) continue;

            // Exit-time gate: wait until the clip reaches the normalized exit time.
            if (t.hasExitTime) {
                const exit = (t.exitTime ?? 1.0) * duration;
                if (this._currentTime < exit) continue;
            }

            if (!this._transitionMet(t)) continue;

            // EVERY trigger in the tree is consumed, including under an OR branch that did not
            // contribute: one left raised would fire some other transition next frame.
            consumeTriggers(this._conditionCtx, t.condition, t.conditions);
            this._enterState(t.to, t.blendTime);
            return;
        }
    }

    /**
     * The evaluator's view of this animator: the parameter table and the hysteresis latches, handed to
     * the shared condition code in `core/conditions.ts`.
     *
     * The two maps ARE `_paramValues` and `_condLatch` — not copies — so nothing has to be synchronised
     * and the extraction cost nothing at runtime.
     */
    private get _conditionCtx(): ConditionContext {
        return { values: this._paramValues, latches: this._condLatch };
    }

    /** A transition's gate: the compound tree when present, else the legacy flat (implicitly ANDed) list. */
    private _transitionMet(t: AnimationTransition): boolean {
        return gateMet(this._conditionCtx, t.condition, t.conditions);
    }

    // Advance EVERY band in the machine once per frame, whatever state is current. Load-bearing:
    // `_evaluateStateMachine` walks only transitions leaving the current state, and the classic
    // `>`/`<` pair sits on two different states — each would be frozen while the other was consulted,
    // leaving both latched on and satisfiable across the whole band.
    private _refreshConditionLatches(): void {
        const sm = this._stateMachine;
        if (!sm) return;
        const ctx = this._conditionCtx;
        for (const t of sm.transitions)
            forEachCondition(t.condition, t.conditions, c => updateLatch(ctx, c));
    }

    /** Fire event markers on the current clip whose time was crossed in (prev, cur]. */
    private _fireDueEvents(prevTime: number, curTime: number, duration: number, looped: boolean): void {
        const machineEvents = this._stateMachine?.events ?? this._externalEvents ?? [];
        const clipEvents = this._currentAnimation?.events ?? [];
        if ((machineEvents.length === 0 && clipEvents.length === 0) || !this._currentAnimation || this._eventCallbacks.length === 0) {
            this._prevEventTime = curTime;
            return;
        }
        const clip = this._currentAnimation.name;
        const emit = (eventName: string) => {
            // Fired from the update loop, outside attachScriptFactory's handler guards.
            for (const cb of this._eventCallbacks) {
                try { cb(eventName, clip); }
                catch (e) { Logger.error(`Error in onAnimationEvent('${eventName}') for node ${this._node?.name}: ${e}`, 'Script'); }
            }
        };
        const fire = (from: number, to: number) => {
            for (const ev of machineEvents) {
                if (ev.clipName === clip && ev.time > from && ev.time <= to) emit(ev.eventName);
            }
            for (const ev of clipEvents) {
                if (ev.time > from && ev.time <= to) emit(ev.name);
            }
        };
        if (looped) {
            // Wrapped past the end: fire (prev, duration] then (0, cur].
            fire(prevTime, duration);
            fire(-1, curTime);
        } else {
            fire(prevTime, curTime);
        }
        this._prevEventTime = curTime;
    }

    // ---- Layers and action slots --------------------------------------------------------------------

    // Build one child animator per layer, plus the declared slots. Children SHARE the parameter table, so
    // a parameter set on the character drives every layer, and a trigger is consumed once whichever layer
    // fires on it.
    private _buildOverlays(sm: AnimationStateMachine): void {
        if (!this._animatedModel) return;
        (sm.layers ?? []).forEach((layer, i) => {
            const child = this._createOverlayAnimator();
            child.setStateMachine({ parameters: [], states: layer.states, transitions: layer.transitions, events: sm.events });
            child._paramValues = this._paramValues;
            // A layer that starts on a clip is simply there from the first frame; fading it in would show
            // the base for a beat on every scene load.
            const present = child._overlayEmpty || !child._currentAnimation ? 0 : 1;
            this._overlays.push({
                kind: 'layer', name: layer.name, animator: child,
                blend: layer.blend ?? 'override',
                maskSpec: layer.mask ?? null, mask: null,
                weight: clamp(layer.weight ?? 1, 0, 1), weightParam: layer.weightParam,
                order: i + 1,
                presence: present, presenceTarget: present, fadeSeconds: this._blendTime,
                action: null,
            });
        });
        for (const slot of sm.slots ?? []) this._addSlot(slot, sm.layers?.length ?? 0);
        this._overlays.sort((a, b) => a.order - b.order);
    }

    private _createOverlayAnimator(): Animator {
        const child = new Animator(this._animatedModel!, undefined, { overlay: true });
        child._blendTime = this._blendTime;
        // A layer's or slot's events are the character's events.
        child.onAnimationEvent((eventName, clipName) => {
            for (const cb of this._eventCallbacks) {
                try { cb(eventName, clipName); }
                catch (e) { Logger.error(`Error in onAnimationEvent('${eventName}') for node ${this._node?.name}: ${e}`, 'Script'); }
            }
        });
        return child;
    }

    private _addSlot(def: AnimationSlotDef, layerCount: number): Overlay {
        const child = this._createOverlayAnimator();
        child._externalEvents = this._stateMachine?.events ?? null;
        const after = def.afterLayer === undefined ? layerCount : clamp(Math.floor(def.afterLayer), 0, layerCount);
        const overlay: Overlay = {
            kind: 'slot', name: def.name, animator: child,
            blend: def.blend ?? 'override',
            maskSpec: def.mask ?? null, mask: null,
            weight: 1, order: after + 0.5,
            presence: 0, presenceTarget: 0, fadeSeconds: 0.15,
            action: null,
        };
        this._overlays.push(overlay);
        return overlay;
    }

    // Advance every overlay one frame: its own clip, its presence fade, and an action's lifecycle.
    private _updateOverlays(deltaTime: number): void {
        for (const o of this._overlays) {
            const child = o.animator;
            if (o.kind === 'layer') {
                o.presenceTarget = child._overlayEmpty || (!child._currentAnimation && !child._fieldEntries) ? 0 : 1;
                o.fadeSeconds = child._activeBlendTime;
            }
            child.update(deltaTime);

            const action = o.action;
            if (action && !action.stopping && !action.loop) {
                // Start fading out so the fade ENDS with the clip, not after it.
                const remaining = child._getAnimationDuration() - child._currentTime;
                if (remaining <= action.blendOut || !child._playing) {
                    action.stopping = true;
                    o.presenceTarget = 0;
                    o.fadeSeconds = Math.max(remaining, 1e-3);
                }
            }

            // Move presence towards its target at a constant rate: the full range takes `fadeSeconds`.
            if (o.presence !== o.presenceTarget) {
                const step = o.fadeSeconds > 1e-4 ? deltaTime / o.fadeSeconds : 1;
                o.presence = o.presenceTarget > o.presence
                    ? Math.min(o.presenceTarget, o.presence + step)
                    : Math.max(o.presenceTarget, o.presence - step);
            }

            if (action && action.stopping && o.presence <= 0) {
                action.done = true;
                o.action = null;
                action.resolve();
            }
        }
    }

    // Node index -> weight for an overlay's mask, resolved by bone NAME against this skin once.
    private _overlayMask(o: Overlay): Map<number, number> | null {
        if (!o.maskSpec) return null;
        if (o.mask) return o.mask;
        const byName = new Map<string, number>();
        for (const [nodeIndex, name] of this._skin?.nodeNames ?? []) byName.set(name, nodeIndex);
        const mask = new Map<number, number>();
        for (const [name, w] of Object.entries(o.maskSpec)) {
            const nodeIndex = byName.get(name);
            if (nodeIndex !== undefined && w > 0) mask.set(nodeIndex, clamp(w, 0, 1));
        }
        o.mask = mask;
        return mask;
    }

    // Blend every overlay onto a bone's base local, in order.
    private _applyOverlays(nodeIndex: number, base: mat4): mat4 {
        let local = base;
        for (const o of this._overlays) {
            if (o.presence <= 0) continue;
            const mask = this._overlayMask(o);
            const maskWeight = mask ? (mask.get(nodeIndex) ?? 0) : 1;
            if (maskWeight <= 0) continue;
            let weight = o.weight;
            if (o.weightParam) {
                const v = this._paramValues.get(o.weightParam);
                if (typeof v === 'number') weight = clamp(v, 0, 1);
                else if (typeof v === 'boolean') weight = v ? 1 : 0;
            }
            const w = weight * maskWeight * o.presence;
            if (w <= 0) continue;
            const layer = o.animator._sourceLocal(nodeIndex);
            // A layer that does not animate this bone leaves it to the layers beneath.
            if (!layer) continue;
            local = o.blend === 'additive'
                ? this._addTransform(local, layer, o.animator._additiveReference(nodeIndex), w)
                : this._blendTransforms(local, layer, w);
        }
        return local;
    }

    // The additive reference for a bone: the current clip's first frame.
    private _additiveReference(nodeIndex: number): { t: vec3; r: quat } | null {
        const bone = this._bones.get(boneKey(nodeIndex));
        return bone ? bone.startTR() : null;
    }

    // base + w x (layer - reference), per component: the rotation delta `inverse(ref) x layer` goes on the
    // right of base (local-space additive), the translation delta is added.
    private _addTransform(base: mat4, layer: mat4, ref: { t: vec3; r: quat } | null, w: number): mat4 {
        if (!ref) return base;
        decomposeTRS(base, BL_T0, BL_R0, BL_S0);
        decomposeTRS(layer, BL_T1, BL_R1, BL_S1);

        quat.multiply(ADD_DELTA, quat.invert(ADD_INV, ref.r), BL_R1);
        quat.slerp(ADD_DELTA, quat.identity(ADD_ID), ADD_DELTA, w);
        quat.normalize(BL_R0, quat.multiply(BL_R0, BL_R0, ADD_DELTA));
        vec3.scaleAndAdd(BL_T0, BL_T0, vec3.sub(BL_T1, BL_T1, ref.t), w);
        return mat4.fromRotationTranslationScale(arenaMat(), BL_R0, BL_T0, BL_S0);
    }

    // A pose state as a clip: every listed bone held at `delta x rest` across one second. Two identical
    // keys, because a zero-length clip would wrap by `% 0`.
    private _poseClip(state: AnimationState): Animation {
        const cached = this._poseClips.get(state);
        if (cached) return cached;
        const nodeOfName = new Map<string, number>();
        for (const [nodeIndex, name] of this._skin?.nodeNames ?? []) nodeOfName.set(name, nodeIndex);

        const samplers: AnimationSampler[] = [];
        const channels: AnimationChannel[] = [];
        for (const bone of state.pose?.bones ?? []) {
            const nodeIndex = nodeOfName.get(bone.name);
            if (nodeIndex === undefined) continue;
            const rest = this._skin?.nodeTransforms?.get(nodeIndex) ?? mat4.create();
            const restT = vec3.create(), restR = quat.create();
            decomposeTRS(rest, restT, restR, vec3.create());

            const r = bone.rotation
                ? quat.normalize(quat.create(), quat.multiply(quat.create(),
                    quat.fromValues(bone.rotation[0], bone.rotation[1], bone.rotation[2], bone.rotation[3]), restR))
                : restR;
            samplers.push({ input: [0, 1], output: [r[0], r[1], r[2], r[3], r[0], r[1], r[2], r[3]], interpolation: 'LINEAR' } as AnimationSampler);
            channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: nodeIndex, targetPath: 'rotation' } as AnimationChannel);

            if (bone.translation) {
                const t = vec3.add(vec3.create(), restT, vec3.fromValues(bone.translation[0], bone.translation[1], bone.translation[2]));
                samplers.push({ input: [0, 1], output: [t[0], t[1], t[2], t[0], t[1], t[2]], interpolation: 'LINEAR' } as AnimationSampler);
                channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: nodeIndex, targetPath: 'translation' } as AnimationChannel);
            }
        }
        const clip: Animation = { name: `pose:${state.pose?.name ?? state.name}`, samplers, channels };
        this._poseClips.set(state, clip);
        return clip;
    }

    /**
     * Play a clip as a one-shot ACTION over whatever the controller is doing — an attack, a reload, a wave
     * — without wiring it into the graph. It fades in, plays, and fades out on its own; a masked slot
     * (say an "UpperBody" one declared on the controller) keeps the legs on locomotion meanwhile.
     *
     * A second action in the same slot cross-fades from the first, whose handle then resolves.
     */
    public playAction(clipName: string, options: AnimationActionOptions = {}): AnimationActionHandle {
        const slotName = options.slot ?? this._stateMachine?.slots?.[0]?.name ?? 'FullBody';
        let slot = this._overlays.find(o => o.kind === 'slot' && o.name === slotName);
        if (!slot) {
            // An undeclared slot is a full-body override above everything — what a bare playAction wants.
            slot = this._addSlot({ name: slotName }, this._stateMachine?.layers?.length ?? 0);
            this._overlays.sort((a, b) => a.order - b.order);
        }

        const exists = !!this._animatedModel?.animations.some(a => a.name === clipName);
        let resolve!: () => void;
        const finished = new Promise<void>(r => { resolve = r; });
        const action: ActionState = {
            clipName, loop: !!options.loop, blendOut: Math.max(0, options.blendOut ?? 0.2),
            stopping: false, done: false, resolve,
            ikWeight: clamp(typeof options.ikWeight === 'number' ? options.ikWeight : 1, 0, 1),
        };
        const target = slot;
        const handle: AnimationActionHandle = {
            slot: slotName, clipName, finished,
            get done() { return action.done; },
            stop: (blendOut?: number) => {
                if (action.done || target.action !== action) return;
                action.stopping = true;
                target.presenceTarget = 0;
                target.fadeSeconds = Math.max(1e-3, blendOut ?? action.blendOut);
            },
        };
        if (!exists) {
            Logger.warn(`playAction: no clip named "${clipName}"`, 'Animation');
            action.done = true;
            resolve();
            return handle;
        }

        // The one being replaced is over as far as its caller is concerned.
        const previous = slot.action;
        if (previous && !previous.done) { previous.done = true; previous.resolve(); }

        const child = slot.animator;
        child._speed = Math.max(0, options.speed ?? 1);
        child._extractRoot = !!options.rootMotion;
        vec3.set(child._rootDelta, 0, 0, 0);
        const crossFade = !!previous && slot.presence > 0;
        child.playAnimationByName(clipName, action.loop, crossFade);
        slot.action = action;
        slot.presenceTarget = 1;
        slot.fadeSeconds = Math.max(1e-3, options.blendIn ?? 0.15);
        if (crossFade) child._activeBlendTime = slot.fadeSeconds;
        return handle;
    }

    /**
     * The world-space root travel the playing actions extracted since the last call (see
     * AnimationActionOptions.rootMotion), and reset. Divide by the frame time for a velocity.
     */
    public consumeRootMotion(out: vec3 = vec3.create()): vec3 {
        vec3.set(out, 0, 0, 0);
        for (const o of this._overlays) {
            if (o.kind !== 'slot') continue;
            vec3.add(out, out, o.animator._rootDelta);
            vec3.set(o.animator._rootDelta, 0, 0, 0);
        }
        if (this._node) {
            const nw = this._node.worldTransform;
            const scale = nw ? Math.cbrt(Math.abs(mat4.determinant(nw as mat4))) || 1 : 1;
            vec3.transformQuat(out, out, this._node.worldQuaternion);
            vec3.scale(out, out, scale);
        }
        return out;
    }

    /** Fade out whatever action is playing in `slot` (every slot when omitted). */
    public stopAction(slot?: string, blendOut?: number): void {
        for (const o of this._overlays) {
            if (o.kind !== 'slot' || (slot && o.name !== slot) || !o.action) continue;
            o.action.stopping = true;
            o.presenceTarget = 0;
            o.fadeSeconds = Math.max(1e-3, blendOut ?? o.action.blendOut);
        }
    }

    /** True while an action is playing (or fading) in `slot`, or in any slot when omitted. */
    public isActionPlaying(slot?: string): boolean {
        return this._overlays.some(o => o.kind === 'slot' && (!slot || o.name === slot) && !!o.action);
    }

    /** Set a layer's weight (0..1) from a script. A weight parameter, when the layer has one, wins. */
    public setLayerWeight(layer: string, weight: number): void {
        const o = this._overlays.find(x => x.kind === 'layer' && x.name === layer);
        if (o) o.weight = clamp(weight, 0, 1);
    }

    /** The state a layer is in, or null. The base layer's is {@link currentStateName}. */
    public layerStateName(layer: string): string | null {
        return this._overlays.find(x => x.kind === 'layer' && x.name === layer)?.animator.currentStateName ?? null;
    }

    /** Names of the layers above the base, in order. */
    public get layerNames(): string[] {
        return this._overlays.filter(o => o.kind === 'layer').map(o => o.name);
    }

    // ---- Ragdoll drive mode ----

    // The pose BEFORE this frame's update, so a ragdoll can start with the velocity the animation had.
    // One copy of the bone matrices per frame, skinned animators only.
    private _prevBones: mat4[] | null = null;
    private _prevNodeWorld: mat4 | null = null;
    private _prevDt = 0;

    private _capturePreviousPose(deltaTime: number): void {
        const nodeWorld = this._node?.worldTransform as mat4 | undefined;
        if (!this._skin || !nodeWorld || this._isOverlay) return;
        const n = this._finalBoneMatrices.length;
        if (!this._prevBones || this._prevBones.length !== n) this._prevBones = Array.from({ length: n }, () => mat4.create());
        for (let i = 0; i < n; i++) mat4.copy(this._prevBones[i], this._finalBoneMatrices[i]);
        this._prevNodeWorld = mat4.copy(this._prevNodeWorld ?? mat4.create(), nodeWorld);
        this._prevDt = deltaTime;
    }

    /**
     * The bone matrices and node transform as they were one update ago, and the time between -- what a
     * ragdoll differences against the current pose for its hand-off velocity. Null before two updates.
     */
    public previousPose(): { bones: mat4[]; nodeWorld: mat4; dt: number } | null {
        if (!this._prevBones || !this._prevNodeWorld || this._prevBones.length !== this._finalBoneMatrices.length) return null;
        return { bones: this._prevBones, nodeWorld: this._prevNodeWorld, dt: this._prevDt };
    }

    /** True while bones are driven by physics bodies instead of animation. */
    public get ragdollActive(): boolean { return this._ragdollActive; }

    /**
     * Hand the skeleton over to physics: bone matrices come from `bodies` (keyed by glTF node index)
     * every frame instead of from animation.
     */
    public enableRagdoll(bodies: Map<number, RagdollBodyRef>): void {
        this._ragdollActive = true;
        this._playing = false;
        this._ragdollDrive = new Map();
        if (!this._skin || !this._node) return;

        // Walk up the skeleton to the nearest ancestor (inclusive) that owns a body.
        const parentOf = this._topology().parentNodeOfNode;
        const drivingIndex = (nodeIndex: number): number | null => {
            let n: number | undefined = nodeIndex;
            while (n !== undefined) {
                if (bodies.has(n)) return n;
                n = parentOf.get(n);
            }
            return null;
        };

        // offset = inverse(bodyWorld0) * nodeWorld0 * finalBoneMatrix0. bodyWorld0 is rigid, so all scale
        // lives in finalBoneMatrix0 and carries through unchanged.
        const nodeWorld0 = this._node.worldTransform;
        const bodyWorld0 = mat4.create();
        const bodyInv0 = mat4.create();
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const bi = drivingIndex(joint.nodeIndex);
            if (bi === null) continue; // no bodied ancestor: keep this bone's last matrix
            const body = bodies.get(bi)!;
            const q = body.quaternion, p = body.position;
            mat4.fromRotationTranslation(bodyWorld0, [q.x, q.y, q.z, q.w], [p.x, p.y, p.z]);
            mat4.invert(bodyInv0, bodyWorld0);
            const offset = mat4.create();
            mat4.multiply(offset, nodeWorld0, this._finalBoneMatrices[jointIndex]); // nodeWorld0 * FBM0
            mat4.multiply(offset, bodyInv0, offset);                                // inverse(bodyWorld0) * ...
            this._ragdollDrive.set(joint.nodeIndex, { body, offset });
        }
    }

    /** Return control of the skeleton to the animation system. */
    public disableRagdoll(): void {
        this._ragdollActive = false;
        this._ragdollDrive = null;
    }

    // Final bone matrices from ragdoll bodies: world transform -> model space -> inverse bind matrix.
    // Runs after the physics step, so the bodies hold this frame's settled pose.
    private _updateRagdollMatrices(): void {
        if (!this._skin || !this._ragdollDrive || !this._node) return;

        const nodeInv = mat4.create();
        mat4.invert(nodeInv, this._node.worldTransform);

        const bodyWorld = mat4.create();
        const tmp = mat4.create();

        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const drive = this._ragdollDrive.get(joint.nodeIndex);
            if (!drive) continue; // no bodied ancestor: keep its last matrix

            // finalBoneMatrix = inverse(nodeWorld) * bodyWorld * offset  (bodyWorld built rigidly)
            const q = drive.body.quaternion, p = drive.body.position;
            mat4.fromRotationTranslation(bodyWorld, [q.x, q.y, q.z, q.w], [p.x, p.y, p.z]);
            mat4.multiply(tmp, nodeInv, bodyWorld);
            mat4.multiply(this._finalBoneMatrices[jointIndex], tmp, drive.offset);
        }
    }

    /** Set the trigger-based playback mappings. */
    public setAnimationMappings(mappings: AnimationMapping[]): void {
        this._animationMappings = mappings;
    }
    
    /** The current trigger-based playback mappings. */
    public getAnimationMappings(): AnimationMapping[] {
        return this._animationMappings;
    }
    
    /** Set the node whose state triggers and variable bindings are read from. */
    public setNode(node: Node): void {
        this._node = node;
    }
    
    /** Evaluate the mapping triggers and start any animation they select. Call before {@link update}. */
    public checkTriggers(): void {
        // While ragdolling, ignore animation triggers (and don't fall back to T-pose).
        if (this._ragdollActive) return;
        if (!this._animatedModel) return;

        // The state machine, when present, is the source of truth for what plays.
        if (this._stateMachine) {
            this._evaluateStateMachine();
            // Layers after the base, so they read parameters the base's variable bindings just refreshed.
            for (const o of this._overlays) if (o.kind === 'layer') o.animator._evaluateStateMachine();
            return;
        }

        // If no mappings, set T-pose by stopping animation
        if (this._animationMappings.length === 0) {
            if (this._playing) {
                this._setTPose();
            }
            return;
        }
        
        const input = InputSystem.instance;
        let triggerFound = false;
        let targetAnimation: string | null = null;
        
        // Check all mappings in order (priority: first match wins)
        for (const mapping of this._animationMappings) {
            let shouldTrigger = false;
            
            switch (mapping.triggerType) {
                case 'key':
                    if (mapping.keyCode && input.isKeyDown(mapping.keyCode)) {
                        shouldTrigger = true;
                    }
                    break;
                    
                case 'direction':
                    if (this._node && mapping.direction) {
                        shouldTrigger = this._checkDirectionTrigger(mapping.direction, mapping.directionThreshold);
                    }
                    break;
                    
                case 'speed':
                    if (mapping.speedThreshold !== undefined) {
                        shouldTrigger = this._checkSpeedTrigger(mapping.speedThreshold);
                    }
                    break;
                    
                case 'custom':
                    if (mapping.customCondition) {
                        shouldTrigger = this._evaluateCustomCondition(mapping.customCondition);
                    }
                    break;
            }
            
            if (shouldTrigger) {
                triggerFound = true;
                targetAnimation = mapping.animationName;
                // First matching trigger wins - stop checking others
                break;
            }
        }
        
        if (triggerFound && targetAnimation) {
            // Play the animation if not already playing it
            if (!this._currentAnimation || this._currentAnimation.name !== targetAnimation || !this._playing) {
                // Blend only when something was running: after _setTPose() the bind pose is on screen but
                // _bones still hold the last animated one, so a cross-fade would start from the wrong pose.
                this.playAnimationByName(targetAnimation, true, this._playing);
            }
        } else {
            // No trigger active - set T-pose if currently playing
            if (this._playing) {
                this._setTPose();
            }
        }
    }
    
    // Reset the bone matrices to the bind pose from the skin's initial node transforms.
    private _setTPose(): void {
        // Drop editor pins first: `showBindPose` means "show me the rest pose", and a bone still held by a
        // gizmo drag would sit visibly out of place in it.
        this._boneOverrides = null;
        if (!this._skin) return;

        // The bind pose is un-IK'd, and this writes bone matrices without going through _recomputePose.
        this._ikFootWeights.clear();
        this._ikFootHits.clear();
        this._ikHipOffset = 0;

        // Stop any playing animation
        this._playing = false;
        // A surviving _isBlending would have _recomputePose mix the old clips back in next frame.
        this._isBlending = false;
        this._previousAnimation = null;
        this._previousBones.clear();
        this._previousFieldEntries = null;
        // Same for a live field: the next _recomputePose would overwrite the bind pose with the blend.
        this._clearField();

        // Accumulate the bind pose along the SHARED topology, exactly as _recomputePose does — a
        // one-level parent lookup would end the walk at any non-joint node.
        const topo = this._topology();
        const globalTransforms = new Map<number, mat4>();

        for (const jointIndex of topo.order) {
            const nodeIndex = this._skin.joints[jointIndex].nodeIndex;
            const local = this._skin.nodeTransforms?.get(nodeIndex);

            const global = mat4.create();
            const parentJoint = topo.parentJoint[jointIndex];
            if (parentJoint >= 0) mat4.copy(global, globalTransforms.get(this._skin.joints[parentJoint].nodeIndex)!);
            for (const chainNode of topo.parentChain[jointIndex]) {
                const rest = this._skin.nodeTransforms?.get(chainNode);
                if (rest) mat4.multiply(global, global, rest);
            }
            if (local) mat4.multiply(global, global, local);
            globalTransforms.set(nodeIndex, global);
        }

        // Calculate final bone matrices for bind pose (same formula as _recomputePose).
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const globalTransform = globalTransforms.get(joint.nodeIndex) ?? mat4.create();
            mat4.multiply(this._finalBoneMatrices[jointIndex], globalTransform, joint.inverseBindMatrix);
            mat4.copy(this._jointModelMatrices[jointIndex] ??= mat4.create(), globalTransform);
        }
    }
    
    // True when the node's movement direction, brought into its local space, is within `threshold` of
    // `targetDirection` by dot product.
    private _checkDirectionTrigger(targetDirection: [number, number, number], threshold: number = 0.8): boolean {
        if (!this._node || !(this._node instanceof ModelNode)) return false;
        
        const modelNode = this._node as ModelNode;
        
        // Get the movement direction from the ModelNode
        const worldInputDir = vec3.clone(modelNode.movementDirection);
        
        // Check if there's any input
        const inputLength = vec3.length(worldInputDir);
        if (inputLength === 0) {
            // No input - check if target direction is zero (idle state)
            const targetLength = Math.sqrt(
                targetDirection[0] * targetDirection[0] + 
                targetDirection[1] * targetDirection[1] + 
                targetDirection[2] * targetDirection[2]
            );
            return targetLength === 0;
        }
        
        // Normalize world input direction
        vec3.normalize(worldInputDir, worldInputDir);
        
        // Invert the node's world rotation to bring the direction into local space.
        const nodeWorldTransform = this._node.worldTransform;
        
        // Extract rotation quaternion from the world transform matrix
        const worldRotation = quat.create();
        mat4.getRotation(worldRotation, nodeWorldTransform);
        
        // Invert the rotation to go from world space to local space
        const inverseRotation = quat.create();
        quat.invert(inverseRotation, worldRotation);
        
        // Transform world input direction to local space using only rotation
        const localInputDir = vec3.create();
        vec3.transformQuat(localInputDir, worldInputDir, inverseRotation);
        
        // Normalize to be safe (should already be normalized, but just in case)
        vec3.normalize(localInputDir, localInputDir);
        
        // Create target direction vector and normalize
        const targetDir = vec3.fromValues(targetDirection[0], targetDirection[1], targetDirection[2]);
        const targetLength = vec3.length(targetDir);
        if (targetLength === 0) {
            // Target is idle (zero vector), but we have input
            return false;
        }
        vec3.normalize(targetDir, targetDir);
        
        // Calculate dot product to measure similarity in local space
        const dotProduct = vec3.dot(localInputDir, targetDir);
        
        // Check if dot product exceeds threshold
        return dotProduct >= threshold;
    }
    
    // True when the measured speed is above `threshold`.
    private _checkSpeedTrigger(threshold: number): boolean {
        return this._currentSpeed >= threshold;
    }
    
    // Evaluate a custom condition string. Only safe property access is permitted.
    private _evaluateCustomCondition(condition: string): boolean {
        if (!this._node) return false;
        
        try {
            // Create a safe evaluation context
            const context = {
                node: this._node,
                position: this._node.position,
                rotation: this._node.rotation,
                scale: this._node.scale,
                // Add any other safe properties here
            };
            
            // Use Function constructor for evaluation (safer than eval)
            const fn = new Function('context', `with(context) { return ${condition}; }`);
            return Boolean(fn(context));
        } catch (error) {
            Logger.print('warn', [`Failed to evaluate animation condition: ${condition}`, error], 'Animation');
            return false;
        }
    }
    
    // Getters and setters
    public get isPlaying(): boolean { return this._playing; }
    public get currentTime(): number { return this._currentTime; }
    /** Duration (seconds) of the current animation, or 0 if none. */
    public get duration(): number { return this._getAnimationDuration(); }
    public get loop(): boolean { return this._loop; }
    public set loop(value: boolean) { this._loop = value; }
    public get speed(): number { return this._speed; }
    public set speed(value: number) { this._speed = Math.max(0, value); }
    public get currentAnimation(): Animation | null { return this._currentAnimation; }
    public get currentSpeed(): number { return this._currentSpeed; }
    public get blendTime(): number { return this._blendTime; }
    public set blendTime(value: number) { this._blendTime = Math.max(0, value); }
    public get isBlending(): boolean { return this._isBlending; }
}
