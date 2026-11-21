// Decorators for script classes: what a field or method of a script means to the engine and the editor.
// Scripts import them from 'cleo/decorators' (src/decorators.ts), not from the 'cleo' barrel; the barrel keeps
// only the machinery below (applyScriptDecorators, membersOfNode, …).
//
//   import { child, find, onAction, save } from 'cleo/decorators'
//
//   export default class Turret extends Node {
//     @child('Muzzle') private _muzzle?: Node            // filled in before onConstruct / onStart
//     @find('GameManager') private _gm?: GameManagerNode  // the same, searching the whole scene
//     @save kills = 0                                     // kept by saves
//     @onAction('Fire') fire() { … }                      // called when the Fire action is pressed
//   }
//
// They are standard (TC39) decorators: each records what it says into the class's decorator metadata,
// `Class[Symbol.metadata]`, and nothing else. Two compilers produce that metadata the same way: Cleo's own
// script compile (scriptDecoratorLowering.ts, which ends each decorated class with a call to
// applyScriptDecorators), and any compiler that implements the standard (esbuild, in the engine's tests,
// compiling a script class used directly as a Node subclass). The engine reads it back with
// membersOfNode() — nodeScripting.ts fills the references, scene.ts routes the actions — and the editor's
// reflection reads the same decorators from the source text.
//
// Their doc comments are what the script editors show on hover, in signature help and in the `@` completion
// list, so: a first sentence that stands alone, an `@param` for every parameter, and examples as inline code
// whose `@` comes right after the opening backtick. TypeScript starts a tag at any `@` that begins a line or
// follows a space -- inside backticks and ``` fences too -- and the hover then shows the rest as that tag
// (tests/decoratorDocs.test.ts holds the line).
//
// A leaf: type-only imports, bar the event system (src/core/events), which imports nothing outside itself.
import type { NetCallOptions, NetCallTarget, SceneNet } from '../net/sceneNet';
import { ANIMATION_CHANNEL, CANCEL_EVENT, DEFAULT_CHANNEL, fireEvent, splitEventName } from '../events/hub';
import type { EventDestination } from '../events/broker';
import type { Node } from '../scene/nodes/node';
import type { ActionState } from '../../input/actionMap';
import type { ActionName, ScriptPickKind, TriggerName } from './fieldTypes';
import { ANIMATOR_CHANNEL } from '../../animation/animatorCommands';

/**
 * Where a class keeps its decorator metadata: the standard `Symbol.metadata`, or, while the JS engine has
 * none, the registered stand-in that compilers implementing decorators (esbuild, TypeScript) use too.
 */
export const SCRIPT_METADATA: symbol = (Symbol as any).metadata ?? Symbol.for('Symbol.metadata');

/** The members a class's own decorators recorded, in its metadata object. */
const MEMBERS = Symbol.for('cleo.scriptMembers');
/** The fields of that class declared `name?:` (known to Cleo's own compile only). */
const OPTIONAL = Symbol.for('cleo.optionalFields');

/**
 * Which change of an action calls an `@onAction` method:
 * - `'started'` (the default): the press — `state.started`, as `Input.started` reads it.
 * - `'released'`: the release — `state.released`.
 * - `'performed'`: the action completing — on the press for a tap, once held long enough for a hold action.
 * - `'changed'`: every change: press, release and each phase in between; the method reads `state`.
 */
export type ActionWhen = 'started' | 'released' | 'performed' | 'changed';

/** One decorated member, as the engine reads it back (see {@link membersOfNode}). */
export type ScriptMember =
    | { kind: 'child' | 'find'; field: string; name: string; optional: boolean }
    | { kind: 'action'; method: string; action: string; when: ActionWhen }
    | { kind: 'event'; method: string; name: string; channel: string; once: boolean; priority: number; where?: EventWhereLiteral }
    | { kind: 'targetEvent'; method: string; name: string; channel: string; capture: boolean; once: boolean; priority: number; where?: EventWhereLiteral }
    | { kind: 'dispatch'; method: string; name: string; channel: string }
    | { kind: 'observable'; field: string; name: string; channel: string }
    | { kind: 'animTrigger'; method: string; trigger: string }
    | { kind: 'animAction'; method: string; clip: string }
    | { kind: 'animParam'; field: string; param: string }
    | { kind: 'every'; method: string; seconds: number }
    | { kind: 'enter' | 'exit'; method: string; filter: string }
    | { kind: 'hold'; method: string; action: string; seconds: number }
    | { kind: 'tap'; method: string; action: string; maxSeconds: number }
    | { kind: 'attribute'; field: string; group?: string; options: AttributeOptions }
    | { kind: 'save'; field: string }
    | { kind: 'options'; field: string; list: string }
    | { kind: 'pick'; field: string; pick: ScriptPickKind }
    | { kind: 'synced'; field: string; onChange?: string }
    | { kind: 'netcall'; method: string; to: NetCallTarget; reliable: boolean; anyone: boolean };

type Recorded = ScriptMember extends infer M ? M extends { optional: boolean } ? Omit<M, 'optional'> : M : never;

/** The parts of a decorator context these decorators read (the standard's, or the lowering's copy of it). */
interface DecoratorContextLike {
    kind: string;
    name: string | symbol;
    static: boolean;
    private: boolean;
    metadata?: object;
}

