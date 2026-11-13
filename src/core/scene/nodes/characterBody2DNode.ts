import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Logger } from "../../logger";
import { createIntent, consumeRequest } from "../../control/intent";
import type { ControlIntent } from "../../control/intent";
import {
    LOCOMOTION_2D_DEFAULTS, createContacts2D, createLocomotion2DEvents, createLocomotion2DState, jumpPhysics,
    locomotion2DTuning,
} from "../../../physics2d/locomotion2d";
import type {
    Body2DMovement, Contacts2D, Locomotion2DEvents, Locomotion2DState, Locomotion2DTuning,
} from "../../../physics2d/locomotion2d";
import type { Body2DSim } from "../../../physics2d/body2d";
import type { ControllerNode } from "./controllerNode";
import { Node } from "./node";

/**
 * A 2D character's body, the 2D twin of a Character: a box standing on its feet at the node's position,
 * moved through the tilemaps and 2D colliders by the scene's 2D physics every frame the game plays --
 * sliding along walls, landing on floors and one-way platforms, walking up and down slopes and steps.
 *
 * It walks (or flies), runs while sprinting, and jumps, with coyote time and a jump buffer, because a
 * driver told it to: a {@link ControllerNode} possesses it and writes a {@link ControlIntent} -- from the
 * player's input actions, or from an AI brain -- and a script may patch that intent from `onUpdate` with
 * {@link drive}, exactly as on a 3D Character. Unpossessed and undriven it is INERT: it falls, and keeps
 * whatever velocity a script gives it.
 *
 * A game's own moves -- a dash, a double jump, a wall jump, a jump cut, a knock-back -- are the game's,
 * written in its script's `onMove2D(dt, substep)`, which runs every physics substep (at most 1/120 s)
 * before the engine's steering. Return `true` from it to own that substep: the engine's steering and jump
 * are skipped and the script's `velocity2D` stands, while gravity (times `gravityScale`) and collision still
 * run. See docs/scripting/characters-and-controllers.md.
 *
 * The body keeps its sprite children facing the way it faces (`flipSprites`). Its world position is its
 * feet: give the sprite a pivot at its feet and the two line up.
 */
export class CharacterBody2DNode extends Node {
    /** The box: width and height, world units, standing on the node's position. */
    public size: [number, number] = [0.8, 1.8];
    /** The 2D layer the body is on, and which an area must look for to see it (bits). */
    public layer: number = 1;
    /** Walk (on the ground, under gravity) or fly (both axes, no gravity). */
    public movement: Body2DMovement = 'walk';
    public walkSpeed: number = LOCOMOTION_2D_DEFAULTS.walkSpeed;
    public runSpeed: number = LOCOMOTION_2D_DEFAULTS.runSpeed;
    public acceleration: number = LOCOMOTION_2D_DEFAULTS.acceleration;
    public deceleration: number = LOCOMOTION_2D_DEFAULTS.deceleration;
    public airControl: number = LOCOMOTION_2D_DEFAULTS.airControl;
    public jumpHeight: number = LOCOMOTION_2D_DEFAULTS.jumpHeight;
    public jumpTimeToApex: number = LOCOMOTION_2D_DEFAULTS.jumpTimeToApex;
    public fallGravityMultiplier: number = LOCOMOTION_2D_DEFAULTS.fallGravityMultiplier;
    /** The fastest fall, units per second. Scripts lower it for a wall slide. */
    public maxFallSpeed: number = LOCOMOTION_2D_DEFAULTS.maxFallSpeed;
    public coyoteSeconds: number = LOCOMOTION_2D_DEFAULTS.coyoteSeconds;
    /** Seconds a jump press is remembered for before landing. Read by the controller, as on a Character. */
    public jumpBufferSeconds: number = 0.12;
    /** A multiplier on gravity. Scripts set it at run time (0 holds the height through a dash). */
    public gravityScale: number = 1;
    /** The most it climbs walking: a step, the rise of a slope. World units. */
    public stepHeight: number = 0.5;
    /** Keep its sprite children facing the way it faces (Sprite.flipX). */
    public flipSprites: boolean = true;
    /** One-way platforms hold it up. Off, it passes through them both ways, as a flier does. */
    public oneWayPlatforms: boolean = true;
    /** Run the locomotion every frame even with no controller and no script driving it. */
    public driveWhenUnpossessed: boolean = false;

