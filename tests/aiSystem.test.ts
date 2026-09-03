import { describe, it, expect, beforeEach } from 'vitest';
import { vec3 } from 'gl-matrix';
import { AISystem } from '../src/ai/aiSystem';
import type { AISceneLike, NavMeshSource } from '../src/ai/aiSystem';
import { aiStats, resetAIStats } from '../src/ai/aiStats';
import { bakeNavMesh } from '../src/ai/navBake';
import { buildNavMesh } from '../src/ai/navMesh';
import type { CleoNavMesh } from '../src/ai/navMesh';

// AISystem is unit-testable precisely because it imports nothing but gl-matrix and types -- unlike
// PhysicsSystem, which reaches the cleo barrel and therefore cannot be tested at all (which is why
// cameraRayFilter.ts had to be split out of it). These four-line fakes are the payoff, and keeping
// them possible is a reason not to import Scene or NavMeshNode here for real.

function quad(x0: number, z0: number, x1: number, z1: number): number[] {
    return [x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0];
}

function mesh(): CleoNavMesh {
    const baked = bakeNavMesh({
        positions: new Float32Array([...quad(0, 0, 3, 1), ...quad(0, 1, 1, 3)]),
        indices: new Uint32Array(0),
    });
    return buildNavMesh(baked.data, { merge: false })!;
}

/** Two islands with nothing between them -- the only way to get a genuinely unreachable destination. */
function islands(): CleoNavMesh {
    const baked = bakeNavMesh({
        positions: new Float32Array([...quad(0, 0, 2, 2), ...quad(20, 0, 22, 2)]),
        indices: new Uint32Array(0),
    });
    return buildNavMesh(baked.data, { merge: false })!;
}

function source(id: string, over: Partial<NavMeshSource> = {}): NavMeshSource {
    return {
        id,
        name: id,
        mesh: mesh(),
        isBaked: true,
        agentRadius: 0.4,
        routePoints: () => [],
        ...over,
    };
}

function scene(...meshes: NavMeshSource[]): AISceneLike {
    return { navMeshes: new Set(meshes), getNodeById: () => undefined };
}

describe('AISystem', () => {
    beforeEach(resetAIStats);

    it('answers nothing before it is bound to a scene', () => {
        const ai = new AISystem();
        expect(ai.scene).toBeNull();
        expect(ai.navMeshFor(null)).toBeNull();
        expect(ai.hasNavigation).toBe(false);
    });

    // The reason binding goes through a method at all. The editor calls setScene on every tab switch,
    // and per-scene state riding along into the next scene is the bug this prevents.
    it('clears whatever the previous scene left when it is rebound', () => {
        const ai = new AISystem();
        ai.setScene(scene(source('a')));
        expect(ai.hasNavigation).toBe(true);

        ai.setScene(null);
        expect(ai.scene).toBeNull();
        expect(ai.hasNavigation).toBe(false);
    });

    describe('navMeshFor', () => {
        it('falls back to the first baked mesh, so a single-navmesh scene needs no wiring', () => {
            const ai = new AISystem();
            ai.setScene(scene(source('only')));
            expect(ai.navMeshFor(null)!.id).toBe('only');
            expect(ai.navMeshFor('')!.id).toBe('only');
        });

        it('honours a named mesh', () => {
            const ai = new AISystem();
            ai.setScene(scene(source('small'), source('large')));
            expect(ai.navMeshFor('large')!.id).toBe('large');
        });

        // An author who picked a specific mesh and silently got a different one has no way to tell.
        // The dangling case is what falls back -- and the controller warns about that, once.
        it('returns a named mesh even when it is unbaked, but falls back for a dangling id', () => {
            const ai = new AISystem();
            const unbaked = source('empty', { mesh: null, isBaked: false });
            ai.setScene(scene(unbaked, source('baked')));

            expect(ai.navMeshFor('empty')!.id).toBe('empty');
            expect(ai.navMeshFor('gone')!.id).toBe('baked');
        });

        it('skips unbaked meshes when choosing a default', () => {
            const ai = new AISystem();
            ai.setScene(scene(source('empty', { mesh: null, isBaked: false }), source('baked')));
            expect(ai.navMeshFor(null)!.id).toBe('baked');
        });

        it('reports no navigation when nothing is baked', () => {
            const ai = new AISystem();
            ai.setScene(scene(source('empty', { mesh: null, isBaked: false })));
            expect(ai.hasNavigation).toBe(false);
            expect(ai.navMeshFor(null)).toBeNull();
        });
    });

    describe('findPath', () => {
        it('routes around a corner and counts the query', () => {
            const ai = new AISystem();
            ai.setScene(scene(source('nav')));

            const out = ai.findPath(ai.navMeshFor(null), vec3.fromValues(2.5, 0, 0.5), vec3.fromValues(0.5, 0, 2.5));
            expect(out.length).toBeGreaterThan(0);
            expect(aiStats.pathQueries).toBe(1);
            expect(aiStats.pathsFound).toBe(1);
            expect(aiStats.waypoints).toBe(out.length);
        });

        // Worth knowing before relying on it: Yuka does NOT fail for a destination off the mesh. It
        // resolves the closest region and routes there, so "walk to that point in the air" reads as
        // "walk to the nearest ground under it". Usually what you want, never what you assumed.
        it('routes to the nearest region for a destination off the mesh', () => {
            const ai = new AISystem();
            ai.setScene(scene(source('nav')));
            const out = ai.findPath(ai.navMeshFor(null), vec3.fromValues(2.5, 0, 0.5), vec3.fromValues(99, 0, 99));
            expect(out.length).toBeGreaterThan(0);
        });

        // A query that finds nothing still counts as a query -- that is the whole point of the
        // counter. An agent hammering an unreachable destination looks free otherwise.
        it('counts a miss as a query but not as a find', () => {
            const ai = new AISystem();
            ai.setScene(scene(source('nav', { mesh: islands() })));

            const out = ai.findPath(ai.navMeshFor(null), vec3.fromValues(1, 0, 1), vec3.fromValues(21, 0, 1));
            expect(out).toHaveLength(0);
            expect(aiStats.pathQueries).toBe(1);
            expect(aiStats.pathsFound).toBe(0);
        });

        it('is a no-op with no mesh, and counts nothing', () => {
            const ai = new AISystem();
            expect(ai.findPath(null, vec3.create(), vec3.create())).toHaveLength(0);
            expect(aiStats.pathQueries).toBe(0);
        });

        it('reuses the array it is given', () => {
            const ai = new AISystem();
            ai.setScene(scene(source('nav')));
            const out: vec3[] = [vec3.create(), vec3.create(), vec3.create()];
            ai.findPath(ai.navMeshFor(null), vec3.fromValues(2.5, 0, 0.5), vec3.fromValues(0.5, 0, 2.5), out);
            // Cleared and refilled, not appended to.
            expect(out.length).toBeGreaterThan(0);
            expect(out.length).toBeLessThan(4);
        });
    });

    it('resets its per-frame counters', () => {
        const ai = new AISystem();
        ai.setScene(scene(source('nav')));
        ai.findPath(ai.navMeshFor(null), vec3.fromValues(2.5, 0, 0.5), vec3.fromValues(0.5, 0, 2.5));
        expect(aiStats.pathQueries).toBe(1);

        resetAIStats();
        expect(aiStats.pathQueries).toBe(0);
        expect(aiStats.pathsFound).toBe(0);
        expect(aiStats.pathMs).toBe(0);
        expect(aiStats.waypoints).toBe(0);
        expect(aiStats.navAgents).toBe(0);
    });
});
