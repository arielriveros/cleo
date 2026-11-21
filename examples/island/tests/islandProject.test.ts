import { EXAMPLE, REPO_ROOT, dataReady, exampleDir, exampleScript, readThisExample } from '@tools/exampleKit/testKit';
import { describe, it, expect, beforeAll } from 'vitest';
import { setGLContext } from '@engine/graphics/rhi/webgl2/glContext';
import { WebGL2Device } from '@engine/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '@engine/graphics/rhi/deviceHandle';
import { existsSync } from 'fs';
import { join } from 'path';
import '@engine-tests/helpers/features';
import { Scene } from '@engine/core/scene/scene';
import { Node } from '@engine/core/scene/nodes/node';
import { parseNodeJson } from '@engine/core/scene/nodes/parseNodeJson';
import { WaterVolumeNode } from '@engine/core/scene/nodes/waterVolumeNode';
import { GiBakeRegistry } from '@engine/graphics/render/gi/giBakeRegistry';
import { decodeWaterBake } from '@engine/water/bake/waterBakeFormat';
import { read } from '@tools/valley/bundleOps';

// The Island example's water (tools/island/build.ts): one Water node per body, the rivers joined to their
// lake and the sea, and every bake it ships CURRENT against the scene as the editor will load it, with the
// landscape's saved heights and the scene's static colliders. A bake that does not match its node's
// signature is silently dropped for the analytic flow, which is what this guards against.

const PROJECT = EXAMPLE;
const present = dataReady(PROJECT);

// A stand-in GL device (as tests/foliageRuleRekey.test.ts): the landscape builds its chunk meshes on load.
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

describe.skipIf(!present)('the Island example’s water', { timeout: 120_000 }, () => {
    it('ships one node per body, rivers joined, and every bake current', async () => {
        const bundle = await read(PROJECT);
        const sceneJson = (Object.values(bundle.scenes)[0] as any).scene;
        const all: any[] = [];
        const walk = (n: any) => { all.push(n); for (const c of n.children ?? []) walk(c); };
        walk(sceneJson);
        // The scene, as far as the water's bake depends on it: the landscape, the water and the static colliders.
        const scene = new Scene();
        const holder = new Node('holder');
        scene.addNode(holder);
        for (const json of all.filter(n => n.type === 'landscape' || n.type === 'waterVolume' || n.type === 'collider')) {
            parseNodeJson(holder, JSON.parse(JSON.stringify({ ...json, children: [] })));
        }
        holder.updateTransforms();
        // Loading the heights and saving them again gives the very same 16-bit heights the tool keyed its bakes on.
        const land = all.find(n => n.type === 'landscape');
        const terrain = [...scene.landscapes][0].terrain!;
        const saved = new Uint16Array(new Uint8Array(Buffer.from(land.terrain.heights, 'base64')).buffer);
        const q = terrain.quantizedHeights();
        let differ = 0;
        for (let i = 0; i < saved.length; i++) if (saved[i] !== q.u16[i]) differ++;
        expect(differ).toBe(0);
        const waters = holder.children.filter((n): n is WaterVolumeNode => n instanceof WaterVolumeNode);
        expect(waters.every(w => !(w as any).waterBody?.shapes)).toBe(true);
        const types = waters.map(w => w.waterType);
        expect(types.filter(t => t === 'ocean')).toHaveLength(1);
        expect(types.filter(t => t === 'river').length).toBeGreaterThanOrEqual(2);
        const rivers = waters.filter(w => w.waterType === 'river');
        expect(rivers.every(r => r.flowsInto !== null)).toBe(true);
        for (const b of bundle.giBakes ?? []) GiBakeRegistry.set(b.id, new Uint8Array(b.bytes));
        const baked = waters.filter(w => w.bakeId);
        expect(baked.length).toBeGreaterThanOrEqual(rivers.length);
        for (const w of baked) {
            const decoded = decodeWaterBake(GiBakeRegistry.get(w.bakeId!)!, w.bakeId!);
            expect(decoded, w.name).not.toBeNull();
            expect(decoded!.signature, `${w.name}'s bake`).toBe(w.bakeSignature());
        }
        for (const b of bundle.giBakes ?? []) GiBakeRegistry.delete(b.id);
    });
});
