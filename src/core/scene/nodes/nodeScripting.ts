import { Node } from "./node";
import type { Scene } from "../scene";
import { Logger } from "../../logger";
import { logScriptError } from "../../scripting/scriptErrors";
import { bindDataAccessors, canAccessVariable } from "./nodeVariables";
import { createScriptImporter, resolveScriptModule, scriptModulesVersion, ScriptFactory, SCRIPT_HANDLERS } from "../../scripting/scriptRuntime";
import { membersOfNode, scriptMembersOf, setNodeScriptMembers } from "../../scripting/decorators";
import { ENGINE_CHANNEL, addTargetListener, getChannel, releaseTarget, removeChannelListenersOwnedBy } from "../../events/hub";
import { setEventErrorReporter } from "../../events/dispatcher";
import { ValueSubject } from "../../events/subject";
import { ANIMATOR_CHANNEL } from "../../../animation/animatorCommands";
import { resolveAssetFields, resolveNodeFields } from "../../properties/fieldRefs";

// A listener that throws, anywhere in the event system, is reported as a script error with its event's name. The
// engine channel's own listeners propagate instead (it does not isolate); a throw from its frame flush lands here.
setEventErrorReporter((error, event) =>
    logScriptError(`Error in a listener of '${event.qualifiedName}'`, error, event.channel === ENGINE_CHANNEL ? 'Runtime' : 'Script'));

/**
 * The bridge between a user script and a live node: the `this` proxy, and the two ways a compiled script
 * gets bound onto a node.
 *
 * This module closes an import cycle with node.ts (the proxy traps need `Node` as a value). Nothing here
 * may dereference `Node` at module evaluation time, or scene loading breaks on the bundler's import order.
 */


type ScriptHandlers = Record<string, Function>;

const scriptProxies: WeakMap<Node, WeakMap<Node, any>> = new WeakMap();
const proxyHandlers: WeakMap<object, ScriptHandlers> = new WeakMap();

/** Reads the real node back out of a script proxy. */
const RAW = Symbol('cleo.rawNode');

/**
 * The raw node behind a script proxy (or the value itself, if it is not one).
 *
 * The engine compares and keys nodes by identity, so anything that takes a Node from script code and
 * keeps it must unwrap first.
 */
export function unwrapScriptNode<T>(value: T): T {
    return (value && (value as any)[RAW]) || value;
}

/**
 * The `this` a script sees: the node itself, with its inspector Variables as plain properties.
 *
 * Name resolution is handler slots, then Node members, then Variables — the handler slots must come
 * first because `Node` declares onStart/onUpdate/… itself. `requester` is the node whose script is
 * running, and every Variable access is access-checked against it, not against `target`.
 */
