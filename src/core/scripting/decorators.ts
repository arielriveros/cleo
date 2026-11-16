// Decorators for script classes: what a field or method of a script means to the engine and the editor.
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
// A leaf: type-only imports.
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
    | { kind: 'pick'; field: string; pick: ScriptPickKind };

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
 * Fills the field with the nearest node named `name` under this one, before `onConstruct` and again
 * before `onStart` while it is still empty. Breadth-first: a direct child wins over a deeper one.
 * A path narrows it: `'HealthBar/Fill'` is the `Fill` nearest under the `HealthBar` nearest.
 *
 * Declare the field `name?:` when the node may legitimately be missing; otherwise a missing one is
 * reported (once) before `onStart`. A value already in the field (assigned, or restored by a save) is kept.
 */
export function child(name: string) {
    const target = needName('@child', name);
    return function <This, V extends Node | null | undefined>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
        record('@child', context, { kind: 'child', field: memberName('@child', context, 'field'), name: target });
    };
}

/**
 * Fills the field with the node named `name` anywhere in the scene (`findNode`), at the same moments as
 * {@link child} and with the same rules.
 */
export function find(name: string) {
    const target = needName('@find', name);
    return function <This, V extends Node | null | undefined>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
        record('@find', context, { kind: 'find', field: memberName('@find', context, 'field'), name: target });
    };
}

/**
 * Calls the method when the input action changes — by default when it is pressed (see {@link ActionWhen}).
 * `action` is an action's name (`'Jump'`) or map-qualified (`'Gameplay/Jump'`). The method gets the
 * action's {@link ActionState}. Like `onAction`, nothing is delivered while the game is paused, and a
 * script may also keep its own `onAction`.
 */
export function onAction(action: ActionName, when: ActionWhen = 'started') {
    const name = needName('@onAction', action);
    return function <This>(_method: (this: This, state: ActionState) => unknown, context: ClassMethodDecoratorContext<This>): void {
        record('@onAction', context, { kind: 'action', method: memberName('@onAction', context, 'method'), action: name, when });
    };
}

/**
 * Calls the method when a game event of that name is emitted (`GameEvents.emit(name, payload)`), with the
 * payload. Listens while the node is awake: from its spawn until it despawns or is removed.
 */
export function onEvent(name: string) {
  const event = needName('@onEvent', name);
  return function <This>(_method: (this: This, payload: any) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onEvent', context, { kind: 'event', method: memberName('@onEvent', context, 'method'), name: event });
  };
}

/**
 * Calls the method every `seconds` of unpaused game time, from the node's spawn until it despawns.
 */
export function every(seconds: number) {
  if (!(typeof seconds === 'number' && seconds > 0)) throw new TypeError('@every needs a period in seconds, above 0');
  return function <This>(_method: (this: This) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@every', context, { kind: 'every', method: memberName('@every', context, 'method'), seconds });
  };
}

/**
 * Calls the method when a trigger overlap begins with another node: this node's own trigger (a Trigger node,
 * or its Collider with a trigger), or one this node walks into. `filter` narrows who: a node name, or the name
 * of a variable the other node has set (`'isPlayer'`); the other node or any of its ancestors may match.
 * Without a filter, anything.
 */
export function onEnter(filter: string = '') {
  return function <This>(_method: (this: This, other: Node) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onEnter', context, { kind: 'enter', method: memberName('@onEnter', context, 'method'), filter });
  };
}

/** Like {@link onEnter}, when the overlap ends. */
export function onExit(filter: string = '') {
  return function <This>(_method: (this: This, other: Node) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onExit', context, { kind: 'exit', method: memberName('@onExit', context, 'method'), filter });
  };
}

/**
 * Calls the method once per press, at the moment the action has been held for `seconds` (default 0.5). It
 * fires again only after a release and a new press. Nothing is delivered while the game is paused.
 */
export function onHold(action: ActionName, seconds: number = 0.5) {
  const name = needName('@onHold', action);
  return function <This>(_method: (this: This, state: ActionState) => unknown, context: ClassMethodDecoratorContext<This>): void {
    record('@onHold', context, { kind: 'hold', method: memberName('@onHold', context, 'method'), action: name, seconds });
  };
}

/**
 * Calls the method when the action is RELEASED, if it was held no longer than `maxSeconds` (default 0.25): a
 * tap. A longer press is a hold (see {@link onHold}) and gets no tap.
 */
export function onTap(action: ActionName, maxSeconds: number = 0.25) {
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

/**
 * Shows the field in the inspector (the Behaviors panel), whatever its access: public, protected or
 * private. A field without it is the script's own business and is not shown, saved per node or overridden
 * by templates. The field's doc comment becomes the row's tooltip.
 *
 *   @attribute speed = 4                                  // in the Attributes section
 *   @attribute('Combat') damage = 10                      // in a "Combat" section
 *   @attribute('Combat', { min: 0, max: 1 }) crit = 0.1   // a slider
 *   @attribute({ readonly: true }) hp = 100
 */
export function attribute<This, V>(value: undefined, context: ClassFieldDecoratorContext<This, V>): void;
export function attribute(group?: string, options?: AttributeOptions): <This, V>(value: undefined, context: ClassFieldDecoratorContext<This, V>) => void;
export function attribute(options: AttributeOptions): <This, V>(value: undefined, context: ClassFieldDecoratorContext<This, V>) => void;
export function attribute(group?: unknown, options?: unknown): any {
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
}

/** Keeps the field in saves (`SaveGame`, and a scene's memory between visits). */
export function save<This, V>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
    record('@save', context, { kind: 'save', field: memberName('@save', context, 'field') });
}

/** Has the inspector offer the entries of the `list` field (a public `string[]`) for this string field. */
export function options<K extends string>(list: K) {
    const field = needName('@options', list);
    return function <This extends { [P in K]: readonly string[] }, V extends string | null | undefined>(_value: undefined, context: ClassFieldDecoratorContext<This, V>): void {
        record('@options', context, { kind: 'options', field: memberName('@options', context, 'field'), list: field });
    };
}

/** Has the inspector offer the names of `kind` this node can reach for a string (or string list) field. */
export function pick(kind: ScriptPickKind) {
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
