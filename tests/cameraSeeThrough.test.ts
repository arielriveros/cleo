import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../src/core/engine';
import { Node } from '../src/core/scene/nodes/node';
import { CameraRigNode } from '../src/core/scene/nodes/cameraRigNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { ColliderNode } from '../src/core/scene/nodes/colliderNode';
import { ModelNode } from '../src/core/scene/nodes/modelNode';
import { MaterialBinder } from '../src/graphics/render/materialBinder';
import { ALL_LAYERS, DEFAULT_CAMERA_BLOCKED_BY, LAYER } from '../src/physics/collisionLayers';

// A camera rig's See through layers: instead of pulling the camera in, the renderer cuts a dithered see-through
// hole into the meshes of the Colliders on those layers (and foliage whose collision is on one). Pinned here: the
// authored state survives a save, a scene saved with the old per-node flags lands on the layers that do what they
// did, and every fragment stage that can draw an opted-in surface actually runs the hole test — a stage that
// forgets it draws that object solid, silently.

async function roundTrip(node: Node): Promise<Node> {
    const json = await node.serialize();
    const parent = new Node('parent');
    parseNodeJson(parent, json);
    return parent.children[0];
}

describe('camera rig layers', () => {
    it('round-trips Blocked by, See through and the hole', async () => {
        const rig = new CameraRigNode('rig');
        rig.collisionLayers = LAYER.DEFAULT | 32;
        rig.seeThroughLayers = LAYER.SEE_THROUGH | 64;
        rig.ditherRadius = 1.6;
        rig.ditherStrength = 0.5;
        const json: any = await rig.serialize();
        expect(json.collisionMode).toBeUndefined();
        const back = await roundTrip(rig) as CameraRigNode;
        expect(back.collisionLayers).toBe(LAYER.DEFAULT | 32);
        expect(back.seeThroughLayers).toBe(LAYER.SEE_THROUGH | 64);
        expect(back.ditherRadius).toBeCloseTo(1.6);
        expect(back.ditherStrength).toBeCloseTo(0.5);
    });

    it('starts blocked by all but See Through and No Camera, seeing through See Through', () => {
        const rig = new CameraRigNode('rig');
        expect(rig.collisionLayers).toBe(DEFAULT_CAMERA_BLOCKED_BY);
        expect(rig.collisionLayers & LAYER.DEFAULT).not.toBe(0);
        expect(rig.collisionLayers & (LAYER.SEE_THROUGH | LAYER.NO_CAMERA)).toBe(0);
        expect(rig.seeThroughLayers).toBe(LAYER.SEE_THROUGH);
    });

    it('reads a rig saved with a collision mode as the layers that did what it did', async () => {
        const parse = (mode: unknown) => {
            const parent = new Node('parent');
            parseNodeJson(parent, { type: 'cameraRig', name: 'rig', id: `rig-${String(mode)}`, children: [], collisionMode: mode });
            return parent.children[0] as CameraRigNode;
        };
        // Dither: pulled in for all but what opted in (on See Through now) and what it passed (No Camera).
        const dither = parse('dither');
        expect(dither.collisionLayers).toBe(DEFAULT_CAMERA_BLOCKED_BY);
        expect(dither.seeThroughLayers).toBe(LAYER.SEE_THROUGH);
        // Retract: pulled in for every solid body, the opted-in ones too; sees through nothing.
        for (const mode of ['retract', 'teleport', undefined]) {
            const rig = parse(mode);
            expect(rig.collisionLayers, String(mode)).toBe(ALL_LAYERS & ~LAYER.NO_CAMERA);
            expect(rig.seeThroughLayers, String(mode)).toBe(0);
        }
    });
});