const hasOwn = (o: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(o, key);

/** An array owned by `metadata` itself — never one inherited from a base class's metadata. */
function ownList<T>(metadata: any, key: symbol): T[] {
    if (!hasOwn(metadata, key)) Object.defineProperty(metadata, key, { value: [], enumerable: false, configurable: true });
    return metadata[key];
}

function memberName(label: string, context: DecoratorContextLike, kind: 'field' | 'method'): string {
    if (context.kind !== kind)
        throw new TypeError(`${label} goes on a ${kind}, not on a ${context.kind}`);
    if (context.static)
        throw new TypeError(`${label} is on static '${String(context.name)}': script decorators go on a class's instance members`);
    if (context.private || typeof context.name !== 'string')
        throw new TypeError(`${label} is on a #private or symbol-named member: give it a plain name`);
    return context.name;
}

function record(label: string, context: DecoratorContextLike, entry: Recorded): void {
    if (!context.metadata)
        throw new Error(`${label} needs decorator metadata (Symbol.metadata), which this script's compiler did not provide`);
    ownList<Recorded>(context.metadata, MEMBERS).push(entry);
}

function needName(label: string, value: unknown): string {
    if (typeof value !== 'string' || !value) throw new TypeError(`${label} needs a name`);
    return value;
}

/**
 * A decorator for a class field, such as `@save` or what `@child('Muzzle')` returns.
 *
 * `Allowed` is the field types it accepts, so a `@child` on a number field is a type error; `Owner` is what
 * the class itself must have (`@options('list')` needs a `list` field).
 */
export type FieldDecorator<Allowed = unknown, Owner = unknown> =
    <This extends Owner, V extends Allowed>(value: undefined, context: ClassFieldDecoratorContext<This, V>) => void;

/**
 * A decorator for a class method, such as what `@onAction('Jump')` returns. `Args` is what the method is
 * called with: a method may take fewer, never more.
 */
export type MethodDecorator<Args extends unknown[] = []> =
    <This>(method: (this: This, ...args: Args) => unknown, context: ClassMethodDecoratorContext<This>) => void;

/**
 * Fills the field with the nearest node called `name` under this one, before `onConstruct` and again before
 * `onStart` while it is still empty.
 *
 * Breadth-first, so a direct child wins over a deeper one. Declare the field `name?:` when the node may be
 * missing; otherwise a missing one is reported once, before `onStart`. A value already in the field (assigned,
 * or restored by a save) is kept.
 *
 * - `@child('Muzzle') private _muzzle?: Node` — the Muzzle under this node
 * - `@child('HealthBar/Fill') fill: Node` — the Fill nearest under the HealthBar nearest
 *
 * @param name The node's name, or a path of names separated by `/`. Written out, not a variable.
 */
export function child(name: string): FieldDecorator<Node | null | undefined> {
    const target = needName('@child', name);
    return function <This, V extends Node | null | undefined>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
        record('@child', context, { kind: 'child', field: memberName('@child', context, 'field'), name: target });
    };
}

/**
 * Fills the field with the node called `name` anywhere in the scene (`findNode`), at the same moments and
 * with the same rules as `@child`.
 *
 * - `@find('GameManager') private _gm: Node | null = null`
 *
 * @param name The node's name. Written out, not a variable.
 */
export function find(name: string): FieldDecorator<Node | null | undefined> {
    const target = needName('@find', name);
    return function <This, V extends Node | null | undefined>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
        record('@find', context, { kind: 'find', field: memberName('@find', context, 'field'), name: target });
    };
}

/**
 * Calls the method when the input action is pressed, or at the change `when` names.
 *
 * The method gets the action's `ActionState`. As with an `onAction` handler, nothing is delivered while the
 * game is paused, and a script may keep its own `onAction` as well.
 *
 * - `@onAction('Jump') jump(state: ActionState) { … }` — pressed
 * - `@onAction('Jump', 'released') land() { … }` — released
 *
 * @param action The action's name (`'Jump'`), or map-qualified (`'Gameplay/Jump'`): one the project's input
 * map declares.
 * @param when `'started'` (the press, the default), `'released'`, `'performed'` (the action completing) or
 * `'changed'` (every change).
 */
export function onAction(action: ActionName, when: ActionWhen = 'started'): MethodDecorator<[state: ActionState]> {
    const name = needName('@onAction', action);
    return function <This>(_method: (this: This, state: ActionState) => unknown, context: ClassMethodDecoratorContext<This>): void {
        record('@onAction', context, { kind: 'action', method: memberName('@onAction', context, 'method'), action: name, when });
    };
}

/** A `where` written in a decorator: fields the event's first argument must have, compared with `===`. */
export type EventWhereLiteral = Readonly<Record<string, string | number | boolean | null>>;

/** What `@onEvent` takes after the event's name. Every option is optional; write them as literals. */
export interface EventListenerOptions {
    /** The channel, when the name does not say one (`'combat:Hit'` does). The game channel by default. */
    channel?: string;
    /** Only the first event of each life of the node (heard again after a respawn). */
    once?: boolean;
    /** Higher runs before lower; equal ones in the order the nodes spawned. Default 0. */
    priority?: number;
    /** Only events whose first argument has these fields: `{ where: { team: 'red' } }`. */
    where?: EventWhereLiteral;
}

/** What `@eventListener` takes after the event's name: `@onEvent`'s options, and `capture`. */
export interface TargetListenerOptions extends EventListenerOptions {
    /**
     * Hear it on its way DOWN to a node beneath this one, before that node's own listeners (and so before the
     * bubble back up): a parent that must see an event first.
     */
    capture?: boolean;
}

function splitListened(label: string, name: string, options: EventListenerOptions | undefined, fallback: string): [channel: string, name: string] {
    const qualified = needName(label, name);
    if (options !== undefined && (options === null || typeof options !== 'object'))
        throw new TypeError(`${label}('${qualified}', options): options must be an object, such as { once: true }`);
    return splitEventName(qualified, options?.channel ?? fallback);
}

function listenerFields(options: EventListenerOptions | undefined): { once: boolean; priority: number; where?: EventWhereLiteral } {
    const out: { once: boolean; priority: number; where?: EventWhereLiteral } = {
        once: !!options?.once,
        priority: typeof options?.priority === 'number' && Number.isFinite(options.priority) ? options.priority : 0,
    };
    if (options?.where && typeof options.where === 'object') out.where = { ...options.where };
    return out;
}

