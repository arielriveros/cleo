import { describe, it, expect, afterEach } from 'vitest';
import { vec3, mat4 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript, resetScriptModules } from '../src/core/scripting/scriptRuntime';
import { engineEventBus, type NodeDirty } from '../src/core/eventBus';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, AnimationStateMachine } from '../src/animation/animator';
import {
    Emitter, EventChannel, Events, getChannel, resetScriptChannels, scriptListenerCount, targetListenerCount,
    setEventErrorReporter, MAX_EVENT_DEPTH, addTargetListener, listenOwned, removeChannelListenersOwnedBy,
    dispatchAt, allChannels,
} from '../src/core/events';
import '../src/cleo';

// The event system under load and at its edges: a randomized model check of the listener store, delivery while the
// lists change, the frame stack unwinding through throws and nesting, async ordering, node targets through
// reparenting, and memory — every listener a scene's nodes made is let go when it is disposed, and what the system
// keeps for itself stays bounded. The loose time bounds are guards against an O(n²) creeping back, not benchmarks.

const gc = (globalThis as any).gc as (() => void) | undefined;
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); gc?.(); } };

afterEach(() => resetScriptChannels());

/** A seeded generator, so a failing fuzz run repeats. */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('the listener store, against a model', () => {
    it('agrees with a plain model through thousands of random adds, removes and emits', () => {
        for (const seed of [1, 7, 42, 1234]) {
            const random = rng(seed);
            const emitter = new Emitter();
            const channel = new EventChannel(`fuzz${seed}`);
            // The model: live records in delivery order (priority desc, then subscription order).
            type M = { id: number; priority: number; once: boolean; off: () => void };
            let model: M[] = [];
            let nextId = 0;
            const calls: number[] = [];
            for (let step = 0; step < 4000; step++) {
                const r = random();
                if (r < 0.45 || model.length === 0) {
                    const id = nextId++;
                    const priority = random() < 0.2 ? Math.floor(random() * 5) - 2 : 0;
                    const once = random() < 0.1;
                    const off = channel.on('E', () => { calls.push(id); }, { priority, once });
                    const m = { id, priority, once, off };
                    // Insert after every record of the same or a higher priority.
                    let at = model.length;
                    while (at > 0 && model[at - 1].priority < priority) at--;
                    model.splice(at, 0, m);
                } else if (r < 0.85) {
                    const k = Math.floor(random() * model.length);
                    model[k].off();
                    model.splice(k, 1);
                } else {
                    calls.length = 0;
                    channel.emit('E');
                    expect(calls, `seed ${seed} step ${step}`).toEqual(model.map(m => m.id));
                    model = model.filter(m => !m.once);
                }
                expect(channel.listeners.count('E')).toBe(model.length);
            }
            // Nothing piles up inside: the store compacts what was removed.
            const list = (channel.listeners as any)._lists.get('E');
            if (list) expect(list.items.length).toBeLessThanOrEqual(Math.max(2 * list.live, list.live + 16) + 1);
            void emitter;
        }
    });

    it('skips a listener removed during delivery and does not call one added during it', () => {
        const c = new EventChannel('during');
        const order: string[] = [];
        const offs: (() => void)[] = [];
        offs.push(c.on('E', () => { order.push('a'); offs[2](); c.on('E', () => order.push('added')); }));
        offs.push(c.on('E', () => order.push('b')));
        offs.push(c.on('E', () => order.push('c')));
        c.emit('E');
        expect(order).toEqual(['a', 'b']);
        order.length = 0;
        c.emit('E');
        // The one added last time is heard now; the one added during this emit, next time.
        expect(order).toEqual(['a', 'b', 'added']);
    });

    it('a nested emit of the same event sees what the outer one changed before it, and the outer walk is unharmed', () => {
        const c = new EventChannel('nested');
        const order: string[] = [];
        let depth = 0;
        c.on('E', () => {
            order.push(`a${depth}`);
            if (depth++ === 0) { c.on('E', () => order.push('late')); c.emit('E'); }
        });
        c.on('E', () => order.push(`b`));
        c.emit('E');
        // Inner: a1, b, late (it was added before the inner emit); outer goes on with b only.
        expect(order).toEqual(['a0', 'a1', 'b', 'late', 'b']);
    });

    it('removing thousands during one delivery neither breaks it nor compacts under it', () => {
        const c = new EventChannel('mass');
        const offs: (() => void)[] = [];
        let heard = 0;
        offs.push(c.on('E', () => { heard++; for (let i = 1; i < offs.length; i += 2) offs[i](); }));
        for (let i = 0; i < 5000; i++) offs.push(c.on('E', () => { heard++; }));
        c.emit('E');
        // The first, then every listener at an even index (the odd ones were removed by the first).
        expect(heard).toBe(1 + 2500);
        expect(c.listeners.count('E')).toBe(2501);
        heard = 0;
        c.emit('E');
        expect(heard).toBe(2501);
    });

    it('keeps the counts exact through once, clear, owner removal and node targets', () => {
        const base = scriptListenerCount();
        const owner = {};
        const offs = [
            Events.on('A', () => {}),
            Events.once('A', () => {}),
            listenOwned(owner, 'combat:B', () => {}),
            listenOwned(owner, 'C', () => {}),
        ];
        const node = new Node('n');
        const offT = addTargetListener(node, 'animation:step', () => {});
        expect(scriptListenerCount()).toBe(base + 5);
        expect(targetListenerCount('animation', 'step')).toBeGreaterThanOrEqual(1);
        Events.emit('A');                         // the once goes
        expect(scriptListenerCount()).toBe(base + 4);
        removeChannelListenersOwnedBy(owner);
        expect(scriptListenerCount()).toBe(base + 2);
        offT();
        offs[0]();
        offs[0]();                                // a second call is harmless
        expect(scriptListenerCount()).toBe(base);
        getChannel('engine').on('X', () => {});   // the engine's are not scripts'
        expect(scriptListenerCount()).toBe(base);
        getChannel('engine').listeners.clear('X');
    });

    it('subscribes and unsubscribes a crowd in linear time', () => {
        const c = new EventChannel('crowd');
        const t0 = performance.now();
        for (let round = 0; round < 3; round++) {
            const offs: (() => void)[] = [];
            for (let i = 0; i < 20_000; i++) offs.push(c.on('Wave', () => {}));
            for (const off of offs) off();
        }
        expect(c.listeners.count('Wave')).toBe(0);
        expect(performance.now() - t0, 'O(n²) would take seconds').toBeLessThan(1500);
    });
});

