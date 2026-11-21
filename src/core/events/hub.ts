// The Hub: every channel, by name, and `Events`, the face scripts use.
//
//   Events.emit('PlayerDied', info)               // sync, on the 'game' channel
//   Events.emit('combat:Hit', target, 10)         // sync, on the 'combat' channel ('channel:Name')
//   await Events.emitAsync('SaveRequested')       // async: every listener's promise awaited, in turn
//   Events.post('ScoreChanged', score)            // deferred: delivered at the frame's event flush
//   const off = Events.on('PlayerDied', info => …)
//   const info = await Events.next('BossDefeated')
//
// Built-in channels:
//   game       what scripts send each other (GameEvents, @onEvent, @eventDispatch). The default.
//   animation  what animators fire: clip markers, state enter/exit, finished actions (at the animator's node).
//   engine     the engine's own traffic: SCENE_CHANGED, LOG, NODE_DIRTY, … (engineEventBus is a view of it).
// Any other name makes a channel on first use.
//
// A leaf: imports only within src/core/events (eventBus.ts relies on that; the Logger emits through it).
import { EventChannel, type ChannelOptions, type DispatchOptions, type NextOptions, type PostOptions } from './channel';
import type { EventListenerFn, ListenOptions } from './emitter';
import type { CleoEvent } from './event';
import { currentEvent } from './dispatcher';
import { clearTargetListeners, ensureTargetEmitter, scriptListenerCount, targetEmitter } from './eventTarget';
import type { QueuedEvent } from './channel';
import { routeEvent, sendRemote, type EventDestination, type EventRoute } from './broker';

/** The channel scripts use when a name does not say another. */
export const DEFAULT_CHANNEL = 'game';
/** The channel animators fire on. */
export const ANIMATION_CHANNEL = 'animation';
/** The engine's own channel. */
export const ENGINE_CHANNEL = 'engine';

/**
 * Returned by an `@eventDispatch` method, it sends nothing this time:
 * `@eventDispatch('Shot') fire() { if (!this.ready) return Events.cancel; … }`.
 */
export const CANCEL_EVENT: unique symbol = Symbol.for('cleo.events.cancel');

const BUILT_IN: Record<string, ChannelOptions> = {
    [DEFAULT_CHANNEL]: { pausable: true, isolateErrors: true },
    [ANIMATION_CHANNEL]: { pausable: true, isolateErrors: true },
    // The engine's and editor's own listeners: never held by a pause, and a throw propagates as it always has.
    [ENGINE_CHANNEL]: { pausable: false, isolateErrors: false },
};

const CHANNEL_NAME = /^[A-Za-z_][\w.-]*$/;

const channels = new Map<string, EventChannel>();

/** The channel called `name`, made on first use (`options` apply only then). */
export function getChannel(name: string, options?: ChannelOptions): EventChannel {
    let existing = channels.get(name);
    if (existing) return existing;
    if (!CHANNEL_NAME.test(name)) throw new TypeError(`'${name}' is not a channel name: letters, digits, '_', '-' and '.', starting with a letter`);
    existing = new EventChannel(name, options ?? BUILT_IN[name], true);
    channels.set(name, existing);
    return existing;
}

/** Every channel made so far. */
export function allChannels(): EventChannel[] { return [...channels.values()]; }

/**
 * Split `'channel:Name'` into its channel and name. A name without a `:` is on `fallback` (the game channel).
 * Only the first `:` separates, so `'ui:menu:open'` is `menu:open` on `ui`.
 */
export function splitEventName(qualified: string, fallback: string = DEFAULT_CHANNEL): [channel: string, name: string] {
    const at = qualified.indexOf(':');
    if (at <= 0 || at === qualified.length - 1) return [fallback, qualified];
    const channel = qualified.slice(0, at);
    return CHANNEL_NAME.test(channel) ? [channel, qualified.slice(at + 1)] : [fallback, qualified];
}

/**
 * Names already resolved, per fallback channel: an emit by name is a map lookup, not a string split. Bounded, so a
 * game that makes event names on the fly (`'Hit' + id`) cannot grow it without end; past the bound names are
 * simply split each time.
 */
const resolved = new Map<string, Map<string, readonly [EventChannel, string]>>();
const RESOLVED_MAX = 4096;

/** The channel and plain name a (possibly qualified) name refers to. */
/** The game channel's own cache: the fallback nearly every lookup uses, one map lookup away. */
const resolvedGame = new Map<string, readonly [EventChannel, string]>();
resolved.set(DEFAULT_CHANNEL, resolvedGame);