/**
 * Calls the method whenever an event of that name is sent on its channel, from anywhere, while the node is awake.
 *
 * Listens from the node's spawn until it despawns or is removed: no setup in `onStart`, no cleanup. The method is
 * called with the event's arguments. It also hears an event dispatched at a node, once that event has finished
 * bubbling; `Events.current.target` says which node.
 *
 * - `@onEvent('PlayerDied') died(info) { … }` — for `GameEvents.emit('PlayerDied', info)` anywhere
 * - `@onEvent('combat:Hit') hit(target, damage) { … }` — on the combat channel
 * - `@onEvent('Died', { where: { team: 'red' }, once: true }) firstRed(info) { … }`
 *
 * @param name The event's name, as `GameEvents.emit` or `Events.emit` sends it; `'channel:Name'` for a channel
 * other than the game's.
 * @param options `channel`, `once`, `priority`, and `where` (fields the first argument must have).
 */
export function onEvent(name: string, options?: EventListenerOptions): MethodDecorator<any[]> {
  const [channel, event] = splitListened('@onEvent', name, options, DEFAULT_CHANNEL);
  return function <This>(_method: (this: This, ...args: any[]) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onEvent', context, { kind: 'event', method: memberName('@onEvent', context, 'method'), name: event, channel, ...listenerFields(options) });
  };
}

/**
 * Calls the method when an event of that name is dispatched at this node, or bubbles up from a node beneath it,
 * while the node is awake.
 *
 * Events travel DOM-style: down to the node they are dispatched at (capture), that node, back up through its
 * ancestors (bubble), and last to the channel's own listeners (`@onEvent`). A character's script hears what its
 * model's animator, its weapon or its hitbox dispatches, and no other character's. The method is called with the
 * event's arguments; `Events.current` is the event (`target`, `stopPropagation()`).
 *
 * - `@eventListener('Shot') shot(result) { … }` — for `@eventDispatch('Shot')` on this node or beneath it
 * - `@eventListener('animation:footstep') step(info) { … }` — a clip marker from this character's animator
 * - `@eventListener('Damaged', { capture: true }) shield(hit) { … }` — before the node that was hit hears it
 *
 * @param name The event's name; `'channel:Name'` for a channel other than the game's.
 * @param options `channel`, `capture`, `once`, `priority`, and `where` (fields the first argument must have).
 */
export function eventListener(name: string, options?: TargetListenerOptions): MethodDecorator<any[]> {
  const [channel, event] = splitListened('@eventListener', name, options, DEFAULT_CHANNEL);
  return function <This>(_method: (this: This, ...args: any[]) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@eventListener', context, {
      kind: 'targetEvent', method: memberName('@eventListener', context, 'method'), name: event, channel,
      capture: !!options?.capture, ...listenerFields(options),
    });
  };
}

/**
 * Calls the method when this node's animator, or one beneath it (the character's model), reaches an event marker
 * on a clip, while the node is awake.
 *
 * The method gets what the marker fired with: `{ event, clip, state, layer, node, animator }`. No subscribing in
 * `onStart`, no unsubscribing in `onDespawn`: a pooled character that respawns hears each marker once.
 *
 * - `@onClipEvent('hit') land(info) { … }` — every clip's `hit` marker
 * - `@onClipEvent('footstep', 'Run') step(info) { … }` — only the Run clip's
 *
 * @param name The marker's name, as the clip's events track shows it.
 * @param clip Only this clip's marker. Empty (the default) for any clip.
 */
export function onClipEvent(name: string, clip: string = ''): MethodDecorator<[info: any]> {
  const [channel, event] = splitListened('@onClipEvent', name, undefined, ANIMATION_CHANNEL);
  return function <This>(_method: (this: This, info: any) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onClipEvent', context, {
      kind: 'targetEvent', method: memberName('@onClipEvent', context, 'method'), name: event, channel,
      capture: false, once: false, priority: 0, ...(clip ? { where: { clip } } : {}),
    });
  };
}

/** What `@eventDispatch` takes in its long form. */
export interface EventDispatchOptions {
    /** The event's name; `'channel:Name'` for a channel other than the game's. */
    name: string;
    /** The channel, when the name does not say one. */
    channel?: string;
    /** Sent after the method's result: listeners get `(result, ...args)`. Literals. */
    args?: unknown[];
    /**
     * `'sync'` (the default): listeners run before the method's caller continues. `'async'`: their promises are
     * awaited, and the method resolves after they settle. `'deferred'`: they run at the frame's event flush.
     */
    mode?: 'sync' | 'async' | 'deferred';
    /** Up through this node's ancestors after it (default true). */
    bubbles?: boolean;
    /** On to the channel's own listeners (`@onEvent`) at the end (default true). */
    broadcast?: boolean;
    /**
     * This machine only (`'local'`, the default), or in a NetSync game also `'host'`, `'peers'` or `'all'`, where
     * it is dispatched at each machine's copy of this node. Offline it is simply delivered here.
     */
    to?: EventDestination;
}

/**
 * Sends an event each time the method runs, with what it returned: dispatched at this node, it bubbles up
 * through its ancestors (`@eventListener`) and ends at the channel's listeners (`@onEvent`).
 *
 * Listeners get `(result, ...extras)`. An async method's result is awaited first. Returning `Events.cancel`
 * sends nothing that time, and the caller gets `undefined`.
 *
 * - `@eventDispatch('Shot') fire() { return { damage: 10 } }` — listeners get `{ damage: 10 }`
 * - `@eventDispatch('Shot', 'pistol') fire() { … }` — listeners get `(result, 'pistol')`
 * - `@eventDispatch({ name: 'Saved', mode: 'async' }) async save() { … }` — resolves once the listeners have
 *
 * @param name The event's name (`'channel:Name'` for another channel), or the long form's options: `name`,
 * `channel`, `args`, `mode` (`'sync'`, `'async'`, `'deferred'`), `bubbles`, `broadcast`, `to`.
 * @param extras Literals sent after the method's result.
 */
