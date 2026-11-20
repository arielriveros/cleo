import { quat, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Logger } from "../../logger";
import { Node } from "./node";
import { CHARACTER_PRESETS, type CharacterPreset } from "./characterPresets";
import { applyPreset } from "../../presets";
import {
    createLocomotionState, locomotionTuning, stepLocomotion, FACING_MODES, MOVE_DIR_SOURCES,
} from "../../control/locomotion";
import type {
    FacingMode, LocomotionSense, LocomotionState, LocomotionTuning, MoveDirSource,
} from "../../control/locomotion";
import { clearIntent, consumeRequest, createIntent, decayRequests, INTENT_REQUESTS } from "../../control/intent";
import type { ControlIntent } from "../../control/intent";
import type { ControllerNode } from "./controllerNode";
import type { RigidBody } from "../../../physics/body";
import { finiteOr } from "../../math";

/**
 * A pawn: something that walks, turns and jumps because a driver told it to.
 *
 * This is `examples/scripts/ThirdPersonPlayable.ts` promoted into the engine. It was a user script with
 * `Input.vector('Move')` wired into its `onUpdate`, which meant the behaviour was unreachable by anything
 * but a player — an NPC wanting the same locomotion had to fork it. Here the character reads a
 * {@link ControlIntent} and has no idea where it came from, so the same node walks under a keyboard, a
 * gamepad, a touch stick or a steering brain.
 *
 * Everything that decides anything lives in the pure `stepLocomotion`; this class is plumbing between it
 * and the node/physics surfaces — the same division `cameraRigMath.ts` has with `cameraRigNode.ts`.
 *
 * ## Who drives it
 *
 * A {@link ControllerNode} possesses it and writes intent in the scene's control pass, before the node
 * loop. A script may also call {@link drive} from `onUpdate` to patch or replace that intent.
 *
 * An unpossessed, unscripted Character is INERT: it never touches its own velocity, so introducing this
 * node type into an existing scene changes nothing. `driveWhenUnpossessed` opts out of that for a
 * character meant to be steered purely from script.
 *
 * ## Why locomotion runs in `update` and not `onUpdate`
 *
 * `attachClassScript` copies a script's prototype methods onto the node as OWN PROPERTIES, which shadows
 * a class method of the same name. Locomotion in `onUpdate` would therefore be silently disabled by any
 * script attached to a Character — the failure being a character that simply does not move, with nothing
 * to say why. `ModelNode.update` sets the precedent: call `super.update` (which runs the script's
 * `onUpdate`), then do the engine's own work.
 */
export class CharacterNode extends Node {
    /**
     * The body that moves this character: its Collider's (the Collider it stands in, holding its capsule).
     * A Character authors no shape of its own, so every body-derived reading on it -- `velocity`,
     * `isGrounded`, `groundNormal`, the measured motion -- and every write to `velocity` go to that body.
     */
    public override get body(): RigidBody | null {
        for (let n = this.parent; n; n = n.parent) if (n.nodeType === 'collider') return n.ownBody;
        return this._body;
    }

    /**
     * Put the character at the WORLD point `position`, standing still, facing `yawDegrees` when given: a
     * respawn, a fast travel. What moves is its Collider, which is what physics moves -- moving the
     * Character itself would only slide it inside its capsule.
     */
    public teleport(position: ArrayLike<number>, yawDegrees?: number): this {
        const collider = this.collider;
        const mover = collider && collider !== this ? collider : this;
        // The Character's own offset in its Collider stays: the Collider goes where that puts the Character.
        const own = this.worldPosition, at = mover.worldPosition;
        mover.setWorldPosition([position[0] + at[0] - own[0], position[1] + at[1] - own[1], position[2] + at[2] - own[2]]);
        if (this.body) this.velocity = vec3.create();
        // A world heading: under a turned Collider (a placed copy's turn) a local yaw would face off by it.
        if (yawDegrees !== undefined) this.setWorldYaw(yawDegrees);
        mover.updateTransforms(mover.parent ? mover.parent.worldTransform : null);
        return this;
    }