function wrapNode(target: Node | null | undefined, requester: Node): any {
    if (!target) return target;

    let byTarget = scriptProxies.get(requester);
    if (!byTarget) { byTarget = new WeakMap(); scriptProxies.set(requester, byTarget); }

    // Memoised so proxy identity is stable: `other === this.parent` must still compare true, and a hot
    // onUpdate that walks this.children must not allocate a proxy per frame.
    const cached = byTarget.get(target);
    if (cached) return cached;

    const handlers: ScriptHandlers = {};

    const proxy: any = new Proxy(target, {
        get(node: any, prop: any, receiver: any) {
            if (prop === RAW) return node;
            if (typeof prop !== 'string') return Reflect.get(node, prop, receiver);
            if (SCRIPT_HANDLERS.includes(prop as any)) return handlers[prop];

            // Synthesized here so the results come back proxied; reaching the Scene lookups through
            // `this.scene` would hand a script raw nodes.
            if (prop === 'findNode')
                return (name: string) => wrapNode(node.scene?.findNode(name), requester);
            if (prop === 'getNodeById')
                return (id: string) => wrapNode(node.scene?.getNodeById(id), requester);
            if (prop === 'getNodesByName')
                return (name: string) => (node.scene?.getNodesByName(name) ?? []).map((found: Node) => wrapNode(found, requester));

            // `this.scene` must go through the same re-wrapping, or its Node-returning members hand back
            // raw, un-access-checked nodes.
            if (prop === 'scene') {
                const scene = node.scene;
                return scene ? wrapScene(scene, requester) : scene;
            }

            // Not a Node member: it is a Variable, or nothing. Unreadable ones read as undefined.
            if (!(prop in node)) {
                if (!node.variables.has(prop)) return undefined;
                return canAccessVariable(node, requester, prop) ? node.variables.get(prop).value : undefined;
            }

            const value = Reflect.get(node, prop, node);

            // Anything that hands back a Node hands back a *proxied* Node.
            if (value instanceof Node) return wrapNode(value, requester);
            if (Array.isArray(value) && value.length && value[0] instanceof Node)
                return value.map((child: Node) => wrapNode(child, requester));

            // Methods must run against the real node, with every proxy argument unwrapped first: the
            // engine may only ever store real nodes.
            if (typeof value === 'function')
                return (...args: any[]) => value.apply(node, args.map(unwrapScriptNode));

            return value;
        },

        set(node: any, prop: any, value: any, receiver: any) {
            if (typeof prop !== 'string') return Reflect.set(node, prop, value, receiver);

            if (SCRIPT_HANDLERS.includes(prop as any)) {
                handlers[prop] = value;
                return true;
            }

            if (prop in node) {
                // A `set` trap returning falsish throws a TypeError under the "use strict" every script
                // runs in, so a write to a getter-only member warns instead of returning `ok`.
                const ok = Reflect.set(node, prop, value, node);
                if (!ok) Logger.warn(`Script on '${requester.name}' cannot set '${prop}' on '${node.name}' — it has no setter.`, 'Script');
                return true;
            }

            if (!canAccessVariable(node, requester, prop)) {
                Logger.warn(`Script on '${requester.name}' cannot set '${prop}' on '${node.name}' (${node.variables.get(prop)?.access ?? 'public'})`, 'Script');
                return true;   // reporting, not throwing — a blocked write is a no-op, as it always was
            }

            node.setVariable(prop, value);
            return true;
        },

        has(node: any, prop: any) {
            return prop in node || (typeof prop === 'string' && node.variables.has(prop));
        },
    });

    proxyHandlers.set(proxy, handlers);
    byTarget.set(target, proxy);
    return proxy;
}

const sceneProxies: WeakMap<Node, WeakMap<Scene, any>> = new WeakMap();

/**
 * Re-wraps whatever a Scene member hands back, so a script reaching a node through `this.scene` (e.g.
 * `this.scene.models`, `this.scene.getNodesByName(...)`) gets the same access-checked view it gets through
 * `this.parent`/`this.findNode(...)`. Generic over a lone Node, a Node[] or a Set<Node>. `Set`s are
 * rebuilt rather than proxied: a Proxy over a built-in Set breaks its methods, which need the real
 * internal slot.
 */
function wrapSceneValue(value: any, requester: Node): any {
    if (value instanceof Node) return wrapNode(value, requester);
    if (value instanceof Set) {
        const first = value.values().next().value;
        return first instanceof Node ? new Set([...value].map((n: Node) => wrapNode(n, requester))) : value;
    }
    if (Array.isArray(value) && value.length && value[0] instanceof Node)
        return value.map((n: Node) => wrapNode(n, requester));
    return value;
}

function wrapScene(scene: Scene, requester: Node): any {
    let byRequester = sceneProxies.get(requester);
    if (!byRequester) { byRequester = new WeakMap(); sceneProxies.set(requester, byRequester); }

    const cached = byRequester.get(scene);
    if (cached) return cached;

    const proxy: any = new Proxy(scene as any, {
        get(target: any, prop: any, receiver: any) {
            if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);

            const value = Reflect.get(target, prop, target);

            // Methods run against the real scene, unwrapping proxied node arguments, and their result
            // gets the same re-wrap as a plain property.
            if (typeof value === 'function')
                return (...args: any[]) => wrapSceneValue(value.apply(target, args.map(unwrapScriptNode)), requester);

            return wrapSceneValue(value, requester);
        },
    });

    byRequester.set(scene, proxy);
    return proxy;
}

