import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { CharacterBody2DNode } from '../src/core/scene/nodes/characterBody2DNode';
import { Body2DNode } from '../src/core/scene/nodes/body2DNode';
import { Area2DNode } from '../src/core/scene/nodes/area2DNode';
import { TilemapNode } from '../src/core/scene/nodes/tilemapNode';
import { Tilemap } from '../src/graphics/tilemap/tilemap';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { createMoveResult, moveAndSlide, raycast2D, wallTouching } from '../src/physics2d/collide2d';
import type { Body2DShape, MoveOptions } from '../src/physics2d/collide2d';
import {
    DEFAULT_PLATFORMER, createPlatformerEvents, createPlatformerState, jumpPhysics, stepPlatformer,
} from '../src/physics2d/platformer';
import type { PlatformerAbilities, PlatformerIntent } from '../src/physics2d/platformer';
import { TILE_NONE, TILE_ONE_WAY, TILE_SLOPE, TILE_SOLID } from '../src/physics2d/types';
import type { CollisionWorld2D, Grid2D } from '../src/physics2d/types';

// The 2D physics: move-and-slide through tiles (solid, one-way, slopes) and boxes, the platformer
// controller's feel, and the scene's 2D pass that runs both and reports area overlaps.

/** A grid from ASCII rows, top row first at row 0: # solid, = one-way, / rising 45, \ falling 45, < > a 26.5 slope's halves. */
function gridOf(rows: string[], originX = 0, originY = 0): Grid2D {
    return {
        originX, originY, cellWidth: 1, cellHeight: 1,
        sample(col, row, slope) {
            const ch = rows[row]?.[col] ?? ' ';
            switch (ch) {
                case '#': return TILE_SOLID;
                case '=': return TILE_ONE_WAY;
                case '/': slope[0] = 0; slope[1] = 1; return TILE_SLOPE;
                case '\\': slope[0] = 1; slope[1] = 0; return TILE_SLOPE;
                case '<': slope[0] = 0; slope[1] = 0.5; return TILE_SLOPE;
                case '>': slope[0] = 0.5; slope[1] = 1; return TILE_SLOPE;
                default: return TILE_NONE;
            }
        },
    };
}
const world = (rows: string[]): CollisionWorld2D => ({ grids: [gridOf(rows)], boxes: [] });
const opts = (o: Partial<MoveOptions> = {}): MoveOptions => ({ dropThrough: false, stepUp: 0.5, snapDown: 0.5, grounded: false, ...o });
const body = (x: number, y: number): Body2DShape => ({ x, y, halfWidth: 0.4, height: 1.8 });

// Row r spans y in [-(r + 1), -r]: the top of row 5 is y = -5.
const FLOOR = [
    '          ',
    '          ',
    '          ',
    '          ',
    '          ',
    '##########',
];

