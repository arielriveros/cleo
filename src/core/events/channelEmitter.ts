// A typed, TypedEmitter-shaped view of one channel: how `engineEventBus` (and `CleoEngine.eventEmitter`) became the
// engine channel without its ~50 subscribers changing. `on`/`off`/`once` chain and return the view; a listener is
// subscribed once however often it is added (the old emitter kept a Set); `emit` is synchronous.
//
// A leaf: imports only within src/core/events, and the dependency-free TypedEmitter.
import { TypedEmitter } from '../typedEmitter';
import type { EventChannel } from './channel';
import type { EventListenerFn, ListenOptions } from './emitter';

type EmitArgs<T> = [T] extends [void] ? [] : [payload: T];

const NO_ARGS: readonly unknown[] = Object.freeze([]);

export class ChannelEmitter<Events extends Record<string, any>> extends TypedEmitter<Events> {
    constructor(public readonly channel: EventChannel) { super(); }

    public override on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void, options?: ListenOptions): this {
        const name = event as string;
        if (!this.channel.listeners.has(name, listener as EventListenerFn)) this.channel.on(name, listener as EventListenerFn, options);
        return this;
    }

    public override off<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): this {
        this.channel.off(event as string, listener as EventListenerFn);
        return this;
    }

    public override once<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): this {
        this.channel.once(event as string, listener as EventListenerFn);
        return this;
    }

    public override emit<K extends keyof Events>(event: K, ...args: EmitArgs<Events[K]>): boolean;
    public override emit(event: any, payload?: any): boolean {
        // No rest parameter: an emit nobody listens to (most LOG and SCENE_CHANGED) builds nothing.
        return arguments.length > 1 ? this.channel.emitOne(event, payload) : this.channel.emitArgs(event, NO_ARGS);
    }

    /** Queue `event` for the channel's flush, once per `coalesce` key (see EventChannel.defer). */
    public post<K extends keyof Events>(event: K, payload: Events[K], coalesce?: unknown, merge?: (queued: Events[K], next: Events[K]) => Events[K]): void {
        this.channel.defer(event as string, [payload], {
            coalesce,
            merge: merge ? (queued, next) => [merge(queued[0] as Events[K], next[0] as Events[K])] : undefined,
        });
    }

    /** The payload queued under coalescing `key`, to fold a new change into in place; undefined if none waits. */
    public queuedPayload<K extends keyof Events>(_event: K, key: unknown): Events[K] | undefined {
        return this.channel.queuedArgs(key)?.[0] as Events[K] | undefined;
    }

    /** Whether anything listens to `event`. Ask before building an expensive payload. */
    public hasListeners<K extends keyof Events>(event: K): boolean {
        return this.channel.listeners.count(event as string) > 0;
    }

    public override removeAllListeners<K extends keyof Events>(event?: K): this {
        this.channel.listeners.clear(event as string | undefined);
        return this;
    }
}