/**
 * Binds a compiled script's handlers to a node. Both paths that run scripts converge here: the editor's
 * eval path and the published player's pre-compiled factories.
 *
 * The factory is called with `this` bound to the node's proxy, and its handlers are collected off that
 * proxy afterwards. The engine API is imported, not injected: the importer resolves 'cleo'.
 */
export function attachScriptFactory(node: Node, factory: ScriptFactory): void {
    const context = wrapNode(node, node);
    const handlers = proxyHandlers.get(context)!;

    // `unwrapScriptNode` is shadowed to identity for the script-facing 'cleo': the real export would let
    // a script strip the proxy off any node and read/write variables past the access checks.
    const result = factory.call(context, createScriptImporter({ ...bindDataAccessors(node), unwrapScriptNode: (value: any) => value }));

    // A class-based script returns its class constructor and runs NATIVELY on the real node: prototype
    // methods are copied on as own properties with `this` = the raw node, and field values are own
    // properties restored from `json.scriptVars` in _commonParse before this runs. Access levels are
    // enforced by the editor's type-checker at author time, not at runtime.
    if (typeof result === 'function' && !!(result as any).prototype) {
        attachClassScript(node, result as any);
        return;
    }

    // Legacy path: a `this.onX = (node, ...) => ...` factory. The engine calls handlers without the
    // leading node, so the proxied self is prepended here to keep the `(node, ...)` convention.
    const guard = (name: string) => {
        const fn = handlers[name];
        if (typeof fn !== 'function') return () => {};
        return (...args: any[]) => {
            try {
                const mapped = args.map(arg => (arg instanceof Node ? wrapNode(unwrapScriptNode(arg), node) : arg));
                const result = fn.apply(context, [context, ...mapped]);
                if (result && typeof result.then === 'function')
                    result.catch((e: any) => logScriptError(`Error in ${name} for node ${node.name}`, e, 'Script'));
            }
            catch (e) { logScriptError(`Error in ${name} for node ${node.name}`, e, 'Script'); }
        };
    };

    node.onConstruct = guard('onConstruct');
    node.onStart = guard('onStart');
    node.onSpawn = guard('onSpawn');
    node.onUpdate = guard('onUpdate');
    node.onCollision = guard('onCollision');
    node.onTrigger = guard('onTrigger');
    node.onTriggerEnter = guard('onTriggerEnter');
    node.onTriggerExit = guard('onTriggerExit');
    node.onDespawn = guard('onDespawn');
    node.onAction = guard('onAction');
    node.onThink = guard('onThink');
    node.onRoomEnter = guard('onRoomEnter');
    node.onRoomExit = guard('onRoomExit');
    node.onAnimationEvent = guard('onAnimationEvent');
    node.onAnimationFinished = guard('onAnimationFinished');
    node.onRestore = guard('onRestore');
    // Only when the script has one: defining `onSave` is what makes a node take part in saves, and its
    // return value IS the point, so unlike the guard above it is passed back (a promise is not).
    if (typeof handlers.onSave === 'function') {
        const fn = handlers.onSave;
        node.onSave = () => {
            try {
                const result = fn.apply(context, [context]);
                if (result && typeof result.then === 'function') {
                    result.catch((e: any) => logScriptError(`Error in onSave for node ${node.name}`, e, 'Script'));
                    return result;   // the save system warns that a promise is not saved
                }
                return result;
            }
            catch (e) { logScriptError(`Error in onSave for node ${node.name}`, e, 'Script'); }
            return undefined;
        };
    }

    // The UI handlers exist only on the UI classes that declare them, so a legacy script on the wrong
    // node type cannot bind a handler nothing will ever call.
    for (const name of ['onPress', 'onValueChanged', 'onSubmit']) {
        if (typeof (node as any)[name] === 'function' && typeof handlers[name] === 'function')
            (node as any)[name] = guard(name);
    }
}

/**
 * Bind a compiled script class onto a node, natively. The class's own prototype methods become own
 * properties on the node with `this` = the node itself; handler slots are additionally wrapped so a
 * throw or a rejected async body is caught and logged.
 *
 * Declared fields get their class DEFAULTS here. Per-node values restored from `json.scriptVars` in
 * _commonParse always win, because only still-undefined fields are filled in.
 */
