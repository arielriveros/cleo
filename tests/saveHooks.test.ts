import { describe, it, expect } from 'vitest';
import '../src/cleo';   // registers 'cleo' and the script transpiler
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript, SCRIPT_HANDLERS } from '../src/core/scripting/scriptRuntime';
import { registerTemplates, clearTemplates } from '../src/core/scene/templates';

// The node and scene half of saving: the flag, the participant index captures walk, the onRestore pass and
// where it falls among the other handlers, and the bits of instantiate a restore leans on.

const nodeJson = (name: string, extra: any = {}, children: any[] = []) =>
    ({ id: name, name, type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children, ...extra });

const parsed = (root: any) => {
    const scene = new Scene();
    scene.parse({ scene: root, textures: [] }, true);
    return scene;
};

describe('Node.saved', () => {
    it('is off by default and serialized only when set', async () => {
        const node = new Node('crate');
        expect(node.saved).toBe(false);
        expect((await node.serialize()).saved).toBeUndefined();
        node.saved = true;
        expect((await node.serialize()).saved).toBe(true);
    });

    it('round-trips through parse', () => {
        const scene = parsed(nodeJson('root', {}, [nodeJson('crate', { saved: true })]));
        expect(scene.findNode('crate')!.saved).toBe(true);
    });

    it('puts the node in its scene participant index, and takes it out again', () => {
        const scene = new Scene();
        const node = new Node('crate');
        scene.addNode(node);
        expect(scene.saveState.participants.has(node)).toBe(false);
        node.saved = true;
        expect(scene.saveState.participants.has(node)).toBe(true);
        node.saved = false;
        expect(scene.saveState.participants.has(node)).toBe(false);
    });

    it('indexes parsed participants however deep they sit', () => {
        const scene = parsed(nodeJson('root', {}, [nodeJson('a', {}, [nodeJson('b', {}, [nodeJson('deep', { saved: true })])])]));
        expect([...scene.saveState.participants].map(n => n.name)).toEqual(['deep']);
    });

    it('counts @save fields and an onSave as taking part', () => {
        const scene = parsed(nodeJson('root', {}, [
            nodeJson('fields', { saveFields: ['souls'] }),
            nodeJson('custom', { script: `
                import { Node } from 'cleo'
                export default class T extends Node { onSave() { return 1 } }
            ` }),
            nodeJson('plain'),
        ]));
        const names = [...scene.saveState.participants].map(n => n.name).sort();
        expect(names).toEqual(['custom', 'fields']);
        expect(scene.findNode('fields')!.saveFields).toEqual(['souls']);
    });

    it('leaves the index when removed from the tree', () => {
        const scene = parsed(nodeJson('root', {}, [nodeJson('crate', { saved: true })]));
        const crate = scene.findNode('crate')!;
        scene.removeNode(crate);
        expect(scene.saveState.participants.has(crate)).toBe(false);
    });
});

describe('the quaternion a save writes', () => {
    it('wins over the Euler rotation, exactly', () => {
        const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2];   // yaw 90: the Euler gimbal
        const scene = parsed(nodeJson('root', {}, [nodeJson('n', { rotation: [10, 20, 30], quaternion: q })]));
        const got = Array.from(scene.findNode('n')!.quaternion);
        got.forEach((v, i) => expect(v).toBeCloseTo(q[i], 6));
    });
});

describe('handler order', () => {
    it('runs onRestore after onConstruct and before onSpawn and onStart, dormant nodes included', () => {
        const order: string[] = [];
        class Tracked extends Node {
            public onConstruct(): void { order.push(`${this.name}:construct`); }
            public onRestore(data: unknown): void { order.push(`${this.name}:restore:${JSON.stringify(data)}`); }
            public onSpawn(): void { order.push(`${this.name}:spawn`); }
            public onStart(): void { order.push(`${this.name}:start`); }
        }
        const scene = new Scene();
        const awake = new Tracked('awake');
        const asleep = new Tracked('asleep');
        asleep.spawnOnStart = false;
        scene.addNode(awake);
        scene.addNode(asleep);
        scene.saveState.pendingRestore.set(awake, { a: 1 });
        scene.saveState.pendingRestore.set(asleep, undefined);
        scene.start();
        expect(order).toEqual([
            'awake:construct', 'asleep:construct',
            'awake:restore:{"a":1}', 'asleep:restore:undefined',
            'awake:spawn', 'awake:start',
        ]);
        expect(scene.saveState.pendingRestore.size).toBe(0);
    });

    it('contains a throwing onRestore', () => {
        class Bad extends Node { public onRestore(): void { throw new Error('boom'); } public started = false; public onStart(): void { this.started = true; } }
        const scene = new Scene();
        const bad = new Bad('bad');
        scene.addNode(bad);
        scene.saveState.pendingRestore.set(bad, undefined);
        expect(() => scene.start()).not.toThrow();
        expect(bad.started).toBe(true);
    });
});