export function resolveEvent(qualified: string, fallback: string = DEFAULT_CHANNEL): readonly [EventChannel, string] {
    if (fallback === DEFAULT_CHANNEL) {
        const hit = resolvedGame.get(qualified);
        if (hit !== undefined) return hit;
    }
    let byName = resolved.get(fallback);
    if (byName === undefined) { byName = new Map(); resolved.set(fallback, byName); }
    const hit = byName.get(qualified);
    if (hit !== undefined) return hit;
    const [channel, name] = splitEventName(qualified, fallback);
    const pair = [getChannel(channel), name] as const;
    if (byName.size < RESOLVED_MAX) byName.set(qualified, pair);
    return pair;
}

/**
 * Whether any channel but the engine's has a listener anywhere, channel-wide or at a node. O(1). For hot paths
 * (every animator, every frame) that would otherwise build an event's arguments for nobody.
 */
export function hasScriptListeners(): boolean {
    return scriptListenerCount() > 0;
}

/** Deliver the deferred events of every pausable channel (`pausable` true) or every other one. Returns how many. */
export function flushChannels(pausable: boolean): number {
    let delivered = 0;
    for (const channel of channels.values()) if (channel.pausable === pausable) delivered += channel.flush();
    return delivered;
}

/** Deliver every channel's deferred events. */
export function flushAllChannels(): number {
    return flushChannels(false) + flushChannels(true);
}

/**
 * Drop the deferred events, on every channel, that are about one of `nodes`: dispatched at one, or carrying one as
 * their payload's `node` (NODE_DIRTY, an animator's StateEnter). For a scene being disposed: its nodes must neither
 * be kept alive by a queue nor heard of by the next scene. Returns how many were dropped.
 */
export function discardQueuedFor(nodes: ReadonlySet<object>): number {
    if (nodes.size === 0) return 0;
    const about = (entry: QueuedEvent): boolean => {
        if (entry.target !== null && nodes.has(entry.target)) return true;
        const first = entry.args[0] as { node?: unknown } | null | undefined;
        return !!first && typeof first === 'object' && typeof first.node === 'object' && first.node !== null && nodes.has(first.node as object);
    };
    let dropped = 0;
    for (const channel of channels.values()) if (channel.queued > 0) dropped += channel.discard(about);
    return dropped;
}

/**
 * Forget what scripts left on the channels: listeners, deferred events and sticky values on every channel but the
 * engine's. Run when a game (re)starts — Play, Stop, a new player boot — so a listener a script added by hand
 * in one run is not called in the next.
 */
export function resetScriptChannels(): void {
    for (const channel of channels.values()) if (channel.name !== ENGINE_CHANNEL) channel.clear();
}

/** Owners that subscribed through {@link listenOwned}: only they are worth looking for on a release. */
const owners = new WeakSet<object>();

/**
 * Listen to `qualified` on behalf of `owner` (a node's `this.listen`): {@link removeChannelListenersOwnedBy}
 * removes it with everything else the owner subscribed.
 */
export function listenOwned(owner: object, qualified: string, fn: EventListenerFn, options?: ListenOptions): () => void {
    owners.add(owner);
    const [channel, name] = resolveEvent(qualified);
    return channel.on(name, fn, { ...options, owner });
}

/**
 * Remove what `owner` subscribed, on every channel. Cheap for an owner that never subscribed (every despawn asks).
 */
export function removeChannelListenersOwnedBy(owner: object): void {
    if (!owners.has(owner)) return;
    owners.delete(owner);
    for (const channel of channels.values()) channel.removeOwnedBy(owner);
}

/** How {@link sendEvent} delivers. */
export interface SendOptions extends DispatchOptions {
    /** `'sync'` (now, the default), `'async'` (awaiting listeners), or `'deferred'` (at the frame's flush). */
    mode?: 'sync' | 'async' | 'deferred';
    /** With `mode: 'async'`: call every listener at once and await them together. */
    parallel?: boolean;
    /** This machine only (default), or over the network too: `'host'`, `'peers'`, `'all'`. */
    to?: EventDestination;
}

/**
 * The one way to send with every option: `qualified` on its channel, at `target` (null for a broadcast), now,
 * awaited or deferred, here or over the network. Returns the event (sync), a promise of it (async), or null
 * (deferred, or not delivered on this machine).
 */
