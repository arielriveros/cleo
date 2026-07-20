import { mat4, vec3, quat } from "gl-matrix";
import { RigidBody, Trigger } from "../../physics/body";
import { Model } from "../../graphics/model";
import { AnimatedModel } from "../../graphics/animatedModel";
import { Animator, AnimationMapping, AnimationStateMachine } from "../../graphics/animator";
import type { RagdollOptions } from "../../physics/ragdoll";
import { Sprite } from "../../graphics/sprite";
import { DirectionalLight, Light, PointLight, Spotlight } from "../../graphics/lighting";
import { Material, CustomMaterial } from "../../graphics/material";
import { Skybox } from "../../graphics/skybox";
import { Texture } from "../../graphics/texture";
import { ShaderManager } from "../../graphics/systems/shaderManager";
import { Scene } from "./scene";
import { v4 as uuidv4 } from 'uuid';
import { Camera } from "../camera";
import { CleoEngine, Shape } from "../../cleo";
import { Logger } from "../logger";
import { compileScript, createScriptImporter, ScriptFactory, SCRIPT_HANDLERS } from "../scripting/scriptRuntime";
import { Terrain, TerrainLodSettings } from "../../terrain/terrain";
import type { BVH } from "../bvh";
import { clamp, dampAngleDeg, dampTime, dampVec3Time, eulerFromQuatDeg, wrapDegrees, RAD2DEG } from "../math";
import { aimFromDirection, boomOffset, collisionRatio, shakeOffsets } from "../cameraRigMath";

type NodeType = 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'sprite' | 'animatedSprite' | 'landscape' | 'volumetricClouds' | 'skyAtmosphere' | 'lodGroup' | 'cameraRig';

export type NodeVariableType = 'number' | 'string' | 'boolean' | 'vec3';
/**
 * Cross-node access level for a variable (enforced at the scripting boundary — getData/setData):
 * - 'public'    : any node may get/set it (default).
 * - 'private'   : only the owning node may get/set it.
 * - 'protected' : the owning node and any of its descendants (subtree) may get/set it.
 */
export type NodeVariableAccess = 'public' | 'private' | 'protected';
export interface NodeVariable {
    type: NodeVariableType;
    value: any;
    access?: NodeVariableAccess; // missing = 'public' (back-compat with old saves)
}

/**
 * True if `requester` is allowed to get/set the variable `name` on `target`, per the variable's
 * access level. Non-existent variables are always accessible (creating one is allowed).
 */
export function canAccessVariable(target: Node, requester: Node, name: string): boolean {
    const v = target?.variables?.get(name);
    if (!v) return true;
    const access = v.access ?? 'public';
    if (access === 'public') return true;
    if (requester === target) return true;                 // owner always
    if (access === 'protected') return requester.isDescendantOf(target);
    return false;                                          // private, non-owner
}

/**
 * Returns a plain snapshot of a node's custom variables (name -> value). Read-only: assigning to
 * the returned object does NOT change the node — use `setData(node, name, value)` to write.
 *
 * When `requester` is supplied (the node running a script), variables that `requester` is not
 * allowed to read (private/protected owned by another node) are omitted. Called without a
 * requester (engine/editor/self) it returns every variable.
 *
 *   const data = getData(player);
 *   if (data.HealthPoints <= 0) { ... }
 *   console.log(data);                 // { HealthPoints: 3, ... }
 */
export function getData(node: Node, requester?: Node): Record<string, any> {
    const out: Record<string, any> = {};
    if (node && node.variables) {
        for (const [name, v] of node.variables) {
            if (!requester || requester === node || canAccessVariable(node, requester, name))
                out[name] = v.value;
        }
    }
    return out;
}

/**
 * Sets a custom variable on a node (including a different node than the one running the script).
 * Pass a single value, or multiple components for a vec3 (setData(node, 'pos', x, y, z)).
 *
 *   setData(other, 'HealthPoints', getData(other).HealthPoints - 1);
 */
export function setData(node: Node, name: string, ...params: any[]): void {
    if (!node || typeof node.setVariable !== 'function') return;
    const value = params.length <= 1 ? params[0] : params;
    node.setVariable(name, value);
}

/**
 * Build the getData/setData a user script sees, bound to the running node as the "requester" so
 * cross-node access respects each variable's public/private/protected level. Used by both the
 * editor-play eval path (_parseScript) and the published no-eval path (attachScripts). Reads are
 * filtered; blocked writes warn and no-op. Access to the script's OWN node is always allowed.
 */
export function bindDataAccessors(requester: Node): {
    getData: (target: Node) => Record<string, any>;
    setData: (target: Node, name: string, ...params: any[]) => void;
} {
    return {
        getData: (target: Node) => getData(target, requester),
        setData: (target: Node, name: string, ...params: any[]) => {
            if (target && target !== requester && !canAccessVariable(target, requester, name)) {
                Logger.warn(`Script on '${requester.name}' cannot set '${name}' on '${target.name}' (${target.variables.get(name)?.access ?? 'public'})`, 'Script');
                return;
            }
            setData(target, name, ...params);
        },
    };
}

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

    node.onStart = guard('onStart');
    node.onSpawn = guard('onSpawn');
    node.onUpdate = guard('onUpdate');
    node.onCollision = guard('onCollision');
    node.onTrigger = guard('onTrigger');
    node.onDespawn = guard('onDespawn');
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

export class Node {
  protected readonly _id: string;
  protected _name: string;
  protected _parent: Node | null;
  protected readonly _children: Node[];
  protected _scene: Scene | null;
  protected readonly _nodeType: NodeType;

  protected readonly  _localTransform: mat4;
  protected _worldTransform: mat4

  // Cached world-space values derived from _worldTransform, recomputed lazily only after the
  // transform actually changes (flagged in updateTransforms) instead of allocating on every read.
  protected _worldPosition: vec3 = vec3.create();
  protected _worldQuaternion: quat = quat.create();
  protected _worldScale: vec3 = vec3.create();
  protected _worldForward: vec3 = vec3.create();
  protected _worldCacheDirty: boolean = true;

  // Cached world-space bounding sphere for frustum culling, recomputed lazily only after the
  // transform changes (flagged in updateTransforms) — see getBoundingSphere().
  protected _worldSphere: { center: vec3; radius: number } = { center: vec3.create(), radius: 0 };
  protected _worldSphereDirty: boolean = true;

  // Same deal for the world-space AABB used by picking and camera collision — see getBoundingBox().
  // Without this the raycaster recomputed a mesh's box from every one of its vertices, once per node
  // *per ray*, allocating two vec3s per vertex; a 5-ray camera probe over a handful of meshes was
  // enough to cost more than the rest of the frame combined.
  protected _worldBox: { min: vec3; max: vec3 } = { min: vec3.create(), max: vec3.create() };
  protected _worldBoxDirty: boolean = true;

  protected readonly _position: vec3;
  protected readonly _translationMatrix: mat4;

  protected readonly _quaternion: quat;
  protected readonly _euler: vec3;
  protected readonly _rotationMatrix: mat4;

  protected readonly _scale: vec3;
  protected readonly _scaleMatrix: mat4;

  protected _hasStarted: boolean = false;
  protected _markForRemoval: boolean = false;

  protected _body: RigidBody | null;
  protected _trigger: Trigger | null;

  protected _visible: boolean;

  // Renderer-driven visibility for LOD level switching and distance culling (see LodGroupNode).
  // Kept separate from _visible: the `visible` setter emits SCENE_CHANGED and (on ModelNode) writes
  // material.config.castShadow — both unacceptable for a flag that flips per frame.
  protected _lodVisible: boolean = true;

  // Custom user-defined variables editable in the inspector, serialized with the node, and
  // readable from scripts via getData(node) and writable via setData(node, name, value).
  protected _variables: Map<string, NodeVariable> = new Map();

  // Script handlers, declared as overridable methods so a class-based script (`class X extends Node`) can
  // override them with matching signatures. `this` IS the node, so there is no `node` self-parameter.
  // attachScriptFactory/attachClassScript install a script's handlers as own-properties shadowing these.

  /**
   * Called once when the scene starts, or immediately on `addChild` if the scene is already running.
   * Runs after {@link onSpawn} and after node variables and script fields are restored, so it is the
   * first place both are safe to read.
   *
   * May be `async` — use {@link wait} to sequence over game time. Throwing is contained: the error is
   * logged and the rest of the scene still starts.
   */
  public onStart(): void {}

  /**
   * Called the moment this node is attached to a parent, before {@link onStart}. Fires on re-parenting
   * as well as on first spawn, so it may run more than once in a node's lifetime — put one-time setup
   * in {@link onStart} instead.
   */
  public onSpawn(): void {}

  /**
   * Called every frame while the scene is running and unpaused.
   *
   * @param delta Seconds since the previous frame. Multiply per-second rates by this — never assume a
   *              fixed frame time.
   * @param time  Seconds of unpaused game time since the scene started.
   */
  public onUpdate(delta: number, time: number): void {}

  /**
   * Called when this node's rigid body begins touching another body. Requires a {@link body} on both
   * nodes — two nodes without bodies never collide.
   *
   * @param other The node owning the other body in the contact.
   */
  public onCollision(other: Node): void {}

  /**
   * Called while another node's body overlaps this node's {@link trigger} volume. Unlike
   * {@link onCollision} this fires for a non-solid region and does not impart forces.
   *
   * @param other The node that entered the trigger volume.
   */
  public onTrigger(other: Node): void {}

  /**
   * Called when this node is removed from the scene, via {@link remove} or a parent's removal.
   * Pending {@link after}/{@link every} timers are cancelled around this call, so it is a safe place
   * to release anything the node owns. Re-parenting does NOT fire this.
   */
  public onDespawn(): void {}

  constructor(name: string, type: NodeType = 'node', id: string = uuidv4()) {
    this._name = name;
    this._id = id;
    this._parent = null;
    this._children = [];
    this._scene = null;
    this._nodeType = type;

    this._localTransform = mat4.create();
    this._worldTransform = mat4.create();

    this._position = vec3.create();
    this._translationMatrix = mat4.create();

    this._euler = vec3.create();
    this._quaternion = quat.create();
    this._rotationMatrix = mat4.create();

    this._scale = vec3.fromValues(1, 1, 1);
    this._scaleMatrix = mat4.create();

    this._body = null;
    this._trigger = null;

    this._visible = true;
  }

  /**
   * Attaches `node` as a child of this one, detaching it from its previous parent first. Re-parenting
   * this way fires {@link onSpawn} but not {@link onDespawn}.
   *
   * Fires the child's {@link onStart} immediately if this node has already started, so a node spawned
   * mid-game is initialized on attach rather than waiting for the next scene start.
   *
   * The child keeps its *local* transform, so its world position moves with the new parent.
   */
  public addChild(node: Node): void {
    // if the node already has a parent, remove it from the parent's children
    if (node.parent) {
      node.parent.removeChild(node, true);
      CleoEngine.eventEmitter.emit('SCENE_CHANGED');
    }
    
    node.parent = this;
    this._children.push(node);
    node.onSpawn();
    if (this._hasStarted)
      node.start();
    if (this.scene) {
      node.scene = this.scene;
      for (const child of node.children) {
        child.onSpawn();
        child.scene = this.scene;
      }
    }
    CleoEngine.eventEmitter.emit('SCENE_CHANGED');
  }

  /**
   * Detaches `node` from this node's children.
   *
   * @param node     The child to detach. Must actually be a child of this node.
   * @param reparent Pass `true` only when moving the node elsewhere in the tree: it suppresses
   *                 {@link onDespawn} and keeps the node's pending timers alive. The default `false`
   *                 treats the detach as a despawn.
   */
  public removeChild(node: Node, reparent: boolean = false): void {
    if (!reparent) {
      // Before onDespawn, and before `scene` is cleared below: a pending this.after/this.every must not
      // fire against a node no longer in the tree.
      node.scene?.cancelTimers(node);
      try { node.onDespawn(); } catch (e) { Logger.error(`Error in onDespawn for node ${node.name}: ${e}`); }
    }
    node.parent = null;
    node.scene = null;
    this._children.splice(this._children.indexOf(node), 1);
    CleoEngine.eventEmitter.emit('SCENE_CHANGED');
  }

  /**
   * Finds this node's *direct* children with the given name. Does not search grandchildren.
   *
   * @returns Every matching child — names are not unique. Empty if none match.
   */
  public getChildByName(name: string): Node[] {
    const nodes: Node[] = [];
    for (const child of this._children)
      if (child.name === name)
        nodes.push(child);
    return nodes;
  }

  /**
   * Finds a *direct* child by its unique id. Does not search grandchildren.
   *
   * @returns The child, or `null` if this node has no direct child with that id.
   */
  public getChildById = (id: string): Node | null => {
    for (const child of this._children)
      if (child.id === id)
        return child;
    return null;
  }

  /**
   * Recomposes this node's local transform from its position/rotation/scale, concatenates it with
   * the parent's world transform, and recurses into every descendant.
   *
   * The scene drives this each frame; call it directly only when you have moved a node and must read a
   * world-space value (`worldPosition`, `worldQuaternion`, `getBoundingSphere`) before the next frame.
   * It walks the whole subtree, so it is not free on deep hierarchies.
   *
   * @param parentWorldTransform The parent's world matrix, or `null` to treat this node as a root.
   *                             Passing `null` for a node that *does* have a parent silently detaches
   *                             it from that parent's transform.
   */
  public updateTransforms(parentWorldTransform: mat4 | null = null): void {
    // Update local transform
    mat4.fromRotationTranslationScale(this._localTransform, this._quaternion, this._position, this._scale);

    // Update world transform
    if (parentWorldTransform)
      mat4.multiply(this._worldTransform, parentWorldTransform, this._localTransform);
    else
      mat4.copy(this._worldTransform, this._localTransform);

    // World transform changed: invalidate the derived world-space cache.
    this._worldCacheDirty = true;
    this._worldSphereDirty = true;
    this._worldBoxDirty = true;

    for (const child of this._children) {
      child.updateTransforms(this._worldTransform);
    }
  }

  private _updateWorldCache(): void {
    vec3.set(this._worldPosition, this._worldTransform[12], this._worldTransform[13], this._worldTransform[14]);
    mat4.getScaling(this._worldScale, this._worldTransform);
    // mat4.getRotation assumes an unscaled matrix: under non-uniform scale the quaternion comes out
    // skewed and non-normalized (90° about Y reads back as ~94.6° with scale [3,1,2]), which then
    // mis-rotates every physics body created from worldQuaternion. Divide the scale out of the
    // basis vectors before extracting the rotation.
    const m = this._worldTransform;
    const sx = this._worldScale[0] || 1;
    const sy = this._worldScale[1] || 1;
    const sz = this._worldScale[2] || 1;
    mat4.set(Node._rotationScratch,
      m[0] / sx, m[1] / sx, m[2] / sx, 0,
      m[4] / sy, m[5] / sy, m[6] / sy, 0,
      m[8] / sz, m[9] / sz, m[10] / sz, 0,
      0, 0, 0, 1);
    mat4.getRotation(this._worldQuaternion, Node._rotationScratch);
    quat.normalize(this._worldQuaternion, this._worldQuaternion);
    vec3.transformQuat(this._worldForward, vec3.set(this._worldForward, 0, 0, 1), this._worldQuaternion);
    vec3.normalize(this._worldForward, this._worldForward);
    this._worldCacheDirty = false;
  }

  // Scratch matrix for _updateWorldCache (avoids a per-frame allocation).
  private static readonly _rotationScratch: mat4 = mat4.create();

  /** Despawns this node (and all its children) — fires onDespawn, cancels its pending timers, detaches
   *  its physics body, and removes it from the scene at the next update. */
  public remove(): void {
    this._markForRemoval = true;
    this.scene?.cancelTimers(this);
    try { this.onDespawn(); } catch (e) { Logger.error(`Error in onDespawn function for node ${this._name}: ${e}`); }
    for (const child of this._children)
      child.remove();
  }

  /** Resolves after `seconds` of unpaused game time. For `async onStart/onUpdate/...` handlers. */
  public wait(seconds: number): Promise<void> {
    return new Promise((resolve) => this.after(seconds, resolve));
  }

  /** Calls `cb` once after `seconds` of unpaused game time. Returns a function that cancels it early. */
  public after(seconds: number, cb: () => void): () => void {
    return this.scene ? this.scene.scheduleAfter(this, seconds, cb) : () => {};
  }

  /** Calls `cb` every `seconds` of unpaused game time until cancelled (or this node despawns). Returns
   *  the cancel function. */
  public every(seconds: number, cb: () => void): () => void {
    return this.scene ? this.scene.scheduleEvery(this, seconds, cb) : () => {};
  }

  public start(): void {
    try {
      this._hasStarted = true;
      this.onStart();
      for (const child of this._children)
        child.start();
    } catch (error) {
      Logger.error(`Error in onStart function for node ${this._name}: ${error}`);
    }
  }

  public update(delta: number, time: number): void {
    try {
      this.onUpdate(delta, time);
    } catch (error) {
      Logger.error(`Error in onUpdate function for node ${this._name}: ${error}`);
    }
  }

  public serialize(): Promise<any> {
    return new Promise((resolve, reject) => {
      Promise.all(this._children.map(child => child.serialize())).then(children => {
        resolve({
          id: this._id,
          name: this._name,
          type: this._nodeType,
          position: [this._position[0], this._position[1], this._position[2]],
          rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
          scale: [this._scale[0], this._scale[1], this._scale[2]],
          children: children,
          variables: this._serializeVariables()
        });
      });
    });
  }

  // Editor-play path: the script is a source string in the scene JSON, so it is compiled here. Published
  // games never reach this — their scripts ship pre-compiled in game.scripts.js and are bound by
  // attachScriptFactory directly. A script that fails to compile (syntax error, unknown import) is
  // reported and skipped: it must not take the rest of the scene down with it.
  private static _parseScript(node: Node, script: string): void {
    try {
      attachScriptFactory(node, compileScript(script));
    } catch (error) {
      Logger.error(`Error parsing script for node ${node.name}: ${error}`, 'Script');
    }
  }

