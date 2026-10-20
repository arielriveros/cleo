import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';

// A despawn during play dissolves, like a foliage LOD change, before the node actually goes. These pin
// the lifecycle around that: when onDespawn fires, what `immediate` and authoring do, and that a fade
// carries down a subtree.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

const FRAME = 1 / 60;
function run(scene: Scene, seconds: number) {
    for (let t = 0; t < seconds; t += FRAME) scene.update(FRAME, 0, false);
}

function world() {
    const scene = new Scene();
    const actor = new CharacterNode('actor');
    scene.addNode(actor);
    scene.start();
    return { scene, actor };
}

describe('gradual despawn', () => {
    it('dissolves over despawnFadeSeconds, then removes, firing onDespawn at the end', () => {
        const { scene, actor } = world();
        let despawned = 0;
        actor.onDespawn = () => { despawned++; };
        actor.remove();
        expect(actor.isDespawning).toBe(true);
        expect(actor.spawned).toBe(true);

        run(scene, scene.despawnFadeSeconds / 2);
        expect(actor.despawnFade).toBeGreaterThan(0.3);
        expect(actor.despawnFade).toBeLessThan(0.7);
        expect(despawned).toBe(0);

        run(scene, scene.despawnFadeSeconds / 2 + 0.1);
        expect(despawned).toBe(1);
        expect(actor.markForRemoval).toBe(true);
    });

    it('skips the dissolve when asked, in authoring, and for a subtree with nothing to draw', () => {
        const { scene, actor } = world();
        actor.remove({ immediate: true });
        expect(actor.markForRemoval).toBe(true);

        const empty = new Node('logic');
        scene.addNode(empty);
        empty.remove();
        expect(empty.markForRemoval).toBe(true);

        const other = new CharacterNode('other');
        scene.addNode(other);
        CleoEngine.authoringMode = true;
        other.remove();
        expect(other.markForRemoval).toBe(true);
    });

    it('carries a parent fade to its children, and honours a custom duration', () => {
        const { scene, actor } = world();
        const child = new CharacterNode('child');
        actor.addChild(child);
        actor.despawn({ fade: 2 });
        run(scene, 1);
        expect(child.effectiveFade).toBeCloseTo(actor.despawnFade, 5);
        expect(actor.despawnFade).toBeGreaterThan(0.4);
        expect(actor.despawnFade).toBeLessThan(0.6);
        run(scene, 1.1);
        expect(actor.spawned).toBe(false);
        expect(actor.markForRemoval).toBe(false);
        expect(actor.despawnFade).toBe(1);
    });

    it('is cancelled by spawn, and upgraded to a removal by a later remove', () => {
        const { scene, actor } = world();
        actor.despawn();
        run(scene, 0.2);
        actor.spawn();
        expect(actor.isDespawning).toBe(false);
        expect(actor.effectiveFade).toBe(1);
        run(scene, 1);
        expect(actor.spawned).toBe(true);

        actor.despawn();
        actor.remove();
        run(scene, scene.despawnFadeSeconds + 0.1);
        expect(actor.markForRemoval).toBe(true);
    });

    it('round-trips a non-default despawnFadeSeconds through the scene file', async () => {
        const scene = new Scene();
        scene.despawnFadeSeconds = 2.5;
        const json = await scene.serialize(true);
        const back = new Scene();
        back.parse(json, true);
        expect(back.despawnFadeSeconds).toBe(2.5);
    });
});
