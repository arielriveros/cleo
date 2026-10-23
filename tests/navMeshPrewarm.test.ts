import { describe, it, expect, beforeEach } from 'vitest';
import {
    buildNavMeshShared, clearSharedNavMeshes, navBuildStats, navMeshDataKey,
} from '../src/ai/navMesh';
import type { NavMeshData } from '../src/ai/navMesh';
import { AISystem } from '../src/ai/aiSystem';
import type { AISceneLike, NavMeshSource } from '../src/ai/aiSystem';

// The Valley's first chase used to build a 45k-region navmesh on the frame the enemy noticed the player.
// These pin the two halves of the fix: a scene prewarms its meshes at start, and a rebuilt scene with the
// same bake (every editor Play re-serializes the scene) reuses the first build instead of paying again.

function grid(n: number, offset = 0): NavMeshData {
    const vertices = new Float32Array(n * n * 4 * 3);
    const counts = new Uint32Array(n * n);
    let v = 0, r = 0;
    for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
        counts[r++] = 4;
        for (const [px, pz] of [[x, z], [x, z + 1], [x + 1, z + 1], [x + 1, z]]) {
            vertices[v++] = px + offset; vertices[v++] = 0; vertices[v++] = pz;
        }
    }
    return { vertices, counts };
}

describe('navMeshDataKey', () => {
    it('is equal for equal content in different objects', () => {
        expect(navMeshDataKey(grid(4))).toBe(navMeshDataKey(grid(4)));
    });
    it('differs when one coordinate moves', () => {
        const a = grid(4), b = grid(4);
        b.vertices[7] += 0.001;
        expect(navMeshDataKey(a)).not.toBe(navMeshDataKey(b));
    });
    it('differs when the region split differs', () => {
        expect(navMeshDataKey(grid(4))).not.toBe(navMeshDataKey(grid(4, 1)));
    });
});

describe('buildNavMeshShared', () => {
    beforeEach(() => clearSharedNavMeshes());

    it('builds once per content and reuses it for a re-parsed copy', () => {
        const builds = navBuildStats.builds;
        const first = buildNavMeshShared(grid(6), { merge: false });
        const second = buildNavMeshShared(grid(6), { merge: false });
        expect(first).not.toBeNull();
        expect(second).toBe(first);
        expect(navBuildStats.builds).toBe(builds + 1);
    });

    it('keys on the build options too', () => {
        const a = buildNavMeshShared(grid(3), { merge: false });
        const b = buildNavMeshShared(grid(3), { merge: true });
        expect(a).not.toBe(b);
    });

    it('evicts the least recently used mesh past its limit', () => {
        const a = buildNavMeshShared(grid(2), { merge: false });
        buildNavMeshShared(grid(3), { merge: false });
        buildNavMeshShared(grid(4), { merge: false });
        expect(buildNavMeshShared(grid(2), { merge: false })).not.toBe(a);
    });
});

describe('AISystem.prewarm', () => {
    it('touches every baked mesh and skips unbaked ones', () => {
        const touched: string[] = [];
        const source = (id: string, baked: boolean): NavMeshSource => ({
            id, name: id, isBaked: baked, agentRadius: 0.4, routePoints: () => [],
            get mesh() { touched.push(id); return null; },
        });
        const scene: AISceneLike = {
            navMeshes: new Set([source('a', true), source('b', false), source('c', true)]),
            getNodeById: () => undefined,
        };
        const ai = new AISystem();
        ai.setScene(scene);
        ai.prewarm();
        expect(touched).toEqual(['a', 'c']);
    });

    it('is a no-op with no scene bound', () => {
        expect(new AISystem().prewarm()).toBe(0);
    });
});
