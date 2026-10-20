import { describe, expect, it, beforeAll } from 'vitest';
import { vec3 } from 'gl-matrix';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { FoliageLayer } from '../src/terrain/foliage';
import { Model } from '../src/graphics/model';
import { Geometry } from '../src/core/geometry';
import { Material, TerrainFoliageRule } from '../src/graphics/material';

// How a mesh instance stands: upright (the default), tilted to the ground's normal, or at a random
// orientation. All three are applied when the matrices are built, from the same stored record.

beforeAll(() => {
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key]
            : objects.has(key) ? () => ({ id: ++n })
            : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

const quadJson = () => new Model(new Geometry(
    [[-1, 0, 0], [1, 0, 0], [1, 2, 0], [-1, 2, 0]],
    [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    [], [], [0, 1, 2, 0, 2, 3],
), Material.Basic({ color: [1, 1, 1] })).serialize();

function layerWith(orientation?: TerrainFoliageRule['orientation'], count = 6): FoliageLayer {
    const layer = FoliageLayer.fromRule({
        kind: 'mesh', name: 'rock', models: [quadJson()], density: 0.01, minScale: 1, maxScale: 1, orientation,
    } as TerrainFoliageRule);
    for (let i = 0; i < count; i++) layer.pushInstance(i * 3, 0, i * 2);
    layer.commit();
    return layer;
}

/** Each instance's local +Y in world space, read off its matrix. */
function ups(layer: FoliageLayer): vec3[] {
    const out: vec3[] = [];
    for (const cell of layer.cells)
        for (let j = 0; j < cell.count; j++) {
            const m = cell.matrices.subarray(j * 16, j * 16 + 16);
            out.push(vec3.normalize(vec3.create(), [m[4], m[5], m[6]]));
        }
    return out;
}

describe('foliage orientation', () => {
    it('stands every instance upright by default', () => {
        for (const u of ups(layerWith())) expect(u[1]).toBeCloseTo(1, 5);
    });

    it('tilts each instance onto the ground normal under it', () => {
        const layer = layerWith('normal');
        const n = vec3.normalize(vec3.create(), [0.5, 1, 0]);
        layer.setNormalSampler(() => n);
        for (const u of ups(layer)) {
            expect(u[0]).toBeCloseTo(n[0], 5);
            expect(u[1]).toBeCloseTo(n[1], 5);
        }
    });

    it('gives free instances varied, stable orientations, and round-trips the choice', () => {
        const layer = layerWith('free', 20);
        const first = ups(layer);
        expect(first.some(u => u[1] < 0.9)).toBe(true);
        expect(new Set(first.map(u => u[0].toFixed(3))).size).toBeGreaterThan(5);
        const back = FoliageLayer.deserialize(layer.serialize());
        expect(back.orientation).toBe('free');
        const again = ups(back);
        // Same records, same orientations: nothing extra is stored, and nothing is random per rebuild.
        expect(again.map(u => u[0].toFixed(4)).sort()).toEqual(first.map(u => u[0].toFixed(4)).sort());
    });

    it('re-orients in place when the rule changes, keeping every instance where it is', () => {
        const layer = layerWith();
        const before = layer.count;
        layer.setPrototype({ kind: 'mesh', name: 'rock', models: [quadJson()], orientation: 'free' } as TerrainFoliageRule);
        expect(layer.orientation).toBe('free');
        expect(layer.count).toBe(before);
        expect(ups(layer).some(u => u[1] < 0.9)).toBe(true);
    });
});
