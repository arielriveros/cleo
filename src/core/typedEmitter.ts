// A minimal typed event emitter. No imports, so any module — engine, worker or the Node host — can use it.

type Listener<T> = (payload: T) => void;
/** For `void` events `emit(name)` takes no payload; otherwise it takes the typed payload. */
type EmitArgs<T> = [T] extends [void] ? [] : [payload: T];

/**
 * Minimal typed event emitter — `on`/`off`/`once`/`emit`, with a compiler-checked payload type per
 * event. Deliberately tiny and dependency-free, so importing it stays cheap.
 */
export class TypedEmitter<Events extends Record<string, any>> {
  private _listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    let set = this._listeners[event];
    if (!set) { set = new Set(); this._listeners[event] = set; }
    set.add(listener);
    return this;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    this._listeners[event]?.delete(listener);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const wrapper: Listener<Events[K]> = (payload) => { this.off(event, wrapper); listener(payload); };
    return this.on(event, wrapper);
  }

  emit<K extends keyof Events>(event: K, ...args: EmitArgs<Events[K]>): boolean {
    const set = this._listeners[event];
    if (!set || set.size === 0) return false;
    const payload = args[0] as Events[K];
    // Iterate a copy so a listener that unsubscribes (or subscribes) during dispatch can't disturb it.
    for (const listener of [...set]) listener(payload);
    return true;
  }

  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event === undefined) this._listeners = {};
    else delete this._listeners[event];
    return this;
  }
}
