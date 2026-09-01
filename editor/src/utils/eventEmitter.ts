/**
 * The editor's event bus, in about thirty lines.
 *
 * This used to be node's `events` package, which webpack resolved out of the tree console-feed drags
 * in -- a direct import of an undeclared dependency, kept alive by nothing but npm's hoisting. Vite
 * does not shim node builtins, so rather than declare a node polyfill for a browser app the four
 * methods the editor actually uses (`emit` x180, `on` x45, `off` x36, `removeAllListeners` x1) are
 * implemented here.
 *
 * Two things this buys beyond dropping a dependency: node's ten-listener
 * `MaxListenersExceededWarning`, which forty-five `.on` sites were always one feature away from
 * tripping, is gone; and `emit` iterates a COPY of the listener list, so a handler that unsubscribes
 * itself (several do, on unmount) cannot make the loop skip the next one.
 */
type Listener = (...args: any[]) => void;

export class EventEmitter {
  private listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event);
    if (list) list.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  off(event: string, listener: Listener): this {
    const list = this.listeners.get(event);
    if (!list) return this;
    // Only the FIRST match, matching node: the same function may legitimately be registered twice.
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
    if (list.length === 0) this.listeners.delete(event);
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }
}

export default EventEmitter;