describe('colliders saved with the old camera channels', () => {
    const parse = (json: any) => {
        const parent = new Node('parent');
        parseNodeJson(parent, json);
        return parent.children[0];
    };
    const collider = (id: string, extra: any = {}, settings: any = {}, children: any[] = []) => ({
        type: 'collider', name: id, id, children, ...extra,
        collider: { mass: 0, shapes: [{ type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }], ...settings },
    });
    const mesh = (id: string, extra: any = {}, children: any[] = []) => ({ type: 'node', name: id, id, children, ...extra });

    it('moves a see-through collider, or one holding a see-through mesh, onto See Through', () => {
        expect((parse(collider('a', { cameraDither: true })) as ColliderNode).layer).toBe(LAYER.SEE_THROUGH);
        expect((parse(collider('b', {}, {}, [mesh('m', {}, [mesh('n', { cameraDither: true })])])) as ColliderNode).layer).toBe(LAYER.SEE_THROUGH);
    });

    it('moves one the camera passed through onto No Camera', () => {
        expect((parse(collider('c', {}, { cameraCollision: false })) as ColliderNode).layer).toBe(LAYER.NO_CAMERA);
        expect((parse(collider('d', {}, { cameraCollision: true })) as ColliderNode).layer).toBe(LAYER.DEFAULT);
    });

    it('keeps a layer of its own, and stops at a nested collider', () => {
        expect((parse(collider('e', { cameraDither: true }, { layer: 32 })) as ColliderNode).layer).toBe(32);
        const outer = parse(collider('f', {}, {}, [collider('g', { cameraDither: true })])) as ColliderNode;
        expect(outer.layer).toBe(LAYER.DEFAULT);
        expect((outer.children[0] as ColliderNode).layer).toBe(LAYER.SEE_THROUGH);
    });

    it('saves no camera flags', async () => {
        const node = parse(collider('h', { cameraDither: true }, { cameraCollision: false }, [mesh('m', { cameraDither: true })]));
        const json: any = await node.serialize();
        expect(json.cameraDither).toBeUndefined();
        expect(json.collider.cameraCollision).toBeUndefined();
        expect(json.children[0].cameraDither).toBeUndefined();
        expect(json.collider.layer).toBe(LAYER.SEE_THROUGH);
    });
});

describe('what the hole cuts', () => {
    // The opt-in alone, without a renderer: it reads only the seen-through layers.
    const optIn = (layers: number, node: Node) => MaterialBinder.prototype.holeOptIn.call({ _camHoleLayers: layers } as any, node);

    it('cuts the meshes of a Collider on a seen-through layer, and nothing outside a Collider', () => {
        const pillar = new ColliderNode('pillar');
        pillar.layer = LAYER.SEE_THROUGH;
        const mesh = new ModelNode('mesh');
        const holder = new Node('holder');
        pillar.addChild(holder);
        holder.addChild(mesh);
        const wall = new ColliderNode('wall');
        const wallMesh = new ModelNode('wall mesh');
        wall.addChild(wallMesh);
        const loose = new ModelNode('loose');

        expect(optIn(LAYER.SEE_THROUGH, mesh)).toBe(true);
        expect(optIn(LAYER.SEE_THROUGH, wallMesh)).toBe(false);
        expect(optIn(LAYER.SEE_THROUGH | LAYER.DEFAULT, wallMesh)).toBe(true);
        expect(optIn(ALL_LAYERS, loose)).toBe(false);
        // A rig that sees through nothing cuts nothing.
        expect(optIn(0, mesh)).toBe(false);
    });
});

describe('the see-through hole in the shaders', () => {
    const SHADERS = join(__dirname, '../src/graphics/shaders/wgsl');
    const read = (name: string) => readFileSync(join(SHADERS, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    it('is tested by every fragment stage that runs the LOD dissolve', () => {
        for (const file of ['chunks/pbrGBuffer.wgsl', 'chunks/pbrForward.wgsl', 'chunks/blinnPhongGBuffer.wgsl',
                            'chunks/blinnPhongForward.wgsl', 'chunks/celForward.wgsl']) {
            const src = read(file);
            expect(src, file).toMatch(/lodFadeKeeps\(/);
            expect(src, file).toMatch(/cameraHoleKeeps\(in\.camHole, in\.camHoleParams/);
        }
    });

    it('is filled by every model vertex stage, after the final world position', () => {
        for (const file of ['chunks/modelVertex.wgsl', 'chunks/skinnedVertex.wgsl', 'chunks/instancedVertex.wgsl']) {
            const src = read(file);
            expect(src, file).toMatch(/u_camHole: vec4<f32>/);
            expect(src, file).toMatch(/u_camHole(Pivot|Pass): vec4<f32>/);
            expect(src, file).toMatch(/cameraHoleVarying\(&out/);
        }
        // Wind moves fragPos, so the hole must be computed from the moved position.
        const inst = read('chunks/instancedVertex.wgsl');
        expect(inst.indexOf('cameraHoleVarying(')).toBeGreaterThan(inst.indexOf('windDisplace('));
    });
});
