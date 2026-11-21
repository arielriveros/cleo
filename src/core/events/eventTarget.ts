// Targets: listeners that belong to one node, for events dispatched AT that node or bubbling up from beneath it —
// what `@eventListener` and `node.addEventListener` add. They are kept here, beside the node rather than on it, in
// a WeakMap: a node nothing listens on costs nothing, and a node that is dropped takes its listeners with it.
//
// How many target listeners each channel has, per event name, is counted, so a dispatch at a node walks its
// ancestors only when some node somewhere listens to that very event — and the hub can say in O(1) whether any
// script listens to anything at all (`hasScriptListeners`, asked by every animator every frame).
//
// Typed structurally — a target is anything with a `parent` — so this module needs no Node import.
//
// A leaf: imports only within src/core/events.
import { Emitter } from './emitter';

/** What can be a target: a scene node, or anything else with a parent chain (and, to be sent down, children). */
export interface EventTargetLike {
    readonly parent: EventTargetLike | null;
    readonly children?: readonly EventTargetLike[];
}

/** The engine's own channel: its listeners are not a script's (see {@link scriptListenerCount}). */
const ENGINE = 'engine';

/** Per target: one Emitter per channel name. */
const targets = new WeakMap<object, Map<string, Emitter>>();

/**
 * Where a target that declares one keeps its listeners: a scene node has `_eventTargets` on its prototype (null),
 * so a dispatch walking a node's ancestors reads a property rather than a WeakMap per ancestor. Set on the node
 * itself, non-enumerable, when its first listener is added. Anything else is kept in the WeakMap.
 */
const SLOT = '_eventTargets';

function byChannelOf(target: object): Map<string, Emitter> | undefined {
    const own = (target as Record<string, unknown>)[SLOT] as Map<string, Emitter> | null | undefined;
    if (own !== undefined) return own === null ? undefined : own;
    return targets.get(target);
}

/** One channel's target listeners, on all targets together: in total, and per event name. */
export interface TargetCounts { total: number; byName: Map<string, number> }
/** Per channel. */
const counts = new Map<string, TargetCounts>();

/** `channel`'s counts, made on first use: a channel keeps a reference, so asking costs no channel lookup. */
export function targetCountsFor(channel: string): TargetCounts {
    let c = counts.get(channel);
    if (!c) { c = { total: 0, byName: new Map() }; counts.set(channel, c); }
    return c;
}

/** Listeners on every channel but the engine's, channel-wide and at nodes together. */
let scriptListeners = 0;

/** How many listeners scripts (anything not on the engine channel) have, everywhere. */
export function scriptListenerCount(): number { return scriptListeners; }

/** A channel's own (broadcast) listeners changed by `delta`: kept in the script total (a system one is not a script's). */
export function countChannelListeners(channel: string, delta: number, system = false): void {
    if (channel !== ENGINE && !system) scriptListeners += delta;
}

function countTarget(channel: string, name: string, delta: number, system: boolean): void {
    const c = targetCountsFor(channel);
    c.total += delta;
    const n = (c.byName.get(name) ?? 0) + delta;
    if (n === 0) c.byName.delete(name); else c.byName.set(name, n);
    if (channel !== ENGINE && !system) scriptListeners += delta;
}

/** How many node-target listeners `channel` has on all targets together: for `name`, or for any event. */
export function targetListenerCount(channel: string, name?: string): number {
    const c = counts.get(channel);
    if (!c) return 0;
    return name === undefined ? c.total : (c.byName.get(name) ?? 0);
}

/** `target`'s listeners on `channel`, if it has any. */
export function targetEmitter(target: object, channel: string): Emitter | undefined {
    return byChannelOf(target)?.get(channel);
}

/** `target`'s listeners on `channel`, made on first use. */
export function ensureTargetEmitter(target: object, channel: string): Emitter {
    let byChannel = byChannelOf(target);
    if (!byChannel) {
        byChannel = new Map();
        if ((target as Record<string, unknown>)[SLOT] === null)
            Object.defineProperty(target, SLOT, { value: byChannel, writable: true, configurable: true, enumerable: false });
        else targets.set(target, byChannel);
    }
    let emitter = byChannel.get(channel);
    if (!emitter) {
        emitter = new Emitter((name, delta, system) => countTarget(channel, name, delta, system));
        byChannel.set(channel, emitter);
    }
    return emitter;
}

/** Drop every listener `target` has, on every channel (or one): a node removed for good. */
export function clearTargetListeners(target: object, channel?: string): void {
    const byChannel = byChannelOf(target);
    if (!byChannel) return;
    for (const [name, emitter] of byChannel) {
        if (channel !== undefined && name !== channel) continue;
        emitter.clear();
        byChannel.delete(name);
    }
    if (byChannel.size > 0) return;
    if (Object.prototype.hasOwnProperty.call(target, SLOT)) (target as Record<string, unknown>)[SLOT] = null;
    else targets.delete(target);
}

/** Drop what `owner` added to `target`. */
export function removeTargetListenersOwnedBy(target: object, owner: object): void {
    const byChannel = byChannelOf(target);
    if (!byChannel) return;
    for (const emitter of byChannel.values()) emitter.removeOwnedBy(owner);
}

/** The parent of a target, or null. */
export function parentOf(target: object): object | null {
    return (target as Partial<EventTargetLike>).parent ?? null;
}

/** The children of a target (for an event sent down), or none. */
export function childrenOf(target: object): readonly object[] {
    return (target as Partial<EventTargetLike>).children ?? NO_CHILDREN;
}

const NO_CHILDREN: readonly object[] = Object.freeze([]);
