import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    Events, EventChannel, ValueSubject, Subject, getChannel, splitEventName, resetScriptChannels, setEventErrorReporter,
    flushAllChannels, MAX_EVENT_DEPTH, hasScriptListeners, sendEvent, setEventTransportResolver,
} from '../src/core/events';
import { GameEvents } from '../src/core/scripting/scriptEvents';

// The event system's core (src/core/events): channels on a hub, delivered sync, async or deferred. No scene here —
// node targets and the engine's use of it are in nodeEvents.test.ts, the decorators in eventDecorators.test.ts.

afterEach(() => { resetScriptChannels(); vi.restoreAllMocks(); });

/** A private channel per test, so nothing leaks between them. */
let n = 0;
const fresh = (options?: ConstructorParameters<typeof EventChannel>[1]) => new EventChannel(`t${n++}`, options);

describe('listening', () => {
    it('calls listeners highest priority first, then in subscription order', () => {
        const c = fresh();
        const order: string[] = [];
        c.on('E', () => order.push('a'));
        c.on('E', () => order.push('high'), { priority: 10 });
        c.on('E', () => order.push('b'));
        c.on('E', () => order.push('low'), { priority: -1 });
        c.emit('E');
        expect(order).toEqual(['high', 'a', 'b', 'low']);
    });

    it('passes every argument, and collects what listeners return', () => {
        const c = fresh();
        c.on('Sum', (a: number, b: number) => a + b);
        c.on('Sum', () => undefined);
        c.on('Sum', (a: number, b: number) => a * b);
        expect(c.publish('Sum', [3, 4]).results).toEqual([7, 12]);
        expect(c.request('Sum', 2, 5)).toBe(7);
        expect(c.request('Nobody')).toBeUndefined();
    });

    it('once, off, and the disposer', () => {
        const c = fresh();
        const got: number[] = [];
        c.once('E', (v: number) => got.push(v));
        const fn = (v: number) => got.push(v * 10);
        c.on('E', fn);
        const off = c.on('E', (v: number) => got.push(v * 100));
        c.emit('E', 1);
        off();
        c.off('E', fn);
        c.emit('E', 2);
        expect(got).toEqual([1, 10, 100]);
        expect(c.hasListeners('E')).toBe(false);
    });

    it('filters with where: fields of the first argument, or a predicate', () => {
        const c = fresh();
        const got: string[] = [];
        c.on('Died', (who: { name: string }) => got.push(`red:${who.name}`), { where: { team: 'red' } });
        c.on('Died', (who: { name: string }) => got.push(`big:${who.name}`), { where: (who: { hp: number }) => who.hp > 50 });
        c.emit('Died', { name: 'a', team: 'red', hp: 10 });
        c.emit('Died', { name: 'b', team: 'blue', hp: 99 });
        c.emit('Died', 'not an object');
        expect(got).toEqual(['red:a', 'big:b']);
    });

    it('is not disturbed by a listener that subscribes or unsubscribes while an event is delivered', () => {
        const c = fresh();
        const got: string[] = [];
        let offB: () => void = () => {};
        c.on('E', () => { got.push('a'); offB(); c.on('E', () => got.push('late')); });
        offB = c.on('E', () => got.push('b'));
        c.emit('E');
        // b was removed mid-dispatch, so it is not called; the one added mid-dispatch waits for the next.
        expect(got).toEqual(['a']);
        c.emit('E');
        expect(got).toEqual(['a', 'a', 'late']);
    });

    it('stops at stopImmediatePropagation', () => {
        const c = fresh();
        const got: string[] = [];
        c.on('E', () => { got.push('a'); Events.current!.stopImmediatePropagation(); });
        c.on('E', () => got.push('b'));
        c.emit('E');
        expect(got).toEqual(['a']);
    });

    it('says which event is being delivered, only while it is', () => {
        const c = fresh();
        let seen: string | null = null;
        c.on('E', () => { seen = Events.current?.qualifiedName ?? null; });
        c.emit('E');
        expect(seen).toBe(`${c.name}:E`);
        expect(Events.current).toBeNull();
    });
});

