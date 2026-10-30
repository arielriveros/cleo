import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../src/core/engine';
import { Node } from '../src/core/scene/nodes/node';
import { CameraRigNode } from '../src/core/scene/nodes/cameraRigNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';

// The camera rig's 'dither' collision mode: instead of pulling the camera in, the renderer cuts a
// dithered see-through hole into whatever opted in (Node.cameraDither, a foliage rule's cameraDither).
// Pinned here: the authored state survives a save, and every fragment stage that can draw an opted-in
// surface actually runs the hole test — a stage that forgets it draws that object solid, silently.

async function roundTrip(node: Node): Promise<Node> {
    const json = await node.serialize();
    const parent = new Node('parent');
    parseNodeJson(parent, json);
    return parent.children[0];
}

describe('camera rig dither mode', () => {
    it('round-trips the collision mode and the hole', async () => {
        const rig = new CameraRigNode('rig');
        rig.collisionMode = 'dither';
        rig.ditherRadius = 1.6;
        rig.ditherStrength = 0.5;
        const back = await roundTrip(rig) as CameraRigNode;
        expect(back.collisionMode).toBe('dither');
        expect(back.ditherRadius).toBeCloseTo(1.6);
        expect(back.ditherStrength).toBeCloseTo(0.5);
    });

    it('defaults to retract, and reads an unknown mode as retract', async () => {
        const rig = new CameraRigNode('rig');
        expect(rig.collisionMode).toBe('retract');
        const json: any = await rig.serialize();
        json.collisionMode = 'teleport';
        const parent = new Node('parent');
        parseNodeJson(parent, json);
        expect((parent.children[0] as CameraRigNode).collisionMode).toBe('retract');
    });
});

describe('Node.cameraDither', () => {
    it('round-trips, and is left out of the JSON when off', async () => {
        const node = new Node('pillar');
        expect((await node.serialize() as any).cameraDither).toBeUndefined();
        node.cameraDither = true;
        expect((await roundTrip(node)).cameraDither).toBe(true);
    });

    it('fans out to descendants, like motion blur', () => {
        const root = new Node('pillars');
        const child = new Node('pillar');
        root.addChild(child);
        root.cameraDither = true;
        expect(child.cameraDither).toBe(true);
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
            expect(src, file).toMatch(/u_camHolePivot: vec4<f32>/);
            expect(src, file).toMatch(/cameraHoleVarying\(&out/);
        }
        // Wind moves fragPos, so the hole must be computed from the moved position.
        const inst = read('chunks/instancedVertex.wgsl');
        expect(inst.indexOf('cameraHoleVarying(')).toBeGreaterThan(inst.indexOf('windDisplace('));
    });
});