  protected static _commonParse(node: Node, parent: Node, json: any) {
    // Apply the serialized transform before anything that derives from it: the rigid body is created
    // at the node's world position/orientation, collider shapes are sized by its world scale, and
    // children compound their world transforms from this node's. These assignments used to run at
    // the tail of this function, which created every physics body at the origin with unscaled
    // shapes — position/rotation were silently corrected afterwards by the setters pushing into the
    // body, but scale has no such path, so colliders never matched a scaled node.
    if (json.position) node.setPosition(json.position);
    if (json.rotation) node.setRotation(json.rotation);
    if (json.scale) node.setScale(json.scale);
    node.updateTransforms(parent.worldTransform);

    // Restore custom variables before scripts so onStart can read them.
    Node._parseVariables(node, json.variables);

    // Restore a class-script's native fields as own properties before the script binds, so its methods
    // read them directly (`this.speed`). The editor injects `scriptVars` at serialize time (like it injects
    // `script`), reading each schema field off the node — the engine never has to know the field schema.
    Node._parseScriptVars(node, json.scriptVars);

    if (json.script)
      Node._parseScript(node, json.script);

    // Shape dimensions and offsets are authored in node-local units, so the node's world scale is
    // applied here. Rotations are scale-invariant and pass through untouched, which is what keeps a
    // scaled node's colliders in the same place and orientation relative to its mesh.
    const setShapes = (shapes: any, target: RigidBody | Trigger) => {
      const scale = node.worldScale;
      const scaledOffset = (offset: number[]) => vec3.fromValues(
        offset[0] * scale[0], offset[1] * scale[1], offset[2] * scale[2]
      );

      for (const shape of shapes) {
        const offset = scaledOffset(shape.offset);
        const rotation = vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2]);

        switch (shape.type) {
          case 'box':
            target.attachShape(Shape.Box(shape.width, shape.height, shape.depth, scale), offset, rotation);
            break;
          case 'sphere':
            target.attachShape(Shape.Sphere(shape.radius, scale), offset, rotation);
            break;
          case 'plane':
            target.attachShape(Shape.Plane(), offset, rotation);
            break;
          case 'cylinder':
            target.attachShape(Shape.Cylinder(shape.radius, shape.radius, shape.height, shape.numSegments, scale), offset, rotation);
            break;
          case 'capsule': {
            // The only descriptor that expands into several cannon shapes: a capsule is a cylinder plus two
            // sphere caps. `attachShape` places a shape at bodyPos + bodyQuat * offset — the shape's OWN
            // rotation never moves it (body.ts) — and the caps are offset along the capsule's local Y, so
            // their offsets have to be rotated here. Skip this and a tilted capsule keeps its caps upright
            // while the cylinder leans out from between them.
            const q = quat.create();
            quat.fromEuler(q, rotation[0], rotation[1], rotation[2]);
            for (const part of Shape.Capsule(shape.radius, shape.height, shape.numSegments, scale)) {
              const capOffset = vec3.transformQuat(vec3.create(), part.offset, q);
              target.attachShape(part.shape, vec3.add(capOffset, capOffset, offset), rotation);
            }
            break;
          }
          case 'convex': {
            // A degenerate hull would feed NaN axes to cannon's SAT, so fall back to its bounding box.
            const hull = Shape.ConvexHull(shape.vertices, shape.faces, scale);
            if (hull) { target.attachShape(hull, offset, rotation); break; }

            const min = [Infinity, Infinity, Infinity];
            const max = [-Infinity, -Infinity, -Infinity];
            for (const v of shape.vertices as number[][])
              for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], v[i]); max[i] = Math.max(max[i], v[i]); }

            Logger.warn(`Convex hull on node ${node.name} is degenerate; falling back to its bounding box.`);
            target.attachShape(
              Shape.Box(max[0] - min[0], max[1] - min[1], max[2] - min[2], scale),
              offset, rotation
            );
            break;
          }
          default:
            console.error(`Shape type ${shape.type} not supported`);
        }
      }
    }

    if (json.body) {
      // setBody/setTrigger return the body they just created, so the shapes go straight onto that rather
      // than re-reading node._body — which is typed nullable and which the checker cannot know was just
      // assigned by the call above.
      setShapes(json.body.shapes, node.setBody(
        json.body.mass,
        json.body.linearDamping,
        json.body.angularDamping,
        json.body.linearConstraints,
        json.body.angularConstraints,
        // Absent in scenes saved before surfaces existed; RigidBody defaults them to the old behavior.
        json.body.friction,
        json.body.restitution,
        // Likewise for the two channels — absent means true, so every pre-existing scene keeps
        // simulating and keeps blocking the camera exactly as it did.
        json.body.simulatePhysics,
        json.body.cameraCollision
      ));
    }

    if (json.trigger)
      setShapes(json.trigger.shapes, node.setTrigger());

    if (json.children) {
      for (const child of json.children) {
        if (child.type === 'model')
          ModelNode.parse(node, child);
        else if (child.type === 'light')
          LightNode.parse(node, child);
        else if (child.type === 'lightProbe')
          LightProbeNode.parse(node, child);
        else if (child.type === 'skybox')
          SkyboxNode.parse(node, child);
        else if (child.type === 'camera')
          CameraNode.parse(node, child);
        else if (child.type === 'sprite')
          SpriteNode.parse(node, child);
        else if (child.type === 'animatedSprite')
          AnimatedSpriteNode.parse(node, child);
        else if (child.type === 'landscape')
          LandscapeNode.parse(node, child);
        else if (child.type === 'volumetricClouds')
          VolumetricCloudsNode.parse(node, child);
        else if (child.type === 'skyAtmosphere')
          SkyAtmosphereNode.parse(node, child);
        else if (child.type === 'lodGroup')
          LodGroupNode.parse(node, child);
        else if (child.type === 'cameraRig')
          CameraRigNode.parse(node, child);
        else
          Node.parse(node, child);
      }
    }
    parent.addChild(node);
  }

  public static parse(parent: Node, json: any) {
    const node = new Node(json.name, json.type, json.id);
    Node._commonParse(node, parent, json);
  }

  /** This node's unique id. Stable across serialization; assigned once at construction. */
  public get id(): string { return this._id; }
  /** This node's display name. Not unique — several nodes may share one. */
  public get name(): string { return this._name; }
  public set name(name: string) {
    this._name = name;
    // The scene indexes nodes by name for getNodesByName/findNode; a rename must invalidate that
    // exactly like the visible setter already invalidates scene-derived state below.
    CleoEngine.eventEmitter.emit('SCENE_CHANGED');
  }
  /**
   * Sets the parent pointer *only* — it does not move the node in the tree. Use {@link addChild} to
   * actually re-parent; assigning this directly will desynchronize the parent's child list.
   */
  public set parent(node: Node | null) { this._parent = node; }
  /** This node's parent, or `null` if it is a scene root or detached. */
  public get parent(): Node | null { return this._parent; }
  /**
   * This node's direct children.
   *
   * Returns the **live internal array**, not a copy — mutating it bypasses {@link addChild} /
   * {@link removeChild} and their lifecycle and scene bookkeeping. Treat it as read-only, and copy it
   * before iterating if the loop body may add or remove children.
   */
  public get children(): Node[] { return this._children; }
  // --- Custom variables -------------------------------------------------------------------------
  public get variables(): Map<string, NodeVariable> { return this._variables; }
  public getVariable(name: string): any {
    const v = this._variables.get(name);
    return v ? v.value : undefined;
  }
  public setVariable(name: string, value: any, type?: NodeVariableType, access?: NodeVariableAccess): void {
    const existing = this._variables.get(name);
    const resolvedType: NodeVariableType = type
      ?? existing?.type
      ?? (typeof value === 'number' ? 'number'
        : typeof value === 'boolean' ? 'boolean'
        : Array.isArray(value) ? 'vec3' : 'string');
    // Preserve the access level across value/type edits; default new variables to 'public'.
    const resolvedAccess: NodeVariableAccess = access ?? existing?.access ?? 'public';
    this._variables.set(name, { type: resolvedType, value, access: resolvedAccess });
  }
  public removeVariable(name: string): void { this._variables.delete(name); }

  /** True if this node is somewhere beneath `ancestor` in the hierarchy (any depth). */
  public isDescendantOf(ancestor: Node): boolean {
    let n: Node | null = this._parent;
    while (n) {
      if (n === ancestor) return true;
      n = n.parent;
    }
    return false;
  }

  /** Serialize custom variables into a plain `{ name: { type, value, access } }` object. */
  protected _serializeVariables(): Record<string, NodeVariable> {
    const out: Record<string, NodeVariable> = {};
    for (const [name, v] of this._variables) out[name] = { type: v.type, value: v.value, access: v.access ?? 'public' };
    return out;
  }

  /** Populate a node's variables from serialized JSON (`{ name: { type, value, access } }`). */
  protected static _parseVariables(node: Node, json: any): void {
    if (!json || typeof json !== 'object') return;
    for (const name of Object.keys(json)) {
      const entry = json[name];
      if (entry && typeof entry === 'object' && 'value' in entry)
        node.setVariable(name, entry.value, entry.type, entry.access);
      else
        node.setVariable(name, entry);
    }
  }

  /**
   * Restore a class-script's native fields (`{ name: value }`) as own properties on the node, so the
   * script's methods read/write them directly (`this.speed`). Deliberately native — script variables are
   * real instance properties, not entries in the {@link _variables} Map (which stays for the legacy,
   * editor-created variable system). The editor serializes these from the linked script's field schema.
   */
  protected static _parseScriptVars(node: Node, json: any): void {
    if (!json || typeof json !== 'object') return;
    for (const name of Object.keys(json)) (node as any)[name] = json[name];
  }

  public get scene(): Scene | null { return this._scene; }
  public set scene(scene: Scene | null) {
    this._scene = scene;
    for (const child of this._children)
      child.scene = scene;
  }
  public get hasStarted(): boolean { return this._hasStarted; }
  public get markForRemoval(): boolean { return this._markForRemoval; }

  /**
   * This node's transform relative to its parent. Live reference — read-only in practice; it is
   * recomposed from position/rotation/scale on every {@link updateTransforms}, so writes are lost.
   */
  public get localTransform(): mat4 { return this._localTransform; }
  /**
   * This node's transform in world space. Live reference, recomputed by {@link updateTransforms} —
   * stale until then if you have just moved the node.
   */
  public get worldTransform(): mat4 { return this._worldTransform; }

  /**
   * Unit +Z axis of this node's **local** rotation, ignoring any parent. For the direction the node
   * actually faces in the world, use {@link worldForward}.
   *
   * Allocates a new vector on every read — hoist it out of hot loops.
   */
  public get forward(): vec3 {
    let forward = vec3.fromValues(0, 0, 1);
    vec3.transformMat4(forward, forward, this._rotationMatrix);
    vec3.normalize(forward, forward);
    return forward;
  }

  // The four world-space getters below share one contract: each returns the LIVE cached vector, filled
  // lazily on first read after a transform change. Never mutate what they return, and never hold the
  // reference across a frame — the cache is rewritten in place, so a stored reference silently changes
  // value underneath you. Copy (`vec3.clone`) if you need either.

  /**
   * This node's position in world space, with every ancestor transform applied.
   *
   * Live cached reference — do not mutate, and copy it if you need to keep it. To *move* the node, set
   * {@link position} (local space); there is no world-space position setter.
   */
  public get worldPosition(): vec3 {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldPosition;
  }

  /**
   * This node's orientation in world space, normalized and correct under non-uniform ancestor scale
   * (the scale is divided out of the basis before extraction — see `_updateWorldCache`).
   *
   * Live cached reference — do not mutate, and copy it if you need to keep it.
   */
  public get worldQuaternion(): quat {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldQuaternion;
  }

  /**
   * This node's accumulated scale in world space (its own scale times every ancestor's).
   *
   * Live cached reference — do not mutate, and copy it if you need to keep it.
   */
  public get worldScale(): vec3 {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldScale;
  }

  /**
   * Unit +Z axis of this node's world orientation — the direction it actually faces in the scene.
   * Prefer this over {@link forward}, which ignores parent transforms.
   *
   * Live cached reference — do not mutate, and copy it if you need to keep it.
   */
  public get worldForward(): vec3 {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldForward;
  }

  /** Sets local-space X (local to this node's parent). Returns `this`, so calls chain: `node.setX(1).setY(2)`. */
  public setX(value: number): Node {
    this._position[0] = value;
    this._updateTranslationMatrix();
    return this;
  }

  /** Moves by `value` along local X. Frame-rate independent when scaled by `delta`: `this.addX(2 * delta)`. */
  public addX(value: number): Node {
    this._position[0] += value;
    this._updateTranslationMatrix();
    return this;
  }

  /** Sets local-space Y (local to this node's parent). */
  public setY(value: number): Node {
    this._position[1] = value;
    this._updateTranslationMatrix();
    return this;
  }

  /** Moves by `value` along local Y. */
  public addY(value: number): Node {
    this._position[1] += value;
    this._updateTranslationMatrix();
    return this;
  }

  /** Sets local-space Z (local to this node's parent). */
  public setZ(value: number): Node {
    this._position[2] = value;
    this._updateTranslationMatrix();
    return this;
  }

  /** Moves by `value` along local Z. */
  public addZ(value: number): Node {
    this._position[2] += value;
    this._updateTranslationMatrix();
    return this;
  }

  /** Sets local-space position (local to this node's parent — use `worldPosition` to read world-space). */
  public setPosition(pos: vec3): Node {
    vec3.copy(this._position, pos);
    this._updateTranslationMatrix();
    return this;
  }

  /** Moves by `value` along this node's own forward vector (its local -Z/+Z facing, not a world axis) —
   *  the usual "walk forward" control. */
  public addForward(value: number) {
    //vec3.add(this._position, this._position, vec3.scale(vec3.create(), this.worldForward, value));
    vec3.add(this._position, this._position, vec3.scale(vec3.create(), this.forward, value));
    this._updateTranslationMatrix();
  }

  /** Moves by `value` along this node's own right vector (perpendicular to `forward`) — "strafe". */
  public addRight(value: number) {
    // normalize forward vector
    vec3.normalize(this.forward, this.forward);
    // normalize right vector
    let right = vec3.cross(vec3.create(), this.forward, vec3.fromValues(0, 1, 0));
    vec3.normalize(right, right);
    // move along right vector
    vec3.add(this._position, this._position, vec3.scale(vec3.create(), right, value));
    this._updateTranslationMatrix();
  }

  /** Moves by `value` along this node's own up vector. */
  public addUp(value: number) {
    vec3.normalize(this.forward, this.forward);
    let right = vec3.cross(vec3.create(), this.forward, vec3.fromValues(0, 1, 0));
    vec3.normalize(right, right);
    let up = vec3.cross(vec3.create(), right, this.forward);
    vec3.normalize(up, up);
    vec3.add(this._position, this._position, vec3.scale(vec3.create(), up, value));
    this._updateTranslationMatrix();
  }

  private _updateTranslationMatrix(): void {
    if (this._body)
      this._body.setPosition(this._position);

    mat4.fromTranslation(this._translationMatrix, this._position);
  }

  /** Rotates by `value` DEGREES around local X (pitch). */
  public rotateX(value: number): Node {
    this._euler[0] += value;
    this._updateRotationMatrix();
    return this;
  }

  /** Rotates by `value` DEGREES around local Y (yaw) — the usual "turn left/right" control. */
  public rotateY(value: number): Node {
    this._euler[1] += value;
    this._updateRotationMatrix();
    return this;
  }

  /** Rotates by `value` DEGREES around local Z (roll). */
  public rotateZ(value: number): Node {
    this._euler[2] += value;
    this._updateRotationMatrix();
    return this;
  }

  /**
   * Sets local-space rotation as Euler angles in DEGREES `[x, y, z]` (pitch, yaw, roll).
   *
   * The angles compose as `Rz(roll) * Ry(yaw) * Rx(pitch)`, so the singular orientation is
   * **yaw = +/-90 degrees** (where pitch and roll collapse into one axis), not pitch. Use
   * `setQuaternion` for orientations that pass through it.
   */
  public setRotation(value: vec3): Node {
    vec3.copy(this._euler, value);
    this._updateRotationMatrix();
    return this;
  }

  /**
   * Sets local-space rotation directly as a quaternion — use this over setRotation to avoid gimbal lock.
   *
   * Keeps `_euler` in sync with the quaternion, because the two are parallel state: without the
   * sync, a later `rotateY()` would compose from whatever euler was last written and snap the node
   * back to that orientation. The euler that comes back is not necessarily the one a caller would
   * have written (the mapping is many-to-one) but it always describes the same rotation.
   *
   * Note it deliberately does NOT push into the physics body, unlike the `setRotation` path. That
   * asymmetry predates this and changing it would alter how existing scenes drive kinematic bodies.
   */
  public setQuaternion(quaternion: quat): Node {
    quat.copy(this._quaternion, quaternion);
    eulerFromQuatDeg(this._euler, this._quaternion);
    mat4.fromQuat(this._rotationMatrix, this._quaternion);
    return this;
  }
  
  private _updateRotationMatrix(): void {
    quat.fromEuler(this._quaternion, this._euler[0], this._euler[1], this._euler[2]);
    if (this._body) this._body.setQuaternion(this._quaternion);
    mat4.fromQuat(this._rotationMatrix, this._quaternion);
  }

  public setXScale(value: number): Node {
    this._scale[0] = value;
    this._updateScaleMatrix();
    return this;
  }

  public addXScale(value: number): Node {
    this._scale[0] += value;
    this._updateScaleMatrix();
    return this;
  }

  public setYScale(value: number): Node {
    this._scale[1] = value;
    this._updateScaleMatrix();
    return this;
  }

  public addYScale(value: number): Node {
    this._scale[1] += value;
    this._updateScaleMatrix();
    return this;
  }

  public setZScale(value: number): Node {
    this._scale[2] = value;
    this._updateScaleMatrix();
    return this;
  }

  public addZScale(value: number): Node {
    this._scale[2] += value;
    this._updateScaleMatrix();
    return this;
  }

  /** Sets local-space scale `[x, y, z]`. Non-uniform scale is fine for rendering; physics colliders on a
   *  non-uniformly-scaled node fall back to a convex hull (see the physics collider feature). */
  public setScale(scale: vec3): Node {
    vec3.copy(this._scale, scale);
    this._updateScaleMatrix();
    return this;
  }

  public setUniformScale(value: number): Node {
    vec3.set(this._scale, value, value, value);
    this._updateScaleMatrix();
    return this;
  }

  private _updateScaleMatrix(): void {
    mat4.fromScaling(this._scaleMatrix, this._scale);
  }

  /** This node's rigid body, or `null` if it has none. See {@link setBody}. */
  public get body(): RigidBody | null { return this._body; }

  /**
   * True when this node's rigid body is resting on something solid — terrain or another body — in the
   * CURRENT gravity direction. Works under any gravity configuration: "down" is the world's gravity vector,
   * not -Y, so inverted or sideways gravity behaves correctly (and under zero gravity nothing is grounded).
   *
   *   if (this.isGrounded) this.velocity = [v[0], JUMP_SPEED, v[2]];
   *
   * Answered from the physics contacts, so it costs no raycast and needs no per-scene wiring. Always false
   * for a node with no body, so a caller never has to check for one.
   *
   * Allows a short grace (~0.1s) after the last real ground contact, because cannon drops the contact of a
   * perfectly resting body for the odd frame and the body plainly has not left the ground — see
   * PhysicsSystem's GROUND_GRACE. Two consequences worth knowing: you get coyote-time jumping for free, and
   * this stays true for that grace after you genuinely walk off a ledge, so it is not the way to ask "am I
   * falling right now" — `velocity[1]` is.
   */
  public get isGrounded(): boolean {
    if (!this._body) return false;
    return this._scene?.physics?.isGrounded(this._body) ?? false;
  }

  /**
   * Surface normal of the ground this node is standing on, pointing up out of it: `[0, 1, 0]` on level ground
   * under normal gravity, tilted on a slope. Use it to move ALONG the ground rather than through it:
   *
   *   const n = this.groundNormal;
   *   const d = dir[0]*n[0] + dir[1]*n[1] + dir[2]*n[2];
   *   dir = normalize([dir[0]-n[0]*d, dir[1]-n[1]*d, dir[2]-n[2]*d]);  // now parallel to the surface
   *
   * Falls back to up (gravity reversed) when airborne, bodyless, or under zero gravity — so the projection
   * above is a no-op in those cases and callers need no special case. Returns a fresh vec3.
   */
  public get groundNormal(): vec3 {
    const up = vec3.fromValues(0, 1, 0);
    if (!this._body) return up;
    return this._scene?.physics?.groundNormal(this._body) ?? up;
  }

  /**
   * This node's world-space velocity, in units per second: `[0, 0, 0]` when it is still (or has no body),
   * `[0, 0, 5]` when it is moving along +Z at 5. Assigning drives the body — the component along gravity is
   * yours to preserve, which is what keeps falling and jumping intact while steering horizontally:
   *
   *   const v = this.velocity;
   *   this.velocity = [dirX * speed, v[1], dirZ * speed];
   *
   * A fresh vector each read (like `forward`), so it is safe to hold on to. Assigning to a node with no body
   * does nothing.
   */
  public get velocity(): vec3 {
    if (!this._body) return vec3.create();
    const v = this._body.velocity;
    return vec3.fromValues(v.x, v.y, v.z);
  }
  public set velocity(value: vec3) {
    // cannon owns the Vec3 and reads it in place every step, so it is mutated rather than replaced.
    this._body?.velocity.set(value[0], value[1], value[2]);
  }

  /**
   * Gives this node a rigid body, created at its current world position and orientation, and wires
   * {@link onCollision}. The body drives the node's transform from here on.
   *
   * Note the body is built from the node's world transform at call time, so set the node's transform
   * *before* calling this. Only meaningful on root-level nodes today — a body on a child node does not
   * track its parent's transform.
   *
   * @param mass              Kilograms. `0` makes the body static: immovable, but still collidable.
   * @param linearDamping     Fraction of linear velocity bled off per second (0 = none, 1 = frozen).
   * @param angularDamping    Fraction of angular velocity bled off per second.
   * @param linearConstraints Per-axis `[x, y, z]` multipliers on linear motion; `0` locks the axis,
   *                          `1` leaves it free. `[1, 1, 0]` confines the body to the XY plane.
   * @param angularConstraints Per-axis multipliers on rotation; `[0, 1, 0]` yaw-only, the usual
   *                          setup for an upright character that must not topple.
   * @param friction          Surface grip, default `0.3`. On contact the pair combines with `min`, so
   *                          the *slipperier* surface wins — a 0.3 body still slides on a 1.0 floor.
   *                          Use `0` for a character whose script owns its own speed.
   * @param restitution       Bounciness, default `0`. Combines with `max`, so the *bouncier* surface
   *                          wins: `0` absorbs the impact, `1` rebounds at the speed it landed.
   * @param simulatePhysics   Take part in physical simulation (collide, push, be pushed). Default
   *                          `true`; `false` leaves the body in the world as a ghost the solver
   *                          ignores, which a camera probe can still see.
   * @param cameraCollision   Block a camera rig's collision probe. Default `true`. Independent of
   *                          `simulatePhysics`, so an object can be solid to the camera but not the
   *                          character, or the reverse.
   * @returns The new body, also available afterwards as {@link body}.
   */
  public setBody(
    mass: number,
    linearDamping?: number,
    angularDamping?: number,
    linearConstraints?: [number, number, number],
    angularConstraints?: [number, number, number],
    friction?: number,
    restitution?: number,
    simulatePhysics?: boolean,
    cameraCollision?: boolean
  ): RigidBody {
    // TODO: Handle the case where the node is a child of another node
    this._body = new RigidBody({
      mass,
      linearDamping,
      angularDamping,
      // Valid during parse: _commonParse applies the JSON transform before creating the body.
      position: this.worldPosition,
      quaternion: this.worldQuaternion,
      linearConstraints, angularConstraints,
      friction, restitution,
      simulatePhysics, cameraCollision
    }, this);

    // handle onCollision event
    this._body.addEventListener('collide', (event: any) => {
      if (event.body instanceof RigidBody || event.body instanceof Trigger)
        this.onCollision(event.body.owner);
    });

    return this._body;
  }

  /** This node's trigger volume, or `null` if it has none. See {@link setTrigger}. */
  public get trigger(): Trigger | null { return this._trigger; }
  /**
   * Turns this node into a non-solid trigger volume, created at its current world transform and wired
   * to {@link onTrigger}. Bodies pass straight through it — nothing is pushed — which is what makes it
   * the tool for checkpoints, pickups and detection zones rather than {@link setBody}.
   *
   * @returns The new trigger, also available afterwards as {@link trigger}.
   */
  public setTrigger(): Trigger {
    this._trigger = new Trigger({
      position: this.worldPosition,
      quaternion: this.worldQuaternion
    }, this);

    // handle onTrigger event
    this._trigger.addEventListener('collide', (event: any) => {
      if (event.body instanceof RigidBody || event.body instanceof Trigger)
        this.onTrigger(event.body.owner);
    });

    return this._trigger;
  }

  // These four return the node's LIVE internal vectors, so writing through them —
  // `node.position[0] += 1` — skips the bookkeeping the setters do: the translation/rotation/scale
  // matrix is not recomposed and the change is never pushed into the physics body, leaving the node
  // and its collider disagreeing about where it is. Read through them; write with setPosition/
  // setRotation/setQuaternion/setScale (or setX/addX/rotateY/...).

  /** Local-space position, relative to the parent. Live reference — write with {@link setPosition}. */
  public get position(): vec3 { return this._position; }
  /**
   * Local-space rotation as Euler angles in radians `[pitch, yaw, roll]`.
   * Live reference — write with {@link setRotation}.
   */
  public get rotation(): vec3 { return this._euler; }

  /**
   * Local-space rotation as a quaternion — the gimbal-lock-free form of {@link rotation}.
   * Live reference — write with {@link setQuaternion}.
   */
  public get quaternion(): quat { return this._quaternion; }
  /** Local-space scale. Live reference — write with {@link setScale}. */
  public get scale(): vec3 { return this._scale; }
  /** This node's kind (`'node'`, `'model'`, `'light'`, ...). Fixed at construction. */
  public get nodeType(): string { return this._nodeType; }
  /**
   * Whether this node renders. Reflects both the authored flag and renderer-driven LOD/distance
   * culling, so it can read `false` on a node you never hid — see {@link setLodVisible}.
   */
  public get visible(): boolean { return this._visible && this._lodVisible; }
  /** Sets authored visibility, recursively for every descendant. */
  public set visible(value: boolean) {
    this._visible = value;
    for (const child of this._children)
      child.visible = value;
    CleoEngine.eventEmitter.emit('SCENE_CHANGED');
  }

  /** Event-less recursive visibility used by LOD switching/culling; does not touch _visible. */
  public setLodVisible(value: boolean): void {
    this._lodVisible = value;
    for (const child of this._children)
      child.setLodVisible(value);
  }

  /**
   * World-space axis-aligned bounding box. The default is a unit cube scaled by the world scale;
   * {@link ModelNode} overrides it with the geometry's actual bounds.
   *
   * Cached and invalidated with the transform (`_worldBoxDirty`), so the returned object is a **live
   * reference rewritten in place** — exactly like {@link worldPosition} and {@link getBoundingSphere}.
   * Clone it if you need to keep a box across frames or compare two nodes' boxes.
   */
  public getBoundingBox(): { min: vec3, max: vec3 } {
    if (!this._worldBoxDirty) return this._worldBox;

    const position = this.worldPosition;
    const scale = this.worldScale;
    const hx = Math.abs(scale[0]) * 0.5, hy = Math.abs(scale[1]) * 0.5, hz = Math.abs(scale[2]) * 0.5;

    vec3.set(this._worldBox.min, position[0] - hx, position[1] - hy, position[2] - hz);
    vec3.set(this._worldBox.max, position[0] + hx, position[1] + hy, position[2] + hz);

    this._worldBoxDirty = false;
    return this._worldBox;
  }

  /**
   * Object-space Bounding Volume Hierarchy for exact ray/triangle picking, or `null` when the node
   * has no static triangle geometry (the raycaster then falls back to the AABB from
   * {@link getBoundingBox}). Overridden by {@link ModelNode} for static meshes.
   */
  public getBVH(): BVH | null {
    return null;
  }

  /**
   * World-space bounding sphere used for fast frustum culling. The default matches the unit-cube
   * {@link getBoundingBox}: centered at the world position with a radius covering the scaled cube's
   * corner. {@link ModelNode} overrides this with the geometry's actual (cached) bounds.
   */
  public getBoundingSphere(): { center: vec3; radius: number } {
    const scale = this.worldScale;
    const maxScale = Math.max(Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2]));
    vec3.copy(this._worldSphere.center, this.worldPosition);
    // Half-diagonal of the scaled unit cube: 0.5 * sqrt(3) per axis, times the largest world scale.
    this._worldSphere.radius = 0.5 * Math.sqrt(3) * maxScale;
    return this._worldSphere;
  }
}

