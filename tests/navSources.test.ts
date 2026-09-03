import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import {
    SoupBuilder, heightfieldSoup, mergeSoups, tessellateSource, tessellateSources,
} from '../src/ai/navSources';
import type { NavSource } from '../src/ai/navSources';
import { bakeNavMesh } from '../src/ai/navBake';
import { buildNavMesh } from '../src/ai/navMesh';

// WINDING IS THE WHOLE TEST FILE. The bake's slope filter reads the sign of (b-a)x(c-a) and does NOT
// take an absolute value, so a face wound backwards silently becomes a ceiling and drops out. That
// failure produces a navmesh with a hole in it and nothing anywhere that says why, which is why every
// primitive below is checked by baking it and asserting a walkable surface came out at the right
// height rather than by eyeballing vertex order.

/** Bake a soup and report the walkable extent it produced. */
function walkable(sources: NavSource[]) {
    const result = bakeNavMesh(tessellateSources(sources));
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    const v = result.data.vertices;
    for (let i = 0; i < v.length; i += 3) {
        minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i]);
        minY = Math.min(minY, v[i + 1]); maxY = Math.max(maxY, v[i + 1]);
    }
    return { ...result, minX, maxX, minY, maxY };
}

const box = (size: [number, number, number], transform = mat4.create()): NavSource =>
    ({ primitive: { kind: 'box', size }, transform });

describe('box colliders', () => {
    it('emits all six faces, of which only the top is walkable', () => {
        const builder = new SoupBuilder();
        tessellateSource(builder, box([2, 2, 2]));
        expect(builder.triangleCount).toBe(12);

        // Twelve in, two out: the +Y face survives the slope filter and the other five do not.
        const result = walkable([box([2, 2, 2])]);
        expect(result.walkableTriangles).toBe(2);
        expect(result.rejectedTriangles).toBe(10);
    });

    it('puts the walkable surface on top of the box, not underneath it', () => {
        // The trap a reversed winding would produce: the -Y face passing instead of the +Y one, so
        // agents path along the bottom of every crate.
        const result = walkable([box([4, 3, 4])]);
        expect(result.minY).toBeCloseTo(1.5, 5);
        expect(result.maxY).toBeCloseTo(1.5, 5);
    });

    it('honours the placing transform', () => {
        const transform = mat4.fromTranslation(mat4.create(), [10, 5, 0]);
        const result = walkable([box([2, 2, 2], transform)]);
        expect(result.minY).toBeCloseTo(6, 5);
        expect(result.minX).toBeCloseTo(9, 5);
        expect(result.maxX).toBeCloseTo(11, 5);
    });

    it('bakes two abutting boxes into one connected surface', () => {
        const left = mat4.fromTranslation(mat4.create(), [0, 0, 0]);
        const right = mat4.fromTranslation(mat4.create(), [4, 0, 0]);
        const result = bakeNavMesh(tessellateSources([
            box([4, 1, 4], left), box([4, 1, 4], right),
        ]));
        const mesh = buildNavMesh(result.data, { merge: false })!;
        expect(mesh.findPath([-1, 0.5, 0], [5, 0.5, 0]).length).toBeGreaterThan(0);
    });
});

describe('cylinder colliders', () => {
    it('caps face out, so the top is walkable and the bottom is not', () => {
        const source: NavSource = {
            primitive: { kind: 'cylinder', radius: 2, height: 4, segments: 8 },
            transform: mat4.create(),
        };
        const result = walkable([source]);
        expect(result.walkableTriangles).toBeGreaterThan(0);
        // The top cap of a 4-tall cylinder centred on the origin.
        expect(result.minY).toBeCloseTo(2, 5);
        expect(result.maxY).toBeCloseTo(2, 5);
    });

    it('clamps a silly segment count instead of allocating for it', () => {
        const builder = new SoupBuilder();
        tessellateSource(builder, {
            primitive: { kind: 'cylinder', radius: 1, height: 1, segments: 100000 },
            transform: mat4.create(),
        });
        // 64 segments: two caps plus a quad per side.
        expect(builder.triangleCount).toBeLessThanOrEqual(64 * 4);
    });
});