function attachClassScript(node: Node, Ctor: new (...args: any[]) => any): void {
    const proto = Ctor.prototype;
    const n = node as any;

    // A plain (non-promise) result is passed through: `onMove2D` returns whether it owns the substep.
    const guard = (name: string, fn: Function) => (...args: any[]) => {
        try {
            const result = fn.apply(node, args); // engine calls with the handler's own args; self is `this`
            if (result && typeof result.then === 'function') {
                result.catch((e: any) => logScriptError(`Error in ${name} for node ${node.name}`, e, 'Script'));
                // An `async onSave` is a mistake the save system reports (a promise is not saved), so it gets it.
                return name === 'onSave' ? result : undefined;
            }
            return result;
        }
        catch (e) { logScriptError(`Error in ${name} for node ${node.name}`, e, 'Script'); }
        return undefined;
    };

    // The script's own class AND every script class it inherits from (`class Hollow extends EnemyBase`,
    // where EnemyBase is another script), most-derived first. The walk stops at the first ENGINE class:
    // its methods are already on the node, and copying them as own properties would freeze them there.
    const levels = scriptPrototypeChain(node, proto);
    applyFieldDefaults(node, levels);
    // `skin: Material` was stored as the material's id: it is the Material from here on.
    resolveAssetFields(node);

    // `__`-prefixed names are Sucrase's field-initializer helpers rather than author methods. The
    // most-derived definition of a name wins; `super.x()` inside it still reaches the base's version,
    // because a copied method keeps the home object it was defined on.
    const seen = new Set<string>();
    for (const level of levels)
    for (const name of Object.getOwnPropertyNames(level)) {
        if (name === 'constructor' || name.startsWith('__') || seen.has(name)) continue;
        seen.add(name);
        const desc = Object.getOwnPropertyDescriptor(level, name);
        if (!desc) continue;

        // ACCESSORS are copied as accessors. A getter's descriptor has no `value`, so the function test
        // below skipped it and the property simply never arrived on the node — `this.progress` read
        // `undefined`, and a script that fed that into arithmetic spread NaN through everything
        // downstream with no error at the point of failure. Defining the descriptor keeps `this` bound
        // to the node, exactly as a copied method is.
        //
        // It also makes a script getter an OWN property, which is what `Animator._refreshVariableParams`
        // requires before it will read a bound node property — so a computed value can now back an
        // animation parameter, where before it silently reported its default forever.
        if (desc.get || desc.set) { Object.defineProperty(n, name, desc); continue; }

        if (typeof desc.value !== 'function') continue;
        if ((SCRIPT_HANDLERS as readonly string[]).includes(name)) n[name] = guard(name, desc.value);
        else n[name] = desc.value; // helper method, runs on the node
    }

    // What the class's decorators declared (`@child`, `@onAction`, ...): the node is not an instance of the
    // class, so it is remembered for the node — fillScriptRefs and the scene's action dispatch read it.
    setNodeScriptMembers(node, scriptMembersOf(Ctor));
    // `@observable` fields become accessors now, holding the value the defaults (or scriptVars) gave them.
    installObservables(node);
}

/* -------------------------------------------------------------------------- */
/* @child / @find                                                              */
/* -------------------------------------------------------------------------- */

/** The node named `name` nearest under `root`, breadth-first (so a direct child wins), not `root` itself. */
function nearestNamed(root: Node, name: string): Node | undefined {
    const queue: Node[] = root.children.slice();
    for (let i = 0; i < queue.length; i++) {
        const node = queue[i];
        if (node.name === name) return node;
        for (const child of node.children) queue.push(child);
    }
    return undefined;
}

/** `@child`'s lookup: each `/`-separated name is the nearest one under the previous match. */
function descendantAt(root: Node, path: string): Node | undefined {
    let at: Node | undefined = root;
    for (const part of path.split('/')) {
        if (!part) continue;
        at = nearestNamed(at, part);
        if (!at) return undefined;
    }
    return at === root ? undefined : at;
}

/** `kind:field:name` of each reference already reported missing: one warning per field per session. */
const reportedMissing = new Set<string>();

