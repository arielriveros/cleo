import { v4 as uuidv4 } from 'uuid';
import { Logger } from "../../logger";
import { Node } from "./node";
import { CharacterNode } from "./characterNode";
import { CameraRigNode } from "./cameraRigNode";
import { unwrapScriptNode } from "./nodeScripting";
import { InputSystem } from "../../../input/inputSystem";
import { applyPlayerReading, clearIntent, createIntent } from "../../control/intent";
import type { ControlIntent, PlayerReading } from "../../control/intent";
import {
    align, arrive, avoidObstacles, blendSteering, cohere, createSteeringState, flee, followTarget,
    intentFromDesired, seek, separate, steeringTuning, wander,
} from "../../control/steering";
import type {
    FlockNeighbour, ProbeHit, SteeringState, SteeringTuning,
} from "../../control/steering";
import {
    AI_GOALS, BEHAVIOR_SENSES, createBehaviorRuntime, isDefaultBehaviorMachine, parseBehaviorMachine,
    stepBehavior,
} from "../../control/behavior";
import type {
    AiGoal, BehaviorMachine, BehaviorParameterSource, BehaviorRuntime, BehaviorState,
} from "../../control/behavior";
import {
    advancePath, clearNavPath, createNavPath, createRepathState, followPath, hasPath, insetCorners,
    markRepathed, remainingDistance, repathPolicy, setNavPath, shouldRepath,
} from "../../../ai/navPath";
import type { NavPath, RepathPolicy, RepathState } from "../../../ai/navPath";
import { Perception, perceptionTuning } from "../../../ai/perception";
import { yawFromDirection } from "../../../ai/interop";
import type { LineOfSightTest, PerceptionCandidate, PerceptionTuning } from "../../../ai/perception";
import { EMPTY_FUZZY_MODEL, FuzzyBrain, isDefaultFuzzyModel, parseFuzzyModel } from "../../../ai/fuzzy";
import { EMPTY_GOAL_GRAPH, GoalBrain, isDefaultGoalGraph, parseGoalGraph } from "../../../ai/goals";
import type { GoalContext, GoalGraph } from "../../../ai/goals";
import { conditionNodeMet } from "../../conditions";
import type { FuzzyModel } from "../../../ai/fuzzy";
import { aiStats } from "../../../ai/aiStats";
import { vec3 } from "gl-matrix";

/**
 * A driver: it possesses a {@link CharacterNode} and decides, each frame, what that character should try
 * to do. Whether the decision comes from a player's actions or from a brain is this node's business and
 * nobody else's.
 *
 * ## Why a separate node rather than a flag on the character
 *
 * Possession makes the driver and the pawn independent things. One AI controller can move between pawns;
 * a player can take over an NPC at runtime by re-possessing it; a cutscene can release a character and
 * leave it standing. A `controlSource` field on the character itself would make all three of those a
 * matter of swapping the character out.
 *
 * ## Ordering
 *
 * {@link think} runs in `Scene.update`'s CONTROL PASS, before the node loop — so every pawn's intent is
 * complete before any `onUpdate` reads it, regardless of where the controller sits in the tree. Putting
 * this in `onUpdate` would make a controller authored after its pawn write intent one frame late.
 *
 * One consequence worth knowing: `dispatchActions` (a node's `onAction`) runs INSIDE the node loop, i.e.
 * after `think`. A controller must therefore POLL `Input.started(...)` rather than rely on `onAction`.
 * Edges are still exactly one frame — `resolveFrame` ran at the top of the frame in
 * `InputSystem.beginFrame` — so polling loses nothing.
 *
 * ## What it buys the camera
 *
 * Because the control pass drives the aim rig BEFORE the character reads it, the character acts on THIS
 * frame's aim. The script pair this replaces read a pivot yaw written by the previous frame's late pass,
 * so a fast camera swing and the strafe that should match it were one frame apart.
 */

export const CONTROL_SOURCES = ['player', 'ai', 'none'] as const;
export type ControlSource = typeof CONTROL_SOURCES[number];

/** Where the "forward" of a movement intent points. */
/** Which brain decides the goal. `machine` is the default, so no existing scene changes. */
export const BRAIN_KINDS = ['machine', 'goal', 'none'] as const;
export type BrainKind = typeof BRAIN_KINDS[number];

export const AIM_SOURCES = ['possessed', 'node', 'world'] as const;
export type AimSource = typeof AIM_SOURCES[number];

/**
 * What an AI controller is trying to do. The verb; the blackboard supplies the noun.
 *
 * `script` writes no intent at all and leaves the whole frame to `onThink` — the escape hatch for a brain
 * this list cannot express, without giving up possession, the aim basis or obstacle avoidance.
 *
 * Defined in `control/behavior.ts`, because a behaviour state names one and that module has to stay a
 * pure leaf. Re-exported here so nothing downstream has to know that.
 */
export { AI_GOALS };
export type { AiGoal };

/** What a blackboard entry may hold. A node id is a string — see `targetKey`. */
export type BlackboardValue = number | boolean | string;

export class ControllerNode extends Node {
    // ----- possession ------------------------------------------------------------------------------
    // The id is the truth and the node handle is a resolution cache — CameraRigNode's pattern, for the
    // same reason: parse is depth-first, so the target very often does not exist yet.
    private _possessedId: string | null = null;
    private _possessed: CharacterNode | null = null;
    private _warnedDanglingPossessed: boolean = false;
    private _warnedStolen: boolean = false;

    // ----- source ----------------------------------------------------------------------------------
    public controlSource: ControlSource = 'player';

    /**
     * ACTION NAMES, not key codes. Nothing in this file names a key, so a player can rebind every one of
     * these in the Input panel and this controller keeps working. An empty or unknown name reads as idle.
     */
    public moveAction: string = 'Move';
    public lookAction: string = 'Look';
    public jumpAction: string = 'Jump';
    public sprintAction: string = 'Sprint';
    public crouchAction: string = '';

    // ----- aim -------------------------------------------------------------------------------------
    /**
     * Where movement's "forward" comes from. `possessed` finds the camera rig under the pawn — the usual
     * third-person setup — `node` names one explicitly, and `world` makes movement world-relative, which
     * is what a top-down game and every steering primitive want.
     */
    public aimSource: AimSource = 'possessed';
    private _aimSourceId: string | null = null;
    private _aimNode: Node | null = null;
    private _aimRig: CameraRigNode | null = null;
    /**
     * Whether to push the look intent into the aim rig. This is what replaces the camera script's
     * `addYaw`/`addPitch` — leave it on unless something else is driving the rig, because two writers
     * fighting over one rig is a camera that moves at double speed.
     */
    public driveAimTarget: boolean = true;

    // ----- AI ---------------------------------------------------------------------------------------
    /** What this controller is trying to do while its source is `ai`. */
    public goal: AiGoal = 'idle';
    /**
     * The blackboard key naming the goal's target — a NODE ID, or the string 'point' to use
     * {@link goalPoint}.
     *
     * A key rather than a node reference field, deliberately: "chase whoever the blackboard calls
     * `target`" is authored once and works for every copy of an NPC, with no id to dangle and nothing
     * for `regenerateNodeIds` to remap. A script writes it with `setBlackboard('target', node.id)`.
     */
    public targetKey: string = 'target';
    /** Used when `targetKey` resolves to nothing, so a goal can name a place rather than a thing. */
    public goalPoint: [number, number, number] = [0, 0, 0];