export class ModelNode extends Node {
    private _model: Model | AnimatedModel;
    private _initialized: boolean;
    // Material type the mesh VAO/vertex-data were last built for. If the material type changes
    // (e.g. the editor switches basic <-> default/pbr, which use different vertex attribute
    // layouts), the mesh must be rebuilt — see the `initialized` getter.
    private _initializedType: string | null = null;
    private _animator: Animator | null;
    private _movementDirection: vec3;
    /** Optional per-node ragdoll simulation config (skinned meshes). Persisted with the scene; read by Ragdoll. */
    private _ragdollConfig: RagdollOptions | null = null;

    constructor(name: string, model: Model | AnimatedModel, id: string = uuidv4()) {
        super(name, 'model', id);
        this._model = model;
        this._initialized = false;
        this._movementDirection = vec3.create();
        
        // Create animator for animated models
        if (model instanceof AnimatedModel && model.hasSkin) {
            this._animator = new Animator(model, this);
        } else {
            this._animator = null;
        }
    }

    public initializeModel(): void {
        const shader = ShaderManager.Instance.getShader(this._model.material.type);
        this._model.mesh.initializeVAO(shader.attributes);
        const attributes = [];

        for (const attr of shader.attributes) {
            switch (attr.name) {
                case 'position':
                case 'a_position':
                    attributes.push('position');
                    break;
                case 'normal':
                case 'a_normal':
                    attributes.push('normal');
                    break;
                case 'uv':
                case 'a_uv':
                case 'texCoord':
                case 'a_texCoord':
                    attributes.push('uv');
                    break;
                case 'tangent':
                case 'a_tangent':
                    attributes.push('tangent');
                    break;
                case 'bitangent':
                case 'a_bitangent':
                    attributes.push('bitangent');
                    break;
                default:
                    const errMsg = `Attribute ${attr.name} not supported`;
                    Logger.error(errMsg)
                    throw new Error(errMsg);
            }
        }

        this._model.mesh.create(this._model.geometry.getData(attributes), this._model.geometry.vertexCount, this._model.geometry.indices);
        this._initialized = true;
        this._initializedType = this._model.material.type;
    }

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            const model = this._model.serialize()
            
            // Serialize animation mappings + state machine if animator exists
            let animationMappings: AnimationMapping[] | null = null;
            let stateMachine: AnimationStateMachine | null = null;
            if (this._animator) {
                animationMappings = this._animator.getAnimationMappings();
                stateMachine = this._animator.getStateMachine();
            }

            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    model: model,
                    animationMappings: animationMappings,
                    stateMachine: stateMachine,
                    ragdoll: this._ragdollConfig
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        // Check if this is an AnimatedModel by looking for animation/skin data
        const isAnimated = json.model.skin || json.model.animations || json.model.jointIndices;
        const model = isAnimated ? AnimatedModel.parse(json.model) : Model.parse(json.model);
        const node = new ModelNode(json.name, model, json.id);
        
        // Restore animation mappings if they exist
        if (json.animationMappings && node.animator) {
            node.animator.setAnimationMappings(json.animationMappings);
        }

        // Restore the animation state machine if present (takes precedence over mappings).
        if (json.stateMachine && node.animator) {
            node.animator.setStateMachine(json.stateMachine);
        }

        // Restore ragdoll config if present
        if (json.ragdoll) node.ragdollConfig = json.ragdoll;

        Node._commonParse(node, parent, json);
    }

    public get model(): Model | AnimatedModel { return this._model; }
    // Reports uninitialized when the material type changed since the mesh was built, so the
    // renderer's `if (!node.initialized) node.initializeModel()` guards rebuild the VAO/vertex
    // data for the new material's attribute layout (basic uses a different layout than default/pbr).
    public get initialized(): boolean {
        return this._initialized && this._initializedType === this._model.material.type;
    }
    public get animator(): Animator | null { return this._animator; }
    public get ragdollConfig(): RagdollOptions | null { return this._ragdollConfig; }
    public set ragdollConfig(config: RagdollOptions | null) { this._ragdollConfig = config; }
    public get movementDirection(): vec3 { return this._movementDirection; }
    public set movementDirection(direction: vec3) { 
        vec3.copy(this._movementDirection, direction);
    }
    public get visible(): boolean { return super.visible; }
    public set visible(value: boolean) {
      super.visible = value;
      this._model.material.config.castShadow = value;
      for (const child of this._children)
        child.visible = value;
      CleoEngine.eventEmitter.emit('SCENE_CHANGED');
    }

    /**
     * World-space AABB of the model's geometry: the geometry's cached object-space box transformed by
     * the world matrix. Cached against `_worldBoxDirty`, so it costs 8 corner transforms at most once
     * per frame, and the returned object is a live reference (see {@link Node.getBoundingBox}).
     *
     * This used to transform *every vertex of the mesh on every call*, allocating two vec3s each, with
     * no cache — and the raycaster calls it once per node per ray. A 5-ray camera-collision probe over
     * 40 mid-poly meshes meant ~1M transforms and ~2M allocations per frame (~18ms, most of it GC).
     *
     * Transforming the local box's corners gives a bound that is correct but looser than the exact
     * vertex hull for a rotated mesh — the standard trade (Unity/Unreal both do this). Precise picking
     * is unaffected: the raycaster refines AABB hits against the triangle BVH.
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        if (!this._worldBoxDirty) return this._worldBox;

        const geometry = this._model.geometry;
        // No geometry → fall back to the base unit cube (which fills and un-dirties the same cache).
        if (geometry.positions.length === 0) return super.getBoundingBox();

        const local = geometry.boundingBox;
        const transform = this.worldTransform;
        const corner = ModelNode._boxScratch;

        const min = this._worldBox.min;
        const max = this._worldBox.max;
        vec3.set(min, Infinity, Infinity, Infinity);
        vec3.set(max, -Infinity, -Infinity, -Infinity);

        for (let i = 0; i < 8; i++) {
            vec3.set(corner,
                (i & 1) ? local.max[0] : local.min[0],
                (i & 2) ? local.max[1] : local.min[1],
                (i & 4) ? local.max[2] : local.min[2]);
            vec3.transformMat4(corner, corner, transform);

            for (let a = 0; a < 3; a++) {
                if (corner[a] < min[a]) min[a] = corner[a];
                if (corner[a] > max[a]) max[a] = corner[a];
            }
        }

        // Skinned meshes deform on the GPU, so the bind-pose bound understates the animated extent.
        // Inflate about the centre by the same factor getBoundingSphere uses, to avoid a limb sticking
        // out of the box (which would make it unpickable and invisible to camera collision).
        if (this._model instanceof AnimatedModel) {
            for (let a = 0; a < 3; a++) {
                const centre = (min[a] + max[a]) * 0.5;
                const half = (max[a] - min[a]) * 0.5 * 1.75;
                min[a] = centre - half;
                max[a] = centre + half;
            }
        }

        this._worldBoxDirty = false;
        return this._worldBox;
    }

    // Reused across the 8 corners so the whole path stays allocation-free.
    private static readonly _boxScratch: vec3 = vec3.create();

    /**
     * Static meshes expose their geometry's cached BVH for exact picking. Skinned/animated meshes
     * deform on the GPU, so an object-space BVH would not match the current pose — those return
     * `null` and fall back to AABB picking.
     */
    public getBVH(): BVH | null {
        if (this._model instanceof AnimatedModel) return null;
        const bvh = this._model.geometry.bvh;
        // Geometry with no triangles → fall back to AABB picking.
        return bvh.triangleCount > 0 ? bvh : null;
    }

    /**
     * World-space bounding sphere for frustum culling: the geometry's cached local sphere transformed
     * by the world matrix, radius scaled by the largest world-axis scale. Cached and invalidated with
     * the transform (`_worldSphereDirty`). Skinned/animated meshes deform on the GPU, so their bind-pose
     * bound understates the animated extent — inflate the radius to avoid popping.
     */
    public getBoundingSphere(): { center: vec3; radius: number } {
        if (!this._worldSphereDirty) return this._worldSphere;

        const local = this._model.geometry.boundingSphere;
        vec3.transformMat4(this._worldSphere.center, local.center, this.worldTransform);

        const scale = this.worldScale;
        const maxScale = Math.max(Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2]));
        let radius = local.radius * maxScale;
        if (this._model instanceof AnimatedModel) radius *= 1.75;

        this._worldSphere.radius = radius;
        this._worldSphereDirty = false;
        return this._worldSphere;
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        // Skip animator playback when the scene has animations disabled (editor scenes) so skinned
        // meshes hold their bind pose; Play scenes leave it enabled, and the Animation Editor drives
        // its preview clone's animator directly (not via scene.update), so both still animate.
        if (this._animator && this._scene?.animationsEnabled !== false) {
            this._animator.checkTriggers();
            this._animator.update(delta);
        }
    }
}