describe('the dispatch stack', () => {
    it('Events.current is the innermost event, and the outer one again after it', () => {
        const c = getChannel('stack');
        const seen: string[] = [];
        c.on('Outer', () => {
            seen.push(Events.current!.name);
            c.emit('Inner');
            seen.push(Events.current!.name);
        });
        c.on('Inner', () => seen.push(Events.current!.name));
        c.emit('Outer');
        expect(seen).toEqual(['Outer', 'Inner', 'Outer']);
        expect(Events.current).toBeNull();
    });

    it('an event kept after its dispatch still says what happened', () => {
        const c = getChannel('kept');
        let kept: any = null;
        c.on('E', () => { kept ??= Events.current; Events.current!.cancel(); return 7; });
        const returned = c.publish('E', [1]);
        expect(returned).toBe(kept);
        expect([kept.cancelled, kept.results, kept.phase, kept.payload]).toEqual([true, [7], 'broadcast', 1]);
        // And another dispatch reusing the frame does not change it.
        c.emit('E', 2);
        expect(kept.payload).toBe(1);
        expect(kept.results).toEqual([7]);
    });

    it('unwinds through a listener that throws on a channel that does not isolate', () => {
        const c = getChannel('engine');
        const boom = () => { throw new Error('boom'); };
        c.on('Throws', boom);
        try {
            for (let i = 0; i < 50; i++) expect(() => c.emit('Throws')).toThrow('boom');
        } finally { c.off('Throws', boom); }
        expect(Events.current).toBeNull();
        // The depth came back down: a chain as deep as the limit still runs.
        const deep = getChannel('deep');
        let calls = 0;
        deep.on('D', () => { calls++; if (calls < MAX_EVENT_DEPTH) deep.emit('D'); });
        deep.emit('D');
        expect(calls).toBe(MAX_EVENT_DEPTH);
    });

    it('drops a dispatch one level past the limit, and reports it once per drop', () => {
        const reported: string[] = [];
        const previous = setEventErrorReporter((e) => reported.push(String((e as Error).message)));
        try {
            const deep = getChannel('deeper');
            let calls = 0;
            deep.on('D', () => { calls++; deep.emit('D'); });
            deep.emit('D');
            expect(calls).toBe(MAX_EVENT_DEPTH);
            expect(reported.filter(m => m.includes('levels deep'))).toHaveLength(1);
            expect(Events.current).toBeNull();
        } finally { setEventErrorReporter(previous); }
    });
});