describe('convex colliders', () => {
    it('tessellates authored faces', () => {
        // A unit box as an explicit hull, top face wound CCW from above.
        const vertices = [
            [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],
            [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
        ];
        const source: NavSource = {
            primitive: { kind: 'convex', vertices, faces: [[4, 7, 6, 5]] },
            transform: mat4.create(),
        };
        const result = walkable([source]);
        expect(result.walkableTriangles).toBe(2);
        expect(result.minY).toBeCloseTo(1, 5);
    });

    // A face indexing a vertex that is not there would otherwise emit a triangle at the origin -- a
    // spike through the whole level, and walkable at y = 0 where nothing exists.
    it('drops a face that indexes a missing vertex rather than spiking to the origin', () => {
        const builder = new SoupBuilder();
        tessellateSource(builder, {
            primitive: { kind: 'convex', vertices: [[0, 0, 0], [1, 0, 0]], faces: [[0, 1, 99]] },
            transform: mat4.create(),
        });
        expect(builder.triangleCount).toBe(0);
    });
});

describe('plane colliders', () => {
    it('emits a finite patch of the infinite half-space', () => {
        const result = walkable([{ primitive: { kind: 'plane', extent: 10 }, transform: mat4.create() }]);
        expect(result.minX).toBeCloseTo(-10, 5);
        expect(result.maxX).toBeCloseTo(10, 5);
    });

    it('emits nothing for a zero extent', () => {
        const builder = new SoupBuilder();
        tessellateSource(builder, { primitive: { kind: 'plane', extent: 0 }, transform: mat4.create() });
        expect(builder.triangleCount).toBe(0);
    });
});

describe('terrain heightfields', () => {
    it('triangulates flat ground the right way up', () => {
        const resolution = 5;
        const soup = heightfieldSoup({
            heights: new Float32Array(resolution * resolution),
            resolution,
            elementSize: 1,
            origin: [0, 0, 0],
        });
        // (5-1)^2 quads, two triangles each.
        expect(soup.positions.length / 9).toBe(32);

        const result = bakeNavMesh(soup);
        expect(result.walkableTriangles).toBe(32);
        expect(result.regions).toBeGreaterThan(0);
    });

    it('centres on the origin it is given', () => {
        const resolution = 3;
        const soup = heightfieldSoup({
            heights: new Float32Array(9),
            resolution,
            elementSize: 2,
            origin: [100, 7, -50],
        });
        let minX = Infinity, maxX = -Infinity, y = 0;
        for (let i = 0; i < soup.positions.length; i += 3) {
            minX = Math.min(minX, soup.positions[i]);
            maxX = Math.max(maxX, soup.positions[i]);
            y = soup.positions[i + 1];
        }
        // Two elements across, so 4 units wide, centred on x = 100.
        expect(minX).toBeCloseTo(98, 5);
        expect(maxX).toBeCloseTo(102, 5);
        expect(y).toBeCloseTo(7, 5);
    });

    it('decimates on request, because an XZ-planar navmesh cannot use full terrain detail', () => {
        const resolution = 9;
        const source = {
            heights: new Float32Array(resolution * resolution),
            resolution,
            elementSize: 1,
            origin: [0, 0, 0] as [number, number, number],
        };
        expect(heightfieldSoup(source, 1).positions.length / 9).toBe(128);
        expect(heightfieldSoup(source, 2).positions.length / 9).toBe(32);
    });

    it('rejects a degenerate field instead of throwing', () => {
        expect(heightfieldSoup({ heights: [], resolution: 1, elementSize: 1, origin: [0, 0, 0] })
            .positions.length).toBe(0);
        expect(heightfieldSoup({ heights: [0, 0, 0, 0], resolution: 2, elementSize: 0, origin: [0, 0, 0] })
            .positions.length).toBe(0);
    });

    it('keeps a slope walkable and a cliff not', () => {
        // A ramp climbing 1 unit per unit of run: 45 degrees.
        const resolution = 5;
        const heights = new Float32Array(resolution * resolution);
        for (let r = 0; r < resolution; r++) for (let c = 0; c < resolution; c++) heights[r * resolution + c] = r;
        const soup = heightfieldSoup({ heights, resolution, elementSize: 1, origin: [0, 0, 0] });

        expect(bakeNavMesh(soup, { maxSlope: 50 }).walkableTriangles).toBe(32);
        expect(bakeNavMesh(soup, { maxSlope: 40 }).walkableTriangles).toBe(0);
    });
});

describe('mergeSoups', () => {
    it('concatenates non-indexed soups', () => {
        const a = tessellateSources([box([2, 2, 2])]);
        const b = tessellateSources([box([2, 2, 2], mat4.fromTranslation(mat4.create(), [10, 0, 0]))]);
        expect(mergeSoups([a, b]).positions.length).toBe(a.positions.length + b.positions.length);
    });

    it('flattens an indexed soup while merging, since two cannot share an index space', () => {
        const indexed = {
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
            indices: new Uint32Array([0, 1, 2]),
        };
        const merged = mergeSoups([indexed]);
        expect(merged.indices.length).toBe(0);
        expect(Array.from(merged.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    });

    it('handles an empty list', () => {
        expect(mergeSoups([]).positions.length).toBe(0);
    });
});
