import { describe, expect, it } from 'vitest';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { ParticleSystemNode } from '../src/core/scene/nodes/particleSystemNode';
import { CameraNode } from '../src/core/scene/nodes/cameraNode';
import { DecalNode } from '../src/core/scene/nodes/decalNode';
import { PointLight } from '../src/graphics/lighting';

// The scene's typed lists are built in one pass from a per-class bitmask (scene.ts `kindsOf`) instead of a ladder of
// `instanceof` tests per node. A subclass must still land in its parent's list, and every list must keep tree order.

class Torch extends LightNode {}

describe('Scene typed lists', () => {
    it('sorts nodes into their lists in tree order, subclasses included', () => {
        const scene = new Scene();
        const group = new Node('group');
        const a = new LightNode('a', new PointLight({ diffuse: [1, 1, 1] }));
        const b = new Torch('b', new PointLight({ diffuse: [1, 1, 1] }));
        const smoke = new ParticleSystemNode('smoke');
        const cam = new CameraNode('cam');
        const decal = new DecalNode('decal');
        group.addChild(a);
        group.addChild(smoke);
        scene.root.addChild(group);
        scene.root.addChild(b);
        scene.root.addChild(cam);
        scene.root.addChild(decal);

        expect(new Set(scene.lights)).toEqual(new Set([a, b]));
        expect([...scene.particleSystems]).toEqual([smoke]);
        expect(scene.activeCamera).toBe(cam);
        expect([...scene.decals]).toEqual([decal]);
        expect(scene.models.size).toBe(0);
        // Breadth first: the root's own children before the group's.
        expect([...scene.lights][0]).toBe(b);
    });

    it('follows a structural change', () => {
        const scene = new Scene();
        const smoke = new ParticleSystemNode('smoke');
        scene.root.addChild(smoke);
        expect(scene.particleSystems.size).toBe(1);
        smoke.remove({ immediate: true });
        expect(scene.particleSystems.size).toBe(0);
    });
});
