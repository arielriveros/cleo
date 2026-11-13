import { rects2DIntersect } from '../core/math';
import { Input } from '../input/inputApi';
import { Node } from '../core/scene/nodes/node';
import { SpriteNode } from '../core/scene/nodes/spriteNode';
import { CharacterBody2DNode } from '../core/scene/nodes/characterBody2DNode';
import type { Body2DNode } from '../core/scene/nodes/body2DNode';
import type { Area2DNode } from '../core/scene/nodes/area2DNode';
import type { TilemapNode } from '../core/scene/nodes/tilemapNode';
import { createMoveResult, moveAndSlide, overlapsSolid, raycast2D, wallTouching } from './collide2d';
import type { Body2DShape, RayHit2D } from './collide2d';
import { createPlatformerEvents, stepPlatformer } from './platformer';
import type { PlatformerIntent } from './platformer';
import type { Box2D, CollisionWorld2D, Grid2D } from './types';

/** What the 2D world reads from the scene each step (the scene's typed lists). */
export interface World2DSceneView {
    readonly tilemaps: ReadonlySet<TilemapNode>;
    readonly bodies2D: ReadonlySet<CharacterBody2DNode>;
    readonly colliders2D: ReadonlySet<Body2DNode>;
    readonly areas2D: ReadonlySet<Area2DNode>;
}

/** The longest substep, seconds: fast enough that a jump's arc is the same at any frame rate. */
const MAX_SUBSTEP = 1 / 120;

/**
 * The scene's 2D physics (Scene.physics2D): each frame the game plays, it moves every 2D character body
 * through the tilemaps and 2D colliders, carries what stands on moving platforms, and tells 2D areas what
 * came in and went out. Queries (raycast, overlap) read the same world between steps.
 */
export class World2D {
    private readonly _world: CollisionWorld2D = { grids: [], boxes: [] };
    private readonly _boxByOwner = new Map<Node, Box2D>();
    private readonly _move = createMoveResult();
    private readonly _events = createPlatformerEvents();
    private readonly _intent: PlatformerIntent = { moveX: 0, moveY: 0, jumpPressed: false, jumpHeld: false, dashPressed: false };
    private readonly _bodyRect: [number, number, number, number] = [0, 0, 0, 0];
    private readonly _areaRect: [number, number, number, number] = [0, 0, 0, 0];
    private readonly _otherRect: [number, number, number, number] = [0, 0, 0, 0];

    /** The world as of the last step (or {@link refresh}): what queries read. */
    public get world(): CollisionWorld2D { return this._world; }

