// Imports must stay type-only: this module has to be dependency-free at runtime (see engineEventBus).
import type { LogEntry } from './logger';
import type { Node } from './scene/nodes/node';
import type { ActionState } from '../input/actionMap';

/**
 * What kind of mutation a `SCENE_CHANGED` event describes. The first three are *structural* — they
 * change which nodes exist or are visible, and Scene listens for exactly those to re-filter its typed
 * node lists. The rest are property edits that do not change scene membership.
 */
export type ChangeKind =
  | 'structure'
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

/** Where a node sat in the tree, as carried by a `structure` change's `prev`/`next`. */
export interface NodePlacement {
  parentId: string;
  index: number;
}

/**
 * What a `structure` change did. `reparent-detach` is the detach half of a re-parent and exists to be
 * IGNORED by a recorder: the `reparent` event that follows describes the same move in full.
 */
export type StructureOp = 'add' | 'remove' | 'reparent' | 'reparent-detach' | 'spawn' | 'despawn' | 'sleep';

/**
 * Payload of the unified `SCENE_CHANGED` event: "something of kind `kind` changed on `node`". One flat
 * discriminated shape, so a single listener handles every mutation. How much detail arrives varies by
 * kind, and a recorder must be built around that:
 *   * `structure` carries `prop: StructureOp` plus `prev`/`next` as {@link NodePlacement} — enough for
 *     an exact inverse.
 *   * `variable` and `component` carry the property name and its old/new value.
 *   * `transform` carries which of position/rotation/scale changed, but NO values.
 *   * The rest carry at most `{ kind, node }`.
 * Anything without an explicit inverse is undone from a subtree snapshot instead.
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
  /**
   * The renderer rewrote its own settings — the quality-preset setter moves bloom, SSAO, motion blur,
   * shadow resolution and render scale at once. Anything mirroring renderer state must re-read here.
   */
  RENDER_SETTINGS_CHANGED: void;
  /**
   * An input action changed phase this frame. GATED on `authoring.enabled`, exactly as the
   * property-level SCENE_CHANGED kinds are: without that a published game would pay an emit per action
   * per frame forever. It exists for the editor's live binding monitor, which is what makes tuning a
   * deadzone something other than guesswork.
   */
  INPUT_ACTION: { map: string; action: string; state: ActionState };
  /** The active input map was replaced — a project load, or an edit in the Input panel. */
  INPUT_MAP_CHANGED: void;
}

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

/**
 * The engine-wide event bus, and the same object as `CleoEngine.eventEmitter`. It must stay in this
 * dependency-free module: `Logger` emits through it, so putting it on the engine class would make every
 * module that logs — including WebGL-free algorithm modules — pull in the whole renderer graph.
 */
export const engineEventBus = new TypedEmitter<EngineEventMap>();

/**
 * Authoring gate for property-level SCENE_CHANGED events (the kinds fired from every setter). Default
 * false, so Play mode and a published game pay nothing. STRUCTURAL changes (add/remove/visible) ignore
 * it — the Scene relies on those for correctness. `CleoEngine.authoringMode` delegates here.
 *
 * Must stay in this leaf module: `Node` reads it, and an import from there to engine.ts would close a
 * cycle through the class every node subclass extends at module-evaluation time.
 */
export const authoring = { enabled: false };
