import { describe, it, expect } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript } from '../src/core/scripting/scriptRuntime';
import '../src/cleo';   // registers the 'cleo' module a script's `import ... from 'cleo'` resolves to
import { Scene } from '../src/core/scene/scene';
import { cloneNodeJson, regenerateNodeIds } from '../src/core/scene/nodeJson';

// The spawn lifecycle is easy to get subtly wrong (a handler that fires twice, a subtree that only half
// wakes up), and every symptom of that shows up as gameplay weirdness rather than a crash. These pin the
// contract: who fires, how often, and what a dormant node is still allowed to be.

/** A node that counts every lifecycle handler it receives. */
class Counting extends Node {
    public counts = { start: 0, spawn: 0, despawn: 0, update: 0 };
    public onStart(): void { this.counts.start++; }
    public onSpawn(): void { this.counts.spawn++; }
    public onDespawn(): void { this.counts.despawn++; }
    public onUpdate(): void { this.counts.update++; }
}

/** A started scene holding `parent > child`, both counting. */
function sceneWith(spawnOnStart: boolean) {
    const scene = new Scene();
    const parent = new Counting('parent');
    const child = new Counting('child');
    parent.addChild(child);
    parent.spawnOnStart = spawnOnStart;
    scene.addNode(parent);
    scene.start();
    return { scene, parent, child };
}

describe('spawnOnStart', () => {
    it('starts a flagged node dormant, without running onStart anywhere in its subtree', () => {
        const { scene, parent, child } = sceneWith(false);

        expect(parent.spawned).toBe(false);
        expect(child.spawned).toBe(false);
        expect(parent.counts.start).toBe(0);
        expect(child.counts.start).toBe(0);
        // It never spawned, so there is nothing to tear down — onDespawn must NOT fire.
        expect(parent.counts.despawn).toBe(0);
        expect(scene.nodes.has(parent)).toBe(false);
    });

    it('defaults to spawning, so a scene that never touches the flag is unchanged', () => {
        const { scene, parent, child } = sceneWith(true);
        expect(parent.spawned).toBe(true);
        expect(parent.counts.start).toBe(1);
        expect(child.counts.start).toBe(1);
        expect(scene.nodes.has(parent)).toBe(true);
    });

    it('drops the node from the scene lists even when they were already built before start', () => {
        const scene = new Scene();
        const crate = new Counting('crate');
        crate.spawnOnStart = false;
        scene.addNode(crate);

        // The play bootstrap does exactly this: setScene() runs an update and the renderer draws frames
        // before the deferred scene.start() fires, so the cached lists exist — holding the node as ACTIVE.
        expect(scene.nodes.has(crate)).toBe(true);

        scene.start();

        // Scene only rebuilds its lists on a structural change. Without one, a node despawned by start()
        // stays in scene.models and keeps rendering, despawned in name only.
        expect(crate.spawned).toBe(false);
        expect(scene.nodes.has(crate)).toBe(false);
    });

    it('keeps a dormant node findable by name and id — the only way back for it', () => {
        const { scene, parent, child } = sceneWith(false);
        expect(scene.findNode('parent')).toBe(parent);
        expect(scene.getNodeById(child.id)).toBe(child);
        // ...but out of the type-filtered lists, which is what stops the renderer and physics reaching it.
        expect(scene.nodes.has(child)).toBe(false);
    });

    it('survives serialize -> parse, and applies at parse rather than at start', async () => {
        const editor = new Scene();
        editor.spawnRulesEnabled = false;
        const crate = new Node('crate');
        editor.addNode(crate);
        editor.start();
        crate.spawnOnStart = false;          // toggled in the inspector, on a live scene

        const json = await editor.serialize(true);
        expect(json.scene.children[0].spawnOnStart).toBe(false);

        const play = new Scene();
        play.parse(json, true);

        // BEFORE start(): both bootstraps defer that behind a timeout and render in the meantime, so a node
        // the game has not spawned must already be out of the lists here.
        expect(play.findNode('crate')!.spawned).toBe(false);
        expect(play.nodes.has(play.findNode('crate')!)).toBe(false);

        play.start();
        expect(play.findNode('crate')!.spawned).toBe(false);
    });

    it('is ignored on an editing scene (spawnRulesEnabled = false)', () => {
        const scene = new Scene();
        scene.spawnRulesEnabled = false;
        const node = new Counting('node');
        node.spawnOnStart = false;
        scene.addNode(node);
        scene.start();

        expect(node.spawned).toBe(true);
        expect(node.counts.start).toBe(1);
    });
});