    /** Rebuild the collision world from the scene: its tilemaps and enabled 2D colliders, as they stand. */
    public refresh(view: World2DSceneView, carry: boolean = false): void {
        const grids: Grid2D[] = this._world.grids;
        grids.length = 0;
        for (const node of view.tilemaps) {
            const map = node.tilemap;
            if (map.grid.kind !== 'orthogonal') continue;
            const p = node.worldPosition;
            grids.push({
                originX: p[0], originY: p[1], cellWidth: map.grid.cellWidth, cellHeight: map.grid.cellHeight,
                sample: (col, row, slope) => map.collision2DAt(col, row, slope),
            });
        }
        const boxes = this._world.boxes;
        boxes.length = 0;
        this._boxByOwner.clear();
        for (const node of view.colliders2D) {
            const b = node.bounds();
            const p = node.worldPosition;
            const dx = carry && Number.isFinite(node.lastX) ? p[0] - node.lastX : 0;
            const dy = carry && Number.isFinite(node.lastY) ? p[1] - node.lastY : 0;
            if (carry) { node.lastX = p[0]; node.lastY = p[1]; }
            if (!node.enabled || !node.visible) continue;
            const box: Box2D = { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], oneWay: node.kind === 'oneWay', dx, dy, owner: node };
            boxes.push(box);
            this._boxByOwner.set(node, box);
        }
    }

    /** One frame of `dt` seconds of game time. */
    public step(dt: number, view: World2DSceneView): void {
        if (!(dt > 0)) return;
        this.refresh(view, true);
        for (const body of view.bodies2D) {
            if (body.markForRemoval || !body.visible) continue;
            this._stepBody(body, dt);
        }
        this._updateAreas(view);
    }

    private _stepBody(body: CharacterBody2DNode, dt: number): void {
        const intent = this._intent;
        if (body.playerInput) {
            const move = Input.vector(body.moveAction);
            intent.moveX = move[0]; intent.moveY = move[1];
            intent.jumpPressed = Input.started(body.jumpAction);
            intent.jumpHeld = Input.pressed(body.jumpAction);
            intent.dashPressed = Input.started(body.dashAction);
        } else {
            const own = body.intent;
            intent.moveX = own.moveX; intent.moveY = own.moveY;
            intent.jumpPressed = own.jumpPressed; intent.jumpHeld = own.jumpHeld; intent.dashPressed = own.dashPressed;
            // Edges are spent by this step; the steer and the hold stand until the script changes them.
            own.jumpPressed = false; own.dashPressed = false;
        }

        const pos = body.position;
        const shape: Body2DShape = { x: pos[0], y: pos[1], halfWidth: body.size[0] / 2, height: body.size[1] };
        const contacts = body.contacts;
        const state = body.controlState;
        const ev = body.stepEvents;
        ev.jumped = ev.airJumped = ev.wallJumped = ev.dashed = ev.landed = ev.droppedThrough = false;

        // Carried by the platform it stands on, by what the platform moved since the last step.
        const ground = body.groundNode ? this._boxByOwner.get(body.groundNode) : undefined;
        if (ground && contacts.grounded && (ground.dx !== 0 || ground.dy !== 0)) {
            shape.x += ground.dx;
            shape.y += ground.dy;
        }

        const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-6));
        const h = dt / steps;
        const moved = this._move;
        for (let i = 0; i < steps; i++) {
            const pressed = i === 0;
            let vyStart: number;
            if (body.controller === 'platformer') {
                const jp = intent.jumpPressed, dp = intent.dashPressed;
                intent.jumpPressed = pressed && jp; intent.dashPressed = pressed && dp;
                stepPlatformer(state, intent, contacts, body.settings, body.abilities, h, this._events);
                intent.jumpPressed = jp; intent.dashPressed = dp;
                const e = this._events;
                ev.jumped ||= e.jumped; ev.airJumped ||= e.airJumped; ev.wallJumped ||= e.wallJumped;
                ev.dashed ||= e.dashed; ev.landed ||= e.landed; ev.droppedThrough ||= e.droppedThrough;
                body.velocity2D[0] = state.vx; body.velocity2D[1] = state.vy;
                vyStart = state.vyStart;
            } else {
                vyStart = body.velocity2D[1];
                if (contacts.grounded && body.velocity2D[1] < 0) body.velocity2D[1] = 0;
                else body.velocity2D[1] -= body.gravity * h;
            }
            const vx = body.velocity2D[0], vy = body.velocity2D[1];
            // The average of the vertical speed before and after this step's gravity: exact under constant
            // gravity, so the arc of a jump does not depend on the frame rate.
            const fall = (vyStart + vy) * 0.5;
            moveAndSlide(this._world, shape, vx * h, fall * h, {
                dropThrough: state.dropLeft > 0 || !body.oneWayPlatforms,
                stepUp: body.stepHeight,
                snapDown: body.stepHeight,
                grounded: contacts.grounded && vy <= 0,
            }, moved);
            shape.x = moved.x; shape.y = moved.y;
            contacts.grounded = moved.grounded;
            contacts.onSlope = moved.onSlope;
            contacts.ceiling = moved.hitCeiling;
            contacts.wallLeft = wallTouching(this._world, shape, -1);
            contacts.wallRight = wallTouching(this._world, shape, 1);
            body.groundNode = moved.groundBox ? moved.groundBox.owner as Node : null;
            // What a wall, a floor or a ceiling stopped stops the velocity too.
            if ((moved.hitLeft && vx < 0) || (moved.hitRight && vx > 0)) { body.velocity2D[0] = 0; state.vx = 0; }
            if ((moved.grounded && vy < 0) || (moved.hitCeiling && vy > 0)) { body.velocity2D[1] = 0; state.vy = 0; }
        }
        if (body.controller !== 'platformer' && body.velocity2D[0] !== 0) body.facing = body.velocity2D[0];
        body.setPosition([shape.x, shape.y, pos[2]]);

        if (body.flipSprites) {
            const left = state.facing < 0;
            for (const child of body.children)
                if (child instanceof SpriteNode && child.sprite.flipX !== left) child.sprite.flipX = left;
        }
    }

    /** The character body an area rides on (its nearest ancestor), whose facing mirrors the area's offset. */
    private static _ownerBody(node: Node): CharacterBody2DNode | null {
        for (let p = node.parent; p; p = p.parent) if (p instanceof CharacterBody2DNode) return p;
        return null;
    }

    private _updateAreas(view: World2DSceneView): void {
        for (const area of view.areas2D) {
            const before = area.touching;
            const now = new Set<Node>();
            if (area.enabled && area.visible && !area.markForRemoval) {
                const owner = World2D._ownerBody(area);
                area.bounds(!!owner && owner.facing < 0, this._areaRect);
                for (const body of view.bodies2D) {
                    if (body === owner || body.markForRemoval || !body.visible || !(area.mask & body.layer)) continue;
                    const p = body.worldPosition;
                    const r = this._bodyRect;
                    r[0] = p[0] - body.size[0] / 2; r[1] = p[1]; r[2] = p[0] + body.size[0] / 2; r[3] = p[1] + body.size[1];
                    if (rects2DIntersect(this._areaRect, r)) now.add(body);
                }
                if (area.detectAreas) {
                    for (const other of view.areas2D) {
                        if (other === area || !other.enabled || !other.visible || other.markForRemoval || !(area.mask & other.layer)) continue;
                        const otherOwner = World2D._ownerBody(other);
                        if (otherOwner && otherOwner === owner) continue;
                        other.bounds(!!otherOwner && otherOwner.facing < 0, this._otherRect);
                        if (rects2DIntersect(this._areaRect, this._otherRect)) now.add(other);
                    }
                }
            }
            for (const n of before) if (!now.has(n)) { area.onTriggerExit(n); n.onTriggerExit(area); }
            for (const n of now) if (!before.has(n)) { area.onTriggerEnter(n); n.onTriggerEnter(area); }
            before.clear();
            for (const n of now) before.add(n);
        }
    }

    // --- queries ------------------------------------------------------------------------------------------

    /** The first solid thing along a ray from (x, y) in direction (dx, dy), within `maxDistance`. */
    public raycast(x: number, y: number, dx: number, dy: number, maxDistance: number): RayHit2D | null {
        return raycast2D(this._world, x, y, dx, dy, maxDistance);
    }

    /** Whether the box [minX, minY, maxX, maxY] overlaps a solid tile or 2D collider. */
    public overlapsSolid(minX: number, minY: number, maxX: number, maxY: number): boolean {
        return overlapsSolid(this._world, minX, minY, maxX, maxY);
    }
}
