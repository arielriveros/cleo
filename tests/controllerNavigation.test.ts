import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene } from '../src/core/scene/scene';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { NavMeshNode } from '../src/core/scene/nodes/navMeshNode';
import { AISystem } from '../src/ai/aiSystem';
import { aiStats, resetAIStats } from '../src/ai/aiStats';
import { bakeNavMesh } from '../src/ai/navBake';
import { moveWorldDirection } from '../src/core/control/intent';
import { vec3 } from 'gl-matrix';

// The point of the whole navmesh milestone, asserted end to end: a controller told to reach something
// behind a wall walks AROUND it instead of into it. Everything below the seam is covered by the leaf
// suites, so what is tested here is the wiring -- goal resolution, the repath policy actually
// throttling, and the fallbacks that make turning navigation on safe on a scene nobody has baked.

let warnings: string[] = [];
let restore: (() => void) | null = null;

beforeEach(async () => {
    resetAIStats();
    warnings = [];
    const { Logger } = await import('../src/core/logger');
    const warn = Logger.warn;
    Logger.warn = ((message: unknown) => { warnings.push(String(message)); }) as typeof Logger.warn;
    restore = () => { Logger.warn = warn; };
});

afterEach(() => restore?.());

function quad(x0: number, z0: number, x1: number, z1: number): number[] {
    return [x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0];
}

/**
 * An L-shaped floor. Straight from the far end of the bottom arm to the top of the upright passes
 * through the missing quadrant, so a straight-line seek walks into nothing and only a route works.
 */
const L_FLOOR = [...quad(0, 0, 6, 2), ...quad(0, 2, 2, 6)];

interface World {
    scene: Scene;
    character: CharacterNode;
    controller: ControllerNode;
    navMesh: NavMeshNode;
    ai: AISystem;
}

function world(opts: { baked?: boolean } = {}): World {
    const scene = new Scene();
    const character = new CharacterNode('pawn');
    const controller = new ControllerNode('brain');
    const navMesh = new NavMeshNode('navigation');

    if (opts.baked !== false) {
        navMesh.setData(bakeNavMesh({
            positions: new Float32Array(L_FLOOR),
            indices: new Uint32Array(0),
        }).data);
    }

    scene.addNode(character);
    scene.addNode(controller);
    scene.addNode(navMesh);
    controller.possess(character);
    controller.controlSource = 'ai';

    const ai = new AISystem();
    ai.setScene(scene as never);
    scene.ai = ai;

    scene.start();
    return { scene, character, controller, navMesh, ai };
}

/** Where the controller is asking the pawn to walk, in world space. */
function desiredDirection(character: CharacterNode): vec3 {
    return moveWorldDirection(vec3.create(), character.intent);
}

/** Put the pawn at the far end of the bottom arm and aim it at the top of the upright. */
function acrossTheCorner(w: World): void {
    w.character.setPosition([5, 0, 1]);
    w.controller.goal = 'path';
    w.controller.goalPoint = [1, 0, 5];
    w.controller.targetKey = 'point';
    w.scene.update(1 / 60, 0, false);
}