    // ----- animator outputs ----------------------------------------------------------------------
    //
    // THESE THREE MUST STAY PLAIN FIELDS, never getter/setter pairs.
    //
    // `Animator._refreshVariableParams` reads a bound node property through
    // `Object.prototype.hasOwnProperty.call(node, name)`, which a prototype getter fails. A TS class
    // field compiles to a constructor assignment and so is an own property; converting one to an
    // accessor — which the house class style otherwise pushes toward — would silently break the
    // animation of every scene that binds to it, with no error anywhere. `tests/characterNode.test.ts`
    // pins the own-property check.

    /**
     * Travel direction relative to the BODY's facing, in DEGREES: 0 ahead, **-90 strafe right**,
     * +90 strafe left, ±180 back.
     *
     * Counter-clockwise, agreeing exactly with {@link Node.planarAngle}, so a blend space can bind to
     * either without its strafes mirroring. Bind it to a 2D Animation Field's X axis.
     */
    public moveDir: number = 0;

    /** True from take-off until the feet are back down. Bind to a `Jumping` bool parameter. */
    public isJumping: boolean = false;

    /**
     * Which turn-in-place clip should play: 0 none, +1/+2 right 90°/180°, -1/-2 left.
     *
     * A clip SELECTOR, so its sign is the opposite of {@link moveDir}'s — see `locomotion.ts`. The
     * character never rotates itself for a turn-in-place; the clip's root motion does, and this only
     * holds the code until the body has caught up.
     */
    public turnRequest: number = 0;

    // ----- tuning (serialized, inspector-visible) -------------------------------------------------

    public walkSpeed: number = 1.5;
    public runSpeed: number = 4;
    public jumpSpeed: number = 4;
    /** Degrees per second the body swings toward the aim WHILE MOVING. */
    public turnSpeed: number = 540;
    /** Degrees the aim may swing off the body before an idle turn-in-place fires. */
    public turnThreshold: number = 90;
    /** Degrees at which an in-progress turn-in-place clears. The release half of a hysteresis pair. */
    public turnReleaseAngle: number = 10;
    /** Seconds the aim must hold past the threshold before a 90 turn engages, so a sweep to 180 plays the 180. */
    public turnSettleSeconds: number = 0.12;
    /** Seconds the aim must hold past 135 degrees before the 180 turn engages. 0 engages it at once. */
    public turnSettleFarSeconds: number = 0;
    /** Seconds of smoothing on {@link moveDir}, so a blend probe glides between strafes. */
    public directionSmoothing: number = 0.12;
    /** Units/s² the planar speed ramps at. 0 snaps, which is what a keyboard controller usually wants. */
    public acceleration: number = 0;
    /**
     * Per second: how fast a moving body's velocity turns toward a new direction, keeping its speed (Unreal's
     * ground friction, 8 there). 0 leaves turning to {@link acceleration}, which is slower and dips the speed.
     */
    public turnFriction: number = 0;
    /** What {@link moveDir} reads: the input's direction, or the body's actual travel. See `MoveDirSource`. */
    public moveDirSource: MoveDirSource = 'input';
    /**
     * Degrees: the steepest ground the character stands on without sliding down it. On ground up to this steep,
     * gravity only presses it into the ground (physics/slopeHold.ts), so it stands still, sets off, brakes and
     * climbs as on the flat; steeper ground it slides down. 0 turns the hold off.
     */
    public slopeLimit: number = 45;
    /**
     * Set by the animator while its state holds this character still (`AnimationState.holdMovement`): the
     * character then stops steering, and only root motion moves it. Runtime only, never saved.
     */
    public animationHold: boolean = false;
    /** 0..1 of steering authority while airborne. */
    public airControl: number = 1;
    /** Seconds after walking off an edge during which a jump still launches. */
    public coyoteSeconds: number = 0.12;
    /**
     * Seconds a jump request stays pending, so a press just before landing still fires. Read by whoever
     * RAISES the request — the controller — rather than by the locomotion step.
     */
    public jumpBufferSeconds: number = 0.15;
    /** Seconds after take-off during which the slope projection is suppressed. */
    public jumpLockoutSeconds: number = 0.15;
    /** `aim` turns toward the intent's aim (a strafe character), `velocity` toward travel, `none` never. */
    public facingMode: FacingMode = 'aim';
    /**
     * Whether locomotion runs with nothing possessing this character. False by default, so an
     * unpossessed Character is inert and cannot fight physics for control of its own velocity.
     */
    public driveWhenUnpossessed: boolean = false;