/**
 * Fill a node's `@child` / `@find` fields that are still empty (`null` or `undefined`): a value already
 * there — assigned by hand, or restored by a save — is kept.
 *
 * Runs before `onConstruct` (the whole tree is parsed and in the scene by then) and again, `final`, right
 * before `onStart`, for what was spawned in between. A reference still missing at that point is reported
 * once, unless the field is declared `name?:` — the author's "it may not be there".
 */
export function fillScriptRefs(node: Node, final: boolean): void {
    const members = membersOfNode(node);
    // `door: LightNode` was stored as a path from this node: the node it leads to, found the same way.
    resolveNodeFields(node, final, field => members.some(m => m.kind === 'attribute' && m.field === field && m.optional));
    if (!members.length) return;
    const n = node as any;
    for (const m of members) {
        if (m.kind !== 'child' && m.kind !== 'find') continue;
        if (n[m.field] != null) continue;
        const found = m.kind === 'child' ? descendantAt(node, m.name) : node.scene?.findNode(m.name);
        if (found) { n[m.field] = found; continue; }
        if (!final || m.optional) continue;
        const key = `${m.kind}:${m.field}:${m.name}`;
        if (reportedMissing.has(key)) continue;
        reportedMissing.add(key);
        Logger.warn(m.kind === 'child'
            ? `'${node.name}': @child('${m.name}') found no '${m.name}' under it, so '${m.field}' stays empty. Declare it '${m.field}?:' if it may be missing.`
            : `'${node.name}': @find('${m.name}') found no '${m.name}' in the scene, so '${m.field}' stays empty. Declare it '${m.field}?:' if it may be missing.`,
            'Script');
    }
}

/**
 * Give a class script's declared fields (`speed = 1`) their DEFAULT values on the node.
 *
 * The class is never constructed, so Sucrase's lowered `__init`/`__init2`/… prototype methods are run
 * against a bare object to harvest the defaults. Only fields the node does not already have are filled
 * in, so per-node `scriptVars` win. An initializer that reads `this` is skipped rather than thrown.
 */
function applyFieldDefaults(node: Node, levels: any[]): void {
    const n = node as any;
    const defaults: Record<string, any> = {};
    // Base-first, so a derived class's default for a field overrides its base's.
    for (const proto of [...levels].reverse()) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (!/^__init\d*$/.test(name)) continue;
            const fn = proto[name];
            if (typeof fn !== 'function') continue;
            try { fn.call(defaults); } catch { /* initializer depends on `this`: leave that field to scriptVars */ }
        }
    }
    for (const key of Object.keys(defaults))
        if (n[key] === undefined) n[key] = defaults[key];
}

/** Prototypes of every class the engine exports — where a script's prototype chain ends. */
let engineProtos: WeakSet<object> | null = null;
/** The 'cleo' they were read from: an optional feature installed since adds classes (scriptModulesVersion). */
let engineProtosFor = -1;
function isEngineProto(proto: any, node: Node): boolean {
    if (proto === Node.prototype || proto === Object.prototype || proto.isPrototypeOf(node)) return true;
    if (!engineProtos || engineProtosFor !== scriptModulesVersion()) {
        engineProtosFor = scriptModulesVersion();
        engineProtos = new WeakSet();
        try {
            for (const value of Object.values(resolveScriptModule('cleo')))
                if (typeof value === 'function' && value.prototype) engineProtos.add(value.prototype);
        } catch { /* 'cleo' not registered (a bare unit test): the node's own chain is the only stop */ }
    }
    return engineProtos.has(proto);
}

/**
 * The script-defined prototypes from `proto` up to (not including) the first engine class, most-derived
 * first. A script extending `CharacterNode` attached to a plain Node stops at `CharacterNode` too, so no
 * engine method is ever copied onto a node of the wrong type.
 */
function scriptPrototypeChain(node: Node, proto: any): any[] {
    const levels: any[] = [];
    for (let p = proto; p && !isEngineProto(p, node); p = Object.getPrototypeOf(p)) levels.push(p);
    return levels;
}

/* -------------------------------------------------------------------------- */
/* @onEvent / @eventListener / @every / @onEnter / @onExit / @onHold / @onTap   */
/* -------------------------------------------------------------------------- */

