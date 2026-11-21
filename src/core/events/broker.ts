// The Broker: what carries events past their own channel. Two jobs:
//
//   routes      `route('animation:footstep', 'audio:step')` re-emits one channel's event on another (renamed or
//               not), or hands it to a function: the footstep the animator fires becomes the sound system's.
//   transport   an event sent `to: 'host' | 'peers' | 'all'` leaves this machine, through the session of the scene
//               the event's node is in (NetSync's `scene.net`). The engine installs how a node finds it; offline there
//               is none and such an event stays here.
//
// A leaf: imports only within src/core/events.
import type { EventChannel } from './channel';
import { currentEvent } from './dispatcher';
import type { EventListenerFn, ListenOptions } from './emitter';

/** Who hears an event sent over the network: the host, every peer, or everyone. */
export type RemoteEventTarget = 'host' | 'peers' | 'all';

/** Where an event is sent: this machine only (the default), or over the network as well. */
export type EventDestination = 'local' | RemoteEventTarget;

/**
 * What a transport says about an event it was handed: `null` when there is no session (offline: this machine is
 * everyone, so the event is delivered here); otherwise whether this machine is among those who should hear it.
 */
export type TransportResult = { local: boolean } | null;

/**
 * Sends a hub event to other machines. `target` is the node it was dispatched at (null for a broadcast); the
 * receiving machine dispatches it at its own copy of that node.
 */
export type EventTransport = (channel: string, name: string, args: unknown[], to: RemoteEventTarget, target: object | null, down?: boolean) => TransportResult;

/**
 * Finds the transport for an event dispatched at `target` (null for a broadcast): the session of the scene that node
 * is in, since one process may run several (a host and its peers, in the NetSync tests). Null when offline.
 */
export type EventTransportResolver = (target: object | null) => EventTransport | null;

let resolver: EventTransportResolver | null = null;

/** Install (or with null, remove) how an event finds its way to other machines. Returns the one it replaced. */
export function setEventTransportResolver(next: EventTransportResolver | null): EventTransportResolver | null {
    const previous = resolver;
    resolver = next;
    return previous;
}

/** Hand an event to its transport. `null` when there is none (offline). */
export function sendRemote(channel: string, name: string, args: unknown[], to: RemoteEventTarget, target: object | null, down = false): TransportResult {
    const transport = resolver?.(target) ?? null;
    return transport ? transport(channel, name, args, to, target, down) : null;
}

/** One forwarding rule, as `route` made it. */
export interface EventRoute {
    readonly from: string;
    readonly to: string | EventListenerFn;
    /** Stop forwarding. */
    readonly remove: () => void;
}

/**
 * Forward `from` (on `source`) to `to`: an event on `dest`, or a function. The forwarded event carries the same
 * arguments, and is dispatched at the same node. A route is an ordinary listener of the source event (`options` as for any listener).
 */
export function routeEvent(source: EventChannel, from: string, dest: EventChannel | null, to: string | EventListenerFn, options?: ListenOptions): EventRoute {
    const forward: EventListenerFn = typeof to === 'function'
        ? to
        // At the node the source event was dispatched at, if it was: node listeners on the destination hear it too.
        : (...args: unknown[]) => { dest!.publish(to, args, currentEvent()?.target ?? null); };
    const remove = source.on(from, forward, options);
    return { from: `${source.name}:${from}`, to: typeof to === 'function' ? to : `${dest!.name}:${to}`, remove };
}
