import { describe, it, expect } from 'vitest';
import {
    CleoNavMesh, EMPTY_NAV_MESH_DATA, buildNavMesh, isNavigableUp, parseNavMeshData,
    polygonsFromData, serializeNavMeshData,
} from '../src/ai/navMesh';
import type { NavMeshData } from '../src/ai/navMesh';
import { vec3 } from 'gl-matrix';

// Every assertion here is pinning a Yuka behaviour the wrapper exists to hide. Three of them are
// traps that fail SILENTLY and were found by running the library rather than by reading it:
//
//   - findPath returns references INTO the navmesh, so a caller that adjusts a waypoint deforms the
//     mesh for every query afterwards;
//   - clampMovement leaves its out-param untouched unless it actually clamps, so a fresh scratch
//     vector reads as garbage on the (overwhelmingly common) frames where the move stays inside;
//   - the epsilon for the containment test defaults to ONE WORLD UNIT.
//
// The round-trip test is the load-bearing one for the whole design: it is what says a scene may store
// merged contours and replay them with the merge switched off.

/** A unit quad on the XZ plane at (x, z), wound so Yuka reads it as walkable. */
function quadData(cells: [number, number][]): NavMeshData {
    const vertices = new Float32Array(cells.length * 4 * 3);
    const counts = new Uint32Array(cells.length);
    let v = 0;
    for (let i = 0; i < cells.length; i++) {
        const [x, z] = cells[i];
        counts[i] = 4;
        for (const [px, pz] of [[x, z], [x, z + 1], [x + 1, z + 1], [x + 1, z]]) {
            vertices[v++] = px;
            vertices[v++] = 0;
            vertices[v++] = pz;
        }
    }
    return { vertices, counts };
}

/** The L: a three-cell bottom row plus a two-cell arm going up in +Z. */
const L_SHAPE: [number, number][] = [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]];

describe('CleoNavMesh', () => {
    it('builds from region contours and reports its graph', () => {
        const mesh = buildNavMesh(quadData(L_SHAPE), { merge: true });
        expect(mesh).not.toBeNull();
        expect(mesh!.regionCount).toBeGreaterThan(0);
    });

    it('returns null rather than throwing for empty or degenerate data', () => {
        expect(buildNavMesh(EMPTY_NAV_MESH_DATA)).toBeNull();
        // A count of 2 is not a polygon.
        expect(buildNavMesh({ vertices: new Float32Array(6), counts: new Uint32Array([2]) })).toBeNull();
    });

    it('funnels a path around the inside corner of an L', () => {
        const mesh = buildNavMesh(quadData(L_SHAPE), { merge: true })!;
        const path = mesh.findPath([2.5, 0, 0.5], [0.5, 0, 2.5]);

        // Three points, not two: the middle one is the corner the funnel had to find. A straight line
        // between the endpoints leaves the mesh entirely.
        expect(path).toHaveLength(3);
        expect(path[1][0]).toBeCloseTo(1, 5);
        expect(path[1][2]).toBeCloseTo(1, 5);
    });

    // THE load-bearing test for the storage design: bake once with the merge on, store the merged
    // contours, replay with the merge off, and get an identical mesh. Measured 200x cheaper on load.
    it('round-trips merged contours exactly, with the merge switched off', () => {
        const baked = buildNavMesh(quadData(L_SHAPE), { merge: true })!;
        const replayed = buildNavMesh(baked.toData(), { merge: false })!;

        expect(replayed.regionCount).toBe(baked.regionCount);
        expect(replayed.nodeCount).toBe(baked.nodeCount);
        expect(replayed.edgeCount).toBe(baked.edgeCount);

        const a = baked.findPath([2.5, 0, 0.5], [0.5, 0, 2.5]);
        const b = replayed.findPath([2.5, 0, 0.5], [0.5, 0, 2.5]);
        expect(b).toHaveLength(a.length);
        for (let i = 0; i < a.length; i++) {
            expect(b[i][0]).toBeCloseTo(a[i][0], 5);
            expect(b[i][2]).toBeCloseTo(a[i][2], 5);
        }
    });

    it('clones waypoints, so a caller cannot deform the mesh through one', () => {
        const mesh = buildNavMesh(quadData(L_SHAPE), { merge: true })!;
        const path = mesh.findPath([2.5, 0, 0.5], [0.5, 0, 2.5]);
        path[1][0] = 999;

        const again = mesh.findPath([2.5, 0, 0.5], [0.5, 0, 2.5]);
        expect(again[1][0]).toBeCloseTo(1, 5);
    });

    it('returns an empty path for an unreachable destination rather than throwing', () => {
        // Two islands with nothing between them.
        const mesh = buildNavMesh(quadData([[0, 0], [5, 0]]), { merge: true })!;
        expect(mesh.findPath([0.5, 0, 0.5], [5.5, 0, 0.5])).toHaveLength(0);
    });

    describe('clampMovement', () => {
        it('slides a move that leaves the mesh back onto the border', () => {
            const mesh = buildNavMesh(quadData([[0, 0], [1, 0], [2, 0]]), { merge: true })!;
            const out = vec3.create();
            expect(mesh.clampMovement([1.5, 0, 0.5], [1.5, 0, 2], out)).toBe(true);
            expect(out[2]).toBeCloseTo(1, 5);
        });

        // The trap: Yuka writes the out-param ONLY when it clamps. The wrapper pre-seeds it, so an
        // interior move reads back as itself instead of as whatever was in the vector before.
        it('writes the destination unchanged when the move stays inside', () => {
            const mesh = buildNavMesh(quadData([[0, 0], [1, 0], [2, 0]]), { merge: true })!;
            const out = vec3.fromValues(-99, -99, -99);
            mesh.clampMovement([0.5, 0, 0.5], [0.6, 0, 0.6], out);
            expect(out[0]).toBeCloseTo(0.6, 5);
            expect(out[2]).toBeCloseTo(0.6, 5);
        });
    });

    it('answers containment against a tight epsilon, not Yuka default of one world unit', () => {
        const mesh = buildNavMesh(quadData([[0, 0]]), { merge: true })!;
        expect(mesh.contains([0.5, 0, 0.5])).toBe(true);
        // Half a unit outside. Yuka's own default would call this contained.
        expect(mesh.contains([1.5, 0, 0.5])).toBe(false);
    });

    it('finds a random point on the mesh', () => {
        const mesh = buildNavMesh(quadData(L_SHAPE), { merge: true })!;
        const out = vec3.create();
        expect(mesh.randomPoint(out)).toBe(true);
        expect(mesh.contains(out)).toBe(true);
    });
});