    /**
     * An authored behaviour machine, or an empty one. When it holds a state, that state's goal and target
     * override {@link goal} and {@link targetKey} — so a controller with no machine behaves exactly as it
     * did before machines existed.
     */
    public behavior: BehaviorMachine = { parameters: [], states: [], transitions: [] };

    // ----- navigation -------------------------------------------------------------------------------
    /**
     * Which navmesh this controller paths on, or null for the scene's first baked one — so a scene
     * with a single navmesh needs no wiring. In NODE_REF_KEYS, so a duplicated pair paths on its own
     * copy rather than the original.
     */
    private _navMeshId: string | null = null;
    private _warnedDanglingNavMesh: boolean = false;

    /** Named route walked by the `patrol` goal. Empty patrols in place. */
    public routeName: string = '';

    /** How often a route is recomputed, and how far the destination may drift before it is. */
    public repath: RepathPolicy = repathPolicy();

    // ----- perception -------------------------------------------------------------------------------
    /** Cone, range, memory span and reaction delay. */
    public perception: PerceptionTuning = perceptionTuning();

    /**
     * Height above the pawn's origin that the agent looks FROM, in world units.
     *
     * A pawn's origin is at its feet, and a ray cast from there runs along the floor — which counts as
     * an obstacle, so an agent with no eye height is blind in exactly the situations it most needs to
     * see. Also what a ray is cast TOWARD is the other pawn's origin, i.e. its feet, so crouching
     * behind low cover works without anything extra.
     */
    public eyeHeight: number = 1.6;

    /**
     * Write the nearest NOTICED character's id into the blackboard under {@link targetKey}, every
     * frame it can see one.
     *
     * On by default, because it is what makes a guard work with nothing but a goal set: without it
     * perception fills in the senses but nobody ever becomes the target, and every chase has to be
     * wired by a script. A brain that picks its own targets turns this off.
     */
    public autoAcquire: boolean = true;

    /**
     * How close counts as having reached an intermediate waypoint. Too small and an agent circles a
     * corner it has already rounded; too large and it cuts across geometry the route went around.
     */
    public waypointRadius: number = 0.5;

    /**
     * An authored fuzzy model, or an empty one.
     *
     * Its INPUT variables are named after senses and motion builtins -- a variable called
     * `distanceToTarget` is fed from that sense, one called `planarSpeed` from the pawn. That is a
     * deliberate convention rather than a second mapping to author: the vocabulary already exists, and
     * a mapping table would be one more place for the two to disagree.
     *
     * Outputs are read through a `{ kind: 'fuzzy' }` behaviour parameter.
     */
    public fuzzy: FuzzyModel = { ...EMPTY_FUZZY_MODEL };

    /**
     * Which brain decides the goal.
     *
     * `machine` is the behaviour state machine and the DEFAULT, so no existing scene changes. `goal`
     * runs the goal graph instead. `none` leaves the goal field alone, which is what a controller
     * driven entirely from `onThink` wants.
     */
    public brain: BrainKind = 'machine';

    /** An authored goal graph, or an empty one. Read only while `brain` is `goal`. */
    public goals: GoalGraph = { ...EMPTY_GOAL_GRAPH };

    // ----- flocking ---------------------------------------------------------------------------------
    /**
     * How far this agent looks for flock-mates, in world units. 0 disables flocking entirely and is
     * why the neighbour gather costs nothing for an agent that is not in a group.
     */
    public flockRadius: number = 6;

    /** Push away from crowding. Usually the strongest of the three, or a flock merges into a point. */
    public separationWeight: number = 1.5;
    /** Match the group's heading. */
    public alignmentWeight: number = 1;
    /** Steer toward the group's centre. Usually the weakest, or a flock collapses inward. */
    public cohesionWeight: number = 0.8;

    public steering: SteeringTuning = steeringTuning();
    /** How many rays to fan ahead for obstacle avoidance. Only fired while `steering.avoidDistance > 0`. */
    public whiskerCount: number = 3;
    /** Total spread of that fan, in degrees. */
    public whiskerSpread: number = 60;