describe('spawn / despawn', () => {
    it('wakes a dormant subtree, running onStart exactly once across repeated cycles', () => {
        const { parent, child } = sceneWith(false);

        parent.spawn();
        expect(parent.spawned).toBe(true);
        expect(child.spawned).toBe(true);
        expect(parent.counts.start).toBe(1);
        expect(child.counts.start).toBe(1);

        parent.despawn();
        parent.spawn();
        // onStart is once-per-node-lifetime; onSpawn is once per life.
        expect(parent.counts.start).toBe(1);
        expect(parent.counts.despawn).toBe(1);
        expect(parent.counts.spawn).toBeGreaterThan(1);
    });

    it('leaves a nested dormant node asleep when its parent is spawned', () => {
        const scene = new Scene();
        const spawner = new Counting('spawner');
        const bullet = new Counting('bullet');
        spawner.addChild(bullet);
        spawner.spawnOnStart = false;
        bullet.spawnOnStart = false;
        scene.addNode(spawner);
        scene.start();

        spawner.spawn();
        // Waking a spawner must not fire every projectile parked under it: the child keeps its own flag.
        expect(spawner.spawned).toBe(true);
        expect(bullet.spawned).toBe(false);
        expect(bullet.counts.start).toBe(0);

        bullet.spawn();
        expect(bullet.spawned).toBe(true);
        expect(bullet.counts.start).toBe(1);
    });

    it('fires onDespawn exactly once, across the whole subtree', () => {
        const { parent, child } = sceneWith(true);
        parent.despawn();
        expect(parent.counts.despawn).toBe(1);
        expect(child.counts.despawn).toBe(1);
    });

    it('does not re-despawn a descendant that was already asleep on its own', () => {
        const { parent, child } = sceneWith(true);
        child.despawn();
        expect(child.counts.despawn).toBe(1);

        parent.despawn();
        // The ancestor's walk must skip it: one sleep, one onDespawn.
        expect(child.counts.despawn).toBe(1);
        expect(parent.counts.despawn).toBe(1);
    });

    it('is idempotent: repeat calls in the same state do nothing', () => {
        const { parent } = sceneWith(true);
        parent.despawn();
        parent.despawn();
        expect(parent.counts.despawn).toBe(1);

        const spawns = parent.counts.spawn;
        parent.spawn();
        parent.spawn();
        expect(parent.counts.spawn).toBe(spawns + 1);
    });

    it('stops a despawned node being updated, and resumes it on spawn', () => {
        const { scene, parent } = sceneWith(true);
        scene.update(0.016, 0, false);
        const updates = parent.counts.update;
        expect(updates).toBeGreaterThan(0);

        parent.despawn();
        scene.update(0.016, 0, false);
        expect(parent.counts.update).toBe(updates);

        parent.spawn();
        scene.update(0.016, 0, false);
        expect(parent.counts.update).toBe(updates + 1);
    });

    it('cancels a despawned node\'s pending timers', () => {
        const { scene, parent } = sceneWith(true);
        let fired = 0;
        parent.every(0.1, () => { fired++; });

        scene.update(0.2, 0, false);
        expect(fired).toBe(1);

        parent.despawn();
        scene.update(1.0, 0, false);
        expect(fired).toBe(1);
    });

    it('delivers onDespawn once for remove(), not twice', () => {
        const { scene, parent } = sceneWith(true);
        parent.remove();
        // The Scene.update sweep unlinks it; it must not fire the handler a second time on the way out.
        scene.update(0.016, 0, false);

        expect(parent.counts.despawn).toBe(1);
        expect(scene.findNode('parent')).toBeUndefined();
    });

    it('still frees a node that was despawned before being removed', () => {
        const { scene, parent } = sceneWith(true);
        parent.despawn();
        parent.remove();
        scene.update(0.016, 0, false);

        expect(scene.findNode('parent')).toBeUndefined();
    });
});

describe('onStart scene access', () => {
    it('can reach the scene, so this.after/this.every schedule for real', () => {
        const scene = new Scene();
        let sceneInStart: unknown = 'not run';
        let cancel: (() => void) | null = null;

        class Timer extends Node {
            public onStart(): void {
                sceneInStart = this.scene;
                cancel = this.after(1, () => {});
            }
        }

        scene.addNode(new Timer('timer'));
        scene.start();

        expect(sceneInStart).toBe(scene);
        // A no-op canceller is what a null scene used to produce; a real one proves the timer was scheduled.
        expect(cancel).not.toBeNull();
    });
});