/**
 * Calls a decorated method, reporting a throw or a rejected promise instead of letting it escape. Returns what
 * the method returned (a promise too, already guarded), so an event's `results` and `request` see it.
 */
function runDecorated(node: Node, method: string, label: string, ...args: unknown[]): unknown {
    return runDecoratedWith(node, method, label, args);
}

/** {@link runDecorated} with the arguments as an array: what an event listener hands on, with no second copy. */
function runDecoratedWith(node: Node, method: string, label: string, args: readonly unknown[]): unknown {
    try {
        const fn = (node as any)[method];
        if (typeof fn !== 'function') return undefined;
        const result = args.length === 0 ? fn.call(node) : args.length === 1 ? fn.call(node, args[0]) : fn.apply(node, args);
        if (result && typeof result.then === 'function')
            return result.then(undefined, (e: any) => { logScriptError(`Error in ${method} (${label}) for node ${node.name}`, e, 'Script'); });
        return result;
    }
    catch (e) { logScriptError(`Error in ${method} (${label}) for node ${node.name}`, e, 'Script'); }
    return undefined;
}

/** What undoes a node's event listeners, `@every` timers and input routing: run on despawn. */
const lifeSubs = new WeakMap<Node, (() => void)[]>();

/** `'game:Died'` shown as `'Died'`: the channel is named only when it is not the game's. */
function eventLabel(channel: string, name: string): string {
    return channel === 'game' ? name : `${channel}:${name}`;
}

/**
 * Start what a script's decorators run for as long as the node is awake: `@onEvent` and `@eventListener`
 * listeners, `@every` timers, and the scene's polling for `@onHold` / `@onTap`. Called when the node spawns;
 * releaseScriptLife undoes it when the node despawns or is removed, so a gone node is never called.
 */
export function bindScriptLife(node: Node): void {
    const members = membersOfNode(node);
    if (!members.length) return;
    releaseScriptLife(node);
    installObservables(node);
    sendAnimParams(node, members);
    const subs: (() => void)[] = [];
    let timedInput = false;
    for (const m of members) {
        if (m.kind === 'event') {
            const label = `@onEvent '${eventLabel(m.channel, m.name)}'`;
            subs.push(getChannel(m.channel).on(m.name, (...args: unknown[]) => runDecoratedWith(node, m.method, label, args),
                { once: m.once, priority: m.priority, where: m.where }));
        }
        else if (m.kind === 'targetEvent') {
            const label = `@eventListener '${eventLabel(m.channel, m.name)}'`;
            subs.push(addTargetListener(node, `${m.channel}:${m.name}`, (...args: unknown[]) => runDecoratedWith(node, m.method, label, args),
                { once: m.once, priority: m.priority, where: m.where, capture: m.capture }));
        }
        else if (m.kind === 'every') subs.push(node.every(m.seconds, () => runDecorated(node, m.method, `@every ${m.seconds}`)));
        else if (m.kind === 'hold' || m.kind === 'tap') timedInput = true;
    }
    const scene = node.scene;
    if (timedInput && scene) {
        scene.inputRouted.add(node);
        subs.push(() => { scene.inputRouted.delete(node); });
    }
    if (subs.length) lifeSubs.set(node, subs);
}

/**
 * Stop what bindScriptLife started, and what the node's script subscribed with `this.listen`. Safe to call on a
 * node that never bound.
 */
export function releaseScriptLife(node: Node): void {
    removeChannelListenersOwnedBy(node);
    const subs = lifeSubs.get(node);
    if (!subs) return;
    lifeSubs.delete(node);
    for (const off of subs) off();
}

/**
 * Forget a node for good (its scene is being disposed): its decorated life, its `this.listen` subscriptions and
 * every listener added at it. A node that only despawned keeps what `addEventListener` added, as a DOM element does.
 */
export function releaseNodeEvents(node: Node): void {
    releaseScriptLife(node);
    releaseTarget(node);
}

/* -------------------------------------------------------------------------- */
/* @observable                                                                 */
/* -------------------------------------------------------------------------- */