describe('moveAndSlide', () => {
    it('lands on a floor and stops there', () => {
        const r = moveAndSlide(world(FLOOR), body(3, -3), 0, -10, opts());
        expect(r.y).toBe(-5);
        expect(r.grounded).toBe(true);
    });

    it('does not tunnel through a floor however fast it falls', () => {
        const r = moveAndSlide(world(FLOOR), body(3, 20), 0, -200, opts());
        expect(r.y).toBe(-5);
    });

    it('stops at a wall, flush with it', () => {
        const w = world(['     #    ', '     #    ', '     #    ', '     #    ', '     #    ', '##########']);
        const r = moveAndSlide(w, body(2, -5), 10, 0, opts({ grounded: true }));
        expect(r.x).toBeCloseTo(5 - 0.4, 6);
        expect(r.hitRight).toBe(true);
        expect(wallTouching(w, { ...body(r.x, r.y) }, 1)).toBe(true);
        expect(wallTouching(w, { ...body(r.x, r.y) }, -1)).toBe(false);
    });

    it('climbs a step no higher than stepUp, and is stopped by a higher one', () => {
        const low = world(['          ', '          ', '          ', '          ', '     #####', '##########']);
        // A full tile is a 1-unit step: more than 0.5.
        expect(moveAndSlide(low, body(3, -5), 2, 0, opts({ grounded: true })).hitRight).toBe(true);
        const r = moveAndSlide(low, body(3, -5), 2, 0, opts({ grounded: true, stepUp: 1.01 }));
        expect(r.x).toBeCloseTo(5, 6);
        expect(r.y).toBeCloseTo(-4, 6);
    });

    it('walks up a 45 degree slope and down it again without leaving the ground', () => {
        const w = world(['          ', '          ', '          ', '          ', '    /#####', '##########']);
        let b = body(2, -5);
        let r = createMoveResult();
        let grounded = true;
        // Up: 0.05 a step, gravity pulling, as the controller drives it.
        for (let i = 0; i < 80; i++) {
            r = moveAndSlide(w, b, 0.05, -0.01, opts({ grounded }), r);
            b = body(r.x, r.y); grounded = r.grounded;
            expect(grounded).toBe(true);
        }
        expect(b.y).toBeCloseTo(-4, 6);
        // And back down, staying on it.
        for (let i = 0; i < 80; i++) {
            r = moveAndSlide(w, b, -0.05, -0.01, opts({ grounded }), r);
            b = body(r.x, r.y); grounded = r.grounded;
            expect(grounded).toBe(true);
        }
        expect(b.y).toBeCloseTo(-5, 6);
    });

    it('stands a body on a slope by the middle of its feet', () => {
        const w = world(['          ', '          ', '          ', '          ', '    /     ', '##########']);
        const r = moveAndSlide(w, body(4.25, -3), 0, -5, opts());
        expect(r.y).toBeCloseTo(-5 + 0.25, 6);
        expect(r.onSlope).toBe(true);
    });

    it('lands on a one-way platform from above, passes it from below, and drops through it', () => {
        const w = world(['          ', '          ', '   ====   ', '          ', '          ', '##########']);
        // From above: lands on its top (y = -2).
        expect(moveAndSlide(w, body(4, -1), 0, -3, opts()).y).toBe(-2);
        // From below: straight through.
        expect(moveAndSlide(w, body(4, -4.9), 0, 3, opts()).y).toBeCloseTo(-1.9, 6);
        // Dropping through.
        expect(moveAndSlide(w, body(4, -2), 0, -1, opts({ dropThrough: true })).y).toBe(-3);
        // Never a wall.
        expect(moveAndSlide(w, body(1, -3), 5, 0, opts()).hitRight).toBe(false);
    });

    it('stops at a ceiling, slopes included', () => {
        const w = world(['          ', '  ###/    ', '          ', '          ', '          ', '##########']);
        const r = moveAndSlide(w, body(3, -5), 0, 5, opts());
        expect(r.hitCeiling).toBe(true);
        expect(r.y + 1.8).toBeCloseTo(-2, 6);
        expect(moveAndSlide(w, body(5.5, -5), 0, 5, opts()).hitCeiling).toBe(true);
    });

    it('collides with solid boxes, lands on one-way boxes from above only', () => {
        const w: CollisionWorld2D = {
            grids: [],
            boxes: [
                { minX: 5, minY: -1, maxX: 6, maxY: 3, oneWay: false, dx: 0, dy: 0, owner: 'wall' },
                { minX: 0, minY: 0, maxX: 4, maxY: 0.2, oneWay: true, dx: 0, dy: 0, owner: 'plank' },
            ],
        };
        expect(moveAndSlide(w, body(2, 0), 10, 0, opts()).x).toBeCloseTo(4.6, 6);
        const land = moveAndSlide(w, body(2, 2), 0, -5, opts());
        expect(land.y).toBeCloseTo(0.2, 6);
        expect(land.groundBox?.owner).toBe('plank');
        expect(moveAndSlide(w, body(2, -2), 0, 3, opts()).y).toBeCloseTo(1, 6);
    });
});

describe('raycast2D', () => {
    it('hits a solid cell, and a slope at its surface', () => {
        const w = world(FLOOR);
        const hit = raycast2D(w, 3.5, 0, 0, -1, 20);
        expect(hit?.y).toBeCloseTo(-5, 3);
        const s = world(['          ', '          ', '          ', '          ', '   /      ', '##########']);
        expect(raycast2D(s, 3.5, 0, 0, -1, 20)?.y).toBeCloseTo(-5 + 0.5, 2);
        expect(raycast2D(w, 3.5, 0, 0, 1, 20)).toBeNull();
    });
});

