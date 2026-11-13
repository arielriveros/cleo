import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vec3 } from 'gl-matrix';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { CharacterBody2DNode } from '../src/core/scene/nodes/characterBody2DNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { TilemapNode } from '../src/core/scene/nodes/tilemapNode';
import { Tilemap } from '../src/graphics/tilemap/tilemap';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { Perception } from '../src/ai/perception';
import { angleToTarget2D, facingYaw2D, paceDirection, probeLedge2D, probeWall2D } from '../src/core/control/control2D';
import { steeringTuning } from '../src/core/control/steering';

// The AI drives a 2D body as it drives a 3D Character: perception across the picture plane (a cone that
// opens the way the body faces, line of sight through the 2D world), steering along X for a walker and in
// XY for a flier, the senses measured side-on, and the walker's own obstacles -- a wall it jumps, a drop
// it stops at.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

/**
 * A level from ASCII rows, top row first, each cell 1 unit; the bottom row's top is y = 0, x = 0 at the left
 * edge. # solid, = one-way.
 */
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
    // Row r spans y in [rows - r - 1, rows - r] once the map sits at y = rows - 1.
    node.setPosition([0, rows.length - 1, 0]);
    scene.addNode(node);
    return scene;
}

function body(scene: Scene, name: string, x: number, y: number, o: Partial<CharacterBody2DNode> = {}) {
    const b = new CharacterBody2DNode(name);
    b.setPosition([x, y, 0]);
    Object.assign(b, o);
    scene.addNode(b);
    return b;
}

function brain(pawn: CharacterBody2DNode, o: Partial<ControllerNode> = {}) {
    const c = new ControllerNode('AI');
    c.controlSource = 'ai';
    c.aimSource = 'world';
    c.driveAimTarget = false;
    Object.assign(c, o);
    pawn.addChild(c);
    c.possess(pawn);
    return c;
}

const run = (scene: Scene, seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { each?.(); scene.update(1 / 60, 0, false); }
};

const FLAT = [
    '                              ',
    '                              ',
    '                              ',
    '                              ',
    '                              ',
    '                              ',
    '                              ',
    '##############################',
];

describe('2D control helpers', () => {
    it('turns a facing into a cone yaw, and measures angles in the picture plane', () => {
        expect(facingYaw2D(1)).toBe(90);
        expect(facingYaw2D(-1)).toBe(-90);
        expect(angleToTarget2D(3, 0, 1)).toBe(0);
        expect(angleToTarget2D(-3, 0, -1)).toBe(0);
        expect(angleToTarget2D(0, 2, 1)).toBeCloseTo(90, 6);
        expect(Math.abs(angleToTarget2D(-3, 0, 1))).toBeCloseTo(180, 6);
        expect(angleToTarget2D(2, 2, -1)).toBeCloseTo(135, 6);
    });

    it('finds walls and ledges ahead, and paces between them', () => {
        const ray = (x: number, y: number, dx: number, _dy: number, max: number) =>
            (dx > 0 && x < 5 && y < 3 && 5 - x <= max ? { distance: 5 - x, normal: [-1, 0] as const } : null);
        expect(probeWall2D(ray, 4.6, 0, 1, 0.4, 1.8, 0.5)).toBe(true);
        expect(probeWall2D(ray, 2, 0, 1, 0.4, 1.8, 0.5)).toBe(false);
        const ground = (x: number) => (x < 6 ? 0 : -Infinity);
        expect(probeLedge2D(ground, 5.5, 0, 1, 0.4, 0.2, 0.8)).toBe(true);
        expect(probeLedge2D(ground, 3, 0, 1, 0.4, 0.2, 0.8)).toBe(false);
        expect(paceDirection(1, true, false)).toBe(-1);
        expect(paceDirection(-1, false, false)).toBe(-1);
    });
});