export function sendEvent(qualified: string, args: unknown[], target: object | null, options: SendOptions = {}): CleoEvent | Promise<CleoEvent> | null {
    const [channel, name] = resolveEvent(qualified);
    const to = options.to ?? 'local';
    if (to !== 'local') {
        // Offline (no transport, or none in session) this machine is everyone, so it is delivered here.
        const sent = sendRemote(channel.name, name, args, to, target, !!options.down);
        if (sent && !sent.local) return null;
    }
    const mode = options.mode ?? 'sync';
    if (mode === 'deferred') {
        channel.defer(name, args, { ...options, target } as PostOptions);
        return null;
    }
    if (mode === 'async') return channel.publishAsync(name, args, target, options);
    return channel.publish(name, args, target, options);
}

/**
 * As {@link sendEvent}, for callers that do not read the event back (a decorator's dispatch, an animator's marker):
 * a sync send allocates no event. Returns a promise only for `mode: 'async'`.
 */
export function fireEvent(qualified: string, args: readonly unknown[], target: object | null, options: SendOptions = {}): Promise<CleoEvent> | void {
    const mode = options.mode ?? 'sync';
    if (mode !== 'sync' || (options.to !== undefined && options.to !== 'local')) {
        const sent = sendEvent(qualified, args as unknown[], target, options);
        return sent instanceof Promise ? sent : undefined;
    }
    const [channel, name] = resolveEvent(qualified);
    channel.fire(name, args, target, options);
}

/**
 * Send `qualified` DOWN from `target`: the target, then every node beneath it, depth first, then the channel's
 * listeners. How a script commands the animators under it (`dispatchDownAt(this, 'animator:SetTrigger', ['Jump'])`).
 */
export function dispatchDownAt(target: object, qualified: string, args: unknown[] = [], options?: DispatchOptions): CleoEvent {
    const [channel, name] = resolveEvent(qualified);
    return channel.dispatchDown(target, name, args, options);
}

/** An event that arrived from another machine: dispatched here, at its node if it names one. */
export function receiveRemoteEvent(channel: string, name: string, args: unknown[], target: object | null, down = false): CleoEvent {
    return getChannel(channel).publish(name, args, target, down ? { down: true } : undefined);
}

/**
 * Listen at a node: `fn` hears `qualified` when it is dispatched at `target` or bubbles up from beneath it (or,
 * with `capture`, on its way down to a node beneath). Returns the function that stops listening.
 */
export function addTargetListener(target: object, qualified: string, fn: EventListenerFn, options?: ListenOptions): () => void {
    const [channel, name] = splitEventName(qualified);
    getChannel(channel);
    const emitter = ensureTargetEmitter(target, channel);
    const record = emitter.add(name, fn, options);
    return () => { emitter.removeRecord(record); };
}

/** Stop `fn` listening at `target`. Returns whether it was. */
export function removeTargetListener(target: object, qualified: string, fn: EventListenerFn, capture?: boolean): boolean {
    const [channel, name] = splitEventName(qualified);
    return targetEmitter(target, channel)?.remove(name, fn, capture) ?? false;
}

/** Whether `target` itself listens to `qualified`. */
export function hasTargetListener(target: object, qualified: string): boolean {
    const [channel, name] = splitEventName(qualified);
    return (targetEmitter(target, channel)?.count(name) ?? 0) > 0;
}

/** Drop every listener at `target`, on every channel: a node removed for good. */
export function releaseTarget(target: object): void {
    clearTargetListeners(target);
}

/** Dispatch `qualified` at `target`, now: capture, target, bubble, then the channel's broadcast. */
export function dispatchAt(target: object, qualified: string, args: unknown[] = [], options?: DispatchOptions): CleoEvent {
    const [channel, name] = resolveEvent(qualified);
    return channel.dispatchAt(target, name, args, options);
}

/** Call every listener of `name` with `args`, now. Returns whether anyone listened. */
function emitByName(name: string, ...args: unknown[]): boolean;
function emitByName(name: string): boolean {
    const resolved = resolveEvent(name);
    const channel = resolved[0];
    if (channel.listeners.count(resolved[1]) === 0) return false;
    // `arguments`, not a rest parameter: an emit nobody listens to builds no argument array.
    const count = arguments.length - 1;
    let args: unknown[];
    if (count === 1) args = [arguments[1]];
    else if (count === 0) args = [];
    else if (count === 2) args = [arguments[1], arguments[2]];
    else { args = []; for (let i = 1; i <= count; i++) args.push(arguments[i]); }
    channel.fire(resolved[1], args, null);
    return true;
}

