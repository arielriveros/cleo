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
    arrive, avoidObstacles, createSteeringState, flee, followTarget, intentFromDesired, seek,
    steeringTuning, wander,
} from "../../control/steering";
import type { ProbeHit, SteeringState, SteeringTuning } from "../../control/steering";
import {
    AI_GOALS, createBehaviorRuntime, isDefaultBehaviorMachine, parseBehaviorMachine, stepBehavior,
} from "../../control/behavior";
import type { AiGoal, BehaviorMachine, BehaviorRuntime, BehaviorState } from "../../control/behavior";
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

        // A machine, when there is one, decides the goal; otherwise the node's own fields do. One state
        // with one goal is exactly equivalent to setting that goal by hand, so adding a machine is never
        // a behaviour change on its own.
        const state = this._stepBehavior(pawn, delta);
        const goal: AiGoal = state ? state.goal : this.goal;
        const targetKey = state?.targetKey || this.targetKey;
        const stateScale = state?.speedScale ?? 1;

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
        const needsTarget = goal === 'seek' || goal === 'flee' || goal === 'follow';
        if (needsTarget && !target && targetKey !== 'point') {
            vec3.set(this._desired, 0, 0, 0);
        } else {
            switch (goal) {
                case 'seek': seek(this._desired, this._selfPos, this._targetPos, tuning.maxSpeed, up); break;
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

    /** Fill the machine's parameter table for this frame. */
    private _refreshBehaviorParams(pawn: CharacterNode): void {
        const values = this._behaviorRuntime.ctx.values;
        for (const p of this.behavior.parameters) {
            let value: number | boolean = p.default;
            const source = p.source;
            switch (source.kind) {
                case 'const':
                    value = source.value;
                    break;
                case 'builtin': {
                    // The pawn's MEASURED motion — planarSpeed, isGrounded, slopeAngle and the rest —
                    // read straight off the node rather than through a second surface of our own.
                    const read = (pawn as unknown as Record<string, unknown>)[source.name];
                    if (typeof read === 'number' || typeof read === 'boolean') value = read;
                    break;
                }
                case 'variable': {
                    const read = pawn.getVariable(source.varName);
                    if (typeof read === 'number' || typeof read === 'boolean') value = read;
                    break;
                }
                case 'blackboard': {
                    const read = this._blackboard.get(source.key);
                    if (typeof read === 'number' || typeof read === 'boolean') value = read;
                    // A string entry (a node id) reads as "is it set", which is what a hasTarget-style
                    // condition on a blackboard key actually wants to ask.
                    else if (typeof read === 'string') value = read.length > 0;
                    break;
                }
                case 'sense':
                    value = this._sense(source.name, pawn);
                    break;
            }
            // A trigger a script raised this frame stays raised until a transition consumes it; anything
            // else is overwritten from its source.
            if (p.type === 'trigger' && values.get(p.name) === true && source.kind !== 'blackboard') continue;
            values.set(p.name, p.type === 'number' ? Number(value) : Boolean(value));
        }
    }

    /** The handful of things only the controller knows, because they are about the GOAL not the pawn. */
    private _sense(name: string, pawn: CharacterNode): number | boolean {
        if (name === 'stateTime') return this._behaviorRuntime.stateTime;

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
        // A respawned brain starts from its entry state rather than resuming mid-chase.
        this._behaviorRuntime = createBehaviorRuntime();
    }

    // ----- serialization ---------------------------------------------------------------------------

    protected _serializePayload(): any {
        return {
            // Both are node ids and BOTH are in NODE_REF_KEYS. Without that, duplicating a
            // controller+character pair leaves the copy driving the ORIGINAL character — which looks
            // right until a second one is spawned and every NPC moves as one.
            possessedId: this._possessedId,
            aimSourceId: this._aimSourceId,

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
            whiskerCount: this.whiskerCount,
            whiskerSpread: this.whiskerSpread,
            // Written only when authored, so a controller that never opened the Behaviour section adds
            // nothing to the scene file.
            ...(isDefaultBehaviorMachine(this.behavior) ? {} : { behavior: this.behavior }),
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
        node.whiskerCount = Math.max(1, Math.min(9, Math.round(
            typeof json.whiskerCount === 'number' && isFinite(json.whiskerCount)
                ? json.whiskerCount : node.whiskerCount)));
        node.whiskerSpread = typeof json.whiskerSpread === 'number' && isFinite(json.whiskerSpread)
            ? Math.max(0, Math.min(360, json.whiskerSpread)) : node.whiskerSpread;
        node.behavior = parseBehaviorMachine(json.behavior);

        // _commonParse adds the node to its parent — do not addChild again.
        Node.finishParse(node, parent, json);
    }
}