describe('perception across the picture plane', () => {
    const tuning = { fieldOfView: 120, range: 20, memorySpan: 5, reactionTime: 0 };
    const see = (yaw: number, target: [number, number], fov = 120) => {
        const p = new Perception();
        p.step([0, 0, 0], yaw, [{ id: 't', position: [target[0], target[1], 0] }], { ...tuning, fieldOfView: fov }, 1 / 60, null, 'xy');
        return p.sightingOf('t')!;
    };

    it('opens its cone the way the body faces', () => {
        expect(see(90, [5, 1]).visible).toBe(true);
        expect(see(90, [-5, 1]).visible).toBe(false);
        expect(see(-90, [-5, 1]).visible).toBe(true);
    });

    it('sees straight up only with a field of view wide enough to reach it', () => {
        expect(see(90, [0, 5]).visible).toBe(false);
        expect(see(90, [0, 5], 200).visible).toBe(true);
    });

    it('remembers where it last saw something in the scene\'s own XY', () => {
        const s = see(90, [4, 2]);
        expect([...s.lastKnownPosition]).toEqual([4, 2, 0]);
    });
});

describe('an AI controller driving a 2D body', () => {
    it('seeks along X only as a walker, staying on its floor under a target above', () => {
        const scene = level(FLAT);
        const guard = body(scene, 'Guard', 2, 0.1);
        const prey = body(scene, 'Prey', 12, 4.5, { movement: 'fly' });
        const c = brain(guard, { goal: 'seek', autoAcquire: false });
        scene.start();
        c.setBlackboard('target', prey.id);
        run(scene, 1.2);
        expect(guard.position[0]).toBeGreaterThan(7);
        expect(guard.position[1]).toBeCloseTo(0, 4);
        expect(guard.intent.move[1]).toBe(0);
        expect(guard.facing).toBe(1);
    });

    it('flies at a target in XY as a flier, and flees it', () => {
        const scene = level(FLAT);
        const bat = body(scene, 'Bat', 2, 3, { movement: 'fly', size: [1, 1] });
        const prey = body(scene, 'Prey', 10, 4, { movement: 'fly', size: [1, 1] });
        const c = brain(bat, { goal: 'arrive', autoAcquire: false });
        scene.start();
        c.setBlackboard('target', prey.id);
        run(scene, 3);
        expect(Math.hypot(bat.position[0] - prey.position[0], bat.position[1] - prey.position[1])).toBeLessThan(0.6);
        c.goal = 'flee';
        run(scene, 1);
        expect(bat.position[0]).toBeLessThan(prey.position[0] - 2);
    });

    it('paces on wander: turns at a wall and at a drop, and one-way planks are floor', () => {
        const scene = level([
            '                    ',
            '                    ',
            '                    ',
            '   #   =====        ',
            '   #####=   ##      ',
            '###########################',
        ]);
        // Standing on the raised floor between the wall (x 3) and the drop past x 8, the plank (x 7..11) at y 1..2.
        const guard = body(scene, 'Guard', 5.5, 1.1);
        brain(guard, { goal: 'wander', steering: steeringTuning({ maxSpeed: 3 }) });
        scene.start();
        let minX = Infinity, maxX = -Infinity;
        run(scene, 8, () => { minX = Math.min(minX, guard.position[0]); maxX = Math.max(maxX, guard.position[0]); });
        expect(guard.position[1]).toBeGreaterThan(0.9);
        expect(minX).toBeGreaterThan(4);
        expect(maxX).toBeLessThan(13);
        expect(maxX - minX).toBeGreaterThan(3);
    });

    it('jumps a wall lower than its jump height in its way, and stops at a taller one', () => {
        const low = level([
            '                              ',
            '                              ',
            '                              ',
            '                              ',
            '          #                   ',
            '          #                   ',
            '##############################',
        ]);
        const guard = body(low, 'Guard', 4, 0.1);
        const prey = body(low, 'Prey', 18, 0.1);
        const c = brain(guard, { goal: 'seek', autoAcquire: false, steering: steeringTuning({ avoidDistance: 0.8 }) });
        low.start();
        c.setBlackboard('target', prey.id);
        run(low, 3);
        expect(guard.position[0]).toBeGreaterThan(12);

        const tall = level([
            '          #                   ',
            '          #                   ',
            '          #                   ',
            '          #                   ',
            '          #                   ',
            '          #                   ',
            '##############################',
        ]);
        const stuck = body(tall, 'Guard', 4, 0.1);
        const away = body(tall, 'Prey', 18, 0.1);
        const b = brain(stuck, { goal: 'seek', autoAcquire: false, steering: steeringTuning({ avoidDistance: 0.8 }) });
        tall.start();
        b.setBlackboard('target', away.id);
        run(tall, 3);
        expect(stuck.position[0]).toBeLessThan(10);
        expect(stuck.position[1]).toBeCloseTo(0, 3);
    });

    it('stops at a drop ahead, unless its target is below it', () => {
        const scene = level([
            '                         ',
            '                         ',
            '########                 ',
            '########                 ',
            '#########################',
        ]);
        const guard = body(scene, 'Guard', 2, 2.1);
        const prey = body(scene, 'Prey', 14, 2.1, { movement: 'fly' });
        const c = brain(guard, { goal: 'seek', autoAcquire: false, steering: steeringTuning({ avoidDistance: 0.6 }) });
        scene.start();
        c.setBlackboard('target', prey.id);
        run(scene, 2);
        expect(guard.position[0]).toBeLessThan(8);
        expect(guard.position[1]).toBeCloseTo(2, 3);
        prey.setPosition([14, 0.5, 0]);
        run(scene, 2);
        expect(guard.position[1]).toBeLessThan(0.5);
        expect(guard.position[0]).toBeGreaterThan(9);
    });

    it('sees the player in front, through a one-way plank but not through rock, and only on its layers', () => {
        const scene = level([
            '                              ',
            '                              ',
            '       =====                  ',
            '                    #         ',
            '                    #         ',
            '##############################',
        ]);
        const guard = body(scene, 'Guard', 5, 0.1, { layer: 2 });
        const player = body(scene, 'Player', 9, 4.1, { layer: 1, movement: 'fly' });
        const bat = body(scene, 'Bat', 7, 0.1, { layer: 2 });
        const c = brain(guard, { perceptionLayers: 1, perception: { fieldOfView: 170, range: 20, memorySpan: 5, reactionTime: 0 } });
        scene.start();
        run(scene, 0.2);
        // Above the plank, in front: seen through it.
        expect(c.sightings ? [...c.sightings].map(s => s.id) : []).not.toContain(bat.id);
        expect(c.getBlackboard('target')).toBe(player.id);
        // Behind the rock: not seen, but remembered where it was.
        player.setPosition([24, 0.1, 0]);
        run(scene, 0.2);
        const seen = [...c.sightings].find(s => s.id === player.id)!;
        expect(seen.visible).toBe(false);
        // Behind its back: not seen.
        player.setPosition([1, 0.1, 0]);
        run(scene, 0.2);
        expect([...c.sightings].find(s => s.id === player.id)!.visible).toBe(false);
        guard.facing = -1;
        run(scene, 0.05);
        expect([...c.sightings].find(s => s.id === player.id)!.visible).toBe(true);
    });

    it('measures its senses side-on', () => {
        const scene = level(FLAT);
        const guard = body(scene, 'Guard', 5, 0.1);
        const player = body(scene, 'Player', 8, 4, { movement: 'fly' });
        const c = brain(guard, { goal: 'idle', autoAcquire: false });
        scene.start();
        c.setBlackboard('target', player.id);
        run(scene, 0.5);
        const sense = (name: string) => (c as any)._sense(name, guard);
        expect(sense('planarDistanceToTarget')).toBeCloseTo(3, 3);
        expect(sense('heightToTarget')).toBeCloseTo(player.position[1] - guard.position[1], 3);
        expect(sense('distanceToTarget')).toBeCloseTo(Math.hypot(3, player.position[1] - guard.position[1]), 3);
        expect(sense('targetInFront')).toBe(true);
        expect(sense('angleToTarget')).toBeGreaterThan(0);
        guard.facing = -1;
        expect(sense('targetInFront')).toBe(false);
        expect(sense('wallAhead')).toBe(false);
        expect(sense('ledgeAhead')).toBe(false);
        guard.teleport(0.45, 0);
        run(scene, 0.1);
        expect(sense('ledgeAhead')).toBe(true);
    });

    it('counts its 2D flock', () => {
        const scene = level(FLAT);
        const a = body(scene, 'A', 5, 3, { movement: 'fly' });
        body(scene, 'B', 6, 3, { movement: 'fly' });
        body(scene, 'C', 20, 3, { movement: 'fly' });
        const c = brain(a, { flockRadius: 3 });
        scene.start();
        run(scene, 0.05);
        expect(c.neighborCount).toBe(1);
        expect(vec3.length(vec3.fromValues(0, 0, 0))).toBe(0);
    });
});
