// Game events: named messages scripts send each other without knowing who listens.
//
//   GameEvents.emit('PlayerDied', { by: 'Hollow' })       // anywhere
//   @onEvent('PlayerDied') onDied(info) { … }              // on any script (see decorators.ts)
//
// GameEvents is the original, one-payload face of the hub's `game` channel (src/core/events): the same listeners
// `Events.on` and `@onEvent` add, so the two mix freely. A qualified name (`'combat:Hit'`) reaches another channel.
// `Events` adds the rest: several arguments, async and deferred delivery, events at a node.
//
// A leaf: imports only the event system, which imports nothing outside itself.
import { DEFAULT_CHANNEL, getChannel, resolveEvent } from '../events/hub';
import type { EventChannel } from '../events/channel';

/** The game channel, looked up once: a plain name (no `channel:`) goes straight to it. */
let game: EventChannel | null = null;

export const GameEvents = {
    /** Calls every listener of `name` with `payload`. A listener's throw is reported, and the rest still run. */
    emit(name: string, payload?: unknown): boolean {
        if (name.indexOf(':') < 0) return (game ??= getChannel(DEFAULT_CHANNEL)).emitOne(name, payload);
        const resolved = resolveEvent(name);
        return resolved[0].emitOne(resolved[1], payload);
    },

    /** Listens to `name`. Returns the function that stops listening. */
    on(name: string, fn: (payload: any) => void): () => void {
        const [channel, plain] = resolveEvent(name);
        return channel.on(plain, fn);
    },

    /** Stops listening. */
    off(name: string, fn: (payload: any) => void): void {
        const [channel, plain] = resolveEvent(name);
        channel.off(plain, fn);
    },
};