export function eventDispatch(name: string | EventDispatchOptions, ...extras: unknown[]): MethodDecorator<any[]> {
    const options: EventDispatchOptions = typeof name === 'string' ? { name, args: extras } : name;
    if (!options || typeof options !== 'object') throw new TypeError(`@eventDispatch needs an event name, or { name, ... }`);
    const [channel, event] = splitEventName(needName('@eventDispatch', options.name), options.channel ?? DEFAULT_CHANNEL);
    const qualified = `${channel}:${event}`;
    const trailing = Array.isArray(options.args) ? options.args.slice() : [];
    const mode = options.mode ?? 'sync';
    if (mode !== 'sync' && mode !== 'async' && mode !== 'deferred')
        throw new TypeError(`@eventDispatch mode must be 'sync', 'async' or 'deferred', not '${String(mode)}'`);
    const send = { mode, bubbles: options.bubbles, broadcast: options.broadcast, to: options.to ?? 'local' } as const;
    return function <This>(method: (this: This, ...args: any[]) => unknown, context: ClassMethodDecoratorContext<This>): any {
        const label = memberName('@eventDispatch', context, 'method');
        record('@eventDispatch', context, { kind: 'dispatch', method: label, name: event, channel });
        const original = method;
        const sent = (self: unknown, value: unknown): unknown => {
            if (value === CANCEL_EVENT) return undefined;
            const delivered = fireEvent(qualified, trailing.length === 0 ? [value] : [value, ...trailing], self && typeof self === 'object' ? self : null, send);
            return delivered instanceof Promise ? delivered.then(() => value) : value;
        };
        const dispatching = function (this: unknown, ...args: unknown[]): unknown {
            const result = original.apply(this as This, args);
            if (result && typeof (result as PromiseLike<unknown>).then === 'function')
                return Promise.resolve(result).then((value) => sent(this, value));
            return sent(this, result);
        };
        // Written above a @netcall (so wrapping its router), the network must still find the method a call runs.
        const netOriginal = (original as any)[NETCALL_ORIGINAL];
        if (netOriginal) Object.defineProperty(dispatching, NETCALL_ORIGINAL, { value: netOriginal });
        return dispatching;
    };
}

/** What `observable` is: the bare decorator, and the way of calling it with the event's name. */
export interface ObservableDecorator {
    /**
     * Sends `<field>Changed` at this node whenever the field is set to a different value, with `(value, previous)`.
     *
     * - `@observable hp = 100` — then `@eventListener('hpChanged') bar(hp, was) { … }`
     */
    <This, V>(value: undefined, context: ClassFieldDecoratorContext<This, V>): void;
    /**
     * Sends `event` at this node whenever the field is set to a different value, with `(value, previous)`.
     *
     * - `@observable('HealthChanged') hp = 100`
     *
     * @param event The event's name; `'channel:Name'` for a channel other than the game's.
     */
    (event?: string): FieldDecorator;
}

/**
 * Sends an event at this node whenever the field is set to a value other than the one it holds (`!==`), with
 * `(value, previous)`: `<field>Changed` by default, which `@eventListener('hpChanged')` on it or an ancestor hears.
 *
 * An array or object changed in place is not a new value: assign a new one (`this.items = [...this.items, x]`).
 *
 * - `@observable hp = 100`
 * - `@observable('ui:ScoreChanged') score = 0`
 */
export const observable: ObservableDecorator = function observable(event?: unknown, context?: unknown): any {
    const apply = (name: string | undefined) =>
        function <This, V>(_value: undefined, ctx: ClassFieldDecoratorContext<This, V>): void {
            const field = memberName('@observable', ctx, 'field');
            const [channel, plain] = splitEventName(name || `${field}Changed`, DEFAULT_CHANNEL);
            record('@observable', ctx, { kind: 'observable', field, name: plain, channel });
        };
    // Bare `@observable`: called as the decorator itself, with the field's context.
    if (event === undefined && context && typeof context === 'object' && 'kind' in (context as object)) {
        apply(undefined)(undefined, context as ClassFieldDecoratorContext<unknown, unknown>);
        return undefined;
    }
    if (event !== undefined && typeof event !== 'string') throw new TypeError(`@observable takes the event's name, or nothing`);
    return apply(event as string | undefined);
} as ObservableDecorator;

/** How the animator decorators send their commands: down from the script's node, to every animator beneath it. */
const DOWN = { down: true } as const;

/** Wrap `original` so each call, once it has returned (awaited if async), hands its value to `after`. */
function afterEachCall<This>(original: (this: This, ...args: any[]) => unknown, after: (self: unknown, value: unknown) => unknown) {
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const result = original.apply(this as This, args);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function')
            return Promise.resolve(result).then((value) => after(this, value));
        return after(this, result);
    };
    // Written above a @netcall (so wrapping its router), the network must still find the method a call runs.
    const netOriginal = (original as any)[NETCALL_ORIGINAL];
    if (netOriginal) Object.defineProperty(wrapped, NETCALL_ORIGINAL, { value: netOriginal });
    return wrapped;
}

/**
 * Fires an animator trigger each time the method runs: sent down from this node to every animator beneath it (the
 * character's model, a sprite), as the `animator:SetTrigger` command.
 *
 * With a name, that trigger. Without one, the method's return value names it, so the trigger can come from a
 * field; returning nothing (or `null`, `''`) fires none. Returning `Events.cancel` fires none, and the caller
 * gets `undefined`. An async method's value is awaited first. The caller gets what the method returned.
 *
 * - `@animTrigger('Jump') jump() { … }` — every call fires Jump
 * - `@animTrigger() getIn() { return this.enterTrigger }` — the trigger a field names
 * - `@animTrigger('Roll') roll() { if (!this.grounded) return Events.cancel }`
 *
 * @param name The trigger: one the project's animators read. Leave it out to name it by the method's return value.
 */