describe('script hooks', () => {
    it('lists onSave and onRestore as script handlers', () => {
        expect(SCRIPT_HANDLERS).toContain('onSave');
        expect(SCRIPT_HANDLERS).toContain('onRestore');
    });

    it("passes a class script's onSave result through", () => {
        const node = new Node('n');
        attachScriptFactory(node, compileScript(`
            import { Node } from 'cleo'
            export default class T extends Node { public n = 3; onSave() { return { n: this.n } } }
        `));
        expect(node.onSave()).toEqual({ n: 3 });
    });

    it("passes an old-style script's onSave result through, and binds onRestore", () => {
        const node = new Node('n');
        let restored: unknown = null;
        (globalThis as any).__restoreSink = (d: unknown) => { restored = d; };
        attachScriptFactory(node, compileScript(`
            this.onSave = () => ({ legacy: true })
            this.onRestore = (self, data) => globalThis.__restoreSink(data)
        `));
        expect(node.onSave()).toEqual({ legacy: true });
        node.onRestore({ x: 1 });
        expect(restored).toEqual({ x: 1 });
        delete (globalThis as any).__restoreSink;
    });

    it('does not make an old-style script without onSave a participant', () => {
        const scene = parsed(nodeJson('root', {}, [nodeJson('n', { script: 'this.onStart = () => {}' })]));
        expect(scene.saveState.participants.size).toBe(0);
    });
});

describe('wasRestored', () => {
    it('is false on a node nothing restored', () => {
        expect(new Node('n').wasRestored).toBe(false);
    });
});

describe('Scene.instantiate for a restore', () => {
    const template = nodeJson('Coin', { saved: true }, [nodeJson('Glow')]);

    it('keeps a requested root id, and records the template it came from', () => {
        registerTemplates([{ id: 'tpl-coin', name: 'Coin', node: template }]);
        try {
            const scene = parsed(nodeJson('root'));
            const made = scene.instantiate('Coin', { id: 'coin-7' })!;
            expect(made.id).toBe('coin-7');
            expect(made.children[0].id).not.toBe('Glow');
            expect(made._cleoSave?.instanceOf).toBe('tpl-coin');
        } finally { clearTemplates(); }
    });

    it('refuses an id already in use', () => {
        registerTemplates([{ id: 'tpl-coin', name: 'Coin', node: template }]);
        try {
            const scene = parsed(nodeJson('root', {}, [nodeJson('taken')]));
            const made = scene.instantiate('Coin', { id: 'taken' })!;
            expect(made.id).not.toBe('taken');
        } finally { clearTemplates(); }
    });

    it('lets a restore edit the copy before it is parsed', () => {
        registerTemplates([{ id: 'tpl-coin', name: 'Coin', node: template }]);
        try {
            const scene = parsed(nodeJson('root'));
            const made = scene.instantiate('Coin', {}, json => { json.position = [4, 5, 6]; json.spawnOnStart = false; })!;
            expect(Array.from(made.position)).toEqual([4, 5, 6]);
            expect(made.spawnOnStart).toBe(false);
        } finally { clearTemplates(); }
    });

    it('can run on a parsed scene that has not started, with the lifecycle left to start()', () => {
        registerTemplates([{ id: 'tpl-coin', name: 'Coin', node: { ...template, script: `
            import { Node } from 'cleo'
            export default class C extends Node { public starts = 0; onStart() { this.starts++ } }
        ` } }]);
        try {
            const scene = parsed(nodeJson('root'));
            const made: any = scene.instantiate('Coin')!;
            expect(made.starts).toBe(0);
            scene.start();
            expect(made.starts).toBe(1);
        } finally { clearTemplates(); }
    });
});
