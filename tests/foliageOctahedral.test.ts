import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { FoliageLayer } from '../src/terrain/foliage';
import { Model } from '../src/graphics/model';
import { Geometry } from '../src/core/geometry';
import { Material, TerrainFoliageRule } from '../src/graphics/material';

// A foliage rule's octahedral impostor: what turns it on, what survives a save, and what falls back to the
// classic card. Same device stub as tests/foliagePrototypeRefresh.test.ts — a Model allocates on construction.
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

const tree = () => {
    const g = new Geometry(
        [[-1, 0, 0], [1, 0, 0], [1, 6, 0], [-1, 6, 0]],
        [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
        [[0, 0], [1, 0], [1, 1], [0, 1]],
        [], [], [0, 1, 2, 0, 2, 3],
    );
    return new Model(g, Material.Basic({ color: [1, 1, 1] })).serialize();
};
const octahedral = { frames: 8, radius: 3.2, center: [0, 3, 0] as [number, number, number] };
const rule = (billboard: TerrainFoliageRule['billboard']): TerrainFoliageRule => ({
    kind: 'mesh', name: 'pine', models: [tree()], density: 0.05, minScale: 1, maxScale: 2, billboard,
} as TerrainFoliageRule);

describe('octahedral foliage impostors', () => {
    it('turn on with both atlases, as one quad over the captured sphere', () => {
        const layer = FoliageLayer.fromRule(rule({ textureId: 'albedo', distance: 50, octahedral, textures: { normal: 'normals' } }));
        expect(layer.billboardOctahedral).toEqual(octahedral);
        expect(layer.billboardNormalTextureId).toBe('normals');
        expect(layer.billboardTextureId).toBe('albedo');
        expect(layer.billboardDistance).toBe(50);
        const b = layer.billboardModel!.geometry.boundingBox;
        expect([...b.min]).toEqual([-3.2, -0.2, 0].map(v => expect.closeTo(v, 5)));
        expect([...b.max]).toEqual([3.2, 6.2, 0].map(v => expect.closeTo(v, 5)));
    });

    it('fall back to the flat card without their normals, or with a broken description', () => {
        for (const billboard of [
            { textureId: 'albedo', distance: 50, octahedral },
            { textureId: 'albedo', distance: 50, octahedral: { frames: 1, radius: 3, center: [0, 0, 0] as [number, number, number] }, textures: { normal: 'n' } },
        ]) {
            const layer = FoliageLayer.fromRule(rule(billboard));
            expect(layer.billboardOctahedral).toBeNull();
            expect(layer.billboardNormalTextureId).toBeNull();
            expect(layer.billboardModel).not.toBeNull();   // the crossed card, still an impostor
        }
    });

    it('survive serialize -> deserialize, normals as a texture slot every reference walker sees', () => {
        const layer = FoliageLayer.fromRule(rule({ textureId: 'albedo', distance: 50, octahedral, textures: { normal: 'normals' } }));
        for (let i = 0; i < 4; i++) layer.pushInstance(i * 4, 0, 0);
        layer.commit();
        const json = layer.serialize();
        expect(json.billboard).toEqual({ textureId: 'albedo', distance: 50, octahedral, textures: { normal: 'normals' } });
        const back = FoliageLayer.deserialize(JSON.parse(JSON.stringify(json)));
        expect(back.billboardOctahedral).toEqual(octahedral);
        expect(back.billboardNormalTextureId).toBe('normals');
    });

    it('clear on a rule that drops the impostor', () => {
        const layer = FoliageLayer.fromRule(rule({ textureId: 'albedo', distance: 50, octahedral, textures: { normal: 'normals' } }));
        layer.setPrototype(rule(null));
        expect(layer.billboardModel).toBeNull();
        expect(layer.billboardOctahedral).toBeNull();
    });
});