describe('cloneNodeJson', () => {
    it('copies typed arrays by value rather than turning them into objects', () => {
        const source = { model: { geometry: { positions: new Float32Array([1, 2, 3]) } } };
        const copy = cloneNodeJson(source);

        expect(copy.model.geometry.positions).toBeInstanceOf(Float32Array);
        expect([...copy.model.geometry.positions]).toEqual([1, 2, 3]);

        // Not shared: Geometry.scale writes positions IN PLACE, so two instances over one buffer would
        // deform each other.
        copy.model.geometry.positions[0] = 99;
        expect(source.model.geometry.positions[0]).toBe(1);
    });
});

describe('regenerateNodeIds', () => {
    it('renumbers the subtree, records where each node came from, and repoints internal refs', () => {
        const json = {
            id: 'rig', type: 'cameraRig', followId: 'target',
            children: [{ id: 'target', type: 'node', children: [] }],
        };
        const map = new Map<string, string>();
        regenerateNodeIds(json, map);

        expect(json.id).not.toBe('rig');
        expect((json as any).__sourceId).toBe('rig');
        // The rig must follow THIS instance's target, not the template's.
        expect(json.followId).toBe(json.children[0].id);
        expect(map.get('rig')).toBe(json.id);
    });

    it('leaves references to nodes outside the subtree alone', () => {
        const json = { id: 'rig', type: 'cameraRig', followId: 'the-player', children: [] };
        regenerateNodeIds(json, new Map());
        expect(json.followId).toBe('the-player');
    });
});

// The end-to-end shape a user actually writes: a class-based script, bound through the real compile ->
// factory -> native-binding pipeline (NOT a Node subclass, which bypasses all of it).
describe('a class script waking a dormant node', () => {
    const CRATE = `
import { Node } from 'cleo'
export default class C extends Node {
  onStart() { globalThis.__log.push('crate onStart'); }
  onSpawn() { globalThis.__log.push('crate onSpawn'); }
}`;
    const SPAWNER = `
import { Node } from 'cleo'
export default class S extends Node {
  onStart() { globalThis.__log.push('spawner onStart'); this.findNode('crate').spawn(); }
}`;

    /** Builds `crate` (dormant) + `spawner`, in either tree order, and starts the scene. */
    function run(spawnerFirst: boolean) {
        (globalThis as any).__log = [];
        const scene = new Scene();
        const crate = new Node('crate');
        crate.spawnOnStart = false;
        const spawner = new Node('spawner');
        if (spawnerFirst) { scene.addNode(spawner); scene.addNode(crate); }
        else { scene.addNode(crate); scene.addNode(spawner); }
        attachScriptFactory(crate, compileScript(CRATE));
        attachScriptFactory(spawner, compileScript(SPAWNER));
        scene.start();
        return { crate, log: (globalThis as any).__log as string[] };
    }

    // Tree order must not matter. It did: the walk settles dormancy node by node, so a spawner reached first
    // called spawn() on a node still flagged awake (a no-op) and the walk then put it to sleep behind it.
    it.each([[false, 'declared after the target'], [true, 'declared before the target']])(
        'wakes it and runs its onStart when the spawner is %s (%s)', (spawnerFirst) => {
            const { crate, log } = run(spawnerFirst as boolean);
            expect(crate.spawned).toBe(true);
            expect(log).toEqual(['spawner onStart', 'crate onSpawn', 'crate onStart']);
        });

    it('gives a class script a real this.findNode — it has no proxy to synthesize one', () => {
        // Class scripts run natively on the node, so the legacy script proxy's synthesized lookups are not
        // there. Without findNode/getNodeById/getNodesByName as real Node methods, the documented
        // `this.findNode('X').spawn()` is a TypeError in exactly the style users are told to write.
        const scene = new Scene();
        const crate = new Node('crate');
        scene.addNode(crate);
        expect(typeof (crate as any).findNode).toBe('function');
        expect(crate.findNode('crate')).toBe(crate);
        expect(crate.getNodeById(crate.id)).toBe(crate);
        expect(crate.getNodesByName('crate')).toEqual([crate]);
    });
});