describe('the platformer controller', () => {
    const all: PlatformerAbilities = { doubleJump: true, dash: true, wallJump: true };
    const none: PlatformerAbilities = { doubleJump: false, dash: false, wallJump: false };
    const intent = (o: Partial<PlatformerIntent> = {}): PlatformerIntent =>
        ({ moveX: 0, moveY: 0, jumpPressed: false, jumpHeld: false, dashPressed: false, ...o });
    const air = { grounded: false, wallLeft: false, wallRight: false, ceiling: false };
    const ground = { ...air, grounded: true };
    const ev = createPlatformerEvents();

    it('derives gravity and the launch speed from the jump\'s height and time', () => {
        const { gravity, jumpSpeed } = jumpPhysics({ jumpHeight: 3, jumpTimeToApex: 0.5 });
        expect(gravity).toBeCloseTo(24, 6);
        expect(jumpSpeed).toBeCloseTo(12, 6);
    });

    it('jumps within coyote time after leaving a ledge, not after', () => {
        const s = createPlatformerState();
        stepPlatformer(s, intent(), ground, DEFAULT_PLATFORMER, none, 1 / 60, ev);
        stepPlatformer(s, intent(), air, DEFAULT_PLATFORMER, none, 0.05, ev);
        stepPlatformer(s, intent({ jumpPressed: true, jumpHeld: true }), air, DEFAULT_PLATFORMER, none, 1 / 60, ev);
        expect(ev.jumped).toBe(true);
        const late = createPlatformerState();
        stepPlatformer(late, intent(), ground, DEFAULT_PLATFORMER, none, 1 / 60, ev);
        stepPlatformer(late, intent(), air, DEFAULT_PLATFORMER, none, 0.2, ev);
        stepPlatformer(late, intent({ jumpPressed: true, jumpHeld: true }), air, DEFAULT_PLATFORMER, none, 1 / 60, ev);
        expect(ev.jumped).toBe(false);
    });

    it('remembers a jump pressed just before landing', () => {
        const s = createPlatformerState();
        stepPlatformer(s, intent({ jumpPressed: true, jumpHeld: true }), air, DEFAULT_PLATFORMER, none, 0.05, ev);
        expect(ev.jumped).toBe(false);
        stepPlatformer(s, intent({ jumpHeld: true }), ground, DEFAULT_PLATFORMER, none, 1 / 60, ev);
        expect(ev.jumped).toBe(true);
    });

    it('double jumps only with the ability, once per landing', () => {
        for (const [abilities, expected] of [[none, false], [all, true]] as const) {
            const s = createPlatformerState();
            stepPlatformer(s, intent(), ground, DEFAULT_PLATFORMER, abilities, 1 / 60, ev);
            stepPlatformer(s, intent(), air, DEFAULT_PLATFORMER, abilities, 0.3, ev);
            stepPlatformer(s, intent({ jumpPressed: true, jumpHeld: true }), air, DEFAULT_PLATFORMER, abilities, 1 / 60, ev);
            expect(ev.airJumped).toBe(expected);
        }
        const s = createPlatformerState();
        stepPlatformer(s, intent(), ground, DEFAULT_PLATFORMER, all, 1 / 60, ev);
        stepPlatformer(s, intent(), air, DEFAULT_PLATFORMER, all, 0.3, ev);
        stepPlatformer(s, intent({ jumpPressed: true, jumpHeld: true }), air, DEFAULT_PLATFORMER, all, 1 / 60, ev);
        stepPlatformer(s, intent(), air, DEFAULT_PLATFORMER, all, 0.3, ev);
        stepPlatformer(s, intent({ jumpPressed: true, jumpHeld: true }), air, DEFAULT_PLATFORMER, all, 1 / 60, ev);
        expect(ev.airJumped).toBe(false);
    });

    it('dashes at dash speed with gravity off, then waits for its cooldown', () => {
        const s = createPlatformerState();
        stepPlatformer(s, intent({ dashPressed: true, moveX: 1 }), ground, DEFAULT_PLATFORMER, all, 1 / 60, ev);
        expect(ev.dashed).toBe(true);
        expect(s.vx).toBe(DEFAULT_PLATFORMER.dashSpeed);
        expect(s.vy).toBe(0);
        for (let t = 0; t < DEFAULT_PLATFORMER.dashTime; t += 1 / 60) stepPlatformer(s, intent({ moveX: 1 }), ground, DEFAULT_PLATFORMER, all, 1 / 60, ev);
        stepPlatformer(s, intent({ dashPressed: true }), ground, DEFAULT_PLATFORMER, all, 1 / 60, ev);
        expect(ev.dashed).toBe(false);
        expect(createPlatformerState().dashLeft).toBe(0);
        const gated = createPlatformerState();
        stepPlatformer(gated, intent({ dashPressed: true }), ground, DEFAULT_PLATFORMER, none, 1 / 60, ev);
        expect(ev.dashed).toBe(false);
    });

    it('slides down a wall it presses into, and jumps off it away from the wall', () => {
        const s = createPlatformerState();
        s.vy = -20;
        const wall = { ...air, wallRight: true };
        stepPlatformer(s, intent({ moveX: 1 }), wall, DEFAULT_PLATFORMER, all, 1 / 60, ev);
        expect(s.wallSliding).toBe(true);
        expect(s.vy).toBe(-DEFAULT_PLATFORMER.wallSlideSpeed);
        stepPlatformer(s, intent({ moveX: 1, jumpPressed: true, jumpHeld: true }), wall, DEFAULT_PLATFORMER, all, 1 / 60, ev);
        expect(ev.wallJumped).toBe(true);
        expect(s.vx).toBeLessThan(0);
        expect(s.vy).toBeGreaterThan(0);
        const gated = createPlatformerState();
        gated.vy = -20;
        stepPlatformer(gated, intent({ moveX: 1 }), wall, DEFAULT_PLATFORMER, none, 1 / 60, ev);
        expect(gated.wallSliding).toBe(false);
    });

    it('cuts the jump short when the button is let go', () => {
        const s = createPlatformerState();
        stepPlatformer(s, intent({ jumpPressed: true, jumpHeld: true }), ground, DEFAULT_PLATFORMER, none, 1 / 60, ev);
        const v = s.vy;
        stepPlatformer(s, intent(), air, DEFAULT_PLATFORMER, none, 1 / 60, ev);
        expect(s.vy).toBeLessThan(v * DEFAULT_PLATFORMER.jumpCutMultiplier + 1);
    });
});

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

