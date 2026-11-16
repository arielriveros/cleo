// Game events: named messages scripts send each other without knowing who listens.
//
//   GameEvents.emit('PlayerDied', { by: 'Hollow' })       // anywhere
//   @onEvent('PlayerDied') onDied(info) { … }              // on any script (see decorators.ts)
//
// Distinct from the engine's own event bus (engineEventBus), which carries editor and renderer traffic and is
// not part of what a game builds on. A leaf: imports nothing.

type Listener = (payload: any) => void;

const listeners = new Map<string, Set<Listener>>();

export const GameEvents = {
    /** Calls every listener of `name` with `payload`. A listener's throw is reported, and the rest still run. */
    emit(name: string, payload?: unknown): boolean {
        const set = listeners.get(name);
        if (!set || set.size === 0) return false;
        for (const fn of [...set]) fn(payload);   // a copy: a listener may unsubscribe while it runs
        return true;
    },

    /** Listens to `name`. Returns the function that stops listening. */
    on(name: string, fn: (payload: any) => void): () => void {
        let set = listeners.get(name);
        if (!set) { set = new Set(); listeners.set(name, set); }
        set.add(fn);
        return () => { set!.delete(fn); };
    },

    /** Stops listening. */
    off(name: string, fn: (payload: any) => void): void {
        listeners.get(name)?.delete(fn);
    },
};