// onConstruct is the one handler a dormant node receives, so it is where a node decides its own fate.
// These pin the pass order and the once-per-node/once-per-life guarantees.
describe('onConstruct', () => {
    const PLAIN = `
import { Node } from 'cleo'
export default class N extends Node {
  onConstruct() { globalThis.__log.push(this.name + ':construct:' + this.spawned) }
  onSpawn()     { globalThis.__log.push(this.name + ':spawn') }
  onStart()     { globalThis.__log.push(this.name + ':start') }
}`;
    const SELF = PLAIN.replace('this.spawned) }', 'this.spawned); this.spawn() }');

    const nodeJson = (id: string, name: string, script: string, dormant: boolean) => ({
        id, name, type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        variables: {}, children: [], script, ...(dormant ? { spawnOnStart: false } : {}),
    });

    function loadScene(children: any[]) {
        (globalThis as any).__log = [];
        const scene = new Scene();
        scene.parse({ scene: {
            id: 'r', name: 'root', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            variables: {}, children,
        }, textures: [] }, true);
        return scene;
    }

    it('runs for every node — dormant included — before any onSpawn or onStart', () => {
        const scene = loadScene([nodeJson('a', 'awake', PLAIN, false), nodeJson('d', 'dormant', PLAIN, true)]);

        // Nothing fires during parse: the tree is still being assembled and nested nodes cannot see the scene.
        expect((globalThis as any).__log).toEqual([]);

        scene.start();
        expect((globalThis as any).__log).toEqual([
            'awake:construct:true',
            'dormant:construct:false',   // the dormant node DOES get it, and can see that it is asleep
            'awake:spawn',
            'awake:start',
        ]);
        // ...and gets nothing else.
        expect(scene.findNode('dormant')!.spawned).toBe(false);
    });

    it('lets a dormant node spawn itself, receiving onSpawn and onStart exactly once', () => {
        const scene = loadScene([nodeJson('s', 'self', SELF, true)]);
        scene.start();

        expect(scene.findNode('self')!.spawned).toBe(true);
        expect((globalThis as any).__log).toEqual(['self:construct:false', 'self:spawn', 'self:start']);
    });

    it('fires once per node, and onSpawn once per life across despawn cycles', () => {
        const scene = loadScene([nodeJson('a', 'awake', PLAIN, false)]);
        scene.start();
        const node = scene.findNode('awake')!;
        (globalThis as any).__log = [];

        node.despawn();
        node.spawn();
        node.despawn();
        node.spawn();

        const log = (globalThis as any).__log as string[];
        expect(log.filter(l => l.startsWith('awake:construct')).length).toBe(0);  // never again
        expect(log.filter(l => l === 'awake:spawn').length).toBe(2);              // one per life
        expect(log.filter(l => l === 'awake:start').length).toBe(0);              // once per lifetime
    });

    it('fires for a node added to an already-running scene, before its onSpawn/onStart', () => {
        const scene = loadScene([]);
        scene.start();
        (globalThis as any).__log = [];

        const added = new Node('added');
        attachScriptFactory(added, compileScript(PLAIN));
        scene.addNode(added);

        expect((globalThis as any).__log).toEqual(['added:construct:true', 'added:spawn', 'added:start']);
    });
});

// The hierarchy case that reads as a bug but is not: a group flagged dormant whose CONTENTS are also
// flagged dormant. Spawning the group leaves them asleep, so nothing appears.
describe('spawning a group whose children are also flagged dormant', () => {
    function group(childDormant: boolean) {
        const scene = new Scene();
        const parent = new Counting('parent');
        const mesh = new Counting('mesh');
        parent.addChild(mesh);
        parent.spawnOnStart = false;
        if (childDormant) mesh.spawnOnStart = false;
        scene.addNode(parent);
        scene.start();
        return { scene, parent, mesh };
    }

    it('wakes a child left at the default', () => {
        const { parent, mesh } = group(false);
        parent.spawn();
        expect(mesh.spawned).toBe(true);
    });

    it('leaves a child that carries its own flag asleep — a spawner must not fire its whole pool', () => {
        const { scene, parent, mesh } = group(true);
        parent.spawn();
        expect(parent.spawned).toBe(true);
        expect(mesh.spawned).toBe(false);
        expect(scene.nodes.has(mesh)).toBe(false);   // still not rendering
    });

    it('wakes the whole group with { subtree: true }', () => {
        const { scene, parent, mesh } = group(true);
        parent.spawn({ subtree: true });
        expect(parent.spawned).toBe(true);
        expect(mesh.spawned).toBe(true);
        expect(scene.nodes.has(mesh)).toBe(true);
        expect(mesh.counts.start).toBe(1);
    });
});