/** A scene with a flat 1x1-cell floor from x = -20 to 20 at y = 0, and a scripted player body on it. */
function level() {
    const scene = new Scene();
    const ts = new Tileset({ id: 'ts', textureId: 'ts.png', imageWidth: 16, imageHeight: 16, tileWidth: 16, tileHeight: 16, columns: 1, rows: 1 });
    ts.setMeta(0, { solid: true });
    const map = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
    map.registerTileset(ts);
    map.addLayer({ tilesetId: 'ts' });
    for (let x = -20; x < 20; x++) map.setTile(0, x, 0, 0);
    scene.addNode(new TilemapNode('Map', map));
    const player = new CharacterBody2DNode('Player');
    player.playerInput = false;
    player.setPosition([0, 2, 0]);
    scene.addNode(player);
    scene.start();
    return { scene, player, map };
}
const run = (scene: Scene, seconds: number, fps = 60, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / fps) { each?.(); scene.update(1 / fps, 0, false); }
};

describe('the 2D physics pass', () => {
    it('drops a body onto the floor and stands it there', () => {
        const { scene, player } = level();
        run(scene, 1);
        expect(player.position[1]).toBeCloseTo(0, 5);
        expect(player.isGrounded).toBe(true);
    });

    it('jumps to the same height at 30, 60 and 144 frames a second', () => {
        const apex = (fps: number) => {
            const { scene, player } = level();
            run(scene, 0.5, fps);
            player.jump();
            let top = 0;
            run(scene, 1, fps, () => { top = Math.max(top, player.position[1]); });
            return top;
        };
        const heights = [30, 60, 144].map(apex);
        for (const h of heights) expect(h).toBeCloseTo(DEFAULT_PLATFORMER.jumpHeight, 1);
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.08);
    });

    it('walks where a script steers it, and faces that way', () => {
        const { scene, player } = level();
        run(scene, 0.3);
        player.move(-1);
        run(scene, 1);
        expect(player.position[0]).toBeLessThan(-5);
        expect(player.facing).toBe(-1);
    });

    it('carries a body standing on a moving platform', () => {
        const scene = new Scene();
        const platform = new Body2DNode('Lift', [4, 0.5]);
        platform.kind = 'oneWay';
        scene.addNode(platform);
        const player = new CharacterBody2DNode('Player');
        player.playerInput = false;
        player.setPosition([0, 1, 0]);
        scene.addNode(player);
        scene.start();
        run(scene, 0.5);
        expect(player.position[1]).toBeCloseTo(0.25, 4);
        let t = 0;
        run(scene, 1, 60, () => { t += 1 / 60; platform.setPosition([t * 2, t, 0]); });
        expect(player.position[0]).toBeGreaterThan(1.5);
        expect(player.position[1]).toBeGreaterThan(0.9);
        expect(player.isGrounded).toBe(true);
    });

    it('tells an area and what came in, and out', () => {
        const { scene, player } = level();
        const zone = new Area2DNode('Checkpoint', [2, 2]);
        zone.setPosition([5, 1, 0]);
        scene.addNode(zone);
        const heard: string[] = [];
        zone.onTriggerEnter = (n: Node) => { heard.push(`zone sees ${n.name}`); };
        zone.onTriggerExit = (n: Node) => { heard.push(`zone loses ${n.name}`); };
        player.onTriggerEnter = (n: Node) => { heard.push(`player in ${n.name}`); };
        run(scene, 0.3);
        player.move(1);
        run(scene, 2);
        expect(heard).toEqual(['zone sees Player', 'player in Checkpoint', 'zone loses Player']);
    });

    it('lets areas see areas, mirrors a facing body\'s child area, and filters by layer', () => {
        const { scene, player } = level();
        const sword = new Area2DNode('Sword', [1, 1]);
        sword.offset = [1, 1];
        sword.detectAreas = true;
        sword.mask = 2;
        player.addChild(sword);
        const enemyHurt = new Area2DNode('Hurtbox', [0.6, 1.6]);
        enemyHurt.layer = 2;
        enemyHurt.setPosition([-1.2, 1, 0]);
        scene.addNode(enemyHurt);
        const hits: string[] = [];
        sword.onTriggerEnter = (n: Node) => { hits.push(n.name); };
        run(scene, 0.3);
        expect(hits).toEqual([]);
        player.facing = -1;
        run(scene, 0.05);
        expect(hits).toEqual(['Hurtbox']);
    });
});