/**
 * Groups alternate LOD subtrees of one mesh asset: child i holds the whole level-i subtree and only
 * one level shows at a time, selected each frame by camera distance (Renderer._updateModelLOD →
 * updateLod). `distances[i]` is the distance at which child i becomes active (ascending,
 * distances[0] = 0). When `cullDistance > 0` the whole group hides past it; 0 = never cull.
 * Level switches use the event-less `setLodVisible` flag, never the `visible` setter (which emits
 * SCENE_CHANGED and, on ModelNode, clobbers material.config.castShadow).
 */
export class LodGroupNode extends Node {
    public distances: number[] = [0];
    public cullDistance: number = 0;

    private _activeLod: number = 0;
    private _distanceCulled: boolean = false;

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'lodGroup', id);
    }

    public get activeLod(): number { return this._activeLod; }
    public get distanceCulled(): boolean { return this._distanceCulled; }

    // Show exactly the active level (or nothing while distance-culled). Called on parse and on
    // transitions only — subtree flag writes are not per-frame work.
    private _applyActiveLod(): void {
        for (let i = 0; i < this._children.length; i++)
            this._children[i].setLodVisible(!this._distanceCulled && i === this._activeLod);
    }

    /**
     * Distance from the camera to the *surface* of the group's bounding sphere picks the level, with
     * the same ×0.9 hysteresis as Terrain.lodFor: coarsen (and cull) immediately, refine/un-cull only
     * once comfortably inside the threshold, so a camera sitting on a boundary doesn't flip per frame.
     */
    public updateLod(camPos: vec3): void {
        if (this._children.length === 0) return;

        const sphere = this.getBoundingSphere();
        const d = Math.max(0, vec3.distance(camPos, sphere.center) - sphere.radius);

        const culled = this.cullDistance > 0 &&
            (this._distanceCulled ? d > this.cullDistance * 0.9 : d > this.cullDistance);
        if (culled !== this._distanceCulled) {
            this._distanceCulled = culled;
            this._applyActiveLod();
        }
        if (culled) return;

        let target = 0;
        for (let i = Math.min(this._children.length, this.distances.length) - 1; i > 0; i--) {
            if (d >= this.distances[i]) { target = i; break; }
        }
        if (target > this._activeLod ||
            (target < this._activeLod && d < this.distances[this._activeLod] * 0.9)) {
            this._activeLod = target;
            this._applyActiveLod();
        }
    }

    /**
     * Union of the level-0 subtree's ModelNode spheres — level 0 is the authored mesh, the other
     * levels are stand-ins for the same object, so its bound serves the whole group (for LOD distance
     * and frustum culling alike). Uses the shared per-frame _worldSphere cache.
     */
    public getBoundingSphere(): { center: vec3; radius: number } {
        if (!this._worldSphereDirty) return this._worldSphere;

        let found = false;
        const center = vec3.create();
        let radius = 0;
        const merge = (s: { center: vec3; radius: number }) => {
            if (!found) { vec3.copy(center, s.center); radius = s.radius; found = true; return; }
            const dist = vec3.distance(center, s.center);
            if (dist + s.radius <= radius) return;              // s inside current
            if (dist + radius <= s.radius) {                    // current inside s
                vec3.copy(center, s.center); radius = s.radius; return;
            }
            const newRadius = (dist + radius + s.radius) / 2;
            vec3.lerp(center, center, s.center, (newRadius - radius) / dist);
            radius = newRadius;
        };
        const visit = (node: Node) => {
            if (node instanceof ModelNode) merge(node.getBoundingSphere());
            for (const child of node.children) visit(child);
        };
        if (this._children[0]) visit(this._children[0]);
        if (!found) return super.getBoundingSphere();

        vec3.copy(this._worldSphere.center, center);
        this._worldSphere.radius = radius;
        this._worldSphereDirty = false;
        return this._worldSphere;
    }

    public serialize(): Promise<any> {
        return new Promise((resolve) => {
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    id: this._id,
                    name: this._name,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    distances: [...this.distances],
                    cullDistance: this.cullDistance
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new LodGroupNode(json.name, json.id);
        node.distances = Array.isArray(json.distances) && json.distances.length ? json.distances.map(Number) : [0];
        node.cullDistance = typeof json.cullDistance === 'number' ? json.cullDistance : 0;
        Node._commonParse(node, parent, json);
        node._applyActiveLod(); // children exist only after _commonParse: start showing level 0
    }
}

/** How `followOffset` is oriented relative to the follow target. */
export type FollowSpace = 'world' | 'targetYaw' | 'targetFull';
/** What drives the rig's aim. */
export type AimMode = 'orbit' | 'lookAt' | 'none';

/**
 * Drives a child CameraNode: follow, aim, spring arm, collision, shake.
 *
 * Hierarchy contract — the rig sits ABOVE a CameraNode and may itself be nested under anything (a
 * vehicle, a bone). The rig node carries the *pivot* (its position) and the *aim* (its rotation);
 * the camera child carries only the boom as a local offset with identity rotation, so it inherits
 * the aim. That split is what makes a local offset of `(0, 0, -armLength)` actually mean "behind".
 *
 * Consequence: **the camera child's local position and rotation become rig-derived state** and are
 * overwritten every frame. They still serialize; the rig just reasserts them on the next pass.
 *
 * Terminology follows the industry split (Cinemachine, Unreal's Cine Camera): `follow` drives
 * position, `lookAt` drives aim, and they are independent — a camera can orbit a player while
 * staring at a boss.
 *
 * Driven by `Scene.update`'s late pass (see `lateUpdate`), NOT by the normal `update` loop.
 *
 * Angles are DEGREES; damping values are time constants in SECONDS where 0 means rigid.
 */
export class CameraRigNode extends Node {
    // --- targets (serialized as ids; the node handles are resolution caches) ---------------------
    private _followId: string | null = null;
    private _lookAtId: string | null = null;
    private _followNode: Node | null = null;
    private _lookAtNode: Node | null = null;

    // --- follow ----------------------------------------------------------------------------------
    /** Pivot offset from the follow target. Y is the "height" above it. */
    public followOffset: vec3 = vec3.fromValues(0, 1.6, 0);
    public followSpace: FollowSpace = 'world';
    /** Per-axis time constants. Separate axes are what allow "loose horizontally, tight vertically". */
    public followDamping: vec3 = vec3.fromValues(0.15, 0.25, 0.15);
    /** Whether `followDamping`'s axes are world axes or the rig's own yaw-aligned axes. */
    public followDampingSpace: 'world' | 'rig' = 'world';

    // --- aim -------------------------------------------------------------------------------------
    public aimMode: AimMode = 'orbit';
    public lookAtOffset: vec3 = vec3.fromValues(0, 1.6, 0);
    public aimDamping: number = 0.1;
    public yawSensitivity: number = 0.2;
    public pitchSensitivity: number = 0.2;
    public invertPitch: boolean = false;
    /** +/-Infinity leaves yaw free (wrapped at the seam) rather than clamped. */
    public yawMin: number = -Infinity;
    public yawMax: number = Infinity;
    public pitchMin: number = -80;
    public pitchMax: number = 80;
    private _yaw: number = 0;
    private _pitch: number = 12;    // positive pitch looks DOWN

    // --- spring arm ------------------------------------------------------------------------------
    public armLength: number = 4;
    public socketOffset: vec3 = vec3.create();

    // --- fov -------------------------------------------------------------------------------------
    /** Opt-in: while false the rig leaves `camera.fov` alone, so the Camera inspector stays authoritative. */
    public fovEnabled: boolean = false;
    public fov: number = 60;
    public fovDamping: number = 0.2;

    // --- collision -------------------------------------------------------------------------------
    public collisionEnabled: boolean = true;
    public collisionRadius: number = 0.2;
    /** Floor on the boom scale. Never 0 — see `collisionRatio`. */
    public collisionMinRatio: number = 0.05;
    /** 0 snaps the camera in instantly, which is correct: easing in leaves it inside the wall. */
    public collisionPullTime: number = 0;
    public collisionReturnTime: number = 0.35;
    /** Nodes (by id) whose bodies the probe ignores, alongside the follow/lookAt targets. */
    public collisionIgnoreIds: string[] = [];

    // --- shake -----------------------------------------------------------------------------------
    public shakePositionAmplitude: vec3 = vec3.fromValues(0.15, 0.15, 0.05);
    /** Degrees, [pitch, yaw, roll]. */
    public shakeRotationAmplitude: vec3 = vec3.fromValues(1.5, 1.5, 2.5);
    public shakeFrequency: number = 22;
    public shakeDecay: number = 1.4;
    /** Non-decaying 0..1 channel a script holds during a rumble; impulses still spike above it. */
    public shakeSustained: number = 0;
    private _trauma: number = 0;
    private _shakeTime: number = 0;
    // Per-instance, and deliberately NOT serialized: a fixed seed would make every rig in a scene
    // shake in perfect unison.
    private readonly _shakeSeed: number = (Math.random() * 0x7fffffff) | 0;

    // --- camera child ----------------------------------------------------------------------------
    /** Optional explicit pin; otherwise the rig finds the nearest CameraNode below it. */
    public cameraNodeId: string | null = null;
    private _cameraChild: CameraNode | null = null;

    // --- runtime state (never serialized) --------------------------------------------------------
    private _pivot: vec3 = vec3.create();
    private _armRatio: number = 1;
    private _currentFov: number = 60;
    private _initialized: boolean = false;
    private _warnedNoCamera: boolean = false;
    private _warnedDanglingFollow: boolean = false;
    private _warnedDanglingLookAt: boolean = false;

    // Scratch, to keep the per-frame path allocation-free.
    private static readonly _v0: vec3 = vec3.create();
    private static readonly _v1: vec3 = vec3.create();
    private static readonly _v2: vec3 = vec3.create();
    private static readonly _v3: vec3 = vec3.create();
    private static readonly _q0: quat = quat.create();
    private static readonly _q1: quat = quat.create();
    private static readonly _m0: mat4 = mat4.create();
    // Separate from _v0.._v3: the collision probe runs while the boom vectors are still live.
    private static readonly _probeDir: vec3 = vec3.create();
    private static readonly _probeRight: vec3 = vec3.create();
    private static readonly _probeUp: vec3 = vec3.create();
    private static readonly _rayFrom: vec3 = vec3.create();
    private static readonly _rayTo: vec3 = vec3.create();
    private static readonly _shake = { position: vec3.create(), rotation: vec3.create() };

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'cameraRig', id);
    }

    // --- target accessors ------------------------------------------------------------------------

    /** The node whose position the rig follows, or null. */
    public get follow(): Node | null { return this._resolveFollow(); }
    public set follow(node: Node | null) {
        // The script proxy's `set` trap forwards values untouched, so a script assigning
        // `rig.follow = this.findNode('Player')` would otherwise store a Proxy that never compares
        // equal to the real node.
        const raw = node ? unwrapScriptNode(node) : null;
        this._followNode = raw;
        this._followId = raw ? raw.id : null;
        this._warnedDanglingFollow = false;
    }

    /** The node the rig aims at while `aimMode` is 'lookAt', or null. */
    public get lookAt(): Node | null { return this._resolveLookAt(); }
    public set lookAt(node: Node | null) {
        const raw = node ? unwrapScriptNode(node) : null;
        this._lookAtNode = raw;
        this._lookAtId = raw ? raw.id : null;
        this._warnedDanglingLookAt = false;
    }

    public get followId(): string | null { return this._followId; }
    public set followId(id: string | null) {
        this._followId = id || null;
        this._followNode = null;
        this._warnedDanglingFollow = false;
    }

    public get lookAtId(): string | null { return this._lookAtId; }
    public set lookAtId(id: string | null) {
        this._lookAtId = id || null;
        this._lookAtNode = null;
        this._warnedDanglingLookAt = false;
    }

    // --- orbit ------------------------------------------------------------------------------------

    public get yaw(): number { return this._yaw; }
    public set yaw(degrees: number) { this._yaw = this._clampYaw(degrees); }
    public get pitch(): number { return this._pitch; }
    public set pitch(degrees: number) { this._pitch = clamp(degrees, this.pitchMin, this.pitchMax); }

    /**
     * Adds RAW input (a mouse delta in pixels, a stick axis) to yaw, scaled by `yawSensitivity`.
     *
     * Deliberately does not multiply by frame delta: mouse deltas are already per-frame quantities,
     * and scaling them by dt makes the camera speed depend on frame rate. Analog-stick callers, whose
     * input is a rate, should multiply by delta themselves.
     */
    public addYaw(raw: number): CameraRigNode {
        this._yaw = this._clampYaw(this._yaw + raw * this.yawSensitivity);
        return this;
    }

    /** Adds RAW input to pitch, scaled by `pitchSensitivity` and honouring `invertPitch`. See `addYaw`. */
    public addPitch(raw: number): CameraRigNode {
        const delta = raw * this.pitchSensitivity * (this.invertPitch ? -1 : 1);
        this._pitch = clamp(this._pitch + delta, this.pitchMin, this.pitchMax);
        return this;
    }

    /** Sets both angles at once, clamped but WITHOUT the sensitivity scaling. */
    public setOrbit(yawDegrees: number, pitchDegrees: number): CameraRigNode {
        this._yaw = this._clampYaw(yawDegrees);
        this._pitch = clamp(pitchDegrees, this.pitchMin, this.pitchMax);
        return this;
    }

    private _clampYaw(degrees: number): number {
        return isFinite(this.yawMin) || isFinite(this.yawMax)
            ? clamp(degrees, this.yawMin, this.yawMax)
            : wrapDegrees(degrees);
    }

    // --- shake -------------------------------------------------------------------------------------

    /** Adds trauma (0..1). Impulses stack but saturate, so a burst of hits cannot exceed a full shake. */
    public shake(amount: number): CameraRigNode {
        this._trauma = clamp(this._trauma + amount, 0, 1);
        return this;
    }

    public stopShake(): CameraRigNode {
        this._trauma = 0;
        this.shakeSustained = 0;
        return this;
    }

    public get trauma(): number { return this._trauma; }

    // --- introspection -----------------------------------------------------------------------------

    /** The damped world-space pivot. Live reference — clone it to keep it across frames. */
    public get pivotPosition(): vec3 { return this._pivot; }
    /** Arm length after collision pullback. */
    public get currentArmLength(): number { return this.armLength * this._armRatio; }

    /**
     * Kills damping for the next pass, so the camera teleports rather than flying across the level.
     * Call it after moving the follow target discontinuously.
     */
    public snapToTarget(): CameraRigNode {
        this._initialized = false;
        return this;
    }

    // --- camera child resolution ---------------------------------------------------------------------

    /** The CameraNode this rig drives, or null. */
    public get camera(): CameraNode | null {
        const cached = this._cameraChild;
        if (cached && cached.parent && !cached.markForRemoval && cached.isDescendantOf(this)) return cached;
        return (this._cameraChild = this._resolveCamera());
    }

    private _resolveCamera(): CameraNode | null {
        if (this.cameraNodeId) {
            const pinned = this._scene?.getNodeById(this.cameraNodeId);
            if (pinned instanceof CameraNode && pinned.isDescendantOf(this)) return pinned;
        }

        // Depth-first so a plain offset node may sit between the rig and its camera, but stopping at
        // the first camera on each branch so a camera nested under a camera does not confuse it.
        const found: CameraNode[] = [];
        const visit = (node: Node) => {
            for (const child of node.children) {
                if (child.name.startsWith('__editor__') || child.name.startsWith('__debug__')) continue;
                if (child instanceof CameraNode) { found.push(child); continue; }
                visit(child);
            }
        };
        visit(this);

        if (found.length === 0) return null;
        if (found.length > 1 && !this._warnedNoCamera)
            Logger.warn(`Camera rig '${this._name}' has ${found.length} camera children; driving the active one.`, 'Scene');
        return found.find(c => c.active) ?? found[0];
    }

    // --- reference resolution -------------------------------------------------------------------------

    private _resolveRef(id: string | null, cache: Node | null): Node | null {
        if (!id) return null;
        // `scene` is nulled on detach, which is how a despawned target is caught without a map lookup
        // on the common path.
        if (cache && cache.id === id && cache.scene && !cache.markForRemoval) return cache;
        return this._scene?.getNodeById(id) ?? null;
    }

    private _resolveFollow(): Node | null {
        return (this._followNode = this._resolveRef(this._followId, this._followNode));
    }

    private _resolveLookAt(): Node | null {
        return (this._lookAtNode = this._resolveRef(this._lookAtId, this._lookAtNode));
    }

    // --- the per-frame pass ----------------------------------------------------------------------------

    /**
     * Drives the camera child. Called by `Scene.update` AFTER every node's `onUpdate` has run and the
     * whole tree's transforms have been re-synced — a rig cannot do this work from its own `update()`,
     * because a follow target that sorts later in the traversal would not have moved yet and the rig
     * would trail it by a frame (visible as shimmer during fast movement).
     *
     * `snap` (editor-stopped or paused) makes every damper instant and skips collision and shake, so
     * the viewport previews the rig's resting pose live while its properties are being edited.
     */
    public lateUpdate(delta: number, snap: boolean): void {
        const cam = this.camera;
        if (!cam) {
            if (!this._warnedNoCamera) {
                Logger.warn(`Camera rig '${this._name}' has no CameraNode child; it will not drive anything.`, 'Scene');
                this._warnedNoCamera = true;
            }
            return;
        }
        this._warnedNoCamera = false;

        const dt = Math.max(0, delta);
        const rigid = snap || !this._initialized;

        this._updatePivot(dt, rigid);
        this._updateAim(dt, rigid);

        // The rig's world orientation; its local orientation is this relative to the parent.
        const worldRotation = quat.fromEuler(CameraRigNode._q0, this._pitch, this._yaw, 0);
        this._applyRigTransform(worldRotation);

        // Boom, in rig-local space, then rotated into the world for the collision probe.
        const boomLocal = boomOffset(CameraRigNode._v1, this.socketOffset, this.armLength);
        const boomWorld = vec3.transformQuat(CameraRigNode._v2, boomLocal, worldRotation);
        const boomDistance = vec3.length(boomWorld);

        this._updateCollision(dt, snap, boomWorld, boomDistance, worldRotation);

        cam.setPosition(vec3.scale(CameraRigNode._v3, boomLocal, this._armRatio));
        cam.setQuaternion(quat.identity(CameraRigNode._q1));

        // Recurses into the camera child, so its world cache is correct for the writes below. The
        // parent's own world transform is already fresh from the Scene's pre-pass.
        this.updateTransforms(this._parent ? this._parent.worldTransform : null);

        this._updateFov(cam, dt, rigid);
        this._writeCamera(cam, dt, snap);

        this._initialized = true;
    }

    private _updatePivot(dt: number, rigid: boolean): void {
        const target = this._resolveFollow();

        if (!target) {
            if (this._followId) {
                // Dangling: hold the last pivot rather than snapping to the origin. A target dying
                // mid-frame should park the camera where it was, which is what a death-cam wants.
                if (!this._warnedDanglingFollow) {
                    Logger.warn(`Camera rig '${this._name}' follows a node that no longer exists (${this._followId}); holding position.`, 'Scene');
                    this._warnedDanglingFollow = true;
                }
                if (!this._initialized) vec3.copy(this._pivot, this.worldPosition);
                return;
            }
            // No target set at all is a legitimate authoring state: the rig's own authored position
            // is the pivot, which makes a static orbit camera work with zero configuration.
            vec3.copy(this._pivot, this.worldPosition);
            return;
        }
        this._warnedDanglingFollow = false;

        const desired = vec3.copy(CameraRigNode._v0, target.worldPosition);
        const offset = CameraRigNode._v1;
        if (this.followSpace === 'world') {
            vec3.copy(offset, this.followOffset);
        } else if (this.followSpace === 'targetFull') {
            vec3.transformQuat(offset, this.followOffset, target.worldQuaternion);
        } else {
            // targetYaw: heading only, so the pivot does not tilt when the target pitches or rolls.
            const forward = target.worldForward;
            const yaw = Math.atan2(forward[0], forward[2]) * RAD2DEG;
            vec3.transformQuat(offset, this.followOffset, quat.fromEuler(CameraRigNode._q1, 0, yaw, 0));
        }
        vec3.add(desired, desired, offset);

        if (rigid) { vec3.copy(this._pivot, desired); return; }

        if (this.followDampingSpace === 'world') {
            dampVec3Time(this._pivot, this._pivot, desired, this.followDamping, dt);
            return;
        }

        // Rig space: damp the error in the rig's own yaw-aligned frame so "behind" and "sideways"
        // can lag differently, then bring it back to world.
        const toRig = quat.invert(CameraRigNode._q1, quat.fromEuler(CameraRigNode._q1, 0, this._yaw, 0));
        const currentLocal = vec3.transformQuat(CameraRigNode._v2, this._pivot, toRig);
        const desiredLocal = vec3.transformQuat(CameraRigNode._v3, desired, toRig);
        dampVec3Time(currentLocal, currentLocal, desiredLocal, this.followDamping, dt);
        vec3.transformQuat(this._pivot, currentLocal, quat.fromEuler(CameraRigNode._q1, 0, this._yaw, 0));
    }

    private _updateAim(dt: number, rigid: boolean): void {
        if (this.aimMode === 'lookAt') {
            const target = this._resolveLookAt();
            if (target) {
                this._warnedDanglingLookAt = false;
                // Aim from the PIVOT, not from the camera: aiming from the camera is circular, since
                // the camera's position depends on the very rotation being solved for. The camera sits
                // behind the pivot on the boom and so looks through it at the target.
                const focus = vec3.add(CameraRigNode._v0, target.worldPosition, this.lookAtOffset);
                const direction = vec3.subtract(CameraRigNode._v0, focus, this._pivot);
                const { yaw, pitch } = aimFromDirection(direction);
                // Written back into the same state orbit mode uses, so switching aimMode at runtime
                // never jumps.
                this._yaw = rigid ? yaw : dampAngleDeg(this._yaw, yaw, this.aimDamping, dt);
                this._pitch = rigid ? pitch : dampTime(this._pitch, pitch, this.aimDamping, dt);
            } else if (this._lookAtId && !this._warnedDanglingLookAt) {
                Logger.warn(`Camera rig '${this._name}' aims at a node that no longer exists (${this._lookAtId}); holding aim.`, 'Scene');
                this._warnedDanglingLookAt = true;
            }
        }
        // 'orbit' and 'none' leave _yaw/_pitch as the script (or the inspector) last set them.
        this._yaw = this._clampYaw(this._yaw);
        this._pitch = clamp(this._pitch, this.pitchMin, this.pitchMax);
    }

    private _applyRigTransform(worldRotation: quat): void {
        const parent = this._parent;

        if (parent) {
            const parentRotation = quat.invert(CameraRigNode._q1, parent.worldQuaternion);
            this.setQuaternion(quat.multiply(CameraRigNode._q1, parentRotation, worldRotation));
        } else {
            this.setQuaternion(worldRotation);
        }

        // With no follow target the rig's authored position IS the pivot, so writing it back would be
        // a no-op that also fights the transform gizmo.
        if (!this._followNode) return;

        if (parent && mat4.invert(CameraRigNode._m0, parent.worldTransform))
            this.setPosition(vec3.transformMat4(CameraRigNode._v0, this._pivot, CameraRigNode._m0));
        else
            this.setPosition(this._pivot);
    }

    private _updateCollision(dt: number, snap: boolean, boomWorld: vec3, boomDistance: number, worldRotation: quat): void {
        if (!this.collisionEnabled || snap || boomDistance < 1e-4) {
            this._armRatio = 1;
            return;
        }

        const direction = vec3.scale(CameraRigNode._probeDir, boomWorld, 1 / boomDistance);
        const hit = this._probe(direction, boomDistance, worldRotation);
        const target = collisionRatio(hit, boomDistance, this.collisionRadius, this.collisionMinRatio);

        // Fast in, slow out. Easing the pull-in would leave the camera inside the wall for several
        // frames, which reads as a rendering bug; easing the return stops it popping backwards the
        // instant a corner clears.
        this._armRatio = target < this._armRatio
            ? dampTime(this._armRatio, target, this.collisionPullTime, dt)
            : dampTime(this._armRatio, target, this.collisionReturnTime, dt);
    }

    /**
     * Nearest obstruction between the pivot and the camera, or null.
     *
     * Probes the PHYSICS world, not render geometry. Raycasting the meshes meant testing their
     * axis-aligned bounding boxes, which is hopeless for an imported asset carrying a rotation: a
     * 0.2-thick wall rotated 45 degrees measures 7.2 deep as an AABB, so the boom stopped ~3.6 units
     * short of the surface and registered phantom hits against empty corners. Collider shapes are
     * convex and exact, they are what the character already collides with, and cannon brings a
     * broadphase the engine otherwise lacks for rays. It also subsumes terrain, whose heightfield
     * body lives in the same world — hence no separate analytic terrain march here any more.
     *
     * Takes `worldRotation` rather than reading `this.worldQuaternion`: the rig's world cache is not
     * refreshed until step 8 of `lateUpdate`, so reading it here would offset the probe rays by the
     * PREVIOUS frame's orientation.
     *
     * Uses its own scratch vectors — `_v0.._v3` still hold the caller's boom, which is read again
     * after this returns.
     */
    private _probe(direction: vec3, distance: number, worldRotation: quat): number | null {
        const physics = this._scene?.physics;
        if (!physics) return null;

        // cannon has no sphere-cast, so approximate the probe sphere with four rays offset around
        // the centre one.
        const right = vec3.transformQuat(CameraRigNode._probeRight, vec3.set(CameraRigNode._probeRight, 1, 0, 0), worldRotation);
        const up = vec3.transformQuat(CameraRigNode._probeUp, vec3.set(CameraRigNode._probeUp, 0, 1, 0), worldRotation);
        const from = CameraRigNode._rayFrom;
        const to = CameraRigNode._rayTo;

        let nearest: number | null = null;
        for (let i = 0; i < 5; i++) {
            vec3.copy(from, this._pivot);
            if (i === 1) vec3.scaleAndAdd(from, from, right, this.collisionRadius);
            else if (i === 2) vec3.scaleAndAdd(from, from, right, -this.collisionRadius);
            else if (i === 3) vec3.scaleAndAdd(from, from, up, this.collisionRadius);
            else if (i === 4) vec3.scaleAndAdd(from, from, up, -this.collisionRadius);

            // A cannon ray is a segment, so the boom length goes into the endpoint.
            vec3.scaleAndAdd(to, from, direction, distance);

            const hit = physics.raycastCamera(from, to, this._rejectHit);
            if (hit !== null && (nearest === null || hit < nearest)) nearest = hit;
        }
        return nearest;
    }

    /**
     * Which bodies the probe must ignore, by owning node. Bound once (not per ray) so handing it to
     * the physics system allocates nothing per frame.
     *
     * The ancestor check is the load-bearing one: a rig is typically a CHILD of the character, and the
     * character is what carries the body, so the pivot sits inside its own capsule. Excluding only
     * descendants — which is all the old mesh-based path needed — would leave the probe hitting the
     * character on frame one and pinning the camera to its head.
     *
     * `owner` is null for bodies the engine did not create, notably the terrain heightfield; those are
     * kept, which is what lets terrain collide through this same path.
     */
    private readonly _rejectHit = (owner: Node | null): boolean => {
        if (!owner) return false;
        if (owner === this || owner.isDescendantOf(this) || this.isDescendantOf(owner)) return true;

        const follow = this._followNode;
        if (follow && (owner === follow || owner.isDescendantOf(follow))) return true;
        const lookAt = this._lookAtNode;
        if (lookAt && (owner === lookAt || owner.isDescendantOf(lookAt))) return true;

        for (const id of this.collisionIgnoreIds) {
            if (owner.id === id) return true;
            const ignored = this._scene?.getNodeById(id);
            if (ignored && owner.isDescendantOf(ignored)) return true;
        }
        return false;
    };

    private _updateFov(cam: CameraNode, dt: number, rigid: boolean): void {
        if (!this.fovEnabled || cam.camera.type !== 'perspective') return;
        this._currentFov = rigid ? this.fov : dampTime(this._currentFov, this.fov, this.fovDamping, dt);
        cam.camera.fov = this._currentFov;
    }

    /**
     * Writes the final view to the Camera, with shake applied as a pure post-offset.
     *
     * Shake never touches `_pivot`, `_yaw`, `_pitch`, `_armRatio` or the camera node's transform, so
     * it cannot feed back into a damper, and gameplay code reading `cameraNode.worldPosition` (to
     * spawn a projectile, say) still sees stable values. The Camera's setters copy, so handing it
     * scratch vectors is safe.
     */
    private _writeCamera(cam: CameraNode, dt: number, snap: boolean): void {
        const position = vec3.copy(CameraRigNode._v0, cam.worldPosition);
        const rotation = quat.copy(CameraRigNode._q0, cam.worldQuaternion);

        if (!snap) {
            this._shakeTime += dt;
            this._trauma = Math.max(0, this._trauma - this.shakeDecay * dt);
        }

        // Quadratic falloff: trauma decays linearly but reads as a smooth settle.
        const effective = snap ? 0 : clamp(this._trauma + this.shakeSustained, 0, 1);
        const strength = effective * effective;

        if (strength > 0) {
            const shake = shakeOffsets(
                CameraRigNode._shake, this._shakeTime, this._shakeSeed, this.shakeFrequency,
                strength, this.shakePositionAmplitude, this.shakeRotationAmplitude
            );
            vec3.transformQuat(CameraRigNode._v1, shake.position, rotation);
            vec3.add(position, position, CameraRigNode._v1);
            // Post-multiply so the shake is expressed in camera space, not world space.
            quat.multiply(rotation, rotation, quat.fromEuler(CameraRigNode._q1, shake.rotation[0], shake.rotation[1], shake.rotation[2]));
        }

        const camera = cam.camera;
        camera.position = position;
        camera.eye = vec3.add(CameraRigNode._v2, position,
            vec3.transformQuat(CameraRigNode._v2, vec3.set(CameraRigNode._v2, 0, 0, 1), rotation));
        // Camera.up is otherwise pinned to world +Y, which would make shake roll invisible. At rest
        // this resolves back to world +Y, matching a plain CameraNode exactly.
        camera.up = vec3.transformQuat(CameraRigNode._v3, vec3.set(CameraRigNode._v3, 0, 1, 0), rotation);
    }

    // --- serialization ------------------------------------------------------------------------------

    public serialize(): Promise<any> {
        return new Promise((resolve) => {
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    id: this._id,
                    name: this._name,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),

                    followId: this._followId,
                    lookAtId: this._lookAtId,
                    cameraNodeId: this.cameraNodeId,

                    followOffset: [...this.followOffset],
                    followSpace: this.followSpace,
                    followDamping: [...this.followDamping],
                    followDampingSpace: this.followDampingSpace,

                    aimMode: this.aimMode,
                    lookAtOffset: [...this.lookAtOffset],
                    aimDamping: this.aimDamping,
                    yaw: this._yaw,
                    pitch: this._pitch,
                    yawSensitivity: this.yawSensitivity,
                    pitchSensitivity: this.pitchSensitivity,
                    invertPitch: this.invertPitch,
                    // JSON has no Infinity; null round-trips through it as "unclamped".
                    yawMin: isFinite(this.yawMin) ? this.yawMin : null,
                    yawMax: isFinite(this.yawMax) ? this.yawMax : null,
                    pitchMin: this.pitchMin,
                    pitchMax: this.pitchMax,

                    armLength: this.armLength,
                    socketOffset: [...this.socketOffset],

                    fovEnabled: this.fovEnabled,
                    fov: this.fov,
                    fovDamping: this.fovDamping,

                    collisionEnabled: this.collisionEnabled,
                    collisionRadius: this.collisionRadius,
                    collisionMinRatio: this.collisionMinRatio,
                    collisionPullTime: this.collisionPullTime,
                    collisionReturnTime: this.collisionReturnTime,
                    collisionIgnoreIds: [...this.collisionIgnoreIds],

                    shakePositionAmplitude: [...this.shakePositionAmplitude],
                    shakeRotationAmplitude: [...this.shakeRotationAmplitude],
                    shakeFrequency: this.shakeFrequency,
                    shakeDecay: this.shakeDecay,
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new CameraRigNode(json.name, json.id);

        const num = (value: any, fallback: number) => typeof value === 'number' && isFinite(value) ? value : fallback;
        const bool = (value: any, fallback: boolean) => typeof value === 'boolean' ? value : fallback;
        const v3 = (out: vec3, value: any) => { if (Array.isArray(value) && value.length >= 3) vec3.set(out, +value[0], +value[1], +value[2]); };

        // Target ids are stored raw and resolved lazily: parse is depth-first over the JSON tree, so
        // the follow target very often does not exist yet at this point.
        node._followId = typeof json.followId === 'string' ? json.followId : null;
        node._lookAtId = typeof json.lookAtId === 'string' ? json.lookAtId : null;
        node.cameraNodeId = typeof json.cameraNodeId === 'string' ? json.cameraNodeId : null;

        v3(node.followOffset, json.followOffset);
        if (json.followSpace === 'world' || json.followSpace === 'targetYaw' || json.followSpace === 'targetFull')
            node.followSpace = json.followSpace;
        v3(node.followDamping, json.followDamping);
        if (json.followDampingSpace === 'world' || json.followDampingSpace === 'rig')
            node.followDampingSpace = json.followDampingSpace;

        if (json.aimMode === 'orbit' || json.aimMode === 'lookAt' || json.aimMode === 'none')
            node.aimMode = json.aimMode;
        v3(node.lookAtOffset, json.lookAtOffset);
        node.aimDamping = num(json.aimDamping, node.aimDamping);
        node.yawSensitivity = num(json.yawSensitivity, node.yawSensitivity);
        node.pitchSensitivity = num(json.pitchSensitivity, node.pitchSensitivity);
        node.invertPitch = bool(json.invertPitch, node.invertPitch);
        node.yawMin = typeof json.yawMin === 'number' ? json.yawMin : -Infinity;
        node.yawMax = typeof json.yawMax === 'number' ? json.yawMax : Infinity;
        node.pitchMin = num(json.pitchMin, node.pitchMin);
        node.pitchMax = num(json.pitchMax, node.pitchMax);
        node._yaw = num(json.yaw, node._yaw);
        node._pitch = num(json.pitch, node._pitch);

        node.armLength = num(json.armLength, node.armLength);
        v3(node.socketOffset, json.socketOffset);

        node.fovEnabled = bool(json.fovEnabled, node.fovEnabled);
        node.fov = num(json.fov, node.fov);
        node.fovDamping = num(json.fovDamping, node.fovDamping);
        node._currentFov = node.fov;

        node.collisionEnabled = bool(json.collisionEnabled, node.collisionEnabled);
        node.collisionRadius = num(json.collisionRadius, node.collisionRadius);
        node.collisionMinRatio = num(json.collisionMinRatio, node.collisionMinRatio);
        node.collisionPullTime = num(json.collisionPullTime, node.collisionPullTime);
        node.collisionReturnTime = num(json.collisionReturnTime, node.collisionReturnTime);
        node.collisionIgnoreIds = Array.isArray(json.collisionIgnoreIds)
            ? json.collisionIgnoreIds.filter((id: any) => typeof id === 'string') : [];

        v3(node.shakePositionAmplitude, json.shakePositionAmplitude);
        v3(node.shakeRotationAmplitude, json.shakeRotationAmplitude);
        node.shakeFrequency = num(json.shakeFrequency, node.shakeFrequency);
        node.shakeDecay = num(json.shakeDecay, node.shakeDecay);

        // _commonParse adds the node to its parent — do not addChild again.
        Node._commonParse(node, parent, json);
    }

    /** Inflated a little so the rig is easy to click in the viewport, like CameraNode. */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const radius = 0.35;
        return {
            min: vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius),
            max: vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius),
        };
    }
}