describe('polygonsFromData', () => {
    it('stops at a count that runs off the end instead of reading zeros', () => {
        // Claims two regions of four vertices; only enough data for one.
        const data: NavMeshData = { vertices: quadData([[0, 0]]).vertices, counts: new Uint32Array([4, 4]) };
        expect(polygonsFromData(data)).toHaveLength(1);
    });

    it('skips a region with fewer than three vertices', () => {
        expect(polygonsFromData({ vertices: new Float32Array(9), counts: new Uint32Array([2]) })).toHaveLength(0);
    });
});

describe('navmesh serialization', () => {
    it('round-trips through base64', () => {
        const original = buildNavMesh(quadData(L_SHAPE), { merge: true })!.toData();
        const json = serializeNavMeshData(original);
        expect(json).not.toBeNull();

        const parsed = parseNavMeshData(json);
        expect(Array.from(parsed.counts)).toEqual(Array.from(original.counts));
        expect(parsed.vertices.length).toBe(original.vertices.length);
        for (let i = 0; i < original.vertices.length; i++) {
            expect(parsed.vertices[i]).toBeCloseTo(original.vertices[i], 5);
        }
        // And the parsed data still builds the same mesh.
        expect(buildNavMesh(parsed, { merge: false })!.regionCount).toBe(original.counts.length);
    });

    it('serializes nothing for an unbaked mesh', () => {
        expect(serializeNavMeshData(EMPTY_NAV_MESH_DATA)).toBeNull();
    });

    it('reads junk as an empty mesh rather than throwing', () => {
        for (const junk of [null, undefined, 42, 'nope', {}, { vertices: 1, counts: 2 }, { vertices: '%%%', counts: '%%%' }]) {
            expect(parseNavMeshData(junk).counts.length).toBe(0);
        }
    });

    it('refuses a blob truncated mid-element', () => {
        const json = serializeNavMeshData(buildNavMesh(quadData([[0, 0]]), { merge: true })!.toData())!;
        // Base64 packs 4 characters into 3 bytes, so 8 characters decode to 6 -- one and a half
        // floats. (6 characters would decode to exactly 4 and legitimately pass.)
        expect(parseNavMeshData({ vertices: json.vertices.slice(0, 8), counts: json.counts }).counts.length).toBe(0);
    });
});

describe('isNavigableUp', () => {
    it('accepts +Y and near-+Y', () => {
        expect(isNavigableUp([0, 1, 0])).toBe(true);
        expect(isNavigableUp([0.05, 0.998, 0])).toBe(true);
    });

    it('refuses sideways and inverted gravity, which Yuka XZ-planar math cannot represent', () => {
        expect(isNavigableUp([1, 0, 0])).toBe(false);
        expect(isNavigableUp([0, -1, 0])).toBe(false);
    });

    // Scene.physics is genuinely undefined on any scene never handed to setScene -- every template and
    // preview-tab scene. "No physics yet" must not read as "refuse to bake".
    it('passes when there is no physics or no gravity at all', () => {
        expect(isNavigableUp(null)).toBe(true);
        expect(isNavigableUp(undefined)).toBe(true);
        expect(isNavigableUp([0, 0, 0])).toBe(true);
    });
});