describe('Tilemap.collision2DAt', () => {
    it('reads solid, one-way and slope tiles, mirroring a flipped slope', () => {
        const ts = new Tileset({ id: 'ts', textureId: 'ts.png', imageWidth: 64, imageHeight: 16, tileWidth: 16, tileHeight: 16, columns: 4, rows: 1 });
        ts.setMeta(0, { solid: true });
        ts.setMeta(1, { oneWay: true });
        ts.setMeta(2, { slope: [0, 0.5] });
        const map = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
        map.registerTileset(ts);
        map.addLayer({ tilesetId: 'ts' });
        map.setTile(0, 0, 0, 0);
        map.setTile(0, 1, 0, 1);
        map.setTile(0, 2, 0, 2);
        map.setTile(0, 3, 0, 2, { flipX: true });
        map.setTile(0, 4, 0, 2, { flipY: true });
        const slope: [number, number] = [0, 0];
        expect(map.collision2DAt(0, 0, slope)).toBe(TILE_SOLID);
        expect(map.collision2DAt(1, 0, slope)).toBe(TILE_ONE_WAY);
        expect(map.collision2DAt(2, 0, slope)).toBe(TILE_SLOPE);
        expect(slope).toEqual([0, 0.5]);
        expect(map.collision2DAt(3, 0, slope)).toBe(TILE_SLOPE);
        expect(slope).toEqual([0.5, 0]);
        expect(map.collision2DAt(4, 0, slope)).toBe(TILE_SOLID);
        expect(map.collision2DAt(9, 0, slope)).toBe(TILE_NONE);
    });
});
