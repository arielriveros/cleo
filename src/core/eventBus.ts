// Type-only imports — erased at compile time, so this module stays dependency-free at runtime and
// Logger can still reach the bus without transitively importing the renderer graph (see engineEventBus).
import type { LogEntry } from './logger';
import type { Node } from './scene/node';

/**
 * What kind of mutation a `SCENE_CHANGED` event describes.
 *
 * The first three are *structural* — they change which nodes exist / are visible, so the scene must
 * re-filter its typed node lists (Scene listens for exactly these). The rest are property edits that
 * do not change scene membership; the editor observes them to mark the tab unsaved and refresh the
 * one affected inspector panel.
 */
export type ChangeKind =
  | 'structure'    // node added / removed / re-parented
  | 'visibility'
  | 'name'
  | 'transform'
  | 'variable'
  | 'physics'
  | 'script'
  | 'material'
  | 'texture'
  | 'light'
  | 'camera'
  | 'environment'
  | 'component';

/**
 * Payload of the unified `SCENE_CHANGED` event: "something of kind `kind` changed on `node`".
 *
 * Kept a single flat discriminated shape on purpose: one listener can handle every mutation uniformly
 * (the editor's dirty bridge, and a future undo/redo `HistoryManager` — the single subscriber that
 * would record inverse operations). `prop`/`prev`/`next` are optional detail a property edit can
 * supply so that a panel knows exactly what to refresh and a history recorder can build the inverse.
 */
export interface SceneChange {
  kind: ChangeKind;
  node?: Node;
  prop?: string;
  prev?: unknown;
  next?: unknown;
}

/** Engine bus event catalog: event name -> payload type. `void` means "emitted with no argument". */
export interface EngineEventMap {
  /** Any node/scene mutation. Structural kinds re-filter the scene; all kinds mark the editor dirty. */
  SCENE_CHANGED: SceneChange;
  /** A new console line was appended. */
  LOG: LogEntry;
  /** An existing console line was rewritten in place (a flush). */
  LOG_UPDATE: LogEntry;
  /** The console was cleared. */
  LOG_CLEAR: void;
}

type Listener<T> = (payload: T) => void;
/** For `void` events `emit(name)` takes no payload; otherwise it takes the typed payload. */
type EmitArgs<T> = [T] extends [void] ? [] : [payload: T];

/**
 * Minimal typed event emitter — replaces the Node.js `events` EventEmitter the bus used to be.
 *
 * The whole engine only ever used `on`/`off`/`emit`, so a ~40-line hand-rolled emitter drops the
 * browser polyfill and, more importantly, gives every event a compiler-checked payload type. Kept
 * tiny and dependency-free so importing it stays cheap.
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

/**
 * The engine-wide event bus, in its own module so lightweight producers can reach it without importing
 * the whole engine.
 *
 * `CleoEngine.eventEmitter` is exactly this object (engine.ts assigns it), so every existing
 * `CleoEngine.eventEmitter.on(...)` consumer is unaffected. The reason it lives here rather than on the
 * engine class: `Logger` emits through it, and if `Logger` imported `engine.ts` to reach it, then any
 * module that logs — including pure, WebGL-free algorithm modules like physics/convexHull.ts — would
 * transitively pull in the entire renderer graph (and the vendored assimpjs blob), which breaks their
 * isolated unit tests. Importing this one-line module keeps `Logger` cheap.
 */
export const engineEventBus = new TypedEmitter<EngineEventMap>();