/** Each node's `@observable` fields: the subject holding each one's value. */
const observed = new WeakMap<Node, Map<string, ValueSubject<unknown>>>();
/** The members already watching each node's subjects (`observable:field`, `animParam:field`), so binding twice adds nothing. */
const watching = new WeakMap<Node, Set<string>>();

/** The subject behind `field` on `node`, made (and the field turned into an accessor over it) on first use. */
function subjectOf(node: Node, field: string): ValueSubject<unknown> {
    let fields = observed.get(node);
    if (!fields) { fields = new Map(); observed.set(node, fields); }
    let subject = fields.get(field);
    if (subject) return subject;
    subject = new ValueSubject<unknown>((node as any)[field]);
    fields.set(field, subject);
    const s = subject;
    Object.defineProperty(node, field, {
        get: () => s.value,
        // The same value again is the usual set (a script writing its state every frame): settled right here.
        set: (value: unknown) => { if (value !== s.value) s.set(value); },
        enumerable: true,
        configurable: true,
    });
    return subject;
}

/**
 * Turn the node's `@observable` and `@animParam` fields into accessors over a {@link ValueSubject}: setting one to a
 * new value dispatches its event at the node (`@observable`), or sends it down to the animators beneath as
 * `animator:SetParam` (`@animParam`). A field may be both. Idempotent: what already watches a field is left alone.
 */
export function installObservables(node: Node): void {
    let seen: Set<string> | undefined;
    for (const m of membersOfNode(node)) {
        if (m.kind !== 'observable' && m.kind !== 'animParam') continue;
        const key = `${m.kind}:${m.field}`;
        seen ??= watching.get(node);
        if (seen?.has(key)) continue;
        if (!seen) { seen = new Set(); watching.set(node, seen); }
        seen.add(key);
        const subject = subjectOf(node, m.field);
        if (m.kind === 'observable') {
            const channel = getChannel(m.channel);
            const name = m.name;
            // Asked on every set: when nobody listens to this event anywhere, a set costs the comparison and no more.
            subject.subscribe((value, previous) => { if (channel.hasListeners(name)) channel.fire(name, [value, previous], node); }, false);
        } else {
            const param = m.param;
            subject.subscribe((value) => { sendAnimParam(node, param, value); }, false);
        }
    }
}

/** The animator channel, looked up once. */
let animator: ReturnType<typeof getChannel> | null = null;

/** Send `param = value` down from `node` to the animators beneath it. A value that is neither number nor boolean is not one. */
function sendAnimParam(node: Node, param: string, value: unknown): void {
    if (typeof value !== 'number' && typeof value !== 'boolean') return;
    (animator ??= getChannel(ANIMATOR_CHANNEL)).fireDown(node, 'SetParam', [param, value]);
}

/** Every `@animParam` field's value sent down once: what a node does when it spawns, so its animators start in step. */
function sendAnimParams(node: Node, members: readonly { kind: string }[]): void {
    for (const m of members as readonly import('../../scripting/decorators').ScriptMember[])
        if (m.kind === 'animParam') sendAnimParam(node, m.param, (node as any)[m.field]);
}

/** The subject behind a node's `@observable` field: subscribe to it to watch the field. Null for any other field. */
export function observableOf(node: Node, field: string): ValueSubject<unknown> | null {
    return observed.get(node)?.get(field) ?? null;
}

/** Whether `other` is what an `@onEnter` / `@onExit` filter names: by node name or by a variable it holds, on it or an ancestor. */
function triggerMatches(other: Node, filter: string): boolean {
    if (!filter) return true;
    for (let n: Node | null = other; n; n = n.parent) {
        if (n.name === filter || n.getVariable(filter)) return true;
    }
    return false;
}

/** Runs `self`'s `@onEnter` / `@onExit` methods for an overlap with `other`. Called wherever a trigger hook fires. */
export function routeTrigger(self: Node, phase: 'enter' | 'exit', other: Node): void {
    const members = membersOfNode(self);
    if (!members.length) return;
    for (const m of members)
        if (m.kind === phase && triggerMatches(other, m.filter))
            runDecorated(self, m.method, `@on${phase === 'enter' ? 'Enter' : 'Exit'}${m.filter ? ` '${m.filter}'` : ''}`, other);
}