    // ----- runtime state (never serialized) -------------------------------------------------------

    private readonly _intent: ControlIntent = createIntent();
    private _locomotion: LocomotionState = createLocomotionState();
    /** Its Collider's body is out of the world (ColliderNode.physicsEnabled off): carried, not walking. */
    private _riding: boolean = false;
    private _controller: ControllerNode | null = null;
    /** Something wrote intent this frame. Cleared after every step — see {@link drive}. */
    private _driven: boolean = false;
    private _warnedNoBody: boolean = false;
    private _warnedConstrained: boolean = false;
    private _warnedAnimatorAncestor: boolean = false;

    // Scratch, to keep the per-frame path allocation-free. Static: only one character steps at a time.
    private static readonly _v0: vec3 = vec3.create();

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'character', id);
    }

    // ----- the intent surface ---------------------------------------------------------------------

    /** This frame's intent. Read-only in spirit — it is overwritten every frame. */
    public get intent(): Readonly<ControlIntent> { return this._intent; }

    /**
     * The intent, MARKED FRESH: this character will act on it during this frame's update.
     *
     * What a controller writes through, and what a script calls from `onUpdate` to patch it. Marking is
     * what keeps an unpossessed character inert rather than driving itself with a stale record.
     */
    public drive(): ControlIntent {
        this._driven = true;
        return this._intent;
    }

    /** The controller currently possessing this character, or null. Set by `ControllerNode.possess`. */
    public get controller(): ControllerNode | null { return this._controller; }
    public get isControlled(): boolean { return this._controller !== null; }

    /**
     * Called by {@link ControllerNode} only. Not `possess`'s inverse — a character never chooses its own
     * controller, so this is a back-pointer update rather than an operation.
     */
    public _setController(controller: ControllerNode | null): void {
        this._controller = controller;
    }

    /** The tuning as the pure step wants it. Rebuilt per frame: the fields are live and inspector-edited. */
    public get tuning(): LocomotionTuning {
        return locomotionTuning({
            walkSpeed: this.walkSpeed,
            runSpeed: this.runSpeed,
            jumpSpeed: this.jumpSpeed,
            turnSpeed: this.turnSpeed,
            turnThreshold: this.turnThreshold,
            turnReleaseAngle: this.turnReleaseAngle,
            turnSettleSeconds: this.turnSettleSeconds,
            turnSettleFarSeconds: this.turnSettleFarSeconds,
            directionSmoothing: this.directionSmoothing,
            acceleration: this.acceleration,
            turnFriction: this.turnFriction,
            moveDirSource: this.moveDirSource,
            airControl: this.airControl,
            coyoteSeconds: this.coyoteSeconds,
            jumpLockoutSeconds: this.jumpLockoutSeconds,
            facingMode: this.facingMode,
        });
    }

    /** Live locomotion state — coyote time left, whether a turn is in progress. For the inspector readout. */
    public get locomotionState(): Readonly<LocomotionState> { return this._locomotion; }

    // ----- the frame ------------------------------------------------------------------------------

    public update(delta: number, time: number): void {
        // The script's onUpdate FIRST, so it can patch or replace the intent the controller wrote.
        super.update(delta, time);
        this._stepLocomotion(delta);
    }

    private _stepLocomotion(delta: number): void {
        // Carried with its body out of the world (a seat in a car): it neither walks nor falls, and nothing it was
        // asked before it sat down (a buffered jump) waits for it to stand up.
        if (this.collider?._bodySuspended) {
            if (!this._riding) {
                this._riding = true;
                this._locomotion = createLocomotionState();
                clearIntent(this._intent);
                for (const kind of INTENT_REQUESTS) this._intent.requests[kind] = 0;
                this.isJumping = false;
                this.turnRequest = 0;
            }
            this._driven = false;
            return;
        }
        if (this._riding) {
            // Back on its feet: a fresh start, not the step it was in when it sat down.
            this._riding = false;
            this._locomotion = createLocomotionState();
        }
        if (!this._driven && !this.driveWhenUnpossessed) return;
        this._driven = false;

        const body = this.body;
        if (!body) {
            // In a Collider with no body built yet -- a scene being authored builds none -- there is nothing
            // to move and nothing wrong.
            if (!this._warnedNoBody && !this.collider) {
                this._warnedNoBody = true;
                Logger.warn(
                    `Character '${this._name}' is not in a Collider, so it cannot move. Put it under a ` +
                    `Collider with a capsule shape (friction 0 suits a character).`, 'Scene');
            }
            return;
        }

        // Held by the animation: no move, stopped at once, facing left alone. The intent itself is untouched, so
        // a jump request still waits in it for when the hold ends.
        const held = this.animationHold;
        const intent = held ? { ...this._intent, move: [0, 0] as [number, number], sprint: false } : this._intent;
        const tuning = held ? { ...this.tuning, acceleration: 0, facingMode: 'none' as const } : this.tuning;
        const out = stepLocomotion(intent, this._sense(delta), tuning, this._locomotion);
        this._locomotion = out.next;

        this.velocity = out.velocity as [number, number, number];
        // On walkable ground, held there over the next step: never in the air, and not as it takes off (the jump
        // lockout), when gravity must have it all.
        if (this.slopeLimit > 0 && this.isGrounded && !out.jumped && out.next.jumpLockout <= 0)
            this._scene?.physics?.holdOnSlope(body, this.slopeLimit);
        // A WORLD yaw (it came from worldForward), so it is set in world space: under a turned parent a local
        // write would face the character off its path. `setWorldQuaternion` also turns the body, which the
        // physics solver has to agree with or the capsule slides while facing elsewhere.
        if (out.yaw !== null) this.setWorldQuaternion(quat.fromEuler(CharacterNode._yawQ, 0, out.yaw, 0));

        this.moveDir = out.moveDir;
        this.isJumping = out.isJumping;
        this.turnRequest = out.turnRequest;

        // The step never consumes the request — it only reports that it launched — so that it can stay a
        // pure function of its arguments. Consuming is the caller's half of that bargain.
        if (out.jumped) consumeRequest(this._intent, 'jump');
        decayRequests(this._intent, delta);
    }

    private static _yawQ = quat.create();

    /** Everything the world can say about this character this frame, as plain numbers. */
    private _sense(delta: number): LocomotionSense {
        const forward = this.worldForward;
        const velocity = this.velocity;
        const normal = this.groundNormal;
        const up = this._scene?.physics?.up ?? vec3.set(CharacterNode._v0, 0, 1, 0);
        return {
            dt: delta,
            // From worldForward, NEVER `rotation[1]`: the euler decomposition can only express |yaw| ≤ 90,
            // so reading the field folds past a quarter turn and the body snaps back mid-rotation.
            bodyYaw: Math.atan2(forward[0], forward[2]) * 180 / Math.PI,
            velocity: [velocity[0], velocity[1], velocity[2]],
            grounded: this.isGrounded,
            groundNormal: [normal[0], normal[1], normal[2]],
            up: [up[0], up[1], up[2]],
        };
    }

    // ----- lifecycle ------------------------------------------------------------------------------

    public onSpawn(): void {
        const body = this.body;
        if (!body) return;

        // The two setup mistakes that make a character look broken rather than misconfigured. Carried
        // over from the script this replaces, where they lived in its onStart.
        const factor = (body as any).linearFactor;
        if (!this._warnedConstrained && factor
            && (factor.x === 0 || factor.y === 0 || factor.z === 0)) {
            this._warnedConstrained = true;
            Logger.warn(
                `Character '${this._name}' has linearConstraints [${factor.x}, ${factor.y}, ${factor.z}] — ` +
                `a 0 locks that axis and blocks movement along it. Set it to [1, 1, 1] on its Collider.`,
                'Scene');
        }

        // Ordering hazard, and a subtle one. Root motion writes back into the body from the ANIMATOR,
        // which runs during the model node's update; a character root normally precedes its model child
        // in the breadth-first traversal, so locomotion happens first and the two compose. A character
        // placed BELOW an animated model inverts that, and the turn-in-place system — which reads the
        // body yaw that root motion produced — then trails by a frame.
        if (!this._warnedAnimatorAncestor && this._hasAnimatedAncestor()) {
            this._warnedAnimatorAncestor = true;
            Logger.warn(
                `Character '${this._name}' sits below an animated model. Root motion will be applied ` +
                `before its locomotion each frame, which makes turn-in-place lag. Put the Character at ` +
                `the root of the actor and the model underneath it.`, 'Scene');
        }
    }

    private _hasAnimatedAncestor(): boolean {
        let node: Node | null = this.parent;
        while (node) {
            if ((node as any).animator) return true;
            node = node.parent;
        }
        return false;
    }

    public onDespawn(): void {
        // Held keys and a half-finished turn must not survive a respawn; the controller's possession does
        // (an id is authored state), so it is deliberately left alone here.
        this._locomotion = createLocomotionState();
        this._driven = false;
    }

    // ----- serialization ---------------------------------------------------------------------------

    /** Applies a preset by id (see CHARACTER_PRESETS) or a preset object. Returns false for an unknown id. */
    public applyPreset(idOrPreset: string | CharacterPreset): boolean {
        return applyPreset(this, CHARACTER_PRESETS, idOrPreset);
    }

    protected _serializePayload(): any {
        return {
            walkSpeed: this.walkSpeed,
            runSpeed: this.runSpeed,
            jumpSpeed: this.jumpSpeed,
            turnSpeed: this.turnSpeed,
            turnThreshold: this.turnThreshold,
            turnReleaseAngle: this.turnReleaseAngle,
            turnSettleSeconds: this.turnSettleSeconds,
            turnSettleFarSeconds: this.turnSettleFarSeconds,
            directionSmoothing: this.directionSmoothing,
            acceleration: this.acceleration,
            turnFriction: this.turnFriction,
            moveDirSource: this.moveDirSource,
            slopeLimit: this.slopeLimit,
            airControl: this.airControl,
            coyoteSeconds: this.coyoteSeconds,
            jumpBufferSeconds: this.jumpBufferSeconds,
            jumpLockoutSeconds: this.jumpLockoutSeconds,
            facingMode: this.facingMode,
            driveWhenUnpossessed: this.driveWhenUnpossessed,
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new CharacterNode(json.name, json.id);

        const bool = (value: any, fallback: boolean) => typeof value === 'boolean' ? value : fallback;

        node.walkSpeed = finiteOr(json.walkSpeed, node.walkSpeed);
        node.runSpeed = finiteOr(json.runSpeed, node.runSpeed);
        node.jumpSpeed = finiteOr(json.jumpSpeed, node.jumpSpeed);
        node.turnSpeed = finiteOr(json.turnSpeed, node.turnSpeed);
        node.turnThreshold = finiteOr(json.turnThreshold, node.turnThreshold);
        node.turnReleaseAngle = finiteOr(json.turnReleaseAngle, node.turnReleaseAngle);
        node.turnSettleSeconds = finiteOr(json.turnSettleSeconds, node.turnSettleSeconds);
        node.turnSettleFarSeconds = finiteOr(json.turnSettleFarSeconds, node.turnSettleFarSeconds);
        node.directionSmoothing = finiteOr(json.directionSmoothing, node.directionSmoothing);
        node.acceleration = finiteOr(json.acceleration, node.acceleration);
        node.turnFriction = finiteOr(json.turnFriction, node.turnFriction);
        if ((MOVE_DIR_SOURCES as readonly string[]).includes(json.moveDirSource)) node.moveDirSource = json.moveDirSource;
        node.slopeLimit = Math.min(89, Math.max(0, finiteOr(json.slopeLimit, node.slopeLimit)));
        node.airControl = finiteOr(json.airControl, node.airControl);
        node.coyoteSeconds = finiteOr(json.coyoteSeconds, node.coyoteSeconds);
        node.jumpBufferSeconds = finiteOr(json.jumpBufferSeconds, node.jumpBufferSeconds);
        node.jumpLockoutSeconds = finiteOr(json.jumpLockoutSeconds, node.jumpLockoutSeconds);
        if ((FACING_MODES as readonly string[]).includes(json.facingMode)) node.facingMode = json.facingMode;
        node.driveWhenUnpossessed = bool(json.driveWhenUnpossessed, node.driveWhenUnpossessed);

        // _commonParse adds the node to its parent — do not addChild again.
        Node.finishParse(node, parent, json);
    }
}