export function animTrigger(name?: TriggerName): MethodDecorator<any[]> {
    const literal = name === undefined ? null : needName('@animTrigger', name);
    return function <This>(method: (this: This, ...args: any[]) => unknown, context: ClassMethodDecoratorContext<This>): any {
        record('@animTrigger', context, { kind: 'animTrigger', method: memberName('@animTrigger', context, 'method'), trigger: literal ?? '' });
        return afterEachCall(method, (self, value) => {
            if (value === CANCEL_EVENT) return undefined;
            const trigger = literal ?? (typeof value === 'string' ? value : '');
            if (trigger && self && typeof self === 'object') fireEvent(`${ANIMATOR_CHANNEL}:SetTrigger`, [trigger], self, DOWN);
            return value;
        });
    };
}

/** What `@animAction` hands the animator with the clip: the options of `playAction` (a sprite reads `restart`). */
export type AnimActionOptions = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Plays a one-shot each time the method runs: sent down from this node to every animator beneath it, as the
 * `animator:PlayAction` command — `playAction` on a skeletal animator (in a slot, over the machine), `play` on a
 * sprite.
 *
 * With a clip, that clip. Without one, the method's return value names it: a clip name, or `{ clip, ...options }`.
 * Returning nothing or `Events.cancel` plays nothing. The caller gets what the method returned.
 *
 * - `@animAction('Wave') wave() { … }`
 * - `@animAction() swing() { return { clip: 'attack' + this.combo, restart: true } }` — a sprite's combo
 *
 * @param clip The clip. Leave it out to name it by the method's return value.
 * @param options What the animator plays it with: a slot, `blendIn`, `blendOut`, `loop`, `speed`; a sprite's `restart`.
 */
export function animAction(clip?: string, options?: AnimActionOptions): MethodDecorator<any[]> {
    const literal = clip === undefined ? null : needName('@animAction', clip);
    const fixed = options && typeof options === 'object' ? { ...options } : undefined;
    return function <This>(method: (this: This, ...args: any[]) => unknown, context: ClassMethodDecoratorContext<This>): any {
        record('@animAction', context, { kind: 'animAction', method: memberName('@animAction', context, 'method'), clip: literal ?? '' });
        return afterEachCall(method, (self, value) => {
            if (value === CANCEL_EVENT) return undefined;
            let play = literal, opts: Record<string, unknown> | undefined = fixed;
            if (play === null) {
                if (typeof value === 'string') play = value;
                else if (value && typeof value === 'object' && typeof (value as { clip?: unknown }).clip === 'string') {
                    const { clip: named, ...rest } = value as { clip: string } & Record<string, unknown>;
                    play = named;
                    opts = { ...fixed, ...rest };
                }
            }
            if (play && self && typeof self === 'object') fireEvent(`${ANIMATOR_CHANNEL}:PlayAction`, [play, opts ?? {}], self, DOWN);
            return value;
        });
    };
}

/** What `animParam` is: the bare decorator, and the way of calling it with the parameter's name. */
export interface AnimParamDecorator {
    /**
     * Sends the field's value to the animator parameter of the field's own name whenever it changes, and once
     * when the node spawns.
     *
     * - `@animParam crouch = false`
     */
    <This, V extends number | boolean>(value: undefined, context: ClassFieldDecoratorContext<This, V>): void;
    /**
     * Sends the field's value to the animator parameter `name` whenever it changes, and once when the node spawns.
     *
     * - `@animParam('Moving') moving = false`
     *
     * @param name The parameter, as the animators under this node name it.
     */
    (name?: string): FieldDecorator<number | boolean>;
}

/**
 * Keeps an animator parameter set from the field: each new value (`!==`) is sent down from this node to every
 * animator beneath it as `animator:SetParam`, and the value it holds once when the node spawns. Assign the field,
 * every frame if you like: only changes are sent.
 *
 * For a parameter the animator does not read from the node itself (a Linked parameter does).
 *
 * - `@animParam('Moving') moving = false`
 * - `@animParam('AttackSpeed') attackSpeed = 1`
 */
export const animParam: AnimParamDecorator = function animParam(name?: unknown, context?: unknown): any {
    const apply = (param: string | undefined) =>
        function <This, V>(_value: undefined, ctx: ClassFieldDecoratorContext<This, V>): void {
            const field = memberName('@animParam', ctx, 'field');
            record('@animParam', ctx, { kind: 'animParam', field, param: param || field });
        };
    // Bare `@animParam`: called as the decorator itself, with the field's context.
    if (name === undefined && context && typeof context === 'object' && 'kind' in (context as object)) {
        apply(undefined)(undefined, context as ClassFieldDecoratorContext<unknown, unknown>);
        return undefined;
    }
    if (name !== undefined && typeof name !== 'string') throw new TypeError(`@animParam takes the parameter's name, or nothing`);
    return apply(name as string | undefined);
} as AnimParamDecorator;

/**
 * Calls the method every `seconds` of unpaused game time, from the node's spawn until it despawns.
 *
 * - `@every(0.5) think() { … }` — twice a second
 *
 * @param seconds The period, in seconds of game time; above 0.
 */
export function every(seconds: number): MethodDecorator {
  if (!(typeof seconds === 'number' && seconds > 0)) throw new TypeError('@every needs a period in seconds, above 0');
  return function <This>(_method: (this: This) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@every', context, { kind: 'every', method: memberName('@every', context, 'method'), seconds });
  };
}

/**
 * Calls the method with the other node when a trigger overlap with it begins, in 3D and 2D.
 *
 * The overlap is one `onTriggerEnter` would report: this node's own trigger (a Trigger node, or its Collider
 * with a trigger), or one this node walks into.
 *
 * - `@onEnter('Player') hit(other: Node) { … }` — the Player, or anything inside it
 * - `@onEnter() any(other: Node) { … }` — anything
 *
 * @param filter Who counts: a node's name, or the name of a variable the other node has set (`'isEnemy'`),
 * matched on the other node or any of its ancestors. Empty (the default) for anything.
 */
export function onEnter(filter: string = ''): MethodDecorator<[other: Node]> {
  return function <This>(_method: (this: This, other: Node) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onEnter', context, { kind: 'enter', method: memberName('@onEnter', context, 'method'), filter });
  };
}

