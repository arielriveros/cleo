import { describe, expect, it } from 'vitest';
import { Geometry } from '../src/core/geometry';

/**
 * `weldSmooth` exists because a mesh can arrive with every triangle owning its own three vertices.
 * Assimp's glTF2 exporter runs `MakeVerboseFormat`, so the .fbx/.glb route unindexes everything it
 * touches — measured on a scanned branch, 1963 authored positions became 11823 vertices under an
 * identity index buffer.
 *
 * Nothing is shared, so nothing can be interpolated ACROSS an edge, and both halves of the shading go
 * faceted at once: the normals at one position disagreed by 55.8 degrees median while sitting only 9.4
 * degrees from their own face, and `_calculateTangents` — which accumulates per vertex — degenerated to
 * per-face, so the parallax chart jumped at every triangle boundary too. Interpolation can only smooth
 * data that is smooth.
 */

/**
 * Two quads hinged along the edge (0,0,0)-(1,0,0): one wing flat in +y, the other folded by `bendDeg`.
 * Written UNWELDED — four triangles, twelve corners, six distinct positions — which is the shape the
 * .fbx route actually delivers. All four faces wind to +z at bend 0, and the uv unrolls across the
 * hinge (v is the signed arc distance) so no seam splits it.
 */
const hinge = (bendDeg: number) => {
    const r = (bendDeg * Math.PI) / 180;
    const A: [number, number, number] = [0, 0, 0];      // hinge
    const B: [number, number, number] = [1, 0, 0];      // hinge
    const C: [number, number, number] = [1, 1, 0];
    const E: [number, number, number] = [0, 1, 0];
    const D: [number, number, number] = [0, -Math.cos(r), Math.sin(r)];
    const F: [number, number, number] = [1, -Math.cos(r), Math.sin(r)];
    const pos = [...A, ...B, ...C, ...A, ...C, ...E, ...B, ...A, ...D, ...B, ...D, ...F];
    const uv = [0, 0, 1, 0, 1, 1,
                0, 0, 1, 1, 0, 1,
                1, 0, 0, 0, 0, -1,
                1, 0, 0, -1, 1, -1];
    return new Geometry(pos, [], uv, [], [], [...Array(12).keys()], false);
};

const angleBetween = (a: number[], b: number[]) => {
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
};

describe('weldSmooth shares vertices and makes the normal field continuous', () => {
    it('an unwelded flat sheet collapses to its distinct positions, with one normal', () => {
        const g = hinge(0).weldSmooth(45);
        expect(g.vertexCount, '12 corners over 6 distinct positions').toBe(6);
        expect(g.indices.length, 'still four triangles worth of corners').toBe(12);
        for (let i = 0; i < g.vertexCount; i++)
            expect(angleBetween([g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]],
                                [0, 0, 1]), 'a flat sheet is all one normal').toBeCloseTo(0, 4);
    });

    it('a gentle bend is SMOOTHED: the hinge vertices are shared and averaged', () => {
        const g = hinge(30).weldSmooth(45);
        // Every position stays shared, because 30 < 45.
        expect(g.vertexCount).toBe(6);
        // The hinge vertices sit between the two faces rather than on either.
        const hingeNormals: number[][] = [];
        for (let i = 0; i < g.vertexCount; i++) {
            const p = [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
            if (Math.abs(p[1]) < 1e-6) hingeNormals.push(
                [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]]);
        }
        expect(hingeNormals.length, 'both ends of the hinge').toBe(2);
        // STRICTLY BETWEEN the two faces, not a hand-computed midpoint: the average is area-weighted
        // over the incident faces, and this hinge has two triangles on one wing and one on the other,
        // so it lands at ~9.9 degrees rather than 15. The invariant worth pinning is that it left both
        // face normals behind - that is what "soft" means - not where exactly it landed.
        for (const n of hingeNormals) {
            const a = angleBetween(n, [0, 0, 1]);
            expect(a, 'left the flat wing normal behind').toBeGreaterThan(1);
            expect(a, 'and did not reach the bent one').toBeLessThan(29);
        }
    });

    it('a sharp bend is KEPT: past the crease angle the hinge splits again', () => {
        const g = hinge(90).weldSmooth(45);
        // The two hinge positions carry a normal per side now, so they split: 4 + 2*2 = 8.
        expect(g.vertexCount).toBe(8);
        for (let i = 0; i < g.vertexCount; i++) {
            const n = [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]];
            const toFlat = angleBetween(n, [0, 0, 1]);
            expect(Math.min(toFlat, Math.abs(toFlat - 90)), 'each side kept its own face normal')
                .toBeCloseTo(0, 3);
        }
    });

    it('the crease angle is the control, not a fixed policy', () => {
        // The same 90-degree hinge smooths when the threshold is raised past it.
        expect(hinge(90).weldSmooth(180).vertexCount).toBe(6);
        // ...and a 0-degree threshold splits the hinge even at 30.
        expect(hinge(30).weldSmooth(0).vertexCount).toBe(8);
    });
});

describe('welding is what lets tangents be a field at all', () => {
    it('an unwelded mesh has one tangent per corner; a welded one shares them', () => {
        const raw = hinge(20);
        expect(raw.vertexCount, 'every triangle owns its corners').toBe(12);
        const welded = raw.weldSmooth(45);
        expect(welded.vertexCount).toBe(6);
        // `_calculateTangents` runs in the constructor over the SHARED vertices, so a vertex used by
        // two triangles now carries one accumulated tangent instead of two independent ones.
        expect(welded.tangents.length / 3).toBe(welded.vertexCount);
        for (let i = 0; i < welded.vertexCount; i++) {
            const t = [welded.tangents[i * 3], welded.tangents[i * 3 + 1], welded.tangents[i * 3 + 2]];
            expect(Math.hypot(t[0], t[1], t[2]), 'unit, not degenerate').toBeCloseTo(1, 4);
        }
    });

    it('a uv seam still splits, because averaging a tangent across one is wrong', () => {
        // Same flat quad, but the two halves are given disjoint uv islands.
        const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
        const uvA = [0, 0, 0.4, 0, 0.4, 1, 0.6, 0, 1, 1, 0.6, 1];
        const g = new Geometry(pos, [], uvA, [], [], [0, 1, 2, 3, 4, 5], false).weldSmooth(45);
        // 4 distinct positions, but the shared edge carries two different uvs, so it stays split.
        expect(g.vertexCount).toBeGreaterThan(4);
    });

    it('leaves a mesh with no indices alone rather than guessing', () => {
        const g = new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [], [], [], [], [], false);
        expect(g.weldSmooth(45)).toBe(g);
    });
});