describe('async delivery', () => {
    it('runs each listener in order, with Events.current in its synchronous part', async () => {
        const c = getChannel('asyncOrder');
        const log: string[] = [];
        c.on('S', async (n: number) => { log.push(`a ${Events.current!.name} ${n}`); await null; log.push(`a done ${Events.current === null}`); });
        c.on('S', () => { log.push('b'); });
        await c.emitAsync('S', 1);
        expect(log).toEqual(['a S 1', 'a done true', 'b']);
    });

    it('skips a listener removed while an earlier one was awaited, and stops on stopImmediatePropagation', async () => {
        const c = getChannel('asyncRemove');
        const log: string[] = [];
        let offC: () => void = () => {};
        c.on('S', async () => { log.push('a'); await null; offC(); });
        c.on('S', () => { log.push('b'); Events.current!.stopImmediatePropagation(); });
        offC = c.on('S', () => { log.push('c'); });
        await c.emitAsync('S');
        expect(log).toEqual(['a', 'b']);
    });

    it('rejects on a channel that does not isolate, and keeps going on one that does', async () => {
        const strict = new EventChannel('strictAsync', { isolateErrors: false });
        strict.on('S', async () => { throw new Error('no'); });
        await expect(strict.emitAsync('S')).rejects.toThrow('no');
        const previous = setEventErrorReporter(() => {});
        try {
            const lax = getChannel('laxAsync');
            lax.on('S', async () => { throw new Error('no'); });
            lax.on('S', async () => 'ok');
            await expect(lax.emitAsync('S')).resolves.toEqual(['ok']);
            await expect(lax.emitParallel('S')).resolves.toEqual(['ok']);
        } finally { setEventErrorReporter(previous); }
    });

    it('two async dispatches interleaving keep their own events', async () => {
        const c = getChannel('interleave');
        const seen: string[] = [];
        c.on('S', async (tag: string) => {
            const ev = Events.current!;
            await new Promise(r => setTimeout(r, tag === 'first' ? 5 : 1));
            seen.push(`${tag}:${ev.payload}`);
            return tag;
        });
        const [a, b] = await Promise.all([c.emitAsync('S', 'first'), c.emitAsync('S', 'second')]);
        expect(seen.sort()).toEqual(['first:first', 'second:second']);
        expect([a, b]).toEqual([['first'], ['second']]);
    });
});

