import { Node } from "./node";
import type { Scene } from "../scene";
import { Logger } from "../../logger";
import { bindDataAccessors, canAccessVariable } from "./nodeVariables";
import { createScriptImporter, ScriptFactory, SCRIPT_HANDLERS } from "../../scripting/scriptRuntime";

/**
 * The bridge between a user script and a live node: the `this` proxy, and the two ways a compiled script
 * gets bound onto a node.
 *
 * Unlike nodeVariables.ts this one needs `Node` as a VALUE — the proxy traps do `instanceof Node` to decide
 * what to re-wrap — so it closes a cycle with the base class, which calls `attachScriptFactory` from its
 * parse path. That cycle is safe in both directions because neither module touches the other at module
 * evaluation time: this file only builds WeakMaps and a Symbol up front, and node.ts only defines a class.
 * Keep it that way — a top-level dereference of `Node` here would break scene loading in whichever import
 * order the bundler happened to pick.
 */


/**
 * The `this` a script sees: the node itself, with its inspector Variables as plain properties.
 *
 *   this.HealthPoints -= 1;      // a Variable declared in the inspector
 *   this.addZ(2 * delta);        // an ordinary Node method
 *   this.parent.teamScore += 1;  // a Variable on another node, access-checked
 *
 * Name resolution: the six handler slots first, then anything the Node itself has (own fields,
 * prototype getters, subclass members), then Variables. Handlers must be intercepted BEFORE the node
 * check because `Node` really does declare onStart/onUpdate/... — assigning straight through them would
 * bypass the error guard in attachScriptFactory and hand the engine an unwrapped function.
 *
 * `requester` is the node whose script is running, which is what every Variable access is checked
 * against. It differs from `target` for a proxy reached through `this.parent`, `this.children[i]`, or an
 * `other` handler argument — so those follow exactly the same public/private/protected rules that
 * getData/setData enforce.
 */
type ScriptHandlers = Record<string, Function>;

const scriptProxies: WeakMap<Node, WeakMap<Node, any>> = new WeakMap();
const proxyHandlers: WeakMap<object, ScriptHandlers> = new WeakMap();

/** Reads the real node back out of a script proxy. */
const RAW = Symbol('cleo.rawNode');

/**
 * The raw node behind a script proxy (or the value itself, if it is not one).
 *
 * The proxy is a script-facing *view* of a node: it must never be stored by the engine, which compares
 * and keys nodes by identity. Anything that takes a Node from script code and keeps it has to unwrap
 * first — the proxy does this for every Node method it forwards, and PhysicsSystem.startRagdoll does it
 * because a script reaches it through `this.scene.physics`, which is not a Node member and so is not
 * forwarded through the proxy at all.
 */
export function unwrapScriptNode<T>(value: T): T {
    return (value && (value as any)[RAW]) || value;
}

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

            // The scene lookups live on Scene, so reaching them through `this.scene` would hand back raw
            // nodes. Synthesize them here instead, where the results are proxied like every other node a
            // script touches — `this.findNode('Player').HealthPoints` then works like `this.HealthPoints`.
            if (prop === 'findNode')
                return (name: string) => wrapNode(node.scene?.findNode(name), requester);
            if (prop === 'getNodeById')
                return (id: string) => wrapNode(node.scene?.getNodeById(id), requester);
            if (prop === 'getNodesByName')
                return (name: string) => (node.scene?.getNodesByName(name) ?? []).map((found: Node) => wrapNode(found, requester));

            // `this.scene` itself must go through the same re-wrapping, or `this.scene.getNodesByName(...)`
            // / `this.scene.models` would hand back raw, un-access-checked nodes — the one remaining way a
            // script could reach a node that bypasses public/private/protected.
            if (prop === 'scene') {
                const scene = node.scene;
                return scene ? wrapScene(scene, requester) : scene;
            }

            // Not a Node member: it is a Variable (or nothing). Unreadable ones read as undefined, which
            // is what getData already does for a variable the requester may not see.
            if (!(prop in node)) {
                if (!node.variables.has(prop)) return undefined;
                return canAccessVariable(node, requester, prop) ? node.variables.get(prop).value : undefined;
            }

            const value = Reflect.get(node, prop, node);

            // Anything that hands back a Node hands back a *proxied* Node, so the script never has to
            // care which end of a reference it is holding: this.parent.hp works like this.hp.
            if (value instanceof Node) return wrapNode(value, requester);
            if (Array.isArray(value) && value.length && value[0] instanceof Node)
                return value.map((child: Node) => wrapNode(child, requester));

            // Methods run against the real node — otherwise every private field they touch would
            // re-enter these traps — and any proxy handed to them is unwrapped first, so the engine only
            // ever stores real nodes (this.addChild(other) must not park a proxy in the scene tree).
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
                // A false return (a getter-only member, e.g. `this.worldPosition = ...`) is not just
                // ignored: under the "use strict" every script runs in, a Proxy `set` trap returning
                // falsish throws a TypeError back into the handler. Warn instead — the assignment was
                // always a no-op, it just used to crash on the way to becoming one.
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
 * `this.parent`/`this.findNode(...)`. Generic over Scene's surface — a lone Node, a Node[], or a
 * Set<Node> — so a new Node-returning Scene member does not need a matching line added here to stay
 * consistent. `Set`s are rebuilt rather than proxied: a live Proxy over a built-in Set breaks its methods
 * (they need the real internal slot), and a fresh copy is exactly as correct for the read-only iteration
 * scripts actually do — precisely how getNodesByName already hands back a fresh array per call.
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

            // Methods run against the real scene (same reasoning as wrapNode: private fields must not
            // re-enter these traps), unwrapping any proxied node passed in, and their result gets the
            // same re-wrap as a plain property would.
            if (typeof value === 'function')
                return (...args: any[]) => wrapSceneValue(value.apply(target, args.map(unwrapScriptNode)), requester);

            return wrapSceneValue(value, requester);
        },
    });

    byRequester.set(scene, proxy);
    return proxy;
}

