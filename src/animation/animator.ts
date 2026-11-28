import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { AnimatedModel, Animation, AnimationSampler, AnimationChannel, Skin } from './animatedModel';
import {
    AnimationField, AnimationFieldAxis, FieldWeight, fieldWeights, rateScaleOf, phaseOffsetOf,
    axisSmoothing, axisDeadzone, axisWrapSpan, weightSmoothing,
} from './animationField';
import { resolveTablePose, type AnimationPose, type AnimationPoseBone } from './animationPose';
import { clamp, dampTime, dampWrapped, decomposeTRS, DEG2RAD, planarSignedAngle, wrapSpan } from '../core/math';
import { skeletonTopology, SkeletonTopology, isAncestorJoint, subtreeOrder } from './skeletonTopology';
import { findKey, findKeyLinear, isSorted } from './keyframes';
import { bakeCubicSpline } from './samplerBake';
import { solveTwoBone, kneePole, ikTuning, validateIkRig, swingReleaseWeight, stepFootLock, footLockWeight, FOOT_LOCK_MAX_TWIST, IkFootChain, IkRig, IkRigValidation } from './ik';
import { Node } from '../core/scene/nodes/node';
import { ModelNode } from '../core/scene/nodes/modelNode';
import { canAccessVariable } from '../core/scene/nodes/nodeVariables';
import { actionsFor, runEventActions, type EventActionBinding } from './eventActions';
import { ANIMATION_CHANNEL, getChannel, hasScriptListeners, resolveEvent } from '../core/events/hub';
import { bindAnimatorCommands } from './animatorCommands';
import { InputSystem } from '../input/inputSystem';
import { Logger } from '../core/logger';
import { LogTally, plural } from '../core/logTally';
import { rootMotionNodeOf, rootParentRotation, rootParentScale } from './clipEdit';
import { humanoidSlotOf, normalizeBoneName } from './boneNames';
import { socketModelMatrix } from './sockets';
import { footLockAt, footLockKey } from './footLockWindows';
import { clipRiseStart } from './clipRiseStart';
import { FORK_DEPTH, forksFromAnywhere, isForkIn, pathsFrom, resolveIn, staticEnd, type MachinePath, type MachineView } from './machineForks';
// The condition model and evaluator live in core/conditions.ts — they read a table of named values and
// answer yes or no, which has nothing to do with animation, and the behavior state machine needs the
// same latching. See that module for why the band is centred and why latches refresh machine-wide.
import {
    ConditionContext, conditionMet, consumeTriggers, forEachCondition, gateMet, isConditionGroup, updateLatch,
} from '../core/conditions';
import type { Condition, ConditionGroup, ConditionNode, ConditionOp } from '../core/conditions';
import type { TriggerName } from '../core/scripting/fieldTypes';
import {
    NO_REACTION_EFFECTS, type AnimationRagdollStart, type AnimationReactionEffects, type AnimatorReactionLink,
    type GetUpClock, type ReactionEffectsNow,
} from './reactionLink';
export type { AnimationRagdollStart, AnimationReactionEffects, AnimatorReactionLink, GetUpClock, ReactionEffectsNow } from './reactionLink';

/** Structural view of a physics body driving a ragdoll bone, so the physics layer stays unimported. */
export interface RagdollBodyRef {
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
}

/**
 * What draws a skeleton from simulated bodies while its animation keeps running underneath (a powered
 * ragdoll: physics/ragdoll.ts). The animation still plays and poses — it is the TARGET the bodies' muscles
 * reach for (Animator.getTargetBoneMatrices) — and each bone is then carried from where the animation puts its
 * part to where the simulation has it, by the part's weight: 0 draws the animation, 1 the body.
 */
export interface PhysicsMappingSource {
    /** Per skin joint index: the part (body) that carries the joint, or -1 for one that keeps its animation. */
    readonly partOfJoint: Int32Array;
    readonly partCount: number;
    /** 0..1: how much of part `i` is drawn as simulated. */
    mappingWeight(part: number): number;
    /** Part `i`'s rigid world pose [px py pz qx qy qz qw] as simulated. */
    simulatedPose(part: number, out: number[]): void;
    /** Part `i`'s rigid world pose as the animation poses it (its final bone matrices, the node's world transform). */
    animatedPose(part: number, finalBones: readonly mat4[], nodeWorld: mat4, out: number[]): void;
    /**
     * The body has every part (it falls, rolls, lies): the animation underneath is only a loose target for its weak
     * muscles, so it is posed every other frame (its clock still runs every frame).
     */
    readonly loose?: boolean;
    /**
     * A part the others are drawn against (absent or -1: none): each simulated part is placed by its pose relative
     * to the anchor's body, on the anchor as the animation has it NOW. A character on its feet has its hips
     * kinematic on its animation, which the body reaches a step later: drawn this way, its simulated upper body sits
     * on the animated hips without a tear at the waist.
     */
    readonly anchorPart?: number;
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
    /**
     * A REACTION value: read from the reactions of the character this animator animates (its own model's, whatever
     * node the parameter names), `none` where it has none (a backend without reactions, reactions off).
     */
    reactions?: (r: AnimatorReactionLink) => number | boolean;
    none?: number | boolean;
    /** Only ever rises (a count of events): a Trigger parameter linked to it fires each time it does. */
    counter?: boolean;
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

    // Reactions (physics/reactive/): what the character's body is doing, and the last hit it took.
    ragdolled:   { type: 'boolean', reactions: r => r.ragdolled, read: n => !!reactionsOfNode(n)?.ragdolled },
    canGetUp:    { type: 'boolean', reactions: r => r.canGetUp, read: n => !!reactionsOfNode(n)?.canGetUp },
    faceUp:      { type: 'boolean', reactions: r => r.faceUp, read: n => !!reactionsOfNode(n)?.faceUp },
    reacting:    { type: 'boolean', reactions: r => r.reacting, read: n => !!reactionsOfNode(n)?.reacting },
    hasControl:  { type: 'boolean', reactions: r => r.hasControl, none: true, read: n => reactionsOfNode(n)?.hasControl ?? true },
    staggering:  { type: 'boolean', reactions: r => r.staggering, read: n => !!reactionsOfNode(n)?.staggering },
    hitAngle:    { type: 'number', signed: true, reactions: r => r.hitAngle, read: n => reactionsOfNode(n)?.hitAngle ?? 0 },
    hitHeight:   { type: 'number', reactions: r => r.hitHeight, read: n => reactionsOfNode(n)?.hitHeight ?? 0 },
    hitStrength: { type: 'number', reactions: r => r.hitStrength, read: n => reactionsOfNode(n)?.hitStrength ?? 0 },
    hitCount:    { type: 'number', counter: true, reactions: r => r.hitCount, read: n => reactionsOfNode(n)?.hitCount ?? 0 },
};

/** A node's reactions, structurally (a ModelNode's or a Character's `reactions`), or null. */
function reactionsOfNode(n: Node | null | undefined): AnimatorReactionLink | null {
    return (n as { reactions?: AnimatorReactionLink | null } | null | undefined)?.reactions ?? null;
}

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
    /**
     * Type 'variable': the node variable this parameter reads from. Type 'trigger': a COUNTER it fires on (a
     * built-in with `counter`, such as hitCount): raised once each time the count rises, and lowered again at the
     * next frame if nothing took it, so a stale one never fires late.
     */
    variable?: AnimationVariableBinding;
}

/** A Ragdoll state (AnimationState.ragdoll): the body is the physics' while the graph is in it. */
export interface AnimationRagdollState {
    /**
     * What entering it does to a character on its feet. `fall` (default): it falls as it was moving; `trip`: its feet
     * are taken from under it and it falls forward; `limp`: it drops out cold, no hands out, no head tucked. Entered
     * off its feet (a hit already knocked it down) it only holds the body, which then never gets up by itself.
     */
    start?: AnimationRagdollStart;
}

