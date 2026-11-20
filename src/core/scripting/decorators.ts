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
// A leaf: type-only imports.
import type { NetCallOptions, NetCallTarget, SceneNet } from '../net/sceneNet';
import type { Node } from '../scene/nodes/node';
import type { ActionState } from '../../input/actionMap';
import type { ActionName, ScriptPickKind } from './fieldTypes';

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
    | { kind: 'event'; method: string; name: string }
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

/**
 * Calls the method with the payload whenever a game event of that name is emitted, while the node is awake.
 *
 * Listens from the node's spawn until it despawns or is removed: no setup in `onStart`, no cleanup.
 *
 * - `@onEvent('PlayerDied') died(info) { … }` — for `GameEvents.emit('PlayerDied', info)` anywhere
 *
 * @param name The event's name, as `GameEvents.emit` sends it.
 */
export function onEvent(name: string): MethodDecorator<[payload: any]> {
  const event = needName('@onEvent', name);
  return function <This>(_method: (this: This, payload: any) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onEvent', context, { kind: 'event', method: memberName('@onEvent', context, 'method'), name: event });
  };
}

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
