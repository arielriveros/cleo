import { describe, it, expect } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';

/**
 * Scene.dispose() cuts the scene's node graph apart (Scene._severNodeGraph). A scene left by Game.loadScene is
 * often still reachable through ONE node — a script callback never removed (every closure a node script makes
 * holds its node), a leftover listener, a cache — and through that node's parent, children and scene links it
 * kept every node and every mesh of the scene alive. Cut, the holder keeps that node and nothing else.
 *
 * The cut must also be silent: no onDespawn, no SCENE_CHANGED per node, which the editor's tree, history and
 * the game UI would all act on for a scene nobody plays any more.
 */

/** A small scene: a group holding a leaf, a sibling, a dormant node, and a timer pending on the leaf. */
function build() {
    const scene = new Scene();
    const group = new Node('group');
    const leaf = new Node('leaf');
    const sibling = new Node('sibling');
    const dormant = new Node('dormant');
    group.addChild(leaf);
    scene.addNode(group);
    scene.addNode(sibling);
    scene.addNode(dormant);
    dormant.despawn();
    return { scene, group, leaf, sibling, dormant };
}

describe('Scene.dispose cuts its node graph', () => {
    it('leaves every node without parent, children or scene, and the scene with an empty root', () => {
        const { scene, group, leaf, sibling, dormant } = build();
        const before = [scene.root, group, leaf, sibling, dormant];
        expect(scene.getNodeById(leaf.id)).toBe(leaf);

        scene.dispose();

        for (const node of before) {
            expect(node.parent, node.name).toBeNull();
            expect(node.children, node.name).toHaveLength(0);
            expect(node.scene, node.name).toBeNull();
        }
        expect(scene.root).toBeDefined();
        expect(scene.root.children).toHaveLength(0);
        // Names, not nodes: a failure must not print a whole scene.
        expect([...scene.nodes].filter(n => n !== scene.root).map(n => n.name)).toEqual([]);
        expect(scene.getNodeById(leaf.id) === undefined).toBe(true);
        expect(scene.getNodeById(dormant.id) === undefined).toBe(true);
    });

    it('drops pending timers, so a callback of the left scene never runs', () => {
        const { scene, leaf } = build();
        let fired = 0;
        leaf.after(0.5, () => fired++);
        scene.dispose();
        (scene as any)._updateTimers(10);
        expect(fired).toBe(0);
        expect((scene as any)._timers).toHaveLength(0);
    });

    it('is silent: no SCENE_CHANGED, no onDespawn', () => {
        const { scene, leaf, sibling } = build();
        let despawned = 0;
        leaf.onDespawn = () => { despawned++; };
        sibling.onDespawn = () => { despawned++; };
        const events: unknown[] = [];
        const listener = (e: unknown) => events.push(e);
        CleoEngine.eventEmitter.on('SCENE_CHANGED', listener);
        try { scene.dispose(); }
        finally { CleoEngine.eventEmitter.off('SCENE_CHANGED', listener); }
        expect(events).toEqual([]);
        expect(despawned).toBe(0);
    });

    it('can run twice', () => {
        const { scene } = build();
        scene.dispose();
        expect(() => scene.dispose()).not.toThrow();
        expect(scene.root.children).toHaveLength(0);
    });

    it.skipIf(typeof (globalThis as any).gc !== 'function')(
        'lets the rest of the scene go while something still holds one node',
        async () => {
            // Built and disposed in a function of its own, so only `kept` and the WeakRefs outlive it.
            const { kept, refs } = (() => {
                const { scene, group, leaf, sibling } = build();
                (sibling as any).payload = new Float32Array(1 << 20); // a mesh's worth of data
                scene.dispose();
                return { kept: leaf, refs: { scene: new WeakRef(scene), group: new WeakRef(group), sibling: new WeakRef(sibling) } };
            })();
            // A WeakRef keeps its target until the job that made it ends.
            await new Promise(resolve => setTimeout(resolve, 0));
            (globalThis as any).gc();
            (globalThis as any).gc();
            expect(kept.name).toBe('leaf');
            // Booleans: a failure that printed the retained scene would print every node in it.
            expect(refs.scene.deref() === undefined, 'the scene').toBe(true);
            expect(refs.group.deref() === undefined, "the leaf's parent").toBe(true);
            expect(refs.sibling.deref() === undefined, 'a sibling and its data').toBe(true);
        },
    );
});
