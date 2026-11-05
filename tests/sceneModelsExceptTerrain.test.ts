import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/rhi/webgl2/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { Scene } from '../src/core/scene/scene';
import { LandscapeNode } from '../src/core/scene/nodes/landscapeNode';
import { ModelNode } from '../src/core/scene/nodes/modelNode';
import { Model } from '../src/graphics/model';
import { Geometry } from '../src/core/geometry';
import { Material } from '../src/graphics/material';

// A landscape is ~1,000 generated chunk ModelNodes. Per-model loops that have nothing to do for a chunk
// walk `scene.modelsExceptTerrain`; it must hold every other model, including models parented under the
// landscape, and follow the scene's lists when they rebuild.

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

const model = (name: string) => new ModelNode(name, new Model(new Geometry(), Material.PBR({})));

describe('Scene.modelsExceptTerrain', () => {
    it('is every model but the landscape chunks, and follows a rebuild', () => {
        const scene = new Scene();
        const landscape = new LandscapeNode('ground', new Terrain({ size: 32, resolution: 17, chunkQuads: 8 }));
        const rock = model('rock');
        const onTerrain = model('placed on the landscape');
        landscape.addChild(onTerrain);
        scene.addNode(landscape);
        scene.addNode(rock);

        expect(landscape.chunkNodes.length).toBeGreaterThan(1);
        const models = [...scene.models];
        const rest = [...scene.modelsExceptTerrain];
        expect(models.length).toBe(rest.length + landscape.chunkNodes.length);
        expect(rest).toEqual(models.filter(m => !m.isTerrainChunk));
        expect(rest).toContain(rock);
        expect(rest).toContain(onTerrain);

        const tree = model('tree');
        scene.addNode(tree);
        expect([...scene.modelsExceptTerrain]).toContain(tree);
        expect([...scene.models]).toContain(tree);
    });
});