const TERRAIN_ATTRIBUTES = ['position', 'normal', 'uv', 'tangent', 'bitangent'];

/**
 * Scene node for a sculptable heightfield terrain. Owns a `Terrain` (heights + physics) and wraps each
 * of its render chunks in a child ModelNode. The chunk children are NOT serialized (they are rebuilt from
 * the compact terrain blob on load), so save/play stay small. Deforming the terrain (sculpt/import) flags
 * chunks dirty; `update()` re-uploads the affected chunk meshes to the GPU once they are initialized.
 */
export class LandscapeNode extends Node {
    private _terrain: Terrain;
    private _chunkNodes: ModelNode[] = [];

    constructor(name: string, terrain: Terrain, id: string = uuidv4()) {
        super(name, 'landscape', id);
        this._terrain = terrain;
        this._buildChunkNodes();
    }

    private _buildChunkNodes(): void {
        this._chunkNodes = [];
        for (let i = 0; i < this._terrain.chunks.length; i++) {
            const node = new ModelNode(`__terrain_chunk__${i}`, this._terrain.chunks[i].model);
            this._chunkNodes.push(node);
            this.addChild(node);
        }
    }

    public get terrain(): Terrain { return this._terrain; }

    /** Swap in a rebuilt terrain (e.g. resized/re-resolutioned) while keeping this node + its transform.
     *  Disposes the old physics body and replaces the internal chunk child nodes. */
    public setTerrain(terrain: Terrain): void {
        this._terrain.dispose();
        for (const c of this._chunkNodes) this.removeChild(c);
        this._chunkNodes = [];
        this._terrain = terrain;
        this._terrain.setOrigin(this.worldPosition);
        this._buildChunkNodes();
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        // Keep the terrain's origin in sync with the node so sculpting/collision follow the node.
        this._terrain.setOrigin(this.worldPosition);
        const chunks = this._terrain.chunks;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const node = this._chunkNodes[i];
            if (chunk.dirty && node && node.initialized) {
                chunk.model.mesh.updateVertexData(chunk.model.geometry.getData(TERRAIN_ATTRIBUTES));
                chunk.dirty = false;
            }
        }
    }

    /**
     * Pick each chunk's detail level for this camera position (called once per frame by the renderer,
     * before any pass, so the shadow maps draw the reduced terrain too). The coarse index buffers are
     * uploaded lazily on first use and re-built only when the configured vertex steps change; they index
     * the chunk's existing vertex buffer, so this never interferes with sculpting's vertex re-uploads.
     */
    public updateLod(camPos: vec3, settings: TerrainLodSettings): void {
        const chunks = this._terrain.chunks;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const node = this._chunkNodes[i];
            if (!node || !node.initialized) continue; // mesh not created yet: draws full-res this frame
            const mesh = chunk.model.mesh;

            if (!settings.enabled) {
                chunk.lod = 0;
                mesh.activeLod = 0;
                continue;
            }
            const steps = chunk.lodSteps;
            if (!steps || steps[0] !== settings.step1 || steps[1] !== settings.step2) {
                mesh.setLodIndices([
                    this._terrain.buildLodIndices(chunk, settings.step1),
                    this._terrain.buildLodIndices(chunk, settings.step2),
                ]);
                chunk.lodSteps = [settings.step1, settings.step2];
            }
            chunk.lod = this._terrain.lodFor(chunk, camPos, settings);
            mesh.activeLod = chunk.lod;
        }
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const half = this._terrain.size / 2;
        const heights = this._terrain.heights;
        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < heights.length; i++) {
            if (heights[i] < minY) minY = heights[i];
            if (heights[i] > maxY) maxY = heights[i];
        }
        if (!isFinite(minY)) { minY = 0; maxY = 0; }
        return {
            min: vec3.fromValues(p[0] - half, p[1] + minY - 0.1, p[2] - half),
            max: vec3.fromValues(p[0] + half, p[1] + maxY + 0.1, p[2] + half),
        };
    }

    public serialize(): Promise<any> {
        // Exclude the internal chunk children; they are rebuilt from the terrain blob on parse.
        const externalChildren = this._children.filter(c => !this._chunkNodes.includes(c as ModelNode));
        return new Promise((resolve) => {
            Promise.all(externalChildren.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children,
                    variables: this._serializeVariables(),
                    terrain: this._terrain.serialize(),
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const terrain = Terrain.deserialize(json.terrain);
        const node = new LandscapeNode(json.name, terrain, json.id);
        Node._commonParse(node, parent, json);
    }
}

export class LightNode extends Node {
    private readonly _light: Light
    private readonly _type: 'directional' | 'point' | 'spotlight';
    private _index: number;
    private _lightSpace: mat4;
    private _castShadows: boolean;
    // Reused scratch to avoid per-frame allocations in the lightSpace getter.
    private readonly _lightView: mat4 = mat4.create();
    private readonly _lightProjection: mat4 = mat4.create();
    private readonly _lightPos: vec3 = vec3.create();

    constructor(name: string, light: Light, castShadows: boolean = false, id: string = uuidv4()) {
        super(name, 'light', id);
        this._light = light;
        this._index = -1;
        this._lightSpace = mat4.create();
        this._castShadows = castShadows;

        if (light instanceof DirectionalLight)
            this._type = 'directional';
        else if (light instanceof PointLight)
            this._type = 'point';
        else if (light instanceof Spotlight)
            this._type = 'spotlight';
        else {
            const errMsg = "Light type not supported";
            Logger.error(errMsg)
            throw new Error(errMsg);
        }
    }

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            let lightData = {};
            switch (this._type) {
                case 'directional':
                    lightData = {
                        diffuse: [this._light.diffuse[0], this._light.diffuse[1], this._light.diffuse[2]],
                        specular: [this._light.specular[0], this._light.specular[1], this._light.specular[2]],
                        ambient: [this._light.ambient[0], this._light.ambient[1], this._light.ambient[2]],
                    };
                    break;
                case 'point':
                    lightData = {
                        diffuse: [this._light.diffuse[0], this._light.diffuse[1], this._light.diffuse[2]],
                        specular: [this._light.specular[0], this._light.specular[1], this._light.specular[2]],
                        ambient: [this._light.ambient[0], this._light.ambient[1], this._light.ambient[2]],
                        constant: (this._light as PointLight).constant,
                        linear: (this._light as PointLight).linear,
                        quadratic: (this._light as PointLight).quadratic
                    };
                    break;
                case 'spotlight':
                    lightData = {
                        diffuse: [this._light.diffuse[0], this._light.diffuse[1], this._light.diffuse[2]],
                        specular: [this._light.specular[0], this._light.specular[1], this._light.specular[2]],
                        ambient: [this._light.ambient[0], this._light.ambient[1], this._light.ambient[2]],
                        constant: (this._light as PointLight).constant,
                        linear: (this._light as Spotlight).linear,
                        quadratic: (this._light as Spotlight).quadratic,
                        cutOff: (this._light as Spotlight).cutOff,
                        outerCutOff: (this._light as Spotlight).outerCutOff
                    };
                    break;
            }
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    lightType: this._type,
                    light: lightData
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        let light;
        switch (json.lightType) {
            case 'directional':
                light = new DirectionalLight({
                    diffuse: json.light.diffuse,
                    specular: json.light.specular,
                    ambient: json.light.ambient,
                });
                break;
            case 'point':
                light = new PointLight({
                    diffuse: json.light.diffuse,
                    specular: json.light.specular,
                    ambient: json.light.ambient,
                    linear: json.light.linear,
                    quadratic: json.light.quadratic
                });
                break;
            case 'spotlight':
                light = new Spotlight({
                    diffuse: json.light.diffuse,
                    specular: json.light.specular,
                    ambient: json.light.ambient,
                    linear: json.light.linear,
                    quadratic: json.light.quadratic,
                    cutOff: json.light.cutOff,
                    outerCutOff: json.light.outerCutOff
                });
                break;
            default:
                const errMsg = `Light ${json} of type ${json.type} not supported`;
                Logger.error(errMsg);
                throw new Error(errMsg);
        }
        const node = new LightNode(json.name, light, json.lightType === 'directional' ? true : false, json.id);
        Node._commonParse(node, parent, json);
        
        parent.addChild(node);
    }

    public get light(): Light { return this._light; }
    public get type(): 'directional' | 'point' | 'spotlight' { return this._type; }
    public get index(): number { return this._index; }
    public set index(value: number) { this._index = value; }
    public get lightSpace(): mat4 {
        const lightPos = vec3.scale(this._lightPos, this.worldForward, -50);
        if (this._type === 'directional') {
            // TODO: Change look at position to be the center of where the camera is looking
            mat4.lookAt(this._lightView, lightPos, [0, 0, 0], [0, 1, 0]);
            mat4.ortho(this._lightProjection, -20, 20, -20, 20, 0.1, 100);
        }
        return mat4.multiply(this._lightSpace, this._lightProjection, this._lightView);
    }
    public get castShadows(): boolean { return this._castShadows; }
    public set castShadows(value: boolean) { this._castShadows = value; }

    /**
     * Get bounding box for LightNode - returns a sphere bounding box
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const scale = this.worldScale;
        
        // For lights, use a sphere bounding box
        // Use the largest scale component as the radius
        const radius = Math.max(scale[0], scale[1], scale[2]) * 0.5;
        
        const min = vec3.fromValues(
            position[0] - radius,
            position[1] - radius,
            position[2] - radius
        );
        const max = vec3.fromValues(
            position[0] + radius,
            position[1] + radius,
            position[2] + radius
        );
        
        return { min, max };
    }
}

/**
 * A light probe captures the surrounding scene into a cubemap and provides image-based lighting
 * (diffuse irradiance + prefiltered specular) for PBR. The actual capture/convolution is done by the
 * renderer (`Renderer.captureProbe`), which fills this node's baked maps. Two modes:
 *  - 'baked'    : captured once (on add, on load, or via the editor "Bake" button).
 *  - 'realtime' : re-captured every `updateFrequency` seconds for dynamic reflections.
 * The baked GPU cubemaps are not serialized (they'd lose HDR); instead the probe re-bakes on load.
 */
export class LightProbeNode extends Node {
    private _resolution: number;
    private _mode: 'baked' | 'realtime';
    private _updateFrequency: number; // seconds (realtime mode)
    private _intensity: number;
    // Influence volume: an oriented box (the node's transform applied to a unit cube scaled by _size,
    // full extents in world units at scale 1). [0,0,0] = unbounded — the probe affects the whole scene
    // (the legacy global behavior, and what pre-volume scenes deserialize to).
    private _size: [number, number, number];
    // Feather width in world units: IBL fades to zero over this distance inside the volume boundary.
    private _blendDistance: number;
    private _needsBake: boolean = true;
    private _lastBakeTime: number = 0;
    private _sourceCube: Texture | null = null;
    private _irradiance: Texture | null = null;
    private _prefiltered: Texture | null = null;
    private _volScratch: mat4 = mat4.create();
    private _invVolScratch: mat4 = mat4.create();
    private static _pointScratch: vec3 = vec3.create();

    constructor(
        name: string,
        options: { resolution?: number, mode?: 'baked' | 'realtime', updateFrequency?: number, intensity?: number, size?: [number, number, number], blendDistance?: number } = {},
        id: string = uuidv4()
    ) {
        super(name, 'lightProbe', id);
        this._resolution = options.resolution ?? 256;
        this._mode = options.mode ?? 'baked';
        this._updateFrequency = options.updateFrequency ?? 1;
        this._intensity = options.intensity ?? 1;
        this._size = options.size ? [options.size[0], options.size[1], options.size[2]] : [0, 0, 0];
        this._blendDistance = options.blendDistance ?? 1;
    }

    // --- Editor-facing properties (setting the ones that affect the capture flags a re-bake) ---
    public get resolution(): number { return this._resolution; }
    public set resolution(v: number) { const n = Math.max(16, Math.floor(v)); if (n !== this._resolution) { this._resolution = n; this._needsBake = true; } }
    public get mode(): 'baked' | 'realtime' { return this._mode; }
    public set mode(v: 'baked' | 'realtime') { this._mode = v; if (v === 'realtime') this._needsBake = true; }
    public get updateFrequency(): number { return this._updateFrequency; }
    public set updateFrequency(v: number) { this._updateFrequency = Math.max(0, v); }
    public get intensity(): number { return this._intensity; }
    public set intensity(v: number) { this._intensity = Math.max(0, v); }
    // Volume setters do NOT flag a re-bake: the volume only governs where the probe applies, not what it captured.
    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) { this._size = [Math.max(0, v[0]), Math.max(0, v[1]), Math.max(0, v[2])]; }
    public get blendDistance(): number { return this._blendDistance; }
    public set blendDistance(v: number) { this._blendDistance = Math.max(0, v); }

    // --- Influence volume ---
    /** True when the probe has a finite influence box; false = unbounded (affects the whole scene). */
    public get bounded(): boolean { return this._size[0] > 0 && this._size[1] > 0 && this._size[2] > 0; }

    /** world -> probe-volume unit cube (containment = |xyz| <= 0.5). Only meaningful when bounded. */
    public get invVolumeMatrix(): mat4 {
        mat4.scale(this._volScratch, this.worldTransform, [this._size[0], this._size[1], this._size[2]]);
        mat4.invert(this._invVolScratch, this._volScratch);
        return this._invVolScratch;
    }

    /** Per-axis feather as a fraction of the unit cube (blendDistance / world size, capped at 0.5).
     *  Uploaded alongside invVolumeMatrix so the shader can smoothstep the boundary. */
    public get volumeBlend(): [number, number, number] {
        const ws = this.worldScale;
        const out: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const worldSize = Math.abs(this._size[i] * ws[i]);
            out[i] = worldSize > 0 ? Math.min(0.5, this._blendDistance / worldSize) : 0;
        }
        return out;
    }

    /**
     * Feathered containment weight of a world-space point: 1 well inside the volume, easing to 0 at
     * the boundary (over blendDistance), 0 outside. Unbounded probes weigh 1 everywhere.
     */
    public probeWeight(p: vec3): number {
        if (!this.bounded) return 1;
        const local = vec3.transformMat4(LightProbeNode._pointScratch, p, this.invVolumeMatrix);
        const blend = this.volumeBlend;
        let w = 1;
        for (let i = 0; i < 3; i++) {
            const edge = 0.5 - Math.abs(local[i]); // distance to the boundary in unit-cube space
            if (edge <= 0) return 0;
            if (blend[i] > 0) {
                const t = Math.min(1, edge / blend[i]);
                w = Math.min(w, t * t * (3 - 2 * t)); // smoothstep
            }
        }
        return w;
    }

    // --- Renderer-facing baking state ---
    public get needsBake(): boolean { return this._needsBake; }
    public get lastBakeTime(): number { return this._lastBakeTime; }
    public get hasBakedMaps(): boolean { return this._irradiance !== null && this._prefiltered !== null; }
    public get irradiance(): Texture | null { return this._irradiance; }
    public get prefiltered(): Texture | null { return this._prefiltered; }
    /** The sharp, full-resolution scene capture (linear HDR) — best for clear/mirror-like reflections. */
    public get envMap(): Texture | null { return this._sourceCube; }
    /** Request a (re)capture on the next frame — used by the editor "Bake" button. */
    public bake(): void { this._needsBake = true; }
    public markBaked(time: number): void { this._needsBake = false; this._lastBakeTime = time; }
    public setBakedMaps(source: Texture, irradiance: Texture, prefiltered: Texture): void {
        this._sourceCube?.delete();
        this._irradiance?.delete();
        this._prefiltered?.delete();
        this._sourceCube = source;
        this._irradiance = irradiance;
        this._prefiltered = prefiltered;
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        if (this.bounded) {
            // World AABB of the oriented influence box, so the editor's selection box shows the volume.
            const world = mat4.scale(this._volScratch, this.worldTransform, [this._size[0], this._size[1], this._size[2]]);
            const min = vec3.fromValues(Infinity, Infinity, Infinity);
            const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
            const corner = LightProbeNode._pointScratch;
            for (let i = 0; i < 8; i++) {
                vec3.set(corner, (i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5);
                vec3.transformMat4(corner, corner, world);
                vec3.min(min, min, corner);
                vec3.max(max, max, corner);
            }
            return { min, max };
        }
        const position = this.worldPosition;
        const scale = this.worldScale;
        const radius = Math.max(scale[0], scale[1], scale[2]) * 0.5;
        const min = vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius);
        const max = vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius);
        return { min, max };
    }

    public serialize(): Promise<any> {
        return new Promise((resolve) => {
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    resolution: this._resolution,
                    mode: this._mode,
                    updateFrequency: this._updateFrequency,
                    intensity: this._intensity,
                    size: [this._size[0], this._size[1], this._size[2]],
                    blendDistance: this._blendDistance
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new LightProbeNode(json.name, {
            resolution: json.resolution,
            mode: json.mode,
            updateFrequency: json.updateFrequency,
            intensity: json.intensity,
            size: json.size,           // absent in pre-volume scenes -> [0,0,0] = unbounded (legacy)
            blendDistance: json.blendDistance
        }, json.id);
        Node._commonParse(node, parent, json);
        parent.addChild(node);
    }
}

export class SkyboxNode extends Node {
    private readonly _skybox: Skybox
    private _initialized: boolean;

    constructor(name: string, skybox: Skybox, id: string = uuidv4()) {
        super(name, 'skybox', id);
        this._skybox = skybox;
        this._initialized = false;
    }

    public initializeSkybox(): void {
        this._skybox.mesh.initializeVAO(ShaderManager.Instance.getShader('skybox').attributes);
        this._skybox.mesh.create(this._skybox.box.getData(['position']), this._skybox.box.indices.length, this._skybox.box.indices);
        this._initialized = true;
    }

    public static parse(parent: Node, json: any) {
        Skybox.fromBase64({
            posX: json.skybox.faces.positiveX,
            negX: json.skybox.faces.negativeX,
            posY: json.skybox.faces.positiveY,
            negY: json.skybox.faces.negativeY,
            posZ: json.skybox.faces.positiveZ,
            negZ: json.skybox.faces.negativeZ
        }).then(skybox => {
            const node = new SkyboxNode(json.name, skybox, json.id);
            Node._commonParse(node, parent, json);
            parent.addChild(node);
        });
    }

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            const skybox = this._skybox.serialize()
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    skybox: skybox
                });
            });
        });
    }

    public get skybox(): Skybox { return this._skybox; }
    public get initialized(): boolean { return this._initialized; }

    /**
     * Get bounding box for SkyboxNode - returns a large sphere bounding box
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        // Skybox is typically very large, use a large bounding box
        const radius = 1000; // Large radius for skybox
        
        const min = vec3.fromValues(
            position[0] - radius,
            position[1] - radius,
            position[2] - radius
        );
        const max = vec3.fromValues(
            position[0] + radius,
            position[1] + radius,
            position[2] + radius
        );
        
        return { min, max };
    }
}

/** Config for a VolumetricCloudsNode. Every field is optional so freshly-created nodes and old
 *  saves both fall back to the defaults below (a mid-coverage cumulus layer). */
