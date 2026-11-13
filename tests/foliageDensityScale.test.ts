import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/rhi/webgl2/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { FoliageLayer, foliageDensityScale, foliageBatchInstances, FOLIAGE_DENSITY_STEPS } from '../src/terrain/foliage';
import { Model } from '../src/graphics/model';
import { Geometry } from '../src/core/geometry';
import { Material, TerrainFoliageRule } from '../src/graphics/material';

// `FoliageLayer.densityScale` thins a layer live (a sequence's Foliage track sweeps it): every draw, the
// shadows and the colliders take the same PREFIX of each cell. Two things make that look right: the
// prefixes nest, so sweeping the scale never swaps one plant for another, and each cell's instances are
// ordered by a hash of where they stand, so any prefix is spread over the whole cell rather than being
// the rows a scatter placed first.

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

const quad = () => new Model(new Geometry(
    [[-1, 0, 0], [1, 0, 0], [1, 2, 0], [-1, 2, 0]],
    [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    [], [], [0, 1, 2, 0, 2, 3],
), Material.Basic({ color: [1, 1, 1] })).serialize();

/** One 40 m cell filled row by row, the way a scatter places its instances. */
function rowByRow(): FoliageLayer {
    const layer = FoliageLayer.fromRule({
        kind: 'mesh', name: 'tree', models: [quad()], density: 0.01, minScale: 1, maxScale: 1,
    } as TerrainFoliageRule);
    layer.cellSize = 40;
    for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) layer.pushInstance(1 + c * 2, 0, 1 + r * 2, (r * 20 + c) * 0.37);
    layer.commit();
    return layer;
}

describe('FoliageLayer.densityScale', () => {
    it('keeps everything until set, clamps, and steps on a 1/32 grid', () => {
        expect(foliageDensityScale({})).toBe(1);
        expect(foliageDensityScale({ densityScale: 1 })).toBe(1);
        expect(foliageDensityScale({ densityScale: 3 })).toBe(1);
        expect(foliageDensityScale({ densityScale: -1 })).toBe(0);
        // Not a number hides nothing.
        expect(foliageDensityScale({ densityScale: NaN })).toBe(1);
        expect(foliageDensityScale({ densityScale: 0.5 })).toBe(0.5);
        expect(foliageDensityScale({ densityScale: 0.51 })).toBe(Math.round(0.51 * FOLIAGE_DENSITY_STEPS) / FOLIAGE_DENSITY_STEPS);
        // Not saved: a reloaded layer is whole again.
        const layer = rowByRow();
        layer.densityScale = 0.2;
        expect(FoliageLayer.deserialize(layer.serialize()).densityScale).toBe(1);
    });

    it('takes nested prefixes: what a lower scale keeps, a higher one keeps too', () => {
        const layer = rowByRow();
        expect(layer.cells.length).toBe(1);
        const kept = (scale: number) => {
            const out = new Set<number>();
            layer.forEachInstanceNear(20, 20, 100, i => out.add(i), scale);
            return out;
        };
        let previous = kept(0);
        expect(previous.size).toBe(0);
        for (const s of [0.1, 0.25, 0.5, 0.75, 1]) {
            const now = kept(s);
            expect(now.size).toBe(Math.ceil(400 * s));
            for (const i of previous) expect(now.has(i)).toBe(true);
            previous = now;
        }
        // The draw counts the same prefix.
        expect(foliageBatchInstances(layer.cells, 0.25)).toBe(100);
    });

    it('spreads any share over the whole cell, not the rows placed first', () => {
        const layer = rowByRow();
        for (const s of [0.1, 0.25]) {
            const quadrants = [0, 0, 0, 0];
            layer.forEachInstanceNear(20, 20, 100, (_i, x, _y, z) => { quadrants[(x < 20 ? 0 : 1) + (z < 20 ? 0 : 2)]++; }, s);
            const each = 400 * s / 4;
            for (const q of quadrants) {
                expect(q).toBeGreaterThan(each * 0.5);
                expect(q).toBeLessThan(each * 1.5);
            }
        }
    });

    it('orders a cell the same way every rebuild', () => {
        const a = rowByRow(), b = rowByRow();
        expect(Array.from(a.cells[0].indices)).toEqual(Array.from(b.cells[0].indices));
        a.setCellSize?.(20); a.setCellSize?.(40);
        expect(Array.from(a.cells[0].indices)).toEqual(Array.from(b.cells[0].indices));
    });
});