    // ----- runtime state (never serialized) --------------------------------------------------------
    private readonly _intent: ControlIntent = createIntent();
    private readonly _blackboard = new Map<string, BlackboardValue>();
    private _steeringState: SteeringState = createSteeringState();
    private _behaviorRuntime: BehaviorRuntime = createBehaviorRuntime();
    private _probes: ProbeHit[] = [];
    private readonly _path: NavPath = createNavPath();
    private readonly _repathState: RepathState = createRepathState();
    private _routeIndex: number = 0;
    private readonly _pathScratch: vec3[] = [];
    private readonly _perception = new Perception();
    private readonly _candidates: PerceptionCandidate[] = [];
    private readonly _rayHit: vec3 = vec3.create();
    private readonly _eye: vec3 = vec3.create();
    /** Ids offered to perception this frame, so a hit ON a candidate is not read as a wall. */
    private readonly _candidateIds = new Set<string>();
    /** Built lazily from `fuzzy`, and rebuilt when the authored model is replaced. */
    private _fuzzyBrain: FuzzyBrain | null = null;
    private _fuzzySource: FuzzyModel | null = null;
    private readonly _fuzzyInputs: Record<string, number> = {};
    private _fuzzyOutputs: Record<string, number> = {};
    private _goalBrain: GoalBrain | null = null;
    private _goalSource: GoalGraph | null = null;
    /** What the goal brain asked for this frame, or null when it asked for nothing. */
    private _goalDrive: { goal: AiGoal; targetKey?: string; speedScale: number } | null = null;
    private _goalContext: GoalContext | null = null;
    /** Rebuilt each frame a flock steer runs. Two arrays because `separate` reads positions only. */
    private readonly _neighbours: FlockNeighbour[] = [];
    private readonly _neighbourPositions: vec3[] = [];
    private _neighbourCount: number = 0;
    private readonly _separation: vec3 = vec3.create();
    private readonly _alignment: vec3 = vec3.create();
    private readonly _cohesion: vec3 = vec3.create();
    /** Bound once: a fresh closure per frame per agent is the kind of garbage that shows up in a HUD. */
    private readonly _lineOfSight: LineOfSightTest = (from, to, hit) => this._testLineOfSight(from, to, hit);
    private readonly _desired: vec3 = vec3.create();
    private readonly _selfPos: vec3 = vec3.create();
    private readonly _targetPos: vec3 = vec3.create();
    private readonly _targetVel: vec3 = vec3.create();
    /** Scratch for the gravity-up vector. Named for the steering use so it cannot collide with Node's. */
    private readonly _steerUp: vec3 = vec3.fromValues(0, 1, 0);
    private readonly _reading: PlayerReading = {
        move: [0, 0], look: [0, 0], jump: false, sprint: false, crouch: false,
    };

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'controller', id);
    }

    // ----- possession ------------------------------------------------------------------------------

    /** The character this controller drives, or null. Resolved through a cache. */
    public get possessed(): CharacterNode | null { return this._resolvePossessed(); }

    public get possessedId(): string | null { return this._possessedId; }
    public set possessedId(id: string | null) {
        if (id === this._possessedId) return;
        this._detach();
        this._possessedId = id;
        this._possessed = null;
        this._aimRig = null;
        this._warnedDanglingPossessed = false;
    }

    /**
     * Take control of `node`. Passing null releases.
     *
     * A character already possessed by someone else is TAKEN OVER, with a warning naming both — the
     * data model cannot prevent two controllers naming one pawn, so the choice is between detecting it
     * and pretending it cannot happen. Last-possess-wins is also what makes "the player takes over this
     * NPC" a single call rather than a handshake with the AI controller.
     */
    public possess(node: CharacterNode | null): this {
        // The script proxy's `set` trap forwards values untouched, so an assignment from a script would
        // otherwise store a Proxy that never compares equal to the real node.
        const raw = node ? unwrapScriptNode(node) as CharacterNode : null;
        if (raw === this._possessed && raw?.id === this._possessedId) return this;

        this._detach();
        if (raw && raw.controller && raw.controller !== this && !this._warnedStolen) {
            this._warnedStolen = true;
            Logger.warn(
                `Controller '${this._name}' took '${raw.name}' from controller ` +
                `'${raw.controller.name}'. A character has one driver; the last to possess it wins.`, 'Scene');
        }
        this._possessed = raw;
        this._possessedId = raw ? raw.id : null;
        this._aimRig = null;
        this._warnedDanglingPossessed = false;
        raw?._setController(this);
        return this;
    }

    public release(): this {
        this._detach();
        this._possessed = null;
        this._possessedId = null;
        this._aimRig = null;
        return this;
    }

    /** Drop the back-pointer, but only if the pawn still thinks WE are its driver. */
    private _detach(): void {
        const current = this._resolvePossessed();
        if (current && current.controller === this) current._setController(null);
    }

    private _resolvePossessed(): CharacterNode | null {
        const id = this._possessedId;
        if (!id) return (this._possessed = null);
        const cache = this._possessed;
        // `scene` is nulled on detach, which is how a despawned target is caught without a map lookup on
        // the common path.
        if (cache && cache.id === id && cache.scene && !cache.markForRemoval) return cache;
        const found = this._scene?.getNodeById(id) ?? null;
        // An id pointing at some other node type resolves to NULL rather than to something that cannot be
        // driven — a controller quietly steering a light would be harder to diagnose than one doing nothing.
        this._possessed = found instanceof CharacterNode ? found : null;
        if (this._possessed) this._possessed._setController(this);
        return this._possessed;
    }

    // ----- navigation -------------------------------------------------------------------------------

    public get navMeshId(): string | null { return this._navMeshId; }
    public set navMeshId(id: string | null) {
        if (id === this._navMeshId) return;
        this._navMeshId = id;
        this._warnedDanglingNavMesh = false;
        clearNavPath(this._path);
    }

    /** The route currently being walked. Read-only in spirit — for the editor's readout and onThink. */
    public get path(): Readonly<NavPath> { return this._path; }

    /** Planar distance still to walk, or 0 when there is no route. Backs the `pathRemaining` sense. */
    public get pathRemaining(): number {
        const pawn = this._resolvePossessed();
        if (!pawn || !hasPath(this._path)) return 0;
        const p = pawn.worldPosition;
        return remainingDistance(this._path, vec3.set(this._selfPos, p[0], p[1], p[2]), this._resolveUp());
    }

    // ----- aim -------------------------------------------------------------------------------------

    public get aimSourceId(): string | null { return this._aimSourceId; }
    public set aimSourceId(id: string | null) {
        this._aimSourceId = id;
        this._aimNode = null;
    }

    /** The camera rig this controller steers, if the aim resolves to one. */
    public get aimRig(): CameraRigNode | null {
        const node = this._resolveAimNode();
        return node instanceof CameraRigNode ? node : null;
    }

    private _resolveAimNode(): Node | null {
        if (this.aimSource === 'world') return null;

        if (this.aimSource === 'node') {
            const id = this._aimSourceId;
            if (!id) return null;
            const cache = this._aimNode;
            if (cache && cache.id === id && cache.scene && !cache.markForRemoval) return cache;
            return (this._aimNode = this._scene?.getNodeById(id) ?? null);
        }

        // 'possessed': the first camera rig under the pawn. This replaces the script's name match against
        // a 'Camera Pivot' child, which broke the moment anyone renamed it.
        const cached = this._aimRig;
        if (cached && cached.scene && !cached.markForRemoval) return cached;
        const pawn = this._resolvePossessed();
        return (this._aimRig = pawn ? ControllerNode._findRig(pawn) : null);
    }

    private static _findRig(node: Node): CameraRigNode | null {
        for (const child of node.children) {
            // Editor-only helpers are not part of the actor.
            if (child.name.includes('__editor__') || child.name.includes('__debug__')) continue;
            if (child instanceof CameraRigNode) return child;
            const found = ControllerNode._findRig(child);
            if (found) return found;
        }
        return null;
    }

    /**
     * The world yaw movement's "forward" means.
     *
     * A `CameraRigNode` reports `.yaw`, which is a WORLD yaw — the rig cancels its parent's rotation every
     * frame — so it needs no correction for the body turning underneath it. A plain node falls back to its
     * euler, which is only valid because such a pivot sets that euler directly.
     */
    private _basisYaw(): number {
        const node = this._resolveAimNode();
        if (!node) return 0;
        if (node instanceof CameraRigNode) return node.yaw;
        return node.rotation[1];
    }

    // ----- the control pass -------------------------------------------------------------------------

    /**
     * Sample the source, steer the aim, and publish intent to the pawn.
     *
     * Called by the scene's control pass, never by `onUpdate`. Guarded by the caller the same way
     * `dispatchActions` is, so one bad controller cannot escape the frame.
     */
    public think(delta: number): void {
        const pawn = this._resolvePossessed();
        if (!pawn) {
            if (this._possessedId && !this._warnedDanglingPossessed) {
                this._warnedDanglingPossessed = true;
                Logger.warn(
                    `Controller '${this._name}' possesses '${this._possessedId}', which is not a Character ` +
                    `in this scene. It will drive nothing until that node exists.`, 'Scene');
            }
            return;
        }

        const basisYaw = this._basisYaw();

        switch (this.controlSource) {
            case 'player':
                this._readPlayer();
                applyPlayerReading(this._intent, this._reading, basisYaw, pawn.jumpBufferSeconds);
                break;
            case 'ai':
                this._steer(pawn, delta);
                break;
            case 'none':
                clearIntent(this._intent);
                break;
        }

        // Steer the camera BEFORE the pawn consumes the intent, so the strafe matches this frame's look
        // rather than the previous one's.
        if (this.driveAimTarget && this.controlSource !== 'none') this._driveAim();

        this._publish(pawn);

        // Last, so a script patches an intent that is otherwise complete rather than fighting the source.
        if (this.onThink !== Node.prototype.onThink) {
            try { this.onThink(delta); }
            catch (e) { Logger.error(`Error in onThink function for node ${this._name}: ${e}`, 'Script'); }
        }
    }

    private _readPlayer(): void {
        const input = InputSystem.instance;
        const move = input.vector(this.moveAction);
        const look = input.vector(this.lookAction);
        this._reading.move[0] = move[0];
        this._reading.move[1] = move[1];
        this._reading.look[0] = look[0];
        this._reading.look[1] = look[1];
        // The press EDGE, not the held state: a held button must not re-raise the request every frame,
        // which would make the jump buffer meaningless.
        this._reading.jump = this.jumpAction ? input.started(this.jumpAction) : false;
        this._reading.sprint = this.sprintAction ? input.pressed(this.sprintAction) : false;
        this._reading.crouch = this.crouchAction ? input.pressed(this.crouchAction) : false;
    }

    // ----- perception -------------------------------------------------------------------------------

    /**
     * Look around, remember what was seen, and optionally pick a target.
     *
     * Called by the scene's PERCEPTION PASS, before any controller thinks — so a brain reads this
     * frame's senses rather than the previous one's. Not called while authoring: the editor's scene is
     * started and unpaused, and paying a raycast per candidate on every frame of every open tab, for
     * senses nothing is reading while nothing moves, is the one part of this that would be felt.
     */
    public perceive(delta: number): void {
        const pawn = this._resolvePossessed();
        if (!pawn || this.controlSource !== 'ai') return;

        // Every other pawn in the scene. A player and every NPC is a Character, so this is both the
        // set an agent cares about and a bounded one — as opposed to "every node", which is neither.
        this._candidates.length = 0;
        this._candidateIds.clear();
        const characters = this._scene?.characters;
        if (characters) {
            for (const character of characters) {
                if (character === pawn) continue;
                this._candidates.push({ id: character.id, position: character.worldPosition });
                this._candidateIds.add(character.id);
            }
        }

        // Eyes at the pawn's origin would look out of its feet, and a floor counts as an obstacle.
        const eye = pawn.worldPosition;
        vec3.set(this._eye, eye[0], eye[1] + this.eyeHeight, eye[2]);

        // The pawn's FACING, from worldForward. Not `planarAngle`, which is the direction of TRAVEL
        // relative to the body and reads 0 while standing still -- a guard's cone would then be pinned
        // to world +Z no matter which way it was turned.
        const forward = pawn.worldForward;
        this._perception.step(
            this._eye, yawFromDirection(forward[0], forward[2]),
            this._candidates, this.perception, delta,
            this._scene?.physics ? this._lineOfSight : null);

        if (this.autoAcquire) this._acquire(pawn);
    }

    /**
     * Adopt the nearest NOTICED character as this controller's target.
     *
     * Nearest rather than first, because "first" is traversal order and would make a guard prefer
     * whichever enemy happens to sit earlier in the tree. Clears the blackboard entry when nothing is
     * in sight AND nothing is still remembered, so a lost target survives long enough to be chased —
     * that is what memory span is for.
     */
    private _acquire(pawn: CharacterNode): void {
        let bestId: string | null = null;
        let bestDistance = Infinity;
        for (const sighting of this._perception.sightings) {
            if (!sighting.noticed) continue;
            const target = this._scene?.getNodeById(sighting.id);
            if (!target) continue;
            const distance = vec3.distance(this._eye, target.worldPosition as vec3);
            if (distance < bestDistance) { bestDistance = distance; bestId = sighting.id; }
        }

        if (bestId) { this.setBlackboard(this.targetKey, bestId); return; }

        const current = this._blackboard.get(this.targetKey);
        if (typeof current === 'string' && current && !this._perception.remembers(current, this.perception)) {
            this.setBlackboard(this.targetKey, undefined);
        }
    }

    /**
     * The line-of-sight query, backed by the physics world.
     *
     * Yuka would otherwise brute-force triangles through `MeshGeometry`; cannon already has a
     * broadphase and already knows which bodies are solid. The pawn's own body is ignored, or an agent
     * finds itself blocking its own view.
     */
    private _testLineOfSight(from: vec3, to: vec3, hit: vec3): boolean {
        const physics = this._scene?.physics;
        if (!physics) return false;
        const pawn = this._possessed;
        try {
            const result = physics.raycast(from, to, { ignore: pawn?.body ? [pawn.body] : undefined });
            if (!result) return false;
            // A hit ON the target is not an obstruction. Characters carry bodies, so without this an
            // agent can never see another agent.
            if (result.node && this._candidateIds.has(result.node.id)) return false;
            vec3.set(hit, result.point[0], result.point[1], result.point[2]);
            return true;
        } catch {
            return false;
        }
    }

    /** What this controller can see right now, for `onThink` and the editor readout. */
    public get sightings() { return this._perception.sightings; }

    /** Where the current target was last seen, or null. Backs the `investigate` goal. */
    public get lastKnownPosition(): vec3 | null {
        const id = this._blackboard.get(this.targetKey);
        if (typeof id !== 'string' || !id) return null;
        const sighting = this._perception.sightingOf(id);
        return sighting && Number.isFinite(sighting.timeSinceSeen) ? sighting.lastKnownPosition : null;
    }

    // ----- the AI source ----------------------------------------------------------------------------

    /** A blackboard entry, or undefined. Public, so `onThink` and any other script can read one. */
    public getBlackboard(key: string): BlackboardValue | undefined {
        return this._blackboard.get(key);
    }

    /**
     * Write a blackboard entry. This is how a brain says WHAT to act on — `setBlackboard('target', id)`
     * — without the controller needing a node-reference field per goal.
     */
    public setBlackboard(key: string, value: BlackboardValue | undefined): void {
        if (value === undefined) this._blackboard.delete(key);
        else this._blackboard.set(key, value);
    }

    public clearBlackboard(): void { this._blackboard.clear(); }

    /** Every key currently set. For the editor's readout. */
    public get blackboardKeys(): string[] { return [...this._blackboard.keys()]; }

    /** The node the current goal is aimed at, resolved through the blackboard, or null. */
    public get goalTarget(): Node | null { return this._resolveTarget(this.targetKey); }

    /** Which behaviour state the machine is holding, or ''. For the editor's readout and for onThink. */
    public get behaviorState(): string { return this._behaviorRuntime.current; }

    /**
     * Turn the goal into an intent.
     *
     * Every branch produces a world-space DESIRED VELOCITY, which `intentFromDesired` converts into
     * exactly the record a player's actions produce — so the character cannot tell the two apart, and an
     * NPC inherits the locomotion, slope handling and animation the player character already has.
     */
    private _steer(pawn: CharacterNode, delta: number): void {
        clearIntent(this._intent);

        // Before the machine, which may read a fuzzy output as one of its parameters -- and before
        // `onThink`, which can read one through `fuzzyValue`. Not inside the machine's parameter
        // refresh: a model with no machine is a legitimate setup, and it would never run.
        this._refreshFuzzy(pawn);

        // Whichever brain is selected decides the goal; otherwise the node's own fields do. A machine
        // with one state naming one goal is exactly equivalent to setting that goal by hand, so
        // adding either brain is never a behaviour change on its own.
        let goal: AiGoal = this.goal;
        let targetKey = this.targetKey;
        let stateScale = 1;

        if (this.brain === 'goal') {
            const drive = this._stepGoals(pawn, delta);
            if (drive) {
                goal = drive.goal;
                targetKey = drive.targetKey || this.targetKey;
                stateScale = drive.speedScale;
            }
        } else if (this.brain === 'machine') {
            const state = this._stepBehavior(pawn, delta);
            if (state) {
                goal = state.goal;
                targetKey = state.targetKey || this.targetKey;
                stateScale = state.speedScale ?? 1;
            }
        }

        if (goal === 'script') {
            // The escape hatch: write nothing and leave the frame to onThink, which still gets possession,
            // the aim basis and everything else this node resolved.
            return;
        }

        const up = this._resolveUp();
        const self = pawn.worldPosition;
        vec3.set(this._selfPos, self[0], self[1], self[2]);
        const tuning = this.steering;

        const target = this._resolveTarget(targetKey);
        if (target) {
            const p = target.worldPosition;
            vec3.set(this._targetPos, p[0], p[1], p[2]);
            const v = (target as CharacterNode).velocity;
            vec3.set(this._targetVel, v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0);
        } else {
            vec3.set(this._targetPos, this.goalPoint[0], this.goalPoint[1], this.goalPoint[2]);
            vec3.set(this._targetVel, 0, 0, 0);
        }

        // A goal that names a thing and has none holds still rather than walking to the world origin,
        // which is what falling back to an unset `goalPoint` would otherwise do.
        const needsTarget = goal === 'seek' || goal === 'flee' || goal === 'follow' || goal === 'path';
        if (needsTarget && !target && targetKey !== 'point') {
            vec3.set(this._desired, 0, 0, 0);
        } else {
            switch (goal) {
                case 'seek': seek(this._desired, this._selfPos, this._targetPos, tuning.maxSpeed, up); break;
                case 'path': this._steerPath(pawn, tuning, up, delta); break;
                case 'investigate': this._steerInvestigate(pawn, tuning, up, delta); break;
                case 'flock': this._steerFlock(pawn, tuning, up); break;
                case 'patrol': this._steerPatrol(pawn, tuning, up); break;
                case 'flee': flee(this._desired, this._selfPos, this._targetPos, tuning.maxSpeed, up); break;
                case 'arrive': arrive(this._desired, this._selfPos, this._targetPos, tuning, up); break;
                case 'follow':
                    followTarget(this._desired, this._selfPos, this._targetPos, this._targetVel, tuning, up);
                    break;
                case 'wander': {
                    const forward = pawn.worldForward;
                    wander(this._desired, vec3.set(this._targetVel, forward[0], forward[1], forward[2]),
                        this._steeringState, tuning, delta, up);
                    break;
                }
                default: vec3.set(this._desired, 0, 0, 0); break;
            }
        }

        // Deflect around whatever is ahead. Gated on `avoidDistance > 0`, so the rays are not fired at all
        // unless avoidance was asked for — see `_probeObstacles`.
        if (tuning.avoidDistance > 0 && vec3.length(this._desired) > 1e-6) {
            this._probeObstacles(pawn);
            avoidObstacles(this._desired, this._desired, this._probes, tuning, up);
        }

        intentFromDesired(this._intent, this._desired, tuning.maxSpeed, up);
        // The state's own throttle multiplies whatever the steer asked for — a patrol at 0.4 and a chase
        // at 1 with nothing else different between them.
        this._intent.speedScale *= stateScale;
    }

    /**
     * Walk a route to the current destination, recomputing it only when the policy says to.
     *
     * Falls back to a straight-line `seek` whenever navigation cannot answer — no navmesh in the
     * scene, nothing baked, or a destination that is simply not reachable. That fallback is what makes
     * switching a goal from `seek` to `path` safe on a scene nobody has baked yet: it behaves exactly
     * as it did before, rather than standing still for a reason nothing explains.
     */
    private _steerPath(pawn: CharacterNode, tuning: SteeringTuning, up: vec3, delta: number): void {
        const source = this._resolveNavMesh();
        if (!source?.mesh) {
            clearNavPath(this._path);
            seek(this._desired, this._selfPos, this._targetPos, tuning.maxSpeed, up);
            return;
        }

        if (shouldRepath(this._repathState, delta, this._targetPos, this.repath)) {
            const found = this._scene?.ai?.findPath(source, this._selfPos, this._targetPos, this._pathScratch)
                ?? source.mesh.findPath(this._selfPos, this._targetPos, this._pathScratch);
            // Marked BEFORE the emptiness check, so an unreachable destination is retried on the
            // policy's schedule rather than re-queried every single frame.
            markRepathed(this._repathState, this._targetPos);
            if (found.length > 0) {
                setNavPath(this._path, found);
                // Agent clearance. The funnel runs exactly through the corner vertex, so an agent
                // following it raw scrapes the wall -- see navPath.insetCorners.
                insetCorners(this._path, source.agentRadius, up);
            } else {
                clearNavPath(this._path);
            }
        }

        if (!hasPath(this._path)) {
            // Unreachable by the mesh. A straight line at least walks toward it, and the whiskers keep
            // the agent off the wall.
            seek(this._desired, this._selfPos, this._targetPos, tuning.maxSpeed, up);
            return;
        }

        aiStats.navAgents++;
        advancePath(this._path, this._selfPos, this.waypointRadius, up);
        followPath(this._desired, this._selfPos, this._path, tuning, up);
    }

    /**
     * Move with the group: separation, alignment and cohesion over the agents nearby.
     *
     * ## No spatial index, deliberately
     *
     * The obvious build is a uniform grid or Yuka's `CellSpacePartitioning`. Neither earns its place:
     * it would be a THIRD spatial structure after cannon's broadphase and every Geometry's BVH, its
     * only consumer would be this, and AI agents number in the tens rather than the thousands — a
     * linear scan over them is cheaper than maintaining an index of them.
     *
     * Yuka's own partitioning also has a trap that argues against reaching for it later: its `query`
     * returns everything in the overlapping CELLS rather than within the radius. Measured, that was 95
     * entities returned for a true 16 — fine for `separate`, which re-tests distance anyway, and badly
     * wrong for a `neighborCount` sense reading the raw result.
     *
     * ## Why three passes rather than one
     *
     * Each urge filters by radius itself, so this walks the neighbour list three times. Over tens of
     * agents that is noise, and the alternative — one fused loop — makes three simple pure functions
     * into one that cannot be tested apart.
     */
    private _steerFlock(pawn: CharacterNode, tuning: SteeringTuning, up: vec3): void {
        this._gatherNeighbours(pawn);
        if (this._neighbourCount === 0) {
            // Alone. Holding still is the honest answer: a flock of one has no group to move with, and
            // wandering instead would make "flock" quietly mean two different things.
            vec3.set(this._desired, 0, 0, 0);
            return;
        }

        const radius = Math.max(0, this.flockRadius);
        separate(this._separation, this._selfPos, this._neighbourPositions, radius, tuning.maxSpeed, up);
        align(this._alignment, this._selfPos, this._neighbours, radius, tuning.maxSpeed, up);
        cohere(this._cohesion, this._selfPos, this._neighbours, radius, tuning.maxSpeed, up);

        blendSteering(this._desired, [
            { force: this._separation, weight: this.separationWeight },
            { force: this._alignment, weight: this.alignmentWeight },
            { force: this._cohesion, weight: this.cohesionWeight },
        ], tuning.maxSpeed);
    }

    /**
     * Collect the other pawns within the flock radius.
     *
     * Velocity is the MEASURED one, not the commanded one: an agent jammed against a wall is being
     * told to run and is not moving, and letting that vote would turn the whole flock into the wall.
     */
    private _gatherNeighbours(pawn: CharacterNode): void {
        this._neighbourCount = 0;
        const radius = Math.max(0, this.flockRadius);
        const characters = this._scene?.characters;
        if (radius <= 0 || !characters) return;

        const here = pawn.worldPosition;
        for (const other of characters) {
            if (other === pawn) continue;
            const there = other.worldPosition;
            // Cheap reject before the planar projection: a full 3D distance is never smaller than the
            // planar one, so anything failing this cannot pass.
            if (vec3.squaredDistance(here as vec3, there as vec3) > radius * radius) continue;

            const index = this._neighbourCount++;
            let entry = this._neighbours[index];
            if (!entry) {
                // Grown once and reused: the arrays are per-controller and per-frame otherwise.
                entry = { position: vec3.create(), velocity: vec3.create() };
                this._neighbours[index] = entry;
                this._neighbourPositions[index] = entry.position;
            }
            vec3.set(entry.position, there[0], there[1], there[2]);
            const velocity = other.currentVelocity;
            vec3.set(entry.velocity, velocity[0], velocity[1], velocity[2]);
        }
        // The reused arrays are longer than the count; trim the VIEWS the steers read.
        this._neighbours.length = this._neighbourCount;
        this._neighbourPositions.length = this._neighbourCount;
    }

    /**
     * How many agents are inside the flock radius. Backs the `neighborCount` sense.
     *
     * Gathers on read, like {@link pathRemaining}: a script asking "am I alone" while the controller
     * is doing something else entirely would otherwise get whatever the last flock steer left behind,
     * which for a controller that has never flocked is 0 forever.
     */
    public get neighborCount(): number {
        const pawn = this._resolvePossessed();
        if (pawn) this._gatherNeighbours(pawn);
        return this._neighbourCount;
    }

    /**
     * Walk to where the target was last seen.
     *
     * The behaviour the whole memory system exists for: an agent that loses sight of you goes to the
     * last place it saw you instead of forgetting you on the frame you break the line. Routed through
     * the navmesh exactly as `path` is, so it goes around the corner you went around.
     *
     * With nothing remembered it holds still rather than walking to the world origin -- the same rule
     * every other goal that names a thing follows.
     */
    private _steerInvestigate(pawn: CharacterNode, tuning: SteeringTuning, up: vec3, delta: number): void {
        const remembered = this.lastKnownPosition;
        if (!remembered) { vec3.set(this._desired, 0, 0, 0); return; }
        vec3.copy(this._targetPos, remembered);
        vec3.set(this._targetVel, 0, 0, 0);
        this._steerPath(pawn, tuning, up, delta);
    }

    /**
     * Walk an authored route on the navmesh, looping.
     *
     * The route's own points ARE the path: they were placed on walkable ground by hand, so routing
     * between them would be asking the navmesh to improve on an author's decision. Reaching the last
     * one wraps to the first, which is what makes a patrol a patrol.
     */
    private _steerPatrol(pawn: CharacterNode, tuning: SteeringTuning, up: vec3): void {
        const source = this._resolveNavMesh();
        const points = this.routeName && source ? source.routePoints(this.routeName) : [];
        if (points.length === 0) {
            // A patrol with no route holds still rather than walking to the world origin.
            vec3.set(this._desired, 0, 0, 0);
            return;
        }

        // Re-seed when the route changed under us, or when the last lap finished.
        if (!hasPath(this._path) || this._path.points.length !== points.length) {
            setNavPath(this._path, points);
            this._path.index = this._routeIndex % points.length;
        }

        aiStats.navAgents++;
        advancePath(this._path, this._selfPos, this.waypointRadius, up);

        // The final waypoint is never consumed by proximity (`arrive` eases into it), so the wrap is
        // ours to make: inside the arrive radius of the last point, start the lap again.
        if (this._path.index >= points.length - 1
            && vec3.distance(this._selfPos, this._path.points[this._path.index]) <= tuning.arriveRadius) {
            this._path.index = 0;
        }
        this._routeIndex = this._path.index;
        followPath(this._desired, this._selfPos, this._path, tuning, up);
    }

    /** The navmesh this controller paths on, warning once if its id names nothing. */
    private _resolveNavMesh() {
        const ai = this._scene?.ai;
        if (!ai) return null;
        const source = ai.navMeshFor(this._navMeshId);
        if (this._navMeshId && source?.id !== this._navMeshId && !this._warnedDanglingNavMesh) {
            this._warnedDanglingNavMesh = true;
            Logger.warn(
                `Controller '${this._name}' names navmesh '${this._navMeshId}', which is not in this ` +
                `scene. It will path on the first baked navmesh instead.`, 'Scene');
        }
        return source;
    }

    /**
     * Advance the goal brain and return what it asked for this frame, or null.
     *
     * The context is built once and reused: it closes over the pawn, and a fresh object per frame per
     * agent is the kind of garbage that shows up in a frame-time HUD rather than in a profile.
     */
    private _stepGoals(pawn: CharacterNode, delta: number): {
        goal: AiGoal; targetKey?: string; speedScale: number;
    } | null {
        if (this.goals !== this._goalSource) {
            this._goalSource = this.goals;
            this._goalBrain = isDefaultGoalGraph(this.goals) ? null : GoalBrain.from(this.goals);
        }
        const brain = this._goalBrain;
        if (!brain) return null;

        if (!this._goalContext) {
            this._goalContext = {
                read: (source) => this._readSource(source, this._possessed ?? pawn),
                met: (condition) => !!condition
                    && conditionNodeMet(this._behaviorRuntime.ctx, condition),
                drive: (goal, targetKey, speedScale) => {
                    this._goalDrive = { goal, targetKey, speedScale };
                },
            };
        }

        // A goal's `until`/`failWhen` read the SAME parameter table the machine uses, so the values
        // have to be current before the brain steps -- otherwise a condition tests last frame's world.
        this._refreshBehaviorParams(pawn);
        this._goalDrive = null;
        brain.step(this._goalContext, delta);
        return this._goalDrive;
    }

    /** The name of the goal currently being pursued, or ''. For the editor readout and `onThink`. */
    public get goalState(): string { return this._goalBrain?.current ?? ''; }

    /** The active plan, outermost first. */
    public get goalPlan(): string[] { return this._goalBrain?.plan ?? []; }

    /**
     * Advance the behaviour machine, if there is one, and return the state now held.
     *
     * Parameters are refreshed first, modelled on `Animator._refreshVariableParams`: a machine reading a
     * stale value would transition on last frame's world.
     */
    private _stepBehavior(pawn: CharacterNode, delta: number): BehaviorState | null {
        if (this.behavior.states.length === 0) return null;
        this._refreshBehaviorParams(pawn);
        const stepped = stepBehavior(this.behavior, this._behaviorRuntime, delta);
        this._behaviorRuntime = stepped.next;
        return stepped.state;
    }

    /**
     * Evaluate the fuzzy model for this frame, if there is one.
     *
     * Once per frame, before any parameter reads it: `defuzzify` re-runs every rule, so a machine with
     * four fuzzy parameters would otherwise pay for the whole rule set four times.
     *
     * Inputs are resolved BY NAME against the same vocabulary everything else uses -- a sense first,
     * then a motion builtin on the pawn, then a numeric blackboard entry. A variable named after
     * nothing is simply never fed, and its rules see the bottom of its range.
     */
    private _refreshFuzzy(pawn: CharacterNode): void {
        if (this.fuzzy !== this._fuzzySource) {
            this._fuzzySource = this.fuzzy;
            this._fuzzyBrain = isDefaultFuzzyModel(this.fuzzy) ? null : FuzzyBrain.from(this.fuzzy);
            this._fuzzyOutputs = {};
        }
        const brain = this._fuzzyBrain;
        if (!brain) return;

        for (const name of brain.inputs) {
            let value: number | undefined;
            if ((BEHAVIOR_SENSES as readonly string[]).includes(name)) {
                const sensed = this._sense(name, pawn);
                value = typeof sensed === 'number' ? sensed : (sensed ? 1 : 0);
            } else {
                const read = (pawn as unknown as Record<string, unknown>)[name];
                if (typeof read === 'number') value = read;
                else if (typeof read === 'boolean') value = read ? 1 : 0;
                else {
                    const entry = this._blackboard.get(name);
                    if (typeof entry === 'number') value = entry;
                    else if (typeof entry === 'boolean') value = entry ? 1 : 0;
                }
            }
            if (value !== undefined) this._fuzzyInputs[name] = value;
        }
        this._fuzzyOutputs = brain.evaluate(this._fuzzyInputs);
    }

    /** A defuzzified output, or 0 when there is no model or no such output. */
    public fuzzyValue(name: string): number {
        const value = this._fuzzyOutputs[name];
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }

    /**
     * Read one parameter source.
     *
     * ONE reader for both brains. The behaviour machine's parameters and a goal evaluator's
     * desirability draw on the same vocabulary, and two copies of this switch would be two places for
     * `blackboard` or `sense` to mean subtly different things.
     *
     * Returns `undefined` when the source has nothing to say, so a caller can keep its own default
     * rather than being handed a 0 it cannot distinguish from a real one.
     */
    private _readSourceOrUndefined(
        source: BehaviorParameterSource, pawn: CharacterNode,
    ): number | boolean | undefined {
        switch (source.kind) {
            case 'const':
                return source.value;
            case 'builtin': {
                // The pawn's MEASURED motion — planarSpeed, isGrounded, slopeAngle and the rest —
                // read straight off the node rather than through a second surface of our own.
                const read = (pawn as unknown as Record<string, unknown>)[source.name];
                return typeof read === 'number' || typeof read === 'boolean' ? read : undefined;
            }
            case 'variable': {
                const read = pawn.getVariable(source.varName);
                return typeof read === 'number' || typeof read === 'boolean' ? read : undefined;
            }
            case 'blackboard': {
                const read = this._blackboard.get(source.key);
                if (typeof read === 'number' || typeof read === 'boolean') return read;
                // A string entry (a node id) reads as "is it set", which is what a hasTarget-style
                // condition on a blackboard key actually wants to ask.
                if (typeof read === 'string') return read.length > 0;
                return undefined;
            }
            case 'sense':
                return this._sense(source.name, pawn);
            case 'fuzzy':
                return this.fuzzyValue(source.name);
            default:
                return undefined;
        }
    }

    /** The same read, with 0 for "nothing to say" — what a desirability curve wants. */
    private _readSource(source: BehaviorParameterSource, pawn: CharacterNode): number | boolean {
        return this._readSourceOrUndefined(source, pawn) ?? 0;
    }

    /** Fill the machine's parameter table for this frame. */
    private _refreshBehaviorParams(pawn: CharacterNode): void {
        const values = this._behaviorRuntime.ctx.values;
        for (const p of this.behavior.parameters) {
            const read = this._readSourceOrUndefined(p.source, pawn);
            const value: number | boolean = read ?? p.default;
            const source = p.source;
            // A trigger a script raised this frame stays raised until a transition consumes it; anything
            // else is overwritten from its source.
            if (p.type === 'trigger' && values.get(p.name) === true && source.kind !== 'blackboard') continue;
            values.set(p.name, p.type === 'number' ? Number(value) : Boolean(value));
        }
    }

    /** The handful of things only the controller knows, because they are about the GOAL not the pawn. */
    private _sense(name: string, pawn: CharacterNode): number | boolean {
        if (name === 'stateTime') return this._behaviorRuntime.stateTime;
        if (name === 'hasPath') return hasPath(this._path);
        if (name === 'pathRemaining') return this.pathRemaining;
        // The getter gathers on read, so a machine can ask without a flock goal ever running.
        if (name === 'neighborCount') return this.neighborCount;

        // Perception senses read the CURRENT target, so they answer about whoever the blackboard
        // names rather than about whatever happens to be visible.
        const seenId = this._blackboard.get(this.targetKey);
        const sighting = typeof seenId === 'string' && seenId
            ? this._perception.sightingOf(seenId) : null;
        if (name === 'targetInSight') return sighting?.noticed === true;
        if (name === 'timeSinceSeen') return sighting ? sighting.timeSinceSeen : Infinity;
        if (name === 'lastKnownDistance') {
            if (!sighting || !Number.isFinite(sighting.timeSinceSeen)) return 0;
            const here = pawn.worldPosition;
            return vec3.distance(
                vec3.set(this._selfPos, here[0], here[1], here[2]), sighting.lastKnownPosition);
        }

        const target = this._resolveTarget(this.targetKey);
        if (name === 'hasTarget') return target !== null;
        if (!target) return name === 'targetVisible' ? false : 0;

        const from = pawn.worldPosition;
        const to = target.worldPosition;
        if (name === 'distanceToTarget') return Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
        if (name === 'angleToTarget') {
            const forward = pawn.worldForward;
            const heading = Math.atan2(to[0] - from[0], to[2] - from[2]);
            const facing = Math.atan2(forward[0], forward[2]);
            let diff = (heading - facing) * 180 / Math.PI;
            diff = ((diff % 360) + 540) % 360 - 180;
            return diff;
        }
        if (name === 'targetVisible') {
            const physics = this._scene?.physics;
            if (!physics) return true;
            try {
                // A clear line means nothing solid between the two. The pawn's own body is ignored, or
                // every agent would find itself blocking its own view.
                const hit = physics.raycast(
                    [from[0], from[1], from[2]], [to[0], to[1], to[2]],
                    { ignore: pawn.body ? [pawn.body] : undefined });
                return !hit || hit.node === target;
            } catch { return true; }
        }
        return 0;
    }

    /** The node a blackboard key names, or null. */
    private _resolveTarget(key: string): Node | null {
        const value = this._blackboard.get(key);
        if (typeof value !== 'string' || !value) return null;
        return this._scene?.getNodeById(value) ?? null;
    }

    private _resolveUp(): vec3 {
        const up = this._scene?.physics?.up;
        return up ? vec3.set(this._steerUp, up[0], up[1], up[2]) : vec3.set(this._steerUp, 0, 1, 0);
    }

    /**
     * Fan rays ahead of the pawn and record what they hit.
     *
     * cannon has no sphere cast, so a fan of rays is the approximation available — the same thing
     * `CameraRigNode._probe` does for the camera boom. The cost is `whiskerCount` raycasts per AI
     * controller per frame, which `physicsStats.rayCount` already surfaces in the performance HUD.
     */
    private _probeObstacles(pawn: CharacterNode): void {
        this._probes.length = 0;
        const physics = this._scene?.physics;
        if (!physics) return;

        const count = Math.max(1, Math.min(9, Math.round(this.whiskerCount)));
        const spread = this.whiskerSpread;
        const from = pawn.worldPosition;
        const heading = Math.atan2(this._desired[0], this._desired[2]);
        const body = pawn.body;

        for (let i = 0; i < count; i++) {
            // Centred fan: one ray dead ahead when count is odd, symmetric either side.
            const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
            const angle = heading + (t * spread * 0.5) * Math.PI / 180;
            const dx = Math.sin(angle);
            const dz = Math.cos(angle);
            const to: [number, number, number] = [
                from[0] + dx * this.steering.avoidDistance,
                from[1],
                from[2] + dz * this.steering.avoidDistance,
            ];
            let hit = null;
            try {
                hit = physics.raycast([from[0], from[1], from[2]], to, { ignore: body ? [body] : undefined });
            } catch { hit = null; }
            if (!hit) continue;
            this._probes.push({
                direction: [dx, 0, dz],
                distance: hit.distance,
                normal: [hit.normal[0], hit.normal[1], hit.normal[2]],
            });
        }
    }

    private _driveAim(): void {
        const rig = this.aimRig;
        if (!rig) return;
        const [x, y] = this._intent.look;
        if (x === 0 && y === 0) return;
        // RAW per-frame deltas, not scaled by delta: addYaw/addPitch apply the rig's own sensitivity,
        // inversion and clamping, and a mouse delta is already a per-frame quantity.
        rig.addYaw(-x);
        rig.addPitch(y);
    }

    /**
     * Copy this frame's intent into the pawn, marking it fresh.
     *
     * A copy rather than handing over the record: two controllers briefly naming one pawn would otherwise
     * alias the same object, and the pawn's jump consumption would reach back into a controller's state.
     */
    private _publish(pawn: CharacterNode): void {
        const target = pawn.drive();
        target.move[0] = this._intent.move[0];
        target.move[1] = this._intent.move[1];
        target.look[0] = this._intent.look[0];
        target.look[1] = this._intent.look[1];
        target.basisYaw = this._intent.basisYaw;
        target.aimYaw = this._intent.aimYaw;
        target.aimPitch = this._intent.aimPitch;
        target.sprint = this._intent.sprint;
        target.crouch = this._intent.crouch;
        target.speedScale = this._intent.speedScale;
        // Requests are RAISED into the pawn, never copied wholesale: the pawn owns the countdown, and
        // overwriting it with the controller's zero would cancel a buffered jump every frame.
        for (const kind of Object.keys(this._intent.requests) as (keyof typeof this._intent.requests)[]) {
            const pending = this._intent.requests[kind];
            if (pending > 0) {
                target.requests[kind] = pending;
                this._intent.requests[kind] = 0;
            }
        }
    }

    // ----- lifecycle -------------------------------------------------------------------------------

    public onDespawn(): void {
        // Without this the pawn keeps a back-pointer to a controller that no longer runs, and its
        // `driveWhenUnpossessed` gate never re-opens — the character freezes with nothing to explain it.
        this._detach();
        // A respawned brain starts from its entry state rather than resuming mid-chase -- and must not
        // remember where it last saw you either.
        this._behaviorRuntime = createBehaviorRuntime();
        this._perception.clear();
        this._goalBrain?.clear();
        clearNavPath(this._path);
    }

    // ----- serialization ---------------------------------------------------------------------------

    protected _serializePayload(): any {
        return {
            // Both are node ids and BOTH are in NODE_REF_KEYS. Without that, duplicating a
            // controller+character pair leaves the copy driving the ORIGINAL character — which looks
            // right until a second one is spawned and every NPC moves as one.
            possessedId: this._possessedId,
            aimSourceId: this._aimSourceId,
            // Also a node id, and also in NODE_REF_KEYS: a duplicated navmesh + controller pair must
            // path on its own copy, not on the original's.
            navMeshId: this._navMeshId,

            controlSource: this.controlSource,
            moveAction: this.moveAction,
            lookAction: this.lookAction,
            jumpAction: this.jumpAction,
            sprintAction: this.sprintAction,
            crouchAction: this.crouchAction,

            aimSource: this.aimSource,
            driveAimTarget: this.driveAimTarget,

            goal: this.goal,
            targetKey: this.targetKey,
            goalPoint: [...this.goalPoint],
            steering: { ...this.steering },
            routeName: this.routeName,
            flockRadius: this.flockRadius,
            separationWeight: this.separationWeight,
            alignmentWeight: this.alignmentWeight,
            cohesionWeight: this.cohesionWeight,
            perception: { ...this.perception },
            eyeHeight: this.eyeHeight,
            autoAcquire: this.autoAcquire,
            repath: { ...this.repath },
            waypointRadius: this.waypointRadius,
            whiskerCount: this.whiskerCount,
            whiskerSpread: this.whiskerSpread,
            // Written only when authored, so a controller that never opened the Behaviour section adds
            // nothing to the scene file.
            ...(isDefaultBehaviorMachine(this.behavior) ? {} : { behavior: this.behavior }),
            // Same rule: a controller that never opened the Fuzzy section adds nothing to the scene.
            ...(isDefaultFuzzyModel(this.fuzzy) ? {} : { fuzzy: this.fuzzy }),
            brain: this.brain,
            ...(isDefaultGoalGraph(this.goals) ? {} : { goals: this.goals }),
            // The blackboard is RUNTIME state — a brain writes into it every frame — so only the entries
            // an author typed are carried, and those live in the node's own `variables` instead.
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new ControllerNode(json.name, json.id);

        const str = (value: any, fallback: string) => typeof value === 'string' ? value : fallback;
        const id = (value: any) => typeof value === 'string' && value ? value : null;

        // Stored raw and resolved lazily: parse is depth-first, so the pawn usually does not exist yet.
        node._possessedId = id(json.possessedId);
        node._aimSourceId = id(json.aimSourceId);
        node._navMeshId = id(json.navMeshId);

        if ((CONTROL_SOURCES as readonly string[]).includes(json.controlSource))
            node.controlSource = json.controlSource;
        node.moveAction = str(json.moveAction, node.moveAction);
        node.lookAction = str(json.lookAction, node.lookAction);
        node.jumpAction = str(json.jumpAction, node.jumpAction);
        node.sprintAction = str(json.sprintAction, node.sprintAction);
        node.crouchAction = str(json.crouchAction, node.crouchAction);

        if ((AIM_SOURCES as readonly string[]).includes(json.aimSource)) node.aimSource = json.aimSource;
        node.driveAimTarget = typeof json.driveAimTarget === 'boolean'
            ? json.driveAimTarget : node.driveAimTarget;

        if ((AI_GOALS as readonly string[]).includes(json.goal)) node.goal = json.goal;
        node.targetKey = str(json.targetKey, node.targetKey);
        if (Array.isArray(json.goalPoint) && json.goalPoint.length >= 3)
            node.goalPoint = [+json.goalPoint[0] || 0, +json.goalPoint[1] || 0, +json.goalPoint[2] || 0];
        // The tolerant reader defaults and clamps every field, so a partial or stale block passes.
        node.steering = steeringTuning(json.steering);
        node.routeName = str(json.routeName, node.routeName);
        const weight = (value: any, fallback: number) =>
            typeof value === 'number' && isFinite(value) ? Math.max(0, value) : fallback;
        node.flockRadius = weight(json.flockRadius, node.flockRadius);
        node.separationWeight = weight(json.separationWeight, node.separationWeight);
        node.alignmentWeight = weight(json.alignmentWeight, node.alignmentWeight);
        node.cohesionWeight = weight(json.cohesionWeight, node.cohesionWeight);
        node.perception = perceptionTuning(json.perception);
        node.eyeHeight = typeof json.eyeHeight === 'number' && isFinite(json.eyeHeight)
            ? Math.max(0, json.eyeHeight) : node.eyeHeight;
        // Absent means true, so a controller written before perception existed still acquires.
        node.autoAcquire = json.autoAcquire !== false;
        // Tolerant readers throughout, so a controller saved before navigation existed reads as one
        // with the defaults rather than failing the whole scene.
        node.repath = repathPolicy(json.repath);
        node.waypointRadius = typeof json.waypointRadius === 'number' && isFinite(json.waypointRadius)
            ? Math.max(0, json.waypointRadius) : node.waypointRadius;
        node.whiskerCount = Math.max(1, Math.min(9, Math.round(
            typeof json.whiskerCount === 'number' && isFinite(json.whiskerCount)
                ? json.whiskerCount : node.whiskerCount)));
        node.whiskerSpread = typeof json.whiskerSpread === 'number' && isFinite(json.whiskerSpread)
            ? Math.max(0, Math.min(360, json.whiskerSpread)) : node.whiskerSpread;
        node.behavior = parseBehaviorMachine(json.behavior);
        node.fuzzy = parseFuzzyModel(json.fuzzy);
        // Absent means `machine`, so every controller written before goal brains existed keeps its
        // state machine rather than silently switching to a graph it does not have.
        if ((BRAIN_KINDS as readonly string[]).includes(json.brain)) node.brain = json.brain;
        node.goals = parseGoalGraph(json.goals);

        // _commonParse adds the node to its parent — do not addChild again.
        Node.finishParse(node, parent, json);
    }
}
