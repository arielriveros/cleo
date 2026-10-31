import { describe, it, expect, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Node } from '../src/core/scene/nodes/node';
import { ClothNode, CLOTH_DEFAULTS } from '../src/core/scene/nodes/clothNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';

// A model allocates its (empty) GPU mesh on construction: a stub GL context stands in, as in
// foliageOrientation.test.ts. Nothing here draws.
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

function hung(options = {}) {
    const pole = new Node('Pole');
    const cloth = new ClothNode('Banner', { columns: 6, rows: 8, width: 1, height: 1.5, ...options });
    pole.addChild(cloth);
    pole.setPosition([2, 3, 0]);
    pole.updateTransforms();
    return { pole, cloth };
}

const step = (cloth: ClothNode, seconds: number, playing = true) => {
    for (let t = 0; t < seconds; t += 1 / 60) cloth.lateStep(1 / 60, playing);
};

describe('ClothNode', () => {
    it('saves its options and material, not its mesh, and loads back the same', async () => {
        const { pole, cloth } = hung({ pinEdge: 'left', stiffness: 0.8, windResponse: 2, bone: 'chest' });
        const json = await cloth.serialize();
        expect(json.type).toBe('cloth');
        expect(json.model).toBeUndefined();
        expect(json.cloth).toMatchObject({ pinEdge: 'left', stiffness: 0.8, windResponse: 2, bone: 'chest', columns: 6 });
        expect(json.material.config.side).toBe('double');

        const parent = new Node('Parent');
        parseNodeJson(parent, json);
        const back = parent.children[0] as ClothNode;
        expect(back).toBeInstanceOf(ClothNode);
        expect(back.options).toEqual(cloth.options);
        expect(back.model.geometry.vertexCount).toBe(6 * 8);
        pole.removeChild(cloth);
    });

    it('rests while authoring and hangs from its node once playing', () => {
        const { pole, cloth } = hung();
        step(cloth, 0.5, false);
        expect(cloth.particlePositions).toBeNull();
        step(cloth, 2);
        const p = cloth.particlePositions!;
        // The held top edge at the pole (the node's origin, width along X), the hem under it.
        expect(p[1]).toBeCloseTo(3, 4);
        const hem = (8 - 1) * 6 + 2;
        expect(p[hem * 3 + 1]).toBeLessThan(3 - 1.4);
        // Back to authoring: the simulation is dropped.
        step(cloth, 0.1, false);
        expect(cloth.particlePositions).toBeNull();
        void pole;
    });

    it('carries its held edge with the node it hangs from', () => {
        const { pole, cloth } = hung();
        step(cloth, 1);
        for (let k = 1; k <= 30; k++) {
            pole.setPosition([2 + k * 0.05, 3, 0]);
            pole.updateTransforms();
            cloth.lateStep(1 / 60, true);
        }
        const p = cloth.particlePositions!;
        // The held edge's left corner: -width/2 off the pole, which has moved 1.5 m along X.
        expect(p[0]).toBeCloseTo(2 + 1.5 - 0.5, 3);
    });

    it('clamps nonsense options to something it can simulate', () => {
        const cloth = new ClothNode('Bad', { columns: 1, rows: 500, mass: -3, pinEdge: 'bottom' as any, stiffness: 7 });
        expect(cloth.options.columns).toBe(2);
        expect(cloth.options.rows).toBe(64);
        expect(cloth.options.mass).toBeGreaterThan(0);
        expect(cloth.options.pinEdge).toBe(CLOTH_DEFAULTS.pinEdge);
        expect(cloth.options.stiffness).toBe(1);
    });
});
