import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mat4, vec3, vec4 } from 'gl-matrix';
import { Camera, CameraNode, Node } from '../src/cleo';
import { ViewProjection } from '../src/graphics/render/viewProjection';

/**
 * A viewmodel (arms and a weapon under the player's camera) is drawn through the ordinary projection of a point
 * on the same view ray: a narrower lens magnifies it about the axis, and the depth share pulls it toward the
 * camera. Everything downstream (lighting, shadows, SSIL...) reconstructs a position from the depth it wrote,
 * so the properties pinned here are what keep the weapon lit as the place it appears to be.
 */

describe('viewmodel flag', () => {
    it('is off, and absent from the JSON, by default', async () => {
        const root = new Node('root');
        const n = new Node('n');
        root.addChild(n);
        expect(n.viewmodel).toBe(false);
        expect(await n.serialize()).not.toHaveProperty('viewmodel');
    });

    it('fans out to children and survives a save', async () => {
        const root = new Node('root');
        const parent = new Node('arms');
        const child = new Node('weapon');
        root.addChild(parent);
        parent.addChild(child);
        parent.viewmodel = true;
        expect(child.viewmodel).toBe(true);
        const json = await parent.serialize();
        expect(json.viewmodel).toBe(true);
        const back = new Node('root');
        Node.parse(back, json);
        expect(back.children[0].viewmodel).toBe(true);
    });
});

describe('camera viewmodel lens', () => {
    const make = () => {
        const root = new Node('root');
        const cam = new CameraNode('cam', new Camera({ type: 'perspective', fov: 80 }));
        root.addChild(cam);
        return cam;
    };

    it('writes nothing for a camera that sets no viewmodel lens', async () => {
        expect((await make().serialize()).camera).not.toHaveProperty('viewmodelFov');
    });

    it('round-trips the lens, and keeps the depth share out of the file', async () => {
        const cam = make();
        cam.viewmodelFov = 55;
        cam.viewmodelDepth = 0.4;
        const json = await cam.serialize();
        expect(json.camera.viewmodelFov).toBe(55);
        expect(JSON.stringify(json)).not.toContain('viewmodelDepth');
        const root = new Node('root');
        CameraNode.parse(root, json);
        expect((root.children[0] as CameraNode).viewmodelFov).toBe(55);
    });

    it('has no matrix when nothing is set', () => {
        expect(make().camera.viewmodelMatrix).toBeNull();
    });
});

describe('viewmodel projection', () => {
    const camera = new Camera({ type: 'perspective', fov: 80, near: 0.1, far: 500 });
    const project = (m: mat4, p: vec3) => {
        const c = vec4.transformMat4(vec4.create(), [p[0], p[1], p[2], 1], m);
        return [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
    };
    const matrixFor = (fov: number, depth: number) => {
        camera.viewmodelFov = fov;
        camera.viewmodelDepth = depth;
        const d = camera.viewmodelMatrix!;
        return mat4.multiply(mat4.create(), camera.projectionMatrix, d);
    };

    it('the depth share leaves the screen position alone and brings the depth forward', () => {
        camera.viewmodelFov = 0; camera.viewmodelDepth = 1;
        const plain = camera.projectionMatrix;
        const squeezed = matrixFor(0, 0.4);
        const p: vec3 = [0.3, -0.2, -0.9];
        const a = project(plain, p), b = project(squeezed, p);
        expect(b[0]).toBeCloseTo(a[0], 6);
        expect(b[1]).toBeCloseTo(a[1], 6);
        expect(b[2]).toBeLessThan(a[2]);
        // And that depth is exactly the plain projection's of the point drawn at 0.4 of its distance.
        const nearer = project(plain, [p[0] * 0.4, p[1] * 0.4, p[2] * 0.4]);
        expect(b[2]).toBeCloseTo(nearer[2], 6);
    });

    it('a narrower lens magnifies about the axis by the ratio of the lenses', () => {
        camera.viewmodelFov = 0; camera.viewmodelDepth = 1;
        const plain = camera.projectionMatrix;
        const narrow = matrixFor(55, 1);
        const p: vec3 = [0.25, 0.1, -1];
        const a = project(plain, p), b = project(narrow, p);
        const f = Math.tan(80 * Math.PI / 360) / Math.tan(55 * Math.PI / 360);
        expect(b[0] / a[0]).toBeCloseTo(f, 6);
        expect(b[1] / a[1]).toBeCloseTo(f, 6);
        expect(b[2]).toBeCloseTo(a[2], 6);
    });

    it('the renderer draws a viewmodel through ViewProjection.viewmodelProjection', () => {
        const src = readFileSync(join(__dirname, '..', 'src', 'graphics', 'render', 'modelDraw.ts'), 'utf8');
        expect(src).toContain('node.viewmodel');
        expect(src).toContain('viewmodelProjection');
        expect(typeof ViewProjection.prototype.viewmodelProjection).toBe('function');
    });

    it('casts no shadow: the shadow pass gathers no viewmodel node', () => {
        const src = readFileSync(join(__dirname, '..', 'src', 'graphics', 'render', 'shadows.ts'), 'utf8').replace(/\r\n/g, '\n');
        expect(src).toMatch(/isEditorOnlyNode\(node\)\) continue;[\s\S]{0,400}if \(node\.viewmodel\) continue;/);
    });
});
