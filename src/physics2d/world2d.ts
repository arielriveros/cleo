import { rects2DIntersect } from '../core/math';
import { decayRequests } from '../core/control/intent';
import { Logger } from '../core/logger';
import { Node } from '../core/scene/nodes/node';
import { SpriteNode } from '../core/scene/nodes/spriteNode';
import { CharacterBody2DNode } from '../core/scene/nodes/characterBody2DNode';
import type { Body2DNode } from '../core/scene/nodes/body2DNode';
import type { Area2DNode } from '../core/scene/nodes/area2DNode';
import type { TilemapNode } from '../core/scene/nodes/tilemapNode';
import { createMoveResult, floorBetween, overlapsSolid, raycast2D } from './collide2d';
import type { RayHit2D } from './collide2d';
import { stepBody2D } from './body2d';
import type { Locomotion2DTuning } from './locomotion2d';
import type { Box2D, CollisionWorld2D, Grid2D } from './types';

/** What the 2D world reads from the scene each step (the scene's typed lists). */
export interface World2DSceneView {
    readonly tilemaps: ReadonlySet<TilemapNode>;
    readonly bodies2D: ReadonlySet<CharacterBody2DNode>;
    readonly colliders2D: ReadonlySet<Body2DNode>;
    readonly areas2D: ReadonlySet<Area2DNode>;
}

/**
 * The scene's 2D physics (Scene.physics2D): each frame the game plays, it moves every 2D character body
 * through the tilemaps and 2D colliders, carries what stands on moving platforms, and tells 2D areas what
 * came in and went out. Queries (raycast, overlap) read the same world between steps.
 */
export class World2D {
    private readonly _world: CollisionWorld2D = { grids: [], boxes: [] };
    private readonly _boxByOwner = new Map<Node, Box2D>();
    private readonly _move = createMoveResult();
    /** The body whose script hook the bound {@link _hook} calls, and the tuning it may retune mid-frame. */
    private _hookBody: CharacterBody2DNode | null = null;
    private _hookTuning: Locomotion2DTuning | null = null;
    private readonly _hook = (dt: number, substep: number): boolean => this._callHook(dt, substep);
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

    /**
     * One body's frame: carried by the platform it stands on, then the pure step (src/physics2d/body2d.ts)
     * -- its script's `onMove2D` each substep, the generic locomotion when something drove it this frame,
     * gravity and move-and-slide. Its jump request ages a frame, as on a 3D Character.
     */
    private _stepBody(body: CharacterBody2DNode, dt: number): void {
        const pos = body.position;
        const sim = body.sim;
        sim.x = pos[0]; sim.y = pos[1];
        sim.halfWidth = body.size[0] / 2; sim.height = body.size[1];
        sim.stepHeight = body.stepHeight; sim.oneWayPlatforms = body.oneWayPlatforms;

        // Carried by the platform it stands on, by what the platform moved since the last step.
        const ground = body.groundNode ? this._boxByOwner.get(body.groundNode) : undefined;
        if (ground && body.contacts.grounded && (ground.dx !== 0 || ground.dy !== 0)) {
            sim.x += ground.dx;
            sim.y += ground.dy;
        }

        const tuning = body.tuning;
        const driven = body._takeDriven();
        const intent = driven ? body.drive() : null;
        // Only a script that defines the hook pays for the call (a class script's methods are own properties).
        const scripted = body.onMove2D !== CharacterBody2DNode.prototype.onMove2D;
        this._hookBody = body; this._hookTuning = tuning;
        stepBody2D(this._world, sim, intent, tuning, dt, scripted ? this._hook : null, this._move);
        this._hookBody = null; this._hookTuning = null;
        // `drive()` above marks it again; this frame is spent.
        body._takeDriven();
        if (intent) decayRequests(intent, dt);

        body.groundNode = sim.groundBox ? sim.groundBox.owner as Node : null;
        body.isJumping = sim.state.jumping;
        body.setPosition([sim.x, sim.y, pos[2]]);

        if (body.flipSprites) {
            const left = sim.state.facing < 0;
            for (const child of body.children)
                if (child instanceof SpriteNode && child.sprite.flipX !== left) child.sprite.flipX = left;
        }
    }

    /** The bound hook: the body's `onMove2D`, then what it may have retuned for the rest of the frame. */
    private _callHook(dt: number, substep: number): boolean {
        const body = this._hookBody!, tuning = this._hookTuning!;
        let owned = false;
        try { owned = body.onMove2D(dt, substep) === true; }
        catch (e) { Logger.error(`Error in onMove2D for node ${body.name}: ${e}`, 'Script'); }
        tuning.maxFallSpeed = Math.max(0, Number.isFinite(body.maxFallSpeed) ? body.maxFallSpeed : tuning.maxFallSpeed);
        tuning.gravityScale = Math.max(0, Number.isFinite(body.gravityScale) ? body.gravityScale : tuning.gravityScale);
        tuning.movement = body.movement === 'fly' ? 'fly' : 'walk';
        return owned;
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

    /**
     * The top of the ground under a body `halfWidth` either side of `x`, from `fromY` down to `fromY - depth`
     * -- one-way platforms included, unlike {@link raycast} -- or -Infinity when there is none: a ledge test.
     */
    public groundBelow(x: number, halfWidth: number, fromY: number, depth: number): number {
        const floor = floorBetween(this._world, { x, y: fromY, halfWidth, height: 0.1 }, fromY, fromY - Math.max(0, depth), false);
        return Number.isFinite(floor) ? floor : -Infinity;
    }

    /** Whether the box [minX, minY, maxX, maxY] overlaps a solid tile or 2D collider. */
    public overlapsSolid(minX: number, minY: number, maxX: number, maxY: number): boolean {
        return overlapsSolid(this._world, minX, minY, maxX, maxY);
    }
}
