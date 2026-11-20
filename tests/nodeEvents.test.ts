import { describe, it, expect, afterEach } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { Events, resetScriptChannels, getChannel, targetListenerCount } from '../src/core/events';
import { engineEventBus, type NodeDirty, type SceneChange } from '../src/core/eventBus';
import '../src/cleo';

// Events at nodes (DOM-style capture / target / bubble, then the channel's broadcast), their lifetime with the
// node's, and the engine's own use of the system: engineEventBus as the engine channel, and NODE_DIRTY.

afterEach(() => resetScriptChannels());

/** root > mid > leaf, in a started scene. */
function chain() {
    const scene = new Scene();
    const root = new Node('root'), mid = new Node('mid'), leaf = new Node('leaf');
    root.addChild(mid);
    mid.addChild(leaf);
    scene.addNode(root);
    scene.start();
    return { scene, root, mid, leaf };
}

describe('dispatchEvent at a node', () => {
    it('travels capture down, the target, bubble up, then the broadcast', () => {
        const { root, mid, leaf } = chain();
        const order: string[] = [];
        root.addEventListener('Hit', () => order.push(`root capture ${Events.current!.phase}`), { capture: true });
        mid.addEventListener('Hit', () => order.push(`mid capture ${Events.current!.phase}`), { capture: true });
        leaf.addEventListener('Hit', (d: number) => order.push(`leaf ${Events.current!.phase} ${d}`));
        mid.addEventListener('Hit', () => order.push(`mid ${Events.current!.phase}`));
        root.addEventListener('Hit', () => order.push(`root ${Events.current!.phase}`));
        Events.on('Hit', () => order.push(`broadcast from ${(Events.current!.target as Node).name}`));
        const event = leaf.dispatchEvent('Hit', 7);
        expect(order).toEqual([
            'root capture capture', 'mid capture capture', 'leaf target 7', 'mid bubble', 'root bubble', 'broadcast from leaf',
        ]);
        expect(event.target).toBe(leaf);
    });

    it('stops at stopPropagation, after the current node’s other listeners', () => {
        const { root, mid, leaf } = chain();
        const order: string[] = [];
        mid.addEventListener('Hit', () => { order.push('mid a'); Events.current!.stopPropagation(); });
        mid.addEventListener('Hit', () => order.push('mid b'));
        root.addEventListener('Hit', () => order.push('root'));
        Events.on('Hit', () => order.push('broadcast'));
        leaf.dispatchEvent('Hit');
        expect(order).toEqual(['mid a', 'mid b']);
    });

    it('stays at the target with bubbles: false, and off the channel with broadcast: false', () => {
        const { root, leaf } = chain();
        const order: string[] = [];
        leaf.addEventListener('E', () => order.push('leaf'));
        root.addEventListener('E', () => order.push('root'));
        Events.on('E', () => order.push('broadcast'));
        leaf.sendEvent('E', [], { bubbles: false });
        expect(order).toEqual(['leaf', 'broadcast']);
        order.length = 0;
        leaf.sendEvent('E', [], { broadcast: false });
        expect(order).toEqual(['leaf', 'root']);
    });

    it('keeps channels apart at a node too', () => {
        const { root, leaf } = chain();
        const got: string[] = [];
        root.addEventListener('combat:Hit', () => got.push('combat'));
        root.addEventListener('Hit', () => got.push('game'));
        leaf.dispatchEvent('combat:Hit');
        expect(got).toEqual(['combat']);
    });

    it('can be awaited, and deferred to the frame’s flush', async () => {
        const { scene, root, leaf } = chain();
        const got: string[] = [];
        root.addEventListener('Saved', async () => { await new Promise(r => setTimeout(r, 2)); got.push('saved'); });
        await leaf.dispatchEventAsync('Saved');
        expect(got).toEqual(['saved']);
        root.addEventListener('Later', () => got.push('later'));
        leaf.sendEvent('Later', [], { mode: 'deferred' });
        expect(got).toEqual(['saved']);
        scene.update(1 / 60, 0, false);
        expect(got).toEqual(['saved', 'later']);
    });

    it('holds deferred game events while paused, and delivers them on resume', () => {
        const { scene } = chain();
        const got: number[] = [];
        Events.on('Tick', (v: number) => got.push(v));
        Events.post('Tick', 1);
        scene.update(1 / 60, 0, true);
        expect(got).toEqual([]);
        scene.update(1 / 60, 0, false);
        expect(got).toEqual([1]);
    });

    it('removeEventListener, and a node with no listeners costs no walk', () => {
        const { leaf, root } = chain();
        const got: string[] = [];
        const fn = () => got.push('x');
        const before = targetListenerCount('game');
        root.addEventListener('E', fn);
        expect(targetListenerCount('game')).toBe(before + 1);
        expect(root.removeEventListener('E', fn)).toBe(true);
        expect(targetListenerCount('game')).toBe(before);
        leaf.dispatchEvent('E');
        expect(got).toEqual([]);
    });
});