export interface VolumetricCloudsOptions {
    // Shape
    coverage?: number;        // 0..1 — how much of the sky is filled
    density?: number;         // overall opacity multiplier
    cloudType?: number;       // 0..1 — stratus (flat) -> cumulus -> cumulonimbus (towering)
    baseAltitude?: number;    // world units — bottom of the cloud slab
    thickness?: number;       // world units — slab height
    baseScale?: number;       // low-frequency shape noise frequency
    detailScale?: number;     // high-frequency erosion noise frequency
    detailStrength?: number;  // 0..1 — how much detail erodes the base shape
    curlStrength?: number;    // domain-warp turbulence for wispy edges
    anvilBias?: number;       // 0..1 — spreads cloud tops outward (cumulonimbus anvil)
    // Lighting
    useSceneSun?: boolean;    // true = take direction/color from the scene directional light
    sunDirection?: [number, number, number]; // override travel direction (used when useSceneSun=false)
    sunColor?: [number, number, number];
    sunIntensity?: number;
    ambientColor?: [number, number, number];  // sky-side ambient
    ambientIntensity?: number;
    groundColor?: [number, number, number];    // ground bounce tint on cloud bottoms
    sunsetColor?: [number, number, number];    // sunrise/sunset glow: tints sun/ambient/ground while the sun crosses the horizon
    phaseG?: number;          // 0..1 — Henyey-Greenstein forward-scatter anisotropy
    silverIntensity?: number; // silver-lining boost near the sun
    silverSpread?: number;    // silver-lining angular spread
    powderStrength?: number;  // 0..1 — dark-edge (powder) effect
    absorption?: number;      // Beer's-law extinction coefficient
    // Animation
    windDirection?: [number, number, number]; // x/z used; drifts the cloud field over time
    windSpeed?: number;
    detailWindFactor?: number; // detail layer drifts faster than the base by this factor
    // Quality
    steps?: number;           // primary raymarch samples (16..192)
    lightSteps?: number;      // secondary (toward-sun) samples (2..12)
    maxDistance?: number;     // max ray length
    jitter?: boolean;         // dither the march start to hide banding
    // Render
    enabled?: boolean;
    opacity?: number;         // 0..1 — final composite opacity
}