describe('errors', () => {
    it('isolates a throwing listener on a script channel, and reports it', () => {
        const reported: string[] = [];
        const previous = setEventErrorReporter((e, ev) => reported.push(`${ev.name}:${(e as Error).message}`));
        try {
            const c = fresh();
            const got: string[] = [];
            c.on('E', () => { throw new Error('boom'); });
            c.on('E', () => got.push('after'));
            expect(() => c.emit('E')).not.toThrow();
            expect(got).toEqual(['after']);
            expect(reported).toEqual(['E:boom']);
        } finally { setEventErrorReporter(previous); }
    });

    it('reports a listener whose promise rejects', async () => {
        const reported: string[] = [];
        const previous = setEventErrorReporter((e) => reported.push((e as Error).message));
        try {
            const c = fresh();
            c.on('E', async () => { throw new Error('later'); });
            c.emit('E');
            await new Promise(r => setTimeout(r, 0));
            expect(reported).toEqual(['later']);
        } finally { setEventErrorReporter(previous); }
    });

    it('lets the throw out on a channel that does not isolate (the engine channel)', () => {
        const c = fresh({ isolateErrors: false });
        c.on('E', () => { throw new Error('boom'); });
        expect(() => c.emit('E')).toThrow('boom');
        expect(getChannel('engine').isolateErrors).toBe(false);
    });

    it('drops an event emitted from its own listener past the depth limit', () => {
        const reported: string[] = [];
        const previous = setEventErrorReporter((e) => reported.push((e as Error).message));
        try {
            const c = fresh();
            let calls = 0;
            c.on('Loop', () => { calls++; c.emit('Loop'); });
            c.emit('Loop');
            expect(calls).toBe(MAX_EVENT_DEPTH);
            expect(reported.some(m => m.includes('levels deep'))).toBe(true);
        } finally { setEventErrorReporter(previous); }
    });
});

describe('async', () => {
    it('emitAsync awaits each listener before calling the next', async () => {
        const c = fresh();
        const log: string[] = [];
        c.on('Save', async () => { log.push('a start'); await new Promise(r => setTimeout(r, 5)); log.push('a end'); return 'a'; });
        c.on('Save', () => { log.push('b'); return 'b'; });
        const results = await c.emitAsync('Save');
        expect(log).toEqual(['a start', 'a end', 'b']);
        expect(results).toEqual(['a', 'b']);
    });

    it('emitParallel starts every listener at once', async () => {
        const c = fresh();
        const log: string[] = [];
        c.on('Load', async () => { log.push('a start'); await new Promise(r => setTimeout(r, 5)); log.push('a end'); return 1; });
        c.on('Load', async () => { log.push('b start'); return 2; });
        expect(await c.emitParallel('Load')).toEqual([1, 2]);
        expect(log.slice(0, 2)).toEqual(['a start', 'b start']);
    });

    it('requestAsync resolves with the first answer', async () => {
        const c = fresh();
        c.on('Price', async (item: string) => item === 'sword' ? 30 : undefined);
        expect(await c.requestAsync('Price', 'sword')).toBe(30);
    });

    it('next resolves with the next matching event, and times out', async () => {
        const c = fresh();
        const next = c.next('Boss', { where: { phase: 2 } });
        c.emit('Boss', { phase: 1 });
        c.emit('Boss', { phase: 2, hp: 50 });
        await expect(next).resolves.toEqual({ phase: 2, hp: 50 });
        expect(c.hasListeners('Boss')).toBe(false);
        await expect(c.next('Never', { timeout: 1 })).rejects.toThrow(/within 1 ms/);
        expect(c.hasListeners('Never')).toBe(false);
    });
});

describe('deferred', () => {
    it('queues until the flush, in order', () => {
        const c = fresh();
        const got: number[] = [];
        c.on('E', (v: number) => got.push(v));
        c.post('E', 1);
        c.post('E', 2);
        expect(got).toEqual([]);
        expect(c.queued).toBe(2);
        expect(c.flush()).toBe(2);
        expect(got).toEqual([1, 2]);
    });

    it('coalesces by key, merging if asked', () => {
        const c = fresh();
        const got: unknown[] = [];
        c.on('Dirty', (v: Set<string>) => got.push([...v]));
        const merge = (q: unknown[], nx: unknown[]) => { for (const a of nx[0] as Set<string>) (q[0] as Set<string>).add(a); return q; };
        c.defer('Dirty', [new Set(['a'])], { coalesce: 'node1', merge });
        c.defer('Dirty', [new Set(['b'])], { coalesce: 'node1', merge });
        c.defer('Dirty', [new Set(['c'])], { coalesce: 'node2', merge });
        c.flush();
        expect(got).toEqual([['a', 'b'], ['c']]);
        // A key is free again after the flush.
        c.defer('Dirty', [new Set(['d'])], { coalesce: 'node1', merge });
        c.flush();
        expect(got).toEqual([['a', 'b'], ['c'], ['d']]);
    });

    it('holds what a listener posts during the flush for the next one', () => {
        const c = fresh();
        let calls = 0;
        c.on('Again', () => { calls++; c.post('Again'); });
        c.post('Again');
        c.flush();
        expect(calls).toBe(1);
        expect(c.queued).toBe(1);
        c.flush();
        expect(calls).toBe(2);
    });

    it('flushes pausable and other channels through the hub', () => {
        const got: string[] = [];
        Events.on('Later', () => got.push('game'));
        Events.post('Later');
        expect(flushAllChannels()).toBeGreaterThanOrEqual(1);
        expect(got).toEqual(['game']);
    });
});

