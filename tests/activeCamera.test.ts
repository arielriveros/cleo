import { describe, it, expect } from 'vitest';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { Camera } from '../src/core/camera';
import { CameraNode } from '../src/core/scene/nodes/cameraNode';

// A host (the editor) renders its viewport through a camera of its own, sitting in the same scene as the
// cameras the user authors. Without a pin the winner is whichever active camera comes first in
// breadth-first order — so a game camera loaded from a saved scene outranked the editor camera appended
// after it, and the viewport both rendered through the game camera and dragged it around. These pin the
// contract that made authored cameras independent of the viewport again.

const makeCamera = (name: string) => new CameraNode(name, new Camera({}));

describe('Scene.activeCamera', () => {
    it('picks the first active camera in breadth-first order when nothing is pinned', () => {
        const scene = new Scene();
        const first = makeCamera('first');
        const second = makeCamera('second');
        scene.addNode(first);
        scene.addNode(second);

        expect(scene.activeCamera).toBe(first);

        first.active = false;
        expect(scene.activeCamera).toBe(second);
    });

    it('prefers a nested pinned camera over an active one earlier in the tree', () => {
        const scene = new Scene();
        const game = makeCamera('game');       // a root camera, parsed in before the host's own
        scene.addNode(game);
        const pivot = new Node('pivot');
        const viewport = makeCamera('viewport');
        pivot.addChild(viewport);
        scene.addNode(pivot);

        expect(scene.activeCamera).toBe(game);

        scene.setActiveCamera(viewport);
        expect(scene.activeCamera).toBe(viewport);

        // ...and the game camera stays a normal, untouched scene node: still active, still there.
        expect(game.active).toBe(true);
    });

    it('falls back to the scan when the pinned camera is deactivated or leaves the scene', () => {
        const scene = new Scene();
        const game = makeCamera('game');
        const viewport = makeCamera('viewport');
        scene.addNode(game);
        scene.addNode(viewport);
        scene.setActiveCamera(viewport);
        expect(scene.activeCamera).toBe(viewport);

        viewport.active = false;
        expect(scene.activeCamera).toBe(game);

        viewport.active = true;
        scene.removeNode(viewport);
        expect(scene.activeCamera).toBe(game);
    });

    it('clears the pin on parse, whose incoming tree makes it stale', () => {
        const scene = new Scene();
        const viewport = makeCamera('viewport');
        scene.addNode(viewport);
        scene.setActiveCamera(viewport);

        scene.parse({ scene: { name: 'root', type: 'node', children: [] }, textures: [] }, true);
        // The pinned node is not in the new tree; nothing survives to hold the view hostage.
        expect(scene.activeCamera).toBeUndefined();

        const game = makeCamera('game');
        scene.addNode(game);
        expect(scene.activeCamera).toBe(game);
    });
});