    /** True from take-off until the feet are back down. A plain field, so an animation can bind to it. */
    public isJumping: boolean = false;

    /**
     * Velocity, units per second (x right, y up): the engine's steering writes it, a script may too (in
     * `onMove2D`, or for an undriven body). (`velocity` is the 3D body's.)
     */
    public readonly velocity2D: [number, number] = [0, 0];

    /** @internal What the last step touched. */
    public readonly contacts: Contacts2D = createContacts2D();
    /** @internal What it stands on: a 2D collider's node, or null (a tile, or the air). */
    public groundNode: Node | null = null;

    private readonly _intent: ControlIntent = createIntent();
    private readonly _state: Locomotion2DState = createLocomotion2DState();
    private readonly _events: Locomotion2DEvents = createLocomotion2DEvents();
    private readonly _tuning: Locomotion2DTuning = { ...LOCOMOTION_2D_DEFAULTS };
    /** @internal The body as the pure step sees it; its arrays are this node's own. */
    public readonly sim: Body2DSim = {
        x: 0, y: 0, halfWidth: 0.4, height: 1.8, velocity: this.velocity2D, contacts: this.contacts,
        state: this._state, events: this._events, stepHeight: 0.5, oneWayPlatforms: true, groundBox: null,
    };
    private _controller: ControllerNode | null = null;
    private _driven: boolean = false;
    private static _warnedLegacyController = false;

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'characterBody2D', id);
    }

    // --- the intent surface ---------------------------------------------------------------------------

    /** This frame's intent. Read-only in spirit -- it is overwritten every frame. */
    public get intent(): Readonly<ControlIntent> { return this._intent; }

    /**
     * The intent, MARKED FRESH: this body will act on it in this frame's 2D physics step. What a controller
     * writes through, and what a script calls from `onUpdate` to patch it.
     *
     * The 2D intent is in WORLD axes: `move[0]` is +x right, `move[1]` +y up (a flier climbs; a walker
     * holds down with a jump to drop through a one-way platform). `sprint` runs, `speedScale` throttles,
     * a raised `jump` request jumps.
     */
    public drive(): ControlIntent {
        this._driven = true;
        return this._intent;
    }

    /** @internal Whether the 2D step should act on the intent this frame, clearing the mark. */
    public _takeDriven(): boolean {
        const driven = this._driven || this.driveWhenUnpossessed;
        this._driven = false;
        return driven;
    }

    /** The controller possessing this body, or null. Set by `ControllerNode.possess`. */
    public get controller(): ControllerNode | null { return this._controller; }
    /**
     * Possess with `controller.possess(body)`; assigning a controller here does that, and null releases.
     * The strings 'platformer' and 'none' named the built-in controller, which moved to the game's scripts:
     * they are accepted and ignored, so an old script still runs.
     */
    public set controller(value: ControllerNode | null | string) {
        if (typeof value === 'string') {
            if (!CharacterBody2DNode._warnedLegacyController) {
                CharacterBody2DNode._warnedLegacyController = true;
                Logger.warn(`'${this._name}': a 2D body no longer has a built-in controller ('${value}'). ` +
                    `A Controller node drives it; a dash or a double jump is the game's script (onMove2D).`, 'Scene');
            }
            return;
        }
        if (value) (value as any).possess?.(this);
        else this._controller?.release();
    }
    public get isControlled(): boolean { return this._controller !== null; }

    /** Called by {@link ControllerNode} only: a back-pointer update. */
    public _setController(controller: ControllerNode | null): void {
        this._controller = controller;
    }

    /**
     * A script's say in the movement, every physics substep (at most 1/120 s), before the engine's
     * steering. Return `true` to own the substep -- the engine skips its steering and jump, your
     * `velocity2D` stands, gravity (times `gravityScale`) and collision still run. The default does nothing.
     */
    public onMove2D(_dt: number, _substep: number): boolean | void {}

    /** The tuning as the pure step wants it, refreshed from the fields (they are live and inspector-edited). */
    public get tuning(): Locomotion2DTuning {
        return locomotion2DTuning(this, this._tuning);
    }

    // --- what scripts read --------------------------------------------------------------------------

    /** Standing on something. */
    public get isGrounded(): boolean { return this.contacts.grounded; }
    /** A wall it touches: -1 on its left, 1 on its right, 0 none. */
    public get onWall(): number { return this.contacts.wallLeft ? -1 : this.contacts.wallRight ? 1 : 0; }
    public get onCeiling(): boolean { return this.contacts.ceiling; }
    public get onSlope(): boolean { return this.contacts.onSlope; }
    /** -1 facing left, 1 facing right. */
    public get facing(): number { return this._state.facing; }
    public set facing(v: number) { this._state.facing = v < 0 ? -1 : 1; }
    /** A jump would launch now: on the ground, or within coyote time of leaving it. */
    public get canJump(): boolean { return this.contacts.grounded || this._state.coyote > 0; }
    /** A jump request is pending (raised and not yet used). */
    public get jumpRequested(): boolean { return this._intent.requests.jump > 0; }
    /** Take the pending jump request, for a script's own jump (a double or wall jump). True once per press. */
    public consumeJump(): boolean { return consumeRequest(this._intent, 'jump'); }
    /** Gravity (units/s^2, positive down) and a jump's launch speed, from the jump height and time. */
    public get gravity(): number { return jumpPhysics(this).gravity; }
    public get jumpSpeed(): number { return jumpPhysics(this).jumpSpeed; }
    /** This frame: it jumped, landed, dropped through a platform. */
    public get justJumped(): boolean { return this._events.jumped; }
    public get justLanded(): boolean { return this._events.landed; }
    public get justDroppedThrough(): boolean { return this._events.droppedThrough; }

    // The measured-motion family, from the 2D step (Node's reads the 3D body, which a 2D body has none of),
    // so animation parameters, behaviour builtins and fuzzy inputs read a 2D body as they read a 3D one.
    public get currentSpeed(): number { return Math.hypot(this.velocity2D[0], this.velocity2D[1]); }
    public get rawSpeed(): number { return this.currentSpeed; }
    /** Speed along the ground: |vx| for a walker, the whole speed for a flier. */
    public get planarSpeed(): number { return this.movement === 'fly' ? this.currentSpeed : Math.abs(this.velocity2D[0]); }
    public get verticalSpeed(): number { return this.velocity2D[1]; }
    public get currentVelocity(): vec3 { return vec3.fromValues(this.velocity2D[0], this.velocity2D[1], 0); }
    public get isMoving(): boolean { return this.planarSpeed > 0.1; }
    public get airTime(): number { return this._state.airTime; }
    public get groundedTime(): number { return this._state.groundedTime; }

    /** Put the body at (x, y) at once, at rest: a respawn, a door. */
    public teleport(x: number, y: number): void {
        const p = this.position;
        this.setPosition([x, y, p[2]]);
        this.velocity2D[0] = 0; this.velocity2D[1] = 0;
        this.contacts.grounded = false;
        this._state.coyote = 0;
        this._state.jumping = false;
        this.isJumping = false;
    }

    /** Selection and pick bounds: the box. */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        return {
            min: vec3.fromValues(p[0] - this.size[0] / 2, p[1], p[2] - 0.05),
            max: vec3.fromValues(p[0] + this.size[0] / 2, p[1] + this.size[1], p[2] + 0.05),
        };
    }

    protected _serializePayload(): any {
        return {
            characterBody2D: {
                size: [this.size[0], this.size[1]], layer: this.layer, movement: this.movement,
                walkSpeed: this.walkSpeed, runSpeed: this.runSpeed, acceleration: this.acceleration,
                deceleration: this.deceleration, airControl: this.airControl, jumpHeight: this.jumpHeight,
                jumpTimeToApex: this.jumpTimeToApex, fallGravityMultiplier: this.fallGravityMultiplier,
                maxFallSpeed: this.maxFallSpeed, coyoteSeconds: this.coyoteSeconds,
                jumpBufferSeconds: this.jumpBufferSeconds,
                ...(this.gravityScale !== 1 ? { gravityScale: this.gravityScale } : {}),
                stepHeight: this.stepHeight, flipSprites: this.flipSprites,
                ...(this.oneWayPlatforms ? {} : { oneWayPlatforms: false }),
                ...(this.driveWhenUnpossessed ? { driveWhenUnpossessed: true } : {}),
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new CharacterBody2DNode(json.name, json.id);
        const d = json.characterBody2D ?? {};
        const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
        if (Array.isArray(d.size) && d.size.length >= 2) node.size = [Math.max(0.01, num(d.size[0], 0.8)), Math.max(0.01, num(d.size[1], 1.8))];
        node.layer = num(d.layer, 1) | 0;
        // A body saved with the built-in platformer controller carries `settings`; see legacyBody2DTuning.
        const tuning = locomotion2DTuning(d.settings && typeof d.settings === 'object' ? legacyBody2DTuning(d) : d);
        node.movement = tuning.movement;
        node.walkSpeed = tuning.walkSpeed;
        node.runSpeed = tuning.runSpeed;
        node.acceleration = tuning.acceleration;
        node.deceleration = tuning.deceleration;
        node.airControl = tuning.airControl;
        node.jumpHeight = tuning.jumpHeight;
        node.jumpTimeToApex = tuning.jumpTimeToApex;
        node.fallGravityMultiplier = tuning.fallGravityMultiplier;
        node.maxFallSpeed = tuning.maxFallSpeed;
        node.coyoteSeconds = tuning.coyoteSeconds;
        node.gravityScale = tuning.gravityScale;
        node.jumpBufferSeconds = Math.max(0, num(d.jumpBufferSeconds ?? d.settings?.jumpBuffer, 0.12));
        node.stepHeight = Math.max(0, num(d.stepHeight, 0.5));
        node.flipSprites = d.flipSprites !== false;
        node.oneWayPlatforms = d.oneWayPlatforms !== false;
        node.driveWhenUnpossessed = d.driveWhenUnpossessed === true;
        Node.finishParse(node, parent, json);
    }
}

/**
 * The generic tuning of a body saved with the built-in platformer controller, before the platformer moved
 * to the game's scripts: its run speed, acceleration, jump and fall carry over, while its dash, air jumps
 * and wall jump -- now script -- are dropped. A `controller: 'none'` body, moved by its velocity alone,
 * becomes a flier when it had no gravity, and keeps its fall otherwise.
 */
export function legacyBody2DTuning(d: any): Partial<Record<keyof Locomotion2DTuning, unknown>> {
    const s = d?.settings ?? {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const out: Partial<Record<keyof Locomotion2DTuning, unknown>> = {
        walkSpeed: num(s.runSpeed), runSpeed: num(s.runSpeed),
        acceleration: num(s.acceleration), deceleration: num(s.deceleration),
        jumpHeight: num(s.jumpHeight), jumpTimeToApex: num(s.jumpTimeToApex),
        fallGravityMultiplier: num(s.fallGravityMultiplier), maxFallSpeed: num(s.maxFallSpeed),
        coyoteSeconds: num(s.coyoteTime),
    };
    const accel = num(s.acceleration), air = num(s.airAcceleration);
    if (accel && air !== undefined) out.airControl = Math.max(0, Math.min(1, air / accel));
    if (d?.controller === 'none') {
        const g = num(d.gravity) ?? 40;
        if (g <= 0) out.movement = 'fly';
        else {
            // A constant fall of `g`: a jump of the stored height reaching its apex under that gravity.
            const h = num(s.jumpHeight) ?? LOCOMOTION_2D_DEFAULTS.jumpHeight;
            out.fallGravityMultiplier = 1;
            out.jumpTimeToApex = Math.sqrt(2 * h / g);
        }
    }
    return out;
}
