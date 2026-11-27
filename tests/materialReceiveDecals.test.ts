import { describe, expect, it, beforeAll } from 'vitest';
import { Material, CustomMaterial } from '../src/graphics/material';
import { AnimatedModel } from '../src/animation/animatedModel';
import { Geometry } from '../src/core/geometry';
import { setGLContext } from '../src/graphics/rhi/webgl2/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';

/**
 * A material's Receive decals option (`config.receiveDecals`), through every copy of serialize and parse: Material's,
 * CustomMaterial's and AnimatedModel's own. It is on by default and stored only when off, so every material saved
 * before it existed (and every one that receives decals) keeps its bytes, and with them its asset hash.
 */

beforeAll(() => {
    // AnimatedModel uploads its buffers when it is built; a stub context takes them (see celMaterial.test.ts).
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

const roundTrip = (m: Material) => Material.parse(JSON.parse(JSON.stringify(m.serialize())));
const triangle = () => new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 0, 1, 0, 0, 1], [0, 1, 2]);

describe('Receive decals', () => {
    it('is on by default and not written out', () => {
        for (const m of [Material.PBR(), Material.Default({}), Material.Basic({}), Material.Cel()]) {
            expect(m.config.receiveDecals !== false).toBe(true);
            expect('receiveDecals' in m.serialize().config, m.type).toBe(false);
        }
    });

    it('stays on for a material saved before it existed', () => {
        const legacy = { type: 'pbr', baseColor: [1, 1, 1], config: { side: 'front', castShadow: true, probeable: true } };
        expect(Material.parse(legacy).config.receiveDecals !== false).toBe(true);
    });

    it('keeps an off through a save and a load, on every shading model', () => {
        for (const m of [Material.PBR({}, { receiveDecals: false }), Material.Default({}, { receiveDecals: false }),
                         Material.Basic({}, { receiveDecals: false }), Material.Cel({}, { receiveDecals: false })]) {
            expect(m.serialize().config.receiveDecals, m.type).toBe(false);
            expect(roundTrip(m).config.receiveDecals, m.type).toBe(false);
        }
    });

    it('keeps an off set on a material after it was made, as the material editor does', () => {
        const m = Material.PBR();
        m.config.receiveDecals = false;
        expect(roundTrip(m).config.receiveDecals).toBe(false);
        delete m.config.receiveDecals;
        expect('receiveDecals' in m.serialize().config).toBe(false);
    });

    it('goes through a custom material', () => {
        const m = CustomMaterial.Create('pbr', 'deferred', { receiveDecals: false });
        const back = Material.parse(JSON.parse(JSON.stringify(m.serialize())));
        expect(back).toBeInstanceOf(CustomMaterial);
        expect(back.config.receiveDecals).toBe(false);
        expect('receiveDecals' in CustomMaterial.Create('pbr').serialize().config).toBe(false);
    });

    it("goes through a skinned model's own copy of serialize and parse", () => {
        const off = new AnimatedModel(triangle(), Material.PBR({}, { receiveDecals: false }));
        expect(AnimatedModel.parse(JSON.parse(JSON.stringify(off.serialize()))).material.config.receiveDecals).toBe(false);
        const on = new AnimatedModel(triangle(), Material.PBR());
        const json = on.serialize();
        expect(JSON.stringify(json)).not.toContain('receiveDecals');
        expect(AnimatedModel.parse(JSON.parse(JSON.stringify(json))).material.config.receiveDecals !== false).toBe(true);
    });
});
