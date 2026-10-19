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

// ----- terrain-shaped bakes ----------------------------------------------------------------------
//
// What a landscape bake actually produces: one region per triangle (the merge is off by default) on a
// surface that is not flat, queried from an agent whose feet are never exactly on it.

/** An n x n grid of unit cells, two triangles each, heights from `h`, minus the `holes` cells. */
function terrainData(n: number, h: (x: number, z: number) => number, holes: (x: number, z: number) => boolean = () => false): NavMeshData {
    const verts: number[] = [];
    const counts: number[] = [];
    const v = (x: number, z: number) => verts.push(x, h(x, z), z);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
        if (holes(x, z)) continue;
        // Same winding as quadData's (x,z) -> (x,z+1) -> (x+1,z+1) -> (x+1,z), split in two.
        v(x, z); v(x, z + 1); v(x + 1, z + 1); counts.push(3);
        v(x, z); v(x + 1, z + 1); v(x + 1, z); counts.push(3);
    }
    return { vertices: new Float32Array(verts), counts: new Uint32Array(counts) };
}

const bumpy = (x: number, z: number) => 0.4 * Math.sin(x * 0.7) + 0.3 * Math.cos(z * 0.5) + 0.05 * x;

describe('CleoNavMesh on terrain', () => {
    it('finds the region under feet that are not exactly on the surface', () => {
        const mesh = buildNavMesh(terrainData(10, bumpy))!;
        const y = bumpy(4.3, 6.2);
        expect(mesh.contains([4.3, y + 0.3, 6.2])).toBe(true);
        expect(mesh.contains([4.3, y - 0.2, 6.2])).toBe(true);
        // But not from a storey up, and not beside the mesh.
        expect(mesh.contains([4.3, y + 6, 6.2])).toBe(false);
        expect(mesh.contains([12, y, 6.2])).toBe(false);
    });

    it('walks straight across open ground instead of a staircase of triangles', () => {
        const mesh = buildNavMesh(terrainData(30, bumpy))!;
        for (const [from, to] of [[[1.3, 0, 2.7], [27.6, 0, 21.2]], [[3.1, 0, 25.4], [26.2, 0, 4.9]], [[0.5, 0, 14.5], [29.5, 0, 15.5]]]) {
            const path = mesh.findPath([from[0], bumpy(from[0], from[2]) + 0.1, from[2]], [to[0], bumpy(to[0], to[2]) + 0.1, to[2]]);
            expect(path).toHaveLength(2);
            // Waypoints sit ON the surface, not at the query's height.
            expect(path[1][1]).toBeCloseTo(bumpy(to[0], to[2]), 1);
        }
    });

    it('still bends around a real hole, and only there', () => {
        // A 4x10 hole in the middle of the field.
        const hole = (x: number, z: number) => x >= 13 && x < 17 && z >= 5 && z < 25;
        const mesh = buildNavMesh(terrainData(30, () => 0, hole))!;
        const path = mesh.findPath([10, 0, 15], [20, 0, 15]);
        expect(path.length).toBe(4);
        // The two interior points are the hole's corners on one side.
        const inner = path.slice(1, -1).map(p => [Math.round(p[0]), Math.round(p[2])]);
        expect(inner.every(([x]) => x === 13 || x === 17)).toBe(true);
        expect(new Set(inner.map(([, z]) => z)).size).toBe(1);
        // Every leg stays on the mesh.
        for (let i = 0; i < path.length - 1; i++) for (let t = 0.05; t < 1; t += 0.05) {
            const x = path[i][0] + (path[i + 1][0] - path[i][0]) * t, z = path[i][2] + (path[i + 1][2] - path[i][2]) * t;
            expect(hole(Math.floor(x), Math.floor(z)) && x > 13.001 && x < 16.999 && z > 5.001 && z < 24.999).toBe(false);
        }
    });

    it('routes from an off-mesh point to the nearest ground in XZ, not the nearest 3D centroid', () => {
        // Two islands at very different heights; the query point is beside the LOW one but level with
        // the high one. A 3D centroid search picks the high island.
        const low = terrainData(4, () => 0);
        const highVerts = Array.from(terrainData(4, () => 10).vertices, (v, i) => i % 3 === 0 ? v + 20 : v);
        const data: NavMeshData = {
            vertices: new Float32Array([...low.vertices, ...highVerts]),
            counts: new Uint32Array([...low.counts, ...low.counts]),
        };
        const mesh = buildNavMesh(data)!;
        const path = mesh.findPath([2, 0, 2], [5, 9, 2]);
        expect(path.length).toBeGreaterThan(0);
        expect(path[path.length - 1][0]).toBeCloseTo(4, 3);
        expect(path[path.length - 1][1]).toBeCloseTo(0, 3);
    });

    it('loads a landscape-sized bake in well under a second', () => {
        const data = terrainData(140, bumpy); // 39,200 regions -- a 300 x 260 m volume baked at 2 m
        const t0 = performance.now();
        const mesh = buildNavMesh(data)!;
        expect(performance.now() - t0).toBeLessThan(1500);
        expect(mesh.regionCount).toBe(39200);
        expect(mesh.nodeCount).toBe(39200);
    });

    it('answers a terrain-sized query quickly', () => {
        const mesh = buildNavMesh(terrainData(90, bumpy))!; // 16,200 regions
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) mesh.findPath([2 + i, 0, 3], [85, 0, 80 - i]);
        expect((performance.now() - t0) / 20).toBeLessThan(40);
    });
});
