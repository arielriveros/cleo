import { describe, it, expect, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Geometry } from '../src/core/geometry';
import { Model } from '../src/graphics/model';
import { Material } from '../src/graphics/material';
import { compactRanges, extractSubmesh, withoutSubmesh } from '../src/graphics/modelSplit';

// Cutting one material range out of a merged mesh — the reverse of modelMerge. A range keeps only the
// vertices its triangles use, renumbered, with every attribute (joint weights included) carried along.

// A stub GL context and device, as tests/submeshRoundTrip.test.ts does: a Model allocates its mesh buffers
// through the RHI on construction, and nothing here draws.
beforeAll(() => {
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key] : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

/** Two quads side by side, merged: range 0 = quad A (vertices 0-3), range 1 = quad B (vertices 4-7). */
function twoQuads(): Geometry {
    const positions: number[] = [], uvs: number[] = [];
    for (const x0 of [0, 2]) {
        positions.push(x0, 0, 0, x0 + 1, 0, 0, x0 + 1, 1, 0, x0, 1, 0);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    }
    const normals = new Array(24).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0));
    const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
    return new Geometry(positions, normals, uvs, undefined, undefined, indices, true);
}

const triangles = (positions: ArrayLike<number>, indices: ArrayLike<number>) => {
    const out: string[] = [];
    for (let i = 0; i < indices.length; i += 3) {
        const tri: number[] = [];
        for (let k = 0; k < 3; k++) { const v = indices[i + k]; tri.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); }
        out.push(tri.join(','));
    }
    return out;
};

describe('compactRanges', () => {
    it('keeps only the vertices a range uses, renumbered, drawing the same triangles', () => {
        const g = twoQuads();
        const c = compactRanges(g, [{ start: 6, count: 6 }]);
        expect(c.positions.length).toBe(4 * 3);
        expect(Math.max(...c.indices)).toBe(3);
        expect(triangles(c.positions, c.indices)).toEqual(triangles(g.positions, g.indices.slice(6, 12)));
        expect(c.uvs.length).toBe(4 * 2);
        expect(c.normals.length).toBe(4 * 3);
        expect(c.submeshes).toEqual([{ start: 0, count: 6 }]);
    });

    it('compacts joint attributes with the vertices', () => {
        const g = twoQuads();
        const joints = new Float32Array(8 * 4).map((_, i) => Math.floor(i / 4));     // vertex v -> joint v
        const weights = new Float32Array(8 * 4).fill(0.25);
        const c = compactRanges(g, [{ start: 6, count: 6 }], joints, weights);
        // The kept vertices were 4..7, in first-use order.
        expect(Array.from(c.jointIndices!.filter((_, i) => i % 4 === 0))).toEqual([4, 5, 6, 7]);
        expect(c.jointWeights!.length).toBe(16);
    });

    it('lays several kept ranges end to end with fresh offsets', () => {
        const c = compactRanges(twoQuads(), [{ start: 6, count: 6 }, { start: 0, count: 6 }]);
        expect(c.submeshes).toEqual([{ start: 0, count: 6 }, { start: 6, count: 6 }]);
        expect(c.positions.length).toBe(8 * 3);
    });
});

describe('extractSubmesh / withoutSubmesh', () => {
    const merged = () => {
        const a = Material.PBR({ baseColor: [1, 0, 0] }), b = Material.PBR({ baseColor: [0, 0, 1] });
        return { model: new Model(twoQuads(), [a, b], [{ start: 0, count: 6 }, { start: 6, count: 6 }]), a, b };
    };

    it('extracts one sub-mesh as a whole-buffer model with its own material', () => {
        const { model, b } = merged();
        const part = extractSubmesh(model, 1);
        expect(part.materials).toEqual([b]);
        expect(part.submeshes).toEqual([]);
        expect(part.geometry.vertexCount).toBe(4);
        expect(part.geometry.indices.length).toBe(6);
    });

    it('removes one sub-mesh and keeps the rest parallel to their materials', () => {
        const { model, a } = merged();
        const rest = withoutSubmesh(model, 1);
        expect(rest.materials).toEqual([a]);
        expect(rest.geometry.vertexCount).toBe(4);
    });

    it('rejects a sub-mesh that does not exist, and removing the only one', () => {
        const { model } = merged();
        expect(() => extractSubmesh(model, 2)).toThrow(RangeError);
        const single = extractSubmesh(model, 0);
        expect(() => withoutSubmesh(single, 0)).toThrow(RangeError);
    });
});