/**
 * Calls the method with the other node when a trigger overlap with it ends: `@onEnter`'s counterpart.
 *
 * - `@onExit('Player') left(other: Node) { … }`
 *
 * @param filter Who counts, as for `@onEnter`. Empty (the default) for anything.
 */
export function onExit(filter: string = ''): MethodDecorator<[other: Node]> {
  return function <This>(_method: (this: This, other: Node) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onExit', context, { kind: 'exit', method: memberName('@onExit', context, 'method'), filter });
  };
}

/**
 * Calls the method once per press, at the moment the action has been held for `seconds`.
 *
 * It fires again only after a release and a new press, and a press that becomes a hold gets no `@onTap`.
 * Nothing is delivered while the game is paused.
 *
 * - `@onHold('Roll', 0.5) sprint(state: ActionState) { … }`
 *
 * @param action The action's name, or map-qualified (`'Gameplay/Roll'`).
 * @param seconds How long the press must last, in seconds; 0.5 by default.
 */
export function onHold(action: ActionName, seconds: number = 0.5): MethodDecorator<[state: ActionState]> {
  const name = needName('@onHold', action);
  return function <This>(_method: (this: This, state: ActionState) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onHold', context, { kind: 'hold', method: memberName('@onHold', context, 'method'), action: name, seconds });
  };
}

/**
 * Calls the method when the action is released after a press no longer than `maxSeconds`: a tap.
 *
 * A longer press is a hold (see `@onHold`) and gets no tap. Nothing is delivered while the game is paused.
 *
 * - `@onTap('Roll') roll(state: ActionState) { … }`
 *
 * @param action The action's name, or map-qualified (`'Gameplay/Roll'`).
 * @param maxSeconds The longest press that still counts as a tap, in seconds; 0.25 by default.
 */
export function onTap(action: ActionName, maxSeconds: number = 0.25): MethodDecorator<[state: ActionState]> {
  const name = needName('@onTap', action);
  return function <This>(_method: (this: This, state: ActionState) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onTap', context, { kind: 'tap', method: memberName('@onTap', context, 'method'), action: name, maxSeconds });
  };
}

/** How an `@attribute` field shows in the inspector. Every option is editor-only: the game never reads them. */
export interface AttributeOptions {
    /** The row's name, instead of the field's. */
    label?: string;
    /** A number field's range: a slider, and values clamped to it. `step` snaps them. */
    min?: number;
    max?: number;
    step?: number;
    /** Shown, not editable. */
    readonly?: boolean;
    /**
     * Shown only while another attribute says so: `'flag'` — that field is truthy; `['mode', 'ranged']` —
     * it equals that value.
     */
    showIf?: string | [field: string, value: unknown];
    /** A `[r, g, b]` field picked with a colour picker (components 0..1). */
    color?: boolean;
    /** A string field edited in a text area. */
    multiline?: boolean;
}

/** What `attribute` is: the bare decorator, and the two ways of calling it with a group or options. */
export interface AttributeDecorator {
    /**
     * Shows the field in the inspector's Behaviors panel, in its Attributes section.
     *
     * - `@attribute speed = 4`
     */
    <This, V>(value: undefined, context: ClassFieldDecoratorContext<This, V>): void;
    /**
     * Shows the field in the inspector's Behaviors panel, in a collapsible section titled `group`.
     *
     * - `@attribute('Combat') damage = 10` — a "Combat" section
     * - `@attribute('Combat', { min: 0, max: 1, step: 0.05 }) crit = 0.1` — a slider in it
     *
     * @param group The section's title; sections appear in the order their first field is declared. Without
     * one, the Attributes section.
     * @param options How the row shows: label, range, read-only, showIf, colour, multiline.
     */
    (group?: string, options?: AttributeOptions): FieldDecorator;
    /**
     * Shows the field in the inspector's Behaviors panel, in its Attributes section, the way `options` say.
     *
     * - `@attribute({ readonly: true }) kills = 0`
     * - `@attribute({ label: 'Tint', color: true }) private _tint = [1, 1, 1]`
     *
     * @param options How the row shows: label, range, read-only, showIf, colour, multiline.
     */
    (options: AttributeOptions): FieldDecorator;
}

/**
 * Shows the field in the inspector (the Behaviors panel), whatever its access: public, protected or private.
 *
 * A field without it is the script's own state: not shown, not stored per node, not overridden by templates.
 * The field's doc comment becomes the row's tooltip. Arguments must be literals.
 *
 * - `@attribute maxHp = 100` — in the Attributes section
 * - `@attribute('Combat') damage = 10` — in a "Combat" section
 * - `@attribute('Combat', { min: 0, max: 1 }) crit = 0.1` — a slider
 * - `@attribute({ readonly: true }) hp = 100` — shown, not editable
 */
export const attribute: AttributeDecorator = function attribute(group?: unknown, options?: unknown): any {
    const apply = (name: string | undefined, opts: AttributeOptions) =>
        function <This, V>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
            record('@attribute', context, { kind: 'attribute', field: memberName('@attribute', context, 'field'), group: name, options: opts });
        };
    // Bare `@attribute`: called as the decorator itself, with the field's context.
    if (group === undefined && options && typeof options === 'object' && 'kind' in (options as object)) {
        apply(undefined, {})(undefined, options as ClassFieldDecoratorContext<unknown, unknown>);
        return undefined;
    }
    const name = typeof group === 'string' ? group : undefined;
    const opts = ((group && typeof group === 'object' ? group : options) ?? {}) as AttributeOptions;
    return apply(name, opts);
} as AttributeDecorator;

/** What `@synced` accepts: bare, or with options. */
export interface SyncedOptions {
    /**
     * A method of this script to call on each peer when a new value arrives, with the previous value:
     * `@synced({ onChange: 'swing' }) open = false` then `swing(was: boolean) { … }`.
     */
    onChange?: string;
}