/** A Get Up state (AnimationState.getUp): the body rises on its clip, lined up with where it lies. */
export interface AnimationGetUpState {
    /** The clip it plays lying on its back, and lying on its front. Either absent: the rig's reaction set's. */
    faceUp?: string;
    faceDown?: string;
    /**
     * Play the clip from its first frame. By default it joins the clip where the body in it starts to rise
     * (clipRiseStart: a capture's get-up often lies still a second or more first), so the character gets up as soon
     * as the body is handed to it.
     */
    fromFirstFrame?: boolean;
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
     * Parameter the playback rate is MULTIPLIED by, re-read every frame: `speed × value` (or the
     * `speedParam`'s value × it). A boss that speeds up in its second phase sets one number and every
     * attack state follows. A missing parameter multiplies by 1.
     */
    speedScaleParam?: string;
    /**
     * Clip seconds to start from (default 0). The clock and the event window both begin there, so a state
     * can play one segment of a longer clip — the second attack of a combo authored as one animation —
     * and an exit-time transition at the segment's end hands over to the next.
     */
    startTime?: number;
    /**
     * Stop motion: show this state's clip (or every clip of its blend space) as `fps` held poses a second of
     * game time, whatever its playback speed. Unset or 0 plays smooth. Only the SAMPLING steps: the clip's
     * clock, its events, exit time, root-motion travel, cross-fades, blend weights, layers and foot IK all
     * stay continuous, so the character still travels smoothly while its pose holds.
     */
    fps?: number;
    /**
     * On a LAYER: collect the clip's ground-plane root travel for {@link Animator.consumeRootMotion} instead
     * of moving anything. The root bone is held over the start spot (its height and tumble stay in the
     * pose), and a script moves the body by the travel — a roll that covers exactly the ground the dive does,
     * through the character's own collision. The base layer moves the character itself instead (per-clip
     * root motion), so this is ignored there.
     */
    extractRootMotion?: boolean;
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
    /**
     * Foot locking in this state, when the skeleton's rig has it (`IkRig.footLock`). Default on. Off, the state
     * plants no foot, and a foot locked when it was entered fades back to the animation over `lockRelease`: a
     * character standing in Idle, say, whose small weight shifts should not be pinned.
     */
    footLock?: boolean;
    /**
     * Feet planted by the clips' foot-lock windows (`Animation.footLocks`), at any height: a foot inside one keeps
     * its ground correction however far above the lowest foot the clip holds it, where foot placement would
     * otherwise read it as swinging and let it go. For a stair climb, whose upper foot stands a riser above the
     * lower one: released, it floats over its tread. Base layer only; off by default, so a clip on the flat keeps
     * the release it was tuned with.
     */
    plantInWindows?: boolean;
    /**
     * Hold the character still while this state plays: the Character it animates stops steering (no planar
     * velocity, no turning; gravity kept), so only the clip's root motion moves it. For a clip that must not
     * travel with whatever speed the body had or the stick asks for, a hard landing say. Base layer only.
     */
    holdMovement?: boolean;
    /**
     * A SYNC GROUP: a transition between two states that share one carries the stride across. The state entered
     * starts at the normalized phase the state left was at (a looping blend space's phase, or a looping clip's
     * time over its length) instead of at its start, and through the cross-fade the two blend spaces advance as
     * one, at the rate of their mixed cycle. So a walk handing over to a stair climb keeps the foot that was
     * planted planted, as long as phase 0 is the same foot's plant in both (a field sample's `phaseOffset`).
     * Not the state GROUPS of the graph (`AnimationStateMachine.groups`), which share transitions. Exit times and
     * `loopCount` count from the carried phase.
     *
     * On a LAYER, a state in a group the base layer's current state is also in FOLLOWS the base: every frame it
     * takes the base's normalized phase (through its own length), so an upper-body layer keeps step with the legs
     * whatever its clips' lengths. When the base comes back into the group at another phase, the layer cross-fades
     * to it from the pose it was showing. While the base is outside the group the layer runs at its own rate.
     * A held layer state (speed 0, a pose blend space) must not be in a group: following would move it.
     */
    syncGroup?: string;
    /** Link to the Pose asset (and pose within it) this state holds. Authoring-side only, like `fieldId`. */
    poseRef?: { assetId: string; poseId: string };
    /**
     * A static POSE to hold instead of a clip, embedded by the editor on Apply. Bones not listed are left
     * to whatever is beneath — in a masked layer that is how a hand grip sits on top of locomotion.
     */
    pose?: AnimationPose;
    /**
     * STEADY, on an override layer: how much (0..1, default 0) the layer's pose keeps its own MODEL-space turn
     * at the top of its mask, whatever the body beneath does. At each entry bone of the layer's mask (a masked
     * bone whose parent is not: the Spine of an upper-body mask) the pose is turned so the bone faces as the
     * layer's own pose has it (its own hips; a bone it does not hold, at rest), measured against the body as
     * the layers BELOW compose it, so layers above (a lean) still tilt it. Everything further down the mask
     * rides in local space, so a weapon held in both hands stays in them. At 0 the layer rides the hips and
     * sways with the walk, as before; one held pose at 0.4..1 replaces a per-gait upper-body clip. Eased over
     * the cross-fade; an empty state holds it. No effect on an additive layer or a whole-body (mask-less) one.
     */
    meshSpace?: number;
    /**
     * Triggers that enter this state directly, by name, from whatever state its layer is in — no
     * transition needed. A script firing `setTrigger('Roll')` plays the state listing `Roll`. Checked after
     * Any State transitions and before the current state's own (see {@link AnimationStateTrigger}).
     */
    triggers?: AnimationStateTrigger[];
    /**
     * A RAGDOLL state (base layer only): while the graph is in it the character's body is the physics' (its
     * reactions), entered falling (see AnimationRagdollState.start) or holding a body already down. The pose under
     * the body is the one it was entered with, or `clipName` when set (also what shows where no body can be made).
     * Layers are muted while it plays (AnimationLayer.overReactions), and Any State transitions and state triggers
     * into ordinary states wait: a ragdoll is not pulled into a car.
     */
    ragdoll?: AnimationRagdollState;
    /**
     * A GET UP state (base layer only): the body rises on its clip (face up or face down, chosen as it is entered,
     * from where the body lies), lined up with the body and blended from it; the transition's own blend, root motion
     * and foot IK do not apply, and the character is held still. Entered before the body lies still, it waits on its
     * first frame until it does.
     */
    getUp?: AnimationGetUpState;
    /** How the body takes hits while this state plays (see AnimationReactionEffects): merged over every layer's. */
    reactions?: AnimationReactionEffects;
    /** The state the machine starts in. Exactly one state should be the entry. */
    isEntry?: boolean;
    /** Graph-editor layout coordinates (authoring only — ignored at runtime). */
    x?: number;
    y?: number;
}

/** A trigger that enters a state directly (see {@link AnimationState.triggers}). */
export interface AnimationStateTrigger {
    /** The trigger parameter's name. */
    trigger: string;
    /** Seconds to cross-fade in over. Undefined uses {@link Animator.blendTime}. */
    blendTime?: number;
    /**
     * Fire even while the state already plays, restarting it (a second hit replays the flinch). Default
     * true: off, a trigger fired then would stay raised and start the state later, out of the blue.
     */
    restart?: boolean;
}

/**
 * What firing a trigger plays — see {@link Animator.triggerInfo}. Everything a script needs to time a
 * one-shot without naming its state.
 */
export interface AnimationTriggerInfo {
    /** The layer the state is on, or null for the base. */
    layer: string | null;
    /** The state the trigger enters. */
    state: string;
    /** The clip it plays ('' for a blend space or a pose), and that clip's length in seconds. */
    clip: string;
    clipLength: number;
    /** Its playback rate now: its speed, or speed parameter, times its speed-multiplier parameter. */
    speed: number;
    /** Clip seconds it starts at. */
    startTime: number;
    /**
     * Real seconds it plays before the layer rests or waits on another trigger: to where it hands over on
     * a trigger (a combo's next segment), else to its clip's end — plus whatever it flows into on its own
     * (a sheathe that goes on into the draw).
     */
    seconds: number;
    /** It collects its clip's root travel for consumeRootMotion() (AnimationState.extractRootMotion). */
    extractsRootMotion: boolean;
    /**
     * Entered whatever the layer is doing (a state trigger, or an Any State transition). False: only from
     * certain states, at their own time — a combo's next segment, which a script queues.
     */
    fromAnywhere: boolean;
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
    /**
     * An Any-State (`'*'`) transition may fire while the machine is already in `to`, restarting it from its
     * start — a second hit replays the flinch. Off, a transition into the current state never fires.
     */
    canTransitionToSelf?: boolean;
}

/**
 * What an animation event marker is heard with on the event system (`@onClipEvent`, `@eventListener('animation:…')`):
 * the marker, the clip it is on, and where the machine was.
 */
export interface AnimationEventInfo {
    /** The marker's name (without a `channel:` prefix, if it had one). */
    event: string;
    /** The clip it is on. */
    clip: string;
    /** The state playing that clip, on its layer; null for an action playing in a slot. */
    state: string | null;
    /** The layer or action slot that played it; null for the base layer. */
    layer: string | null;
    /** The node the animator belongs to (the character's model). */
    node: Node | null;
    animator: Animator;
}

/**
 * What `StateEnter`, `StateExit`, `ActionFinished`, `TriggerStarted` and `TriggerEnded` are heard with on the
 * `animation` channel.
 */
export interface AnimationStateEventInfo {
    /** The state entered (StateEnter) or left (StateExit); for TriggerStarted the state the trigger entered; null for ActionFinished. */
    state: string | null;
    /** The state left, or null (the first state, or an action). */
    from: string | null;
    /** The state entered, or null for an action. */
    to: string | null;
    /** The layer the state is on (null for the base layer), or the action's slot. */
    layer: string | null;
    /** ActionFinished: the action's clip. */
    clip?: string;
    /**
     * TriggerStarted: the trigger whose state the layer now plays. TriggerEnded: the one it played, now over (the
     * layer back in its entry state, or another trigger's state). See {@link Animator.activeTrigger}.
     */
    trigger?: string;
    node: Node | null;
    animator: Animator;
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
    /** The base layer's state groups: see {@link AnimationStateGroup}. */
    groups?: AnimationStateGroup[];
    /** The base layer's forks: see {@link AnimationFork}. */
    forks?: AnimationFork[];
    /** The base layer's graph reroute points: see {@link AnimationReroutes}. Authoring only. */
    reroutes?: AnimationReroutes;
    events: AnimationEventMarker[];
    /**
     * What an event does: event name -> actions (a sound, a particle burst, a light flash, a spawned template), run by
     * the animator when a clip marker of that name fires or a script calls `fireEvent`. See animation/eventActions.ts.
     */
    eventActions?: EventActionBinding[];
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

/**
 * A group of states on one layer: drawn as one node in the editor, and a name transitions can use.
 *
 *   - A transition FROM the group fires from whichever of its states is playing, after that state's own
 *     transitions (a state's own way out wins over its group's): the way into the air, say, written once for every
 *     state in the group.
 *   - A transition TO the group enters its `entry` state (its first, when unset), which may be a fork: then it goes
 *     on through the fork.
 *
 * A group may hold forks as well as states. Its own ways out never apply to its forks: the machine never rests in
 * one. A state or fork belongs to at most one group, and group names do not repeat state or fork names.
 */
export interface AnimationStateGroup {
    name: string;
    /** Member names: states, and forks. */
    states: string[];
    /** The state (or fork) a transition into the group enters. Default: the first member. */
    entry?: string;
    /** Graph position (authoring only). */
    x?: number;
    y?: number;
}

/**
 * A FORK on one layer: a junction transitions go through, never a state the machine rests in.
 *
 * Transitions go INTO it (from a state, a group, Any State or another fork) and OUT of it (to a state, a group or
 * another fork): its ways out are the transitions whose `from` is its name, tried in their order. A transition into
 * a fork fires only when one of its ways out can, and then goes straight on, in the same frame, to the first way out
 * that holds. So N states that share M ways out are N + M transitions, not N x M.
 *
 *   - Every leg's gates (`minDwell`, exit time, conditions) are tested against the state being LEFT.
 *   - The cross-fade is the last leg's that sets one (the one nearest the state entered), else the animator's.
 *   - The triggers of every leg on the path taken are consumed; a way out that was only tried consumes nothing.
 *   - A way out into the state the machine is already in is passed over (unless the path starts at Any State and
 *     a leg can restart its state), and the next is tried.
 *
 * Names are shared with states and groups: a state or a group of the same name wins.
 */
export interface AnimationFork {
    name: string;
    /** Graph position (authoring only). */
    x?: number;
    y?: number;
}

/**
 * A point a drawn transition line is routed through in the graph editor (authoring only, ignored at runtime): a
 * reroute point, as in a Blueprint. The line passes through it left to right (`axis` 'h', the default) or top to
 * bottom ('v'), whichever way it is heading.
 */
export interface AnimationReroute {
    x: number;
    y: number;
    axis?: 'h' | 'v';
}

/**
 * The reroute points of a layer's drawn lines, by line: `<view>::<line key>`, the view '' for the whole layer or the
 * name of the group opened, the key the line's own (two names joined by '|', or a group's port line 'from>to').
 * Authoring only, ignored at runtime.
 */
export type AnimationReroutes = Record<string, AnimationReroute[]>;

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
    /** The layer's state groups: see {@link AnimationStateGroup}. */
    groups?: AnimationStateGroup[];
    /** The layer's forks: see {@link AnimationFork}. */
    forks?: AnimationFork[];
    /** The layer's graph reroute points: see {@link AnimationReroutes}. Authoring only. */
    reroutes?: AnimationReroutes;
    /** 0..1, default 1. */
    weight?: number;
    /** Parameter to read the weight from each frame. Overrides `weight`. */
    weightParam?: string;
    blend?: AnimationBlendMode;
    /** Link to the Bone Mask asset. Authoring-side only; the runtime reads `mask`. */
    maskId?: string;
    /** Bone NAME -> weight 0..1, embedded on Apply. Absent = the whole body; a bone not listed = 0. */
    mask?: Record<string, number>;
    /**
     * SUPPORT-HAND IK: after every layer, this hand reaches where the layer's OWN pose puts it relative to the
     * other hand (or a socket), so a weapon held in the other hand keeps both hands on it whatever the layers
     * above do to that hand (an aim offset, sway, recoil) and however its poses are edited.
     */
    handIk?: AnimationHandIk;
    /**
     * Keep playing while the base layer is in a Ragdoll or Get Up state. Off (default), the layer fades out over the
     * transition in and back over the one out: an aim or a weapon pose must not pull at a body getting up.
     */
    overReactions?: boolean;
}

/** A layer's support-hand IK (see {@link AnimationLayer.handIk}). */
export interface AnimationHandIk {
    /** The hand that reaches: `'left'` keeps a left hand on a weapon held in the right. */
    hand: 'left' | 'right';
    /** 0..1, default 1, times the layer's weight and presence. */
    weight?: number;
    /** A float (or bool) parameter to read it from each frame instead of `weight`: 0 lets go (a sprint). */
    weightParam?: string;
    /**
     * Reach this socket (the hand's frame on it) instead of where the layer's own pose puts the hand relative
     * to the other one. An edit to the reaching hand in the layer's poses is then ignored.
     */
    socket?: string;
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

// Poses (and a variant's `reference`, what an additive layer measures it from) live in animationPose.ts.
export type { AnimationPose, AnimationPoseBone };

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
    /**
     * Seconds into the clip to start from (default 0): one segment of a longer clip, e.g. the second
     * attack of a combo authored as one continuous animation. Events before it do not fire.
     */
    startTime?: number;
}

/** A playing action. `finished` resolves once it has faded fully out, however it ended. */
export interface AnimationActionHandle {
    readonly slot: string;
    readonly clipName: string;
    readonly done: boolean;
    readonly finished: Promise<void>;
    /** Clip seconds the action is at, and the clip's length (both 0 once it is over). */
    readonly time: number;
    readonly duration: number;
    /** Fade the action out now. */
    stop(blendOut?: number): void;
    /**
     * Put the action at `clipSeconds` (wrapped when it loops, else held at the clip's end), firing none of
     * the clip's events in between: a scrub, or a sequencer keeping the clip on its timeline.
     */
    seek(clipSeconds: number): void;
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
    /**
     * Steady's entry bones (masked joints whose parent joint is not), each with the nodes from the root down to
     * its parent frame. Resolved with `mask`; null while it is (and for a whole-body layer: no entries).
     */
    entries: Map<number, number[]> | null;
    /** Its layer's Steady (`AnimationState.meshSpace`) this frame, 0 for slots and additive layers. */
    steadyNow: number;
    /** The layer's support-hand IK, if it has one. */
    handIk: AnimationHandIk | null;
    /** The layer plays over Ragdoll and Get Up states (AnimationLayer.overReactions). */
    overReactions: boolean;
}

/**
 * What `Animator.updateStateMachine` may swap in place: the same parameters (names and types), the same layers
 * and slots in order, and on the base and every layer the same states playing the same KIND of thing (a clip by
 * name, a pose, a blend space). What those poses and blend spaces hold, transitions, weights and masks may differ.
 */
function machineShape(sm: AnimationStateMachine): string {
    const states = (list: AnimationState[]) =>
        list.map(s => `${s.name}=${s.ragdoll ? 'ragdoll:' + (s.clipName ?? '') : s.getUp ? `getUp:${s.getUp.faceUp ?? ''}/${s.getUp.faceDown ?? ''}`
            : s.pose ? 'pose' : s.field ? 'field' : 'clip:' + (s.clipName ?? '')}`).join('|');
    return JSON.stringify([
        sm.parameters.map(p => `${p.name}:${p.type}`),
        states(sm.states),
        (sm.layers ?? []).map(l => [l.name, states(l.states)]),
        (sm.slots ?? []).map(s => s.name),
    ]);
}

/** Whether a state is a Ragdoll state, a Get Up state, or neither. */
function reactionKindOf(s: AnimationState | null | undefined): 'ragdoll' | 'getUp' | null {
    return s?.ragdoll ? 'ragdoll' : s?.getUp ? 'getUp' : null;
}

/** AnimationReactionEffects.react, strictest last. */
const REACT_RANK: Record<string, number> = { full: 0, flinch: 1, none: 2 };

/** The first trigger a transition's conditions read (the one that starts what it enters), or null. */
function firstTriggerOf(t: AnimationTransition): string | null {
    let found: string | null = null;
    forEachCondition(t.condition, t.conditions, c => { if (!found && c.op === 'trigger') found = c.param; });
    return found;
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
    /** Fix what {@link startTR} answers to a given pose instead of the first frame: a pose variant's base. */
    public seedStart(t: vec3, r: quat): void {
        this._startTR = { t: vec3.clone(t), r: quat.clone(r) };
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

// The additive reference of each pose clip's bones (`Animator._poseClipOf`): its base pose for a variant, rest
// otherwise. Seeded onto every bone map built from that clip (`_buildBoneMapFor`), so `startTR` answers it.
const POSE_REFERENCES = new WeakMap<Animation, Map<number, { t: vec3; r: quat }>>();

// One line per scene build, not four plus one per clip for every character: a Valley-sized scene logged
// thousands, which evicted the warnings that explain a broken setup from the log ring.
const ANIMATOR_TALLY = new LogTally('Animation', ['animators', 'joints', 'animations'] as const,
    c => `Initialized ${plural(c.animators, 'animator')}: ${plural(c.joints, 'joint')}, ${plural(c.animations, 'animation')}`);

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

/**
 * A layer following the base's sync group (AnimationState.syncGroup) further than this from the base's phase (a
 * share of the cycle) cross-fades to it, over LAYER_REACQUIRE_BLEND seconds, instead of jumping. Closer than this
 * is the ordinary frame-to-frame drift of a layer whose clip is another length, and it simply snaps.
 */
const LAYER_REACQUIRE_GAP = 0.02;
const LAYER_REACQUIRE_BLEND = 0.2;

// Blend scratch. Every helper below fully consumes its inputs before returning.
const MIX_BONES: Bone[] = [];
const MIX_WEIGHTS: number[] = [];
const MIX_T = vec3.create(), MIX_S = vec3.create(), MIX_R = quat.create();
const BL_T0 = vec3.create(), BL_R0 = quat.create(), BL_S0 = vec3.create();
const BL_T1 = vec3.create(), BL_R1 = quat.create(), BL_S1 = vec3.create();
const ADD_INV = quat.create(), ADD_DELTA = quat.create(), ADD_ID = quat.create();
// A field's additive reference (see `_fieldReference`): its mix, and the hemisphere it is summed in.
const REF_T = vec3.create(), REF_R = quat.create(), REF_HEMI = quat.create();
const FIELD_REF = { t: REF_T, r: REF_R };

// Foot IK scratch: the solve runs per character per frame and used to allocate ~60 vectors and matrices.
const IK_WORLD_TO_MODEL = mat4.create();
const IK_UP = vec3.create(), IK_ORIGIN = vec3.create(), IK_FORWARD = vec3.create(), IK_ZERO = vec3.create();
const IK_ANKLE_WORLD = vec3.create(), IK_FROM = vec3.create(), IK_TO = vec3.create();
const IK_HIT_MODEL = vec3.create(), IK_TMP = vec3.create(), IK_SHIFT = vec3.create(), IK_O = vec3.create();
const IK_INV = mat4.create(), IK_FRAME = mat4.create(), IK_ROT = mat4.create(), IK_AROUND = mat4.create();
// Support-hand IK (`_applyHandIk`).
const HIK_TARGET = mat4.create(), HIK_LEAD = mat4.create(), HIK_REACH = mat4.create(), HIK_TMP = mat4.create();
const HIK_ROOT = vec3.create(), HIK_MID = vec3.create(), HIK_TIP = vec3.create(), HIK_GOAL = vec3.create(), HIK_AT = vec3.create();
const HIK_T = vec3.create(), HIK_S = vec3.create(), HIK_CUR = quat.create(), HIK_WANT = quat.create(), HIK_ID = quat.create();
const IK_NEW_GLOBAL = mat4.create();
const IK_HIP = vec3.create(), IK_KNEE = vec3.create(), IK_ANKLE = vec3.create(), IK_EASED = vec3.create();
const IK_UNLOCKED = vec3.create(), IK_LOCK_PULL = vec3.create(), IK_LOCK_FROM_HIP = vec3.create();
/**
 * The furthest a foot lock that is letting go may stretch a leg, as a share of its length (unless the animation
 * already has it straighter). Near full extension a knee swings a long way for a little reach: a release still
 * pulling a swinging foot back toward its spot dragged the leg straight after it, and the knee snapped 4 to 10 cm
 * in a frame as it let go. A HELD foot may stretch the leg all the way: holding a foot the body moves away from
 * (a change of direction) is what the lock is for. Between the two, by how far the lock has let go.
 */
const LOCK_MAX_STRETCH = 0.97;
const IK_ALIGN = quat.create(), IK_PARTIAL = quat.create(), IK_COUNTER = quat.create(), IK_HALF = quat.create();
const IK_QID = quat.create();
const IK_LOCK_M3 = mat3.create(), IK_LOCK_M3_INV = mat3.create(), IK_LOCK_ORIGIN = vec3.create();
const IK_LOCK_FREE = vec3.create(), IK_LOCK_FREE_WORLD = vec3.create(), IK_LOCK_DIR = vec3.create();
const IK_LOCK_D = vec3.create(), IK_LOCK_D2 = vec3.create(), IK_LOCK_Q = quat.create(), IK_TWIST = quat.create();
const IK_LOCK_POINT = vec3.create(), IK_LOCK_MODEL = vec3.create(), IK_LOCK_SPAN = vec3.create();
/** Below this share of its length lying along the ground, a foot's heading is not read (it stands on its toe). */
const FOOT_LOCK_LEVEL = 0.5;
/** The along-the-ground part of `v`, as a tuple (no allocation of a vec3). */
const planarOf = (v: vec3, up: vec3): [number, number, number] => {
    const d = vec3.dot(v, up);
    return [v[0] - up[0] * d, v[1] - up[1] * d, v[2] - up[2] * d];
};

/** One foot's plan for this frame, pooled per animator. See `_applyFootIk`. */
interface FootPlan {
    chain: IkFootChain;
    ankle: vec3;         // model space, as animated
    target: vec3;        // model space, on the ground
    normal: vec3;        // model space, of the surface
    weight: number;      // this foot's damped contribution
    /** Signed distance from the animated ankle to its target along `up`. Negative = the foot must drop. */
    along: number;
    /** The animated ankle's height along `up` — where the CLIP put it, before any ground is consulted. */
    height: number;
    /**
     * Foot locking: where the ANKLE must go to put the planted point back on its spot (model space), and how
     * much of that applies (0 = unlocked). `lockPlanar`: only along the ground (a toe lock: the clip and the
     * ground decide the height, the heel lifting as animated while the ball stays down).
     */
    lockPoint: vec3;
    lockWeight: number;
    lockPlanar: boolean;
    /** The planted heading, ankle to toe, flattened (model space). Zero-length without a toe. */
    lockDir: vec3;
}

/**
 * One foot's lock (foot locking, `IkRigTuning.footLock`). WORLD space: the planted spot must stay where it is
 * on the ground while the character carries model space away from it.
 */
interface FootLockState {
    /** 0..1 progress of the lock (its weight through the rig's curve); see stepFootLock. */
    alpha: number;
    /** Between its plant and its release, whatever the weight has reached. */
    planted: boolean;
    /** Where the ankle is planted. */
    point: vec3;
    /** The planted heading, ankle to toe, flattened and unit; zero-length without a toe. */
    dir: vec3;
    /** The animated locked point (toe or ankle) last frame (model space) and the model's origin then (world), for its ground speed. */
    prevPoint: vec3;
    prevOrigin: vec3;
    hasPrev: boolean;
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
    /** A pose sample (`AnimationFieldSample.pose`): held, so it has no cycle of its own. */
    pose?: boolean;
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

// Stop motion (AnimationState.fps): slack on the frame clock, so five 1/60 s frames reach a 1/12 s one
// despite the rounding of their sum.
const FRAME_EPSILON = 1e-6;

/**
 * A stop-motion frame clock (game seconds into its held frame) with the frames it has reached taken off,
 * or -1 when it has reached none. A hitch longer than a frame drops the whole frames it spans: the pose
 * jumps to the present once, rather than bursting through every frame it missed.
 */
function takeFrame(clock: number, fps: number): number {
    const period = 1 / fps;
    if (!(clock + FRAME_EPSILON >= period)) return -1;
    return Math.max(0, clock - period * Math.floor((clock + FRAME_EPSILON) / period));
}

/** A state's stop-motion rate (AnimationState.fps), 0 for smooth. A pose state has no clock to step. */
function stateFps(state: AnimationState): number {
    if (state.pose && !state.field) return 0;
    const fps = state.fps;
    return typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : 0;
}

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
    /**
     * A layer's child is still showing (its presence > 0), set by the parent each frame. Coming out of an
     * empty state while it is, the next clip cross-fades from the pose still fading instead of replacing it.
     */
    private _overlayVisible: boolean = false;
    /**
     * A layer's foot-IK weight while it fades out through an empty state: the weight of the clip state it
     * left, so a roll's "no foot IK" eases back with the fade rather than snapping on at the exit.
     */
    private _overlayFadeIkWeight: number = 1;
    /** Seconds a layer's presence takes to fade in or out: the blend of the transition it last took. */
    private _presenceFadeSeconds: number = 0.15;
    /**
     * The trigger that started what this machine plays: set when a trigger enters a state, kept through
     * trigger-less transitions (a sequence), cleared back in the entry state. See activeTrigger.
     */
    private _activeTrigger: string | null = null;
    /** Layer states whose clip the model lacks, warned about once each. */
    private _warnedMissingLayerClip: Set<string> | null = null;
    /**
     * The machine was set while the model had no clips at all: shared clips (the skeleton's) are attached after
     * the model is parsed, so every state was entered with nothing to play. The first frame the clips are there,
     * the machine is entered again (`_catchUpClips`), and nothing is reported meanwhile: no clips at all is
     * "not yet", not a missing clip.
     */
    private _setWhileClipsPending = false;
    /**
     * Fired transitions whose triggers are lowered once the base AND every layer have evaluated this frame
     * (see checkTriggers), so a trigger two layers read fires both. Null outside that pass: consume at once.
     */
    private _pendingTriggerConsumes: AnimationTransition[] | null = null;
    // Scratch for the walk through forks (`_wayOut`): the legs of the path being tried, and the forks it has expanded.
    private _forkPath: AnimationTransition[] = [];
    private _forksSeen: string[] = [];
    /** Event markers a slot's child fires — the parent machine's list, since a slot has no machine. */
    private _externalEvents: AnimationEventMarker[] | null = null;
    /** Layers and slots, in the order they apply over the base. */
    private _overlays: Overlay[] = [];
    /** Set by `_recomputePose`, so `update` can tell whether the overlays still need a pose this frame. */
    private _posedThisFrame: boolean = false;
    /**
     * Poses turned into clips, keyed by the pose object (a state's, or a blend-space sample's). A re-embed makes
     * new objects, so an edited pose is rebuilt.
     */
    private _poseClips: WeakMap<AnimationPose, Animation> = new WeakMap();
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

    // ---- Stop motion (AnimationState.fps) ----
    // A stepped state samples its clips at a HELD time, snapshotted from the continuous clock on each tick
    // of a frame clock that runs on game time. Everything that reads the clock itself (events, exit time,
    // root travel, sync phase) keeps the continuous value; only the pose sampling reads the held one.
    /** The current state's frame rate; 0 = smooth (sample the live clock). */
    private _fps: number = 0;
    /** Game seconds since the last held frame. Not reset on a state change: the character keeps one beat. */
    private _frameClock: number = 0;
    /** Clip time / field phase of the frame on screen (meaningful while `_fps > 0`). */
    private _heldTime: number = 0;
    private _heldFieldPhase: number = 0;
    /** A frame was taken in this `_advance`, so a synced layer re-snapshots at the phase it follows. */
    private _tickedThisFrame: boolean = false;
    /** The same, for the outgoing side of a cross-fade: it keeps stepping at its own state's rate. */
    private _previousFps: number = 0;
    private _previousFrameClock: number = 0;
    private _previousHeldTime: number = 0;
    private _previousHeldFieldPhase: number = 0;

    private _blendTime: number = 0.3; // Default blend time in seconds
    private _currentBlendTime: number = 0;
    private _isBlending: boolean = false;

    // Ragdoll: bone matrices come from physics bodies instead of animation, each joint driven by the
    // nearest ancestor bone that owns one. finalBoneMatrix = inv(nodeWorld) * bodyWorld * offset, where
    // the constant offset holds the bone's full start pose, so only RIGID motion is followed.
    private _ragdollActive: boolean = false;
    private _ragdollDrive: Map<number, { body: RagdollBodyRef, offset: mat4 }> | null = null;

    // Physics mapping (a powered ragdoll, see PhysicsMappingSource): the animation keeps posing into these
    // TARGET matrices, and the skinning matrices are carried from them to the simulated bodies.
    private _physicsMapping: PhysicsMappingSource | null = null;
    private readonly _targetBones: mat4[] = [];
    private readonly _targetModel: mat4[] = [];
    /**
     * No foot placement or foot locking while bodies carry the legs (a reaction): planting an animated foot on the
     * ground fights them. Faded out quickly, and back in after; what it remembered (locks, ground hits) is
     * forgotten, so it comes back fresh.
     */
    public ikSuppressed = false;
    /** No support-hand IK while bodies carry the arms: a hand pinned to a weapon fights the arm's reaction. */
    public handIkSuppressed = false;
    /**
     * No foot LOCKING (placement stays): a body shoved across the ground (a reaction's stagger) slides under feet
     * that cannot be planted; held, each foot stretched behind until it strayed past its lock and snapped. Feet
     * already held let go over the rig's lockRelease and plant again once it is off.
     */
    public footLockSuppressed = false;
    /**
     * The hand a layer's support-hand IK holds on a weapon in the other (more than half on, before any suppression),
     * or null: what tells a character's reactions its hands are busy.
     */
    public get handIkActive(): 'left' | 'right' | null { return this._handIkActive; }
    private _handIkActive: 'left' | 'right' | null = null;

    // ---- Ragdoll and Get Up states, reaction effects (reactionLink.ts) ----

    /** The reaction state the base layer is in: a Ragdoll state, a Get Up state, or neither (null). */
    public get reactionKind(): 'ragdoll' | 'getUp' | null {
        if (this._isOverlay) return null;
        return reactionKindOf(this._currentState);
    }

    /**
     * How hits land on the character now: the reaction effects (AnimationState.reactions) of the base layer's state
     * and of every layer's, merged. `react` is the strictest a state showing at least half says; `busyHands` every
     * hand such a state names (null: none names one); `force` and `shove` the product of each state's, by how much of
     * it shows. Worked out once a frame.
     */
    public get reactionEffects(): Readonly<ReactionEffectsNow> {
        if (this._isOverlay) return NO_REACTION_EFFECTS;
        if (this._effects && this._effectsAt === this._animatorClock) return this._effects;
        let react = 0, said = false, L = false, R = false, force = 1, shove = 1;
        const take = (s: AnimationState | null, w: number) => {
            const e = s?.reactions;
            if (!e || !(w > 0)) return;
            if (w >= 0.5) {
                if (e.react) react = Math.max(react, REACT_RANK[e.react] ?? 0);
                const h = e.busyHands;
                if (h && h !== 'auto') {
                    said = true;
                    if (h === 'both' || h === 'left') L = true;
                    if (h === 'both' || h === 'right') R = true;
                }
            }
            if (typeof e.force === 'number' && Number.isFinite(e.force)) force *= 1 + (clamp(e.force, 0, 10) - 1) * Math.min(1, w);
            if (typeof e.shove === 'number' && Number.isFinite(e.shove)) shove *= 1 + (clamp(e.shove, 0, 10) - 1) * Math.min(1, w);
        };
        take(this._currentState, 1);
        for (const o of this._overlays) if (o.kind === 'layer') take(o.animator._currentState, o.presence * this._overlayWeight(o));
        const effects: ReactionEffectsNow = {
            react: react >= 2 ? 'none' : react >= 1 ? 'flinch' : 'full',
            busyHands: said ? { L, R } : null,
            force: clamp(force, 0, 10), shove: clamp(shove, 0, 10),
        };
        this._effects = effects;
        this._effectsAt = this._animatorClock;
        return effects;
    }

    /**
     * The base layer is in a Get Up state: play its clip for the side the body lies on (`faceUp`; the rig's own
     * get-up clips, `fallback`, for a side it names none), from its first frame, and hand back its clock — what the
     * character's reactions follow as the body rises. Null when the base is in no Get Up state or has no clip to
     * play: the reactions then play the rig's clip in their own slot.
     */
    public playGetUp(faceUp: boolean, fallback?: { faceUp?: string; faceDown?: string } | null): GetUpClock | null {
        if (this._isOverlay) return null;
        const state = this._currentState;
        if (!state?.getUp) return null;
        const clip = this._getUpClip(state, faceUp, fallback);
        if (!clip) return null;
        if (clip !== this._currentAnimation) {
            this._noRootMotion = true;
            this._playClip(clip, false, false);
            this._speed = state.speed ?? 1;
            this._applyStateSpeed(state);
        }
        this._getUpStart = this._riseStartFor(state, clip);
        this._currentTime = this._getUpStart;
        this._prevEventTime = this._getUpStart;
        this._eventFromStart = this._getUpStart <= 0;
        this._playing = true;
        this._reactionHold = false;
        return this._getUpClock();
    }

    /**
     * The base layer is in a Ragdoll state playing a clip of its own: the body's muscles follow that clip (the
     * reactions ease their reference pose to it) rather than the pose the body fell in.
     */
    public get reactionClipPlaying(): boolean {
        if (this._isOverlay) return false;
        const s = this._currentState;
        return !!s?.ragdoll && !!s.clipName && this._currentAnimation?.name === s.clipName;
    }

    /** Out of any Ragdoll or Get Up state at once, back to the entry state (the reactions were reset: a respawn). */
    public endReactionStates(): void {
        if (this._isOverlay || !this.reactionKind) return;
        this.resetStateMachine();
    }

    /** The character's reactions, through its model (ModelNode.reactions, made on first ask), or null. */
    private _reactionLink(): AnimatorReactionLink | null {
        if (this._isOverlay) return null;
        return reactionsOfNode(this._node);
    }

    /** A Get Up state's clip for a side: its own for that side, else the rig's, else the other side's. */
    private _getUpClip(state: AnimationState, faceUp: boolean, fallback?: { faceUp?: string; faceDown?: string } | null): Animation | null {
        const g = state.getUp ?? {}, f = fallback ?? {};
        const up = g.faceUp || f.faceUp, down = g.faceDown || f.faceDown;
        const name = faceUp ? (up || down) : (down || up);
        if (!name) return null;
        return this._animatedModel?.animations.find(a => a.name === name) ?? null;
    }

    /** Where a Get Up state joins its clip (seconds into it): where the body in it rises, unless it says from the start. */
    private _riseStartFor(state: AnimationState, clip: Animation): number {
        if (state.getUp?.fromFirstFrame) return 0;
        const skin = this._animatedModel?.skin;
        return skin ? clipRiseStart(clip, skin) : 0;
    }
    /** Seconds into the Get Up state's clip it joined it at. */
    private _getUpStart = 0;

    /**
     * The current Get Up state's clock, in real seconds from where it joined its clip (its rise start); over once the
     * state is left.
     */
    private _getUpClock(): GetUpClock {
        const self = this, token = this._stateToken, start = this._getUpStart;
        const rate = () => Math.max(1e-3, self._speed);
        const live = () => self._stateToken === token;
        return {
            get time() { return live() ? Math.max(0, self._currentTime - start) / rate() : 0; },
            get duration() { return live() ? Math.max(0, self._getAnimationDuration() - start) / rate() : 0; },
            get done() { return !live() || (!self._playing && self._currentTime >= self._getAnimationDuration() - 1e-6); },
            seek(seconds: number) {
                if (!live()) return;
                self._currentTime = clamp(start + seconds * rate(), start, self._getAnimationDuration());
                self._prevEventTime = self._currentTime;
            },
            stop() {
                // Knocked down again: the state waits on the frame it joined for the body to come to rest once more.
                if (!live()) return;
                self._reactionHold = true;
                self._currentTime = start;
                self._prevEventTime = start;
                self._playing = true;
            },
        };
    }

    /**
     * A Ragdoll or Get Up state was entered: tell the character's reactions, now (at the end of checkTriggers, or as
     * update starts after a forceState), in the phase scripts already call them from. Twice at most: a reaction
     * event's listener may force another state.
     */
    private _flushReactionEdge(): void {
        if (this._isOverlay || this._reactionEdge === null || this._flushingReactions) return;
        this._flushingReactions = true;
        try {
            for (let pass = 0; pass < 2 && this._reactionEdge !== null; pass++) {
                const edge = this._reactionEdge;
                this._reactionEdge = null;
                const state = this._currentState;
                const link = this._reactionLink();
                if (!link) { this._warnNoReactions(state); break; }
                if (edge === 'ragdoll' && state?.ragdoll) link.graphRagdoll(state.ragdoll.start ?? 'fall');
                else if (edge === 'getUp' && state?.getUp) link.graphGetUp();
            }
        } finally {
            this._flushingReactions = false;
        }
    }

    private _warnNoReactions(state: AnimationState | null): void {
        if (!state || this._warnedNoReactions || !this._node?.scene) return;
        if (!(this._node.scene as { physics?: unknown }).physics) return;
        this._warnedNoReactions = true;
        Logger.info(
            `Animation state "${state.name}" is a ${state.ragdoll ? 'Ragdoll' : 'Get Up'} state, but this character has no `
            + `reactions (they run on the Jolt physics backend, with a skeleton a ragdoll fits): it plays as an ordinary `
            + `state.`, 'Animation');
    }

    /**
     * The pose on screen from the base layer alone (its clip or blend space, mid cross-fade as it is), held as a clip:
     * what a Ragdoll state with no clip of its own keeps under the body. Never the bind pose: the body is made from
     * what shows.
     */
    private _heldPoseClip(): Animation | null {
        const skin = this._skin;
        if (!skin) return null;
        const samplers: AnimationSampler[] = [];
        const channels: AnimationChannel[] = [];
        const t = vec3.create(), r = quat.create(), s = vec3.create();
        const seen = new Set<number>();
        const add = (nodeIndex: number) => {
            if (seen.has(nodeIndex)) return;
            seen.add(nodeIndex);
            const local = this._sourceLocal(nodeIndex) ?? skin.nodeTransforms?.get(nodeIndex);
            if (!local) return;
            decomposeTRS(local, t, r, s);
            samplers.push({ input: [0, 1], output: [r[0], r[1], r[2], r[3], r[0], r[1], r[2], r[3]], interpolation: 'LINEAR' } as AnimationSampler);
            channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: nodeIndex, targetPath: 'rotation' } as AnimationChannel);
            samplers.push({ input: [0, 1], output: [t[0], t[1], t[2], t[0], t[1], t[2]], interpolation: 'LINEAR' } as AnimationSampler);
            channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: nodeIndex, targetPath: 'translation' } as AnimationChannel);
        };
        for (const joint of skin.joints) add(joint.nodeIndex);
        for (const chain of this._topology().parentChain) for (const nodeIndex of chain ?? []) add(nodeIndex);
        return channels.length ? { name: 'ragdoll:held', samplers, channels } as Animation : null;
    }

    /** A Ragdoll or Get Up state entered since the reactions were last told (see _flushReactionEdge). */
    private _reactionEdge: 'ragdoll' | 'getUp' | null = null;
    private _flushingReactions = false;
    private _warnedNoReactions = false;
    private _warnedGetUpClip: Set<string> | null = null;
    /** The Get Up state's clip waits on its first frame: the body is not down yet, or its rise was cut short. */
    private _reactionHold = false;
    /** Bumped on every state entry: a Get Up clock handed out before is over once it changes. */
    private _stateToken = 0;
    /** The layers' weight while the base is in a Ragdoll or Get Up state (0) or not (1), faded over `_reactionMuteFade`. */
    private _reactionMute = 1;
    private _reactionMuteFade = 0.2;
    /** The base clip's root motion is off (a Get Up state's: the reactions place the character). */
    private _noRootMotion = false;
    /** Linked triggers: the count each last read; those raised by a count and not taken yet (lowered next frame). */
    private readonly _counterSeen = new Map<string, number>();
    private readonly _counterPulse = new Set<string>();
    private _effects: ReactionEffectsNow | null = null;
    private _effectsAt = -1;
    /** How much of foot and hand IK is on, as the two switches above fade it (1 on, 0 off). */
    private _footIkReaction = 1;
    private _handIkReaction = 1;
    /** Seconds to fade reaction-suppressed IK out, and back in. */
    private static readonly IK_REACTION_OUT = 0.15;
    private static readonly IK_REACTION_IN = 0.35;

    // When set, drives playback each frame instead of the AnimationMapping list. Parameter values are
    // live; triggers are consumed when a transition using them fires.
    private _stateMachine: AnimationStateMachine | null = null;
    private _paramValues: Map<string, number | boolean> = new Map();
    private _currentStateName: string | null = null;
    private _eventCallbacks: ((eventName: string, clipName: string) => void)[] = [];
    /** Stops this animator obeying the `animator:*` commands sent to its node (animatorCommands.ts). */
    private _unbindCommands: (() => void) | null = null;
    /** A layer's or slot's animator: the character's animator it plays for, and its layer's name. */
    private _overlayOwner: Animator | null = null;
    private _overlayName: string | null = null;
    private _prevEventTime: number = 0;
    /** A clip just started: the next event window opens before time 0, so a marker at 0 fires (see _fireDueEvents). */
    private _eventFromStart: boolean = false;
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
    private _fieldBoneCache: Map<string, { bones: Map<string, Bone>; duration: number; animation: Animation; pose?: boolean; field?: AnimationField | null }> = new Map();
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
    /** Per foot (keyed like `_ikFootWeights`): its foot lock, while one is held or fading out. */
    private _ikFootLocks: Map<number, FootLockState> = new Map();
    /**
     * Per foot (keyed like `_ikFootWeights`): the share of the pose that has it inside a clip foot-lock window,
     * damped, which swing release leaves planted however high it stands (a stair climb's upper foot).
     */
    private _ikPlantedShare: Map<number, number> = new Map();
    /** Per foot node: the key its clip foot-lock windows are stored under (footLockWindows.ts). */
    private _footLockKeys: Map<number, string> = new Map();
    /**
     * The share of the pose, at the last `_footLockWindow`, that has no foot-lock windows for that foot (a
     * cross-fade still showing Idle, say). Where it is above 0 the animation slides the feet as it blends, and a
     * lock does not catch a foot sliding faster than `lockCatchSpeed`.
     */
    private _footLockUnwindowed = 0;
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
    /** The cross-fade in flight is a sync group's (AnimationState.syncGroup): both fields on one phase. */
    private _syncedBlend: boolean = false;
    /**
     * The outgoing side of a cross-fade that INTERRUPTED another one: the pose that was on screen, per bone,
     * frozen. Taking the interrupted blend's target as the outgoing side instead would drop everything it was
     * still fading out of in one frame. Read before `_previousFieldEntries` / `_previousBones`; never advances.
     */
    private _frozenPrevious: Map<string, mat4> | null = null;

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
        // Commands sent down to the model node reach this animator (a layer's or slot's has no node of its own).
        if (this._node && !this._isOverlay) this._unbindCommands = bindAnimatorCommands(this._node, this);
        
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
        ANIMATOR_TALLY.add({
            animators: 1, joints: this._skin?.joints.length ?? 0, animations: animatedModel.animations.length,
        });

        // If model has animations, set the first one as default. None yet is not reported: a model on shared
        // clips gets them after it is built.
        if (animatedModel.animations.length > 0) this.playAnimation(0);
    }
    
    /** Play the animation at `animationIndex`. */
    public playAnimation(animationIndex: number, loop: boolean = true, blend: boolean = true): void {
        if (!this._animatedModel || animationIndex < 0 || animationIndex >= this._animatedModel.animations.length) {
            Logger.warn(`Animation index ${animationIndex} out of range`, 'Animation');
            return;
        }
        
        this._playClip(this._animatedModel.animations[animationIndex], loop, blend);
    }

    // Play a clip object — one of the model's, or a synthesized one such as a pose state's. With
    // `sameClipBlend`, restarting the clip already playing cross-fades from where it was instead of jumping.
    private _playClip(animation: Animation, loop: boolean, blend: boolean, sameClipBlend: boolean = false): void {
        this._overlayEmpty = false;
        // Must NOT test `_playing`: a finished non-looping clip holds its last frame with _playing false,
        // and that is exactly when a machine wants to cross-fade away from it. `_currentAnimation` being
        // null already covers the first play, the only case that must not blend.
        const blendOut = blend && (this._fieldEntries !== null
            || (!!this._currentAnimation && (this._currentAnimation !== animation || sameClipBlend)));

        if (blendOut && this._isBlending) {
            // Interrupting a cross-fade: fade out of what is on screen, not out of the blend's target alone.
            this._freezeOutgoingPose();
            this._previousLoop = this._loop;
            this._currentBlendTime = 0;
            this._activeBlendTime = this._blendTime; // a transition may override this right after
        } else if (blendOut) {
            // Store current animation state for blending
            this._frozenPrevious = null;
            this._previousAnimation = this._currentAnimation;
            this._previousBones = new Map(this._bones);
            this._capturePreviousField();
            this._capturePreviousRootPin();
            this._capturePreviousFrames();
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
            this._frozenPrevious = null;
        }

        this._clearField();
        this._syncedBlend = false;
        // Smooth unless a state says otherwise: `_enterState` sets the state's own rate right after.
        this._fps = 0;

        this._currentAnimation = animation;
        this._currentTime = 0;
        this._eventFromStart = true;
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
            if (!this._clipsPending()) Logger.warn(`Animation "${name}" not found`, 'Animation');
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

        // A pose clip's additive reference is its base pose (or rest), not its first frame, which is the pose itself.
        const refs = POSE_REFERENCES.get(animation);
        if (refs) for (const bone of bones.values()) { const ref = refs.get(bone.id); if (ref) bone.seedStart(ref.t, ref.r); }

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
                Logger.warn(`Animation "${animation.name}" has no channels targeting the skin joints. This animation may not work correctly.`, 'Animation');
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

    // Start playing a field, cross-fading out of whatever is posed. A different field starts at phase 0, or at
    // `startPhase` (a sync group's carried phase); re-entering the SAME field object carries its phase, so a
    // ping-ponging state does not stutter. Identity is by reference: each state embeds its own copy, so two
    // states never share one.
    private _startField(
        field: AnimationField,
        inputs: { x?: string; y?: string } | undefined,
        loop: boolean,
        blend: boolean,
        blendOverride?: number,
        startPhase?: number,
        restart = false,
    ): void {
        if (!this._animatedModel) return;
        // A layer coming out of an empty state shows again, as `_playClip` does for a clip.
        this._overlayEmpty = false;

        const hadSource = this._fieldEntries !== null || this._currentAnimation !== null;
        if (blend && hadSource && this._isBlending) {
            // Interrupting a cross-fade: see _playClip. The frozen pose has no phase to keep in step with.
            this._freezeOutgoingPose();
            this._previousLoop = this._loop;
            this._currentBlendTime = 0;
            this._activeBlendTime = blendOverride !== undefined ? Math.max(0, blendOverride) : this._blendTime;
        } else if (blend && hadSource) {
            this._frozenPrevious = null;
            this._previousAnimation = this._currentAnimation;
            this._previousBones = new Map(this._bones);
            this._capturePreviousField();
            // A synced hand-over from a blend space: the two run on one phase through the cross-fade.
            this._syncedBlend = startPhase !== undefined && this._previousFieldEntries !== null;
            this._capturePreviousRootPin();
            this._capturePreviousFrames();
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
            this._frozenPrevious = null;
            this._syncedBlend = false;
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
        // A one-shot entered again (a second hit's flinch) starts over, its probe snapped to where it reads now; one
        // that loops carries its phase, so a ping-ponging state does not stutter.
        if (!sameField || restart) {
            this._fieldPhase = 0;
            this._fieldWeightState.clear();
            this._fieldSampleMeta.clear();
            this._fieldWeightsSeeded = false;
            this._fieldDominant = null;
            this._fieldProbeSeeded = false;
        }
        if (!sameField) this._warnedMissingClips.clear();
        // A sync group's carried phase, set before the previous phase is: the markers it skips do not fire.
        if (startPhase !== undefined && Number.isFinite(startPhase)) this._fieldPhase = ((startPhase % 1) + 1) % 1;
        this._prevFieldPhase = this._fieldPhase;
        this._bones.clear();          // the field owns the pose now; stale clip bones must not leak through
        this._currentAnimation = null;
        this._currentTime = 0;
        this._loop = loop;
        this._playing = true;
        this._loopsPlayed = 0;
        this._loopLimit = 0;
        // Smooth unless a state says otherwise, as in `_playClip`.
        this._fps = 0;

        this._refreshFieldWeights();
        // After the refresh: the weighted duration is only known once the entries exist.
        this._currentTime = this._fieldPhase * this._fieldDuration(this._fieldEntries);
        this._prevEventTime = this._currentTime;
    }

    /**
     * The bone map + duration for a clip in the active field, built once and cached by clip name. A POSE sample
     * (`pose`) is its pose held as a clip (`_poseClipOf`) under the sample's key: one entry per key while the field
     * is the same (a blend space places one pose at many points), rebuilt when the field is swapped (an edit). One
     * fading out after its sample left the field is asked for without its pose, and the cache still has it.
     */
    private _fieldClip(clipName: string, pose?: AnimationPose): { bones: Map<string, Bone>; duration: number; animation: Animation; pose?: boolean } | null {
        const held = this._fieldBoneCache.get(clipName);
        if (pose || held?.pose) {
            if (held?.pose && (held.field === this._fieldDef || !pose)) return held;
            const clip = this._poseClipOf(pose!, pose!.name ?? clipName);
            if (held && held.animation === clip) { held.field = this._fieldDef; return held; }
            const entry = { bones: this._buildBoneMapFor(clip), duration: 1, animation: clip, pose: true, field: this._fieldDef };
            this._fieldBoneCache.set(clipName, entry);
            return entry;
        }
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
            const clip = this._fieldClip(w.sample.clipName, this._samplePose(field, w.sample.clipName, w.sample.pose));
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
                ...(clip.pose ? { pose: true } : {}),
            });
        }

        // Whatever is LEFT in `damped` is fading out and must still be posed. Its sample is gone, so rate
        // scale and phase offset come from the remembered meta — defaulting the offset to 0 would jog it.
        for (const [clipName, weight] of damped) {
            const clip = this._fieldClip(clipName, this._samplePose(field, clipName));
            if (!clip) continue;
            const meta = this._fieldSampleMeta.get(clipName);
            entries.push({
                clipName, animation: clip.animation, bones: clip.bones,
                duration: clip.duration, weight,
                rateScale: meta?.rateScale ?? 1,
                phaseOffset: meta?.phaseOffset ?? 0,
                ...(clip.pose ? { pose: true } : {}),
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

    // A pose sample's pose: on the sample, or the field's pose table's entry for its key (a variant there composed
    // onto its base: `resolveTablePose`). Undefined for a clip sample.
    private _samplePose(field: AnimationField, clipName: string, onSample?: AnimationPose): AnimationPose | undefined {
        if (onSample) return onSample;
        const entry = field.poses?.[clipName];
        return entry ? resolveTablePose(entry, field.poses) : undefined;
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
        if (this._clipsPending() || this._warnedMissingClips.has(clipName)) return;
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
        let d = 0, clips = 0, poses = 0;
        for (const e of entries) {
            if (e.pose) { poses += e.weight; continue; }
            d += e.weight * (e.duration / e.rateScale);
            clips += e.weight;
        }
        // A pose has no cycle: the clips' alone sets it, over their own weight; a field of poses only, one second.
        if (poses > 0) return clips > 1e-9 ? d / clips : 1;
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
        if (this._frozenPrevious) return this._frozenPrevious.get(key) ?? null;
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
            this._poseFieldAt(this._fieldEntries, this._samplePhase);
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
            this._poseFieldAt(this._fieldEntries, this._samplePhase);
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
        /** The outgoing blend space's phase while one cross-fades out, else null. */
        previousPhase: number | null;
        /** The cross-fade in flight is a sync group's: both sides on one phase. */
        synced: boolean;
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
            previousPhase: this._isBlending && this._previousFieldEntries ? this._previousFieldPhase : null,
            synced: this._syncedBlend && this._isBlending,
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
    /**
     * The normalized phase a transition into `next` carries (AnimationState.syncGroup): where the state being
     * left is in its cycle, when both are in one sync group and it loops (a field, or a looping clip). Null for any
     * other entry, a re-entry of the same state among them, which starts over.
     */
    private _syncedPhase(name: string, next: AnimationState | undefined): number | null {
        const group = next?.syncGroup;
        const sm = this._stateMachine;
        if (!group || !sm || !this._currentStateName || this._currentStateName === name) return null;
        if (this._stateByName(sm, this._currentStateName)?.syncGroup !== group || !this._loop) return null;
        return this._cyclePhase();
    }

    /** Where the current state is in its cycle, 0..1: a blend space's phase, a clip's time over its length. */
    private _cyclePhase(): number | null {
        if (this._fieldEntries) return this._fieldPhase;
        if (!this._currentAnimation) return null;
        const duration = this._getAnimationDuration();
        return duration > 0 ? (this._currentTime % duration) / duration : null;
    }

    /** The current state's sync group and phase, when it is a looping state in one: what a layer follows. */
    private _leadPhase(): { group: string; phase: number } | null {
        const sm = this._stateMachine;
        if (!sm || !this._currentStateName || !this._loop || !this._playing) return null;
        const group = this._stateByName(sm, this._currentStateName)?.syncGroup;
        if (!group) return null;
        const phase = this._cyclePhase();
        return phase === null ? null : { group, phase };
    }

    /**
     * Keep every layer whose state shares the base's sync group on the base's phase (AnimationState.syncGroup).
     * Runs after the base advanced this frame and before the pose is composed, so the layer is posed at this
     * frame's phase, not the last one's.
     */
    private _followSyncedLayers(pose: boolean): void {
        const lead = this._leadPhase();
        for (const o of this._overlays) {
            if (o.kind !== 'layer') continue;
            const child = o.animator;
            const sm = child._stateMachine;
            const state = sm && child._currentStateName ? child._stateByName(sm, child._currentStateName) : null;
            if (!lead || !state || state.syncGroup !== lead.group || child._overlayEmpty || !child._playing) continue;
            child._followPhase(lead.phase, pose, o.presence > 0);
        }
    }

    /**
     * Move this (layer) animator to `phase` of its current cycle, re-posing it when `pose`. A jump on screen (the
     * base came back into the group at another phase) cross-fades from the pose shown, over LAYER_REACQUIRE_BLEND.
     */
    private _followPhase(phase: number, pose: boolean, visible: boolean): void {
        const current = this._cyclePhase();
        if (current === null) return;
        const gap = Math.abs(phase - current);
        if (visible && pose && !this._isBlending && Math.min(gap, 1 - gap) > LAYER_REACQUIRE_GAP) {
            this._freezeOutgoingPose();
            this._currentBlendTime = 0;
            this._activeBlendTime = LAYER_REACQUIRE_BLEND;
        }
        const entries = this._fieldEntries;
        if (entries) {
            this._fieldPhase = phase;
            this._currentTime = phase * this._fieldDuration(entries);
            // A stepped layer takes the followed phase as its frame only on its own beat.
            if (this._tickedThisFrame) this._holdCurrentFrame();
            // A synced cross-fade inside the layer moves both of its sides on the one phase.
            if (this._isBlending && this._syncedBlend && this._previousFieldEntries) this._previousFieldPhase = phase;
            if (pose) {
                this._poseFieldAt(entries, this._samplePhase);
                if (this._isBlending && this._previousFieldEntries) this._poseFieldAt(this._previousFieldEntries,
                    this._previousFps > 0 ? this._previousHeldFieldPhase : this._previousFieldPhase);
            }
        } else {
            this._currentTime = phase * this._getAnimationDuration();
            if (this._tickedThisFrame) this._holdCurrentFrame();
            if (pose) { const t = this._sampleTime; for (const bone of this._bones.values()) bone.update(t); }
        }
    }

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
        // A Ragdoll or Get Up state forced since checkTriggers (forceState, resetStateMachine).
        if (this._reactionEdge !== null) this._flushReactionEdge();
        this._updatePosed(deltaTime);
        // A powered ragdoll: the animation above posed the target; the bodies carry the skin from it.
        if (this._physicsMapping) this._applyPhysicsMapping();
    }

    private _updatePosed(deltaTime: number): void {
        if (this._setWhileClipsPending) this._catchUpClips();
        this._capturePreviousPose(deltaTime);
        // A layer's animator poses whenever the animator it belongs to does; see _skipPose.
        if (!this._isOverlay) {
            this._skipPose = false;
            // Bodies drive this skeleton every frame: its target must be as fresh, unless the body has every part.
            if (this._lodStride > 1 && !this._physicsMapping) {
                this._lodCountdown--;
                if (this._lodCountdown > 0) this._skipPose = true;
                else this._lodCountdown = this._lodStride;
            } else if (this._physicsMapping?.loose && deltaTime > 0) {
                // Only on a frame that moves time: an update(0) is a measurement (a get-up lining its clip up with
                // the body), and must pose.
                this._looseSkip = !this._looseSkip;
                if (this._looseSkip) this._skipPose = true;
            }
            const muted = this.reactionKind ? 0 : 1;
            if (this._reactionMute !== muted) {
                const step = this._reactionMuteFade > 1e-4 ? Math.max(0, deltaTime) / this._reactionMuteFade : 1;
                this._reactionMute = muted < this._reactionMute ? Math.max(muted, this._reactionMute - step) : Math.min(muted, this._reactionMute + step);
            }
        }
        this._ikDelta += Math.max(0, deltaTime);
        if (!this._isOverlay) this._fadeReactionIk(deltaTime);
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

    /** Move the reaction IK weights toward their switches: out in IK_REACTION_OUT, in in IK_REACTION_IN. */
    private _fadeReactionIk(deltaTime: number): void {
        const dt = Math.max(0, deltaTime);
        const toward = (w: number, off: boolean) => off
            ? Math.max(0, w - dt / Animator.IK_REACTION_OUT)
            : Math.min(1, w + dt / Animator.IK_REACTION_IN);
        this._footIkReaction = toward(this._footIkReaction, this.ikSuppressed);
        this._handIkReaction = toward(this._handIkReaction, this.handIkSuppressed);
    }

    /** Foot IK's memory dropped (locks, ground hits, weights, the hip drop): it starts over when it comes back. */
    private _forgetFootIk(): void {
        this._ikFootWeights.clear();
        this._ikFootHits.clear();
        this._ikFootLocks.clear();
        this._ikPlantedShare.clear();
        this._ikHipOffset = 0;
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
    /** Every other frame skipped while a loose body draws the skeleton (see PhysicsMappingSource.loose). */
    private _looseSkip = false;
    /** Wall-clock time since foot IK last ran, so its smoothing keeps real time across skipped frames. */
    private _ikDelta = 0;

    /**
     * Pick the LOD tier from what the camera saw last frame. Called by ModelNode before each update.
     * `culled`: the model is hidden by a draw distance (Node.drawDistance) — no pose at all until it is
     * back. Honoured even with `lod.enabled` off, since nothing that shows the pose is drawn.
     */
    public setLod(visible: boolean, distance: number, culled = false): void {
        const lod = Animator.lod;
        let stride = 1;
        let ik = true;
        if (culled && !this.lodExempt) {
            // Infinite stride: one pose on the tier change (countdown 1), then none until the tier changes
            // back, which again poses on the very next frame.
            stride = Number.POSITIVE_INFINITY;
            ik = false;
        } else if (lod.enabled && !this.lodExempt) {
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
        this._tickedThisFrame = false;

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
        // A Get Up state waiting for the body to come to rest: on its first frame.
        if (this._reactionHold) this._deltaTime = 0;
        this._frameDelta = deltaTime;

        // Update blend time if blending. In playback time (a state played faster blends in faster), except for a
        // HELD state, at speed 0: it still blends in, over the blend's seconds, or it never would and its pose
        // would stay the one it blended from (a held blend space of look poses on a layer added nothing).
        if (this._isBlending) {
            this._currentBlendTime += this._speed > 0 ? this._deltaTime : this._frameDelta;
            if (this._currentBlendTime >= this._activeBlendTime) {
                // Blend complete
                this._isBlending = false;
                this._previousAnimation = null;
                this._previousBones.clear();
                this._previousFieldEntries = null;
                this._frozenPrevious = null;
                this._syncedBlend = false;
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
            // A synced cross-fade (sync groups) moves both sides on one phase, at the rate of the cycle the blend
            // shows: the outgoing one's length mixed into this one's by the blend's progress.
            let cycle = duration;
            if (this._syncedBlend && this._isBlending && this._previousFieldEntries && this._previousAdvancing) {
                const previous = this._fieldDuration(this._previousFieldEntries);
                const alpha = this._activeBlendTime > 0 ? Math.min(1, this._currentBlendTime / this._activeBlendTime) : 1;
                if (previous > 0) cycle = previous + (duration - previous) * alpha;
            }
            if (cycle > 0) this._fieldPhase += this._deltaTime / cycle;
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

        // Stop motion: on the beat, the clock's time becomes the frame on screen. A clip that finished just now
        // shows its last key, whatever the beat (`_playing` was true above, so false here means just now).
        this._tickFrame(deltaTime, !this._playing);

        // A field's `_currentTime` is not monotonic — the weighted duration moves — so both phases are
        // projected through the SAME duration before the markers are compared.
        if (this._fieldEntries) {
            this._fireDueEvents(this._prevFieldPhase * duration, this._fieldPhase * duration, duration, looped);
        } else {
            this._fireDueEvents(prevTime, this._currentTime, duration, looped);
        }

        // Update all bones with current animation time — unless the LOD skips this frame's pose, in which
        // case only what gameplay reads (time, events above, root motion below) moves on. A stepped state
        // samples its held frame, every posed frame: a blend-space clip fading in between beats must be posed too.
        const pose = !this._skipPose;
        if (this._fieldEntries) {
            if (pose) this._poseFieldAt(this._fieldEntries, this._samplePhase);
        } else {
            if (pose) { const t = this._sampleTime; for (const bone of this._bones.values()) bone.update(t); }
            // After the pose loop: it drives the character, then pins the root bone to the locked reference.
            // Every frame: root motion samples the root bone on its own, and it is what moves the character.
            if (this._rootMotionActive) this._applyRootMotion(prevTime, this._currentTime, duration, looped);
        }

        // The outgoing motion keeps playing under the cross-fade; freezing it stops the legs mid-stride.
        if (this._isBlending && this._previousFieldEntries) {
            if (this._previousAdvancing && this._syncedBlend) {
                this._previousFieldPhase = this._fieldPhase;
            } else if (this._previousAdvancing) {
                const previousDuration = this._fieldDuration(this._previousFieldEntries);
                if (previousDuration > 0) this._previousFieldPhase += this._deltaTime / previousDuration;
                if (this._previousFieldPhase >= 1) {
                    this._previousFieldPhase = this._previousLoop ? this._previousFieldPhase % 1 : 1;
                }
            }
            this._tickPreviousFrame(deltaTime);
            // The outgoing field keeps its snapshot weights; the live probe must not steer it.
            if (pose) this._poseFieldAt(this._previousFieldEntries,
                this._previousFps > 0 ? this._previousHeldFieldPhase : this._previousFieldPhase);
        } else if (this._isBlending && this._previousAnimation) {
            if (this._previousAdvancing) {
                const previousDuration = this._getPreviousAnimationDuration();
                this._previousTime += this._deltaTime;
                if (this._previousTime >= previousDuration) {
                    // Only a looping clip wraps; wrapping a finished one restarts it under the blend.
                    this._previousTime = this._previousLoop ? this._previousTime % previousDuration : previousDuration;
                }
            }
            this._tickPreviousFrame(deltaTime);
            // Not advancing means the clip finished before the blend began; it holds its last pose.
            if (pose) {
                const t = this._previousFps > 0 ? this._previousHeldTime : this._previousTime;
                for (const bone of this._previousBones.values()) bone.update(t);
                // The re-sample above overwrote the outgoing clip's root pin; put it back.
                this._pinPreviousRoot();
            }
        }

        // Layers in this state's sync group take this frame's phase before the pose is composed.
        if (!this._isOverlay && this._overlays.length) this._followSyncedLayers(pose);

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
        if (this._isOverlay ? !this._extractRoot : (!animation.rootMotion || this._noRootMotion)) return;

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
            // Two spans across the loop point: prev→end and start→cur. The second walks on from where the
            // whole cycle left the body facing: turned by the loop's own turn (end against start).
            const end = bone.sampleTR(duration);
            const start = bone.sampleTR(0);
            vec3.sub(deltaT, end.t, prev.t);
            const seg2 = vec3.create();
            vec3.sub(seg2, cur.t, start.t);
            const loopTurn = quat.multiply(quat.create(), end.r, quat.invert(quat.create(), start.r));
            vec3.transformQuat(seg2, seg2, loopTurn);
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

        // The travel is in the clip's frame, but the target has already turned by every rotation applied so far
        // (prev against the pin), and Wp below includes that turn. Undo it, or a clip that turns AND travels (a
        // quarter turn, then a step) has its later travel turned twice: the step goes sideways.
        const turned = quat.multiply(quat.create(), this._rootRefR, quat.invert(quat.create(), prev.r));
        vec3.transformQuat(deltaT, deltaT, turned);

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
                // In WORLD space, so a target under a moved or turned parent travels the clip's world delta.
                target.setWorldPosition(vec3.add(vec3.create(), target.worldPosition, worldT));
                // A world-space rotation delta LEFT-multiplies the target's world orientation;
                // setWorldQuaternion also turns its body.
                const worldR = quat.multiply(quat.create(), quat.multiply(quat.create(), wp, deltaR), wpInv);
                target.setWorldQuaternion(quat.normalize(quat.create(), quat.multiply(quat.create(), worldR, target.worldQuaternion)));
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

        // Pin the horizontal position to the start; keep the clip's own rotation and height -- the HELD frame's,
        // when the state steps, or the hips would turn smoothly under a body that holds still.
        const shown = this._fps > 0 ? bone.sampleTR(this._heldTime) : cur;
        const t = vec3.clone(shown.t);
        for (let a = 0; a < 3; a++) if (a !== up) t[a] = this._rootRefT[a];
        const pinned = mat4.fromRotationTranslationScale(mat4.create(), shown.r, t, this._rootRefS);
        bone.setLocalTransform(pinned);
        void curTime;
    }

    /**
     * A cross-fade is interrupted by another: freeze the pose on screen (the base cross-fade's mix, per bone,
     * exactly what `_sourceLocal` returns) as the outgoing side, and drop the clips it was mixed from, so
     * nothing outgoing advances or carries a root pin. Layers and IK go on top afterwards as usual.
     */
    private _freezeOutgoingPose(): void {
        const frozen = new Map<string, mat4>();
        const skin = this._skin;
        if (skin) {
            const add = (nodeIndex: number) => {
                const key = boneKey(nodeIndex);
                if (frozen.has(key)) return;
                const local = this._sourceLocal(nodeIndex);
                if (local) frozen.set(key, mat4.clone(local));
            };
            for (const joint of skin.joints) add(joint.nodeIndex);
            for (const chain of this._topology().parentChain) for (const nodeIndex of chain) add(nodeIndex);
        }
        this._frozenPrevious = frozen;
        this._previousAnimation = null;
        this._previousBones = new Map();
        this._previousFieldEntries = null;
        this._prevRootBoneName = null;
        this._previousAdvancing = false;
        this._previousFps = 0;   // a frozen pose has no clip left to step
        this._isBlending = true;
        this._syncedBlend = false;
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

    // The current state's stop-motion frames as the outgoing side's: under the cross-fade it keeps stepping at its
    // own rate, on the same beat (the clock is copied, not restarted), so both sides change pose together.
    private _capturePreviousFrames(): void {
        this._previousFps = this._fps;
        this._previousFrameClock = this._frameClock;
        this._previousHeldTime = this._heldTime;
        this._previousHeldFieldPhase = this._heldFieldPhase;
    }

    /**
     * Run the stop-motion frame clock by `deltaTime` game seconds and, on the beat, take the frame now on the
     * continuous clock as the held one. `force` takes it whatever the clock says (a clip that just finished
     * ends on its last key). Smooth (`_fps` 0): nothing to hold.
     */
    private _tickFrame(deltaTime: number, force: boolean): void {
        if (!(this._fps > 0)) { this._frameClock = 0; return; }
        this._frameClock += Math.max(0, deltaTime);
        const left = takeFrame(this._frameClock, this._fps);
        if (left >= 0) this._frameClock = left;
        else if (!force) return;
        this._heldTime = this._currentTime;
        this._heldFieldPhase = this._fieldPhase;
        this._tickedThisFrame = true;
    }

    /** {@link _tickFrame} for the outgoing side of a cross-fade, on its own state's rate. */
    private _tickPreviousFrame(deltaTime: number): void {
        if (!(this._previousFps > 0)) return;
        this._previousFrameClock += Math.max(0, deltaTime);
        const left = takeFrame(this._previousFrameClock, this._previousFps);
        if (left < 0) return;
        this._previousFrameClock = left;
        this._previousHeldTime = this._previousTime;
        this._previousHeldFieldPhase = this._previousFieldPhase;
    }

    /** Take the frame on the continuous clock as the held one now: a state's first frame, a scrub, an edit. */
    private _holdCurrentFrame(): void {
        this._heldTime = this._currentTime;
        this._heldFieldPhase = this._fieldPhase;
    }

    /** The clip time / field phase to SAMPLE at: the held frame when the state steps, the live clock otherwise. */
    private get _sampleTime(): number { return this._fps > 0 ? this._heldTime : this._currentTime; }
    private get _samplePhase(): number { return this._fps > 0 ? this._heldFieldPhase : this._fieldPhase; }

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
        this._syncedBlend = false;
        this._frozenPrevious = null;
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
            this._ikFootLocks.clear();
            this._ikPlantedShare.clear();
            this._footLockKeys.clear();
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
    // Copies of the last pose's locals, kept only once `posedLocal` has been asked for (the editor's pose gizmo):
    // `_poseLocals` holds scratch that the next character to pose reuses.
    private _keepPosedLocals = false;
    private readonly _posedLocalCopies = new Map<number, mat4>();

    /**
     * A node's LOCAL transform in the last pose, everything applied (layers, IK, editor overrides): what the
     * editor's pose gizmo turns a bone from. Null before the first pose, and on a layer's own animator. The
     * first call starts keeping copies, re-posing once to fill them.
     */
    public posedLocal(nodeIndex: number): mat4 | null {
        if (this._isOverlay) return null;
        if (!this._keepPosedLocals) { this._keepPosedLocals = true; this._recomputePose(); }
        const m = this._posedLocalCopies.get(nodeIndex);
        return m ? mat4.clone(m) : null;
    }

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
        for (const o of this._overlays) {
            o.steadyNow = o.kind === 'layer' && o.blend !== 'additive' && o.presence > 0 ? o.animator._steadyNow() : 0;
        }
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
        // The support hands first: foot IK's pelvis drop then carries both hands together.
        this._handIkActive = null;
        if (this._overlays.length) this._applyHandIk(localTransforms, globalTransforms, topo);
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
        if (this._physicsMapping) this._keepTarget();
        if (this._keepPosedLocals) {
            for (const [nodeIndex, local] of localTransforms) {
                let copy = this._posedLocalCopies.get(nodeIndex);
                if (!copy) { copy = mat4.create(); this._posedLocalCopies.set(nodeIndex, copy); }
                mat4.copy(copy, local);
            }
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

    // ---- Support-hand IK --------------------------------------------------------------------------
    // A layer's `handIk`: one hand reaching where the layer's own pose puts it relative to the other. Model space,
    // after every layer and before foot IK.

    // Each arm's chain (upper arm, forearm, hand, by node), the joint both arms hang from, and the nodes from that
    // joint down to each hand. Found once per skin by humanoid slot; null when the skin has no two hands.
    private _handChainsCache: {
        left: [number, number, number]; right: [number, number, number];
        fromCommon: { left: number[]; right: number[] };
    } | null | undefined = undefined;

    private _handChains(topo: SkeletonTopology): NonNullable<Animator['_handChainsCache']> | null {
        if (this._handChainsCache !== undefined) return this._handChainsCache;
        const skin = this._skin!;
        const handJoint = (slot: string): number => {
            for (let j = 0; j < skin.joints.length; j++) {
                const name = skin.nodeNames?.get(skin.joints[j].nodeIndex);
                if (name && humanoidSlotOf(name) === slot) return j;
            }
            return -1;
        };
        const chainOf = (hand: number): [number, number, number] | null => {
            const fore = hand >= 0 ? topo.parentJoint[hand] : -1;
            const upper = fore >= 0 ? topo.parentJoint[fore] : -1;
            return upper >= 0 ? [skin.joints[upper].nodeIndex, skin.joints[fore].nodeIndex, skin.joints[hand].nodeIndex] : null;
        };
        const lh = handJoint('hand.L'), rh = handJoint('hand.R');
        const left = chainOf(lh), right = chainOf(rh);
        if (!left || !right) return (this._handChainsCache = null);
        // The joints above each hand, nearest first; the first one the left hand's line shares is the common one.
        const above = (j: number) => { const out: number[] = []; for (let p = topo.parentJoint[j], g = 0; p >= 0 && g < 256; p = topo.parentJoint[p], g++) out.push(p); return out; };
        const rightUp = new Set(above(rh));
        const common = above(lh).find(j => rightUp.has(j));
        if (common === undefined) return (this._handChainsCache = null);
        // The nodes from the common joint (not included) down to a hand: joints and the non-joint nodes between.
        const down = (hand: number): number[] => {
            const out: number[] = [];
            for (let j = hand, g = 0; j >= 0 && j !== common && g < 256; j = topo.parentJoint[j], g++) {
                out.unshift(skin.joints[j].nodeIndex);
                out.unshift(...(topo.parentChain[j] ?? []));
            }
            return out;
        };
        return (this._handChainsCache = { left, right, fromCommon: { left: down(lh), right: down(rh) } });
    }

    // The product of a layer's own locals along `nodes` (top-down): a hand's transform relative to the common joint,
    // as the layer's pose has it. A node the layer does not hold is taken as the body has it.
    private _layerChain(out: mat4, nodes: number[], o: Overlay, localTransforms: Map<number, mat4>): mat4 {
        mat4.identity(out);
        for (const n of nodes) {
            const local = o.animator._sourceLocal(n) ?? localTransforms.get(n) ?? this._skin!.nodeTransforms?.get(n) ?? IDENTITY;
            mat4.multiply(out, out, local);
        }
        return out;
    }

    private _applyHandIk(localTransforms: Map<number, mat4>, globalTransforms: Map<number, mat4>, topo: SkeletonTopology): void {
        for (const o of this._overlays) {
            const ik = o.handIk;
            if (!ik || o.kind !== 'layer' || o.presence <= 0) continue;
            let w = ik.weight ?? 1;
            if (ik.weightParam) {
                const v = this._paramValues.get(ik.weightParam);
                if (typeof v === 'number') w = v;
                else if (typeof v === 'boolean') w = v ? 1 : 0;
            }
            w = clamp(w, 0, 1) * this._overlayWeight(o) * o.presence;
            if (w > 0.5) this._handIkActive = ik.hand;
            w *= this._handIkReaction;
            if (!(w > 1e-4)) continue;
            const chains = this._handChains(topo);
            if (!chains) return;
            const reach = ik.hand === 'left' ? chains.left : chains.right;
            const lead = ik.hand === 'left' ? chains.right : chains.left;
            const leadGlobal = globalTransforms.get(lead[2]);
            const upper = globalTransforms.get(reach[0]), fore = globalTransforms.get(reach[1]), hand = globalTransforms.get(reach[2]);
            if (!leadGlobal || !upper || !fore || !hand) continue;

            // Where the hand goes: on the socket, or where the layer's pose has it relative to the other hand.
            if (ik.socket) {
                const skin = this._skin!;
                if (!socketModelMatrix(HIK_TARGET, skin, ik.socket, j => globalTransforms.get(skin.joints[j].nodeIndex) ?? null)) continue;
            } else {
                const leadChain = this._layerChain(HIK_LEAD, ik.hand === 'left' ? chains.fromCommon.right : chains.fromCommon.left, o, localTransforms);
                const reachChain = this._layerChain(HIK_REACH, ik.hand === 'left' ? chains.fromCommon.left : chains.fromCommon.right, o, localTransforms);
                if (!mat4.invert(HIK_TMP, leadChain)) continue;
                mat4.multiply(HIK_TARGET, leadGlobal, mat4.multiply(HIK_TMP, HIK_TMP, reachChain));
            }

            mat4.getTranslation(HIK_ROOT, upper);
            mat4.getTranslation(HIK_MID, fore);
            mat4.getTranslation(HIK_TIP, hand);
            vec3.lerp(HIK_GOAL, HIK_TIP, mat4.getTranslation(HIK_AT, HIK_TARGET), w);
            // No pole: the arm keeps the bend plane its pose has (the elbow where the pose put it).
            const solve = solveTwoBone({ root: HIK_ROOT, mid: HIK_MID, tip: HIK_TIP, target: HIK_GOAL });
            this._rotateGlobal(reach[0], solve.rootDelta, localTransforms, globalTransforms, topo);
            this._reaccumulate(localTransforms, globalTransforms, topo, reach[0]);
            this._rotateGlobal(reach[1], solve.midDelta, localTransforms, globalTransforms, topo);
            this._reaccumulate(localTransforms, globalTransforms, topo, reach[1]);

            // And the hand turned onto the target's frame, by the same weight.
            decomposeTRS(globalTransforms.get(reach[2])!, HIK_T, HIK_CUR, HIK_S);
            decomposeTRS(HIK_TARGET, HIK_T, HIK_WANT, HIK_S);
            quat.multiply(HIK_WANT, HIK_WANT, quat.invert(HIK_CUR, HIK_CUR));
            quat.slerp(HIK_WANT, quat.identity(HIK_ID), HIK_WANT, w);
            this._rotateGlobal(reach[2], HIK_WANT, localTransforms, globalTransforms, topo);
            this._reaccumulate(localTransforms, globalTransforms, topo, reach[2]);
        }
    }

    // ---- Foot IK ----------------------------------------------------------------------------------
    // Plant each foot on whatever is under it and lower the pelvis when a leg cannot reach. Works in the
    // MODEL-space pose; the ground query is a world raycast brought back through inverse(worldTransform).
    // A no-op without a rig, without physics, or at zero weight.

    // The IK weight this frame: the current state's, or the parameter it names. A missing parameter
    // keeps the static weight rather than reading 0.
    private _stateIkWeight(): number {
        // An action that turns IK off (a roll) eases it out as the action fades in, and back as it fades out.
        // A layer state does the same through its own ikWeight (an Actions layer's roll), by how much of the
        // layer shows: its weight times its presence.
        let actions = 1;
        for (const o of this._overlays) {
            if (o.presence <= 0) continue;
            if (o.kind === 'slot') {
                if (o.action && o.action.ikWeight < 1) actions *= 1 + (o.action.ikWeight - 1) * o.presence;
                continue;
            }
            const child = o.animator;
            const w = child._overlayEmpty ? child._overlayFadeIkWeight : child._stateIkWeightOfState();
            if (w < 1) actions *= 1 + (w - 1) * o.presence * this._overlayWeight(o);
        }
        return actions * this._stateIkWeightOfState();
    }

    /**
     * Tell the character this animator animates whether its current state holds it still (`holdMovement`): the
     * first ancestor with an `animationHold` field (a CharacterNode), as root motion finds its body. Written every
     * evaluation, so leaving the state lets go on the next frame.
     */
    private _publishMovementHold(): void {
        if (this._isOverlay || !this._node) return;
        const sm = this._stateMachine;
        const state = sm && this._currentStateName ? this._stateByName(sm, this._currentStateName) : null;
        // A Ragdoll or Get Up state holds it too: the body (the reactions) has it.
        const hold = !!state?.holdMovement || !!state?.ragdoll || !!state?.getUp;
        let n: Node | null = this._node.parent;
        while (n && typeof (n as { animationHold?: unknown }).animationHold !== 'boolean') n = n.parent;
        if (n) (n as unknown as { animationHold: boolean }).animationHold = hold;
    }

    /** Whether the current base-layer state allows foot locking (a cross-fade's TARGET decides). */
    private _stateFootLock(): boolean {
        const sm = this._stateMachine;
        const state = sm && this._currentStateName ? this._stateByName(sm, this._currentStateName) : null;
        return state?.footLock !== false;
    }

    /** Whether the base state plants its feet by the clips' windows, at any height (AnimationState.plantInWindows). */
    private _statePlantsInWindows(): boolean {
        const sm = this._stateMachine;
        const state = sm && this._currentStateName ? this._stateByName(sm, this._currentStateName) : null;
        return !!state?.plantInWindows;
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
        // Feet are not planted on a body lying down or rising, unless the state says otherwise.
        const kindDefault = !this._isOverlay && (state.ragdoll || state.getUp) ? 0 : 1;
        return typeof state.ikWeight === 'number' ? clamp(state.ikWeight, 0, 1) : kindDefault;
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
        if (this._footIkReaction <= 1e-3) {
            if (this._ikFootWeights.size || this._ikFootLocks.size || this._ikHipOffset !== 0) this._forgetFootIk();
            return false;
        }
        const rig = this._skin?.ikRig;
        if (!rig || !rig.feet?.length || !this._node) return false;

        const physics = this._node.scene?.physics;
        if (!physics) return false;

        // Only the chains the skeleton supports: a rig can name the right bones and still not be a leg.
        const checked = this._validatedRig(rig, topo);
        if (checked.feet.length === 0) return false;

        const weight = this._stateIkWeight() * this._footIkReaction;
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
        // foot's animated height, so it cannot be decided inside this loop.
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
                // what a foot ray used to cost. And only the rig's trace layers: the steps of a stair, not
                // the ramp laid over them for the capsule.
                hit = physics.raycast(from, to, { ignore: ownBody, groundOnly: true, layerMask: tuning.traceLayers });
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
                this._ikFootLocks.delete(key);
                this._ikPlantedShare.delete(key);
                continue;
            }

            const plan = plans[planCount] ??= { chain, ankle: vec3.create(), target: vec3.create(),
                                                normal: vec3.create(), weight: 0, along: 0, height: 0,
                                                lockPoint: vec3.create(), lockWeight: 0, lockDir: vec3.create(), lockPlanar: false };
            planCount++;
            plan.chain = chain;
            plan.lockWeight = 0;
            const ankle = mat4.getTranslation(plan.ankle, ankleGlobal);
            const hitModel = vec3.transformMat4(IK_HIT_MODEL, ground.point, worldToModel);
            const normalModel = vec3.transformMat4(plan.normal, ground.normal, worldToModel);
            vec3.sub(normalModel, normalModel, originModel);
            if (vec3.length(normalModel) > 1e-8) vec3.normalize(normalModel, normalModel);

            // The ankle sits a foot's height above the sole, or the whole foot sinks through the ground.
            const desired = vec3.scaleAndAdd(plan.target, hitModel, up, tuning.footHeight);
            plan.along = vec3.dot(vec3.sub(IK_TMP, desired, ankle), up);
            plan.height = vec3.dot(ankle, up);
            plan.weight = next;
        }

        // ---- Pass 1b: let go of the feet that are mid-swing --------------------------------------------
        // A swing is what the ANIMATION lifts a foot by, measured against the lowest animated foot. Never the
        // foot's clearance above its own ground: across a slope the ground under the two feet differs, and
        // that difference read as lift — the downhill foot was released and floated, and an uphill swing foot
        // became the "planted" reference and was pulled down onto the slope. One foot is its own reference.
        let ref = Infinity;
        for (let i = 0; i < planCount; i++) ref = Math.min(ref, plans[i].height);
        const plantInWindows = this._statePlantsInWindows();

        for (let i = 0; i < planCount; i++) {
            const plan = plans[i];
            // In a state that plants by the clips' windows (AnimationState.plantInWindows), a foot inside one of
            // its clip's foot-lock windows is PLANTED, by the clip's own account, however far above the lowest foot
            // it is: the upper foot of a stair climb stands a riser higher than the lower one, and released it
            // would float over its tread. The share of the pose that says so, damped over the rig's smoothing so a
            // window's edge (or the state's) does not pop the foot; outside every window, or in any other state,
            // the release decides alone, as it always did (a flat clip keeps the release it was tuned with).
            const shares = plantInWindows ? this._footLockShares(plan.chain.foot) : null;
            const planted = shares && shares.total > 0 ? shares.inside / shares.total : 0;
            const before = this._ikPlantedShare.get(plan.chain.foot) ?? 0;
            const share = tuning.smoothing > 0 && dt > 0 ? dampTime(before, planted, tuning.smoothing, dt) : planted;
            if (share > 1e-4) this._ikPlantedShare.set(plan.chain.foot, share);
            else this._ikPlantedShare.delete(plan.chain.foot);
            // The release only stops a lifted foot being pulled DOWN. A foot inside the ground is pushed out
            // of it mid-swing too, or a stride over rising ground clips through it. No jump where `along`
            // changes sign: the correction there is zero either way.
            if (plan.along <= 0) plan.weight *= share + (1 - share) * swingReleaseWeight(plan.height - ref, tuning.swingRelease);
        }

        // ---- Pass 1c: foot locking -------------------------------------------------------------------
        // A foot the animation has planted holds its spot and heading while the body moves or turns over it,
        // and lets go when the animation lifts it. Not in the air: there is nothing to stand on.
        if (tuning.footLock > 0 && !airborne) {
            const origin = mat4.getTranslation(IK_LOCK_ORIGIN, nodeWorld);
            mat3.fromMat4(IK_LOCK_M3, nodeWorld);
            mat3.fromMat4(IK_LOCK_M3_INV, worldToModel);
            // "Down" is measured on the point that holds the ground (the toe where there is one), against the
            // lowest such point, as swing release measures the ankles.
            let lowest = Infinity;
            for (let i = 0; i < planCount; i++) lowest = Math.min(lowest, vec3.dot(this._lockedPoint(plans[i], globalTransforms, IK_LOCK_POINT), up));
            const allowed = this._stateFootLock() && !this.footLockSuppressed;
            for (let i = 0; i < planCount; i++) {
                this._lockFoot(plans[i], lowest, origin, nodeWorld, worldToModel, up, upWorld, tuning, dt, globalTransforms, allowed);
            }
        } else if (this._ikFootLocks.size > 0) {
            this._ikFootLocks.clear();
        }

        // A released foot must not be solved AT ALL: `solveTwoBone` clamps to `maxReach`, so even an
        // identity solve pulls a straight leg in by a couple of millimetres. Compacted in place. A foot whose
        // lock is still fading out stays, though swing release has let go of its height.
        let activeCount = 0;
        for (let i = 0; i < planCount; i++) {
            const plan = plans[i];
            if (plan.weight > 1e-3 || plan.lockWeight > 1e-3) {
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
                localTransforms, globalTransforms, topo, plan.lockWeight, plan.lockPoint, plan.lockDir, plan.lockPlanar);
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
        lockWeight: number = 0,
        lockPoint: vec3 | null = null,
        lockDir: vec3 | null = null,
        lockPlanar: boolean = false,
    ): void {
        const hipG = globalTransforms.get(chain.thigh), kneeG = globalTransforms.get(chain.shin);
        const ankleG = globalTransforms.get(chain.foot);
        if (!hipG || !kneeG || !ankleG) return;
        const hip = mat4.getTranslation(IK_HIP, hipG);
        const knee = mat4.getTranslation(IK_KNEE, kneeG);
        const ankle = mat4.getTranslation(IK_ANKLE, ankleG);

        // Ease by the foot's weight rather than snapping: ikWeight = 0 is exactly the animated pose.
        const eased = vec3.lerp(IK_EASED, ankle, target, weight);
        // A locked foot goes where it was planted. An ankle lock includes the height (on a slope the ground under
        // the animated ankle is not the ground the foot stands on); a toe lock moves the foot along the ground only.
        if (lockWeight > 0 && lockPoint) {
            const unlocked = vec3.copy(IK_UNLOCKED, eased);
            if (lockPlanar) {
                const along = vec3.sub(IK_LOCK_D, lockPoint, eased);
                vec3.scaleAndAdd(along, along, up, -vec3.dot(along, up));
                vec3.scaleAndAdd(eased, eased, along, lockWeight);
            } else vec3.lerp(eased, eased, lockPoint, lockWeight);
            // Letting go, never stretched further by the lock than LOCK_MAX_STRETCH (or the animation's own
            // stretch): the target stops where the line from the unlocked target toward the lock leaves that reach.
            const legLength = vec3.distance(hip, knee) + vec3.distance(knee, ankle);
            const reach = Math.max(LOCK_MAX_STRETCH * legLength, vec3.distance(hip, unlocked));
            if (vec3.distance(hip, eased) > reach) {
                const pull = vec3.sub(IK_LOCK_PULL, eased, unlocked);
                const from = vec3.sub(IK_LOCK_FROM_HIP, unlocked, hip);
                const a = vec3.dot(pull, pull), b = vec3.dot(pull, from), c = vec3.dot(from, from) - reach * reach;
                // |from + t pull| = reach, for t in [0, 1]: c <= 0 (the unlocked target is within reach), so real.
                const t = a > 1e-12 ? clamp((-b + Math.sqrt(Math.max(0, b * b - a * c))) / a, 0, 1) : 0;
                // How far the lock has let go: 0 held (the leg may go straight), 1 gone (the cap in full).
                const letGo = tuning.footLock > 0 ? 1 - clamp(lockWeight / tuning.footLock, 0, 1) : 1;
                vec3.scaleAndAdd(eased, unlocked, pull, 1 - letGo * (1 - t));
            }
        }

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

        // A locked foot keeps the heading it was planted with: the body turns over it, the foot does not. Not while
        // the foot stands steeply on its toe, whose flattened direction is noise.
        if (lockWeight > 0 && lockDir && chain.toe !== undefined && vec3.squaredLength(lockDir) > 0) {
            const toeG = globalTransforms.get(chain.toe), footG = globalTransforms.get(chain.foot);
            const dir = toeG && footG ? vec3.sub(IK_LOCK_D, mat4.getTranslation(IK_LOCK_D, toeG), mat4.getTranslation(IK_LOCK_D2, footG)) : null;
            const level = dir ? Math.hypot(...planarOf(dir, up)) > vec3.length(dir) * FOOT_LOCK_LEVEL : false;
            if (dir && level) {
                const angle = clamp(planarSignedAngle(dir, lockDir, up), -FOOT_LOCK_MAX_TWIST, FOOT_LOCK_MAX_TWIST) * lockWeight;
                if (Math.abs(angle) > 1e-4) {
                    quat.setAxisAngle(IK_TWIST, up, angle * DEG2RAD);
                    this._rotateGlobal(chain.foot, IK_TWIST, localTransforms, globalTransforms, topo);
                    this._reaccumulate(localTransforms, globalTransforms, topo, chain.foot);
                }
            }
        }
    }

    /**
     * What the posed clips say about one foot (by its node): the weighted share of them inside a foot-lock window
     * for it, or null when too little of the pose has windows for that foot (under half its weight) and the foot is
     * left to detection. Weighted as the base pose is: a blend space's samples each at their own time, a cross-fade's
     * two sides by the blend. A frozen interrupted pose and a pose state carry no windows.
     */
    private _footLockWindow(footNode: number): number | null {
        const { total, withData, inside } = this._footLockShares(footNode);
        this._footLockUnwindowed = total > 0 ? Math.max(0, 1 - withData / total) : 0;
        if (!(total > 0) || withData < total * 0.5) return null;
        return inside / withData;
    }

    /**
     * The posed clips' foot-lock windows for one foot (by its node), weighted as the base pose is (see
     * `_footLockWindow`): the pose's whole weight, the share of it from clips with windows for that foot, and the
     * share of it inside one of them. No side effects.
     */
    private _footLockShares(footNode: number): { total: number; withData: number; inside: number } {
        let key = this._footLockKeys.get(footNode);
        if (key === undefined) {
            key = footLockKey(this._skin?.nodeNames?.get(footNode) ?? String(footNode));
            this._footLockKeys.set(footNode, key);
        }
        let total = 0, withData = 0, inside = 0;
        const add = (clip: Animation | null, time: number, w: number) => {
            if (!(w > 0)) return;
            total += w;
            const v = clip ? footLockAt(clip, key!, time) : null;
            if (v === null) return;
            withData += w;
            inside += v * w;
        };
        const addField = (entries: FieldEntry[], phase: number, scale: number) => {
            for (const e of entries) {
                let p = phase + e.phaseOffset;
                if (p > 1) p -= 1;
                add(e.animation, p * e.duration, e.weight * scale);
            }
        };
        const f = this._isBlending
            ? (this._activeBlendTime > 0 ? Math.min(this._currentBlendTime / this._activeBlendTime, 1) : 1)
            : 1;
        if (this._fieldEntries) addField(this._fieldEntries, this._fieldPhase, f);
        else add(this._currentAnimation, this._currentTime, f);
        if (this._isBlending && f < 1) {
            if (this._frozenPrevious) total += 1 - f;
            else if (this._previousFieldEntries) addField(this._previousFieldEntries, this._previousFieldPhase, 1 - f);
            else add(this._previousAnimation, this._previousTime, 1 - f);
        }
        return { total, withData, inside };
    }

    /** The point of a foot that holds the ground (model space, as animated): its toe, or its ankle without one. */
    private _lockedPoint(plan: FootPlan, globalTransforms: Map<number, mat4>, out: vec3): vec3 {
        const toeG = plan.chain.toe !== undefined ? globalTransforms.get(plan.chain.toe) : undefined;
        return toeG ? mat4.getTranslation(out, toeG) : vec3.copy(out, plan.ankle);
    }

    /**
     * Foot locking for one foot, after swing release has set its height weight: decide whether the animation
     * has it planted, step its lock (`stepFootLock`), and hand the solve where the ankle must go.
     *
     * What is locked is the point that holds the ground: the TOE (the ball of the foot) where the leg has one,
     * else the ankle. The ball stays down through heel-off, so a toe lock holds the foot until it really leaves
     * the ground, while the heel still rises as animated; an ankle lock would let go at heel-off, or pin the heel.
     *
     * Planted means down at the lowest foot, held still vertically by the clip, and not swinging over the ground.
     * "Over the ground" is the animated point's travel WITHOUT the body's rotation: R·(p - p') + (origin - origin').
     * A straight cycle on a body that turns reads still, which is exactly the foot the turn would otherwise sweep
     * round (the glide); a root-motion turn's planted foot reads r·omega, slow; a swing reads twice the body's
     * speed, which is where the line is drawn (see below).
     */
    private _lockFoot(
        plan: FootPlan,
        lowest: number,
        origin: vec3,
        nodeWorld: mat4,
        worldToModel: mat4,
        up: vec3,
        upWorld: vec3,
        tuning: ReturnType<typeof ikTuning>,
        dt: number,
        globalTransforms: Map<number, mat4>,
        allowed: boolean,
    ): void {
        const key = plan.chain.foot;
        let lock = this._ikFootLocks.get(key);
        if (!lock) {
            lock = { alpha: 0, planted: false, point: vec3.create(), dir: vec3.create(), prevPoint: vec3.create(),
                     prevOrigin: vec3.create(), hasPrev: false };
            this._ikFootLocks.set(key, lock);
        }
        const toeG = plan.chain.toe !== undefined ? globalTransforms.get(plan.chain.toe) : undefined;
        const point = this._lockedPoint(plan, globalTransforms, IK_LOCK_POINT);

        // Where that point would be shown without the lock (the height correction applied), in the world.
        const free = vec3.scaleAndAdd(IK_LOCK_FREE, point, up, plan.along * plan.weight);
        const freeWorld = vec3.transformMat4(IK_LOCK_FREE_WORLD, free, nodeWorld);
        // The animated heading in the world, ankle to toe, flattened. Zero-length without a toe, and while the foot
        // is pitched steeply (toe-off): its flattened direction then says nothing about where it points.
        const dirWorld = vec3.set(IK_LOCK_DIR, 0, 0, 0);
        if (toeG) {
            vec3.sub(dirWorld, point, plan.ankle);
            vec3.transformMat3(dirWorld, dirWorld, IK_LOCK_M3);
            const length = vec3.length(dirWorld);
            vec3.scaleAndAdd(dirWorld, dirWorld, upWorld, -vec3.dot(dirWorld, upWorld));
            if (vec3.length(dirWorld) > Math.max(1e-6, length * FOOT_LOCK_LEVEL)) vec3.normalize(dirWorld, dirWorld);
            else vec3.set(dirWorld, 0, 0, 0);
        }
        const hasDir = vec3.squaredLength(dirWorld) > 0;

        // dt 0 is a scrub: the lock holds as it is.
        if (dt > 0) {
            let prevAlpha = lock.alpha;
            let lockable = false;
            let slide = 0;
            // The clips' own word, where they have it: inside a foot-lock window the foot is planted, outside it
            // is not, whatever it looks like.
            const authored = this._footLockWindow(key);
            if (lock.hasPrev) {
                const d = vec3.sub(IK_LOCK_D, point, lock.prevPoint);
                // How fast the CLIP lifts or lowers the foot (model space, so a body climbing a ramp is not it).
                const rise = Math.abs(vec3.dot(d, up)) / dt;
                vec3.transformMat3(d, d, IK_LOCK_M3);
                const body = vec3.sub(IK_LOCK_D2, origin, lock.prevOrigin);
                vec3.add(d, d, body);
                vec3.scaleAndAdd(d, d, upWorld, -vec3.dot(d, upWorld));
                vec3.scaleAndAdd(body, body, upWorld, -vec3.dot(body, upWorld));
                // Looser for a foot already held, so noise round the thresholds does not let it go and re-plant.
                const held = lock.planted;
                const slack = held ? 1.5 : 1;
                // Planted: down, held still vertically, and not swinging over the ground. A swing crosses the
                // ground at about twice the body's speed and a planted foot at about none, so the line is the
                // body's own speed (1.5x): that also takes a planted foot the animation is sliding because it
                // plays another direction than the body goes (a blend still catching up with a turn), which is
                // exactly a foot to hold. To PLANT, the ankle must also be on its ground (a run's lower foot in
                // the flight phase is the lowest foot, but in the air); a held foot keeps its lock through
                // heel-off, its ball still down. A state without locking plants nothing; what it inherits fades.
                const ground = vec3.length(d) / dt, bodySpeed = vec3.length(body) / dt;
                slide = ground;
                const down = vec3.dot(point, up) - lowest < tuning.lockHeight * slack
                    && (held || plan.along > -tuning.lockHeight);
                // Held, the ball of the foot only has to stay down: it rocks up and down a little as the foot rolls
                // onto it, which is no reason to let go.
                lockable = allowed && down && (held || rise < tuning.lockSpeed)
                    && ground < (tuning.lockSpeed + 1.5 * bodySpeed) * slack;
                // Nothing walks that far in one frame: a teleport or a respawn. Let go at once, not over lockRelease.
                if (vec3.length(d) > tuning.lockDistance) { lock.alpha = 0; lock.planted = false; prevAlpha = 0; }
            }
            if (authored !== null) lockable = allowed && authored >= 0.5;
            // Not caught sliding fast while the pose still blends in a clip without windows (see `lockCatchSpeed`):
            // it plants once it has slowed. A held foot stays held; a blend space catching up with a turn, all of
            // it windowed, still catches the foot it slides, which is the foot to hold.
            if (!lock.planted && tuning.lockCatchSpeed > 0 && slide >= tuning.lockCatchSpeed && this._footLockUnwindowed > 1e-3) lockable = false;
            let stray = 0;
            if (prevAlpha > 0) {
                const off = vec3.sub(IK_LOCK_D, freeWorld, lock.point);
                vec3.scaleAndAdd(off, off, upWorld, -vec3.dot(off, upWorld));
                // Distance only: the heading lock is clamped to FOOT_LOCK_MAX_TWIST instead, and past it the foot
                // turns with the animation (a strafe turns its feet out) while its spot stays held.
                stray = vec3.length(off) / tuning.lockDistance;
            }
            if (stepFootLock(lock, lockable, stray, dt, tuning) === 'plant') {
                // Planted where the foot is SHOWN: a re-plant while the last lock is still fading out starts
                // from there, not from the animation, or the foot would pop.
                const shown = footLockWeight(prevAlpha, tuning.lockBlendCurve) * tuning.footLock;
                if (prevAlpha > 0) vec3.lerp(lock.point, freeWorld, lock.point, shown);
                else vec3.copy(lock.point, freeWorld);
                if (!hasDir) vec3.set(lock.dir, 0, 0, 0);
                else if (prevAlpha > 0 && vec3.squaredLength(lock.dir) > 0) {
                    const angle = planarSignedAngle(dirWorld, lock.dir, upWorld) * shown;
                    vec3.transformQuat(lock.dir, dirWorld, quat.setAxisAngle(IK_LOCK_Q, upWorld, angle * DEG2RAD));
                } else vec3.copy(lock.dir, dirWorld);
            }
            vec3.copy(lock.prevPoint, point);
            vec3.copy(lock.prevOrigin, origin);
            lock.hasPrev = true;
        }

        const weight = footLockWeight(lock.alpha, tuning.lockBlendCurve) * tuning.footLock;
        plan.lockWeight = weight;
        plan.lockPlanar = !!toeG;
        if (weight <= 0) return;
        const lockModel = vec3.transformMat4(IK_LOCK_MODEL, lock.point, worldToModel);
        if (vec3.squaredLength(lock.dir) > 0) {
            const dir = vec3.transformMat3(plan.lockDir, lock.dir, IK_LOCK_M3_INV);
            vec3.scaleAndAdd(dir, dir, up, -vec3.dot(dir, up));
            if (vec3.length(dir) > 1e-6) vec3.normalize(dir, dir); else vec3.set(dir, 0, 0, 0);
        } else vec3.set(plan.lockDir, 0, 0, 0);
        if (!toeG) { vec3.copy(plan.lockPoint, lockModel); return; }
        // A toe lock: the ankle goes where the animated foot, turned to the planted heading about the toe, puts
        // its toe on the planted spot. (`_solveLeg` turns the foot by the same angle once the leg is solved.)
        const span = vec3.sub(IK_LOCK_SPAN, point, plan.ankle);
        if (hasDir && vec3.squaredLength(plan.lockDir) > 0) {
            const angle = clamp(planarSignedAngle(span, plan.lockDir, up), -FOOT_LOCK_MAX_TWIST, FOOT_LOCK_MAX_TWIST);
            vec3.transformQuat(span, span, quat.setAxisAngle(IK_LOCK_Q, up, angle * DEG2RAD));
        }
        vec3.sub(plan.lockPoint, lockModel, span);
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
        this._frozenPrevious = null;
        if (this._fieldEntries) {
            // A field's clock is its normalized phase; the caller's seconds are relative to the
            // current weighted duration.
            this._fieldPhase = duration > 0 ? this._currentTime / duration : 0;
            this._prevFieldPhase = this._fieldPhase;   // a scrub is not playback; it must not fire events
        }
        if (this._fps > 0) {
            // A stepped state scrubs through its frames: the ones playback from the start would show at this
            // speed, each `speed / fps` clip seconds apart, and the last key at the end, as playback ends on it.
            // The clock restarts on the frame shown.
            const step = this._speed > 0 ? this._speed / this._fps : 0;
            this._heldTime = step > 0 && this._currentTime < duration
                ? Math.min(duration, Math.floor(this._currentTime / step + FRAME_EPSILON) * step)
                : this._currentTime;
            this._heldFieldPhase = duration > 0 ? this._heldTime / duration : 0;
            this._frameClock = 0;
        }
        if (this._fieldEntries) {
            this._poseFieldAt(this._fieldEntries, this._samplePhase);
        } else {
            const t = this._sampleTime;
            for (const bone of this._bones.values()) {
                bone.update(t);
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
     * Make `name` the current state of the base layer at once, cross-fading over `blend` seconds (the state's own
     * default when omitted), whatever the transitions say. For a machine driven from outside — a NetSync peer
     * putting a followed character into the state the host has it in (docs/design/netsync.md §6.7). Returns false
     * when the machine has no such state.
     */
    public forceState(name: string, blend?: number): boolean {
        if (!this._stateMachine?.states.some(s => s.name === name)) return false;
        if (this._currentStateName === name) return true;
        this._enterState(name, blend);
        return true;
    }

    /**
     * Assign or clear the state machine, resetting parameters to their defaults and entering the entry
     * state. Null falls back to the mapping list, else the bind pose.
     */
    public setStateMachine(sm: AnimationStateMachine | null): void {
        this._stateMachine = sm;
        this._paramValues.clear();
        this._currentStateName = null;
        // A new machine starts smooth and on a fresh beat; its entry state sets its own rate.
        this._fps = 0;
        this._frameClock = 0;
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
        this._setWhileClipsPending = false;
        if (!sm) return;
        for (const p of sm.parameters) this._paramValues.set(p.name, p.default);
        this._setWhileClipsPending = !this._isOverlay && this._clipsPending();
        this._buildOverlays(sm);
        this.resetStateMachine();
    }

    /**
     * Swap in an edited copy of the machine playing now WITHOUT restarting it: parameters, current states and
     * their phases carry on, and what the edit changed shows at once (a pose edited in the editor, the poses of a
     * blend space). Only for a machine of the same shape (`machineShape`: parameters, layers and slots, every
     * layer's states and what kind of thing each plays); anything else falls back to {@link setStateMachine},
     * which re-enters the entry states. Returns whether it was swapped in place.
     */
    public updateStateMachine(sm: AnimationStateMachine): boolean {
        const old = this._stateMachine;
        if (this._isOverlay || !old || machineShape(old) !== machineShape(sm)) { this.setStateMachine(sm); return false; }
        this._stateMachine = sm;
        this._rebindCurrentState();
        for (const o of this._overlays) {
            if (o.kind === 'slot') {
                const def = sm.slots?.find(s => s.name === o.name);
                if (def) { o.blend = def.blend ?? 'override'; o.maskSpec = def.mask ?? null; o.mask = null; }
                continue;
            }
            const layer = sm.layers?.find(l => l.name === o.name);
            if (!layer) continue;
            o.blend = layer.blend ?? 'override';
            o.maskSpec = layer.mask ?? null;
            o.mask = null;
            o.weight = clamp(layer.weight ?? 1, 0, 1);
            o.weightParam = layer.weightParam;
            o.handIk = layer.handIk ?? null;
            o.overReactions = !!layer.overReactions;
            const child = o.animator;
            child._stateMachine = { parameters: [], states: layer.states, transitions: layer.transitions, groups: layer.groups, forks: layer.forks, events: sm.events };
            child._rebindCurrentState();
        }
        this._recomputePose();
        return true;
    }

    // After `updateStateMachine`: the current state's pose or blend space, if the new machine holds another one,
    // takes over at once, at the same time and phase, without a cross-fade.
    private _rebindCurrentState(): void {
        const state = this._stateMachine?.states.find(s => s.name === this._currentStateName);
        if (!state) return;
        if (this._isOverlay && (state.pose || state.field || state.clipName)) this._steadyTarget = clamp(state.meshSpace ?? 0, 0, 1);
        // An edited frame rate shows at once, from the frame on the clock now.
        const fps = stateFps(state);
        if (fps !== this._fps && (state.field || state.clipName || state.pose)) {
            this._fps = fps;
            this._holdCurrentFrame();
        }
        if (state.pose) {
            const clip = this._poseClipOf(state.pose, state.pose.name ?? state.name);
            if (clip === this._currentAnimation) return;
            this._currentAnimation = clip;
            this._bones = this._buildBoneMapFor(clip);
            for (const bone of this._bones.values()) bone.update(this._currentTime);
        } else if (state.field && this._fieldDef && state.field !== this._fieldDef) {
            this._fieldDef = state.field;
            this._refreshFieldWeights();
            if (this._fieldEntries) this._poseFieldAt(this._fieldEntries, this._samplePhase);
        }
    }

    /** No clips at all on the model yet: shared clips still to be attached (see `_setWhileClipsPending`). */
    private _clipsPending(): boolean {
        return (this._animatedModel?.animations?.length ?? 0) === 0;
    }

    /**
     * The machine was set before the model had clips, and now it has them: enter it again, its layers rebuilt (an
     * empty layer's presence is decided as it is built), its parameters kept. Once.
     */
    private _catchUpClips(): void {
        if (!this._setWhileClipsPending || this._clipsPending() || !this._stateMachine) return;
        this._setWhileClipsPending = false;
        this._warnedMissingClips.clear();
        this._fieldBoneCache.clear();
        this._clearField();
        this._overlays = [];
        this._buildOverlays(this._stateMachine);
        this._currentStateName = null;
        this.resetStateMachine();
    }

    /** Re-enter the entry state and reset triggers to their defaults. */
    public resetStateMachine(): void {
        if (!this._stateMachine) return;
        // Reset triggers (bool/float keep their last set value; triggers are momentary).
        for (const p of this._stateMachine.parameters) {
            if (p.type === 'trigger') this._paramValues.set(p.name, false);
        }
        // Linked triggers learn their counts again: what was counted before the reset fires nothing.
        this._counterSeen.clear();
        this._counterPulse.clear();
        const before = this._activeTrigger;
        this._activeTrigger = null;
        this._noteTriggerChange(before);
        const entry = this._stateMachine.states.find(s => s.isEntry) ?? this._stateMachine.states[0];
        if (entry) this._enterState(entry.name);
        else if (this._isOverlay) { this._currentStateName = null; this._overlayEmpty = true; }
        else { this._currentStateName = null; this._setTPose(); }
        for (const o of this._overlays) if (o.kind === 'layer') o.animator.resetStateMachine();
    }

    // Parameter setters/getters used by scripts to drive the machine.
    public setFloat(name: string, value: number): void { this._paramValues.set(name, value); }
    public setBool(name: string, value: boolean): void { this._paramValues.set(name, value); }
    /**
     * Fire a momentary trigger, by name; it is consumed when the state or transition it starts fires. A
     * project's scripts are checked against the triggers its animators declare (see TriggerName).
     */
    public setTrigger(name: TriggerName): void { this._paramValues.set(name, true); this._counterPulse.delete(name); }
    public resetTrigger(name: TriggerName): void { this._paramValues.set(name, false); }
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
            const groupA = this._groupOf(a)?.name;
            // Its own way, then its group's, then Any State's; each straight to `b` (or to `b`'s group entering it), or
            // through forks on to it.
            const into = (p: MachinePath) => resolveIn(sm, p.to) === b;
            const path = pathsFrom(sm, a).find(into)
                ?? (groupA ? pathsFrom(sm, groupA).find(into) : undefined)
                ?? pathsFrom(sm, '*').find(into);
            if (!path) { lines.push(`${a} -> ${b}: (no transition)`); continue; }
            const parts: string[] = [];
            const gates: string[] = [];
            path.legs.forEach((t, i) => {
                const own: string[] = [];
                forEachCondition(t.condition, t.conditions, c => own.push(this._describeCondition(c)));
                if (own.length) parts.push((i > 0 ? `${t.from}: ` : '') + own.join(' AND '));
                if (t.minDwell) gates.push(`minDwell ${t.minDwell}s`);
                if (t.hasExitTime) gates.push(`exitTime ${t.exitTime ?? 1}`);
            });
            const via = path.legs.length > 1 ? ` (via ${path.legs.slice(1).map(t => t.from).join(', ')})` : '';
            lines.push(
                `${a} -> ${b}${via}: ${parts.length ? parts.join(' THEN ') : '(NO CONDITIONS - fires unconditionally)'}`
                + (gates.length ? ` | ${gates.join(', ')}` : ' | no dwell/exit-time gate'));
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
        // A layer coming out of an empty state that has already faded away fades back in through its
        // presence; one still visible (interrupted mid-fade) cross-fades from the pose it is holding, as a
        // slot does, or the old pose would be swapped for the new clip's first frame at full presence.
        const wasEmpty = (this._overlayEmpty && !this._overlayVisible) || !this._currentAnimation;
        // A sync group's hand-over: read where the stride is before anything below resets it.
        const carried = this._syncedPhase(name, state);
        if (this._isOverlay) {
            // Steady eases from what the layer showed to this state's over the cross-fade; an empty state holds it.
            this._steadyFrom = this._steadyNow();
            const empty = !state || (!state.pose && !state.field && !state.clipName);
            this._steadyTarget = empty ? this._steadyFrom : clamp(state!.meshSpace ?? 0, 0, 1);
            // A layer fading back in from nothing shows its state's Steady from the start.
            this._steadyFade = wasEmpty ? 0 : Math.max(0, blendOverride ?? this._blendTime);
            // Leaving a clip for an empty state keeps that clip's foot-IK weight for the fade-out. Read
            // before the name changes: it is the state being left that answers.
            if (!this._overlayEmpty) this._overlayFadeIkWeight = this._stateIkWeightOfState();
            // The layer's presence fades over THIS transition's blend, whatever cross-fade came before.
            this._presenceFadeSeconds = Math.max(0, blendOverride ?? this._blendTime);
            // Only a clip state that asks extracts root travel (armed below); `_extractRoot` is read when a
            // clip starts, so a clip already playing out under an empty state keeps what it had.
            this._extractRoot = false;
        }
        const leftState = this._currentStateName;
        const leftKind = this._isOverlay ? null : reactionKindOf(this._currentState);
        this._noteStateChange(leftState, name);
        this._currentStateName = name;
        if (leftState !== null) this._postAnimationEvent('StateExit', { state: leftState, from: leftState, to: name, layer: this._overlayName });
        this._postAnimationEvent('StateEnter', { state: name, from: leftState, to: name, layer: this._overlayName });
        this._prevEventTime = 0;
        this._stateTime = 0;
        this._stateToken++;
        (this._overlayOwner ?? this)._effects = null;

        if (!this._isOverlay) {
            this._reactionHold = false;
            this._noRootMotion = false;
            const kind = reactionKindOf(state);
            if (kind) this._reactionEdge = kind;
            // The layers fade out over the transition into one, and back over the one out.
            if (kind || leftKind) this._reactionMuteFade = Math.max(0, blendOverride ?? this._blendTime);
            if (kind === 'ragdoll') { this._enterRagdollState(state!, blendOverride); return; }
            if (kind === 'getUp') { this._enterGetUpState(state!, blendOverride); return; }
        }

        // A field state blends several clips instead of playing one; _startField arms the cross-fade itself.
        if (state?.field) {
            this._startField(state.field, state.fieldInputs, state.loop, true, blendOverride, carried ?? undefined, !state.loop && carried === null);
            this._loopLimit = Math.max(0, Math.floor(state.loopCount ?? 0));
            this._loopsPlayed = 0;
            this._speed = state.speed ?? 1.0;
            this._applyStateSpeed(state);
            // Stop motion: the state's first frame is the one it starts on (a carried phase included).
            this._fps = stateFps(state);
            this._holdCurrentFrame();
            return;
        }

        if (state?.pose) {
            this._playClip(this._poseClipOf(state.pose, state.pose.name ?? state.name), true, !(this._isOverlay && wasEmpty));
            if (blendOverride !== undefined) this._activeBlendTime = Math.max(0, blendOverride);
            this._speed = 1;
            return;
        }

        // A layer clip the model does not have plays nothing: say so once, and fade out as an empty state
        // would rather than keep the previous clip running under this state's name.
        const missingOnLayer = this._isOverlay && !!state?.clipName
            && !this._animatedModel?.animations.some(a => a.name === state.clipName);
        if (missingOnLayer) this._warnMissingLayerClip(state!);
        if (this._isOverlay && (!state || !state.clipName || missingOnLayer)) {
            // An empty state on a LAYER means "add nothing": fade the layer out, holding its last pose
            // while it goes, rather than snapping the bones to rest. The held clip keeps playing out (and
            // keeps handing over any root travel it extracts) under the fade, as an action's does.
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
        if (this._isOverlay) {
            // Root travel is extracted per state (AnimationState.extractRootMotion), armed as the clip starts.
            this._extractRoot = !!state.extractRootMotion;
            vec3.set(this._rootDelta, 0, 0, 0);
            // A layer coming out of an empty state fades in through its presence; cross-fading from whatever
            // stale clip it last held would replay that clip first. Re-entering the SAME clip (a second hit
            // restarting the flinch, a combo going back to its first swing) cross-fades from where it was.
            const clip = this._animatedModel!.animations.find(a => a.name === state.clipName)!;
            this._playClip(clip, state.loop, !wasEmpty, true);
        } else {
            this.playAnimationByName(state.clipName, state.loop, true);
        }
        // playAnimation just armed the blend with the animator-wide default; the transition gets the last word.
        if (blendOverride !== undefined) this._activeBlendTime = Math.max(0, blendOverride);
        if (typeof state.startTime === 'number' && state.startTime > 0 && this._currentAnimation) {
            // Join the clip part-way (one segment of a combo clip): the clock starts there, and neither the
            // events nor the root travel before it count -- both are read from the previous frame's time.
            this._currentTime = Math.min(state.startTime, this._getAnimationDuration());
            this._prevEventTime = this._currentTime;
            this._eventFromStart = false;
        }
        // A sync group's carried phase wins over `startTime`: the clip joins the stride where it was.
        if (carried !== null && state.loop && this._currentAnimation) {
            this._currentTime = carried * this._getAnimationDuration();
            this._prevEventTime = this._currentTime;
            this._eventFromStart = false;
        }
        this._loopLimit = Math.max(0, Math.floor(state.loopCount ?? 0));
        this._loopsPlayed = 0;
        this._speed = state.speed ?? 1.0;
        this._applyStateSpeed(state);
        // Stop motion: the state's first frame is the one it starts on (`startTime` or a carried phase included).
        if (this._currentAnimation) {
            this._fps = stateFps(state);
            this._holdCurrentFrame();
        }
    }

    /** Into a Ragdoll state: its clip, or the pose on screen held (see AnimationState.ragdoll). */
    private _enterRagdollState(state: AnimationState, blendOverride: number | undefined): void {
        // The body moves the character now: no clip's root motion does.
        this._noRootMotion = true;
        const clip = state.clipName ? this._animatedModel?.animations.find(a => a.name === state.clipName) : undefined;
        if (clip) {
            this.playAnimationByName(state.clipName, state.loop, true);
            if (blendOverride !== undefined) this._activeBlendTime = Math.max(0, blendOverride);
            this._loopLimit = Math.max(0, Math.floor(state.loopCount ?? 0));
            this._loopsPlayed = 0;
            this._speed = state.speed ?? 1.0;
            this._applyStateSpeed(state);
            return;
        }
        // Built BEFORE the clip changes (_playClip rebuilds the bones it reads), and nothing is written to the bone
        // matrices until the next pose: the body is made from what is on screen.
        const held = this._heldPoseClip();
        if (held) this._playClip(held, true, false);
        this._speed = 1;
    }

    /**
     * Into a Get Up state: the clip for the side the body lies on, from its first frame with no cross-fade (the skin
     * blends from the body), no root motion; waiting on that frame while the body is not down yet. With no body to
     * rise from (no reactions, a body already up), an ordinary clip state.
     */
    private _enterGetUpState(state: AnimationState, blendOverride: number | undefined): void {
        const link = this._reactionLink();
        const clip = this._getUpClip(state, link?.faceUp ?? false, link?.getUpClips);
        if (!clip) {
            this._warnedGetUpClip ??= new Set();
            if (!this._warnedGetUpClip.has(state.name) && !this._clipsPending()) {
                this._warnedGetUpClip.add(state.name);
                Logger.warn(`Get Up state "${state.name}" has no clip to play: pick its face-up and face-down clips, or the rig's in its Reactions tab.`, 'Animation');
            }
            const held = this._heldPoseClip();
            if (held) this._playClip(held, true, false);
            return;
        }
        const fromBody = !!link?.ragdolled;
        this._noRootMotion = true;
        this._playClip(clip, false, !fromBody);
        // Joined where the body in it rises: what it waits on while the body is not down yet, and plays on from.
        this._getUpStart = this._riseStartFor(state, clip);
        if (this._getUpStart > 0) {
            this._currentTime = this._prevEventTime = this._getUpStart;
            this._eventFromStart = false;
        }
        if (!fromBody && blendOverride !== undefined) this._activeBlendTime = Math.max(0, blendOverride);
        this._loopLimit = 0;
        this._loopsPlayed = 0;
        this._speed = state.speed ?? 1.0;
        this._applyStateSpeed(state);
        this._reactionHold = fromBody;
    }

    private _warnMissingLayerClip(state: AnimationState): void {
        if (this._clipsPending()) return;
        this._warnedMissingLayerClip ??= new Set();
        if (this._warnedMissingLayerClip.has(state.name)) return;
        this._warnedMissingLayerClip.add(state.name);
        Logger.warn(
            `Animation state "${state.name}" plays "${state.clipName}", which this model does not have, so the `
            + `layer adds nothing while it is there. Pick a clip the character has, or link its skeleton's clips.`,
            'Animation');
    }

    // Report a Speed parameter that has gone negative, once per state. There is no reverse playback, so
    // it clamps to 0 and the clip FREEZES — usually a signed built-in bound where a magnitude was meant.
    private _warnNegativeSpeed(state: AnimationState, value: number): void {
        const key = `${state.name}\u0000${state.speedParam}`;
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
    // back to the state's fixed `speed`; `speedScaleParam` multiplies either.
    private _applyStateSpeed(state: AnimationState | undefined): void {
        if (!state?.speedParam && !state?.speedScaleParam) return;
        let rate = state.speed ?? 1.0;
        const v = state.speedParam ? this._paramValues.get(state.speedParam) : undefined;
        // Parameter renamed or deleted: keep the fixed speed. Reading it as 0 would freeze the clip.
        if (v === undefined && !state.speedScaleParam) return;
        if (v !== undefined) {
            // A bool reads as 1/0 so a flag can halt motion. The setter's clamp is mirrored here, since this
            // bypasses it — there is no reverse playback.
            const raw = typeof v === 'number' ? v : (v ? 1 : 0);
            if (raw < 0) this._warnNegativeSpeed(state, raw);
            rate = raw;
        }
        const scale = state.speedScaleParam ? this._paramValues.get(state.speedScaleParam) : undefined;
        if (typeof scale === 'number' && Number.isFinite(scale)) rate *= scale;
        this._speed = Math.max(0, rate);
    }

    // This node or the nearest ancestor with a rigid body — whatever is actually being moved. An
    // animator lives on the skinned ModelNode, but the body sits on the root above it.
    private _nearestBodiedNode(): Node | null {
        let n: Node | null = this._node;
        while (n) {
            // The body's OWNER (a Character reads its Collider's body but is not what moves it).
            if (n.ownBody) return n;
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
        // The character's reactions, looked up once a frame and only if a parameter reads them.
        let link: AnimatorReactionLink | null | undefined;
        const reactions = () => link === undefined ? (link = this._reactionLink()) : link;
        for (const p of sm.parameters) {
            if (p.type === 'trigger') {
                if (p.variable) this._refreshLinkedTrigger(p, reactions);
                continue;
            }
            if (p.type !== 'variable' || !p.variable) continue;
            const pinned = this._paramOverrides.get(p.name);
            if (pinned !== undefined) { this._paramValues.set(p.name, pinned); continue; }
            // A reaction value: the character's own reactions, whatever node the parameter names.
            const reactionValue = p.variable.source === 'builtin' ? NODE_BUILTINS[p.variable.varName]?.reactions : undefined;
            if (reactionValue) {
                const r = reactions();
                const v = r ? reactionValue(r) : (NODE_BUILTINS[p.variable.varName].none ?? p.default);
                this._paramValues.set(p.name, p.variable.varType === 'boolean' ? !!v : Number(v));
                continue;
            }
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

    /**
     * A trigger linked to a counter (AnimationParameter.variable): raised once each time the count rises (the first
     * read only learns it); a raise nothing took is lowered at the next frame, so a hit never flinches a body later.
     */
    private _refreshLinkedTrigger(p: AnimationParameter, reactions: () => AnimatorReactionLink | null): void {
        if (this._counterPulse.delete(p.name) && this._paramValues.get(p.name) === true) this._paramValues.set(p.name, false);
        const b = p.variable!;
        let count: number | null = null;
        const builtin = b.source === 'builtin' ? NODE_BUILTINS[b.varName] : undefined;
        if (builtin?.reactions) {
            const r = reactions();
            if (r) count = Number(builtin.reactions(r));
        } else {
            const src = this._resolveVarNode(b.nodeRef);
            if (src && builtin) count = Number(builtin.read(src));
            else if (src && canAccessVariable(src, this._node!, b.varName)) {
                let v: unknown = src.getVariable(b.varName);
                if (v === undefined && Object.prototype.hasOwnProperty.call(src, b.varName)) v = (src as unknown as Record<string, unknown>)[b.varName];
                if (v !== undefined) count = Number(v);
            }
        }
        if (count === null || !Number.isFinite(count)) return;
        const seen = this._counterSeen.get(p.name);
        this._counterSeen.set(p.name, count);
        if (seen !== undefined && count > seen) {
            this._paramValues.set(p.name, true);
            this._counterPulse.add(p.name);
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

        // In this order, the first that holds fires: Any State transitions, then the triggers states are
        // entered by directly, then the current state's own way out — so a hit or a death interrupts
        // whatever the state was about to do.
        const duration = this._getAnimationDuration();
        // In a Ragdoll or Get Up state only another such state is entered from anywhere: whatever else would have
        // been (a car's EnterCar) waits for the body to be up, its trigger taken so it does not fire later.
        const held = this._isOverlay ? false : reactionKindOf(this._currentState) !== null;
        for (const t of sm.transitions) {
            if (t.from !== '*') continue;
            if (held && !this._entersReactionState(t.to)) { if (this._transitionMet(t)) this._consumeLeg(t); continue; }
            if (this._tryTransition(t, duration)) return;
        }
        for (const s of sm.states) {
            for (const entry of s.triggers ?? []) {
                if (!entry.trigger || this._paramValues.get(entry.trigger) !== true) continue;
                if (s.name === this._currentStateName && entry.restart === false) continue;
                if (held && !reactionKindOf(s)) {
                    this._consumeLeg({ from: '*', to: s.name, conditions: [], condition: { op: 'and', children: [{ param: entry.trigger, op: 'trigger' }] } });
                    continue;
                }
                this._takeTransition({ from: '*', to: s.name, conditions: [], condition: { op: 'and', children: [{ param: entry.trigger, op: 'trigger' }] } },
                    entry.trigger, entry.blendTime);
                return;
            }
        }
        for (const t of sm.transitions) if (t.from === this._currentStateName && this._tryTransition(t, duration)) return;
        // Then the group's: a way out written once for every state in it.
        const group = this._groupOf(this._currentStateName);
        if (group) for (const t of sm.transitions) if (t.from === group.name && this._tryTransition(t, duration)) return;
    }

    /** Whether a transition's target (through a group's entry) is a Ragdoll or Get Up state. */
    private _entersReactionState(to: string): boolean {
        const sm = this._stateMachine;
        if (!sm) return false;
        const name = this._resolveTarget(to);
        return reactionKindOf(this._stateByName(sm, name)) !== null;
    }

    /** The group a state belongs to on this machine, if any. */
    private _groupOf(stateName: string | null): AnimationStateGroup | null {
        if (!stateName) return null;
        for (const g of this._stateMachine?.groups ?? []) if (g.states.includes(stateName)) return g;
        return null;
    }

    /** The state a transition's `to` enters: the name itself, or a group's entry state (which may be a fork). */
    private _resolveTarget(name: string): string {
        return this._stateMachine ? resolveIn(this._stateMachine, name) : name;
    }

    /** Whether `name` is one of this machine's forks: never a state, only a way through (see {@link AnimationFork}). */
    private _isFork(name: string): boolean {
        const sm = this._stateMachine;
        return !!sm?.forks?.length && isForkIn(sm, name);
    }

    // Fire `t` if it can: its source, its dwell, its exit time and its conditions all allow it. One into a fork fires
    // only on through one of the fork's ways out.
    private _tryTransition(t: AnimationTransition, duration: number): boolean {
        const to = this._resolveTarget(t.to);
        if (this._isFork(to)) return this._tryThroughFork(t, to, duration);
        if (to === this._currentStateName && !(t.from === '*' && t.canTransitionToSelf)) return false;
        if (!this._legOpen(t, duration)) return false;
        this._takeTransition(t, firstTriggerOf(t), t.blendTime);
        return true;
    }

    // One leg's own gates, against the state being left: its dwell, its exit time, its conditions. It only reads:
    // nothing is consumed until a whole path is taken.
    private _legOpen(t: AnimationTransition, duration: number): boolean {
        // Before the conditions, so a trigger is not consumed by a transition that cannot fire yet.
        if (t.minDwell && this._stateTime < t.minDwell) return false;

        // Exit-time gate: wait until the clip reaches the normalized exit time.
        if (t.hasExitTime) {
            const exit = (t.exitTime ?? 1.0) * duration;
            if (this._currentTime < exit) return false;
        }

        return this._transitionMet(t);
    }

    // `first` goes into `fork`: fire it, and the fork's first way out that holds (through any forks after it), as one
    // transition. The cross-fade is the last leg's that has one; the trigger, the first along the way.
    private _tryThroughFork(first: AnimationTransition, fork: string, duration: number): boolean {
        if (!this._legOpen(first, duration)) return false;
        const path = this._forkPath;
        path.length = 0;
        this._forksSeen.length = 0;
        path.push(first);
        const to = this._wayOut(fork, duration, first.from === '*');
        if (to === null) { path.length = 0; return false; }
        let trigger: string | null = null;
        for (const leg of path) if ((trigger = firstTriggerOf(leg)) !== null) break;
        let blend: number | undefined;
        for (let i = path.length - 1; i >= 0 && blend === undefined; i--) blend = path[i].blendTime;
        for (const leg of path) this._consumeLeg(leg);
        path.length = 0;
        this._enterVia(to, trigger, blend);
        return true;
    }

    // The state `fork`'s first open way out reaches (in the transitions' order), its legs pushed onto `_forkPath`; null
    // when none can go. A fork is expanded once per attempt, and a path stops at FORK_DEPTH legs, so a cycle of forks
    // ends. Called on every frame a way into a fork is open (Any State into one: every frame), so it allocates nothing.
    private _wayOut(fork: string, duration: number, fromAnywhere: boolean): string | null {
        const path = this._forkPath, seen = this._forksSeen;
        if (seen.includes(fork) || path.length >= FORK_DEPTH) return null;
        seen.push(fork);
        for (const t of this._stateMachine!.transitions) {
            if (t.from !== fork) continue;
            const to = this._resolveTarget(t.to);
            const onward = this._isFork(to);
            // Into the state already playing: passed over (the next way out is tried), unless the path started at Any
            // State and a leg on it may restart its state.
            if (!onward && to === this._currentStateName && !(fromAnywhere && (t.canTransitionToSelf || this._forkPathRestarts()))) continue;
            if (!this._legOpen(t, duration)) continue;
            const mark = path.length;
            path.push(t);
            if (!onward) return to;
            const end = this._wayOut(to, duration, fromAnywhere);
            if (end !== null) return end;
            path.length = mark;
        }
        return null;
    }

    private _forkPathRestarts(): boolean {
        for (const leg of this._forkPath) if (leg.canTransitionToSelf) return true;
        return false;
    }

    // Take a transition (or a state's own trigger, as one): consume its triggers, note which trigger
    // started what plays now, and enter its state.
    private _takeTransition(t: AnimationTransition, trigger: string | null, blendTime: number | undefined): void {
        this._consumeLeg(t);
        this._enterVia(this._resolveTarget(t.to), trigger, blendTime);
    }

    private _consumeLeg(t: AnimationTransition): void {
        // EVERY trigger in the tree is consumed, including under an OR branch that did not contribute: one
        // left raised would fire some other transition next frame. Inside checkTriggers that waits until
        // every layer has evaluated, so they all see this frame's triggers.
        if (this._pendingTriggerConsumes) this._pendingTriggerConsumes.push(t);
        else consumeTriggers(this._conditionCtx, t.condition, t.conditions);
    }

    private _enterVia(to: string, trigger: string | null, blendTime: number | undefined): void {
        // A trigger-less transition (a sheathe going on into the draw) carries the one that started it.
        const before = this._activeTrigger;
        if (trigger) this._activeTrigger = trigger;
        this._enterState(to, blendTime);
        if (this._stateMachine?.states.find(s => s.name === to)?.isEntry) this._activeTrigger = null;
        this._noteTriggerChange(before);
    }

    /**
     * The active trigger went from `before` to what it is now: `TriggerEnded` for the one over, `TriggerStarted`
     * for the one begun, posted for the frame's flush (and only built when someone listens).
     */
    private _noteTriggerChange(before: string | null): void {
        const now = this._activeTrigger;
        if (before === now) return;
        if (before) this._postAnimationEvent('TriggerEnded', { state: this._currentStateName, from: null, to: null, layer: this._overlayName, trigger: before });
        if (now) this._postAnimationEvent('TriggerStarted', { state: this._currentStateName, from: null, to: null, layer: this._overlayName, trigger: now });
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

    /**
     * Fire event markers on the current clip whose time was crossed in (prev, cur]. The first window after a clip
     * starts (or restarts) opens before time 0, so a marker AT 0 fires with the clip.
     */
    private _fireDueEvents(prevTime: number, curTime: number, duration: number, looped: boolean): void {
        const fromStart = this._eventFromStart;
        this._eventFromStart = false;
        const machineEvents = this._stateMachine?.events ?? this._externalEvents ?? [];
        const clipEvents = this._currentAnimation?.events ?? [];
        // A layer or slot forwards to the root, which owns the callbacks and the bound actions.
        const hasListeners = this._eventCallbacks.length > 0
            || (!this._isOverlay && ((this._stateMachine?.eventActions?.length ?? 0) > 0 || hasScriptListeners()));
        if ((machineEvents.length === 0 && clipEvents.length === 0) || !this._currentAnimation || !hasListeners) {
            this._prevEventTime = curTime;
            return;
        }
        const clip = this._currentAnimation.name;
        const emit = (eventName: string) => this._dispatchEvent(eventName, clip);
        const fire = (from: number, to: number) => {
            for (const ev of machineEvents) {
                if (ev.clipName !== clip || ev.time <= from || ev.time > to) continue;
                // Events belong on the clip now; the editor moves a machine's markers there when it opens the
                // animator. Until that machine is saved (or in a game published before) both copies exist:
                // the clip's wins, so the event fires once.
                if (clipEvents.some(c => c.name === ev.eventName && Math.abs(c.time - ev.time) < 1e-4)) continue;
                emit(ev.eventName);
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
            fire(fromStart ? -1 : prevTime, curTime);
        }
        this._prevEventTime = curTime;
    }

    /**
     * One event: the effects bound to it on this machine's Event Actions first, then the `onAnimationEvent` listeners,
     * then the event system: dispatched at the character's node on the `animation` channel (src/core/events), so
     * `@onClipEvent` / `@eventListener('animation:…')` on it or an ancestor and `@onEvent('animation:…')` anywhere
     * hear it. A marker named `'channel:name'` goes to that channel instead.
     * A layer or slot has no bindings of its own; it hands its events to the character's root animator, which runs them.
     */
    private _dispatchEvent(eventName: string, clipName: string, layer: string | null = null, state?: string | null): void {
        if (!this._isOverlay) {
            const actions = actionsFor(this._stateMachine?.eventActions, eventName, clipName);
            if (actions.length > 0 && this._node) runEventActions(this._node, actions);
        }
        // Fired from the update loop, outside attachScriptFactory's handler guards.
        for (const cb of this._eventCallbacks) {
            try { cb(eventName, clipName); }
            catch (e) { Logger.error(`Error in onAnimationEvent('${eventName}') for node ${this._node?.name}: ${e}`, 'Script'); }
        }
        if (!this._isOverlay && hasScriptListeners()) {
            const [channel, name] = resolveEvent(eventName, ANIMATION_CHANNEL);
            // Only an event someone listens to (here or at any node) is built at all.
            if (channel.hasListeners(name)) {
                const info: AnimationEventInfo = {
                    event: name, clip: clipName, state: state === undefined ? this._currentStateName : state, layer,
                    node: this._node, animator: this,
                };
                channel.fire(name, [info], this._node);
            }
        }
    }

    /**
     * A state or action event (`StateEnter`, `StateExit`, `ActionFinished`): posted on the `animation` channel at the
     * character's node, and delivered at the frame's event flush -- never inside the state change itself, where a
     * listener that set a trigger or forced a state would re-enter the machine mid-transition.
     */
    private _postAnimationEvent(name: 'StateEnter' | 'StateExit' | 'ActionFinished' | 'TriggerStarted' | 'TriggerEnded', info: Omit<AnimationStateEventInfo, 'node' | 'animator'>): void {
        const root = this._overlayOwner ?? this;
        if (!hasScriptListeners()) return;
        const channel = getChannel(ANIMATION_CHANNEL);
        if (!channel.hasListeners(name)) return;
        const payload: AnimationStateEventInfo = { ...info, node: root._node, animator: root };
        channel.defer(name, [payload], { target: root._node });
    }

    /**
     * Fire the named event as if a clip marker had: its bound Event Actions run and `onAnimationEvent` listeners hear it.
     * For things with no clip to carry a marker (a bot's shot), so their effects are still the machine's data.
     */
    public fireEvent(eventName: string): void {
        this._dispatchEvent(eventName, this._currentAnimation?.name ?? '');
    }

    // ---- Layers and action slots --------------------------------------------------------------------

    // Build one child animator per layer, plus the declared slots. Children SHARE the parameter table, so
    // a parameter set on the character drives every layer, and a trigger is consumed once whichever layer
    // fires on it.
    private _buildOverlays(sm: AnimationStateMachine): void {
        if (!this._animatedModel) return;
        (sm.layers ?? []).forEach((layer, i) => {
            const child = this._createOverlayAnimator(layer.name);
            child.setStateMachine({ parameters: [], states: layer.states, transitions: layer.transitions, groups: layer.groups, forks: layer.forks, events: sm.events });
            child._paramValues = this._paramValues;
            // A layer that starts on a clip is simply there from the first frame; fading it in would show
            // the base for a beat on every scene load.
            const present = child._overlayEmpty || !child._currentAnimation ? 0 : 1;
            child._overlayVisible = present > 0;
            this._overlays.push({
                kind: 'layer', name: layer.name, animator: child,
                blend: layer.blend ?? 'override',
                maskSpec: layer.mask ?? null, mask: null,
                weight: clamp(layer.weight ?? 1, 0, 1), weightParam: layer.weightParam,
                order: i + 1,
                presence: present, presenceTarget: present, fadeSeconds: this._blendTime,
                action: null, entries: null, steadyNow: 0, handIk: layer.handIk ?? null, overReactions: !!layer.overReactions,
            });
        });
        for (const slot of sm.slots ?? []) this._addSlot(slot, sm.layers?.length ?? 0);
        this._overlays.sort((a, b) => a.order - b.order);
    }

    private _createOverlayAnimator(name: string): Animator {
        const child = new Animator(this._animatedModel!, undefined, { overlay: true });
        child._blendTime = this._blendTime;
        child._overlayOwner = this;
        child._overlayName = name;
        // A layer's or slot's events are the character's events.
        child.onAnimationEvent((eventName, clipName) => this._dispatchEvent(eventName, clipName, name, child._currentStateName));
        return child;
    }

    private _addSlot(def: AnimationSlotDef, layerCount: number): Overlay {
        const child = this._createOverlayAnimator(def.name);
        child._externalEvents = this._stateMachine?.events ?? null;
        const after = def.afterLayer === undefined ? layerCount : clamp(Math.floor(def.afterLayer), 0, layerCount);
        const overlay: Overlay = {
            kind: 'slot', name: def.name, animator: child,
            blend: def.blend ?? 'override',
            maskSpec: def.mask ?? null, mask: null,
            weight: 1, order: after + 0.5,
            presence: 0, presenceTarget: 0, fadeSeconds: 0.15,
            action: null, entries: null, steadyNow: 0, handIk: null, overReactions: true,
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
                o.fadeSeconds = child._presenceFadeSeconds;
            }
            // A layer that is not drawn and is not fading in poses nothing (its clock and its machine still run).
            if (o.presence <= 0 && o.presenceTarget <= 0) child._skipPose = true;
            child.update(deltaTime);

            const action = o.action;
            if (action && !action.stopping && !action.loop) {
                // Start fading out so the fade ENDS with the clip, not after it. In real seconds: the
                // clip's remaining time divided by its playback speed, since `blendOut` and the presence
                // step below are both wall-clock (a 1.6x attack with a 0.3 s blend-out fades for 0.3 s,
                // not the 0.19 s its clip time would give).
                const remaining = (child._getAnimationDuration() - child._currentTime) / Math.max(child._speed, 1e-3);
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
            // Read by the child's next state change (checkTriggers runs before update).
            child._overlayVisible = o.presence > 0;
        }
    }

    /**
     * Bone name -> node index on this skin: the exact name, else the same bone under another exporter's
     * spelling (`mixamorig1:Spine2` authored, `mixamorig:Spine2_04` on the skin) — masks and poses are
     * authored by name on one skeleton and played on whatever skeleton a model retargets them onto.
     */
    private _nodeOfBoneName(): (name: string) => number | undefined {
        const exact = new Map<string, number>(), loose = new Map<string, number>();
        for (const [nodeIndex, name] of this._skin?.nodeNames ?? []) {
            exact.set(name, nodeIndex);
            const n = normalizeBoneName(name);
            if (!loose.has(n)) loose.set(n, nodeIndex);
        }
        return (name) => exact.get(name) ?? loose.get(normalizeBoneName(name));
    }

    // Node index -> weight for an overlay's mask, resolved by bone NAME against this skin once.
    private _overlayMask(o: Overlay): Map<number, number> | null {
        if (!o.maskSpec) return null;
        if (o.mask) return o.mask;
        const nodeOf = this._nodeOfBoneName();
        const mask = new Map<number, number>();
        for (const [name, w] of Object.entries(o.maskSpec)) {
            const nodeIndex = nodeOf(name);
            if (nodeIndex !== undefined && w > 0) mask.set(nodeIndex, clamp(w, 0, 1));
        }
        o.mask = mask;
        o.entries = this._skin ? this._entryPaths(mask) : null;
        return mask;
    }

    // A mask's entry bones (masked joints whose parent joint is not) and, for each, the nodes from the root down
    // to its parent frame, joints and the non-joint nodes between them in order: what Steady measures along.
    private _entryPaths(mask: Map<number, number>): Map<number, number[]> {
        const topo = this._topology();
        const joints = this._skin!.joints;
        const pathTo = (j: number, depth = 0): number[] => {
            const pj = topo.parentJoint[j];
            const above = pj >= 0 && depth < 256 ? [...pathTo(pj, depth + 1), joints[pj].nodeIndex] : [];
            return [...above, ...(topo.parentChain[j] ?? [])];
        };
        const out = new Map<number, number[]>();
        for (const nodeIndex of mask.keys()) {
            const j = topo.jointOfNode.get(nodeIndex);
            if (j === undefined) continue;
            const pj = topo.parentJoint[j];
            if (pj >= 0 && mask.has(joints[pj].nodeIndex)) continue;
            out.set(nodeIndex, pathTo(j));
        }
        return out;
    }

    // An overlay's weight this frame: its parameter's when it names one, else its own.
    private _overlayWeight(o: Overlay): number {
        // Muted under a Ragdoll or Get Up state, unless the layer plays over them (slots never are).
        const mute = o.kind === 'layer' && !o.overReactions ? this._reactionMute : 1;
        if (o.weightParam) {
            const v = this._paramValues.get(o.weightParam);
            if (typeof v === 'number') return clamp(v, 0, 1) * mute;
            if (typeof v === 'boolean') return (v ? 1 : 0) * mute;
        }
        return o.weight * mute;
    }

    // Blend every overlay onto a bone's base local, in order.
    // Blend the overlays below `upTo` (all of them by default) onto a bone's base local, in order.
    private _applyOverlays(nodeIndex: number, base: mat4, upTo: number = this._overlays.length): mat4 {
        let local = base;
        for (let k = 0; k < upTo; k++) {
            const o = this._overlays[k];
            if (o.presence <= 0) continue;
            const mask = this._overlayMask(o);
            const maskWeight = mask ? (mask.get(nodeIndex) ?? 0) : 1;
            if (maskWeight <= 0) continue;
            const w = this._overlayWeight(o) * maskWeight * o.presence;
            if (w <= 0) continue;
            let layer = o.animator._sourceLocal(nodeIndex);
            // A layer that does not animate this bone leaves it to the layers beneath.
            if (!layer) continue;
            if (o.steadyNow > 0) {
                const path = o.entries?.get(nodeIndex);
                if (path) layer = this._steadied(layer, path, k, o, o.steadyNow);
            }
            local = o.blend === 'additive'
                ? this._addTransform(local, layer, o.animator._additiveReference(nodeIndex), w)
                : this._blendTransforms(local, layer, w);
        }
        return local;
    }

    // A node's local with the base and the overlays below `k` applied: the body as layer k finds it.
    private _localBelow(nodeIndex: number, k: number): mat4 {
        const override = this._boneOverrides?.get(nodeIndex);
        if (override) return override;
        const base = this._sourceLocal(nodeIndex) ?? this._skin!.nodeTransforms?.get(nodeIndex) ?? IDENTITY;
        return k > 0 ? this._applyOverlays(nodeIndex, base, k) : base;
    }

    // Scratch for `_steadied`, one set per nesting depth: measuring the body below a Steady layer can meet
    // another Steady layer beneath it.
    private _steadyScratch: { f: quat; g: quat; t: vec3; r: quat; s: vec3 }[] = [];
    private _steadyDepth = 0;

    // A Steady layer's local at one of its entry bones (`AnimationState.meshSpace`): turned so the bone keeps, by
    // `s`, the model-space turn the layer's own pose gives it. F is its parent frame's turn in the body as the
    // overlays below this one compose it; G the same frame in the layer's own pose (a joint it does not hold, at
    // rest; the non-joint nodes between joints as the body has them, so they cancel). Rotations only, read with
    // the scale divided out (the 0.01 Armature). The local turn R becomes slerp(I, inv(F) G, s) x R.
    private _steadied(layer: mat4, path: number[], k: number, o: Overlay, s: number): mat4 {
        const depth = this._steadyDepth++;
        const sc = this._steadyScratch[depth] ??= { f: quat.create(), g: quat.create(), t: vec3.create(), r: quat.create(), s: vec3.create() };
        try {
            const topo = this._topology();
            const rest = this._skin!.nodeTransforms;
            quat.identity(sc.f);
            quat.identity(sc.g);
            for (const n of path) {
                decomposeTRS(this._localBelow(n, k), sc.t, sc.r, sc.s);
                quat.multiply(sc.f, sc.f, sc.r);
                if (topo.jointOfNode.has(n)) decomposeTRS(o.animator._sourceLocal(n) ?? rest?.get(n) ?? IDENTITY, sc.t, sc.r, sc.s);
                quat.multiply(sc.g, sc.g, sc.r);
            }
            quat.multiply(sc.g, quat.invert(sc.f, sc.f), sc.g);           // D = inv(F) x G
            quat.slerp(sc.g, quat.identity(sc.f), sc.g, s);
            decomposeTRS(layer, sc.t, sc.r, sc.s);
            quat.normalize(sc.r, quat.multiply(sc.r, sc.g, sc.r));
            return mat4.fromRotationTranslationScale(arenaMat(), sc.r, sc.t, sc.s);
        } finally {
            this._steadyDepth--;
        }
    }

    // How much of a layer's pose holds its model-space turn right now: the current state's `meshSpace`, eased
    // from what the layer showed over the transition into it. Timed by the state's own clock, not the clip
    // cross-fade: two states holding one pose do not cross-fade at all.
    private _steadyFrom = 0;
    private _steadyTarget = 0;
    private _steadyFade = 0;
    private _steadyNow(): number {
        if (this._steadyFade <= 0 || this._stateTime >= this._steadyFade) return this._steadyTarget;
        return this._steadyFrom + (this._steadyTarget - this._steadyFrom) * (this._stateTime / this._steadyFade);
    }

    // The additive reference for a bone: the current clip's first frame, or a field's (`_fieldReference`).
    private _additiveReference(nodeIndex: number): { t: vec3; r: quat } | null {
        const key = boneKey(nodeIndex);
        if (this._fieldEntries) return this._fieldReference(this._fieldEntries, key);
        const bone = this._bones.get(key);
        return bone ? bone.startTR() : null;
    }

    // A field's additive reference for a bone: each sample's first frame, mixed by the samples' weights as the
    // pose is (`_fieldLocal`), so a blend space of pose clips adds what each adds over its own start: the delta
    // of the mix is the mix of the deltas. Before this an additive layer playing a field added nothing (the
    // field owns no `_bones`). Null when no weighted sample animates the bone. Shared scratch: used at once.
    private _fieldReference(entries: FieldEntry[], key: string): { t: vec3; r: quat } | null {
        let total = 0, anchored = false;
        vec3.set(REF_T, 0, 0, 0);
        quat.set(REF_R, 0, 0, 0, 0);   // an accumulator, not a rotation yet
        for (const e of entries) {
            const bone = e.bones.get(key);
            if (!bone || !(e.weight > 0)) continue;
            const start = bone.startTR();
            if (!anchored) { quat.copy(REF_HEMI, start.r); anchored = true; }
            const w = quat.dot(REF_HEMI, start.r) < 0 ? -e.weight : e.weight;
            vec3.scaleAndAdd(REF_T, REF_T, start.t, e.weight);
            REF_R[0] += start.r[0] * w;
            REF_R[1] += start.r[1] * w;
            REF_R[2] += start.r[2] * w;
            REF_R[3] += start.r[3] * w;
            total += e.weight;
        }
        if (!anchored || total <= 0) return null;
        vec3.scale(REF_T, REF_T, 1 / total);
        if (quat.length(REF_R) < 1e-8) quat.copy(REF_R, REF_HEMI);
        quat.normalize(REF_R, REF_R);
        return FIELD_REF;
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

    // A pose as a clip: every listed bone held at `delta x rest` across one second. Two identical keys, because
    // a zero-length clip would wrap by `% 0`. Its additive reference (POSE_REFERENCES) is `pose.reference` (a
    // variant's base) or rest, so on an additive layer a pose adds what it changes from its base.
    private _poseClipOf(pose: AnimationPose, label: string): Animation {
        const cached = this._poseClips.get(pose);
        if (cached) return cached;
        const nodeOf = this._nodeOfBoneName();
        const reference = new Map<string, AnimationPoseBone>();
        for (const b of pose.reference ?? []) reference.set(b.name, b);

        const samplers: AnimationSampler[] = [];
        const channels: AnimationChannel[] = [];
        const refs = new Map<number, { t: vec3; r: quat }>();
        for (const bone of pose.bones ?? []) {
            const nodeIndex = nodeOf(bone.name);
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

            const ref = reference.get(bone.name);
            refs.set(nodeIndex, {
                t: ref?.translation ? vec3.add(vec3.create(), restT, vec3.fromValues(ref.translation[0], ref.translation[1], ref.translation[2])) : vec3.clone(restT),
                r: ref?.rotation
                    ? quat.normalize(quat.create(), quat.multiply(quat.create(),
                        quat.fromValues(ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]), restR))
                    : quat.clone(restR),
            });
        }
        const clip: Animation = { name: `pose:${label}`, samplers, channels };
        POSE_REFERENCES.set(clip, refs);
        this._poseClips.set(pose, clip);
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
        let resolveFinished!: () => void;
        const finished = new Promise<void>(r => { resolveFinished = r; });
        // Over: faded out, replaced, or stopped. Its `finished` resolves, and the event system hears `ActionFinished`.
        const resolve = (): void => {
            resolveFinished();
            this._postAnimationEvent('ActionFinished', { state: null, from: null, to: null, layer: slotName, clip: clipName });
        };
        const action: ActionState = {
            clipName, loop: !!options.loop, blendOut: Math.max(0, options.blendOut ?? 0.2),
            stopping: false, done: false, resolve,
            ikWeight: clamp(typeof options.ikWeight === 'number' ? options.ikWeight : 1, 0, 1),
        };
        const target = slot;
        const handle: AnimationActionHandle = {
            slot: slotName, clipName, finished,
            get done() { return action.done; },
            get time() { return action.done || target.action !== action ? 0 : target.animator._currentTime; },
            get duration() { return action.done || target.action !== action ? 0 : target.animator._getAnimationDuration(); },
            stop: (blendOut?: number) => {
                if (action.done || target.action !== action) return;
                action.stopping = true;
                target.presenceTarget = 0;
                target.fadeSeconds = Math.max(1e-3, blendOut ?? action.blendOut);
            },
            seek: (clipSeconds: number) => {
                if (action.done || target.action !== action || !Number.isFinite(clipSeconds)) return;
                const child = target.animator;
                const duration = child._getAnimationDuration();
                let at = Math.max(0, clipSeconds);
                if (duration > 0) at = action.loop ? at % duration : Math.min(at, duration);
                // As a part-way start does: the clock moves, and no event between the old time and the new fires.
                child._currentTime = at;
                child._prevEventTime = at;
                child._eventFromStart = false;
            },
        };
        if (!exists) {
            Logger.warn(`playAction: no clip named "${clipName}"`, 'Animation');
            action.done = true;
            resolveFinished();   // never played, so never finished playing: no ActionFinished
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
        if (typeof options.startTime === 'number' && options.startTime > 0) {
            // Join the clip part-way (one attack of a combo clip): the clock starts there, and neither the
            // events nor the root travel before it count -- the travel is read from the previous frame's time.
            child._currentTime = Math.min(options.startTime, child._getAnimationDuration());
            child._prevEventTime = child._currentTime;
            child._eventFromStart = false;
        }
        slot.action = action;
        slot.presenceTarget = 1;
        slot.fadeSeconds = Math.max(1e-3, options.blendIn ?? 0.15);
        // No blend-in: there at once, so the next pose (an update(0), say) is the clip's and not what it replaces.
        if (typeof options.blendIn === 'number' && options.blendIn <= 1e-3) slot.presence = 1;
        if (crossFade) child._activeBlendTime = slot.fadeSeconds;
        return handle;
    }

    /**
     * The world-space root travel extracted since the last call — by playing actions
     * (AnimationActionOptions.rootMotion) and by layer states that extract it
     * (AnimationState.extractRootMotion) — and reset. Divide by the frame time for a velocity.
     */
    public consumeRootMotion(out: vec3 = vec3.create()): vec3 {
        vec3.set(out, 0, 0, 0);
        for (const o of this._overlays) {
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

    /**
     * Clip seconds into the clip a layer's current state plays (a state with a `startTime` begins there),
     * or 0 when the layer is unknown or plays nothing. A non-looping clip stops at its duration, so
     * `layerStateTime(l) >= layerStateDuration(l)` is "the clip has reached its end".
     */
    public layerStateTime(layer: string): number {
        const o = this._overlays.find(x => x.kind === 'layer' && x.name === layer);
        return o && !o.animator._overlayEmpty && o.animator._currentAnimation ? o.animator._currentTime : 0;
    }

    /**
     * Where a layer's current state is in its cycle, 0..1 (a blend space's phase, a clip's time over its length),
     * or null when the layer is unknown or plays nothing. A layer state in the base's sync group reads the base's.
     */
    public layerPhase(layer: string): number | null {
        const o = this._overlays.find(x => x.kind === 'layer' && x.name === layer);
        return o && !o.animator._overlayEmpty ? o.animator._cyclePhase() : null;
    }

    /** Length in clip seconds of the clip a layer's current state plays, or 0 (see layerStateTime). */
    public layerStateDuration(layer: string): number {
        const o = this._overlays.find(x => x.kind === 'layer' && x.name === layer);
        return o && !o.animator._overlayEmpty && o.animator._currentAnimation ? o.animator._getAnimationDuration() : 0;
    }

    /**
     * The trigger whose state `layer` (the base when omitted or null) is playing: the one that entered it,
     * still holding through any trigger-less transition after it (a sheathe going on into the draw), and
     * null once the layer is back in its entry state. A script that fired `Roll` knows its roll is over
     * when this stops reading `Roll` — without naming any state.
     */
    public activeTrigger(layer?: string | null): string | null {
        if (!layer) return this._activeTrigger;
        return this._overlays.find(x => x.kind === 'layer' && x.name === layer)?.animator._activeTrigger ?? null;
    }

    /**
     * What firing `trigger` plays (see {@link AnimationTriggerInfo}), or null when nothing reads it. The
     * state it enters is looked for from the top layer down to the base: a state entered by that trigger
     * directly, else an Any State transition on it, else a transition from some state on it.
     */
    public triggerInfo(trigger: string): AnimationTriggerInfo | null {
        const sm = this._stateMachine;
        if (!sm || !trigger) return null;
        const machines: (MachineView & { layer: string | null })[] = [
            ...[...(sm.layers ?? [])].reverse().map(l => ({ layer: l.name, states: l.states, transitions: l.transitions, groups: l.groups, forks: l.forks })),
            { layer: null, states: sm.states, transitions: sm.transitions, groups: sm.groups, forks: sm.forks },
        ];
        const reads = (t: AnimationTransition) => {
            let hit = false;
            forEachCondition(t.condition, t.conditions, c => { if (c.op === 'trigger' && c.param === trigger) hit = true; });
            return hit;
        };
        for (const m of machines) {
            let to = m.states.find(s => s.triggers?.some(e => e.trigger === trigger))?.name;
            let fromAnywhere = !!to;
            if (!to) {
                // A way out of a fork Any State goes into fires from anywhere as well.
                const anywhere = forksFromAnywhere(m);
                to = m.transitions.find(t => (t.from === '*' || anywhere.has(t.from)) && reads(t))?.to;
                fromAnywhere = !!to;
            }
            if (!to) to = m.transitions.find(t => t.from !== '*' && reads(t))?.to;
            // A transition into a group enters its entry state; into a fork, it goes on through the fork's first way out.
            const end = to ? staticEnd(m, to) : null;
            const state = end ? m.states.find(s => s.name === end) : undefined;
            if (!state) continue;
            const clip = state.clipName && !state.field && !state.pose ? state.clipName : '';
            return {
                layer: m.layer, state: state.name, clip, clipLength: this._clipLengthOf(clip),
                speed: this._rateOf(state), startTime: Math.max(0, state.startTime ?? 0),
                seconds: this._secondsOf(state, m, new Set()),
                extractsRootMotion: !!state.extractRootMotion, fromAnywhere,
            };
        }
        return null;
    }

    private _clipLengthOf(name: string): number {
        const clip = name ? this._animatedModel?.animations.find(a => a.name === name) : undefined;
        if (!clip) return 0;
        let end = 0;
        for (const s of clip.samplers) if (s.input.length) end = Math.max(end, s.input[s.input.length - 1]);
        return end;
    }

    // A state's playback rate right now, as _applyStateSpeed would set it.
    private _rateOf(state: AnimationState): number {
        let rate = state.speed ?? 1;
        const v = state.speedParam ? this._paramValues.get(state.speedParam) : undefined;
        if (v !== undefined) rate = typeof v === 'number' ? v : (v ? 1 : 0);
        const scale = state.speedScaleParam ? this._paramValues.get(state.speedScaleParam) : undefined;
        if (typeof scale === 'number' && Number.isFinite(scale)) rate *= scale;
        return Math.max(0, rate);
    }

    // Real seconds `state` plays before its layer rests or waits on another trigger (AnimationTriggerInfo.seconds).
    private _secondsOf(state: AnimationState, m: MachineView, seen: Set<string>): number {
        if (seen.has(state.name)) return 0;
        seen.add(state.name);
        const clip = state.clipName && !state.field && !state.pose ? state.clipName : '';
        const length = this._clipLengthOf(clip);
        if (!length || state.loop) return 0;
        const rate = Math.max(0.05, this._rateOf(state));
        const start = Math.max(0, state.startTime ?? 0);
        const isEntry = (name: string) => !!m.states.find(s => s.name === name)?.isEntry;
        // Its ways out that wait for its clip: a transition, or one through forks with a leg that waits (all must
        // hold, so the latest exit time is the one).
        const exitOf = (p: MachinePath) => Math.max(...p.legs.filter(l => l.hasExitTime).map(l => l.exitTime ?? 1));
        const out = pathsFrom(m, state.name).filter(p => p.to !== state.name && p.legs.some(l => l.hasExitTime) && !isEntry(p.to));
        // A hand-over on a trigger ends this state's own part there (a combo's next segment waits for a press).
        const onTrigger = out.filter(p => p.legs.some(l => firstTriggerOf(l))).map(p => exitOf(p) * length);
        const end = onTrigger.length ? Math.min(length, ...onTrigger) : length;
        const own = Math.max(0, end - start) / rate;
        if (onTrigger.length) return own;
        // One that goes on by itself (sheathe, then draw) lasts as long as what it goes on into, too.
        const next = out.find(p => p.legs.every(l => !firstTriggerOf(l) && !l.condition?.children?.length && !l.conditions?.length));
        const after = next ? m.states.find(s => s.name === next.to) : undefined;
        return own + (after ? this._secondsOf(after, m, seen) : 0);
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

    /**
     * Draw the skeleton from simulated bodies while the animation keeps running underneath, as its target
     * (see PhysicsMappingSource). Replaces any earlier source.
     */
    public enablePhysicsMapping(source: PhysicsMappingSource): void {
        this._physicsMapping = source;
        this._playing = true;
        this._keepTarget();
    }

    /** Draw the animation alone again. */
    public disablePhysicsMapping(): void {
        if (!this._physicsMapping) return;
        this._physicsMapping = null;
        this.ikSuppressed = false;
        this.handIkSuppressed = false;
        this.footLockSuppressed = false;
        // Skinning matrices back to the animation's, now.
        if (this._targetBones.length === this._finalBoneMatrices.length) {
            for (let j = 0; j < this._finalBoneMatrices.length; j++) {
                mat4.copy(this._finalBoneMatrices[j], this._targetBones[j]);
                if (this._targetModel[j]) mat4.copy(this._jointModelMatrices[j] ??= mat4.create(), this._targetModel[j]);
            }
        }
    }

    /** True while bodies draw the skeleton over a running animation (a powered ragdoll). */
    public get physicsMapped(): boolean { return this._physicsMapping !== null; }

    /**
     * The skinning matrices the ANIMATION poses, before any physics mapping: what a powered ragdoll's muscles
     * reach for. The same array as getFinalBoneMatrices when nothing maps the skeleton. Live: overwritten by the
     * next pose.
     */
    public getTargetBoneMatrices(): mat4[] {
        return this._physicsMapping && this._targetBones.length === this._finalBoneMatrices.length ? this._targetBones : this._finalBoneMatrices;
    }

    /** A joint's model-space transform as the ANIMATION poses it (see getTargetBoneMatrices). */
    public getTargetJointModelMatrix(jointIndex: number): mat4 | null {
        if (!this._physicsMapping) return this.getJointModelMatrix(jointIndex);
        return this._targetModel[jointIndex] ?? this.getJointModelMatrix(jointIndex);
    }

    /** The animation's pose, kept as the target before the mapping draws over it. */
    private _keepTarget(): void {
        const n = this._finalBoneMatrices.length;
        for (let j = 0; j < n; j++) {
            mat4.copy(this._targetBones[j] ??= mat4.create(), this._finalBoneMatrices[j]);
            const model = this._jointModelMatrices[j];
            if (model) mat4.copy(this._targetModel[j] ??= mat4.create(), model);
        }
        this._targetBones.length = n;
    }

    private readonly _mapAnim = [0, 0, 0, 0, 0, 0, 1];
    private readonly _mapSim = [0, 0, 0, 0, 0, 0, 1];
    private readonly _mapX = [0, 0, 0, 0, 0, 0, 1];
    private readonly _mapQ = quat.create();
    private _mapParts: mat4[] = [];
    private readonly _mapInv = mat4.create();
    private readonly _mapA = mat4.create();
    private readonly _mapB = mat4.create();

    /**
     * Skinning matrices carried from the animation to the bodies: per part, D = inv(N)·B·inv(A)·N in model
     * space, A the part as animated, B as drawn (A blended toward the simulation by the part's weight); every
     * bone the part carries is D times its animated matrix, so a bone keeps where the animation puts it RELATIVE
     * to its part (fingers on a physical hand still curl).
     */
    private _applyPhysicsMapping(): void {
        const src = this._physicsMapping, skin = this._skin, node = this._node;
        if (!src || !skin || !node) return;
        const n = this._finalBoneMatrices.length;
        if (this._targetBones.length !== n) this._keepTarget();
        const nodeWorld = node.worldTransform as mat4;
        if (!mat4.invert(this._mapInv, nodeWorld)) return;
        const parts = src.partCount;
        while (this._mapParts.length < parts) this._mapParts.push(mat4.create());
        const active: boolean[] = [];
        const anim = this._mapAnim, sim = this._mapSim;
        // Drawn against an anchor: X = A·inv(S), the anchor as animated over the anchor as simulated, on every part.
        const anchor = src.anchorPart ?? -1, X = this._mapX;
        let anchored = false;
        if (anchor >= 0 && anchor < parts) {
            src.animatedPose(anchor, this._targetBones, nodeWorld, anim);
            src.simulatedPose(anchor, sim);
            const qx = quat.multiply(this._mapQ, [anim[3], anim[4], anim[5], anim[6]] as quat, quat.conjugate(quat.create(), [sim[3], sim[4], sim[5], sim[6]] as quat));
            const ps = vec3.transformQuat(vec3.create(), [sim[0], sim[1], sim[2]], qx);
            X[0] = anim[0] - ps[0]; X[1] = anim[1] - ps[1]; X[2] = anim[2] - ps[2];
            X[3] = qx[0]; X[4] = qx[1]; X[5] = qx[2]; X[6] = qx[3];
            anchored = X.every(v => Number.isFinite(v));
        }
        for (let p = 0; p < parts; p++) {
            const w = src.mappingWeight(p);
            active[p] = w > 0;
            if (!active[p]) continue;
            src.animatedPose(p, this._targetBones, nodeWorld, anim);
            src.simulatedPose(p, sim);
            if (anchored && p !== anchor) {
                const q = [X[3], X[4], X[5], X[6]] as quat;
                const at = vec3.transformQuat(vec3.create(), [sim[0], sim[1], sim[2]], q);
                const r = quat.multiply(quat.create(), q, [sim[3], sim[4], sim[5], sim[6]] as quat);
                sim[0] = at[0] + X[0]; sim[1] = at[1] + X[1]; sim[2] = at[2] + X[2];
                sim[3] = r[0]; sim[4] = r[1]; sim[5] = r[2]; sim[6] = r[3];
            }
            let ok = true;
            for (let i = 0; i < 7; i++) if (!Number.isFinite(sim[i])) ok = false;
            if (!ok) { active[p] = false; continue; }
            const qa = [anim[3], anim[4], anim[5], anim[6]] as quat;
            const qb = w >= 1 ? [sim[3], sim[4], sim[5], sim[6]] as quat : quat.slerp(quat.create(), qa, [sim[3], sim[4], sim[5], sim[6]] as quat, w);
            const pb: vec3 = w >= 1 ? [sim[0], sim[1], sim[2]] : [anim[0] + (sim[0] - anim[0]) * w, anim[1] + (sim[1] - anim[1]) * w, anim[2] + (sim[2] - anim[2]) * w];
            mat4.fromRotationTranslation(this._mapA, qa, [anim[0], anim[1], anim[2]]);
            mat4.invert(this._mapA, this._mapA);
            mat4.fromRotationTranslation(this._mapB, qb, pb);
            const d = this._mapParts[p];
            // D = inv(N) · B · inv(A) · N
            mat4.multiply(d, this._mapB, this._mapA);
            mat4.multiply(d, d, nodeWorld);
            mat4.multiply(d, this._mapInv, d);
        }
        for (let j = 0; j < n; j++) {
            const p = src.partOfJoint[j];
            const target = this._targetBones[j], model = this._targetModel[j];
            if (p >= 0 && p < parts && active[p]) {
                const d = this._mapParts[p];
                mat4.multiply(this._finalBoneMatrices[j], d, target);
                if (model) mat4.multiply(this._jointModelMatrices[j] ??= mat4.create(), d, model);
            } else {
                mat4.copy(this._finalBoneMatrices[j], target);
                if (model) mat4.copy(this._jointModelMatrices[j] ??= mat4.create(), model);
            }
        }
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
        this._unbindCommands?.();
        this._unbindCommands = null;
        this._node = node;
        if (node && !this._isOverlay) this._unbindCommands = bindAnimatorCommands(node, this);
    }
    
    /** Evaluate the mapping triggers and start any animation they select. Call before {@link update}. */
    public checkTriggers(): void {
        // While ragdolling, ignore animation triggers (and don't fall back to T-pose).
        if (this._ragdollActive) return;
        if (!this._animatedModel) return;
        this._catchUpClips();

        // The state machine, when present, is the source of truth for what plays.
        if (this._stateMachine) {
            // A fired transition's triggers are lowered only after every layer has had its look, so a
            // trigger the base and a layer both read (Died) fires both rather than whichever comes first.
            const fired: AnimationTransition[] = [];
            this._pendingTriggerConsumes = fired;
            try {
                this._evaluateStateMachine();
                // Layers after the base, so they read parameters the base's variable bindings just refreshed.
                for (const o of this._overlays) {
                    if (o.kind !== 'layer') continue;
                    o.animator._pendingTriggerConsumes = fired;
                    try { o.animator._evaluateStateMachine(); }
                    finally { o.animator._pendingTriggerConsumes = null; }
                }
            } finally {
                this._pendingTriggerConsumes = null;
            }
            for (const t of fired) consumeTriggers(this._conditionCtx, t.condition, t.conditions);
            this._publishMovementHold();
            // A Ragdoll or Get Up state entered: the reactions take the body now, as a script's call would.
            this._flushReactionEdge();
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
        this._ikFootLocks.clear();
        this._ikPlantedShare.clear();
        this._ikHipOffset = 0;

        // Stop any playing animation
        this._playing = false;
        // A surviving _isBlending would have _recomputePose mix the old clips back in next frame.
        this._isBlending = false;
        this._frozenPrevious = null;
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
