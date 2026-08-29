import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { FoliageLayer } from '../src/terrain/foliage';
import { Model } from '../src/graphics/model';
import { Geometry } from '../src/core/geometry';
import { Material, TerrainFoliageRule } from '../src/graphics/material';

// `Mesh` allocates a VAO and buffers in its constructor, so building a prototype Model touches the
// device even though nothing here is ever drawn. Same stub as tests/submeshRoundTrip.test.ts.
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

/**
 * Refreshing a foliage layer's prototype from an edited rule.
 *
 * The property the whole feature rests on: a scattered instance's matrix holds only its position, a
 * random yaw and a random scale — the prototype's own transform is baked into its VERTICES editor-side.
 * So swapping the prototype cannot invalidate an instance, and a model or material edit must leave
 * hand-painted placement exactly where it was. Density is the single exception, because it says how
 * many instances should exist rather than what they look like, and that is reported back to the caller
 * rather than acted on here.
 */

/** A unit quad at a given size, so a "transform edit" is visible as changed vertex positions. */
const quadJson = (size: number, texture?: string) => {
    const g = new Geometry(
        [[-size, 0, 0], [size, 0, 0], [size, size * 2, 0], [-size, size * 2, 0]],
        [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
        [[0, 0], [1, 0], [1, 1], [0, 1]],
        [], [], [0, 1, 2, 0, 2, 3],
    );
    const mat = Material.Basic(texture ? { color: [1, 1, 1], texture } : { color: [1, 1, 1] });
    return new Model(g, mat).serialize();
};

const rule = (over: Partial<TerrainFoliageRule> = {}): TerrainFoliageRule => ({
    kind: 'mesh', name: 'oak', models: [quadJson(1)],
    density: 0.05, minScale: 1, maxScale: 1, ...over,
} as TerrainFoliageRule);

/** Scatter a handful of instances at known positions. */
function scattered(layer: FoliageLayer, n = 6): FoliageLayer {
    for (let i = 0; i < n; i++) layer.pushInstance(i * 3, 0, i * 5);
    layer.commit();
    return layer;
}

const instances = (layer: FoliageLayer) => {
    const out: number[][] = [];
    const buf: number[] = [0, 0, 0, 0, 0];
    for (let i = 0; i < layer.count; i++) { layer.instanceAt(i, buf); out.push([...buf]); }
    return out;
};

describe('a prototype swap preserves the scatter', () => {
    it('keeps every instance position and yaw when the geometry changes', () => {
        const layer = scattered(FoliageLayer.fromRule(rule()));
        const before = instances(layer);

        // A transform edit reaches the layer as different baked vertices.
        layer.setPrototype(rule({ models: [quadJson(4)] }));

        expect(layer.count).toBe(before.length);
        expect(instances(layer)).toEqual(before);
    });

    it('reports no density change when only the geometry moved', () => {
        const layer = scattered(FoliageLayer.fromRule(rule()));
        expect(layer.setPrototype(rule({ models: [quadJson(4)] })).densityChanged).toBe(false);
    });

    it('adopts the new geometry rather than keeping the old copy', () => {
        const layer = scattered(FoliageLayer.fromRule(rule()));
        const beforeX = layer.model.geometry.boundingBox.max[0];

        layer.setPrototype(rule({ models: [quadJson(4)] }));

        expect(layer.model.geometry.boundingBox.max[0]).toBeGreaterThan(beforeX);
    });

    it('adopts a new material — the half a node walk can never reach', () => {
        const layer = scattered(FoliageLayer.fromRule(rule()));
        layer.setPrototype(rule({ models: [quadJson(1, 'bark')] }));
        expect(layer.model.material.textures.get('texture')).toBe('bark');
    });

    it('re-uploads the prototype mesh by clearing `initialized`', () => {
        const layer = scattered(FoliageLayer.fromRule(rule()));
        layer.initialized = true;   // the renderer's flag, set once the mesh + VAO exist
        layer.setPrototype(rule({ models: [quadJson(4)] }));
        expect(layer.initialized).toBe(false);
    });
});

describe('cell bounds track the new prototype', () => {
    it('grows the padded AABB when the prototype grows', () => {
        const layer = scattered(FoliageLayer.fromRule(rule()));
        const before = layer.cells.map(c => [...c.min, ...c.max]);

        layer.setPrototype(rule({ models: [quadJson(6)] }));

        // Same cells (the instances did not move), wider padding.
        expect(layer.cells).toHaveLength(before.length);
        expect(layer.cells[0].min[0]).toBeLessThan(before[0][0]);
        expect(layer.cells[0].max[0]).toBeGreaterThan(before[0][3]);
    });

    it('does not re-upload every cell for a prototype-only edit', () => {
        // `version` is what the renderer compares against `cell.uploadedVersion`. Bumping it for an
        // edit that cannot change a single matrix would re-upload every cell's buffer for nothing.
        const layer = scattered(FoliageLayer.fromRule(rule()));
        const version = layer.version;
        layer.setPrototype(rule({ models: [quadJson(4)] }));
        expect(layer.version).toBe(version);
    });

    it('resets a stale LOD selection when the level count shrinks', () => {
        // The renderer indexes the billboard bucket at levels.length, so a cell remembering a level
        // that no longer exists would select past the end.
        const layer = scattered(FoliageLayer.fromRule(rule({
            models: [quadJson(1)], lods: [{ models: [quadJson(1)], distance: 20 }],
        })));
        layer.cells[0].lod = 1;

        layer.setPrototype(rule({ models: [quadJson(1)] }));   // back to one level

        expect(layer.levels).toHaveLength(1);
        expect(layer.cells[0].lod).toBe(0);
    });
});

describe('the two cases that do touch instances', () => {
    it('re-rolls scale in place when the range changes, keeping position and yaw', () => {
        const layer = scattered(FoliageLayer.fromRule(rule({ minScale: 1, maxScale: 1 })));
        const before = instances(layer);
        expect(before.every(i => i[4] === 1)).toBe(true);

        layer.setPrototype(rule({ minScale: 5, maxScale: 5 }));

        const after = instances(layer);
        expect(after).toHaveLength(before.length);
        for (let i = 0; i < after.length; i++) {
            expect(after[i].slice(0, 4)).toEqual(before[i].slice(0, 4));   // x, y, z, yaw untouched
            expect(after[i][4]).toBe(5);                                   // scale re-rolled
        }
    });

    it('reports a density change so the caller can decide to re-scatter', () => {
        const layer = scattered(FoliageLayer.fromRule(rule({ density: 0.05 })));
        expect(layer.setPrototype(rule({ density: 0.5 })).densityChanged).toBe(true);
        // Reported, never acted on here: setPrototype must not discard placement on its own.
        expect(layer.count).toBe(6);
    });
});

describe('retired prototype meshes are handed back for disposal', () => {
    it('queues the outgoing meshes on a swap', () => {
        const layer = scattered(FoliageLayer.fromRule(rule()));
        // Construction already retires one: `fromRule` parses a throwaway base Model that
        // `_applyMeshPrototype` immediately replaces. That was a leak too, and the queue catches it.
        expect(layer.collectRetiredMeshes().length).toBeGreaterThan(0);

        layer.setPrototype(rule({ models: [quadJson(4)] }));

        // One per outgoing LOD0 sub-mesh. Without this queue every refresh leaked a VAO and its buffers.
        expect(layer.collectRetiredMeshes().length).toBeGreaterThan(0);
        // Drained, so a second collect returns nothing.
        expect(layer.collectRetiredMeshes()).toHaveLength(0);
    });
});