/** What `synced` is: the bare decorator, and the way of calling it with options. */
export interface SyncedDecorator {
    /**
     * The host keeps every peer's copy of this field up to date (docs/design/netsync.md §6.3): set it on the host,
     * the peers see the new value, reliably and in order. Numbers, booleans, strings, arrays, plain objects and
     * node references. Offline it is an ordinary field.
     *
     * - `@synced open = false`
     */
    <This, V>(value: undefined, context: ClassFieldDecoratorContext<This, V>): void;
    /**
     * As `@synced`, calling `onChange` on each peer with the previous value when a new one arrives.
     *
     * - `@synced({ onChange: 'swing' }) open = false`
     *
     * @param options `onChange`: the name of a method of this script, called on each peer with the old value.
     */
    (options: SyncedOptions): FieldDecorator;
}

/**
 * Keeps every peer's copy of the field as the host has it, in a NetSync game (docs/design/netsync.md §6.3).
 *
 * Set the field on the host; the peers get the new value reliably and in order, and a peer that joins later gets
 * it too. Numbers, booleans, strings, arrays, plain objects and node references. Offline it is an ordinary field.
 *
 * - `@synced open = false`
 * - `@synced({ onChange: 'swing' }) open = false` — `swing(was)` runs on each peer when it changes
 */
export const synced: SyncedDecorator = function synced(options?: unknown, context?: unknown): any {
    const apply = (opts: SyncedOptions) =>
        function <This, V>(_value: undefined, ctx: ClassFieldDecoratorContext<This, V>): void {
            const entry: Recorded = { kind: 'synced', field: memberName('@synced', ctx, 'field') };
            if (typeof opts.onChange === 'string' && opts.onChange) (entry as { onChange?: string }).onChange = opts.onChange;
            record('@synced', ctx, entry);
        };
    if (options === undefined && context && typeof context === 'object' && 'kind' in (context as object)) {
        apply({})(undefined, context as ClassFieldDecoratorContext<unknown, unknown>);
        return undefined;
    }
    return apply((options ?? {}) as SyncedOptions);
} as SyncedDecorator;

/** What `@netcall` takes. */
export interface NetCallDecoratorOptions {
    /** Where it runs: `'host'` (a peer asks), `'all'` (the host tells everyone) or `'owner'` (the host tells the node's player). */
    to: NetCallTarget;
    /** Default true. False sends it on the fast lane, where it may be lost: for effects, not for game state. */
    reliable?: boolean;
    /** A `to: 'host'` call a peer may make on a node it does not own (a door anyone can open). Default false. */
    anyone?: boolean;
}

/**
 * Runs the method on another machine of a NetSync game (docs/design/netsync.md §6.9).
 *
 * The arguments travel with it: numbers, strings, booleans, arrays, plain objects and node references.
 *
 * - `@netcall({ to: 'host' }) fire(aim: number[]) { … }` — a player's machine calls it; it runs on the host,
 *   if that player owns this node (`anyone: true` for any player). `this.net.caller` says who.
 * - `@netcall({ to: 'all', reliable: false }) flash() { … }` — the host calls it; it runs on the host and every peer.
 * - `@netcall({ to: 'owner' }) hint(text: string) { … }` — the host calls it; it runs on this node's player.
 *
 * Offline every call simply runs. A peer calling one meant for `'all'` or `'owner'` is ignored (only the host
 * may tell others), with a warning.
 *
 * @param options `to`: where it runs (`'host'`, `'all'` or `'owner'`); `reliable` (default true); `anyone`: a
 * peer may call a `'host'` one on a node it does not own.
 */
export function netcall(options: NetCallDecoratorOptions): MethodDecorator<any[]> {
    const to = options?.to;
    if (to !== 'host' && to !== 'all' && to !== 'owner') throw new TypeError(`@netcall needs { to: 'host' | 'all' | 'owner' }`);
    const routing: NetCallOptions = { to, reliable: options.reliable !== false, anyone: !!options.anyone };
    return function <This>(method: (this: This, ...args: any[]) => unknown, context: ClassMethodDecoratorContext<This>): any {
        const name = memberName('@netcall', context, 'method');
        record('@netcall', context, { kind: 'netcall', method: name, to, reliable: routing.reliable, anyone: routing.anyone });
        const original = method;
        const routed = function (this: any, ...args: unknown[]): unknown {
            const net = this?.scene?.net as SceneNet | null | undefined;
            return net ? net.call(this, name, original as (...a: unknown[]) => unknown, args, routing) : original.apply(this, args);
        };
        // What the network runs when the call arrives (never the routed wrapper, which would send it on again).
        Object.defineProperty(routed, NETCALL_ORIGINAL, { value: original });
        return routed;
    };
}

/** The method a `@netcall` wrapper stands for, kept on the wrapper under this symbol. */
export const NETCALL_ORIGINAL: unique symbol = Symbol('cleo.netcall.original');

/**
 * Keeps the field in saves: `SaveGame` files, and a scene's memory between visits.
 *
 * - `@save kills = 0`
 * - `@save` and `@pick('sound')` on one field: a picked sound that is kept by saves
 */
export const save: FieldDecorator = function save<This, V>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
    record('@save', context, { kind: 'save', field: memberName('@save', context, 'field') });
};

/**
 * Has the inspector offer the entries of another field, a public `string[]`, for this string field.
 *
 * - `weapons: string[] = ['Sword', 'Axe']` then `@options('weapons') weapon = 'Sword'`
 *
 * @param list The name of that `string[]` field. Naming a field that is not a list is a type error.
 */
export function options<K extends string>(list: K): FieldDecorator<string | null | undefined, { [P in K]: readonly string[] }> {
    const field = needName('@options', list);
    return function <This extends { [P in K]: readonly string[] }, V extends string | null | undefined>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
        record('@options', context, { kind: 'options', field: memberName('@options', context, 'field'), list: field });
    };
}