/** The script-facing hub: the game channel, or any channel by a qualified name (`'combat:Hit'`). */
export const Events = {
    /** Call every listener of `name` with `args`, now. Returns whether anyone listened. */
    emit: emitByName,
    /** As `emit`, returning the event: what listeners returned (`results`) and whether one cancelled it. */
    publish(name: string, ...args: unknown[]): CleoEvent {
        const [channel, plain] = resolveEvent(name);
        return channel.publish(plain, args);
    },
    /** Call the listeners one after another, awaiting each one's promise. Resolves to what they returned. */
    emitAsync(name: string, ...args: unknown[]): Promise<unknown[]> {
        const [channel, plain] = resolveEvent(name);
        return channel.emitAsync(plain, ...args);
    },
    /** Call every listener at once and await them all. Resolves to what they returned. */
    emitParallel(name: string, ...args: unknown[]): Promise<unknown[]> {
        const [channel, plain] = resolveEvent(name);
        return channel.emitParallel(plain, ...args);
    },
    /** Queue the event for this frame's event flush (after every node has updated). */
    post(name: string, ...args: unknown[]): void {
        const [channel, plain] = resolveEvent(name);
        channel.post(plain, ...args);
    },
    /** Emit and keep the arguments: a listener added later with `{ replay: true }` hears them at once. */
    emitSticky(name: string, ...args: unknown[]): boolean {
        const [channel, plain] = resolveEvent(name);
        return channel.emitSticky(plain, ...args);
    },
    /** Send with every option: `{ mode: 'sync' | 'async' | 'deferred', to: 'local' | 'host' | 'peers' | 'all' }`. */
    send(name: string, args: unknown[] = [], options: SendOptions = {}): CleoEvent | Promise<CleoEvent> | null {
        return sendEvent(name, args, null, options);
    },
    /** Listen to `name`. Returns the function that stops listening. */
    on(name: string, fn: EventListenerFn, options?: ListenOptions): () => void {
        const [channel, plain] = resolveEvent(name);
        return channel.on(plain, fn, options);
    },
    /** Listen to the next `name` only. Returns the function that stops listening before it fires. */
    once(name: string, fn: EventListenerFn, options?: ListenOptions): () => void {
        const [channel, plain] = resolveEvent(name);
        return channel.once(plain, fn, options);
    },
    /** Stop `fn` listening to `name`. */
    off(name: string, fn: EventListenerFn): boolean {
        const [channel, plain] = resolveEvent(name);
        return channel.off(plain, fn);
    },
    /** Resolves with the first argument of the next `name`: `const boss = await Events.next('BossSpawned')`. */
    next(name: string, options?: NextOptions): Promise<unknown> {
        const [channel, plain] = resolveEvent(name);
        return channel.next(plain, options);
    },
    /** Ask: the first thing a listener of `name` returns for `args`, or undefined. */
    request(name: string, ...args: unknown[]): unknown {
        const [channel, plain] = resolveEvent(name);
        return channel.request(plain, ...args);
    },
    /** Ask, awaiting the listeners: the first thing one resolves to, or undefined. */
    requestAsync(name: string, ...args: unknown[]): Promise<unknown> {
        const [channel, plain] = resolveEvent(name);
        return channel.requestAsync(plain, ...args);
    },
    /** Whether anyone listens to `name` (its channel's listeners or any node's). */
    hasListeners(name: string): boolean {
        const [channel, plain] = resolveEvent(name);
        return channel.hasListeners(plain);
    },
    /** The channel called `name` (made on first use): the same methods, without qualified names. */
    channel(name: string, options?: ChannelOptions): EventChannel {
        return getChannel(name, options);
    },
    /** Forward `from` to `to` (an event, or a function): `Events.route('animation:footstep', 'audio:step')`. */
    route(from: string, to: string | EventListenerFn, options?: ListenOptions): EventRoute {
        const [source, plainFrom] = resolveEvent(from);
        if (typeof to === 'function') return routeEvent(source, plainFrom, null, to, options);
        const [dest, plainTo] = resolveEvent(to);
        return routeEvent(source, plainFrom, dest, plainTo, options);
    },
    /** Deliver every channel's deferred events now. The frame does this by itself; for tests and tools. */
    flush(): number {
        return flushAllChannels();
    },
    /** The event whose listener is running right now: who sent it, what earlier listeners returned. Else null. */
    get current(): CleoEvent | null {
        return currentEvent();
    },
    /** Returned by an `@eventDispatch` method, it sends nothing this time. */
    cancel: CANCEL_EVENT as typeof CANCEL_EVENT,
};
