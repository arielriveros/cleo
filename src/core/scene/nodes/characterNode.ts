import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Logger } from "../../logger";
import { Node } from "./node";
import {
    createLocomotionState, locomotionTuning, stepLocomotion, FACING_MODES,
} from "../../control/locomotion";
import type {
    FacingMode, LocomotionSense, LocomotionState, LocomotionTuning,
} from "../../control/locomotion";
import { consumeRequest, createIntent, decayRequests } from "../../control/intent";
import type { ControlIntent } from "../../control/intent";
import type { ControllerNode } from "./controllerNode";

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
    /** Seconds of smoothing on {@link moveDir}, so a blend probe glides between strafes. */
    public directionSmoothing: number = 0.12;
    /** Units/s² the planar speed ramps at. 0 snaps, which is what a keyboard controller usually wants. */
    public acceleration: number = 0;
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
            directionSmoothing: this.directionSmoothing,
            acceleration: this.acceleration,
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
        if (!this._driven && !this.driveWhenUnpossessed) return;
        this._driven = false;

        const body = this.body;
        if (!body) {
            if (!this._warnedNoBody) {
                this._warnedNoBody = true;
                Logger.warn(
                    `Character '${this._name}' has no rigid body, so it cannot move. Add one in the ` +
                    `Physics panel (a capsule collider with friction 0 suits a character).`, 'Scene');
            }
            return;
        }

        const out = stepLocomotion(this._intent, this._sense(delta), this.tuning, this._locomotion);
        this._locomotion = out.next;

        this.velocity = out.velocity as [number, number, number];
        // `setRotation` pushes into the body; `setQuaternion` deliberately would not, and the physics
        // solver has to agree with the transform or the capsule slides while facing elsewhere.
        if (out.yaw !== null) this.setRotation([0, out.yaw, 0]);

        this.moveDir = out.moveDir;
        this.isJumping = out.isJumping;
        this.turnRequest = out.turnRequest;

        // The step never consumes the request — it only reports that it launched — so that it can stay a
        // pure function of its arguments. Consuming is the caller's half of that bargain.
        if (out.jumped) consumeRequest(this._intent, 'jump');
        decayRequests(this._intent, delta);
    }

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
                `a 0 locks that axis and blocks movement along it. Set it to [1, 1, 1] in the Physics panel.`,
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

    protected _serializePayload(): any {
        return {
            walkSpeed: this.walkSpeed,
            runSpeed: this.runSpeed,
            jumpSpeed: this.jumpSpeed,
            turnSpeed: this.turnSpeed,
            turnThreshold: this.turnThreshold,
            turnReleaseAngle: this.turnReleaseAngle,
            directionSmoothing: this.directionSmoothing,
            acceleration: this.acceleration,
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

        const num = (value: any, fallback: number) => typeof value === 'number' && isFinite(value) ? value : fallback;
        const bool = (value: any, fallback: boolean) => typeof value === 'boolean' ? value : fallback;

        node.walkSpeed = num(json.walkSpeed, node.walkSpeed);
        node.runSpeed = num(json.runSpeed, node.runSpeed);
        node.jumpSpeed = num(json.jumpSpeed, node.jumpSpeed);
        node.turnSpeed = num(json.turnSpeed, node.turnSpeed);
        node.turnThreshold = num(json.turnThreshold, node.turnThreshold);
        node.turnReleaseAngle = num(json.turnReleaseAngle, node.turnReleaseAngle);
        node.directionSmoothing = num(json.directionSmoothing, node.directionSmoothing);
        node.acceleration = num(json.acceleration, node.acceleration);
        node.airControl = num(json.airControl, node.airControl);
        node.coyoteSeconds = num(json.coyoteSeconds, node.coyoteSeconds);
        node.jumpBufferSeconds = num(json.jumpBufferSeconds, node.jumpBufferSeconds);
        node.jumpLockoutSeconds = num(json.jumpLockoutSeconds, node.jumpLockoutSeconds);
        if ((FACING_MODES as readonly string[]).includes(json.facingMode)) node.facingMode = json.facingMode;
        node.driveWhenUnpossessed = bool(json.driveWhenUnpossessed, node.driveWhenUnpossessed);

        // _commonParse adds the node to its parent — do not addChild again.
        Node.finishParse(node, parent, json);
    }
}