describe('listener lifetime', () => {
    it('this.listen is released when the node despawns or is removed', () => {
        const { leaf, mid } = chain();
        const got: string[] = [];
        leaf.listen('Ping', () => got.push('leaf'));
        mid.listen('Ping', () => got.push('mid'));
        Events.emit('Ping');
        leaf.despawn({ immediate: true });
        Events.emit('Ping');
        mid.parent!.removeChild(mid);
        Events.emit('Ping');
        expect(got).toEqual(['leaf', 'mid', 'mid']);
    });

    it('addEventListener stays through a despawn, as a DOM element’s listeners do', () => {
        const { leaf } = chain();
        const got: string[] = [];
        leaf.addEventListener('E', () => got.push('e'));
        leaf.despawn({ immediate: true });
        leaf.spawn();
        leaf.dispatchEvent('E');
        expect(got).toEqual(['e']);
    });

    it('Scene.dispose releases every node’s listeners', () => {
        const { scene, leaf, root } = chain();
        const got: string[] = [];
        leaf.listen('Ping', () => got.push('listen'));
        root.addEventListener('E', () => got.push('target'));
        const before = targetListenerCount('game');
        scene.dispose();
        Events.emit('Ping');
        expect(got).toEqual([]);
        expect(targetListenerCount('game')).toBe(before - 1);
    });
});

describe('the engine channel', () => {
    it('engineEventBus is a view of it: chaining, once, a listener added twice is subscribed once', () => {
        const engine = getChannel('engine');
        const got: unknown[] = [];
        const fn = (p: unknown) => got.push(p);
        expect(engineEventBus.on('RENDER_SETTINGS_CHANGED', fn).on('RENDER_SETTINGS_CHANGED', fn)).toBe(engineEventBus);
        expect(engine.listeners.count('RENDER_SETTINGS_CHANGED')).toBe(1);
        engineEventBus.once('RENDER_SETTINGS_CHANGED', () => got.push('once'));
        engineEventBus.emit('RENDER_SETTINGS_CHANGED');
        engineEventBus.emit('RENDER_SETTINGS_CHANGED');
        engineEventBus.off('RENDER_SETTINGS_CHANGED', fn);
        engineEventBus.emit('RENDER_SETTINGS_CHANGED');
        expect(got).toEqual([undefined, 'once', undefined]);
        expect(engineEventBus.emit('RENDER_SETTINGS_CHANGED')).toBe(false);
    });

    it('lets a listener’s throw out, as the old emitter did', () => {
        const boom = () => { throw new Error('boom'); };
        engineEventBus.on('INPUT_MAP_CHANGED', boom);
        try { expect(() => engineEventBus.emit('INPUT_MAP_CHANGED')).toThrow('boom'); }
        finally { engineEventBus.off('INPUT_MAP_CHANGED', boom); }
    });

    it('NODE_DIRTY: once per node per frame, every aspect together, before the frame is drawn', () => {
        const { scene, leaf, mid } = chain();
        scene.update(1 / 60, 0, false);       // settle the first matrices
        const got: { name: string; aspects: string[] }[] = [];
        const fn = (d: NodeDirty) => got.push({ name: d.node.name, aspects: [...d.aspects].sort() });
        engineEventBus.on('NODE_DIRTY', fn);
        try {
            leaf.markDirty('bounds');
            leaf.drawDistance = 50;            // 'lists'
            leaf.markDirty('bounds');
            mid.setPosition(vec3.fromValues(1, 2, 3));   // 'transform' on mid and its child, at the next updateTransforms
            expect(got).toEqual([]);
            scene.update(1 / 60, 1 / 60, true); // paused: the engine channel still flushes
            expect(got).toEqual([
                { name: 'leaf', aspects: ['bounds', 'lists', 'transform'] },
                { name: 'mid', aspects: ['transform'] },
            ]);
            got.length = 0;
            scene.update(1 / 60, 2 / 60, false);
            expect(got, 'nothing moved').toEqual([]);
        } finally { engineEventBus.off('NODE_DIRTY', fn); }
    });

    it('posts no NODE_DIRTY while nobody listens', () => {
        const { leaf } = chain();
        const engine = getChannel('engine');
        const before = engine.queued;
        leaf.markDirty('bounds');
        leaf.setPosition(vec3.fromValues(4, 5, 6));
        leaf.updateTransforms();
        expect(engine.queued).toBe(before);
    });

    it('markDirty keeps the node correct by itself: bounds caches and the scene’s lists', () => {
        const { scene, leaf } = chain();
        expect(scene.nodes).toContain(leaf);
        (scene as any)._dirty = false;
        leaf.markDirty('lists');
        expect((scene as any)._dirty).toBe(true);
        (leaf as any)._worldBoxDirty = false;
        leaf.invalidateWorldBounds();
        expect((leaf as any)._worldBoxDirty).toBe(true);
    });

    it('a scene re-reads its lists only for its own structural changes', () => {
        const a = new Scene(), b = new Scene();
        const nodeA = new Node('a'), nodeB = new Node('b');
        a.addNode(nodeA);
        b.addNode(nodeB);
        void a.nodes; void b.nodes;            // both clean
        nodeB.addChild(new Node('child'));
        expect((a as any)._dirty, 'another scene’s change').toBe(false);
        expect((b as any)._dirty).toBe(true);
        // The editor's own emits name no scene: they still count.
        engineEventBus.emit('SCENE_CHANGED', { kind: 'structure' } as SceneChange);
        expect((a as any)._dirty).toBe(true);
    });
});
