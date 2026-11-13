import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { CharacterBody2DNode } from '../src/core/scene/nodes/characterBody2DNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { NavMeshNode } from '../src/core/scene/nodes/navMeshNode';
import { TilemapNode } from '../src/core/scene/nodes/tilemapNode';
import { Tilemap } from '../src/graphics/tilemap/tilemap';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { AISystem } from '../src/ai/aiSystem';
import { bakeNavGraph2D, navGraph2DSourceHash } from '../src/ai/navGraph2D';
import { World2D } from '../src/physics2d/world2d';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';

// A controller paths a 2D body on the scene's 2D navigation, as it paths a 3D Character on a navmesh:
// `path` and `investigate` plan through the graph (walks, jumps, drops) and the follower makes the jumps,
// `patrol` plans each leg between route points that stand on different platforms, and a flier flies the
// air grid. With nothing baked it seeks in a straight line, as in 3D.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

// The map sits at y = rows - 1: the floor's top is y = 0, platforms' tops y = 3 (x 8..14) and y = 6 (x 15..21).
const STAIRS = [
    '                          ',
    '                          ',
    '                          ',
    '               ######     ',
    '                          ',
    '                          ',
    '        ######            ',
    '                          ',
    '                          ',
    '##########################',
];

function level(rows: string[]) {
    const scene = new Scene();
    const ts = new Tileset({ id: 'ts', textureId: 'ts.png', imageWidth: 32, imageHeight: 16, tileWidth: 16, tileHeight: 16, columns: 2, rows: 1 });
    ts.setMeta(0, { solid: true });
    ts.setMeta(1, { oneWay: true });
    const map = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
    map.registerTileset(ts);
    map.addLayer({ tilesetId: 'ts' });
    rows.forEach((row, r) => [...row].forEach((ch, c) => {
        if (ch === '#') map.setTile(0, c, r, 0);
        if (ch === '=') map.setTile(0, c, r, 1);
    }));
    const node = new TilemapNode('Map', map);
    node.setPosition([0, rows.length - 1, 0]);
    scene.addNode(node);
    scene.ai = new AISystem();
    scene.ai.setScene(scene);
    return scene;
}

/** A 2D navmesh over the level, baked for `body`'s profile. */
function bakeFor(scene: Scene, rows: string[], body: CharacterBody2DNode, name = 'Nav'): NavMeshNode {
    const nav = new NavMeshNode(name);
    nav.space = '2D';
    const w = rows[0].length, h = rows.length;
    nav.setPosition([w / 2, h / 2, 0]);
    nav.size = [w, h, 1];
    nav.agent2D = {
        movement: body.movement, width: body.size[0], height: body.size[1], walkSpeed: body.walkSpeed,
        acceleration: body.acceleration, airControl: body.airControl, jumpHeight: body.jumpHeight,
        jumpTimeToApex: body.jumpTimeToApex, fallGravityMultiplier: body.fallGravityMultiplier,
        maxFallSpeed: body.maxFallSpeed, stepHeight: body.stepHeight, maxDrop: 12, oneWayPlatforms: body.oneWayPlatforms,
    };
    scene.addNode(nav);
    scene.update(0, 0, false);
    const world = new World2D();
    world.refresh(scene);
    const { data } = bakeNavGraph2D(world.world, nav.bounds2D(), nav.agent2D);
    nav.setGraph2D(data, navGraph2DSourceHash(world.world, nav.bounds2D(), nav.agent2D));
    return nav;
}

function guard(scene: Scene, x: number, y: number, o: Partial<CharacterBody2DNode> = {}) {
    const b = new CharacterBody2DNode('Guard');
    b.setPosition([x, y, 0]);
    b.walkSpeed = 5;
    b.jumpHeight = 3.4;
    b.jumpTimeToApex = 0.4;
    Object.assign(b, o);
    scene.addNode(b);
    return b;
}
function brain(pawn: CharacterBody2DNode, o: Partial<ControllerNode> = {}) {
    const c = new ControllerNode('AI');
    c.controlSource = 'ai';
    c.aimSource = 'world';
    c.driveAimTarget = false;
    c.autoAcquire = false;
    Object.assign(c, o);
    pawn.addChild(c);
    c.possess(pawn);
    return c;
}
const run = (scene: Scene, seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { each?.(); scene.update(1 / 60, 0, false); }
};

