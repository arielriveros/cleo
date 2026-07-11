import { mat4, vec3, quat } from "gl-matrix";
import { RigidBody, Trigger } from "../../physics/body";
import { Model } from "../../graphics/model";
import { AnimatedModel } from "../../graphics/animatedModel";
import { Animator, AnimationMapping } from "../../graphics/animator";
import type { RagdollOptions } from "../../physics/ragdoll";
import { Sprite } from "../../graphics/sprite";
import { DirectionalLight, Light, PointLight, Spotlight } from "../../graphics/lighting";
import { Skybox } from "../../graphics/skybox";
import { Texture } from "../../graphics/texture";
import { ShaderManager } from "../../graphics/systems/shaderManager";
import { Scene } from "./scene";
import { v4 as uuidv4 } from 'uuid';
import { Camera } from "../camera";
import { CleoEngine, InputManager, Shape } from "../../cleo";
import { Logger } from "../logger";
import { Terrain } from "../../terrain/terrain";
import type { BVH } from "../bvh";

type NodeType = 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'sprite' | 'animatedSprite' | 'landscape';

export type NodeVariableType = 'number' | 'string' | 'boolean' | 'vec3';
export interface NodeVariable {
    type: NodeVariableType;
    value: any;
}

/**
 * Returns a plain snapshot of a node's custom variables (name -> value). Read-only: assigning to
 * the returned object does NOT change the node — use `setData(node, name, value)` to write.
 *
 *   const data = getData(player);
 *   if (data.HealthPoints <= 0) { ... }
 *   console.log(data);                 // { HealthPoints: 3, ... }
 */
