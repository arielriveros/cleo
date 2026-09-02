import { Node } from "./node";
import type { Scene } from "../scene";
import { Logger } from "../../logger";
import { bindDataAccessors, canAccessVariable } from "./nodeVariables";
import { createScriptImporter, ScriptFactory, SCRIPT_HANDLERS } from "../../scripting/scriptRuntime";

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
                    result.catch((e: any) => Logger.error(`Error in ${name} for node ${node.name}: ${e}`, 'Script'));
            }
            catch (e) { Logger.error(`Error in ${name} for node ${node.name}: ${e}`, 'Script'); }
        };
    };

    node.onConstruct = guard('onConstruct');
    node.onStart = guard('onStart');
    node.onSpawn = guard('onSpawn');
    node.onUpdate = guard('onUpdate');
    node.onCollision = guard('onCollision');
    node.onTrigger = guard('onTrigger');
    node.onDespawn = guard('onDespawn');
    node.onAction = guard('onAction');

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

    const guard = (name: string, fn: Function) => (...args: any[]) => {
        try {
            const result = fn.apply(node, args); // engine calls with the handler's own args; self is `this`
            if (result && typeof result.then === 'function')
                result.catch((e: any) => Logger.error(`Error in ${name} for node ${node.name}: ${e}`, 'Script'));
        }
        catch (e) { Logger.error(`Error in ${name} for node ${node.name}: ${e}`, 'Script'); }
    };

    applyFieldDefaults(node, proto);

    // Only the class's OWN prototype: inherited Node methods are the engine's, already on the node, and
    // `__`-prefixed names are Sucrase's field-initializer helpers rather than author methods.
    for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor' || name.startsWith('__')) continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || typeof desc.value !== 'function') continue;
        if ((SCRIPT_HANDLERS as readonly string[]).includes(name)) n[name] = guard(name, desc.value);
        else n[name] = desc.value; // helper method, runs on the node
    }
}

/**
 * Give a class script's declared fields (`speed = 1`) their DEFAULT values on the node.
 *
 * The class is never constructed, so Sucrase's lowered `__init`/`__init2`/… prototype methods are run
 * against a bare object to harvest the defaults. Only fields the node does not already have are filled
 * in, so per-node `scriptVars` win. An initializer that reads `this` is skipped rather than thrown.
 */
function applyFieldDefaults(node: Node, proto: any): void {
    const n = node as any;
    const defaults: Record<string, any> = {};
    for (const name of Object.getOwnPropertyNames(proto)) {
        if (!/^__init\d*$/.test(name)) continue;
        const fn = proto[name];
        if (typeof fn !== 'function') continue;
        try { fn.call(defaults); } catch { /* initializer depends on `this`: leave that field to scriptVars */ }
    }
    for (const key of Object.keys(defaults))
        if (n[key] === undefined) n[key] = defaults[key];
}