/**
 * Has the inspector offer the names of one kind this node can reach, for a string or string-list field.
 *
 * - `@pick('clip') attackClip = 'Attack'` — the clips of this node's character
 * - `@pick('sound') hitSounds: string[] = []`
 *
 * @param kind What the field names: `'clip'`, `'sound'`, `'socket'`, `'template'`, `'node'`, `'trigger'` or
 * `'spriteClip'`.
 */
export function pick(kind: ScriptPickKind): FieldDecorator<string | readonly string[] | null | undefined> {
    const what = needName('@pick', kind) as ScriptPickKind;
    return function <This, V extends string | readonly string[] | null | undefined>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
        record('@pick', context, { kind: 'pick', field: memberName('@pick', context, 'field'), pick: what });
    };
}

/** One decorated member as Cleo's compile hands it over: its decorators in source order, kind, name, `?`. */
export type LoweredMember = [decorators: unknown[], kind: 'field' | 'method', name: string, optional: 0 | 1];

/**
 * Applies a script class's member decorators, with standard semantics: called by the static block Cleo's
 * script compile adds to each decorated class (scriptDecoratorLowering.ts), so not by hand.
 *
 * Each member's decorators run innermost (last written) first, with a standard decorator context whose
 * `metadata` becomes `Class[Symbol.metadata]` (inheriting the base class's). A method decorator may return
 * a replacement method. What cannot work on a class Cleo never constructs is an error: an initializer
 * returned by a field decorator, and `addInitializer`.
 */
export function applyScriptDecorators(Class: Function, members: readonly LoweredMember[]): void {
    const parent: any = Object.getPrototypeOf(Class);
    const metadata = Object.create(parent?.[SCRIPT_METADATA] ?? null);
    Object.defineProperty(Class, SCRIPT_METADATA, { value: metadata, enumerable: false, configurable: true, writable: true });
    const proto = Class.prototype;

    for (const [decorators, kind, name, optional] of members) {
        if (kind === 'field' && optional) ownList<string>(metadata, OPTIONAL).push(name);
        const context = {
            kind, name, static: false, private: false, metadata,
            access: kind === 'method'
                ? { has: (o: any) => name in o, get: (o: any) => o[name] }
                : { has: (o: any) => name in o, get: (o: any) => o[name], set: (o: any, v: unknown) => { o[name] = v; } },
            addInitializer() {
                throw new Error(`A decorator on '${name}' called addInitializer: script classes are never constructed (their members are bound onto the node), so it would never run`);
            },
        };
        for (let d = decorators.length - 1; d >= 0; d--) {
            const decorator = decorators[d];
            if (typeof decorator !== 'function')
                throw new TypeError(`A decorator on '${name}' is not a function — is it imported?`);
            const result = decorator(kind === 'method' ? proto[name] : undefined, context);
            if (result === undefined) continue;
            if (kind === 'method' && typeof result === 'function') {
                Object.defineProperty(proto, name, { value: result, writable: true, configurable: true, enumerable: false });
                continue;
            }
            throw new TypeError(kind === 'field'
                ? `A decorator on field '${name}' returned an initializer: script classes are never constructed, so it would never run`
                : `A decorator on '${name}' returned something other than a method`);
        }
    }
}

const EMPTY: readonly ScriptMember[] = Object.freeze([]);
const byClass = new WeakMap<object, readonly ScriptMember[]>();
const byNode = new WeakMap<object, readonly ScriptMember[]>();

/** The key under which a derived class's decorator replaces its base's on the same member. */
function overrideKey(m: ScriptMember): string {
    return m.kind === 'action' ? `action:${m.method}:${m.action}:${m.when}`
        : m.kind === 'event' || m.kind === 'targetEvent' || m.kind === 'dispatch' ? `${m.kind}:${m.method}:${m.channel}:${m.name}`
        : m.kind === 'observable' ? `observable:${m.field}`
        : m.kind === 'animParam' ? `animParam:${m.field}`
        : m.kind === 'animTrigger' || m.kind === 'animAction' ? `${m.kind}:${m.method}`
        : 'method' in m ? `${m.kind}:${m.method}:${'name' in m ? m.name : 'action' in m ? m.action : 'filter' in m ? m.filter : ''}`
        : m.kind === 'child' || m.kind === 'find' ? `ref:${m.field}`
        : `${m.kind}:${m.field}`;
}

/**
 * Everything the decorators of `Class` and of the script classes it extends recorded, the most derived
 * first; a member a derived class decorates again takes the derived class's decorator. Empty for a class
 * without decorators (every engine class). Cached per class.
 */
export function scriptMembersOf(Class: Function | null | undefined): readonly ScriptMember[] {
    if (!Class) return EMPTY;
    const cached = byClass.get(Class);
    if (cached) return cached;
    const out: ScriptMember[] = [];
    const seen = new Set<string>();
    for (let md = (Class as any)[SCRIPT_METADATA]; md; md = Object.getPrototypeOf(md)) {
        if (!hasOwn(md, MEMBERS)) continue;
        const optional = new Set<string>(hasOwn(md, OPTIONAL) ? md[OPTIONAL] : []);
        for (const entry of md[MEMBERS] as Recorded[]) {
            const member = (entry.kind === 'child' || entry.kind === 'find'
                ? { ...entry, optional: optional.has(entry.field) }
                : entry) as ScriptMember;
            const key = overrideKey(member);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(member);
        }
    }
    const result = out.length ? Object.freeze(out) : EMPTY;
    byClass.set(Class, result);
    return result;
}

/** Remember the decorated members of the script class bound onto `node` (attachClassScript). */
export function setNodeScriptMembers(node: object, members: readonly ScriptMember[]): void {
    if (members.length) byNode.set(node, members);
    else byNode.delete(node);
}

/**
 * The decorated members of the script running on `node`: the class bound onto it by the script runtime,
 * or — for a node that IS an instance of a decorated class — its own class's.
 */
export function membersOfNode(node: object): readonly ScriptMember[] {
    return byNode.get(node) ?? scriptMembersOf((node as any).constructor);
}