export function getData(node: Node): Record<string, any> {
    const out: Record<string, any> = {};
    if (node && node.variables) for (const [name, v] of node.variables) out[name] = v.value;
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

interface GlobalState {
    input: InputManager;
    logger: (text: string) => void;
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

  public onStart: (node: Node, global: GlobalState) => void = () => {};
  public onSpawn: (node: Node, global: GlobalState) => void = () => {};
  public onUpdate: (node: Node, delta: number, time: number, global: GlobalState) => void = () => {};
  public onCollision: (node: Node, other: Node, global: GlobalState) => void = () => {};
  public onTrigger: (node: Node, other: Node, global: GlobalState) => void = () => {};
  public onDespawn: (node: Node, global: GlobalState) => void = () => {};

  private _globalStateObject: GlobalState = {
    input: InputManager.instance,
    logger: (t)=>Logger.log(t, 'Script')
  }

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
    node.onSpawn(node, this._globalStateObject);
    if (this._hasStarted)
      node.start();
    if (this.scene) {
      node.scene = this.scene;
      for (const child of node.children) {
        child.onSpawn(child, this._globalStateObject);
        child.scene = this.scene;
      }
    }
    CleoEngine.eventEmitter.emit('SCENE_CHANGED');
  }

  public removeChild(node: Node, reparent: boolean = false): void {
    if (!reparent) {
      try { node.onDespawn(node, this._globalStateObject); } catch (e) { Logger.error(`Error in onDespawn for node ${node.name}: ${e}`); }
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
    mat4.getRotation(this._worldQuaternion, this._worldTransform);
    mat4.getScaling(this._worldScale, this._worldTransform);
    vec3.transformQuat(this._worldForward, vec3.set(this._worldForward, 0, 0, 1), this._worldQuaternion);
    vec3.normalize(this._worldForward, this._worldForward);
    this._worldCacheDirty = false;
  }

  public remove(): void {
    this._markForRemoval = true;
    try { this.onDespawn(this, this._globalStateObject); } catch (e) { Logger.error(`Error in onDespawn function for node ${this._name}: ${e}`); }
    for (const child of this._children)
      child.remove();
  }

  public start(): void {
    try {
      this._hasStarted = true;
      this.onStart(this, this._globalStateObject);
      for (const child of this._children)
        child.start();
    } catch (error) {
      Logger.error(`Error in onStart function for node ${this._name}: ${error}`);
    }
  }

  public update(delta: number, time: number): void {
    try {
      this.onUpdate(this, delta, time, this._globalStateObject);
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
          variables: this._serializeVariables(),
          scripts: {
            // TODO: Only serialize the function body
            onStart: this.onStart.toString(),
            onSpawn: this.onSpawn.toString(),
            onUpdate: this.onUpdate.toString(),
            onDespawn: this.onDespawn.toString()
          }
        });
      });
    });
  }

  private static _findToken(script: string, token: string): string | null {
    let beginIndex = script.indexOf(token);
    if (beginIndex === -1)
      return null;
    while (script[beginIndex] !== '{')
      beginIndex++;

    let endIndex = beginIndex;
    let count = 0;
    while (endIndex < script.length) {
      if (script[endIndex] === '{') 
        count++;
      else if (script[endIndex] === '}') 
        count--;
      if (count === 0)
        break;
      endIndex++;
    }

    if (endIndex === script.length) {
      return null;
    }

    return script.substring(beginIndex + 1, endIndex);
  }

  private static _parseScript(node: Node, script: string): void {
    // Compile the entire script once, allowing helper functions and variables
    // Scripts can either:
    // 1) Define top-level functions: function onStart() {}, function onUpdate(...) {}, etc.
    // 2) Export handlers via module.exports = { onStart, onUpdate, onSpawn, onCollision, onTrigger }
    try {
      const factory = new Function(
        'node',
        'global',
        'Logger',
        'InputManager',
        'getData',
        'setData',
        'scene',
        'findNode',
        `"use strict";
         const console = {
           log: (...args) => global.logger(args.map(a => String(a)).join(' ')),
           warn: (...args) => Logger.warn(args.map(a => String(a)).join(' '), 'Script'),
           error: (...args) => Logger.error(args.map(a => String(a)).join(' '), 'Script')
         };
         let exports = {};
         let module = { exports };
         // Source runs at the function top level so top-level \`function\` declarations hoist to
         // the function scope; module.exports handlers are also supported.
         ${script}
         const ex = (module && typeof module.exports === 'object' && module.exports) ? module.exports : {};
         const pick = (fn, name) => (typeof fn === 'function' ? fn : (typeof ex[name] === 'function' ? ex[name] : null));
         return {
           onStart:     pick(typeof onStart === 'function' ? onStart : null, 'onStart'),
           onSpawn:     pick(typeof onSpawn === 'function' ? onSpawn : null, 'onSpawn'),
           onUpdate:    pick(typeof onUpdate === 'function' ? onUpdate : null, 'onUpdate'),
           onCollision: pick(typeof onCollision === 'function' ? onCollision : null, 'onCollision'),
           onTrigger:   pick(typeof onTrigger === 'function' ? onTrigger : null, 'onTrigger'),
           onDespawn:   pick(typeof onDespawn === 'function' ? onDespawn : null, 'onDespawn')
         };`
      ) as (...args: any[]) => any;

      const findNode = (name: string) => node.scene?.getNodesByName(name)[0];
      const handlers = factory(
        node, node._globalStateObject, Logger, InputManager,
        getData, setData, node.scene, findNode
      ) || {};

      const adaptStartLike = (fn: any) => {
        if (typeof fn !== 'function') return () => {};
        const ar = fn.length;
        return (n: Node, g: GlobalState) => {
          try {
            if (ar >= 2) fn(n, g);           // (node, global)
            else if (ar === 1) fn(n);        // (node)
            else fn();                        // () with closure access to node/global
          } catch (e) { Logger.error(`Error in script onStart/onSpawn for node ${n.name}: ${e}`); }
        };
      };

      const adaptUpdate = (fn: any) => {
        if (typeof fn !== 'function') return () => {};
        const ar = fn.length;
        return (n: Node, d: number, t: number, g: GlobalState) => {
          try {
            if (ar >= 4) fn(n, d, t, g);     // (node, delta, time, global)
            else if (ar === 3) fn(n, d, t);  // (node, delta, time)
            else if (ar === 2) fn(d, t);     // (delta, time)
            else if (ar === 1) fn(d);        // (delta)
            else fn();                        // () with closure access
          } catch (e) { Logger.error(`Error in script onUpdate for node ${n.name}: ${e}`); }
        };
      };

      const adaptOther = (fn: any) => {
        if (typeof fn !== 'function') return () => {};
        const ar = fn.length;
        return (n: Node, other: Node, g: GlobalState) => {
          try {
            if (ar >= 3) fn(n, other, g);    // (node, other, global)
            else if (ar === 2) fn(other, g); // (other, global)
            else if (ar === 1) fn(other);    // (other)
            else fn();                        // () with closure access
          } catch (e) { Logger.error(`Error in script event for node ${n.name}: ${e}`); }
        };
      };

      node.onStart = adaptStartLike(handlers.onStart) as (node: Node, global: GlobalState) => void;
      node.onSpawn = adaptStartLike(handlers.onSpawn) as (node: Node, global: GlobalState) => void;
      node.onUpdate = adaptUpdate(handlers.onUpdate) as (node: Node, delta: number, time: number, global: GlobalState) => void;
      node.onCollision = adaptOther(handlers.onCollision) as (node: Node, other: Node, global: GlobalState) => void;
      node.onTrigger = adaptOther(handlers.onTrigger) as (node: Node, other: Node, global: GlobalState) => void;
      node.onDespawn = adaptStartLike(handlers.onDespawn) as (node: Node, global: GlobalState) => void;
    } catch (error) {
      Logger.error(`Error parsing script for node ${node.name}: ${error}`);
    }
  }

  protected static _commonParse(node: Node, parent: Node, json: any) {
    node.updateTransforms(parent.worldTransform);

    // Restore custom variables before scripts so onStart can read them.
    Node._parseVariables(node, json.variables);

    if (json.script)
      Node._parseScript(node, json.script);

    const setShapes = (shapes: any, target: RigidBody | Trigger) => {
      for (const shape of shapes) {
        switch (shape.type) {
          case 'box':
            target.attachShape(
              Shape.Box(shape.width, shape.height, shape.depth),
              vec3.fromValues(shape.offset[0], shape.offset[1], shape.offset[2]),
              vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2])
            );
            break;
          case 'sphere':
            target.attachShape(
              Shape.Sphere(shape.radius),
              vec3.fromValues(shape.offset[0], shape.offset[1], shape.offset[2]),
              vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2])
            );
            break;
          case 'plane':
            target.attachShape(
              Shape.Plane(),
              vec3.fromValues(shape.offset[0], shape.offset[1], shape.offset[2]),
              vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2])
            );
            break;
          case 'cylinder':
            target.attachShape(
              Shape.Cylinder(shape.radius, shape.radius, shape.height, shape.numSegments),
              vec3.fromValues(shape.offset[0], shape.offset[1], shape.offset[2]),
              vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2])
            );
            break;
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
        else
          Node.parse(node, child);
      }
    }
    node.setPosition(json.position);
    node.setRotation(json.rotation);
    node.setScale(json.scale);
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
  public setVariable(name: string, value: any, type?: NodeVariableType): void {
    const existing = this._variables.get(name);
    const resolvedType: NodeVariableType = type
      ?? existing?.type
      ?? (typeof value === 'number' ? 'number'
        : typeof value === 'boolean' ? 'boolean'
        : Array.isArray(value) ? 'vec3' : 'string');
    this._variables.set(name, { type: resolvedType, value });
  }
  public removeVariable(name: string): void { this._variables.delete(name); }

  /** Serialize custom variables into a plain `{ name: { type, value } }` object. */
  protected _serializeVariables(): Record<string, NodeVariable> {
    const out: Record<string, NodeVariable> = {};
    for (const [name, v] of this._variables) out[name] = { type: v.type, value: v.value };
    return out;
  }

  /** Populate a node's variables from serialized JSON (`{ name: { type, value } }`). */
  protected static _parseVariables(node: Node, json: any): void {
    if (!json || typeof json !== 'object') return;
    for (const name of Object.keys(json)) {
      const entry = json[name];
      if (entry && typeof entry === 'object' && 'value' in entry)
        node.setVariable(name, entry.value, entry.type);
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
      position: this.worldPosition, // TODO: Set the world position, problem when parsing because world position is not set yet
      quaternion: this.worldQuaternion, // TODO: Set the world quaternion, same as above
      linearConstraints, angularConstraints
    }, this);

    // handle onCollision event
    this._body.addEventListener('collide', (event: any) => {
      if (event.body instanceof RigidBody || event.body instanceof Trigger)
        this.onCollision(this, event.body.owner, this._globalStateObject);
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
        this.onTrigger(this, event.body.owner, this._globalStateObject);
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
            
            // Serialize animation mappings if animator exists
            let animationMappings: AnimationMapping[] | null = null;
            if (this._animator) {
                animationMappings = this._animator.getAnimationMappings();
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
        if (this._animator) {
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