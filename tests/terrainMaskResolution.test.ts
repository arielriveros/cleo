import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/rhi/webgl2/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { defaultMaskResolution } from '../src/terrain/terrainLayerStack';
import { defaultBlendRule } from '../src/terrain/terrainLayers';
import { Material, TerrainMaterial } from '../src/graphics/material';

/**
 * A landscape's paint masks have a resolution of their own, chosen at Rebuild or by a world import. The
 * stack always saved it (`layerStack.maskRes`), but the terrain was rebuilt from size/resolution/chunks
 * alone, so every reload resampled the masks back to the default and blurred a 2048² import to 1024².
 */

beforeAll(() => {
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key]
            : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

describe('mask resolution', () => {
    it('survives serialize -> deserialize, masks and all', () => {
        const t = new Terrain({ size: 64, resolution: 17, chunkQuads: 8, maskResolution: 96 });
        expect(t.maskResolution).toBe(96);
        expect(defaultMaskResolution(17)).not.toBe(96);
        const tm = TerrainMaterial.Create('basic', { color: [1, 1, 1] });
        tm.slots.push({ id: 'sand', name: 'Sand', material: Material.Basic({ color: [0.8, 0.7, 0.5] }), surfaceMaterialId: null,
                        tiling: 10, rule: defaultBlendRule(), allowFoliage: false, manual: true });
        t.layerStack.setBase(tm);
        const plane = new Uint8Array(96 * 96);
        for (let i = 0; i < plane.length; i++) plane[i] = i % 251;
        expect(t.layerStack.writeChannel('sand', plane, 96)).toBe(true);

        const back = Terrain.deserialize(JSON.parse(JSON.stringify(t.serialize())));
        expect(back.maskResolution).toBe(96);
        const ch = back.layerStack.slotChannel('sand')!;
        const patch = back.layerStack.readMaskPatches(back.layerStack.masks.fullRegion()).find(p => p.channel === ch)!;
        expect(Array.from(patch.data)).toEqual(Array.from(plane));
    });

    it('a blob without one still gets the default', () => {
        const json = new Terrain({ size: 64, resolution: 17, chunkQuads: 8 }).serialize() as any;
        delete json.layerStack.maskRes;
        expect(Terrain.deserialize(json).maskResolution).toBe(defaultMaskResolution(17));
    });
});
