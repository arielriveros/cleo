import { describe, it, expect } from 'vitest';
import { Geometry } from '../src/core/geometry';

/**
 * Save-format compatibility for the flat-typed-array representation.
 *
 * `Geometry` now stores flat `Float32Array`s, but projects saved before that hold the nested
 * `[[x,y,z], ...]` shape, and published bundles bake geometry into JSON the same way. The constructor
 * therefore has to read both — this pins that, because the failure mode is "every existing project
 * loads with garbled meshes", which no type checker would catch.
 */

const NESTED_POSITIONS = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
const NESTED_UVS = [[0, 0], [1, 0], [0, 1]];
const FLAT_POSITIONS = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const FLAT_UVS = [0, 0, 1, 0, 0, 1];
const INDICES = [0, 1, 2];

describe('Geometry accepts every persisted attribute shape', () => {
    it('reads the legacy nested shape', () => {
        const g = new Geometry(NESTED_POSITIONS, [], NESTED_UVS, [], [], INDICES);
        expect(g.vertexCount).toBe(3);
        expect(Array.from(g.positions)).toEqual(FLAT_POSITIONS);
        expect(Array.from(g.uvs)).toEqual(FLAT_UVS);
        expect(Array.from(g.indices)).toEqual(INDICES);
    });

    it('reads a flat number[] (what serialize now writes)', () => {
        const g = new Geometry(FLAT_POSITIONS, [], FLAT_UVS, [], [], INDICES);
        expect(g.vertexCount).toBe(3);
        expect(Array.from(g.positions)).toEqual(FLAT_POSITIONS);
        expect(Array.from(g.uvs)).toEqual(FLAT_UVS);
    });

    // The worker path: transferred buffers must be adopted without a copy, or the whole point of
    // making the boundary transferable is lost.
    it('adopts a Float32Array without copying it', () => {
        const positions = new Float32Array(FLAT_POSITIONS);
        const g = new Geometry(positions, [], new Float32Array(FLAT_UVS), [], [], new Uint32Array(INDICES));
        expect(g.positions).toBe(positions);
    });

    it('produces identical geometry from the nested and flat shapes', () => {
        const nested = new Geometry(NESTED_POSITIONS, [], NESTED_UVS, [], [], INDICES);
        const flat = new Geometry(FLAT_POSITIONS, [], FLAT_UVS, [], [], INDICES);
        const attrs = ['position', 'normal', 'uv', 'tangent', 'bitangent'];
        expect(Array.from(nested.getData(attrs))).toEqual(Array.from(flat.getData(attrs)));
        expect(Array.from(nested.boundingBox.min)).toEqual(Array.from(flat.boundingBox.min));
    });

    it('handles empty attributes without producing NaN or a broken stride', () => {
        const g = new Geometry([], [], [], [], [], []);
        expect(g.vertexCount).toBe(0);
        expect(g.getData(['position']).length).toBe(0);
        expect(Array.from(g.boundingBox.min)).toEqual([0, 0, 0]);
        expect(Array.from(g.boundingBox.max)).toEqual([0, 0, 0]);
    });

    /**
     * A geometry with positions but no UVs still gets tangents generated, and `getData` must not
     * leave a hole in the stride for the attributes that are absent.
     */
    it('omits absent attributes from the interleave', () => {
        const g = new Geometry(FLAT_POSITIONS, [], [], [], [], INDICES);
        // uv requested but absent -> contributes nothing; position(3) + tangent(3) = stride 6.
        expect(g.getData(['position', 'uv', 'tangent']).length).toBe(3 * 6);
    });
});
