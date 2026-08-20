import { mat4, quat, vec3 } from 'gl-matrix';
import { AnimatedModel, Animation, AnimationSampler, AnimationChannel, Skin } from './animatedModel';
import {
    AnimationField, AnimationFieldAxis, FieldWeight, fieldWeights, rateScaleOf, phaseOffsetOf,
    axisSmoothing, axisDeadzone, axisWrapSpan, weightSmoothing,
} from './animationField';
import { clamp, dampTime, dampWrapped, wrapSpan } from '../core/math';
import { skeletonTopology, SkeletonTopology, isAncestorJoint } from './skeletonTopology';
import { solveTwoBone, ikTuning, validateIkRig, swingReleaseWeight, IkFootChain, IkRig, IkRigValidation } from './ik';
import { Node } from '../core/scene/nodes/node';
import { ModelNode } from '../core/scene/nodes/modelNode';
import { canAccessVariable } from '../core/scene/nodes/nodeVariables';
import { InputManager } from '../input/inputManager';
import { Logger } from '../core/logger';

/**
 * Minimal structural view of a physics body used to drive ragdoll bones.
 * Matches cannon-es Body (position/quaternion) without importing the physics layer.
 */
export interface RagdollBodyRef {
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
}

/**
 * Animation mapping interface for trigger-based animation playback
 */
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
// Animation State Machine + Events
//
// The modern authoring model (replaces the flat AnimationMapping list going forward):
// named States each bound to a clip, Transitions with Conditions that compare typed
// Parameters scripts set at runtime, plus per-clip timeline Event markers that fire named
// events. The whole machine is a plain serializable object stored on the Animator/ModelNode.
// ---------------------------------------------------------------------------

export type AnimationParameterType = 'bool' | 'float' | 'trigger' | 'variable';

/**
 * Engine-provided node values a 'variable' parameter can bind to, alongside user-authored variables.
 *
 * These exist because the ordinary lookup cannot reach them. `_refreshVariableParams` resolves a variable
 * through `getVariable(name)` and then an OWN property via `hasOwnProperty` — and that guard is deliberate,
 * since it is the only thing stopping a parameter named `position` from reading a real Node member. But a
 * prototype getter like `currentSpeed` fails `hasOwnProperty` too, so binding to one would silently read the
 * default forever. A curated list keeps the guard intact while making the useful values reachable.
 *
 * They are all MEASURED state (what the body actually did), which is exactly what an animation machine wants:
 * a character jammed against a wall should fall back to idle rather than keep running on the spot.
 */