describe('events at nodes, at the edges', () => {
    it('at the target, capture and bubble listeners run together in priority order', () => {
        const parent = new Node('p'), leaf = new Node('l');
        parent.addChild(leaf);
        const order: string[] = [];
        leaf.addEventListener('E', () => order.push(`bubble ${Events.current!.phase}`));
        leaf.addEventListener('E', () => order.push(`capture ${Events.current!.phase}`), { capture: true, priority: 1 });
        leaf.dispatchEvent('E');
        expect(order).toEqual(['capture target', 'bubble target']);
    });

    it('removeEventListener tells a capture listener from a bubble one', () => {
        const node = new Node('n');
        const fn = () => {};
        node.addEventListener('E', fn, { capture: true });
        node.addEventListener('E', fn);
        expect(node.removeEventListener('E', fn, false)).toBe(true);
        expect(node.removeEventListener('E', fn, false)).toBe(false);
        expect(node.removeEventListener('E', fn, true)).toBe(true);
    });

    it('bubbles: false still captures on the way down, and skips only the way up', () => {
        const root = new Node('r'), leaf = new Node('l');
        root.addChild(leaf);
        const order: string[] = [];
        root.addEventListener('E', () => order.push('root capture'), { capture: true });
        root.addEventListener('E', () => order.push('root bubble'));
        leaf.addEventListener('E', () => order.push('leaf'));
        leaf.sendEvent('E', [], { bubbles: false });
        expect(order).toEqual(['root capture', 'leaf']);
    });

    it('follows the tree as it is: a reparented node bubbles to its new ancestors only', () => {
        const a = new Node('a'), b = new Node('b'), leaf = new Node('leaf');
        a.addChild(leaf);
        const heard: string[] = [];
        a.addEventListener('E', () => heard.push('a'));
        b.addEventListener('E', () => heard.push('b'));
        leaf.dispatchEvent('E');
        a.removeChild(leaf, true);
        b.addChild(leaf);
        leaf.dispatchEvent('E');
        expect(heard).toEqual(['a', 'b']);
    });

    it('keeps its listeners off the node’s own properties', () => {
        const node = new Node('n');
        const before = Object.keys(node).length;
        const off = node.addEventListener('E', () => {});
        expect(Object.keys(node)).toHaveLength(before);
        expect(Object.prototype.propertyIsEnumerable.call(node, '_eventTargets')).toBe(false);
        off();
        dispatchAt(node, 'E');
    });
});

describe('animator events, deeper', () => {
    const SKIN = { joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }], nodeTransforms: new Map([[0, mat4.create()]]) };
    const clip = (name: string, events?: Animation['events']): Animation => ({
        name, events,
        samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    } as Animation);
    const step = (a: Animator, seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { a.checkTriggers(); a.update(1 / 60); } };

    it('a layer’s marker is dispatched once, at the character, naming its layer; a slot’s names its slot', () => {
        const model = { skin: SKIN, animations: [clip('legs'), clip('wave', [{ time: 0.3, name: 'hand' }]), clip('swing', [{ time: 0.2, name: 'hit' }])] } as unknown as AnimatedModel;
        const machine: AnimationStateMachine = {
            parameters: [],
            states: [{ name: 'Walk', clipName: 'legs', loop: true, speed: 1, isEntry: true }],
            transitions: [],
            events: [],
            layers: [{ name: 'Upper', states: [{ name: 'Wave', clipName: 'wave', loop: false, speed: 1, isEntry: true }], transitions: [] }],
        } as any;
        const node = new Node('model');
        const heard: string[] = [];
        const off = node.addEventListener('animation:hand', (info: any) => heard.push(`hand ${info.layer} ${info.state} ${info.clip}`));
        const offHit = node.addEventListener('animation:hit', (info: any) => heard.push(`hit ${info.layer} ${info.state}`));
        const legacy: string[] = [];
        const animator = new Animator(model, node);
        animator.setStateMachine(machine);
        animator.onAnimationEvent((name) => legacy.push(name));
        step(animator, 0.5);
        animator.playAction('swing', { slot: 'Arms' });
        step(animator, 0.4);
        off(); offHit();
        expect(heard).toEqual(['hand Upper Wave wave', 'hit Arms null']);
        expect(legacy).toEqual(['hand', 'hit']);
    });

    it('builds nothing for a marker nobody listens to while scripts listen to other things', () => {
        const model = { skin: SKIN, animations: [clip('run', [{ time: 0.1, name: 'a' }, { time: 0.6, name: 'b' }])] } as unknown as AnimatedModel;
        const animator = new Animator(model, new Node('m'));
        animator.setStateMachine({ parameters: [], states: [{ name: 'Run', clipName: 'run', loop: true, speed: 1, isEntry: true }], transitions: [], events: [] } as any);
        const off = Events.on('SomethingElse', () => {});
        const channel = getChannel('animation');
        const fire = channel.fire.bind(channel);
        let fired = 0;
        (channel as any).fire = (...args: any[]) => { fired++; return (fire as any)(...args); };
        try { step(animator, 2); }
        finally { (channel as any).fire = fire; off(); }
        expect(fired).toBe(0);
    });
});