/**
 * Binds a compiled script's handlers to a node. Both paths that run scripts converge here: the editor
 * evals the source (_parseScript) and the published player loads pre-compiled factories from
 * game.scripts.js (editor/src/player/attachScripts.ts) — they share this function so the calling
 * convention cannot drift between them.
 *
 * A script declares its handlers by assigning them to `this` (`this.onUpdate = (node, delta) => {}`),
 * so the factory is called with `this` bound to the node's proxy and the handlers are collected from it
 * afterwards. The engine API is imported, not injected — the importer resolves 'cleo' to the barrel's
 * namespace, with getData/setData bound to this node for the scripts that still use them.
 */
export function attachScriptFactory(node: Node, factory: ScriptFactory): void {
    const context = wrapNode(node, node);
    const handlers = proxyHandlers.get(context)!;

    // `unwrapScriptNode` is a real export of 'cleo' — the engine needs it internally (e.g. PhysicsSystem
    // reaching a raw node through `this.scene.physics`). Handing a script the real function would let it
    // strip the proxy off `this` or any node it holds and read/write variables straight past the
    // public/private/protected checks below, so it is shadowed to identity for the script-facing 'cleo'.
    const result = factory.call(context, createScriptImporter({ ...bindDataAccessors(node), unwrapScriptNode: (value: any) => value }));

    // A class-based script returns its class constructor. It runs NATIVELY on the real node: its own
    // prototype methods (onUpdate/onCollision/… and any author-defined helper like this.canJump) are copied
    // onto the node as own properties, and their `this` is the raw node — so `this.speed` is a direct
    // property read/write, not a Map lookup, and this.parent/this.findNode(...) hand back real nodes.
    // Access levels (public/private/protected) are enforced by the editor's type-checker at author time; the
    // runtime is native, with no per-variable proxy. Field values live as own properties on the node,
    // restored from `json.scriptVars` in _commonParse before this runs.
    if (typeof result === 'function' && !!(result as any).prototype) {
        attachClassScript(node, result as any);
        return;
    }

    // Legacy path: a `this.onX = (node, ...) => ...` factory whose handlers were collected on the proxy.
    // The engine now calls handlers WITHOUT the leading node (onUpdate(delta, time)), so the proxied self is
    // prepended here to preserve the legacy `(node, ...)` calling convention. Scripts must only ever see
    // proxied nodes; a throwing handler must not take the frame down; the node's name makes the error findable.
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

    // The UI handlers exist only on the UI classes that declare them (a Button has onPress, a Slider has
    // onValueChanged). Installed through a lookup rather than named individually so a legacy script on the
    // wrong node type cannot bind a handler nothing will ever call. The class-script path needs no
    // equivalent: attachClassScript already tests SCRIPT_HANDLERS membership.
    for (const name of ['onPress', 'onValueChanged', 'onSubmit']) {
        if (typeof (node as any)[name] === 'function' && typeof handlers[name] === 'function')
            (node as any)[name] = guard(name);
    }
}

/**
 * Bind a compiled script class onto a node, natively. The class's own prototype methods become own
 * properties on the node with `this` = the node itself:
 *  - handler slots (onStart/onSpawn/onUpdate/onCollision/onTrigger/onDespawn) are wrapped so a throw or a
 *    rejected async body is caught and logged; the engine calls them with the handler's own args
 *    (`onUpdate(delta, time)`, `onCollision(other)`), self reached through `this`;
 *  - every other method (a helper like `this.canJump()`) is copied through verbatim, so it runs on the node.
 * Declared fields get their class DEFAULTS here (see applyFieldDefaults); per-node values restored from
 * `json.scriptVars` in _commonParse always win, because only still-undefined fields are filled in.
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

    // Only the class's OWN prototype — inherited Node/ModelNode methods are the engine's, already on the node.
    // `__`-prefixed names are Sucrase's field-initializer helpers (handled above), not author methods.
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
 * The node already exists, so the script's class is never constructed — which means its field initializers
 * never run on their own. Sucrase lowers each field into an `__init`/`__init2`/… prototype method that the
 * constructor would have called; run those against a bare object to harvest the declared defaults, then fill
 * in only the fields the node does not already have. That ordering is what makes per-node values win: the
 * editor restores them into `json.scriptVars` (applied in _commonParse, before the script binds), and a field
 * that already has a value is left alone.
 *
 * Without this a field whose per-node value never made it into scriptVars would read `undefined`, and the
 * first bit of arithmetic on it (`this.speed * delta`) would silently poison the node's transform with NaN.
 * An initializer that reads `this` can't be evaluated this way; it is skipped rather than allowed to throw.
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