describe('a controller on a path goal', () => {
    it('steers along the corridor rather than straight at the destination', () => {
        const w = world();
        acrossTheCorner(w);

        const direction = desiredDirection(w.character);
        // The destination is up and to the left; the route has to go left along the arm FIRST.
        // A straight line would carry a positive Z component immediately.
        expect(direction[0]).toBeLessThan(0);
        expect(Math.abs(direction[0])).toBeGreaterThan(Math.abs(direction[2]));
    });

    it('counts exactly one path query for one agent on the frame it plans', () => {
        const w = world();
        acrossTheCorner(w);
        expect(aiStats.pathQueries).toBe(1);
        expect(aiStats.pathsFound).toBe(1);
        expect(aiStats.navAgents).toBe(1);
    });

    // The only thing standing between an agent and a graph search every frame.
    it('does not requery while the policy says the route is still good', () => {
        const w = world();
        w.controller.repath = { interval: 10, targetDrift: 100 };
        acrossTheCorner(w);
        expect(aiStats.pathQueries).toBe(1);

        resetAIStats();
        for (let i = 0; i < 30; i++) w.scene.update(1 / 60, 0, false);
        expect(aiStats.pathQueries).toBe(0);
    });

    it('replans when the destination drifts far enough', () => {
        const w = world();
        w.controller.repath = { interval: 100, targetDrift: 1 };
        acrossTheCorner(w);

        resetAIStats();
        w.controller.goalPoint = [1, 0, 1];
        w.scene.update(1 / 60, 0, false);
        expect(aiStats.pathQueries).toBe(1);
    });

    // Turning navigation on must never be a regression on a scene nobody has baked yet. Standing
    // still for a reason nothing explains is the failure mode this avoids.
    it('falls back to a straight line when nothing is baked', () => {
        const w = world({ baked: false });
        acrossTheCorner(w);

        const direction = desiredDirection(w.character);
        expect(vec3.length(direction)).toBeGreaterThan(0);
        // Straight at it: left AND up, rather than along the corridor first.
        expect(direction[0]).toBeLessThan(0);
        expect(direction[2]).toBeGreaterThan(0);
        expect(aiStats.pathQueries).toBe(0);
    });

    it('falls back to a straight line when the scene has no AI system at all', () => {
        const w = world();
        w.scene.ai = undefined;
        acrossTheCorner(w);
        expect(vec3.length(desiredDirection(w.character))).toBeGreaterThan(0);
    });

    it('warns once when its navmesh id names nothing, then paths on the default', () => {
        const w = world();
        w.controller.navMeshId = 'does-not-exist';
        acrossTheCorner(w);
        for (let i = 0; i < 5; i++) w.scene.update(1 / 60, 0, false);

        const dangling = warnings.filter(m => m.includes('does-not-exist'));
        expect(dangling).toHaveLength(1);
        // And it still went somewhere.
        expect(vec3.length(desiredDirection(w.character))).toBeGreaterThan(0);
    });

    it('reports how far there is left to walk', () => {
        const w = world();
        acrossTheCorner(w);
        // Round the corner, so further than the straight-line distance of ~5.7.
        expect(w.controller.pathRemaining).toBeGreaterThan(6);
    });
});

describe('a controller on a patrol goal', () => {
    function patrolling(): World {
        const w = world();
        w.navMesh.routes = [{ name: 'loop', points: [[1, 0, 1], [5, 0, 1], [1, 0, 5]], loop: true }];
        w.controller.goal = 'patrol';
        w.controller.routeName = 'loop';
        w.character.setPosition([1, 0, 1]);
        return w;
    }

    it('walks the authored route', () => {
        const w = patrolling();
        w.scene.update(1 / 60, 0, false);
        // Standing on the first point, so it should already be heading for the second (+X).
        expect(desiredDirection(w.character)[0]).toBeGreaterThan(0);
        expect(aiStats.navAgents).toBe(1);
    });

    it('needs no path query at all -- the route IS the path', () => {
        const w = patrolling();
        w.scene.update(1 / 60, 0, false);
        expect(aiStats.pathQueries).toBe(0);
    });

    it('loops back to the start after the last waypoint', () => {
        const w = patrolling();
        w.scene.update(1 / 60, 0, false);
        expect(w.controller.path.index).toBe(1);

        // Waypoints are consumed by ARRIVING at them, one at a time -- an agent cannot skip the middle
        // of its own route, so the walk has to be stepped rather than teleported to the end.
        w.character.setPosition([5, 0, 1]);
        w.scene.update(1 / 60, 0, false);
        expect(w.controller.path.index).toBe(2);

        // On the final waypoint. `advancePath` deliberately never consumes that one, so the wrap is
        // the patrol goal's own job.
        w.character.setPosition([1, 0, 5]);
        w.scene.update(1 / 60, 0, false);
        expect(w.controller.path.index).toBe(0);
    });

    it('holds still for a route that does not exist, rather than walking to the origin', () => {
        const w = patrolling();
        w.controller.routeName = 'missing';
        w.character.setPosition([5, 0, 1]);
        w.scene.update(1 / 60, 0, false);
        expect(vec3.length(desiredDirection(w.character))).toBe(0);
    });
});

describe('navigation persistence', () => {
    it('round-trips the navigation fields', async () => {
        const w = world();
        w.controller.navMeshId = w.navMesh.id;
        w.controller.routeName = 'loop';
        w.controller.repath = { interval: 2, targetDrift: 5 };
        w.controller.waypointRadius = 1.25;

        const json = await w.controller.serialize() as any;
        expect(json.navMeshId).toBe(w.navMesh.id);
        expect(json.routeName).toBe('loop');
        expect(json.repath).toEqual({ interval: 2, targetDrift: 5 });
        expect(json.waypointRadius).toBe(1.25);
    });

    it('reads a controller saved before navigation existed as one with the defaults', () => {
        const scene = new Scene();
        const controller = new ControllerNode('brain');
        scene.addNode(controller);
        // No navMeshId, no repath, no routeName -- the shape of every controller written before this.
        expect(controller.navMeshId).toBeNull();
        expect(controller.repath.interval).toBeGreaterThan(0);
        expect(controller.waypointRadius).toBeGreaterThan(0);
    });
});