describe('memory', () => {
    it('runs with a collector to call (the suite starts Node with --expose-gc), so the checks below are real', () => {
        expect(typeof gc).toBe('function');
    });

    const ALL = `import { Node, Events } from 'cleo'
import { onEvent, eventListener, eventDispatch, observable, onClipEvent } from 'cleo/decorators'
export default class Everything extends Node {
  blob = new Array(512).fill(1)
  @observable hp = 10
  @onEvent('Tick') tick() {}
  @onEvent('combat:Hit', { once: true }) hit() {}
  @eventListener('Ping') ping() {}
  @onClipEvent('step') step() {}
  @eventDispatch({ name: 'Later', mode: 'deferred' }) later() { return this.blob }
  onStart() {
    this.listen('Manual', () => this.blob)
    this.addEventListener('Own', () => this.blob)
    Events.on('ByHand', () => this.blob)       // the kind of listener only a reset can clean up
    this.hp = 11
    this.later()
  }
}`;

    /** One play session: a scene of `count` nodes running ALL, updated, with events queued, then disposed. */
    function session(factory: unknown, count: number): WeakRef<Scene> {
        const scene = new Scene();
        for (let i = 0; i < count; i++) {
            const n = new Node(`n${i}`);
            scene.addNode(n);
            attachScriptFactory(n, factory as any);
        }
        scene.start();
        scene.update(1 / 60, 0, false);
        // Left queued at dispose: a deferred dispatch at a node, and a NODE_DIRTY about one.
        (scene.findNode('n0') as any).later();
        scene.findNode('n1')!.markDirty('bounds');
        scene.dispose();
        return new WeakRef(scene);
    }

    it('lets a disposed scene go with every kind of listener its nodes made, and keeps nothing queued about it', async () => {
        if (!gc) return;
        const factory = compileScript(ALL);
        const dirty = (_: NodeDirty) => {};
        engineEventBus.on('NODE_DIRTY', dirty);
        try {
            const before = scriptListenerCount();
            const refs: WeakRef<Scene>[] = [];
            for (let s = 0; s < 5; s++) refs.push(session(factory, 50));
            // The decorated and this.listen listeners went with the scenes; Events.on by hand waits for a reset.
            expect(scriptListenerCount() - before).toBe(5 * 50);
            resetScriptModules();
            // Back to what was there before (listeners other tests left at nodes they never disposed).
            expect(scriptListenerCount()).toBe(before);
            for (const ch of allChannels()) expect(ch.queued, ch.name).toBe(0);
            await settle();
            expect(refs.filter(r => r.deref() !== undefined)).toHaveLength(0);
        } finally { engineEventBus.off('NODE_DIRTY', dirty); }
    });

    it('holds the heap flat over many play sessions', async () => {
        if (!gc) return;
        const factory = compileScript(ALL);
        // Warm up: the first sessions JIT and fill caches.
        for (let s = 0; s < 3; s++) { session(factory, 100); resetScriptModules(); }
        await settle();
        const h0 = process.memoryUsage().heapUsed;
        for (let s = 0; s < 25; s++) { session(factory, 100); resetScriptModules(); }
        await settle();
        const grownMB = (process.memoryUsage().heapUsed - h0) / 1048576;
        // Each session's nodes hold half a megabyte of blobs: a leak of the sessions would be ~12 MB.
        expect(grownMB).toBeLessThan(4);
    });

    it('lets a disposed scene go while another scene lives on (its listener list never empties)', async () => {
        if (!gc) return;
        // The published player's case: the next scene is alive and listening on the engine bus, so the disposed
        // scene's own SCENE_CHANGED listener is removed from a list that stays, and must not linger there.
        const alive = new Scene();
        const make = (): WeakRef<Scene> => { const s = new Scene(); s.start(); s.dispose(); return new WeakRef(s); };
        const refs = [make(), make(), make()];
        await settle();
        expect(refs.filter(r => r.deref() !== undefined)).toHaveLength(0);
        alive.dispose();
    });

    it('a removed listener holds nothing, however long its record waits to be compacted', async () => {
        if (!gc) return;
        const c = new EventChannel('tombstones');
        const keep = c.on('E', () => {});
        const make = (): WeakRef<object> => {
            const big = { blob: new Array(1000).fill(0) };
            const off = c.on('E', () => big.blob.length);
            off();
            return new WeakRef(big);
        };
        const ref = make();
        await settle();
        expect(ref.deref()).toBeUndefined();
        keep();
    });

    it('lets a removed node go when nothing else holds it, listeners and all', async () => {
        if (!gc) return;
        const scene = new Scene();
        const make = (): WeakRef<Node> => {
            const n = new Node('gone');
            scene.addNode(n);
            n.addEventListener('E', () => n.name);
            n.listen('F', () => n.name);
            scene.removeNode(n);
            return new WeakRef(n);
        };
        const ref = make();
        await settle();
        expect(ref.deref()).toBeUndefined();
        scene.dispose();
    });

    it('a resolved or timed-out next() leaves no listener behind', async () => {
        const c = getChannel('nextMem');
        const p = c.next('Go');
        c.emit('Go', 1);
        await p;
        await expect(c.next('Never', { timeout: 1 })).rejects.toThrow();
        expect(c.listeners.count()).toBe(0);
    });

    it('a channel’s queue is bounded when nothing flushes it', () => {
        const previous = setEventErrorReporter(() => {});
        try {
            const c = new EventChannel('unflushed');
            for (let i = 0; i < 60_000; i++) c.post('E', i);
            expect(c.queued).toBe(50_000);
            c.flush();
            expect(c.queued).toBe(0);
        } finally { setEventErrorReporter(previous); }
    });

    it('a dispatch with shared arguments allocates nothing, with or without a listener', async () => {
        if (!gc) return;
        const c = getChannel('alloc');
        const args = [1];
        let sink = 0;
        const measure = (): number => {
            gc!();
            const h0 = process.memoryUsage().heapUsed;
            for (let i = 0; i < 100_000; i++) c.fire('E', args, null);
            return process.memoryUsage().heapUsed - h0;
        };
        measure();
        expect(measure(), 'nobody listening').toBeLessThan(256 * 1024);
        const off = c.on('E', (n: number) => { sink += n; });
        measure();
        expect(measure(), 'one listener').toBeLessThan(256 * 1024);
        off();
        expect(sink).toBeGreaterThan(0);
    });

    it('NODE_DIRTY folds a node’s changes into one event without allocating per change', () => {
        const scene = new Scene();
        const node = new Node('n');
        scene.addNode(node);
        scene.start();
        const got: string[][] = [];
        const fn = (d: NodeDirty) => { if (d.node === node) got.push([...d.aspects].sort()); };
        engineEventBus.on('NODE_DIRTY', fn);
        try {
            for (let i = 0; i < 1000; i++) { node.markDirty('bounds'); node.markDirty('render'); node.setPosition(vec3.fromValues(i, 0, 0)); }
            scene.update(1 / 60, 0, false);
            expect(got).toEqual([['bounds', 'render', 'transform']]);
        } finally { engineEventBus.off('NODE_DIRTY', fn); scene.dispose(); }
    });
});