export const NODE_BUILTINS: Record<string, {
    type: 'number' | 'boolean';
    /**
     * True when this value can go below zero.
     *
     * Recorded here so consumers cannot drift from the getters. It matters wherever a negative reading means
     * something other than "a small number": a state's Speed parameter clamps at 0 and freezes the clip (see
     * _applyStateSpeed), and a blend-space axis authored only over non-negative coordinates leaves half a
     * signed parameter's range unreachable.
     */
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

    // The only SIGNED speeds. Every other speed above is a vector magnitude, so a blend-space sample authored
    // at a negative speed on one of those axes is unreachable and its clip never plays; these are what make
    // "walk backwards at -1.5" mean what it looks like it means. See Node.forwardSpeed for the two valid
    // blend-space layouts and why mixing them leaves dead space.
    forwardSpeed:     { type: 'number',  signed: true, read: n => n.forwardSpeed },
    lateralSpeed:     { type: 'number',  signed: true, read: n => n.lateralSpeed },

    // Rate of change, not state. These are what make a START and a STOP expressible: speed alone cannot tell
    // a character breaking into a run from one already running at that speed, so a machine reading only
    // `planarSpeed` can pick a gait but can never play the transition into it.
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
 * Binds a 'variable' parameter to a node value, read each frame.
 *
 * `nodeRef` resolves relative to the model node running the machine: `'self'`, `'parent'`, `'bodied'` (the
 * nearest ancestor, or self, that owns a rigid body), or a specific node id in the scene.
 *
 * **Prefer a relative reference over an id.** An id is an identity, and identities do not survive being
 * re-created: deleting and re-adding a character, rebuilding a template instance, or re-placing from an asset
 * all regenerate node ids, and the binding then names a node that no longer exists. `'bodied'` names the
 * RELATIONSHIP instead — "whatever is actually moving" — which is what the picker means when it offers a
 * character's bodied ancestor, and it cannot dangle.
 *
 * Two sources: a node CUSTOM VARIABLE (the default, read through the access model —
 * [[node-variable-access]]), or one of the engine's {@link NODE_BUILTINS}.
 */
export interface AnimationVariableBinding {
    nodeRef: 'self' | 'parent' | 'bodied' | string;
    varName: string;
    /** Whether the bound variable reads as a number or boolean (decides which condition ops apply). */
    varType: 'number' | 'boolean';
    /**
     * Where `varName` is read from. Absent means 'variable', so every machine authored before built-ins
     * existed keeps resolving exactly as it did.
     */
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
    /**
     * Link to the Animation Field asset this state plays instead of a single clip. Authoring-side only —
     * the runtime reads `field`, below. Kept so the editor can re-resolve the asset and refresh the copy.
     */
    fieldId?: string;
    /**
     * Resolved copy of the field, embedded by the editor when the machine is applied. This is what actually
     * plays: the machine is serialized whole onto the node, so an embedded field travels through scene saves,
     * templates, bundles and the published game with no extra plumbing anywhere.
     */
    field?: AnimationField;
    /** Names of the machine parameters feeding the field's axes. */
    fieldInputs?: { x?: string; y?: string };
    loop: boolean;
    speed: number;
    /**
     * How many times to play the clip when `loop` is set. 0 or undefined = forever. After the last pass the
     * clip holds on its final frame, exactly as a non-looping clip does — which is what an exit-time
     * transition waits on.
     */
    loopCount?: number;
    /**
     * Parameter to read the playback rate from, instead of `speed`. Re-read every frame, so a variable-bound
     * parameter can drive the rate live (e.g. run faster the faster the character moves). Overrides `speed`.
     */
    speedParam?: string;
    /**
     * How strongly foot IK applies while this state plays, 0..1. Absent means 1 (fully on).
     *
     * On by default, and that is deliberate rather than lazy: a foot whose ground ray finds nothing fades its
     * own contribution to zero, so a character in mid-air already looks right with no authoring at all. This
     * is for the exceptions — a state whose animation should be trusted verbatim.
     */
    ikWeight?: number;
    /**
     * Parameter to read {@link ikWeight} from instead, re-read every frame. Overrides `ikWeight`.
     *
     * The values worth binding here already exist as built-ins: `isGrounded`, `isFalling`, `airTime`,
     * `groundDistance`. A MISSING parameter keeps the static weight rather than reading 0, matching how
     * `speedParam` behaves — a dangling reference should not silently switch a feature off.
     */
    ikWeightParam?: string;
    /** The state the machine starts in. Exactly one state should be the entry. */
    isEntry?: boolean;
    /** Graph-editor layout coordinates (authoring only — ignored at runtime). */
    x?: number;
    y?: number;
}

/** Comparison operator for a transition condition (interpreted per parameter type). */
export type AnimationConditionOp = 'gt' | 'lt' | 'eq' | 'neq' | 'true' | 'false' | 'trigger';

export interface AnimationCondition {
    param: string;
    op: AnimationConditionOp;
    /** Threshold for float comparisons ('gt' | 'lt' | 'eq' | 'neq'). */
    value?: number;
    /**
     * Full width of a latching band centred on `value`, in parameter units. Applies to 'gt' and 'lt'; ignored
     * by every other operator.
     *
     * A bare threshold on a measured value chatters: a speed hovering at 0.1 satisfies `Speed > 0.1` and
     * `Speed < 0.1` on alternating frames, so a machine with one of each flips state every frame — which is
     * what "the animation spasms" usually turns out to be. With a band of `h`, `> value` does not engage until
     * `value + h/2` and does not release until the parameter falls back through `value - h/2` (mirrored for
     * `<`), so a `>`/`<` pair on the same threshold ends up with its two engage points `h` apart and the
     * signal has to genuinely swing before the machine moves.
     *
     * The latch is keyed by the condition's own terms, so two identical conditions share one band — which is
     * what you want, since they are asking the same question of the same signal.
     */
    hysteresis?: number;
}

/** An AND/OR gate over conditions and nested gates. See {@link AnimationTransition.condition}. */
export interface AnimationConditionGroup {
    op: 'and' | 'or';
    children: AnimationConditionNode[];
}

export type AnimationConditionNode = AnimationCondition | AnimationConditionGroup;

/**
 * A group carries `children`; a leaf carries `param`. Both have an `op`, so `op` cannot discriminate them —
 * the group's is 'and'/'or' while the leaf's is a comparison.
 */
export function isConditionGroup(node: AnimationConditionNode): node is AnimationConditionGroup {
    return 'children' in node;
}

export interface AnimationTransition {
    /** Source state name, or '*' to match any state. */
    from: string;
    to: string;
    /**
     * Flat, implicitly-ANDed conditions. Superseded by `condition` — kept so machines authored before gates
     * existed keep running untouched. Ignored entirely whenever `condition` is present.
     */
    conditions: AnimationCondition[];
    /** Compound condition tree. When present it is the only thing consulted; `conditions` is ignored. */
    condition?: AnimationConditionGroup;
    /** When true, the transition only fires once the clip reaches exitTime. */
    hasExitTime?: boolean;
    /** Normalized clip time (0..1) the transition waits for when hasExitTime is set. */
    exitTime?: number;
    /**
     * Seconds to cross-fade over when this transition fires. Undefined uses the animator-wide
     * {@link Animator.blendTime}. Per-edge because one machine wants a snappy landing and a lazy gait change.
     */
    blendTime?: number;
    /**
     * Seconds the machine must already have spent in `from` before this transition may fire at all.
     *
     * The blunt instrument against a state pair that ping-pongs, and the one that works even when the cause is
     * not a single threshold (two states whose conditions genuinely overlap, a trigger raised every frame).
     * Unlike `hasExitTime` it is measured in real seconds from state entry, not in normalized clip time, so it
     * is meaningful for a looping state with no natural exit point.
     *
     * Distinct from `blendTime`: a blend covers the change visually, but the machine can still change its mind
     * mid-blend and re-arm a new one from a pose that has barely moved. This stops it changing its mind.
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
    states: AnimationState[];
    transitions: AnimationTransition[];
    events: AnimationEventMarker[];
}

/**
 * Represents a single keyframe for position data
 */
interface KeyPosition {
    position: vec3;
    timeStamp: number;
}

/**
 * Represents a single keyframe for rotation data
 */
interface KeyRotation {
    orientation: quat;
    timeStamp: number;
}

/**
 * Represents a single keyframe for scale data
 */
interface KeyScale {
    scale: vec3;
    timeStamp: number;
}

/**
 * Bone class handles interpolation of keyframes for a single bone
 */
class Bone {
    private _name: string;
    private _id: number;
    private _localTransform: mat4;

    private _positions: KeyPosition[] = [];
    private _rotations: KeyRotation[] = [];
    private _scales: KeyScale[] = [];

    // The bone's REST pose, used for any channel it has no keyframes for. Non-root skeletal bones are
    // rotation-only — they hold their bind offset and never translate — so without this a rotation-only
    // bone would fall back to a zero translation and collapse onto its parent's origin. Defaults to identity
    // so a bone with no rest seeded behaves exactly as before.
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

    /**
     * Add position channel data
     */
    public addPositionChannel(sampler: AnimationSampler): void {
        this._positions = [];
        for (let i = 0; i < sampler.input.length; i++) {
            const position = vec3.fromValues(
                sampler.output[i * 3],
                sampler.output[i * 3 + 1],
                sampler.output[i * 3 + 2]
            );
            this._positions.push({
                position,
                timeStamp: sampler.input[i]
            });
        }
    }
    
    /**
     * Add rotation channel data
     */
    public addRotationChannel(sampler: AnimationSampler): void {
        this._rotations = [];
        for (let i = 0; i < sampler.input.length; i++) {
            const orientation = quat.fromValues(
                sampler.output[i * 4],
                sampler.output[i * 4 + 1],
                sampler.output[i * 4 + 2],
                sampler.output[i * 4 + 3]
            );
            quat.normalize(orientation, orientation);
            this._rotations.push({
                orientation,
                timeStamp: sampler.input[i]
            });
        }
    }
    
    /**
     * Add scale channel data
     */
    public addScaleChannel(sampler: AnimationSampler): void {
        this._scales = [];
        for (let i = 0; i < sampler.input.length; i++) {
            const scale = vec3.fromValues(
                sampler.output[i * 3],
                sampler.output[i * 3 + 1],
                sampler.output[i * 3 + 2]
            );
            this._scales.push({
                scale,
                timeStamp: sampler.input[i]
            });
        }
    }
    
    /**
     * Update the bone's local transform based on animation time
     */
    public update(animationTime: number): void {
        const translation = this._interpolatePosition(animationTime);
        const rotation = this._interpolateRotation(animationTime);
        const scale = this._interpolateScale(animationTime);
        
        // Combine transformations: T * R * S
        mat4.fromRotationTranslationScale(this._localTransform, rotation, translation, scale);
    }
    
    /**
     * Get the current index for position keyframes
     */
    private _getPositionIndex(animationTime: number): number {
        for (let i = 0; i < this._positions.length - 1; i++) {
            if (animationTime < this._positions[i + 1].timeStamp) {
                return i;
            }
        }
        return this._positions.length - 2;
    }
    
    /**
     * Get the current index for rotation keyframes
     */
    private _getRotationIndex(animationTime: number): number {
        for (let i = 0; i < this._rotations.length - 1; i++) {
            if (animationTime < this._rotations[i + 1].timeStamp) {
                return i;
            }
        }
        return this._rotations.length - 2;
    }
    
    /**
     * Get the current index for scale keyframes
     */
    private _getScaleIndex(animationTime: number): number {
        for (let i = 0; i < this._scales.length - 1; i++) {
            if (animationTime < this._scales[i + 1].timeStamp) {
                return i;
            }
        }
        return this._scales.length - 2;
    }
    
    /**
     * Calculate interpolation factor (0-1) between two keyframes.
     *
     * CLAMPED, and it has to be. The index helpers return `length - 2` for any time past the last keyframe, so
     * an unclamped factor greater than 1 EXTRAPOLATES beyond the final pose along the last segment's slope.
     * A clip's duration is the longest of its channels, so any bone whose channel ends earlier is asked for a
     * time past its own end on every cycle — and an animation field drives several clips of differing lengths
     * to the same phase, which makes it routine rather than rare. Two coincident keyframes divide by zero and
     * also land here; holding the earlier keyframe is the only defined answer.
     */
    private _getScaleFactor(lastTimeStamp: number, nextTimeStamp: number, animationTime: number): number {
        const framesDiff = nextTimeStamp - lastTimeStamp;
        if (!(framesDiff > 0)) return 0;
        const midWayLength = animationTime - lastTimeStamp;
        return clamp(midWayLength / framesDiff, 0, 1);
    }
    
    /**
     * Interpolate position at given animation time
     */
    private _interpolatePosition(animationTime: number): vec3 {
        if (this._positions.length === 0) {
            return vec3.clone(this._restT); // no channel: hold the bind offset, not the origin
        }
        
        if (this._positions.length === 1) {
            return this._positions[0].position;
        }
        
        const p0Index = this._getPositionIndex(animationTime);
        const p1Index = p0Index + 1;
        const scaleFactor = this._getScaleFactor(
            this._positions[p0Index].timeStamp,
            this._positions[p1Index].timeStamp,
            animationTime
        );
        
        const finalPosition = vec3.create();
        vec3.lerp(finalPosition, this._positions[p0Index].position, this._positions[p1Index].position, scaleFactor);
        return finalPosition;
    }
    
    /**
     * Interpolate rotation at given animation time using spherical interpolation (slerp)
     */
    private _interpolateRotation(animationTime: number): quat {
        if (this._rotations.length === 0) {
            return quat.clone(this._restR); // no channel: hold the bind rotation
        }
        
        if (this._rotations.length === 1) {
            const rotation = quat.create();
            quat.normalize(rotation, this._rotations[0].orientation);
            return rotation;
        }
        
        const p0Index = this._getRotationIndex(animationTime);
        const p1Index = p0Index + 1;
        const scaleFactor = this._getScaleFactor(
            this._rotations[p0Index].timeStamp,
            this._rotations[p1Index].timeStamp,
            animationTime
        );
        
        const finalRotation = quat.create();
        quat.slerp(finalRotation, this._rotations[p0Index].orientation, this._rotations[p1Index].orientation, scaleFactor);
        quat.normalize(finalRotation, finalRotation);
        return finalRotation;
    }
    
    /**
     * Interpolate scale at given animation time
     */
    private _interpolateScale(animationTime: number): vec3 {
        if (this._scales.length === 0) {
            return vec3.clone(this._restS); // no channel: hold the bind scale
        }
        
        if (this._scales.length === 1) {
            return this._scales[0].scale;
        }
        
        const p0Index = this._getScaleIndex(animationTime);
        const p1Index = p0Index + 1;
        const scaleFactor = this._getScaleFactor(
            this._scales[p0Index].timeStamp,
            this._scales[p1Index].timeStamp,
            animationTime
        );
        
        const finalScale = vec3.create();
        vec3.lerp(finalScale, this._scales[p0Index].scale, this._scales[p1Index].scale, scaleFactor);
        return finalScale;
    }
    
    /**
     * Sample this bone's translation + rotation at an arbitrary time WITHOUT touching `_localTransform`.
     * Used by root-motion extraction to read the root bone at two times per frame; reuses the same
     * interpolation the normal pose path uses, so the extracted delta matches what would have been posed.
     */
    public sampleTR(time: number): { t: vec3; r: quat } {
        return { t: vec3.clone(this._interpolatePosition(time)), r: quat.clone(this._interpolateRotation(time)) };
    }

    /** Overwrite the local transform directly — root motion locks the root bone to a fixed pose with this. */
    public setLocalTransform(m: mat4): void { mat4.copy(this._localTransform, m); }

    public get localTransform(): mat4 { return this._localTransform; }
    public get name(): string { return this._name; }
    public get id(): number { return this._id; }
}

/**
 * One clip contributing to an active field blend: its own bone map and length, plus how much of the final
 * pose it owns this frame. `bones` is shared with {@link Animator}'s per-clip cache and must never be
 * mutated per-entry — only advanced, which every entry of a field does in lockstep anyway.
 */
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

/**
 * Damped weight below which a clip that is fading out stops being posed.
 *
 * Larger than animationField's own WEIGHT_EPSILON on purpose: this one ends a decaying exponential, which
 * never actually reaches zero, so too tight a value keeps every clip a character has ever blended through
 * posed forever. At 1e-3 a contribution is well under a tenth of a percent of the pose.
 */
const WEIGHT_FADE_EPSILON = 1e-3;

/**
 * How far a rival must lead the current dominant clip before the dominant changes hands.
 *
 * Only affects which clip owns event markers and what `currentAnimation` reports — never the blend itself.
 */
const DOMINANT_SWITCH_MARGIN = 0.05;

/**
 * State changes within one second that mean the machine is fighting itself rather than responding.
 *
 * Set above what real play produces: a burst through idle -> walk -> run -> turn while the player slams the
 * controls is four in a second and legitimate. Sustained thrashing is an order of magnitude faster — a pair of
 * transitions both satisfied around one threshold flips every frame, i.e. 60 — so six is comfortably clear of
 * honest play while still catching a bounce long before it needs a stopwatch to see.
 */
const PING_PONG_FLIPS_PER_SEC = 6;

/**
 * Animator class manages skeletal animation playback
 * Based on the LearnOpenGL skeletal animation approach
 */
export class Animator {
    private _currentAnimation: Animation | null = null;
    private _animatedModel: AnimatedModel | null = null;
    private _currentTime: number = 0;
    /**
     * Frame time scaled by playback speed. This is CLOCK time: it advances phase, clip time and cross-fades,
     * which is exactly what a playback rate is supposed to affect.
     */
    private _deltaTime: number = 0;
    /**
     * Frame time as the wall gives it, unscaled. This is FILTER time.
     *
     * The two must not be the same variable, because playback rate and filter response are unrelated
     * quantities. Every damping time constant in here — axis smoothing, weight smoothing, IK foot weights — is
     * authored in SECONDS, so feeding them a speed-scaled dt makes a state at speed 0.5 take twice as long to
     * settle as it asked for.
     *
     * At speed 0 it is worse than a stretch: each filter reads `dt <= 0` as "do not filter" and returns its
     * target raw. A state whose Speed parameter is bound to a signed value (`forwardSpeed`, `planarAngle`, …)
     * pins `_speed` to 0 the moment that value goes negative — see _applyStateSpeed — so the clips freeze while
     * the blend goes on being recomputed every frame from an unsmoothed, noisy probe. That reads on screen as
     * the whole pose vibrating, and only ever on one side of the axis, because the clamp is what makes it
     * asymmetric.
     *
     * Assigned in lockstep with `_deltaTime` so the two go stale together when `update` returns early: a
     * scrubbing editor must still not advance any smoothing.
     */
    private _frameDelta: number = 0;
    private _finalBoneMatrices: mat4[] = [];
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

    // Ragdoll: when active, bone matrices are driven by physics bodies instead of animation.
    // Every joint is driven by the nearest ancestor bone that owns a body, so bones without their own
    // body (e.g. pruned fingers) ride rigidly on their limb. finalBoneMatrix = inv(nodeWorld) * bodyWorld * offset;
    // the constant offset captures the bone's full start pose incl. any embedded rig scale, so bones
    // follow only the body's RIGID motion (no scale reconstruction) and scaled rigs don't blow up.
    private _ragdollActive: boolean = false;
    private _ragdollDrive: Map<number, { body: RagdollBodyRef, offset: mat4 }> | null = null;

    // Animation state machine (the modern action/event-driven model). When set, it drives
    // playback each frame instead of the AnimationMapping list. Parameter values are live
    // (set by scripts); triggers are consumed when a transition using them fires.
    private _stateMachine: AnimationStateMachine | null = null;
    private _paramValues: Map<string, number | boolean> = new Map();
    private _currentStateName: string | null = null;
    private _eventCallbacks: ((eventName: string, clipName: string) => void)[] = [];
    private _prevEventTime: number = 0;
    /**
     * Real seconds spent in the current state. What {@link AnimationTransition.minDwell} is measured against —
     * deliberately not derived from _currentTime, which a field re-scales as its blend shifts and which a
     * looping state wraps.
     */
    private _stateTime: number = 0;
    /**
     * Latch state for conditions with a hysteresis band, keyed by the condition's terms.
     *
     * Keyed by value rather than by identity because a condition leaf is a plain serialized object with no
     * stable identity across an edit, and because two leaves asking the same question of the same parameter
     * should share one band anyway.
     */
    private _condLatch: Map<string, boolean> = new Map();

    // ---- Animation field (blend space) playback ----
    //
    // When a field is active it REPLACES _bones as the source of the current pose: several clips are posed
    // at a shared normalized phase and mixed by weight. _currentTime / duration stay meaningful (they read
    // the weighted duration), so exit-time transitions and event markers keep working untouched.
    private _fieldDef: AnimationField | null = null;
    private _fieldInputs: { x?: string; y?: string } | null = null;
    private _fieldEntries: FieldEntry[] | null = null;
    /**
     * SMOOTHED probe coordinates — what the field is actually sampled at. Set directly by the editor preview
     * (which wants no lag), damped towards _fieldTargetX/Y when a machine is driving the axes.
     */
    private _fieldX: number = 0;
    private _fieldY: number = 0;
    /**
     * The probe the parameters are asking for, after the axis deadband. Kept separate from _fieldX/_fieldY so
     * the damping has a fixed target: damping towards a value that is itself the damped result would stall.
     */
    private _fieldTargetX: number = 0;
    private _fieldTargetY: number = 0;
    /** False until the first parameter read, which snaps the probe instead of damping in from 0. */
    private _fieldProbeSeeded: boolean = false;
    /** Shared normalized playback position (0..1) across every contributing clip — the anti-foot-slide. */
    private _fieldPhase: number = 0;
    /** Phase at the START of this frame, so event markers get a monotonic window (see _fireDueEvents). */
    private _prevFieldPhase: number = 0;
    /**
     * Damped weight per clip name, surviving between frames.
     *
     * This is what keeps the contributing SET continuous. fieldWeights drops a clip the moment its weight
     * goes negligible, and an entry appearing or vanishing between two frames is a discontinuity no amount of
     * probe smoothing can remove — _mixTransforms seeds its accumulator from the first entry and folds the
     * rest in incrementally, so the set changing changes the result. Holding a departing clip here at a
     * decaying weight turns that step into a fade.
     */
    private _fieldWeightState: Map<string, number> = new Map();
    /**
     * Last seen rate scale and phase offset per clip name, so a clip that is FADING OUT — and whose sample the
     * field no longer returns — keeps being posed the way it was while it was still contributing.
     */
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
    /**
     * Clip currently treated as dominant, held with a margin.
     *
     * _currentAnimation follows this, and it owns event-marker ownership plus the public getter. Picking the
     * per-frame maximum outright makes the identity flicker every frame around a 50/50 crossing, which fires
     * (or drops) markers at random.
     */
    private _fieldDominant: string | null = null;
    /** Bone maps per clip, built once. Weights change every frame; bone maps must not be rebuilt with them. */
    private _fieldBoneCache: Map<string, { bones: Map<string, Bone>; duration: number; animation: Animation }> = new Map();
    /** Cached skeleton hierarchy; see _topology(). */
    private _topologyCache: SkeletonTopology | null = null;
    private _topologySkin: Skin | null = null;

    // ---- Foot IK state ----
    //
    // Both are damped across frames, which is the whole reason they are fields rather than locals: a foot
    // crossing the lip of a ledge would otherwise snap between planted and free on consecutive frames.
    /** Per foot (keyed by its ankle's node index): how much of the IK correction is currently applied. */
    private _ikFootWeights: Map<number, number> = new Map();
    /**
     * Per foot: the last surface its ray found, in WORLD space, so a foot that loses its ground fades out
     * instead of popping. Without it there is nothing to fade TOWARDS on the frame the ray first misses, and
     * the correction simply vanishes for that frame however smoothly the weight is decaying.
     *
     * World, not model: a model-space memory would be carried along by the character, so a walking character's
     * fading foot would be held at a stale point relative to its own body rather than to the ground it just
     * left. Re-transformed through the current `worldToModel` each frame, which is already computed.
     */
    private _ikFootHits: Map<number, { point: vec3; normal: vec3 }> = new Map();
    /** The last validated rig and its result, so validation and its warning happen once per rig, not per frame. */
    private _validatedRigRef: IkRig | null = null;
    private _rigValidation: IkRigValidation | null = null;
    /** How far the pelvis is currently lowered, in model units along "up". Never positive. */
    private _ikHipOffset: number = 0;
    /** The field being cross-faded OUT of, mirroring _previousBones for the single-clip path. */
    private _previousFieldEntries: FieldEntry[] | null = null;
    private _previousFieldPhase: number = 0;

    // ---- Root motion ----
    //
    // When the current clip is flagged `rootMotion`, the ROOT bone's per-frame translation/rotation delta is
    // applied to the character (the nearest bodied ancestor, else the model node) and the root bone is then
    // locked to its clip-start pose so the mesh is not also moved in model space. Single-clip playback only;
    // a field blends several clips and has no single root to extract.
    private _rootMotionActive: boolean = false;
    private _rootBoneName: string | null = null;
    private _rootRefT: vec3 = vec3.create();
    private _rootRefR: quat = quat.create();
    private _rootRefS: vec3 = vec3.fromValues(1, 1, 1);
    /**
     * Rotation of the root bone's PARENT chain within the skin (the static armature). This is what carries a
     * rig's authoring→engine axis conversion (e.g. an FBX Z-up rig imported Y-up sits under a -90°X armature),
     * so the root delta must be brought through it — otherwise a yaw authored about the armature's up-axis
     * comes out as a roll/pitch in world space, i.e. "the turn rotates on the wrong axis".
     */
    private _rootParentRot: quat = quat.create();

    constructor(animatedModel: AnimatedModel, node?: Node) {
        this._animatedModel = animatedModel;
        this._node = node || null;
        
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
    
    /**
     * Play animation by index
     */
    public playAnimation(animationIndex: number, loop: boolean = true, blend: boolean = true): void {
        if (!this._animatedModel || animationIndex < 0 || animationIndex >= this._animatedModel.animations.length) {
            Logger.warn(`Animation index ${animationIndex} out of range`, 'Animation');
            return;
        }
        
        const animation = this._animatedModel.animations[animationIndex];
        
        // Blend out of whatever is currently posed, whether or not it is still running. It deliberately does
        // NOT test `_playing`: a non-looping clip that reached its end has already set _playing = false while
        // holding its last frame, and that is exactly when a state machine wants to cross-fade away from it
        // (a Jump landing). `_currentAnimation` being null already covers the only case that must not blend —
        // the very first play. Callers that must not blend out of a bind pose pass blend = false.
        // A field is always a distinct pose source from a clip, so switching away from one always blends —
        // there is no "same animation" case to suppress it the way there is for clip-to-clip.
        const blendOut = blend && (this._fieldEntries !== null
            || (!!this._currentAnimation && this._currentAnimation !== animation));

        if (blendOut) {
            // Store current animation state for blending
            this._previousAnimation = this._currentAnimation;
            this._previousBones = new Map(this._bones);
            this._capturePreviousField();
            this._previousTime = this._currentTime;
            // Read BEFORE _playing/_loop are overwritten below: a clip that already ran to its end must hold
            // its final pose under the cross-fade, not restart.
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

        // A single clip is taking over as the current pose source; any field is now history (it was moved
        // into the previous slot above when this switch blends).
        this._clearField();

        this._currentAnimation = animation;
        this._currentTime = 0;
        this._loop = loop;
        this._playing = true;
        // Fresh clip, fresh budget. _enterState re-applies the state's limit right after this; every other
        // caller means "loop forever" and must not inherit a limit left behind by a previous state.
        this._loopsPlayed = 0;
        this._loopLimit = 0;

        // Build bone map from animation channels
        this._buildBoneMap(animation);

        // Arm root motion for this clip, if it carries it: lock onto its root bone and snapshot the pose the
        // extraction holds the mesh at while the delta drives the character.
        this._setupRootMotion(animation);
    }

    /**
     * Play animation by name
     */
    public playAnimationByName(name: string, loop: boolean = true, blend: boolean = true): void {
        if (!this._animatedModel) return;
        
        const animationIndex = this._animatedModel.animations.findIndex(anim => anim.name === name);
        if (animationIndex === -1) {
            Logger.warn(`Animation "${name}" not found`, 'Animation');
            return;
        }
        
        this.playAnimation(animationIndex, loop, blend);
    }
    
    /**
     * Build a FRESH bone map from an animation's channels.
     *
     * Split out of _buildBoneMap so field playback can build maps of its own. Every live pose source needs
     * its OWN Bone objects: bones carry the time they were last posed at, and two sources advancing the same
     * Bone to different times each frame would clobber each other (a field cross-fading into a clip it also
     * contains is the case that hits this).
     */
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
                // Seed its rest pose so a channel it lacks falls back to the bind offset — the same rest
                // source _recomputePose uses for a joint with no channels at all, keeping the two consistent.
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

    /**
     * Build bone map from animation channels
     */
    private _buildBoneMap(animation: Animation): void {
        this._bones = this._buildBoneMapFor(animation);

        let animatedCount = 0;
        if (this._skin) {
            for (let i = 0; i < this._skin.joints.length; i++) {
                if (this._bones.has(`bone_${this._skin.joints[i].nodeIndex}`)) animatedCount++;
            }
        }

        // ONE line, and a FLUSH line: this runs on every state entry, and four rows per entry is 240 lines a
        // second out of a machine that is thrashing — which evicts the whole 500-entry ring in two seconds and
        // buries the very warnings (ping-pong, dangling binding, missing clip) that would explain the
        // thrashing. A flush row is rewritten in place and is not mirrored to devtools, so the information
        // stays available without being able to drown anything.
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
    //
    // A field poses SEVERAL clips at one shared normalized phase and mixes them by weight. It replaces
    // _bones as the current pose source while active; _recomputePose reads both through _currentLocal /
    // _previousLocal so the hierarchy accumulation, bind-pose fallback and cross-fade below it are unchanged.

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

    /**
     * Move the active field into the outgoing slot for a cross-fade, with bone maps of its OWN.
     *
     * The copy is not an optimization to skip: the outgoing and incoming sides are advanced to different
     * times every frame, and sharing Bone objects (which hold their last posed transform) would have each
     * side overwrite the other. Rebuilding two or three bone maps happens only on a state transition.
     */
    private _capturePreviousField(): void {
        if (!this._fieldEntries) { this._previousFieldEntries = null; return; }
        this._previousFieldEntries = this._fieldEntries.map(e => ({
            ...e,
            bones: this._buildBoneMapFor(e.animation),
        }));
        this._previousFieldPhase = this._fieldPhase;
    }

    /**
     * Start playing a field, cross-fading out of whatever is currently posed.
     *
     * A DIFFERENT field starts at phase 0. It does NOT inherit the outgoing one's phase: the outgoing
     * side keeps its own and goes on advancing under the cross-fade (see _previousFieldPhase), so the
     * transition is covered by the blend rather than by matching up two unrelated cycles.
     *
     * Re-entering the SAME field object is the exception, and the reason is the ping-pong case: two
     * transitions sitting either side of one threshold re-enter a state every frame while the parameter
     * hovers, and restarting the cycle from zero each time is a stutter with no animation content behind it.
     * The identity test is deliberately by reference — each state embeds its own copy of a field, so two
     * different states playing the same asset are still different objects and still reset.
     */
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

        // A field blends several clips and has no single root to extract; make sure a clip's root motion does
        // not linger and keep driving the character while the field plays.
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
        // Re-derived after the refresh, since the weighted duration is only known once the entries exist. On a
        // carried phase this restores the clock the exit-time gate reads; on a reset it is 0 either way.
        this._currentTime = this._fieldPhase * this._fieldDuration(this._fieldEntries);
        this._prevEventTime = this._currentTime;
    }

    /** The bone map + duration for a clip in the active field, built once and cached by clip name. */
    private _fieldClip(clipName: string): { bones: Map<string, Bone>; duration: number; animation: Animation } | null {
        const animation = this._animatedModel?.animations.find(a => a.name === clipName);
        if (!animation) return null;

        // Keyed by NAME, so the cache has to be checked against the clip that name resolves to today. A clip
        // replaced under the same name — re-imported, or refreshed from the model asset — produces a new
        // Animation object, and a stale entry would go on posing the old keyframes at the old duration.
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

    /**
     * Re-sample the field at the current probe and rebuild the contributing entries.
     *
     * Runs every frame: the probe moves continuously, so the weights do too. Only the weights are cheap to
     * recompute — the bone maps come from _fieldBoneCache, so a weight change never rebuilds one.
     */
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
                // The sample names a clip this model does not have. Skipping keeps the rest of the blend
                // alive — but if EVERY sample is unresolvable the field ends up empty, its duration is 0, the
                // phase never advances, and the character silently holds its bind pose with nothing anywhere
                // saying why. That is the shape of almost every "my blend space stopped animating" report, so
                // it gets named. Once per clip name, or it would be a per-frame flood.
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

        // Whatever is LEFT in `damped` is fading out: a clip the field no longer returns at all. It still has
        // to be posed, or the fade the damping just bought would not be visible anywhere.
        //
        // Its sample is gone, so its rate scale and phase offset come from the remembered meta. That matters
        // for the OFFSET in particular: defaulting it to 0 would jog the clip by however much it was shifted
        // on the exact frame it starts fading, turning the fade this exists to provide back into a pop.
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

        // Dropping unresolvable samples above leaves the remainder summing to less than 1, which would fade
        // the pose towards the bind pose. Re-normalize so what is left still makes a whole pose.
        const total = entries.reduce((sum, e) => sum + e.weight, 0);
        if (total > 0 && Math.abs(total - 1) > 1e-6) for (const e of entries) e.weight /= total;

        // Heaviest first. The mix itself no longer depends on this — _mixTransforms is order-independent —
        // but the debug readout reads better heaviest-first, and a stable order keeps diffs of it readable.
        entries.sort((a, b) => b.weight - a.weight);

        this._fieldEntries = entries;

        // Keep _currentAnimation pointing at the dominant clip: event markers are authored per clip, and the
        // public getter is part of the API. It is NOT used for timing — _getAnimationDuration is field-aware.
        const dominant = this._resolveFieldDominant(entries);
        this._currentAnimation = dominant ? dominant.animation : null;
    }

    /**
     * Move the probe towards what the parameters are asking for.
     *
     * Filtering — this and the weight damping both — is a RUNTIME concern, gated on a machine driving the
     * axes. The field editor writes the probe directly and gets the field exactly as authored: a lag between
     * the pointer and the pose would make placing samples guesswork, and the two agree at steady state
     * anyway, so the preview still cannot drift from the game.
     *
     * Two filters, in this order. The DEADBAND decides whether the target moved at all — below it the probe is
     * not merely slow to follow, it does not follow, which is the only thing that fully removes buzz from a
     * noisy input. The DAMP then closes the remaining gap over the axis's smoothing time, frame-rate
     * independently. A wrapping axis is damped along the shortest arc, or a heading crossing the seam would
     * travel the long way round and sweep the blend through every clip on the way.
     *
     * The editor preview leaves `_fieldInputs` null and writes `_fieldX/_fieldY` directly; it wants the probe
     * exactly where the pointer is, so this whole path is skipped for it.
     */
    private get _fieldFiltering(): boolean { return this._fieldInputs !== null; }

    private _advanceFieldProbe(field: AnimationField): void {
        if (!this._fieldFiltering || !this._fieldInputs) return;

        const read = (name: string | undefined, fallback: number): number => {
            if (!name) return fallback;
            const v = this._paramValues.get(name);
            if (typeof v === 'number') return v;
            if (typeof v === 'boolean') return v ? 1 : 0;
            // Parameter renamed or deleted: hold the last probe rather than snapping the blend to 0,
            // which would read as the character suddenly standing still.
            return fallback;
        };

        const rawX = read(this._fieldInputs.x, this._fieldTargetX);
        const rawY = read(this._fieldInputs.y, this._fieldTargetY);
        const spanX = axisWrapSpan(field.xAxis);
        const spanY = axisWrapSpan(field.yAxis);

        // Deadband against the committed TARGET, not against the damped probe: comparing to the probe would
        // let the target creep one deadzone at a time and never settle.
        const dzX = axisDeadzone(field.xAxis);
        const dzY = axisDeadzone(field.yAxis);
        if (Math.abs(this._wrappedGap(rawX, this._fieldTargetX, spanX)) > dzX) this._fieldTargetX = rawX;
        if (Math.abs(this._wrappedGap(rawY, this._fieldTargetY, spanY)) > dzY) this._fieldTargetY = rawY;

        // The first read snaps. Damping in from 0 would walk the blend up through every clip between the
        // origin and wherever the character actually is on the frame the state is entered.
        if (!this._fieldProbeSeeded) {
            this._fieldProbeSeeded = true;
            this._fieldX = this._fieldTargetX;
            this._fieldY = this._fieldTargetY;
            return;
        }

        // Wall-clock, not playback-scaled: `smoothing` is authored in seconds, and a state running at half
        // speed did not ask for twice the lag. See _frameDelta.
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

    /**
     * Damp each clip's weight towards what the field asked for, keeping departing clips alive until they are
     * negligible. Returns clipName -> damped weight; a clip below WEIGHT_EPSILON is dropped and forgotten.
     *
     * Duplicate clip names inside one field collapse into a single entry: the same Bone map cannot be posed at
     * two different weights, and it is the same motion either way.
     */
    private _dampFieldWeights(field: AnimationField, weights: FieldWeight[]): Map<string, number> {
        const targets = new Map<string, number>();
        for (const w of weights) targets.set(w.sample.clipName, (targets.get(w.sample.clipName) ?? 0) + w.weight);

        const seconds = weightSmoothing(field);
        const dt = this._frameDelta;   // wall-clock; see _frameDelta

        // The FIRST evaluation of a field must snap. Damping from an empty state means damping up from zero,
        // and a zero-weight pose is the bind pose — the character would unfold into its blend over the
        // smoothing time every time the state is entered.
        const seed = !this._fieldWeightsSeeded;
        this._fieldWeightsSeeded = true;

        if (seed || !this._fieldFiltering || seconds <= 0 || dt <= 0) {
            this._fieldWeightState = targets;
            return new Map(targets);
        }

        const next = new Map<string, number>();
        // The union of "what the field wants" and "what is still fading" — a clip missing from `targets` is
        // damped towards 0 rather than dropped, which is the entire point.
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

    /**
     * The dominant entry, switching only when a rival leads by a margin.
     *
     * Without the margin the identity flips every frame either side of a 50/50 crossing. That matters because
     * _currentAnimation decides which clip's event markers are live, so a flickering dominant fires markers
     * from two clips at once or drops both.
     */
    private _resolveFieldDominant(entries: FieldEntry[]): FieldEntry | null {
        if (entries.length === 0) { this._fieldDominant = null; return null; }

        let best: FieldEntry | null = null;
        for (const e of entries) if (!best || e.weight > best.weight) best = e;

        const held = this._fieldDominant ? entries.find(e => e.clipName === this._fieldDominant) ?? null : null;
        if (held && best && best.weight - held.weight < DOMINANT_SWITCH_MARGIN) return held;

        this._fieldDominant = best ? best.clipName : null;
        return best;
    }

    /**
     * Name a field clip the model does not have, once per clip name.
     *
     * The set is cleared when the field changes, so re-importing the model and fixing the mismatch lets the
     * warning fire again if it is still wrong — a diagnostic that only ever speaks once per session is one
     * you cannot use to check whether you fixed it.
     */
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

    /**
     * Pose every contributing clip at the shared phase, each scaled to its OWN length (no foot sliding) and
     * shifted by its own offset (so clips that start at different points in the gait line up).
     */
    private _poseFieldAt(entries: FieldEntry[], phase: number): void {
        for (const e of entries) {
            // Wrapped, not clamped: the offset moves a clip AROUND its cycle, so phase 0.9 with an offset of
            // 0.3 is 0.2 into the next lap, not held at the end.
            //
            // The comparison is STRICTLY greater, not a modulo. Phase 1.0 is a real terminal state — a field
            // that has finished its last loop parks there and holds its final frame, which is what an
            // exit-time transition waits on — and `1 % 1` is 0, which would snap that held pose back to the
            // first frame. With offsets in [0,1) and phase in [0,1], this keeps 1.0 meaning 1.0.
            let p = phase + e.phaseOffset;
            if (p > 1) p -= 1;
            for (const bone of e.bones.values()) bone.update(p * e.duration);
        }
    }

    /**
     * Weighted mix of several local transforms into one. ORDER-INDEPENDENT — that property is the point.
     *
     * This used to fold rotations with an incremental slerp against a running accumulator. That is not
     * commutative, and the entries it is handed are sorted by weight, so any two weights CROSSING reordered
     * the fold and moved the result. Measured on four plausible leg orientations: 0.119 degrees of change
     * from the swap alone, 0.267 degrees across all 24 orderings — every frame, on a bone near the root of
     * the limb, so it amplifies down the chain. A probe dithering on a tie line does exactly that.
     *
     * So: flatten every quaternion into ONE reference hemisphere, take the weighted sum, and normalize
     * (nlerp). Commutative, associative up to float rounding, and for the near-identical poses a blend space
     * mixes it lands ~0.07 degrees from the slerp fold — far inside the artefact it removes. Translation and
     * scale were already order-independent (a sequential affine lerp IS the exact weighted mean); they are
     * written as plain weighted sums here because that is now the obvious form.
     *
     * `reference` must be STABLE frame to frame. Using the first part, as an obvious implementation would,
     * reintroduces the bug at one remove: measured, that still leaves a 0.030 degree spread across orderings,
     * because which quaternion gets flipped then depends on which one happened to come first. Callers pass
     * the dominant clip's rotation, which has its own switch hysteresis.
     */
    private _mixTransforms(parts: { m: mat4; w: number }[], reference?: quat | null): mat4 {
        const result = mat4.create();
        if (parts.length === 0) return result;
        if (parts.length === 1) return mat4.copy(result, parts[0].m);

        const t = vec3.create();
        const s = vec3.create();
        const r = quat.create();

        // No caller-supplied reference: the heaviest part. Deterministic given the same set, whatever order
        // it arrives in. Its own SIGN does not matter — negating the reference negates every flip decision
        // and so negates the sum, and q and -q are the same rotation.
        let ref = reference ?? null;
        if (!ref) {
            let best: { m: mat4; w: number } | null = null;
            for (const part of parts) if (!best || part.w > best.w) best = part;
            ref = mat4.getRotation(quat.create(), (best ?? parts[0]).m);
        }

        const translation = vec3.create();
        const scale = vec3.create();
        const rotation = quat.create();   // starts at (0,0,0,0) — an accumulator, not a rotation yet
        quat.set(rotation, 0, 0, 0, 0);

        let total = 0;
        for (const part of parts) {
            if (part.w <= 0) continue;
            mat4.getTranslation(t, part.m);
            mat4.getScaling(s, part.m);
            mat4.getRotation(r, part.m);

            vec3.scaleAndAdd(translation, translation, t, part.w);
            vec3.scaleAndAdd(scale, scale, s, part.w);

            // Into the reference hemisphere. Without this a clip whose quaternion sits on the far side
            // cancels against the others instead of adding to them, and the limb sweeps through the body.
            const w = quat.dot(ref, r) < 0 ? -part.w : part.w;
            rotation[0] += r[0] * w;
            rotation[1] += r[1] * w;
            rotation[2] += r[2] * w;
            rotation[3] += r[3] * w;
            total += part.w;
        }

        if (total === 0) return mat4.copy(result, parts[0].m);
        vec3.scale(translation, translation, 1 / total);
        vec3.scale(scale, scale, 1 / total);

        // Exactly-opposed contributions can still sum to nothing, which would normalize to NaN and collapse
        // the skeleton. Unreachable once every part is in one hemisphere, but this is user data.
        if (quat.length(rotation) < 1e-8) quat.copy(rotation, ref);
        quat.normalize(rotation, rotation);

        mat4.fromRotationTranslationScale(result, rotation, translation, scale);
        return result;
    }

    /**
     * The field-blended local transform for a bone, or null when no contributing clip animates it.
     *
     * `dominantClip` names the entry whose rotation anchors the hemisphere. It is the clip
     * {@link _resolveFieldDominant} is holding, so it only changes when the dominant genuinely changes hands
     * — which is what keeps the mix stable while two weights trade places around a tie.
     */
    private _fieldLocal(entries: FieldEntry[] | null, boneName: string, dominantClip?: string | null): mat4 | null {
        if (!entries || entries.length === 0) return null;
        const parts: { m: mat4; w: number }[] = [];
        let reference: quat | null = null;
        for (const e of entries) {
            const bone = e.bones.get(boneName);
            if (!bone) continue;
            parts.push({ m: bone.localTransform, w: e.weight });
            // The dominant clip may not animate this bone; then there is no anchor and _mixTransforms falls
            // back to the heaviest part, which is deterministic for a fixed set of contributions.
            if (dominantClip && e.clipName === dominantClip) {
                reference = mat4.getRotation(quat.create(), bone.localTransform);
            }
        }
        if (parts.length === 0) return null;
        // Partial coverage (a bone only some contributing clips animate) is left to the caller's bind-pose
        // fallback rather than mixed against an implicit identity, which would drag the bone towards origin.
        return this._mixTransforms(parts, reference);
    }

    /** Local transform of a bone in the CURRENT pose source (field when one is active, else the clip). */
    private _currentLocal(boneName: string): mat4 | null {
        if (this._fieldEntries) return this._fieldLocal(this._fieldEntries, boneName, this._fieldDominant);
        return this._bones.get(boneName)?.localTransform ?? null;
    }

    /**
     * Local transform of a bone in the OUTGOING pose source during a cross-fade.
     *
     * No dominant clip is tracked for the outgoing side — its weights are a frozen snapshot taken when the
     * transition fired, so they cannot cross and the heaviest-part fallback is already stable.
     */
    private _previousLocal(boneName: string): mat4 | null {
        if (this._previousFieldEntries) return this._fieldLocal(this._previousFieldEntries, boneName, null);
        return this._previousBones.get(boneName)?.localTransform ?? null;
    }

    /**
     * Play a field directly, outside any state machine. The Animation Field editor's preview uses this;
     * at runtime a field is normally entered through a state (see _enterState).
     */
    public playField(field: AnimationField, x: number, y?: number, loop: boolean = true): void {
        this._fieldX = x;
        this._fieldY = y ?? 0;
        this._startField(field, undefined, loop, false);
    }

    /**
     * Swap in a new definition for the field already playing, WITHOUT restarting it.
     *
     * This is what the field editor calls as the user edits: moving a sample or an axis range has to change
     * the blend immediately, but going through playField would reset the phase and drop playback on every
     * drag — the model would twitch back to frame 0 instead of showing the edit take effect mid-stride.
     * Falls back to playField when nothing is playing yet.
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
     * Everything between a machine parameter and the pose, in one snapshot, for diagnosing a blend that will
     * not sit still.
     *
     * A field is a chain — parameter, deadbanded target, damped probe, weights, pose — and when it vibrates
     * the only question worth asking is WHICH LINK is moving. Reading them all at one instant answers it:
     * a raw value that jitters while the probe is calm means the noise is upstream in whatever writes the
     * parameter; a calm probe with restless weights means the field's own layout; both calm while the
     * character still shakes means the pose blend or the state machine.
     *
     * Read-only and allocated per call — this is a debug surface, not a per-frame path.
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
         * Every live machine parameter, whatever the current state plays.
         *
         * The field rows above only cover the two parameters bound to the AXES, and those are exactly the ones
         * that are innocent when a machine is ping-ponging: what drives a state change is a parameter on a
         * transition CONDITION, which may be none of them. Without these, a machine flipping in and out of its
         * field state shows a flip counter with nothing to explain it.
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
        return sm.states.find(s => s.name === this._currentStateName) ?? null;
    }

    /**
     * Update animation state
     */
    public update(deltaTime: number): void {
        // Ragdoll takes over: drive bones from physics bodies, skip all animation.
        if (this._ragdollActive) {
            this._updateRagdollMatrices();
            return;
        }

        // Dwell is counted here, above every early return, because a state whose clip has finished sets
        // _playing false — and the returns below would then freeze the clock a minDwell gate is waiting on,
        // locking the machine into that state permanently.
        if (deltaTime > 0) this._stateTime += deltaTime;
        // Same reasoning, and the same placement: the ping-pong window must keep time even when the pose path
        // below bails out, or a machine bouncing between two finished clips measures its own rate as infinite.
        if (deltaTime > 0) this._animatorClock += deltaTime;

        // Calculate speed if node is available.
        //
        // Prefer the measured speed of the nearest ancestor that owns a body. The fallback below measures
        // this._node.position — a LOCAL offset — which is pinned at 0 for the standard character rig
        // (a `Model` child sitting at a fixed offset under a moving `Playable` root), so the 'speed' trigger
        // could never fire on exactly the hierarchy the engine's own example recommends.
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
            // Advance the shared normalized PHASE, then project it onto the weighted duration — never the
            // other way round. The weighted duration moves as the blend shifts (a walk is longer than a run),
            // so deriving the phase from a wall-clock time would jog the pose every time the probe moved.
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
                // _loopLimit is a count of PLAYS, so the pass just finished counts: a limit of 1 stops here, and 0
                // means forever. Once the budget is spent the clip holds its last frame, same as a non-looping one,
                // which is what an exit-time transition is waiting on.
                if (this._loop && (this._loopLimit === 0 || this._loopsPlayed < this._loopLimit)) {
                    this._currentTime = this._currentTime % duration;
                    looped = true;
                } else {
                    this._currentTime = duration;
                    this._playing = false;
                    // Finish any blend still in flight. From here on the guard at the top of update() returns
                    // early, so _currentBlendTime would never reach _activeBlendTime and the pose would be stuck
                    // at a partial mix forever — reachable whenever a clip is shorter than the blend.
                    this._finishBlend();
                }
            }
        }

        // Fire any animation-event markers crossed this frame.
        //
        // A field's _currentTime is `phase * weightedDuration`, and the duration moves with the weights — so
        // it is NOT monotonic, and comparing this frame's value against the last frame's can step backwards
        // (dropping every marker in between) or leap forwards (firing markers the animation never reached).
        // Both phases are projected through the SAME duration instead, which is monotonic by construction.
        if (this._fieldEntries) {
            this._fireDueEvents(this._prevFieldPhase * duration, this._fieldPhase * duration, duration, looped);
        } else {
            this._fireDueEvents(prevTime, this._currentTime, duration, looped);
        }

        // Update all bones with current animation time
        if (this._fieldEntries) {
            this._poseFieldAt(this._fieldEntries, this._fieldPhase);
        } else {
            for (const bone of this._bones.values()) {
                bone.update(this._currentTime);
            }
            // Root motion runs AFTER the pose loop: it drives the character by this frame's root delta, then
            // overwrites the root bone's just-posed transform with the locked reference so the mesh stays put.
            if (this._rootMotionActive) this._applyRootMotion(prevTime, this._currentTime, duration, looped);
        }

        // If blending, also update the previous pose source. The outgoing motion keeps playing under the
        // cross-fade — freezing it leaves the fading-out legs stopped mid-stride for the whole blend.
        if (this._isBlending && this._previousFieldEntries) {
            if (this._previousAdvancing) {
                const previousDuration = this._fieldDuration(this._previousFieldEntries);
                if (previousDuration > 0) this._previousFieldPhase += this._deltaTime / previousDuration;
                if (this._previousFieldPhase >= 1) {
                    this._previousFieldPhase = this._previousLoop ? this._previousFieldPhase % 1 : 1;
                }
            }
            // The outgoing field keeps its own weights: it is a snapshot of the mix at the moment the
            // transition fired, not something the (now irrelevant) probe should keep steering.
            this._poseFieldAt(this._previousFieldEntries, this._previousFieldPhase);
        } else if (this._isBlending && this._previousAnimation) {
            if (this._previousAdvancing) {
                const previousDuration = this._getPreviousAnimationDuration();
                this._previousTime += this._deltaTime;
                if (this._previousTime >= previousDuration) {
                    // Only a looping clip wraps. A non-looping one holds its end — wrapping it would restart
                    // the outgoing clip underneath the blend.
                    this._previousTime = this._previousLoop ? this._previousTime % previousDuration : previousDuration;
                }
            }
            // Not advancing = the clip had already finished before the blend began; it holds its last pose,
            // which is what a Jump landing cross-fades away from.
            for (const bone of this._previousBones.values()) {
                bone.update(this._previousTime);
            }
        }

        // Turn the current bone local transforms into final skinning matrices.
        this._recomputePose();
    }

    // ---- Root motion -----------------------------------------------------------------------------

    /**
     * Arm (or disarm) root motion for the clip that just started. Finds the clip's root bone and captures the
     * pose the extraction will lock the mesh to. Disarms when the clip carries no root motion or has no root.
     */
    private _setupRootMotion(animation: Animation): void {
        this._rootMotionActive = false;
        this._rootBoneName = null;
        if (!animation.rootMotion) return;

        const rootName = this._findRootMotionBone(animation);
        const bone = rootName ? this._bones.get(rootName) : null;
        if (!bone) return;

        const ref = bone.sampleTR(0);
        vec3.copy(this._rootRefT, ref.t);
        quat.copy(this._rootRefR, ref.r);
        // The root bone's animation channels rarely touch scale; take it from the bind pose so the locked
        // matrix reproduces the rig's own scale rather than a bare 1.
        vec3.set(this._rootRefS, 1, 1, 1);
        const rest = this._skin?.nodeTransforms?.get(bone.id);
        if (rest) mat4.getScaling(this._rootRefS, rest);

        this._rootParentRot = this._rootParentRotation(bone.id);
        this._rootBoneName = rootName;
        this._rootMotionActive = true;
    }

    /**
     * Accumulated rotation of the joints ABOVE `rootNodeIndex` in the skin, in the model node's local space:
     * `topLocal * … * immediateParentLocal`. These joints are static (the extraction bone is the HIGHEST
     * animated one), so their bind transforms are their live transforms. This is the axis basis the root
     * bone's channels are expressed in.
     */
    private _rootParentRotation(rootNodeIndex: number): quat {
        const out = quat.create();
        if (!this._skin) return out;
        const parentOf = this._topology().parentNodeOfNode;

        const chain: number[] = []; // immediate parent first, up to the skeleton root
        let p = parentOf.get(rootNodeIndex);
        while (p !== undefined) { chain.push(p); p = parentOf.get(p); }

        const acc = mat4.create(); // identity
        for (let i = chain.length - 1; i >= 0; i--) {
            const local = this._skin.nodeTransforms?.get(chain[i]);
            if (local) mat4.multiply(acc, acc, local);
        }
        mat4.getRotation(out, acc);
        return quat.normalize(out, out);
    }

    /**
     * The bone name of the clip's root-motion bone: the HIGHEST joint this clip actually animates (one whose
     * ancestors are all un-animated). That handles both a rig whose root bone carries the motion and the
     * common "static Armature → animated Hips" layout, where the structural skeleton root has no channels.
     * Returns null when the clip animates no joints (nothing to extract).
     */
    private _findRootMotionBone(animation: Animation): string | null {
        if (!this._skin) return null;
        const animated = new Set(animation.channels.map(c => c.targetNodeIndex));
        const parentOf = this._topology().parentNodeOfNode;

        const isHighestAnimated = (nodeIndex: number): boolean => {
            let p = parentOf.get(nodeIndex);
            while (p !== undefined) {
                if (animated.has(p)) return false;
                p = parentOf.get(p);
            }
            return true;
        };

        // Prefer the declared skeleton root when the clip animates it directly.
        const skel = this._skin.skeleton;
        if (skel !== undefined && animated.has(skel) && isHighestAnimated(skel)) return `bone_${skel}`;
        for (const j of this._skin.joints) {
            if (animated.has(j.nodeIndex) && isHighestAnimated(j.nodeIndex)) return `bone_${j.nodeIndex}`;
        }
        return null;
    }

    /**
     * Apply this frame's root-bone delta to the character, then lock the root bone in place.
     *
     * The delta is the change in the root bone's LOCAL transform between the previous and current times; on a
     * loop wrap it is composed across the seam so a cycling clip advances smoothly instead of snapping back.
     * That local delta is expressed in the root bone's own axis basis, so it is first brought into WORLD space
     * through `Wp = nodeWorldRotation · armatureParentRotation` — the node's orientation and the static
     * armature above the bone (which carries any authoring→engine axis conversion). Skipping the armature part
     * is what makes a yaw come out as a roll: the "wrong axis" bug. The resulting world delta then drives the
     * nearest bodied ancestor (else the model node), whose parent is unrotated so its own transform is world.
     * Finally the root bone is pinned to the clip-start reference so the mesh does not double-move.
     */
    private _applyRootMotion(prevTime: number, curTime: number, duration: number, looped: boolean): void {
        const bone = this._rootBoneName ? this._bones.get(this._rootBoneName) : null;
        if (!bone) return;

        const deltaT = vec3.create();
        const deltaR = quat.create();
        const cur = bone.sampleTR(curTime);
        const prev = bone.sampleTR(prevTime);

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

        const target = this._nearestBodiedNode() ?? this._node;
        if (target) {
            // Wp = the world basis the bone's local delta lives in: the model node's world rotation composed
            // with the static armature above the bone. Rotate the translation by it, and CONJUGATE the rotation
            // by it so a yaw about the armature's up-axis becomes a yaw about world up rather than a roll.
            const wp = quat.multiply(
                quat.create(),
                this._node ? this._node.worldQuaternion : quat.create(),
                this._rootParentRot);
            quat.normalize(wp, wp);
            const wpInv = quat.invert(quat.create(), wp);

            const worldT = vec3.transformQuat(vec3.create(), deltaT, wp);
            target.setPosition(vec3.add(vec3.create(), target.position, worldT));

            // World-space rotation delta, so it LEFT-multiplies the target's (world = local) orientation.
            const worldR = quat.multiply(quat.create(), quat.multiply(quat.create(), wp, deltaR), wpInv);
            const newQ = quat.normalize(quat.create(), quat.multiply(quat.create(), worldR, target.quaternion));
            target.setQuaternion(newQ);
            // setQuaternion deliberately does not push into the body (see Node), so a bodied target's physics
            // orientation must be set explicitly. setPosition already pushed the translation.
            if (target.body) target.body.setQuaternion(newQ);
        }

        // Pin the root bone to its start pose: the character carries the motion, the mesh renders in place.
        const locked = mat4.create();
        mat4.fromRotationTranslationScale(locked, this._rootRefR, this._rootRefT, this._rootRefS);
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

    /**
     * This skin's topology, built once and rebuilt only if the skin itself is swapped.
     *
     * Keyed on the Skin OBJECT rather than a dirty flag: a skin's hierarchy is fixed once it is parsed, so
     * identity is the whole invalidation rule, and it cannot go stale behind a model change.
     */
    private _topology(): SkeletonTopology {
        if (!this._topologyCache || this._topologySkin !== this._skin) {
            this._topologySkin = this._skin;
            this._topologyCache = skeletonTopology(this._skin!);
            // A different skeleton means different joints, so the damped IK state describes bones that may no
            // longer exist — including the remembered ground each of them last stood on. Keyed off the same
            // identity check for the same reason the topology is.
            this._ikFootWeights.clear();
            this._ikFootHits.clear();
            this._ikHipOffset = 0;
        }
        return this._topologyCache;
    }

    /**
     * Recompute _finalBoneMatrices from the bones' current local transforms.
     * Split out of update() so seek() can pose the skeleton at an arbitrary time
     * without advancing time or running trigger logic.
     */
    private _recomputePose(): void {
        if (!this._skin) return;

        // Build local transforms map for all joints
        const localTransforms = new Map<number, mat4>();
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const nodeIndex = joint.nodeIndex;
            const boneName = `bone_${nodeIndex}`;
            // Whichever source is posing this bone — a single clip or a weighted field blend.
            const current = this._currentLocal(boneName);

            if (current) {
                const previous = this._isBlending ? this._previousLocal(boneName) : null;
                if (previous) {
                    // Blend between previous and current animation
                    // A zero blend duration is legal (the setter clamps to >= 0, not > 0) and would divide to
                    // NaN here, which slerps into NaN quaternions and collapses the skeleton. It means
                    // "instant", so read it as fully blended.
                    const blendFactor = this._activeBlendTime > 0
                        ? Math.min(this._currentBlendTime / this._activeBlendTime, 1.0)
                        : 1.0;
                    const blendedTransform = this._blendTransforms(previous, current, blendFactor);
                    localTransforms.set(nodeIndex, blendedTransform);
                } else {
                    // Use animated transform
                    localTransforms.set(nodeIndex, current);
                }
            } else {
                // Use initial node transform from GLTF, or identity if not available
                const initialTransform = this._skin.nodeTransforms?.get(nodeIndex);
                localTransforms.set(nodeIndex, initialTransform ? initialTransform : mat4.create());
            }
        }

        // Accumulate global transforms down the hierarchy.
        //
        // A flat loop in topological order, not the memoized recursion this used to be. The recursion looked
        // up each joint's parent with `joints.find(...)` — a linear scan, inside the recursion, per joint, per
        // frame. The topology answers that in a map, and its `order` guarantees a parent is finished before
        // any child asks for it.
        const topo = this._topology();
        const globalTransforms = new Map<number, mat4>();

        // The global of a node that is NOT a joint: a skin's root is routinely parented to an armature or an
        // empty, whose transform still applies. Such a node has no animated local, so it resolves straight to
        // its rest transform exactly as the old recursion's fallback did.
        const outsideSkin = (nodeIndex: number): mat4 => {
            let m = globalTransforms.get(nodeIndex);
            if (m) return m;
            // CLONED, never the skin's own matrix. `globalTransforms` is written in place — by the
            // re-accumulation loop and by the IK pass's _rotateGlobal — so caching the rest transform by
            // reference would let a solve write into `nodeTransforms`, which is the bind-pose fallback for
            // every unanimated joint and the source `_setTPose` reads. The corruption would accumulate every
            // frame and survive as long as the model does.
            const rest = this._skin!.nodeTransforms?.get(nodeIndex);
            m = rest ? mat4.clone(rest) : mat4.create();
            globalTransforms.set(nodeIndex, m);
            return m;
        };

        for (const jointIndex of topo.order) {
            const joint = this._skin.joints[jointIndex];
            const nodeIndex = joint.nodeIndex;
            const local = localTransforms.get(nodeIndex) ?? this._skin.nodeTransforms?.get(nodeIndex) ?? mat4.create();

            const parentNode = topo.parentNode[jointIndex];
            const global = mat4.create();
            if (parentNode === undefined) {
                mat4.copy(global, local);
            } else {
                const parentJoint = topo.parentJoint[jointIndex];
                const parentGlobal = parentJoint >= 0
                    ? globalTransforms.get(this._skin.joints[parentJoint].nodeIndex)!
                    : outsideSkin(parentNode);
                mat4.multiply(global, parentGlobal, local);
            }
            globalTransforms.set(nodeIndex, global);
        }

        // Foot IK, if this skeleton has a rig and anything is holding it up. Placed HERE — after the pose is
        // fully accumulated, before the bind matrices are folded in — because it needs to know where the feet
        // actually ended up, and because writing corrected LOCALS lets the accumulation loop above be re-run
        // verbatim to carry the change down to every descendant.
        if (this._applyFootIk(localTransforms, globalTransforms, topo)) {
            for (const jointIndex of topo.order) {
                const joint = this._skin.joints[jointIndex];
                const nodeIndex = joint.nodeIndex;
                const local = localTransforms.get(nodeIndex)!;
                const parentNode = topo.parentNode[jointIndex];
                const global = globalTransforms.get(nodeIndex)!;
                if (parentNode === undefined) {
                    mat4.copy(global, local);
                } else {
                    const parentJoint = topo.parentJoint[jointIndex];
                    const parentGlobal = parentJoint >= 0
                        ? globalTransforms.get(this._skin.joints[parentJoint].nodeIndex)!
                        : outsideSkin(parentNode);
                    mat4.multiply(global, parentGlobal, local);
                }
            }
        }

        // Calculate final bone matrices: finalMatrix = globalTransform × inverseBindMatrix
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const globalTransform = globalTransforms.get(joint.nodeIndex) ?? mat4.create();
            mat4.multiply(this._finalBoneMatrices[jointIndex], globalTransform, joint.inverseBindMatrix);
        }
    }

    // ---- Foot IK ----------------------------------------------------------------------------------
    //
    // Plant each foot on whatever is under it, and lower the pelvis when a leg cannot reach. Runs against the
    // MODEL-space pose inside _recomputePose; the ground query is a world-space raycast, so the hit comes back
    // through inverse(node.worldTransform).
    //
    // Everything here is a no-op without a rig, without physics, or at zero weight — which is what makes this
    // "runtime only" without needing a flag: an editor scene has no live physics, so the ray never hits and
    // the pass costs one map lookup.

    /**
     * The IK weight this frame: the current state's, or the parameter it names.
     *
     * A missing parameter keeps the static weight rather than reading 0 — a dangling reference should not
     * silently disable the feature, the same reasoning as _applyStateSpeed.
     */
    private _stateIkWeight(): number {
        const sm = this._stateMachine;
        const state = sm && this._currentStateName
            ? sm.states.find(s => s.name === this._currentStateName)
            : null;
        if (!state) return 1;
        if (state.ikWeightParam) {
            const v = this._paramValues.get(state.ikWeightParam);
            if (typeof v === 'number') return clamp(v, 0, 1);
            if (typeof v === 'boolean') return v ? 1 : 0;
        }
        return typeof state.ikWeight === 'number' ? clamp(state.ikWeight, 0, 1) : 1;
    }

    /**
     * The rig's usable chains, validated once per rig object and reported once.
     *
     * Keyed on the rig's identity rather than a dirty flag, for the same reason the topology is: a rig is
     * replaced wholesale when it is edited, so identity IS the invalidation rule. The warning fires on the
     * first frame a bad rig is seen and then stays quiet — a per-frame flood would bury the one line that
     * says what is wrong.
     */
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

    /**
     * Solve foot placement into `localTransforms`. Returns true when anything changed, which is the caller's
     * signal to re-accumulate.
     *
     * The governing idea is a STANCE/SWING split: IK owns a foot that is on the ground and the animation owns
     * one that is in the air. It is not "plant every foot on whatever the ray found" — the ray reaches further
     * down than a stride lifts, so that would drag every swing back to the floor and fight the animation.
     * Which feet count as planted is decided in pass 1b, and it needs every foot's clearance, which is why the
     * work is split across passes rather than done per foot.
     *
     * Known limitation: during a true flight phase (both feet airborne but still within `traceDown`) the lower
     * foot becomes the reference and keeps its correction. That is left to the two mechanisms that already
     * exist for it — `traceDown`, and an `ikWeightParam` bound to a grounded flag — rather than a third knob.
     */
    private _applyFootIk(
        localTransforms: Map<number, mat4>,
        globalTransforms: Map<number, mat4>,
        topo: SkeletonTopology,
    ): boolean {
        const rig = this._skin?.ikRig;
        if (!rig || !rig.feet?.length || !this._node) return false;

        const physics = this._node.scene?.physics;
        if (!physics) return false;

        // Only the chains the skeleton actually supports. A rig can name the right bones and still not
        // describe a leg — three bones from unrelated parts of the rig solve to a pose with no relation to
        // the character, which on screen is a thrash rather than an obvious error. Cached per rig object,
        // since it is pure and the rig only changes when someone edits it.
        const checked = this._validatedRig(rig, topo);
        if (checked.feet.length === 0) return false;

        const weight = this._stateIkWeight();
        const tuning = ikTuning(rig);
        // dt is 0 on a seek/scrub, which must not advance the smoothing — but the targets still resolve, so a
        // scrubbed pose is the settled one rather than whatever the last played frame left behind.
        //
        // Wall-clock, not playback-scaled: a foot easing onto a step is reacting to the ground, not playing an
        // animation, so a slowed-down (or speed-0) state must not slow down or freeze the ease. See _frameDelta.
        const dt = this._frameDelta;

        const nodeWorld = this._node.worldTransform;
        const worldToModel = mat4.create();
        // A degenerate world transform (a zero scale on some axis) has no inverse and nothing sensible to
        // place a foot against.
        if (!mat4.invert(worldToModel, nodeWorld)) return false;
        // Gravity-up in MODEL space. Direction, not position, so translation is dropped — and it is
        // renormalized because a scaled character's model space is not metric.
        const upWorld = physics.up;
        const up = vec3.transformMat4(vec3.create(), upWorld, worldToModel);
        const originModel = vec3.transformMat4(vec3.create(), vec3.create(), worldToModel);
        vec3.sub(up, up, originModel);
        if (vec3.length(up) < 1e-8) return false;
        vec3.normalize(up, up);

        const ownBody = this._nearestBodiedNode()?.body ?? null;

        // ---- Pass 1a: where does each foot want to be? -------------------------------------------------
        //
        // Only where it WANTS to be. Whether it should actually go there is pass 1b's job: a foot the
        // animation has lifted mid-stride still finds ground under it (traceDown reaches further than a stride
        // lifts), and planting it there would destroy the swing. That decision needs every foot's clearance,
        // so it cannot be made inside this loop.
        type FootPlan = {
            chain: IkFootChain;
            ankle: vec3;         // model space, as animated
            target: vec3;        // model space, on the ground
            normal: vec3;        // model space, of the surface
            weight: number;      // this foot's damped contribution
            /** Signed distance from the animated ankle to its target along `up`. Negative = the foot must drop. */
            along: number;
        };
        const plans: FootPlan[] = [];

        for (const chain of checked.feet) {
            // A half-assigned chain is normal while authoring; skip it rather than throwing.
            const ankleGlobal = globalTransforms.get(chain.foot);
            if (!ankleGlobal || !globalTransforms.get(chain.thigh) || !globalTransforms.get(chain.shin)) continue;

            const ankle = mat4.getTranslation(vec3.create(), ankleGlobal);
            const ankleWorld = vec3.transformMat4(vec3.create(), ankle, nodeWorld);

            const from = vec3.scaleAndAdd(vec3.create(), ankleWorld, upWorld, tuning.traceUp);
            const to = vec3.scaleAndAdd(vec3.create(), ankleWorld, upWorld, -tuning.traceDown);
            const hit = physics.raycast(from, to, { ignore: ownBody });

            const key = chain.foot;
            const prev = this._ikFootWeights.get(key) ?? 0;
            // No ground under this foot: it fades out rather than switching off, or a foot crossing the lip
            // of a ledge would snap between placed and un-placed on consecutive frames.
            const target = hit ? weight : 0;
            const next = tuning.smoothing > 0 && dt > 0 ? dampTime(prev, target, tuning.smoothing, dt) : target;
            this._ikFootWeights.set(key, next);

            // Fading OUT needs somewhere to fade to. The decaying weight above is not enough on its own —
            // with no hit there is no target to ease towards, so the correction would simply be absent on the
            // frame the ray first misses, which is the pop the damping exists to prevent. The remembered
            // surface drifts as the character moves, but the drift is largest exactly where the weight is
            // smallest, so their product stays negligible.
            if (hit) {
                this._ikFootHits.set(key, {
                    point: vec3.clone(hit.point),
                    normal: vec3.clone(hit.normal),
                });
            }
            const ground = this._ikFootHits.get(key);
            if (!ground || next <= 1e-3) {
                // Spent: drop the memory rather than leave a stale point to be resurrected after a teleport.
                this._ikFootHits.delete(key);
                continue;
            }

            const hitModel = vec3.transformMat4(vec3.create(), ground.point, worldToModel);
            const normalModel = vec3.transformMat4(vec3.create(), ground.normal, worldToModel);
            vec3.sub(normalModel, normalModel, originModel);
            if (vec3.length(normalModel) > 1e-8) vec3.normalize(normalModel, normalModel);

            // The ankle sits a foot's height above the sole; without that the ankle itself lands on the
            // ground and the whole foot sinks through it.
            const desired = vec3.scaleAndAdd(vec3.create(), hitModel, up, tuning.footHeight);
            const along = vec3.dot(vec3.sub(vec3.create(), desired, ankle), up);

            plans.push({ chain, ankle, target: desired, normal: normalModel, weight: next, along });
        }

        // ---- Pass 1b: let go of the feet that are mid-swing --------------------------------------------
        //
        // `-along` is a foot's CLEARANCE: how far the animated ankle sits above where it would be planted.
        // Measured against the lowest foot rather than absolutely, because absolutely it says nothing — a foot
        // 0.3 above its ground is mid-stride if the other foot is down, and is a character standing on ground
        // 0.3 lower than the animation assumed if the other foot is up there too. The first wants releasing,
        // the second wants the whole pelvis lowered, and only the other foot distinguishes them.
        //
        // A one-legged rig, or a frame where only one foot has a plan, makes that foot its own reference and
        // so keeps the full correction. That is the honest answer: with one foot there is no evidence about
        // what "planted" means.
        let ref = Infinity;
        for (const plan of plans) ref = Math.min(ref, -plan.along);
        // Clamped at 0 so a foot THROUGH the ground (negative clearance) cannot lift the reference and release
        // the other leg, which is properly planted.
        ref = plans.length ? Math.max(0, ref) : 0;

        for (const plan of plans) {
            plan.weight *= swingReleaseWeight(-plan.along - ref, tuning.swingRelease);
        }
        // A released foot must not merely be solved towards nothing — it must not be solved at all.
        // `solveTwoBone` clamps the target distance to `maxReach`, so even an identity solve pulls a straight
        // leg in by a couple of millimetres. Same reason the weight guard above exists.
        const active = plans.filter(p => p.weight > 1e-3);

        // The deepest a foot needs to go, in model units along -up, WEIGHTED by how much of that foot's
        // correction is actually being applied. Unweighted, a swing foot dominates this — its clearance is the
        // largest of any foot — and the pelvis dips by the stride's lift height once per step even though the
        // foot it is dipping for has been let go.
        let lowest = 0;
        for (const plan of active) lowest = Math.min(lowest, Math.min(0, plan.along) * plan.weight);

        // ---- Pass 2: lower the pelvis ------------------------------------------------------------------
        //
        // Only ever DOWN. A foot that needs to rise is a step the knee can bend for; a foot that needs to drop
        // may be out of the leg's reach, and dropping the pelvis is the only way to keep it planted without
        // the character doing the splits.
        //
        // With NO foot on the ground the target is 0 — and this deliberately does not return early, because
        // the pelvis may still be lowered from when a foot was down. It has to RISE back over the smoothing
        // time, which means going on applying the decaying offset below. Returning here instead would drop
        // the character to its animated pose in one frame at the exact moment IK is meant to be invisible,
        // and leave the stale offset to resume from on landing.
        const hipTarget = active.length > 0 ? Math.max(-tuning.maxHipDrop, Math.min(0, lowest)) : 0;
        this._ikHipOffset = tuning.smoothing > 0 && dt > 0
            ? dampTime(this._ikHipOffset, hipTarget, tuning.smoothing, dt)
            : hipTarget;
        // Snap the tail of the exponential to zero so a released pelvis stops costing a re-accumulation.
        if (Math.abs(this._ikHipOffset) < 1e-5) this._ikHipOffset = 0;

        if (active.length === 0 && this._ikHipOffset === 0) return false;

        const hipsLocal = checked.hips !== undefined ? localTransforms.get(checked.hips) : undefined;
        if (hipsLocal && this._ikHipOffset !== 0) {
            // Applied to the hips' LOCAL translation, in the parent's space — so it travels down the whole
            // skeleton through the ordinary accumulation instead of needing every descendant patched.
            const hipsJoint = topo.jointOfNode.get(checked.hips!);
            const parentJoint = hipsJoint !== undefined ? topo.parentJoint[hipsJoint] : -1;
            const shift = vec3.scale(vec3.create(), up, this._ikHipOffset);
            if (parentJoint >= 0) {
                const parentGlobal = globalTransforms.get(this._skin!.joints[parentJoint].nodeIndex);
                if (parentGlobal) {
                    const inv = mat4.create();
                    mat4.invert(inv, parentGlobal);
                    // A direction, so the parent's translation must not come with it.
                    const o = vec3.transformMat4(vec3.create(), vec3.create(), inv);
                    vec3.transformMat4(shift, shift, inv);
                    vec3.sub(shift, shift, o);
                }
            }
            const moved = mat4.clone(hipsLocal);
            moved[12] += shift[0]; moved[13] += shift[1]; moved[14] += shift[2];
            localTransforms.set(checked.hips!, moved);

            // Re-accumulate so the leg solve below sees where the feet actually are AFTER the drop.
            this._reaccumulate(localTransforms, globalTransforms, topo);
        }

        // ---- Pass 3: solve each leg --------------------------------------------------------------------
        for (const plan of active) {
            this._solveLeg(plan.chain, plan.target, plan.normal, plan.weight, up, tuning,
                localTransforms, globalTransforms, topo);
        }
        return true;
    }

    /** Re-run the parent-to-child accumulation in place. Cheap: one matrix multiply per joint. */
    private _reaccumulate(
        localTransforms: Map<number, mat4>,
        globalTransforms: Map<number, mat4>,
        topo: SkeletonTopology,
    ): void {
        for (const jointIndex of topo.order) {
            const nodeIndex = this._skin!.joints[jointIndex].nodeIndex;
            const local = localTransforms.get(nodeIndex);
            const global = globalTransforms.get(nodeIndex);
            if (!local || !global) continue;
            const parentJoint = topo.parentJoint[jointIndex];
            if (parentJoint < 0) {
                const parentNode = topo.parentNode[jointIndex];
                // A self-parented joint is a one-node cycle, which skeletonTopology reports as a root while
                // leaving parentNode pointing at the joint itself. Multiplying its global by its own global
                // SQUARES the transform — and a leg solve re-accumulates up to eight times a frame, so it
                // compounds instead of merely being wrong once. _recomputePose's own loops dodge this by
                // branching on `undefined`; this one has to check identity as well.
                const parentGlobal = parentNode !== undefined && parentNode !== nodeIndex
                    ? globalTransforms.get(parentNode)
                    : undefined;
                if (parentGlobal) mat4.multiply(global, parentGlobal, local);
                else mat4.copy(global, local);
            } else {
                mat4.multiply(global, globalTransforms.get(this._skin!.joints[parentJoint].nodeIndex)!, local);
            }
        }
    }

    /**
     * Bend one leg onto its target and roll the foot onto the surface.
     *
     * Each step writes a LOCAL and re-accumulates before the next reads a global, so every stage sees the
     * result of the one before it — the same discipline the skeleton itself uses.
     */
    private _solveLeg(
        chain: IkFootChain,
        target: vec3,
        normal: vec3,
        weight: number,
        up: vec3,
        tuning: ReturnType<typeof ikTuning>,
        localTransforms: Map<number, mat4>,
        globalTransforms: Map<number, mat4>,
        topo: SkeletonTopology,
    ): void {
        const posOf = (node: number): vec3 | null => {
            const g = globalTransforms.get(node);
            return g ? mat4.getTranslation(vec3.create(), g) : null;
        };

        const hip = posOf(chain.thigh), knee = posOf(chain.shin), ankle = posOf(chain.foot);
        if (!hip || !knee || !ankle) return;

        // Ease towards the target by the foot's weight rather than snapping to it. This is where a partially
        // faded foot lives, and where ikWeight = 0 becomes exactly the animated pose.
        const eased = vec3.lerp(vec3.create(), ankle, target, weight);

        const solve = solveTwoBone({ root: hip, mid: knee, tip: ankle, target: eased });
        this._rotateGlobal(chain.thigh, solve.rootDelta, localTransforms, globalTransforms, topo);
        this._reaccumulate(localTransforms, globalTransforms, topo);
        this._rotateGlobal(chain.shin, solve.midDelta, localTransforms, globalTransforms, topo);
        this._reaccumulate(localTransforms, globalTransforms, topo);

        // Roll the foot onto the surface. Clamped: past maxSlope, matching the ground stops reading as
        // contact and starts reading as a broken ankle, so the foot keeps its animated orientation instead.
        const slope = Math.acos(clamp(vec3.dot(normal, up), -1, 1)) * 180 / Math.PI;
        if (slope > 1e-3 && slope <= tuning.maxSlopeDeg) {
            const align = quat.rotationTo(quat.create(), up, normal);
            // Scaled by weight, so a fading foot un-rolls as smoothly as it un-plants.
            const partial = quat.slerp(quat.create(), quat.create(), align, weight);
            this._rotateGlobal(chain.foot, partial, localTransforms, globalTransforms, topo);
            this._reaccumulate(localTransforms, globalTransforms, topo);

            // The toe inherited the foot's roll; counter-rotate it so the ball stays flat on the surface
            // rather than being levered off it by the ankle.
            if (chain.toe !== undefined && globalTransforms.has(chain.toe)) {
                const counter = quat.invert(quat.create(), partial);
                const half = quat.slerp(quat.create(), quat.create(), counter, 0.5);
                this._rotateGlobal(chain.toe, half, localTransforms, globalTransforms, topo);
                this._reaccumulate(localTransforms, globalTransforms, topo);
            }
        }
    }

    /**
     * Apply a MODEL-space rotation to one joint by rewriting its local transform.
     *
     * The delta is expressed in model space (that is the space the solver worked in), so it is applied to the
     * joint's global and then brought back through the parent — `local = inverse(parentGlobal) * newGlobal`.
     * Writing the local rather than the global is what lets one re-accumulation carry the change to every
     * descendant instead of each caller patching its own subtree.
     */
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
        const origin = mat4.getTranslation(vec3.create(), global);
        const rot = mat4.fromQuat(mat4.create(), delta);
        const around = mat4.create();
        mat4.fromTranslation(around, origin);
        mat4.multiply(around, around, rot);
        mat4.translate(around, around, vec3.negate(vec3.create(), origin));

        const newGlobal = mat4.multiply(mat4.create(), around, global);

        const jointIndex = topo.jointOfNode.get(nodeIndex);
        const parentJoint = jointIndex !== undefined ? topo.parentJoint[jointIndex] : -1;
        const parentNode = jointIndex !== undefined ? topo.parentNode[jointIndex] : undefined;
        const parentGlobal = parentJoint >= 0
            ? globalTransforms.get(this._skin!.joints[parentJoint].nodeIndex)
            : parentNode !== undefined ? globalTransforms.get(parentNode) : undefined;

        const local = mat4.create();
        if (parentGlobal) {
            const inv = mat4.create();
            mat4.invert(inv, parentGlobal);
            mat4.multiply(local, inv, newGlobal);
        } else mat4.copy(local, newGlobal);
        localTransforms.set(nodeIndex, local);
        mat4.copy(global, newGlobal);
    }

    /**
     * Pose the skeleton at an explicit time on the current animation (for editor scrubbing).
     * Does not change play/pause state and does not advance time on its own.
     */
    public seek(time: number): void {
        if (this._ragdollActive || !this._skin) return;
        if (!this._currentAnimation && !this._fieldEntries) return;
        const duration = this._getAnimationDuration();
        this._currentTime = Math.max(0, Math.min(time, duration));
        this._isBlending = false;
        if (this._fieldEntries) {
            // The field's clock is its normalized phase; the seconds the caller passed are only meaningful
            // relative to the current weighted duration.
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

    /**
     * Blend between two transformation matrices
     */
    private _blendTransforms(from: mat4, to: mat4, factor: number): mat4 {
        // Decompose both matrices into translation, rotation, and scale
        const fromTranslation = vec3.create();
        const fromRotation = quat.create();
        const fromScale = vec3.create();
        mat4.getTranslation(fromTranslation, from);
        mat4.getRotation(fromRotation, from);
        mat4.getScaling(fromScale, from);
        
        const toTranslation = vec3.create();
        const toRotation = quat.create();
        const toScale = vec3.create();
        mat4.getTranslation(toTranslation, to);
        mat4.getRotation(toRotation, to);
        mat4.getScaling(toScale, to);
        
        // Interpolate each component
        const blendedTranslation = vec3.create();
        const blendedRotation = quat.create();
        const blendedScale = vec3.create();
        
        vec3.lerp(blendedTranslation, fromTranslation, toTranslation, factor);
        quat.slerp(blendedRotation, fromRotation, toRotation, factor);
        vec3.lerp(blendedScale, fromScale, toScale, factor);
        
        // Reconstruct the matrix
        const result = mat4.create();
        mat4.fromRotationTranslationScale(result, blendedRotation, blendedTranslation, blendedScale);
        return result;
    }
    
    /**
     * Get previous animation duration from samplers
     */
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
    
    /**
     * Get animation duration from samplers
     */
    private _getAnimationDuration(): number {
        // A field's length is the weighted average of its contributing clips, NOT the dominant clip's own
        // length — that is what keeps the shared phase advancing at the blended gait's rate.
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
     * Get final bone matrices for rendering
     */
    public getFinalBoneMatrices(): mat4[] {
        return this._finalBoneMatrices;
    }
    
    /**
     * Get final bone matrices as flat array for shader uniform
     */
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

    /**
     * Force the skeleton to its bind (default / T) pose and stop playback.
     * Public wrapper of the internal T-pose reset — used by the editor to preview the
     * rest pose and to guarantee a T-pose whenever nothing is playing.
     */
    public showBindPose(): void { this._setTPose(); }

    // ---- Animation state machine (action/event-driven playback) ----

    /** The current state machine, or null if none is assigned. */
    public getStateMachine(): AnimationStateMachine | null { return this._stateMachine; }
    public get hasStateMachine(): boolean { return this._stateMachine !== null; }
    /** Name of the state currently active in the machine (null when no machine / no entry). */
    public get currentStateName(): string | null { return this._currentStateName; }

    /**
     * Assign (or clear) the state machine. Resets live parameter values to their defaults and
     * enters the entry state. Pass null to remove the machine (falls back to mappings/T-pose).
     */
    public setStateMachine(sm: AnimationStateMachine | null): void {
        this._stateMachine = sm;
        this._paramValues.clear();
        this._currentStateName = null;
        // The new machine's states carry their own fields; anything cached belongs to the old one. Re-applying
        // an edited machine from the editor goes through here, so this is also what makes a field edit take.
        this._fieldBoneCache.clear();
        this._clearField();
        // Bands belong to the machine that authored them: a re-applied machine may have changed a threshold,
        // and a latch keyed on the old terms would keep a condition held past its new release point.
        this._condLatch.clear();
        // Likewise the dangling-binding reports: different parameters, and a re-apply is exactly when someone
        // has just fixed one and wants to know whether it took.
        this._warnedBindings.clear();
        this._warnedNegativeSpeed.clear();
        // Re-arm the ping-pong report too: re-applying a machine is exactly when someone has just added the
        // hysteresis it asked for and wants to know whether that took.
        this._stateFlips.length = 0;
        this._warnedPingPong = false;
        if (!sm) return;
        for (const p of sm.parameters) this._paramValues.set(p.name, p.default);
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
        else { this._currentStateName = null; this._setTPose(); }
    }

    // Parameter setters/getters used by scripts to drive the machine.
    public setFloat(name: string, value: number): void { this._paramValues.set(name, value); }
    public setBool(name: string, value: boolean): void { this._paramValues.set(name, value); }
    /** Fire a momentary trigger; it is consumed when a transition that uses it fires. */
    public setTrigger(name: string): void { this._paramValues.set(name, true); }
    public resetTrigger(name: string): void { this._paramValues.set(name, false); }
    public getParam(name: string): number | boolean | undefined { return this._paramValues.get(name); }

    /** Subscribe to animation events fired by clip event markers. Returns an unsubscribe fn. */
    public onAnimationEvent(cb: (eventName: string, clipName: string) => void): () => void {
        this._eventCallbacks.push(cb);
        return () => { this._eventCallbacks = this._eventCallbacks.filter(c => c !== cb); };
    }

    /**
     * Record a state change and report the machine if it is thrashing.
     *
     * A machine that changes state several times a second is fighting itself: two transitions are both
     * satisfiable around one threshold, so it bounces. On screen that is not "the state machine is wrong", it
     * is **the character vibrating** — every entry re-arms a cross-fade from a pose that has barely moved, and
     * if one of the two states plays a field and the other a clip, the blend is torn down and rebuilt every
     * frame. It reads as a blend problem, and people go looking in the blend.
     *
     * Reported with the PAIR named, because the count alone does not say which two transitions to go and fix.
     * The clock is accumulated frame time rather than a wall clock: a stepped or slow-motion animator must
     * measure its own time, and the engine has no business reading `Date.now()` in a per-frame path.
     */
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

    /**
     * Both transitions between a pair of states, with every condition's live value and whether it is met.
     *
     * The count and the pair say WHERE; this says WHY, and without it the answer is a guessing game played
     * against a machine nobody looking at the log can see. Two shapes account for almost every real
     * ping-pong and both are obvious here and nowhere else: a transition with an empty condition list (which
     * fires unconditionally, every frame), and a `>`/`<` pair whose values are both currently MET.
     */
    private _describeTransitions(from: string, to: string): string {
        const sm = this._stateMachine;
        if (!sm) return '';
        const lines: string[] = [];
        for (const [a, b] of [[from, to], [to, from]]) {
            const t = sm.transitions.find(x => x.from === a && x.to === b)
                ?? sm.transitions.find(x => x.from === '*' && x.to === b);
            if (!t) { lines.push(`${a} -> ${b}: (no transition)`); continue; }
            const parts: string[] = [];
            this._forEachCondition(t, c => parts.push(this._describeCondition(c)));
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
        return `[${c.param} ${c.op}${target}${band} | ${c.param}=${shown} | ${this._conditionMet(c) ? 'MET' : 'not met'}]`;
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

    /**
     * Enter a state by name: make it current and play its bound clip. `blendOverride` is the firing
     * transition's own cross-fade duration, if it set one.
     */
    private _enterState(name: string, blendOverride?: number): void {
        if (!this._stateMachine) return;
        const state = this._stateMachine.states.find(s => s.name === name);
        this._noteStateChange(this._currentStateName, name);
        this._currentStateName = name;
        this._prevEventTime = 0;
        this._stateTime = 0;

        // A field state blends several clips by its axis parameters instead of playing one. _startField
        // takes the transition's cross-fade itself, since it arms the blend rather than playAnimation.
        if (state?.field) {
            this._startField(state.field, state.fieldInputs, state.loop, true, blendOverride);
            this._loopLimit = Math.max(0, Math.floor(state.loopCount ?? 0));
            this._loopsPlayed = 0;
            this._speed = state.speed ?? 1.0;
            this._applyStateSpeed(state);
            return;
        }

        if (!state || !state.clipName) {
            // Nothing to play: hold the bind pose. This is legitimate for a deliberately empty state, but it
            // is ALSO where a field state lands when its embedded field has gone missing — `reembedFields`
            // drops a state's `field` when its asset id no longer resolves, and a field state carries no
            // `clipName` to fall back to. That path ends with _playing false and the character frozen in its
            // bind pose, so it says so rather than looking like an empty state somebody meant.
            if (state?.fieldId) {
                Logger.warn(
                    `Animation state "${name}" plays a blend field whose asset is missing, so it has nothing `
                    + `to play and holds the bind pose. Re-pick the field on that state and Apply.`,
                    'Animation');
            }
            this._setTPose();
            return;
        }
        this.playAnimationByName(state.clipName, state.loop, true);
        // playAnimation just armed the blend with the animator-wide default; the transition gets the last word.
        if (blendOverride !== undefined) this._activeBlendTime = Math.max(0, blendOverride);
        this._loopLimit = Math.max(0, Math.floor(state.loopCount ?? 0));
        this._loopsPlayed = 0;
        this._speed = state.speed ?? 1.0;
        this._applyStateSpeed(state);
    }

    /**
     * Report a Speed parameter that has gone negative, once per state.
     *
     * The clamp below is correct — there is no reverse playback — but on its own it is invisible, and what it
     * does is not small: playback pins to 0, so the clip FREEZES. Until this warning existed that read as "the
     * animation vibrates when I move that way", because the pose goes on being re-blended every frame from an
     * unsmoothed probe while the clips hold still (see {@link _frameDelta}).
     *
     * Signed built-ins are the usual source, and the trap is that they look like the obvious binding:
     * `forwardSpeed` and `lateralSpeed` are signed BY DESIGN (that is what makes "walk backwards" reachable in
     * a blend space), and `planarAngle` is negative across a whole half of its range.
     */
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

    /**
     * Drive the playback rate from a parameter when the state names one. Called on entry AND every frame, since
     * a variable-bound parameter moves while the state is held. Falls back to the state's fixed `speed`.
     */
    private _applyStateSpeed(state: AnimationState | undefined): void {
        if (!state?.speedParam) return;
        const v = this._paramValues.get(state.speedParam);
        // Parameter gone (renamed or deleted): keep the state's fixed speed. Reading the absent value as 0
        // would freeze the clip mid-pose, which looks like a broken rig rather than a dangling reference.
        if (v === undefined) return;
        // A bool reads as 1/0 so a flag can halt motion outright. The public setter's clamp is mirrored here
        // because this bypasses it; there is no reverse playback.
        const raw = typeof v === 'number' ? v : (v ? 1 : 0);
        if (raw < 0) this._warnNegativeSpeed(state, raw);
        this._speed = Math.max(0, raw);
    }

    /**
     * This node or the nearest ancestor with a rigid body — whatever is actually being moved.
     *
     * An animator lives on the skinned ModelNode, but the body that drives a character sits on the root
     * above it, so "how fast am I going" has to be asked of that root.
     */
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
        // A RELATIONSHIP rather than an identity, and that is the point: the character's rig is
        // `Playable(body) -> holder -> ModelNode(animator)`, so the thing that actually moves is neither self
        // nor parent, and naming it by node id breaks the moment the node is re-created. See the note on
        // dangling references in _refreshVariableParams.
        if (ref === 'bodied') return this._nearestBodiedNode();
        return this._node?.scene?.getNodeById(ref) ?? null;
    }

    /**
     * Report a binding whose node has gone missing, once per parameter.
     *
     * This warning is the whole reason the bug below took so long to find: a parameter reading its default
     * because its node vanished is indistinguishable, from the outside, from one legitimately reading zero.
     * The machine keeps running, keeps posing its entry state, and never transitions — with nothing anywhere
     * saying why.
     */
    private _warnDanglingBinding(paramName: string, message: string): void {
        if (this._warnedBindings.has(paramName)) return;
        this._warnedBindings.add(paramName);
        Logger.warn(`Animation parameter "${paramName}": ${message}`, 'Animation');
    }

    /**
     * Pull the live value of every 'variable' parameter into _paramValues, honoring the variable's
     * public/private/protected access (requester = this model node). Falls back to the parameter's
     * default when the source node is missing or access is denied.
     *
     * Two storage shapes are read. A class script's declared fields are NATIVE own properties on the node
     * (`this.speed`), which the legacy `variables` Map knows nothing about; legacy inline-script variables
     * still live in that Map. Map first, then the native own property — `hasOwnProperty` keeps this from
     * ever reading a real Node member (`name`, `position`, …) just because a parameter shares its name.
     */
    private _refreshVariableParams(): void {
        const sm = this._stateMachine;
        if (!sm || !this._node) return;
        for (const p of sm.parameters) {
            if (p.type !== 'variable' || !p.variable) continue;
            let src = this._resolveVarNode(p.variable.nodeRef);
            let val: number | boolean = p.default;

            // A DANGLING REFERENCE. `nodeRef` may be a node id, and every re-instantiation regenerates ids —
            // deleting and re-adding a character, rebuilding a template instance, re-placing from an asset.
            // The binding then names a node that no longer exists and this whole loop quietly writes the
            // default: every speed reads 0, no condition ever fires, and the character poses its entry state
            // forever looking perfectly healthy.
            //
            // For a BUILT-IN there is exactly one sensible repair. The picker only ever offers built-ins for
            // self, parent, or the nearest bodied ancestor, and the first two are relative and cannot dangle
            // — so a dangling one meant the bodied ancestor, and that is a relationship we can re-derive.
            // A user VARIABLE on an arbitrary scene node gets no such guess: driving a machine from the wrong
            // object is worse than not driving it.
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

            // Built-ins are engine state, not user data, so they skip the access model — there is no
            // variable record to carry an access modifier, and canAccessVariable would wave any unknown
            // name through anyway. An unrecognized name falls back to the default rather than throwing:
            // a machine saved against a newer engine must not take the frame down.
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
                // Coerce to the binding's declared type so conditions compare correctly even if the
                // variable holds a numeric string / truthy value (otherwise the number ops, which
                // require `typeof === 'number'`, silently never match).
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
        // Before any transition is considered, and for EVERY transition rather than just the ones leaving the
        // current state — a hysteresis band that only advances while its own state is active does not work.
        if (!this._currentStateName) { this.resetStateMachine(); return; }

        // Re-read a parameter-driven playback rate: the state is already entered, so nothing else would.
        this._applyStateSpeed(sm.states.find(s => s.name === this._currentStateName));

        const duration = this._getAnimationDuration();
        for (const t of sm.transitions) {
            if (t.from !== '*' && t.from !== this._currentStateName) continue;
            if (t.to === this._currentStateName) continue;

            // Dwell gate: refuse to leave a state we only just entered. Checked before the conditions so a
            // trigger is not consumed by a transition that cannot fire yet.
            if (t.minDwell && this._stateTime < t.minDwell) continue;

            // Exit-time gate: wait until the clip reaches the normalized exit time.
            if (t.hasExitTime) {
                const exit = (t.exitTime ?? 1.0) * duration;
                if (this._currentTime < exit) continue;
            }

            if (!this._transitionMet(t)) continue;

            // Consume any triggers this transition used, then switch. Every trigger in the tree is consumed,
            // including under an OR branch that did not contribute — the transition still "used" it, and
            // leaving it raised would fire some other transition next frame.
            this._forEachCondition(t, c => { if (c.op === 'trigger') this._paramValues.set(c.param, false); });
            this._enterState(t.to, t.blendTime);
            return;
        }
    }

    /** A transition's gate: the compound tree when present, else the legacy flat (implicitly ANDed) list. */
    private _transitionMet(t: AnimationTransition): boolean {
        if (t.condition) return this._nodeMet(t.condition);
        return t.conditions.every(c => this._conditionMet(c));
    }

    private _nodeMet(node: AnimationConditionNode): boolean {
        if (!isConditionGroup(node)) return this._conditionMet(node);
        // An EMPTY group is no constraint at all, for OR as much as AND. Strictly `[].some()` is false, but a
        // group you just added in the editor and have not filled in yet must not silently block the transition
        // forever — and an empty `conditions` list has always meant "always fires".
        if (node.children.length === 0) return true;
        return node.op === 'or'
            ? node.children.some(c => this._nodeMet(c))
            : node.children.every(c => this._nodeMet(c));
    }

    /** Visit every condition leaf of a transition, whichever shape it is stored in. */
    private _forEachCondition(t: AnimationTransition, visit: (c: AnimationCondition) => void): void {
        const walk = (node: AnimationConditionNode) => {
            if (isConditionGroup(node)) node.children.forEach(walk);
            else visit(node);
        };
        if (t.condition) walk(t.condition);
        else t.conditions.forEach(visit);
    }

    private _conditionMet(c: AnimationCondition): boolean {
        const v = this._paramValues.get(c.param);
        switch (c.op) {
            case 'trigger': return v === true;
            case 'true':    return v === true;
            case 'false':   return v === false;
            case 'gt':      return typeof v === 'number' && this._thresholdMet(c, v, true);
            case 'lt':      return typeof v === 'number' && this._thresholdMet(c, v, false);
            case 'eq':      return typeof v === 'number' && v === (c.value ?? 0);
            case 'neq':     return typeof v === 'number' && v !== (c.value ?? 0);
            default:        return false;
        }
    }

    /**
     * A 'gt'/'lt' comparison, latching when the condition authors a hysteresis band.
     *
     * The band is CENTRED on the authored threshold — `hysteresis` is its full width, so a `> 1` with a
     * hysteresis of 0.4 engages at 1.2 and does not release until the value falls back through 0.8. That
     * symmetry is what makes it work on the case it exists for: a `> x` / `< x` PAIR either side of one
     * threshold. Widening only the release would leave both halves still satisfiable at the same value (0.95
     * genuinely is `< 1` while 1.05 genuinely is `> 1`), and the machine would keep flipping. Centring the
     * band pushes the two engage points apart instead — `> 1 ±0.4` fires at 1.2, `< 1 ±0.4` at 0.8 — so
     * nothing happens until the signal genuinely swings.
     *
     * The latch tracks the SIGNAL, not the transition, and {@link _refreshConditionLatches} is what makes that
     * true — see the note there. It is not a detail: without it the band protects nothing.
     */
    private _thresholdMet(c: AnimationCondition, v: number, greater: boolean): boolean {
        const threshold = c.value ?? 0;
        if (!(typeof c.hysteresis === 'number' && c.hysteresis > 0)) {
            return greater ? v > threshold : v < threshold;
        }
        // Idempotent, so calling it here as well as in the per-frame refresh is safe — and it keeps this
        // correct for any caller that reaches a condition without having refreshed first.
        this._updateLatch(c);
        return this._condLatch.get(this._latchKey(c)) === true;
    }

    /** Identity of a condition's band: the terms it is asking about, so two identical conditions share one. */
    private _latchKey(c: AnimationCondition): string {
        return `${c.param}|${c.op}|${c.value ?? 0}|${c.hysteresis ?? 0}`;
    }

    /**
     * Advance one hysteresis band by the parameter's current value.
     *
     * Idempotent within a frame: engaging is always the stricter test, so re-running it on the value it just
     * produced cannot move the latch again.
     */
    private _updateLatch(c: AnimationCondition): void {
        if (c.op !== 'gt' && c.op !== 'lt') return;
        const h = typeof c.hysteresis === 'number' && c.hysteresis > 0 ? c.hysteresis : 0;
        if (h === 0) return;
        const v = this._paramValues.get(c.param);
        if (typeof v !== 'number') return;

        const greater = c.op === 'gt';
        const threshold = c.value ?? 0;
        const half = h / 2;
        const engage = greater ? threshold + half : threshold - half;
        const release = greater ? threshold - half : threshold + half;

        const key = this._latchKey(c);
        const met = this._condLatch.get(key) === true
            ? (greater ? v > release : v < release)
            : (greater ? v > engage : v < engage);
        this._condLatch.set(key, met);
    }

    /**
     * Advance EVERY band in the machine, once per frame, whatever state is current.
     *
     * This is load-bearing, and its absence was a real bug. `_evaluateStateMachine` only walks transitions
     * leaving the current state, so without this pass a band is only advanced while its own source state
     * happens to be active — and the classic pair sits on two different states. `Speed > 0.1 ±0.1` lives on
     * `Idle -> Locomotion` and `Speed < 0.1 ±0.1` on `Locomotion -> Idle`, so each was frozen exactly while the
     * other was being consulted.
     *
     * Both could therefore be latched ON at once, and a latched condition tests its RELEASE point — which for
     * a `>`/`<` pair overlaps across the entire band. `> 0.1` read true down to 0.05 while `< 0.1` read true up
     * to 0.15, so anything in between satisfied both and the machine flipped every frame: a ping-pong at
     * precisely the values the band was added to protect, which is a nasty thing to debug because the fix
     * looks like it is already applied.
     */
    private _refreshConditionLatches(): void {
        const sm = this._stateMachine;
        if (!sm) return;
        for (const t of sm.transitions) this._forEachCondition(t, c => this._updateLatch(c));
    }

    /** Fire event markers on the current clip whose time was crossed in (prev, cur]. */
    private _fireDueEvents(prevTime: number, curTime: number, duration: number, looped: boolean): void {
        const sm = this._stateMachine;
        if (!sm || sm.events.length === 0 || !this._currentAnimation || this._eventCallbacks.length === 0) {
            this._prevEventTime = curTime;
            return;
        }
        const clip = this._currentAnimation.name;
        const fire = (from: number, to: number) => {
            for (const ev of sm.events) {
                if (ev.clipName !== clip) continue;
                if (ev.time > from && ev.time <= to) {
                    // Fired straight from the update loop, outside the handler guards attachScriptFactory
                    // installs — a throwing subscriber must not take the frame down with it.
                    for (const cb of this._eventCallbacks) {
                        try { cb(ev.eventName, clip); }
                        catch (e) { Logger.error(`Error in onAnimationEvent('${ev.eventName}') for node ${this._node?.name}: ${e}`, 'Script'); }
                    }
                }
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

    // ---- Ragdoll drive mode ----

    /** True while bones are driven by physics bodies instead of animation. */
    public get ragdollActive(): boolean { return this._ragdollActive; }

    /**
     * Hand the skeleton over to physics: bone matrices are computed from the given
     * per-joint bodies (keyed by GLTF node index) every frame instead of from animation.
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

        // Snapshot each bone's fixed offset from its driving body at hand-off:
        //   offset = inverse(bodyWorld0) * nodeWorld0 * finalBoneMatrix0
        // bodyWorld0 is built rigidly (pos+quat) from the body's spawn pose, so all scale lives in
        // finalBoneMatrix0 and is carried through unchanged. At t=0 this reproduces the exact pose.
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

    /**
     * Compute final bone matrices from ragdoll bodies. Each body carries a bone's
     * world transform; convert it to model space via the owning node's inverse world
     * transform, then apply the inverse bind matrix (matching the animation path).
     * Runs after the physics step, so bodies hold this frame's settled pose.
     */
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

    /**
     * Set animation mappings for trigger-based playback
     */
    public setAnimationMappings(mappings: AnimationMapping[]): void {
        this._animationMappings = mappings;
    }
    
    /**
     * Get current animation mappings
     */
    public getAnimationMappings(): AnimationMapping[] {
        return this._animationMappings;
    }
    
    /**
     * Set the node reference for checking triggers
     */
    public setNode(node: Node): void {
        this._node = node;
    }
    
    /**
     * Check triggers and play appropriate animations
     * Should be called every frame before update
     */
    public checkTriggers(): void {
        // While ragdolling, ignore animation triggers (and don't fall back to T-pose).
        if (this._ragdollActive) return;
        if (!this._animatedModel) return;

        // The state machine, when present, is the source of truth for what plays.
        if (this._stateMachine) {
            this._evaluateStateMachine();
            return;
        }

        // If no mappings, set T-pose by stopping animation
        if (this._animationMappings.length === 0) {
            if (this._playing) {
                this._setTPose();
            }
            return;
        }
        
        const input = InputManager.instance;
        let triggerFound = false;
        let targetAnimation: string | null = null;
        
        // Check all mappings in order (priority: first match wins)
        for (const mapping of this._animationMappings) {
            let shouldTrigger = false;
            
            switch (mapping.triggerType) {
                case 'key':
                    if (mapping.keyCode && input.isKeyPressed(mapping.keyCode)) {
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
                // Blend only when something was actually running. This path re-plays after _setTPose() stopped
                // it, and a bind pose is not a legitimate blend source: _bones still hold the last ANIMATED
                // pose, so a cross-fade would start from a pose the viewer is not looking at. (playAnimation
                // itself no longer checks _playing — the state machine needs to blend out of a finished clip.)
                this.playAnimationByName(targetAnimation, true, this._playing);
            }
        } else {
            // No trigger active - set T-pose if currently playing
            if (this._playing) {
                this._setTPose();
            }
        }
    }
    
    /**
     * Set T-pose by resetting bone matrices to bind pose using initial node transforms
     */
    private _setTPose(): void {
        if (!this._skin) return;

        // The bind pose is by definition un-IK'd, and this path writes the bone matrices by its own route
        // without going through _recomputePose. Leaving the damped IK state behind would have the next real
        // pose resume from a pelvis drop, foot weights and remembered ground that belong to a pose no longer
        // on screen.
        this._ikFootWeights.clear();
        this._ikFootHits.clear();
        this._ikHipOffset = 0;

        // Stop any playing animation
        this._playing = false;
        // Abandon any blend too: the bind pose written below replaces the mix outright, and a surviving
        // _isBlending would have _recomputePose keep mixing the old clips back in on the next frame.
        this._isBlending = false;
        this._previousAnimation = null;
        this._previousBones.clear();
        this._previousFieldEntries = null;
        // Same for a live field, which is a pose source in its own right — leaving it set would have the
        // very next _recomputePose overwrite the bind pose with the blend again.
        this._clearField();

        // Calculate bind pose transforms for all joints
        const globalTransforms = new Map<number, mat4>();
        
        const calculateBindPoseTransform = (nodeIndex: number): mat4 => {
            // Check if already calculated
            if (globalTransforms.has(nodeIndex)) {
                return globalTransforms.get(nodeIndex)!;
            }
            
            // Get initial local transform from GLTF data
            const localTransform = this._skin!.nodeTransforms?.get(nodeIndex);
            if (!localTransform) {
                // Fallback to identity if no transform data
                const identity = mat4.create();
                globalTransforms.set(nodeIndex, identity);
                return identity;
            }
            
            // Find parent
            const joint = this._skin!.joints.find(j => j.nodeIndex === nodeIndex);
            const parentIndex = joint?.parentIndex;
            
            let globalTransform = mat4.create();
            
            if (parentIndex !== undefined) {
                // Has parent - multiply parent's global transform by local transform
                const parentGlobal = calculateBindPoseTransform(parentIndex);
                mat4.multiply(globalTransform, parentGlobal, localTransform);
            } else {
                // No parent - local transform IS the global transform
                mat4.copy(globalTransform, localTransform);
            }
            
            globalTransforms.set(nodeIndex, globalTransform);
            return globalTransform;
        };
        
        // Calculate final bone matrices for bind pose
        for (let jointIndex = 0; jointIndex < this._skin.joints.length; jointIndex++) {
            const joint = this._skin.joints[jointIndex];
            const nodeIndex = joint.nodeIndex;
            
            const globalTransform = calculateBindPoseTransform(nodeIndex);
            mat4.multiply(this._finalBoneMatrices[jointIndex], globalTransform, joint.inverseBindMatrix);
        }
    }
    
    /**
     * Check if movement direction matches the target direction vector in local space
     * Uses dot product to determine if the input direction is similar enough to the target
     * The input direction is transformed to the node's local space
     */
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
        
        // Get the node's rotation to convert world space to local space
        // Extract rotation from world transform and invert it
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
    
    /**
     * Check if speed is above threshold
     */
    private _checkSpeedTrigger(threshold: number): boolean {
        return this._currentSpeed >= threshold;
    }
    
    /**
     * Evaluate custom condition (basic implementation)
     * For security, only allow safe property access
     */
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
