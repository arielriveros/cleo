import { mat4, vec3, quat } from "gl-matrix";
import { RigidBody, Trigger } from "../../physics/body";
import { Model } from "../../graphics/model";
import { AnimatedModel } from "../../graphics/animatedModel";
import { Animator, AnimationMapping, AnimationStateMachine } from "../../graphics/animator";
import type { RagdollOptions } from "../../physics/ragdoll";
import { Sprite } from "../../graphics/sprite";
import { DirectionalLight, Light, PointLight, Spotlight } from "../../graphics/lighting";
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

type NodeType = 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'sprite' | 'animatedSprite' | 'landscape' | 'volumetricClouds' | 'skyAtmosphere';

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

            // findNode lives on Scene, so this.scene.findNode(...) would hand back a raw node. Synthesize
            // it here instead, where the result can be proxied like every other node a script touches.
            if (prop === 'findNode')
                return (name: string) => wrapNode(node.scene?.findNode(name), requester);

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

            if (prop in node) return Reflect.set(node, prop, value, node);

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

    factory.call(context, createScriptImporter(bindDataAccessors(node)));

    // The engine calls handlers with raw nodes; scripts must only ever see proxied ones. A throwing
    // handler must not take the frame down with it either, and the node's name is the only thing that
    // makes the error findable in a scene of hundreds.
    const guard = (name: string) => {
        const fn = handlers[name];
        if (typeof fn !== 'function') return () => {};
        return (...args: any[]) => {
            try { fn.apply(context, args.map(arg => (arg instanceof Node ? wrapNode(unwrapScriptNode(arg), node) : arg))); }
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

  // Custom user-defined variables editable in the inspector, serialized with the node, and
  // readable from scripts via getData(node) and writable via setData(node, name, value).
  protected _variables: Map<string, NodeVariable> = new Map();

  // Script handlers. The node is always the first argument; everything else a script needs it imports.
  public onStart: (node: Node) => void = () => {};
  public onSpawn: (node: Node) => void = () => {};
  public onUpdate: (node: Node, delta: number, time: number) => void = () => {};
  public onCollision: (node: Node, other: Node) => void = () => {};
  public onTrigger: (node: Node, other: Node) => void = () => {};
  public onDespawn: (node: Node) => void = () => {};

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

  public addChild(node: Node): void {
    // if the node already has a parent, remove it from the parent's children
    if (node.parent) {
      node.parent.removeChild(node, true);
      CleoEngine.eventEmitter.emit('SCENE_CHANGED');
    }
    
    node.parent = this;
    this._children.push(node);
    node.onSpawn(node);
    if (this._hasStarted)
      node.start();
    if (this.scene) {
      node.scene = this.scene;
      for (const child of node.children) {
        child.onSpawn(child);
        child.scene = this.scene;
      }
    }
    CleoEngine.eventEmitter.emit('SCENE_CHANGED');
  }

  public removeChild(node: Node, reparent: boolean = false): void {
    if (!reparent) {
      try { node.onDespawn(node); } catch (e) { Logger.error(`Error in onDespawn for node ${node.name}: ${e}`); }
    }
    node.parent = null;
    node.scene = null;
    this._children.splice(this._children.indexOf(node), 1);
    CleoEngine.eventEmitter.emit('SCENE_CHANGED');
  }

  public getChildByName(name: string): Node[] {
    const nodes: Node[] = [];
    for (const child of this._children)
      if (child.name === name)
        nodes.push(child);
    return nodes;
  }

  public getChildById = (id: string): Node | null => {
    for (const child of this._children)
      if (child.id === id)
        return child;
    return null;
  }

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

  public remove(): void {
    this._markForRemoval = true;
    try { this.onDespawn(this); } catch (e) { Logger.error(`Error in onDespawn function for node ${this._name}: ${e}`); }
    for (const child of this._children)
      child.remove();
  }

  public start(): void {
    try {
      this._hasStarted = true;
      this.onStart(this);
      for (const child of this._children)
        child.start();
    } catch (error) {
      Logger.error(`Error in onStart function for node ${this._name}: ${error}`);
    }
  }

  public update(delta: number, time: number): void {
    try {
      this.onUpdate(this, delta, time);
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
      node.setBody(
        json.body.mass,
        json.body.linearDamping,
        json.body.angularDamping,
        json.body.linearConstraints,
        json.body.angularConstraints
      );
      setShapes(json.body.shapes, node._body);
    }

    if (json.trigger) {
      node.setTrigger();
      setShapes(json.trigger.shapes, node._trigger);
    }

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

  public get id(): string { return this._id; }
  public get name(): string { return this._name; }
  public set name(name: string) { this._name = name; }
  public set parent(node: Node | null) { this._parent = node; }
  public get parent(): Node | null { return this._parent; }
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

  public get scene(): Scene | null { return this._scene; }
  public set scene(scene: Scene | null) {
    this._scene = scene;
    for (const child of this._children)
      child.scene = scene;
  }
  public get hasStarted(): boolean { return this._hasStarted; }
  public get markForRemoval(): boolean { return this._markForRemoval; }

  public get localTransform(): mat4 { return this._localTransform; }
  public get worldTransform(): mat4 { return this._worldTransform; }

  public get forward(): vec3 {
    let forward = vec3.fromValues(0, 0, 1);
    vec3.transformMat4(forward, forward, this._rotationMatrix);
    vec3.normalize(forward, forward);
    return forward;
  }

  public get worldPosition(): vec3 {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldPosition;
  }

  public get worldQuaternion(): quat {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldQuaternion;
  }

  public get worldScale(): vec3 {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldScale;
  }

  public get worldForward(): vec3 {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldForward;
  }

  public setX(value: number): Node {
    this._position[0] = value;
    this._updateTranslationMatrix();
    return this;
  }

  public addX(value: number): Node {
    this._position[0] += value;
    this._updateTranslationMatrix();
    return this;
  }

  public setY(value: number): Node {
    this._position[1] = value;
    this._updateTranslationMatrix();
    return this;
  }

  public addY(value: number): Node {
    this._position[1] += value;
    this._updateTranslationMatrix();
    return this;
  }

  public setZ(value: number): Node {
    this._position[2] = value;
    this._updateTranslationMatrix();
    return this;
  }

  public addZ(value: number): Node {
    this._position[2] += value;
    this._updateTranslationMatrix();
    return this;
  }

  public setPosition(pos: vec3): Node {
    vec3.copy(this._position, pos);
    this._updateTranslationMatrix();
    return this;
  }

  public addForward(value: number) {
    //vec3.add(this._position, this._position, vec3.scale(vec3.create(), this.worldForward, value));
    vec3.add(this._position, this._position, vec3.scale(vec3.create(), this.forward, value));
    this._updateTranslationMatrix();
  }

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

  public rotateX(value: number): Node {
    this._euler[0] += value;
    this._updateRotationMatrix();
    return this;
  }
  
  public rotateY(value: number): Node {
    this._euler[1] += value;
    this._updateRotationMatrix();
    return this;
  }
  
  public rotateZ(value: number): Node {
    this._euler[2] += value;
    this._updateRotationMatrix();
    return this;
  }
  
  public setRotation(value: vec3): Node {
    vec3.copy(this._euler, value);
    this._updateRotationMatrix();
    return this;
  }

  public setQuaternion(quaternion: quat): Node {
    quat.copy(this._quaternion, quaternion);
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

  public get body(): RigidBody | null { return this._body; }
  public setBody(
    mass: number,
    linearDamping?: number,
    angularDamping?: number,
    linearConstraints?: [number, number, number],
    angularConstraints?: [number, number, number]
  ): RigidBody {
    // TODO: Handle the case where the node is a child of another node
    this._body = new RigidBody({
      mass,
      linearDamping,
      angularDamping,
      // Valid during parse: _commonParse applies the JSON transform before creating the body.
      position: this.worldPosition,
      quaternion: this.worldQuaternion,
      linearConstraints, angularConstraints
    }, this);

    // handle onCollision event
    this._body.addEventListener('collide', (event: any) => {
      if (event.body instanceof RigidBody || event.body instanceof Trigger)
        this.onCollision(this, event.body.owner);
    });

    return this._body;
  }

  public get trigger(): Trigger | null { return this._trigger; }
  public setTrigger(): void {
    this._trigger = new Trigger({
      position: this.worldPosition,
      quaternion: this.worldQuaternion
    }, this);

    // handle onTrigger event
    this._trigger.addEventListener('collide', (event: any) => {
      if (event.body instanceof RigidBody || event.body instanceof Trigger)
        this.onTrigger(this, event.body.owner);
    });

  }

  public get position(): vec3 { return this._position; }
  public get rotation(): vec3 { return this._euler; }

  public get quaternion(): quat { return this._quaternion; }
  public get scale(): vec3 { return this._scale; }
  public get nodeType(): string { return this._nodeType; }
  public get visible(): boolean { return this._visible; }
  public set visible(value: boolean) {
    this._visible = value;
    for (const child of this._children)
      child.visible = value;
    CleoEngine.eventEmitter.emit('SCENE_CHANGED');
  }

  /**
   * Get the bounding box for this node
   * Default implementation returns a unit cube
   * Should be overridden by subclasses for more accurate bounding boxes
   */
  public getBoundingBox(): { min: vec3, max: vec3 } {
    const position = this.worldPosition;
    const scale = this.worldScale;
    
    // Default to unit cube
    const halfSize = vec3.create();
    vec3.scale(halfSize, vec3.fromValues(0.5, 0.5, 0.5), 1);
    vec3.multiply(halfSize, halfSize, scale);
    
    const min = vec3.create();
    const max = vec3.create();
    vec3.subtract(min, position, halfSize);
    vec3.add(max, position, halfSize);

    return { min, max };
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
     * Get bounding box for ModelNode based on the model's geometry
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const scale = this.worldScale;

        // Get the model's geometry bounds
        const geometry = this._model.geometry;
        const positions = geometry.positions;
        
        if (!positions || positions.length === 0) {
            // Fallback to unit cube if no geometry
            const halfSize = vec3.create();
            vec3.scale(halfSize, vec3.fromValues(0.5, 0.5, 0.5), 1);
            vec3.multiply(halfSize, halfSize, scale);
            const min = vec3.create();
            const max = vec3.create();
            vec3.subtract(min, position, halfSize);
            vec3.add(max, position, halfSize);
            return { min, max };
        }
        
        // Calculate bounding box from geometry vertices with proper transformation
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        
        // Use the world transform matrix directly (already includes position, rotation, scale)
        const transform = this.worldTransform;
        
        for (let i = 0; i < positions.length; i++) {
            const vertex = positions[i];
            
            // Transform vertex using the world transform matrix
            const transformedVertex = vec3.create();
            // Ensure vertex is a Float32Array for gl-matrix compatibility
            const vertexVec = (vertex instanceof Float32Array) ? vertex : vec3.fromValues(vertex[0], vertex[1], vertex[2]);
            vec3.transformMat4(transformedVertex, vertexVec, transform);

            minX = Math.min(minX, transformedVertex[0]);
            minY = Math.min(minY, transformedVertex[1]);
            minZ = Math.min(minZ, transformedVertex[2]);
            maxX = Math.max(maxX, transformedVertex[0]);
            maxY = Math.max(maxY, transformedVertex[1]);
            maxZ = Math.max(maxZ, transformedVertex[2]);
        }
        
        const min = vec3.fromValues(minX, minY, minZ);
        const max = vec3.fromValues(maxX, maxY, maxZ);

        return { min, max };
    }

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
    private _needsBake: boolean = true;
    private _lastBakeTime: number = 0;
    private _sourceCube: Texture | null = null;
    private _irradiance: Texture | null = null;
    private _prefiltered: Texture | null = null;

    constructor(
        name: string,
        options: { resolution?: number, mode?: 'baked' | 'realtime', updateFrequency?: number, intensity?: number } = {},
        id: string = uuidv4()
    ) {
        super(name, 'lightProbe', id);
        this._resolution = options.resolution ?? 256;
        this._mode = options.mode ?? 'baked';
        this._updateFrequency = options.updateFrequency ?? 1;
        this._intensity = options.intensity ?? 1;
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
                    intensity: this._intensity
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new LightProbeNode(json.name, {
            resolution: json.resolution,
            mode: json.mode,
            updateFrequency: json.updateFrequency,
            intensity: json.intensity
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
    // God rays (screen-space radial light shafts from the scene directional light — post-process)
    godRaysEnabled?: boolean;
    godRaySamples?: number;     // radial-blur samples toward the sun (quality/cost)
    godRayDensity?: number;     // 0..1 — march length toward the sun (shaft length/spread)
    godRayWeight?: number;      // per-sample weight
    godRayDecay?: number;       // 0..1 — attenuation per sample
    godRayExposure?: number;    // overall shaft intensity
    godRayThreshold?: number;   // brightness cutoff that isolates the bright sun from dim sky
    godRayTint?: [number, number, number]; // multiply tint on the shafts
    godRaySunSpread?: number;   // angular radius (deg) of the sun source — only the sky within this
                                // cone of the sun direction emits shafts (so clouds elsewhere don't)
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
    private _godRayWeight: number;
    private _godRayDecay: number;
    private _godRayExposure: number;
    private _godRayThreshold: number;
    private _godRayTint: [number, number, number];
    private _godRaySunSpread: number;
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
        this._godRayWeight = options.godRayWeight ?? 0.5;
        this._godRayDecay = options.godRayDecay ?? 0.95;
        this._godRayExposure = options.godRayExposure ?? 0.3;
        this._godRayThreshold = options.godRayThreshold ?? 0.5;
        this._godRayTint = options.godRayTint ?? [1.0, 1.0, 1.0];
        this._godRaySunSpread = options.godRaySunSpread ?? 15;
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
    public get godRayWeight(): number { return this._godRayWeight; }
    public set godRayWeight(v: number) { this._godRayWeight = Math.max(0, v); }
    public get godRayDecay(): number { return this._godRayDecay; }
    public set godRayDecay(v: number) { this._godRayDecay = Math.min(1, Math.max(0, v)); }
    public get godRayExposure(): number { return this._godRayExposure; }
    public set godRayExposure(v: number) { this._godRayExposure = Math.max(0, v); }
    public get godRayThreshold(): number { return this._godRayThreshold; }
    public set godRayThreshold(v: number) { this._godRayThreshold = Math.max(0, v); }
    public get godRayTint(): [number, number, number] { return this._godRayTint; }
    public set godRayTint(v: [number, number, number]) { this._godRayTint = v; }
    public get godRaySunSpread(): number { return this._godRaySunSpread; }
    public set godRaySunSpread(v: number) { this._godRaySunSpread = Math.min(60, Math.max(2, v)); }

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
                        godRayWeight: this._godRayWeight,
                        godRayDecay: this._godRayDecay,
                        godRayExposure: this._godRayExposure,
                        godRayThreshold: this._godRayThreshold,
                        godRayTint: this._godRayTint,
                        godRaySunSpread: this._godRaySunSpread
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
                    active: this._active
                });
            });
        });
    }

    public get camera(): Camera { return this._camera; }
    public get active(): boolean { return this._active; }
    public set active(value: boolean) { this._active = value; }

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