/**
 * Scene-wide volumetric cloud layer. Holds only configuration (no GPU resources) — the Renderer
 * discovers it as a singleton off the Scene (like the skybox) and runs a single fullscreen
 * raymarch pass, so all of these values are plain serializable getters/setters driven by the editor.
 */
export class VolumetricCloudsNode extends Node {
    // Shape
    private _coverage: number;
    private _density: number;
    private _cloudType: number;
    private _baseAltitude: number;
    private _thickness: number;
    private _baseScale: number;
    private _detailScale: number;
    private _detailStrength: number;
    private _curlStrength: number;
    private _anvilBias: number;
    // Lighting
    private _useSceneSun: boolean;
    private _sunDirection: [number, number, number];
    private _sunColor: [number, number, number];
    private _sunIntensity: number;
    private _ambientColor: [number, number, number];
    private _ambientIntensity: number;
    private _groundColor: [number, number, number];
    private _sunsetColor: [number, number, number];
    private _phaseG: number;
    private _silverIntensity: number;
    private _silverSpread: number;
    private _powderStrength: number;
    private _absorption: number;
    // Animation
    private _windDirection: [number, number, number];
    private _windSpeed: number;
    private _detailWindFactor: number;
    // Quality
    private _steps: number;
    private _lightSteps: number;
    private _maxDistance: number;
    private _jitter: boolean;
    // Render
    private _enabled: boolean;
    private _opacity: number;

    constructor(name: string, options: VolumetricCloudsOptions = {}, id: string = uuidv4()) {
        super(name, 'volumetricClouds', id);
        this._coverage = options.coverage ?? 0.5;
        this._density = options.density ?? 1.0;
        this._cloudType = options.cloudType ?? 0.5;
        this._baseAltitude = options.baseAltitude ?? 800;
        this._thickness = options.thickness ?? 700;
        this._baseScale = options.baseScale ?? 0.0004;
        this._detailScale = options.detailScale ?? 0.003;
        this._detailStrength = options.detailStrength ?? 0.35;
        this._curlStrength = options.curlStrength ?? 0.4;
        this._anvilBias = options.anvilBias ?? 0.0;

        this._useSceneSun = options.useSceneSun ?? true;
        this._sunDirection = options.sunDirection ?? [-0.5, -0.8, -0.35];
        this._sunColor = options.sunColor ?? [1.0, 0.95, 0.85];
        this._sunIntensity = options.sunIntensity ?? 10.0;
        this._ambientColor = options.ambientColor ?? [0.55, 0.65, 0.8];
        this._ambientIntensity = options.ambientIntensity ?? 1.0;
        this._groundColor = options.groundColor ?? [0.4, 0.4, 0.42];
        this._sunsetColor = options.sunsetColor ?? [1.0, 0.38, 0.16];
        this._phaseG = options.phaseG ?? 0.5;
        this._silverIntensity = options.silverIntensity ?? 0.6;
        this._silverSpread = options.silverSpread ?? 0.08;
        this._powderStrength = options.powderStrength ?? 0.5;
        this._absorption = options.absorption ?? 1.0;

        this._windDirection = options.windDirection ?? [1.0, 0.0, 0.2];
        this._windSpeed = options.windSpeed ?? 12.0;
        this._detailWindFactor = options.detailWindFactor ?? 2.0;

        this._steps = options.steps ?? 48;
        this._lightSteps = options.lightSteps ?? 6;
        this._maxDistance = options.maxDistance ?? 60000;
        this._jitter = options.jitter ?? true;

        this._enabled = options.enabled ?? true;
        this._opacity = options.opacity ?? 1.0;
    }

    // --- Shape ---
    public get coverage(): number { return this._coverage; }
    public set coverage(v: number) { this._coverage = Math.min(1, Math.max(0, v)); }
    public get density(): number { return this._density; }
    public set density(v: number) { this._density = Math.max(0, v); }
    public get cloudType(): number { return this._cloudType; }
    public set cloudType(v: number) { this._cloudType = Math.min(1, Math.max(0, v)); }
    public get baseAltitude(): number { return this._baseAltitude; }
    public set baseAltitude(v: number) { this._baseAltitude = v; }
    public get thickness(): number { return this._thickness; }
    public set thickness(v: number) { this._thickness = Math.max(1, v); }
    public get baseScale(): number { return this._baseScale; }
    public set baseScale(v: number) { this._baseScale = Math.max(0.00001, v); }
    public get detailScale(): number { return this._detailScale; }
    public set detailScale(v: number) { this._detailScale = Math.max(0.00001, v); }
    public get detailStrength(): number { return this._detailStrength; }
    public set detailStrength(v: number) { this._detailStrength = Math.min(1, Math.max(0, v)); }
    public get curlStrength(): number { return this._curlStrength; }
    public set curlStrength(v: number) { this._curlStrength = Math.max(0, v); }
    public get anvilBias(): number { return this._anvilBias; }
    public set anvilBias(v: number) { this._anvilBias = Math.min(1, Math.max(0, v)); }

    // --- Lighting ---
    public get useSceneSun(): boolean { return this._useSceneSun; }
    public set useSceneSun(v: boolean) { this._useSceneSun = v; }
    public get sunDirection(): [number, number, number] { return this._sunDirection; }
    public set sunDirection(v: [number, number, number]) { this._sunDirection = v; }
    public get sunColor(): [number, number, number] { return this._sunColor; }
    public set sunColor(v: [number, number, number]) { this._sunColor = v; }
    public get sunIntensity(): number { return this._sunIntensity; }
    public set sunIntensity(v: number) { this._sunIntensity = Math.max(0, v); }
    public get ambientColor(): [number, number, number] { return this._ambientColor; }
    public set ambientColor(v: [number, number, number]) { this._ambientColor = v; }
    public get ambientIntensity(): number { return this._ambientIntensity; }
    public set ambientIntensity(v: number) { this._ambientIntensity = Math.max(0, v); }
    public get groundColor(): [number, number, number] { return this._groundColor; }
    public set groundColor(v: [number, number, number]) { this._groundColor = v; }
    public get sunsetColor(): [number, number, number] { return this._sunsetColor; }
    public set sunsetColor(v: [number, number, number]) { this._sunsetColor = v; }
    public get phaseG(): number { return this._phaseG; }
    public set phaseG(v: number) { this._phaseG = Math.min(0.999, Math.max(0, v)); }
    public get silverIntensity(): number { return this._silverIntensity; }
    public set silverIntensity(v: number) { this._silverIntensity = Math.max(0, v); }
    public get silverSpread(): number { return this._silverSpread; }
    public set silverSpread(v: number) { this._silverSpread = Math.max(0.001, v); }
    public get powderStrength(): number { return this._powderStrength; }
    public set powderStrength(v: number) { this._powderStrength = Math.min(1, Math.max(0, v)); }
    public get absorption(): number { return this._absorption; }
    public set absorption(v: number) { this._absorption = Math.max(0, v); }

    // --- Animation ---
    public get windDirection(): [number, number, number] { return this._windDirection; }
    public set windDirection(v: [number, number, number]) { this._windDirection = v; }
    public get windSpeed(): number { return this._windSpeed; }
    public set windSpeed(v: number) { this._windSpeed = v; }
    public get detailWindFactor(): number { return this._detailWindFactor; }
    public set detailWindFactor(v: number) { this._detailWindFactor = v; }

    // --- Quality ---
    public get steps(): number { return this._steps; }
    public set steps(v: number) { this._steps = Math.min(192, Math.max(16, Math.floor(v))); }
    public get lightSteps(): number { return this._lightSteps; }
    public set lightSteps(v: number) { this._lightSteps = Math.min(12, Math.max(2, Math.floor(v))); }
    public get maxDistance(): number { return this._maxDistance; }
    public set maxDistance(v: number) { this._maxDistance = Math.max(1, v); }
    public get jitter(): boolean { return this._jitter; }
    public set jitter(v: boolean) { this._jitter = v; }

