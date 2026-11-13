import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import {
    DEFAULT_PLATFORMER, createPlatformerEvents, createPlatformerState,
} from "../../../physics2d/platformer";
import type {
    PlatformerAbilities, PlatformerEvents, PlatformerIntent, PlatformerSettings, PlatformerState,
} from "../../../physics2d/platformer";
import { Node } from "./node";

/** How a 2D body moves: the built-in platformer controller, or by its velocity alone (a script sets it). */
export type Body2DController = 'platformer' | 'none';

/**
 * A 2D character's body: an axis-aligned box standing on its feet at the node's position, moved through
 * the tilemaps and 2D colliders by the scene's 2D physics (src/physics2d) every frame the game plays --
 * sliding along walls, landing on floors and one-way platforms, walking up and down slopes and steps.
 *
 * With the PLATFORMER controller (the default) it runs, jumps (higher the longer the button is held, with
 * coyote time and a jump buffer) and, given the abilities, double jumps, dashes and wall-slides and
 * wall-jumps. It reads the player's input actions, or, with `playerInput` off, the intent a script hands it
 * (`move`, `jump`, `dash`): an enemy walks with the same feel as the player. With no controller it falls
 * by `gravity` and moves by `velocity`, which a script sets.
 *
 * The body keeps its sprite children facing the way it faces (`flipSprites`). Its world position is its
 * feet: give the sprite a pivot at its feet and the two line up.
 */
export class CharacterBody2DNode extends Node {
    /** The box: width and height, world units, standing on the node's position. */
    public size: [number, number] = [0.8, 1.8];
    /** The 2D layer the body is on, and which an area must look for to see it (bits). */
    public layer: number = 1;
    public controller: Body2DController = 'platformer';
    /** Read the player's input actions; off, scripts drive it (move, jump, dash). */
    public playerInput: boolean = true;
    /** The input actions it reads. */
    public moveAction: string = 'Move';
    public jumpAction: string = 'Jump';
    public dashAction: string = 'Dash';
    public settings: PlatformerSettings = { ...DEFAULT_PLATFORMER, wallJumpSpeed: [...DEFAULT_PLATFORMER.wallJumpSpeed] as [number, number] };
    /** The abilities a metroidvania hands out: off until found. */
    public abilities: PlatformerAbilities = { doubleJump: false, dash: false, wallJump: false };
    /** Fall acceleration with no controller, units per second squared. */
    public gravity: number = 40;
    /** The most it climbs walking: a step, the rise of a slope. World units. */
    public stepHeight: number = 0.5;
    /** Keep its sprite children facing the way it faces (Sprite.flipX). */
    public flipSprites: boolean = true;

    /**
     * Velocity, units per second (x right, y up). The controller writes it; with no controller, a script
     * does. (`velocity` is the 3D body's.)
     */
    public readonly velocity2D: [number, number] = [0, 0];