describe('sticky', () => {
    it('replays the last sticky value to a listener that asks for it', () => {
        const c = fresh();
        c.emitSticky('Level', 'Keep');
        const got: string[] = [];
        c.on('Level', (v: string) => got.push(`replay:${v}`), { replay: true });
        c.on('Level', (v: string) => got.push(`plain:${v}`));
        expect(got).toEqual(['replay:Keep']);
        c.emitSticky('Level', 'Crypt');
        expect(got).toEqual(['replay:Keep', 'replay:Crypt', 'plain:Crypt']);
        expect(c.sticky('Level')).toEqual(['Crypt']);
    });
});

describe('subjects', () => {
    it('a ValueSubject calls a new subscriber with its value, then with each change', () => {
        const hp = new ValueSubject(100);
        const got: [number, number | undefined][] = [];
        const off = hp.subscribe((v, was) => got.push([v, was]));
        hp.value = 80;
        hp.value = 80;          // the same value: nobody told
        off();
        hp.value = 10;
        expect(got).toEqual([[100, undefined], [80, 100]]);
    });

    it('a Subject multicasts and survives a throwing subscriber', () => {
        const previous = setEventErrorReporter(() => {});
        try {
            const s = new Subject<number>();
            const got: number[] = [];
            s.subscribe(() => { throw new Error('x'); });
            s.subscribe(v => got.push(v));
            s.next(3);
            expect(got).toEqual([3]);
            expect(s.observed).toBe(2);
        } finally { setEventErrorReporter(previous); }
    });
});

describe('the hub', () => {
    it("splits 'channel:Name', with the game channel by default", () => {
        expect(splitEventName('Died')).toEqual(['game', 'Died']);
        expect(splitEventName('combat:Hit')).toEqual(['combat', 'Hit']);
        expect(splitEventName('ui:menu:open')).toEqual(['ui', 'menu:open']);
        expect(splitEventName(':odd')).toEqual(['game', ':odd']);
        expect(splitEventName('trailing:')).toEqual(['game', 'trailing:']);
        expect(splitEventName('two words:x')).toEqual(['game', 'two words:x']);
        expect(splitEventName('footstep', 'animation')).toEqual(['animation', 'footstep']);
    });

    it('keeps channels apart, and GameEvents is the game channel', () => {
        const got: string[] = [];
        Events.on('Hit', () => got.push('game'));
        Events.on('combat:Hit', () => got.push('combat'));
        GameEvents.emit('Hit', 1);
        Events.emit('combat:Hit');
        GameEvents.emit('combat:Hit', 2);
        expect(got).toEqual(['game', 'combat', 'combat']);
        expect(getChannel('combat')).toBe(Events.channel('combat'));
    });

    it('GameEvents.emit isolates a throwing listener now, as its comment always said', () => {
        const previous = setEventErrorReporter(() => {});
        try {
            const got: number[] = [];
            GameEvents.on('E', () => { throw new Error('x'); });
            GameEvents.on('E', (p) => got.push(p));
            expect(GameEvents.emit('E', 4)).toBe(true);
            expect(got).toEqual([4]);
            expect(GameEvents.emit('Nobody', 1)).toBe(false);
        } finally { setEventErrorReporter(previous); }
    });

    it('routes one event onto another channel', () => {
        const got: unknown[] = [];
        Events.on('audio:step', (info: unknown) => got.push(info));
        const route = Events.route('animation:footstep', 'audio:step');
        Events.emit('animation:footstep', { foot: 'L' });
        route.remove();
        Events.emit('animation:footstep', { foot: 'R' });
        expect(got).toEqual([{ foot: 'L' }]);
    });

    it('resetScriptChannels forgets script listeners but keeps the engine channel', () => {
        const got: string[] = [];
        Events.on('E', () => got.push('game'));
        getChannel('engine').on('E', () => got.push('engine'));
        Events.post('E');
        expect(hasScriptListeners()).toBe(true);
        resetScriptChannels();
        expect(hasScriptListeners()).toBe(false);
        Events.emit('E');
        getChannel('engine').emit('E');
        flushAllChannels();
        expect(got).toEqual(['engine']);
        getChannel('engine').listeners.clear('E');
    });

    it("sends over the network through the transport, delivering here only when this machine is one of the 'to'", () => {
        const sent: string[] = [];
        const previous = setEventTransportResolver(() => (channel, name, args, to) => { sent.push(`${channel}:${name}>${to}:${args.join(',')}`); return { local: to !== 'host' }; });
        try {
            const got: string[] = [];
            Events.on('Ping', (v: number) => got.push(`ping ${v}`));
            sendEvent('Ping', [1], null, { to: 'all' });
            sendEvent('Ping', [2], null, { to: 'host' });
            sendEvent('Ping', [3], null);
            expect(sent).toEqual(['game:Ping>all:1', 'game:Ping>host:2']);
            expect(got).toEqual(['ping 1', 'ping 3']);
        } finally { setEventTransportResolver(previous); }
        // Offline (no transport) everything is delivered here.
        const got: number[] = [];
        Events.on('Pong', (v: number) => got.push(v));
        Events.send('Pong', [5], { to: 'host' });
        expect(got).toEqual([5]);
    });
});