    // --- Render ---
    public get enabled(): boolean { return this._enabled; }
    public set enabled(v: boolean) { this._enabled = v; }
    public get opacity(): number { return this._opacity; }
    public set opacity(v: number) { this._opacity = Math.min(1, Math.max(0, v)); }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const radius = 1000;
        const min = vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius);
        const max = vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius);
        return { min, max };
    }

    public serialize(): Promise<any> {
        return new Promise((resolve) => {
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    clouds: {
                        coverage: this._coverage,
                        density: this._density,
                        cloudType: this._cloudType,
                        baseAltitude: this._baseAltitude,
                        thickness: this._thickness,
                        baseScale: this._baseScale,
                        detailScale: this._detailScale,
                        detailStrength: this._detailStrength,
                        curlStrength: this._curlStrength,
                        anvilBias: this._anvilBias,
                        useSceneSun: this._useSceneSun,
                        sunDirection: this._sunDirection,
                        sunColor: this._sunColor,
                        sunIntensity: this._sunIntensity,
                        ambientColor: this._ambientColor,
                        ambientIntensity: this._ambientIntensity,
                        groundColor: this._groundColor,
                        sunsetColor: this._sunsetColor,
                        phaseG: this._phaseG,
                        silverIntensity: this._silverIntensity,
                        silverSpread: this._silverSpread,
                        powderStrength: this._powderStrength,
                        absorption: this._absorption,
                        windDirection: this._windDirection,
                        windSpeed: this._windSpeed,
                        detailWindFactor: this._detailWindFactor,
                        steps: this._steps,
                        lightSteps: this._lightSteps,
                        maxDistance: this._maxDistance,
                        jitter: this._jitter,
                        enabled: this._enabled,
                        opacity: this._opacity
                    }
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new VolumetricCloudsNode(json.name, json.clouds ?? {}, json.id);
        Node._commonParse(node, parent, json);
        parent.addChild(node);
    }
}

/** Config for a SkyAtmosphereNode. Every field is optional so freshly-created nodes and old saves
 *  both fall back to Earth-like defaults (a clear midday blue sky). */
export interface SkyAtmosphereOptions {
    // Sun
    useSceneSun?: boolean;                      // true = take direction/color from the scene directional light
    sunDirection?: [number, number, number];    // override: direction TOWARD the sun (used when useSceneSun=false / no light)
    sunColor?: [number, number, number];
    sunIntensity?: number;
    // Atmosphere
    rayleighScatter?: number;   // multiplier on the Earth Rayleigh coefficients
    rayleighHeight?: number;    // Rayleigh scale height (m)
    mieScatter?: number;        // multiplier on the Mie coefficient
    mieHeight?: number;         // Mie scale height (m)
    mieG?: number;              // Mie anisotropy (forward scattering)
    planetRadius?: number;      // m
    atmosphereRadius?: number;  // m
    sunDiskSize?: number;       // angular radius of the sun disk (degrees)
    exposure?: number;
    groundColor?: [number, number, number]; // tint for below-horizon (downward) directions
    // Quality
    resolution?: number;        // cubemap face size
    viewSteps?: number;         // primary raymarch samples
    lightSteps?: number;        // secondary (toward-sun) samples
    // Fog (distance fog whose color is sampled from the atmosphere cubemap — aerial perspective)
    fogEnabled?: boolean;
    fogDensity?: number;        // exponential density (per world unit)
    fogStart?: number;          // distance before fog begins (world units)
    fogHeight?: number;         // world Y where fog is densest (height fog)
    fogHeightFalloff?: number;  // how quickly fog thins with altitude (0 = uniform, no height dependence)
    fogMaxOpacity?: number;     // 0..1 cap so distant geometry never fully disappears
    fogColor?: [number, number, number]; // custom tint, blended with the atmosphere color
    fogColorBlend?: number;     // 0 = pure atmosphere color, 1 = pure custom fogColor
    // God rays (volumetric light shafts from the scene directional light — a raymarched post pass
    // that tests the sun's shadow map along each view ray). Legacy radial-blur keys (godRayWeight,
    // godRayDecay, godRayThreshold, godRaySunSpread) are ignored when parsing old scenes.
    godRaysEnabled?: boolean;
    godRaySamples?: number;      // raymarch steps per pixel (quality/cost)
    godRayDensity?: number;      // 0..1 — scattering density of the participating medium
    godRayExposure?: number;     // overall shaft intensity
    godRayTint?: [number, number, number]; // multiply tint on the shafts
    godRayAnisotropy?: number;   // 0..0.95 — Henyey-Greenstein g: higher = light hugs the sun direction
    godRayMaxDistance?: number;  // world units — how far from the camera the march extends
}

/**
 * Scene-wide physically-based sky. Holds only parameters (plus a runtime cubemap that is NOT
 * serialized). The Renderer discovers it as a singleton off the Scene (like the skybox), bakes a
 * Nishita single-scattering atmosphere into a cubemap whenever the directional light changes
 * direction, and draws that cubemap as the sky background. Mutually exclusive with SkyboxNode
 * (the editor enforces one-at-a-time).
 */
export class SkyAtmosphereNode extends Node {
    // Sun
    private _useSceneSun: boolean;
    private _sunDirection: [number, number, number];
    private _sunColor: [number, number, number];
    private _sunIntensity: number;
    // Atmosphere
    private _rayleighScatter: number;
    private _rayleighHeight: number;
    private _mieScatter: number;
    private _mieHeight: number;
    private _mieG: number;
    private _planetRadius: number;
    private _atmosphereRadius: number;
    private _sunDiskSize: number;
    private _exposure: number;
    private _groundColor: [number, number, number];
    // Quality
    private _resolution: number;
    private _viewSteps: number;
    private _lightSteps: number;
    // Fog (applied per-frame in a screen-space pass; changing these does NOT require a cubemap re-bake)
    private _fogEnabled: boolean;
    private _fogDensity: number;
    private _fogStart: number;
    private _fogHeight: number;
    private _fogHeightFalloff: number;
    private _fogMaxOpacity: number;
    private _fogColor: [number, number, number];
    private _fogColorBlend: number;
    // God rays (per-frame screen-space post pass; changing these does NOT require a cubemap re-bake)
    private _godRaysEnabled: boolean;
    private _godRaySamples: number;
    private _godRayDensity: number;
    private _godRayExposure: number;
    private _godRayTint: [number, number, number];
    private _godRayAnisotropy: number;
    private _godRayMaxDistance: number;
    // Runtime bake state (not serialized)
    private _cubemap: Texture | null = null;
    private _cubemapResolution: number = 0;
    private _needsBake: boolean = true;
    private _lastSunDir: [number, number, number] = [0, -1, 0];

    constructor(name: string, options: SkyAtmosphereOptions = {}, id: string = uuidv4()) {
        super(name, 'skyAtmosphere', id);
        this._useSceneSun = options.useSceneSun ?? true;
        this._sunDirection = options.sunDirection ?? [0.0, 0.35, -0.94];
        this._sunColor = options.sunColor ?? [1.0, 1.0, 1.0];
        this._sunIntensity = options.sunIntensity ?? 22.0;

        this._rayleighScatter = options.rayleighScatter ?? 1.0;
        this._rayleighHeight = options.rayleighHeight ?? 8000.0;
        this._mieScatter = options.mieScatter ?? 1.0;
        this._mieHeight = options.mieHeight ?? 1200.0;
        this._mieG = options.mieG ?? 0.76;
        this._planetRadius = options.planetRadius ?? 6371000.0;
        this._atmosphereRadius = options.atmosphereRadius ?? 6471000.0;
        this._sunDiskSize = options.sunDiskSize ?? 1.5;
        this._exposure = options.exposure ?? 1.3;
        this._groundColor = options.groundColor ?? [0.25, 0.22, 0.2];

        this._resolution = options.resolution ?? 256;
        this._viewSteps = options.viewSteps ?? 16;
        this._lightSteps = options.lightSteps ?? 8;

        this._fogEnabled = options.fogEnabled ?? false; // opt-in: adding a sky shouldn't fog the scene
        this._fogDensity = options.fogDensity ?? 0.0008;
        this._fogStart = options.fogStart ?? 20.0;
        this._fogHeight = options.fogHeight ?? 0.0;
        this._fogHeightFalloff = options.fogHeightFalloff ?? 0.0;
        this._fogMaxOpacity = options.fogMaxOpacity ?? 0.7; // keep objects readable (never fully sky)
        this._fogColor = options.fogColor ?? [0.7, 0.8, 0.9];
        this._fogColorBlend = options.fogColorBlend ?? 0.0;

        this._godRaysEnabled = options.godRaysEnabled ?? false; // opt-in
        this._godRaySamples = options.godRaySamples ?? 64;
        this._godRayDensity = options.godRayDensity ?? 0.9;
        this._godRayExposure = options.godRayExposure ?? 0.3;
        this._godRayTint = options.godRayTint ?? [1.0, 1.0, 1.0];
        this._godRayAnisotropy = options.godRayAnisotropy ?? 0.6;
        this._godRayMaxDistance = options.godRayMaxDistance ?? 80;
    }

    // --- Sun ---
    public get useSceneSun(): boolean { return this._useSceneSun; }
    public set useSceneSun(v: boolean) { this._useSceneSun = v; this._needsBake = true; }
    public get sunDirection(): [number, number, number] { return this._sunDirection; }
    public set sunDirection(v: [number, number, number]) { this._sunDirection = v; this._needsBake = true; }
    public get sunColor(): [number, number, number] { return this._sunColor; }
    public set sunColor(v: [number, number, number]) { this._sunColor = v; this._needsBake = true; }
    public get sunIntensity(): number { return this._sunIntensity; }
    public set sunIntensity(v: number) { this._sunIntensity = Math.max(0, v); this._needsBake = true; }

    // --- Atmosphere ---
    public get rayleighScatter(): number { return this._rayleighScatter; }
    public set rayleighScatter(v: number) { this._rayleighScatter = Math.max(0, v); this._needsBake = true; }
    public get rayleighHeight(): number { return this._rayleighHeight; }
    public set rayleighHeight(v: number) { this._rayleighHeight = Math.max(1, v); this._needsBake = true; }
    public get mieScatter(): number { return this._mieScatter; }
    public set mieScatter(v: number) { this._mieScatter = Math.max(0, v); this._needsBake = true; }
    public get mieHeight(): number { return this._mieHeight; }
    public set mieHeight(v: number) { this._mieHeight = Math.max(1, v); this._needsBake = true; }
    public get mieG(): number { return this._mieG; }
    public set mieG(v: number) { this._mieG = Math.min(0.99, Math.max(-0.99, v)); this._needsBake = true; }
    public get planetRadius(): number { return this._planetRadius; }
    public set planetRadius(v: number) { this._planetRadius = Math.max(1, v); this._needsBake = true; }
    public get atmosphereRadius(): number { return this._atmosphereRadius; }
    public set atmosphereRadius(v: number) { this._atmosphereRadius = Math.max(1, v); this._needsBake = true; }
    public get sunDiskSize(): number { return this._sunDiskSize; }
    public set sunDiskSize(v: number) { this._sunDiskSize = Math.max(0, v); this._needsBake = true; }
    public get exposure(): number { return this._exposure; }
    public set exposure(v: number) { this._exposure = Math.max(0, v); this._needsBake = true; }
    public get groundColor(): [number, number, number] { return this._groundColor; }
    public set groundColor(v: [number, number, number]) { this._groundColor = v; this._needsBake = true; }

    // --- Quality ---
    public get resolution(): number { return this._resolution; }
    public set resolution(v: number) { const n = Math.min(1024, Math.max(16, Math.floor(v))); if (n !== this._resolution) { this._resolution = n; this._needsBake = true; } }
    public get viewSteps(): number { return this._viewSteps; }
    public set viewSteps(v: number) { this._viewSteps = Math.min(64, Math.max(4, Math.floor(v))); this._needsBake = true; }
    public get lightSteps(): number { return this._lightSteps; }
    public set lightSteps(v: number) { this._lightSteps = Math.min(32, Math.max(2, Math.floor(v))); this._needsBake = true; }

    // --- Fog (per-frame screen pass; setters do NOT flip needsBake — no cubemap re-bake needed) ---
    public get fogEnabled(): boolean { return this._fogEnabled; }
    public set fogEnabled(v: boolean) { this._fogEnabled = v; }
    public get fogDensity(): number { return this._fogDensity; }
    public set fogDensity(v: number) { this._fogDensity = Math.max(0, v); }
    public get fogStart(): number { return this._fogStart; }
    public set fogStart(v: number) { this._fogStart = Math.max(0, v); }
    public get fogHeight(): number { return this._fogHeight; }
    public set fogHeight(v: number) { this._fogHeight = v; }
    public get fogHeightFalloff(): number { return this._fogHeightFalloff; }
    public set fogHeightFalloff(v: number) { this._fogHeightFalloff = Math.max(0, v); }
    public get fogMaxOpacity(): number { return this._fogMaxOpacity; }
    public set fogMaxOpacity(v: number) { this._fogMaxOpacity = Math.min(1, Math.max(0, v)); }
    public get fogColor(): [number, number, number] { return this._fogColor; }
    public set fogColor(v: [number, number, number]) { this._fogColor = v; }
    public get fogColorBlend(): number { return this._fogColorBlend; }
    public set fogColorBlend(v: number) { this._fogColorBlend = Math.min(1, Math.max(0, v)); }

    // --- God rays (per-frame screen pass; setters do NOT flip needsBake) ---
    public get godRaysEnabled(): boolean { return this._godRaysEnabled; }
    public set godRaysEnabled(v: boolean) { this._godRaysEnabled = v; }
    public get godRaySamples(): number { return this._godRaySamples; }
    public set godRaySamples(v: number) { this._godRaySamples = Math.min(128, Math.max(8, Math.floor(v))); }
    public get godRayDensity(): number { return this._godRayDensity; }
    public set godRayDensity(v: number) { this._godRayDensity = Math.min(1, Math.max(0, v)); }
    public get godRayExposure(): number { return this._godRayExposure; }
    public set godRayExposure(v: number) { this._godRayExposure = Math.max(0, v); }
    public get godRayTint(): [number, number, number] { return this._godRayTint; }
    public set godRayTint(v: [number, number, number]) { this._godRayTint = v; }
    public get godRayAnisotropy(): number { return this._godRayAnisotropy; }
    public set godRayAnisotropy(v: number) { this._godRayAnisotropy = Math.min(0.95, Math.max(0, v)); }
    public get godRayMaxDistance(): number { return this._godRayMaxDistance; }
    public set godRayMaxDistance(v: number) { this._godRayMaxDistance = Math.min(1000, Math.max(5, v)); }

    // --- Runtime bake state (renderer-facing) ---
    public get cubemap(): Texture | null { return this._cubemap; }
    public get cubemapResolution(): number { return this._cubemapResolution; }
    public get needsBake(): boolean { return this._needsBake; }
    public get lastSunDir(): [number, number, number] { return this._lastSunDir; }
    /** Force a re-bake on the next frame (e.g. editor "Rebake" button). */
    public markDirty(): void { this._needsBake = true; }
    /** Store a freshly-created render-target cubemap (disposes any previous one). */
    public setCubemap(cube: Texture, resolution: number): void {
        if (this._cubemap && this._cubemap !== cube) this._cubemap.delete();
        this._cubemap = cube;
        this._cubemapResolution = resolution;
    }
    /** Mark the current cubemap as up-to-date for the given sun direction. */
    public markBaked(sunDir: [number, number, number]): void {
        this._needsBake = false;
        this._lastSunDir = [sunDir[0], sunDir[1], sunDir[2]];
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const radius = 1000;
        const min = vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius);
        const max = vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius);
        return { min, max };
    }

    public serialize(): Promise<any> {
        return new Promise((resolve) => {
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    atmosphere: {
                        useSceneSun: this._useSceneSun,
                        sunDirection: this._sunDirection,
                        sunColor: this._sunColor,
                        sunIntensity: this._sunIntensity,
                        rayleighScatter: this._rayleighScatter,
                        rayleighHeight: this._rayleighHeight,
                        mieScatter: this._mieScatter,
                        mieHeight: this._mieHeight,
                        mieG: this._mieG,
                        planetRadius: this._planetRadius,
                        atmosphereRadius: this._atmosphereRadius,
                        sunDiskSize: this._sunDiskSize,
                        exposure: this._exposure,
                        groundColor: this._groundColor,
                        resolution: this._resolution,
                        viewSteps: this._viewSteps,
                        lightSteps: this._lightSteps,
                        fogEnabled: this._fogEnabled,
                        fogDensity: this._fogDensity,
                        fogStart: this._fogStart,
                        fogHeight: this._fogHeight,
                        fogHeightFalloff: this._fogHeightFalloff,
                        fogMaxOpacity: this._fogMaxOpacity,
                        fogColor: this._fogColor,
                        fogColorBlend: this._fogColorBlend,
                        godRaysEnabled: this._godRaysEnabled,
                        godRaySamples: this._godRaySamples,
                        godRayDensity: this._godRayDensity,
                        godRayExposure: this._godRayExposure,
                        godRayTint: this._godRayTint,
                        godRayAnisotropy: this._godRayAnisotropy,
                        godRayMaxDistance: this._godRayMaxDistance
                    }
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new SkyAtmosphereNode(json.name, json.atmosphere ?? {}, json.id);
        Node._commonParse(node, parent, json);
        parent.addChild(node);
    }
}

export class CameraNode extends Node {
    private readonly _camera: Camera;
    private _active: boolean;
    // Ordered fullscreen post-process passes (screen-mode CustomMaterials) run by the renderer for
    // this camera, in array order. Serialized inline like mesh materials; the editor links them to
    // material assets via the '__screenMaterialIds' node variable.
    private _screenMaterials: CustomMaterial[] = [];

    constructor(name: string, camera: Camera, id: string = uuidv4()) {
        super(name, 'camera', id);
        this._camera = camera;
        this._active = true;
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        this._camera.position = this.worldPosition;
        this._camera.eye = vec3.add(vec3.create(), this.worldPosition, this.worldForward);
    }

    public static parse(parent: Node, json: any) {
        const node = new CameraNode(json.name, new Camera({
            type: json.camera.type,
            fov: json.camera.fov,
            near: json.camera.near,
            far: json.camera.far,
            left: json.camera.left,
            right: json.camera.right,
            bottom: json.camera.bottom,
            top: json.camera.top
        }), json.id);
        Node._commonParse(node, parent, json);
        node.active = json.active;
        node.screenMaterials = (Array.isArray(json.screenMaterials) ? json.screenMaterials : [])
            .map((m: any) => Material.parse(m))
            .filter((m: Material): m is CustomMaterial => m instanceof CustomMaterial && m.renderMode === 'screen');
        parent.addChild(node);
    }

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    camera: {
                        type: this._camera.type,
                        fov: this._camera.fov,
                        near: this._camera.near,
                        far: this._camera.far,
                        left: this._camera.left,
                        right: this._camera.right,
                        bottom: this._camera.bottom,
                        top: this._camera.top
                    },
                    active: this._active,
                    screenMaterials: this._screenMaterials.map(m => m.serialize())
                });
            });
        });
    }

    public get camera(): Camera { return this._camera; }
    public get active(): boolean { return this._active; }
    public set active(value: boolean) { this._active = value; }
    public get screenMaterials(): CustomMaterial[] { return this._screenMaterials; }
    public set screenMaterials(mats: CustomMaterial[]) { this._screenMaterials = mats; }

    /**
     * Get bounding box for CameraNode - returns a small sphere bounding box
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const scale = this.worldScale;
        
        // Camera has a larger bounding box for easier selection
        const radius = Math.max(scale[0], scale[1], scale[2]) * 0.5;
        
        const min = vec3.fromValues(
            position[0] - radius,
            position[1] - radius,
            position[2] - radius
        );
        const max = vec3.fromValues(
            position[0] + radius,
            position[1] + radius,
            position[2] + radius
        );
        
        return { min, max };
    }
}

export class SpriteNode extends Node {
    protected _sprite: Sprite;
    protected _initialized: boolean;
    protected _constraints: 'free' | 'spherical' | 'cylindrical';

    constructor(
        name: string,
        sprite: Sprite,
        constraints: 'free' | 'spherical' | 'cylindrical' = 'spherical',
        id: string = uuidv4(),
        nodeType: 'sprite' | 'animatedSprite' = 'sprite'
    ) {
        super(name, nodeType, id);
        this._sprite = sprite;
        this._initialized = false;
        this._constraints = constraints;
    }

    public initializeSprite(): void {
        const shader = ShaderManager.Instance.getShader(this._sprite.material.type);
        this._sprite.mesh.initializeVAO(shader.attributes);

        const attributes = [];
        for (const attr of shader.attributes) {
            switch (attr.name) {
                case 'position':
                case 'a_position':
                    attributes.push('position');
                    break;
                case 'normal':
                case 'a_normal':
                    attributes.push('normal');
                    break;
                case 'uv':
                case 'a_uv':
                case 'texCoord':
                case 'a_texCoord':
                    attributes.push('uv');
                    break;
                case 'tangent':
                case 'a_tangent':
                    attributes.push('tangent');
                    break;
                case 'bitangent':
                case 'a_bitangent':
                    attributes.push('bitangent');
                    break;
                default:
                    const errMsg = `Attribute ${attr.name} not supported`;
                    Logger.error(errMsg)
                    throw new Error(errMsg);
            }
        }

        this._sprite.mesh.create(this._sprite.geometry.getData(attributes), this._sprite.geometry.vertexCount, this._sprite.geometry.indices);
        this._initialized = true;
    }

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            const sprite = {
                constraints: this._constraints,
                material: this._sprite.serialize()
            }
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    sprite: sprite
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const sprite = new SpriteNode(json.name, Sprite.parse(json.sprite.material), json.sprite.constraints, json.id);
        sprite.constraints = json.sprite.constraints;
        Node._commonParse(sprite, parent, json);
        parent.addChild(sprite);
    }

    public get sprite(): Sprite { return this._sprite; }
    public get initialized(): boolean { return this._initialized; }
    public get constraints(): 'free' | 'spherical' | 'cylindrical' { return this._constraints; }
    public set constraints(value: 'free' | 'spherical' | 'cylindrical') { this._constraints = value; }

    /**
     * Get bounding box for SpriteNode - returns a small sphere bounding box
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const scale = this.worldScale;
        
        // Sprite has a small bounding box
        const radius = Math.max(scale[0], scale[1], scale[2]) * 0.3;
        
        const min = vec3.fromValues(
            position[0] - radius,
            position[1] - radius,
            position[2] - radius
        );
        const max = vec3.fromValues(
            position[0] + radius,
            position[1] + radius,
            position[2] + radius
        );
        
        return { min, max };
    }
}

export class AnimatedSpriteNode extends SpriteNode {
    private _columns: number;
    private _rows: number;
    private _fps: number;
    private _loop: boolean;
    private _startFrame: number;
    private _endFrame: number;
    private _currentFrame: number;
    private _accumulator: number;
    private _sequence: number[] | null;
    private _seqIndex: number;

    constructor(
        name: string,
        sprite: Sprite,
        options?: {
            columns?: number,
            rows?: number,
            fps?: number,
            loop?: boolean,
            startFrame?: number,
            endFrame?: number,
            sequence?: number[] | null,
            constraints?: 'free' | 'spherical' | 'cylindrical',
            id?: string
        }
    ) {
        super(name, sprite, options?.constraints || 'spherical', options?.id || uuidv4(), 'animatedSprite');
        this._columns = Math.max(1, options?.columns ?? 1);
        this._rows = Math.max(1, options?.rows ?? 1);
        this._fps = Math.max(0.0001, options?.fps ?? 12);
        this._loop = options?.loop ?? true;
        this._startFrame = Math.max(0, options?.startFrame ?? 0);
        const maxFrames = this._columns * this._rows;
        this._endFrame = Math.min(maxFrames - 1, options?.endFrame ?? (maxFrames - 1));
        this._currentFrame = this._startFrame;
        this._accumulator = 0;
        this._sequence = options?.sequence ?? null;
        this._seqIndex = 0;
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        const frameTime = 1.0 / this._fps;
        this._accumulator += delta;
        while (this._accumulator >= frameTime) {
            this._accumulator -= frameTime;
            if (this._sequence && this._sequence.length > 0) {
                if (this._seqIndex < this._sequence.length - 1) {
                    this._seqIndex++;
                } else if (this._loop) {
                    this._seqIndex = 0;
                }
                this._currentFrame = this._sequence[this._seqIndex];
            } else {
                if (this._currentFrame < this._endFrame) {
                    this._currentFrame++;
                } else if (this._loop) {
                    this._currentFrame = this._startFrame;
                } else {
                    // stop at last frame
                    this._currentFrame = this._endFrame;
                }
            }
        }
    }

    public getUVTransform(): [number, number, number, number] {
        const total = this._columns * this._rows;
        if (total <= 0) return [0, 0, 1, 1];
        const scaleX = 1 / this._columns;
        const scaleY = 1 / this._rows;
        const idx = Math.max(0, Math.min(this._currentFrame, total - 1));
        const col = idx % this._columns;
        const row = Math.floor(idx / this._columns);
        const offsetX = col * scaleX;
        const offsetY = row * scaleY;
        return [offsetX, offsetY, scaleX, scaleY];
    }

    public serialize(): Promise<any> {
        return new Promise((resolve) => {
            const sprite = {
                constraints: this._constraints,
                material: this._sprite.serialize()
            };
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    variables: this._serializeVariables(),
                    sprite: sprite,
                    animation: {
                        columns: this._columns,
                        rows: this._rows,
                        fps: this._fps,
                        loop: this._loop,
                        startFrame: this._startFrame,
                        endFrame: this._endFrame,
                        sequence: this._sequence
                    }
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const spriteNode = new AnimatedSpriteNode(
            json.name,
            Sprite.parse(json.sprite.material),
            {
                id: json.id,
                constraints: json.sprite.constraints,
                columns: json.animation?.columns ?? 1,
                rows: json.animation?.rows ?? 1,
                fps: json.animation?.fps ?? 12,
                loop: json.animation?.loop ?? true,
                startFrame: json.animation?.startFrame ?? 0,
                endFrame: json.animation?.endFrame ?? ((json.animation?.columns ?? 1) * (json.animation?.rows ?? 1) - 1),
                sequence: json.animation?.sequence ?? null
            }
        );
        Node._commonParse(spriteNode, parent, json);
        parent.addChild(spriteNode);
    }

    public get columns(): number { return this._columns; }
    public set columns(v: number) { this._columns = Math.max(1, Math.floor(v)); this._resetFrameBounds(); }
    public get rows(): number { return this._rows; }
    public set rows(v: number) { this._rows = Math.max(1, Math.floor(v)); this._resetFrameBounds(); }
    public get fps(): number { return this._fps; }
    public set fps(v: number) { this._fps = Math.max(0.0001, v); }
    public get loop(): boolean { return this._loop; }
    public set loop(v: boolean) { this._loop = v; }
    public get startFrame(): number { return this._startFrame; }
    public set startFrame(v: number) { this._startFrame = Math.max(0, Math.floor(v)); this._currentFrame = this._startFrame; this._seqIndex = 0; }
    public get endFrame(): number { return this._endFrame; }
    public set endFrame(v: number) { this._endFrame = Math.max(this._startFrame, Math.floor(v)); }
    public get currentFrame(): number { return this._currentFrame; }
    public set currentFrame(v: number) { this._currentFrame = Math.max(this._startFrame, Math.min(Math.floor(v), this._endFrame)); this._accumulator = 0; }
    public get sequence(): number[] | null { return this._sequence; }
    public set sequence(seq: number[] | null) { this._sequence = (seq && seq.length > 0) ? seq : null; this._seqIndex = 0; if (this._sequence) this._currentFrame = this._sequence[0]; }

    private _resetFrameBounds(): void {
        const maxFrames = this._columns * this._rows;
        this._startFrame = Math.min(this._startFrame, Math.max(0, maxFrames - 1));
        this._endFrame = Math.min(this._endFrame, Math.max(0, maxFrames - 1));
        if (this._startFrame > this._endFrame) this._endFrame = this._startFrame;
        this._currentFrame = this._startFrame;
        this._seqIndex = 0;
    }
}