    /** @internal The controller's memory, what the last step touched, and what happened in it. */
    public readonly controlState: PlatformerState = createPlatformerState();
    public readonly stepEvents: PlatformerEvents = createPlatformerEvents();
    public readonly contacts = { grounded: false, wallLeft: false, wallRight: false, ceiling: false, onSlope: false };
    /** @internal The scripted intent, consumed by the next step when `playerInput` is off. */
    public readonly intent: PlatformerIntent = { moveX: 0, moveY: 0, jumpPressed: false, jumpHeld: false, dashPressed: false };
    /** @internal What it stands on: a 2D collider's node, or null (a tile, or the air). */
    public groundNode: Node | null = null;

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'characterBody2D', id);
    }

    // --- what scripts read --------------------------------------------------------------------------

    /** Standing on something. */
    public get isGrounded(): boolean { return this.contacts.grounded; }
    /** A wall it touches: -1 on its left, 1 on its right, 0 none. */
    public get onWall(): number { return this.contacts.wallLeft ? -1 : this.contacts.wallRight ? 1 : 0; }
    public get onCeiling(): boolean { return this.contacts.ceiling; }
    public get onSlope(): boolean { return this.contacts.onSlope; }
    /** -1 facing left, 1 facing right. */
    public get facing(): number { return this.controlState.facing; }
    public set facing(v: number) { this.controlState.facing = v < 0 ? -1 : 1; }
    public get isDashing(): boolean { return this.controlState.dashLeft > 0; }
    public get isWallSliding(): boolean { return this.controlState.wallSliding; }
    /** This frame: it jumped (from the ground, the air or a wall), dashed, landed. */
    public get justJumped(): boolean { return this.stepEvents.jumped || this.stepEvents.airJumped || this.stepEvents.wallJumped; }
    public get justDashed(): boolean { return this.stepEvents.dashed; }
    public get justLanded(): boolean { return this.stepEvents.landed; }

    // --- what scripts do -----------------------------------------------------------------------------

    /** Steer (-1..1) this frame, with `playerInput` off. */
    public move(x: number, y: number = 0): void { this.intent.moveX = x; this.intent.moveY = y; }
    /** Press jump this frame (held until `releaseJump`, so it jumps its full height), with `playerInput` off. */
    public jump(): void { this.intent.jumpPressed = true; this.intent.jumpHeld = true; }
    public releaseJump(): void { this.intent.jumpHeld = false; }
    /** Press dash this frame, with `playerInput` off. */
    public dash(): void { this.intent.dashPressed = true; }

    /** Put the body at (x, y) at once, at rest: a respawn, a door. */
    public teleport(x: number, y: number): void {
        const p = this.position;
        this.setPosition([x, y, p[2]]);
        this.velocity2D[0] = 0; this.velocity2D[1] = 0;
        this.controlState.vx = 0; this.controlState.vy = 0; this.controlState.dashLeft = 0;
        this.contacts.grounded = false;
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
                size: [this.size[0], this.size[1]], layer: this.layer, controller: this.controller,
                playerInput: this.playerInput, moveAction: this.moveAction, jumpAction: this.jumpAction, dashAction: this.dashAction,
                settings: { ...this.settings, wallJumpSpeed: [...this.settings.wallJumpSpeed] },
                abilities: { ...this.abilities },
                gravity: this.gravity, stepHeight: this.stepHeight, flipSprites: this.flipSprites,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new CharacterBody2DNode(json.name, json.id);
        const d = json.characterBody2D ?? {};
        const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
        if (Array.isArray(d.size) && d.size.length >= 2) node.size = [Math.max(0.01, num(d.size[0], 0.8)), Math.max(0.01, num(d.size[1], 1.8))];
        node.layer = num(d.layer, 1) | 0;
        node.controller = d.controller === 'none' ? 'none' : 'platformer';
        node.playerInput = d.playerInput !== false;
        if (typeof d.moveAction === 'string') node.moveAction = d.moveAction;
        if (typeof d.jumpAction === 'string') node.jumpAction = d.jumpAction;
        if (typeof d.dashAction === 'string') node.dashAction = d.dashAction;
        const s = d.settings ?? {};
        for (const key of Object.keys(DEFAULT_PLATFORMER) as (keyof PlatformerSettings)[]) {
            if (key === 'wallJumpSpeed') {
                if (Array.isArray(s.wallJumpSpeed) && s.wallJumpSpeed.length >= 2)
                    node.settings.wallJumpSpeed = [num(s.wallJumpSpeed[0], 9), num(s.wallJumpSpeed[1], 12)];
            } else (node.settings as any)[key] = num(s[key], DEFAULT_PLATFORMER[key] as number);
        }
        const a = d.abilities ?? {};
        node.abilities = { doubleJump: a.doubleJump === true, dash: a.dash === true, wallJump: a.wallJump === true };
        node.gravity = num(d.gravity, 40);
        node.stepHeight = Math.max(0, num(d.stepHeight, 0.5));
        node.flipSprites = d.flipSprites !== false;
        Node.finishParse(node, parent, json);
    }
}