describe('a controller pathing a 2D body', () => {
    it('climbs a staircase of platforms by jumping', () => {
        const scene = level(STAIRS);
        const g = guard(scene, 2, 0.1);
        bakeFor(scene, STAIRS, g);
        const c = brain(g, { goal: 'path', targetKey: 'point', goalPoint: [18, 6, 0] });
        scene.start();
        let jumps = 0, planned = false;
        run(scene, 10, () => { if (g.justJumped) jumps++; planned ||= c.path.actions.includes('jump'); });
        expect(jumps).toBeGreaterThanOrEqual(2);
        expect(g.position[1]).toBeCloseTo(6, 2);
        expect(Math.abs(g.position[0] - 18)).toBeLessThan(1);
        expect(planned).toBe(true);
    });

    it('patrols a route whose points stand on different platforms', () => {
        const scene = level(STAIRS);
        const g = guard(scene, 2, 0.1);
        const nav = bakeFor(scene, STAIRS, g);
        nav.routes = [{ name: 'Watch', points: [[3, 0, 0], [11, 3, 0]], loop: true } as any];
        brain(g, { goal: 'patrol', routeName: 'Watch' });
        scene.start();
        let onPlatform = 0, backDown = false;
        run(scene, 16, () => {
            if (g.isGrounded && Math.abs(g.position[1] - 3) < 0.05) onPlatform++;
            if (onPlatform > 0 && g.isGrounded && Math.abs(g.position[1]) < 0.05 && g.position[0] < 4) backDown = true;
        });
        expect(onPlatform).toBeGreaterThan(0);
        expect(backDown).toBe(true);
    });

    it('investigates where its target was last seen through the graph', () => {
        const scene = level(STAIRS);
        const g = guard(scene, 2, 0.1);
        bakeFor(scene, STAIRS, g);
        const prey = new CharacterBody2DNode('Prey');
        prey.movement = 'fly';
        prey.setPosition([11, 3.1, 0]);
        scene.addNode(prey);
        const c = brain(g, { goal: 'investigate', autoAcquire: true, perception: { fieldOfView: 360, range: 30, memorySpan: 30, reactionTime: 0 } });
        scene.start();
        run(scene, 0.3);
        // Seen, then gone: the guard goes to where it was, up on the platform.
        prey.setPosition([40, 40, 0]);
        run(scene, 8);
        expect(c.lastKnownPosition).not.toBeNull();
        expect(g.position[1]).toBeCloseTo(3, 2);
    });

    it('seeks in a straight line with nothing baked', () => {
        const scene = level(STAIRS);
        const g = guard(scene, 2, 0.1);
        brain(g, { goal: 'path', targetKey: 'point', goalPoint: [20, 0, 0] });
        scene.start();
        run(scene, 4);
        expect(g.position[0]).toBeGreaterThan(18);
    });

    it('takes the graph that fits how it moves: a flier the air grid, a walker the platforms', () => {
        const scene = level(STAIRS);
        const walker = guard(scene, 2, 0.1);
        const bat = guard(scene, 3, 3, { movement: 'fly', size: [0.8, 0.8], oneWayPlatforms: false });
        bat.name = 'Bat';
        const walkNav = bakeFor(scene, STAIRS, walker, 'Walk Nav');
        const flyNav = bakeFor(scene, STAIRS, bat, 'Fly Nav');
        expect(walkNav.movement2D).toBe('walk');
        expect(flyNav.movement2D).toBe('fly');
        const c = brain(bat, { goal: 'path', targetKey: 'point', goalPoint: [18, 9, 0] });
        brain(walker, { goal: 'idle' });
        scene.start();
        run(scene, 6);
        expect(c.path.actions.every(a => a === 'fly')).toBe(true);
        expect(Math.hypot(bat.position[0] - 18, bat.position[1] + 0.4 - 9)).toBeLessThan(1);
    });

    it('stores a 2D bake on its navmesh node, and loads it back', () => {
        const scene = level(STAIRS);
        const g = guard(scene, 2, 0.1);
        const nav = bakeFor(scene, STAIRS, g);
        const json = { ...(nav as any)._serializePayload(), type: 'navMesh', name: 'Nav', id: 'n1', position: [13, 5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [] };
        expect(json.space).toBe('2D');
        expect(json.graph2D).toBeTruthy();
        const back = new Scene();
        parseNodeJson(back.root, JSON.parse(JSON.stringify(json)));
        const loaded = back.getNodeById('n1') as NavMeshNode;
        expect(loaded.space).toBe('2D');
        expect(loaded.isBaked).toBe(true);
        expect(loaded.mesh).toBeNull();
        expect(loaded.graph2D!.nodeCount).toBe(nav.graph2D!.nodeCount);
        expect(loaded.agent2D.jumpHeight).toBe(3.4);
        // A 3D navmesh writes none of it.
        const plain = new NavMeshNode('3D');
        expect((plain as any)._serializePayload().space).toBeUndefined();
    });
});
