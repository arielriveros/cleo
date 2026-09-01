import { mat4, vec3, quat } from "gl-matrix";
import { RigidBody, Trigger } from "../../../physics/body";
import { MotionRecord, MotionConfig, motionConfig, planarSplit, signedAngleBetween, headingAngle, facingComponents } from "../../../physics/motion";
import type { Scene } from "../scene";
import { sceneStats, sceneStatsDetail } from "../sceneStats";
import { v4 as uuidv4 } from 'uuid';
import { engineEventBus, authoring } from "../../eventBus";
import { Shape } from "../../../physics/shape";
import { Logger } from "../../logger";
import { compileScript, resolveNodeScript } from "../../scripting/scriptRuntime";
import { NodeType } from "./nodeType";
import type { NodeVariable, NodeVariableType, NodeVariableAccess } from "./nodeVariables";
import { attachScriptFactory } from "./nodeScripting";
import { parseChild } from "./childParser";
import type { BVH } from "../../bvh";
import type { ChangeKind } from "../../eventBus";
import { eulerFromQuatDeg } from "../../math";



/**
 * Downward speed (units/s, gravity-relative) past which {@link Node.isFalling} reports true. Not zero:
 * a resting body is pressed into its surface by gravity and measures a small downward drift.
 */
const FALLING_SPEED = -0.5;

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

  // Spawn lifecycle. `_spawnOnStart` is authored (inspector + serialized); `_spawned` is the runtime state.
  // A dormant node is dropped from the scene's derived lists (Scene._filterByType), which is what makes
  // despawn cover EVERY consumer at once rather than the subset that checks `visible`.
  protected _spawnOnStart: boolean = true;
  protected _spawned: boolean = true;
  // onConstruct is once per node per scene load, so it needs its own latch — _hasStarted cannot serve, since
  // a dormant node receives onConstruct and never starts.
  protected _hasConstructed: boolean = false;
  // onSpawn is once per LIFE: set when it fires, cleared by despawn.
  protected _spawnNotified: boolean = false;

  protected _body: RigidBody | null;
  protected _trigger: Trigger | null;

  protected _visible: boolean;

  // Renderer-driven visibility for LOD level switching and distance culling (see LodGroupNode). Must stay
  // separate from _visible: that setter emits SCENE_CHANGED and, on ModelNode, writes castShadow.
  protected _lodVisible: boolean = true;

  // Custom user-defined variables editable in the inspector, serialized with the node, and
  // readable from scripts via getData(node) and writable via setData(node, name, value).
  protected _variables: Map<string, NodeVariable> = new Map();

  // Script handlers, declared as overridable methods so a class-based script can override them with
  // matching signatures. `this` IS the node, so there is no `node` self-parameter.

  /**
   * Called once for **every** node in the scene, spawned or not — the one handler a dormant node still
   * receives. Runs before {@link onSpawn} and {@link onStart}, with {@link scene} already available.
   *
   * Fires once per node per scene load: not on re-parenting, and not on a later spawn/despawn cycle. A
   * script class is never constructed, so this is the hook that replaces a `constructor()`.
   */
  public onConstruct(): void {}

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
   * Called once each time this node becomes live — at scene start, or when {@link spawn} wakes it — after
   * {@link onConstruct} and before {@link onStart}. The place for per-life setup; use {@link onStart} for
   * setup that must happen only once. Re-parenting does not re-fire it.
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
   *
   * @param index Where among the existing children to insert. Appends when omitted or out of range.
   */
  public addChild(node: Node, index?: number): void {
    // Captured before the detach so the structural event below can describe the whole move as one edit.
    const from = node.parent
      ? { parentId: node.parent.id, index: node.parent._children.indexOf(node) }
      : null;

    if (node.parent) {
      // removeChild emits the detach itself, flagged `reparent-detach`.
      node.parent.removeChild(node, true);
    }

    node.parent = this;
    if (index === undefined || index < 0 || index >= this._children.length) this._children.push(node);
    else this._children.splice(index, 0, node);

    // Scene FIRST, then the handlers: onStart routinely calls this.after/this.every, which go through
    // `this.scene`, and start() below reads `scene.spawnRulesEnabled`.
    if (this.scene)
      node.scene = this.scene;

    // Only when the scene is already running. During a scene LOAD every node is attached before Scene.start
    // walks the finished tree, so firing here too would deliver each handler twice.
    if (this._hasStarted) {
      node.applySpawnRules();
      node.runConstructHandlers();
      node.runSpawnHandlers();
      node.start();
    }
    engineEventBus.emit('SCENE_CHANGED', {
      kind: 'structure', node,
      prop: from ? 'reparent' : 'add',
      prev: from,
      // The real landing slot, not `length - 1`: an indexed insert must report where it actually went.
      next: { parentId: this._id, index: this._children.indexOf(node) },
    });
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
    // A node that is already dormant has had all of this done by despawn(); firing onDespawn again here
    // would deliver it twice.
    if (!reparent && node._spawned) {
      // Before onDespawn, and before `scene` is cleared below: a pending this.after/this.every must not
      // fire against a node no longer in the tree.
      node.scene?.cancelTimers(node);
      try { node.onDespawn(); } catch (e) { Logger.error(`Error in onDespawn for node ${node.name}: ${e}`); }
    }
    const index = this._children.indexOf(node);
    node.parent = null;
    node.scene = null;
    this._children.splice(index, 1);
    // The detach half of a re-parent is flagged so a recorder can ignore it — the addChild that follows
    // describes the same move in full.
    engineEventBus.emit('SCENE_CHANGED', {
      kind: 'structure', node,
      prop: reparent ? 'reparent-detach' : 'remove',
      prev: { parentId: this._id, index },
      next: null,
    });
  }

  /**
   * Move an existing child to a different position among its siblings.
   *
   * Purely an ordering change — no detach, no handlers, and no `structure` event, since which nodes exist
   * has not changed.
   */
  public moveChildTo(node: Node, index: number): void {
    const from = this._children.indexOf(node);
    if (from < 0) return;
    const to = Math.max(0, Math.min(index, this._children.length - 1));
    if (from === to) return;
    this._children.splice(from, 1);
    this._children.splice(to, 0, node);
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
    mat4.fromRotationTranslationScale(this._localTransform, this._quaternion, this._position, this._scale);

    if (parentWorldTransform)
      mat4.multiply(this._worldTransform, parentWorldTransform, this._localTransform);
    else
      mat4.copy(this._worldTransform, this._localTransform);

    this._worldCacheDirty = true;
    this._worldSphereDirty = true;
    this._worldBoxDirty = true;

    // Dormant subtrees are skipped: nothing reads their matrices, and spawn() recomputes them first.
    for (const child of this._children) {
      if (child._spawned)
        child.updateTransforms(this._worldTransform);
    }
  }

  private _updateWorldCache(): void {
    vec3.set(this._worldPosition, this._worldTransform[12], this._worldTransform[13], this._worldTransform[14]);
    mat4.getScaling(this._worldScale, this._worldTransform);
    // mat4.getRotation assumes an unscaled matrix: under non-uniform scale the quaternion comes back
    // skewed and non-normalized. Divide the scale out of the basis vectors before extracting it.
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

  /**
   * Destroys this node and its whole subtree: it is {@link despawn}ed immediately (onDespawn, timers
   * cancelled, physics bodies dropped) and unlinked from the scene at the next update.
   *
   * Permanent — the node cannot be brought back. For something that should reappear later, use
   * {@link despawn} and {@link spawn} instead.
   */
  public remove(): void {
    this.despawn();
    this._forEachInSubtree(n => { n._markForRemoval = true; });
  }

  /**
   * Brings a dormant node (and its subtree) back to life: it renders, updates, animates and simulates again.
   * No-op if it is already spawned.
   *
   *   this.findNode('Door').spawn();
   *
   * Fires {@link onSpawn} every time; {@link onStart} runs only on the FIRST spawn. Descendants carrying
   * their own `spawnOnStart = false` stay asleep unless `subtree` is passed.
   *
   * @param options `subtree: true` wakes every descendant, ignoring their own spawnOnStart flags.
   */
  public spawn(options: { subtree?: boolean } = {}): void {
    if (this._spawned) return;

    // Decided before anything fires: this node unconditionally (an explicit spawn overrides its own flag),
    // and each descendant only if its own spawnOnStart allows.
    const waking: Node[] = [];
    const collect = (node: Node, applySpawnRules: boolean) => {
      if (node._spawned) return;   // already awake, and so is everything beneath it
      if (applySpawnRules && !node._spawnOnStart && node._scene?.spawnRulesEnabled !== false) return;
      waking.push(node);
      for (const child of node._children) collect(child, !options.subtree);
    };
    collect(this, false);

    for (const node of waking) node._spawned = true;

    // World matrices went stale while dormant (updateTransforms skips dormant subtrees), and physics/render
    // both read them the same frame this returns.
    this.updateTransforms(this._parent ? this._parent.worldTransform : null);

    for (const node of waking) {
      // A pooled node must not resume the momentum it had when it despawned.
      if (node._body) {
        node._body.velocity.set(0, 0, 0);
        node._body.angularVelocity.set(0, 0, 0);
      }
      node._spawnNotified = true;
      try { node.onSpawn(); } catch (e) { Logger.error(`Error in onSpawn for node ${node.name}: ${e}`); }
    }

    // onStart is once per node lifetime, so a node returning from despawn does not get it again.
    if (this._scene?.hasStarted) {
      for (const node of waking) {
        if (node._hasStarted) continue;
        try {
          node._hasStarted = true;
          node.onStart();
        } catch (e) { Logger.error(`Error in onStart function for node ${node.name}: ${e}`); }
      }
    }

    engineEventBus.emit('SCENE_CHANGED', { kind: 'structure', node: this, prop: 'spawn' });
  }

  /**
   * Puts this node and its subtree to sleep without destroying it: it stops rendering, stops receiving
   * {@link onUpdate}, stops animating, and its physics body and trigger leave the world. Pending
   * {@link after}/{@link every} timers are cancelled and {@link onDespawn} fires once. No-op if it is
   * already dormant.
   *
   * The node stays in the scene tree and remains findable by name/id. Use {@link remove} instead when it
   * should never come back.
   */
  public despawn(): void {
    if (!this._spawned) return;

    this._forEachInSubtree(n => {
      // A descendant that was already dormant has had all of this done; firing its onDespawn again from
      // an ancestor's despawn would deliver the handler twice for one sleep.
      if (!n._spawned) return;

      // Before onDespawn: a pending this.after/this.every must not fire against a node that is going away.
      n._scene?.cancelTimers(n);
      try { n.onDespawn(); } catch (e) { Logger.error(`Error in onDespawn function for node ${n.name}: ${e}`); }

      // PhysicsSystem walks scene.nodes, which no longer contains this node once the flag is cleared below,
      // so this is the last chance to take its body and trigger out of the world.
      const physics = n._scene?.physics;
      if (physics) {
        if (n._body) physics.removeBody(n._body);
        if (n._trigger) physics.removeBody(n._trigger);
      }

      n._spawned = false;
      n._spawnNotified = false;   // next spawn is a new life, and gets its own onSpawn
    });

    engineEventBus.emit('SCENE_CHANGED', { kind: 'structure', node: this, prop: 'despawn' });
  }

  /**
   * Put every subtree flagged `spawnOnStart = false` to sleep, without starting anything.
   *
   * Called by `Scene.parse` so the rule takes effect the moment a scene is built: the editor and the
   * player both defer `scene.start()`, and the engine renders during the gap. Harmless to run twice.
   */
  public applySpawnRules(): void {
    if (this._scene?.spawnRulesEnabled === false) return;

    let slept = false;
    const walk = (node: Node) => {
      // `_hasStarted` means a script already spawned it explicitly; that decision wins over the flag.
      if (!node._hasStarted && !node._spawnOnStart) {
        if (node._spawned) slept = true;
        node._forEachInSubtree(n => { n._spawned = false; });
        return;
      }
      for (const child of node._children) walk(child);
    };
    walk(this);

    // Scene rebuilds its cached node lists only on a structural change, so a flag flipped without one leaves
    // a dormant node in scene.models, still rendering.
    if (slept)
      engineEventBus.emit('SCENE_CHANGED', { kind: 'structure', node: this, prop: 'sleep' });
  }

  /**
   * Fire {@link onConstruct} across this subtree, once per node, dormant nodes included.
   *
   * Driven by Scene.start (and by addChild into a running scene) rather than from the attach itself, so
   * `this.scene` is always live inside the handler.
   */
  public runConstructHandlers(): void {
    this._forEachInSubtree(n => {
      if (n._hasConstructed) return;
      n._hasConstructed = true;
      try { n.onConstruct(); } catch (e) { Logger.error(`Error in onConstruct for node ${n.name}: ${e}`); }
    });
  }

  /** Fire {@link onSpawn} across this subtree, for the nodes that are actually awake. */
  public runSpawnHandlers(): void {
    this._forEachInSubtree(n => {
      if (!n._spawned || n._spawnNotified) return;
      n._spawnNotified = true;
      try { n.onSpawn(); } catch (e) { Logger.error(`Error in onSpawn for node ${n.name}: ${e}`); }
    });
  }

  /** Applies `fn` to this node and every descendant, parents before children. */
  private _forEachInSubtree(fn: (node: Node) => void): void {
    fn(this);
    for (const child of this._children)
      child._forEachInSubtree(fn);
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
    // A node flagged dormant does not start: no onStart, and no descent into its children. onDespawn is
    // NOT fired — it never spawned. Editor scenes opt out via `scene.spawnRulesEnabled = false`.
    // `!_hasStarted` guards against undoing an explicit spawn: the start walk reaches nodes in tree order,
    // so a script spawning something declared LATER would otherwise have that reverted when it arrives.
    if (!this._hasStarted && !this._spawnOnStart && this._scene?.spawnRulesEnabled !== false) {
      this._forEachInSubtree(n => { n._spawned = false; });
      // The emit is not optional: Scene caches its node lists and rebuilds them only on a structural
      // change, so without it this node stays in scene.models and keeps drawing.
      engineEventBus.emit('SCENE_CHANGED', { kind: 'structure', node: this, prop: 'sleep' });
      return;
    }

    try {
      // Guarded so start() is idempotent — onStart is once per node lifetime.
      if (!this._hasStarted) {
        this._hasStarted = true;
        this.onStart();
      }
      for (const child of this._children)
        child.start();
    } catch (error) {
      Logger.error(`Error in onStart function for node ${this._name}: ${error}`);
    }
  }

  public update(delta: number, time: number): void {
    try {
      // Attributes user-script time separately from the rest of the node loop. Gated: two
      // performance.now() calls per node per frame.
      if (sceneStatsDetail.enabled) {
        const start = performance.now();
        this.onUpdate(delta, time);
        sceneStats.scriptMs += performance.now() - start;
      } else {
        this.onUpdate(delta, time);
      }
    } catch (error) {
      Logger.error(`Error in onUpdate function for node ${this._name}: ${error}`);
    }
  }

  /**
   * The keys this node adds on top of the common block. Subclasses override this instead of
   * reimplementing {@link serialize}. May be async. `{}` means the common block fully describes the node.
   */
  protected _serializePayload(): any | Promise<any> { return {}; }

  /**
   * Which children go into the serialized subtree. A hook because `LandscapeNode`'s generated terrain
   * chunks are children in the live tree but must never be persisted.
   */
  protected _serializableChildren(): Node[] { return this._children; }

  /**
   * Serialize this node and its subtree. Treat as final — override {@link _serializePayload} instead.
   */
  public async serialize(): Promise<any> {
    const children = await Promise.all(this._serializableChildren().map(child => child.serialize()));
    return {
      id: this._id,
      name: this._name,
      type: this._nodeType,
      position: [this._position[0], this._position[1], this._position[2]],
      rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
      scale: [this._scale[0], this._scale[1], this._scale[2]],
      children: children,
      variables: this._serializeVariables(),
      spawnOnStart: this._spawnOnStart,
      ...(await this._serializePayload()),
    };
  }

  // Editor-play path: the script is a source string in the scene JSON, compiled here. Published games ship
  // pre-compiled factories instead. A script that fails to compile is reported and skipped.
  private static _parseScript(node: Node, script: string): void {
    try {
      attachScriptFactory(node, compileScript(script));
    } catch (error) {
      Logger.error(`Error parsing script for node ${node.name}: ${error}`, 'Script');
    }
  }

  /**
   * The shared parse tail: transforms, spawn rules, variables, script fields, the script itself, physics
   * shapes, children, and finally attaching the node to its parent.
   *
   * **Attaches the node — never call `addChild` after it**, or the load fires a spurious detach +
   * reparent pair per node. `tests/nodeParse.test.ts` pins that at zero.
   */
  protected static finishParse(node: Node, parent: Node, json: any) {
    // Apply the serialized transform before anything that derives from it: the rigid body is created at
    // the node's world position/orientation, collider shapes are sized by its world scale, and children
    // compound their world transforms from this node's.
    if (json.position) node.setPosition(json.position);
    if (json.rotation) node.setRotation(json.rotation);
    if (json.scale) node.setScale(json.scale);
    node.updateTransforms(parent.worldTransform);

    // Absent in older saves, which is exactly the `true` default. Must land before the trailing addChild,
    // which may immediately start() the node.
    if (json.spawnOnStart === false) node._spawnOnStart = false;

    // Restore custom variables before scripts so onStart can read them.
    Node._parseVariables(node, json.variables);

    // Restore a class-script's native fields as own properties before the script binds, so its methods read
    // them directly (`this.speed`). The editor injects `scriptVars` at serialize time.
    Node._parseScriptVars(node, json.scriptVars);

    if (json.script)
      Node._parseScript(node, json.script);
    else {
      // No-eval (published) path: the source was stripped at publish time and lives as a real function in
      // game.scripts.js. `__sourceId` is the template's original id, the key those factories use.
      const factory = resolveNodeScript(json.__sourceId ?? json.id);
      if (factory) {
        try { attachScriptFactory(node, factory); }
        catch (e) { Logger.error(`Failed to attach script for node ${node.name}: ${e}`, 'Script'); }
      }
    }

    // Shape dimensions and offsets are authored in node-local units, so the node's world scale is applied
    // here. Rotations are scale-invariant and pass through untouched.
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
            // A capsule expands into a cylinder plus two sphere caps. `attachShape` places a shape at
            // bodyPos + bodyQuat * offset — a shape's OWN rotation never moves it (body.ts) — so the caps'
            // offsets, which run along the capsule's local Y, must be rotated here.
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
            Logger.error(`Shape type ${shape.type} not supported`, 'Physics');
        }
      }
    }

    if (json.body) {
      // setBody/setTrigger return the body they just created, so the shapes go straight onto that rather
      // than re-reading node._body, which is typed nullable.
      const body = node.setBody(
        json.body.mass,
        json.body.linearDamping,
        json.body.angularDamping,
        json.body.linearConstraints,
        json.body.angularConstraints,
        // Absent in older saves; RigidBody supplies its own defaults for them.
        json.body.friction,
        json.body.restitution,
        // Likewise for the two channels — absent means true.
        json.body.simulatePhysics,
        json.body.cameraCollision,
        // Absent in scenes saved before the ground probe existed; RigidBody defaults it to 0 (off).
        json.body.groundProbeDistance,
        // Likewise: absent means 0, which RigidBody reads as "use the engine default".
        json.body.motionSmoothing
      );
      setShapes(json.body.shapes, body);
      // AFTER every shape is attached: cannon has no centre of mass (`body.position` is it), so an
      // offset collider would otherwise leave the mass at the node origin and the geometry hanging off
      // it — which makes the body rotate until it lines up with whatever it is standing on.
      body.recenterMass();
    }

    // Triggers are deliberately NOT recentred: they are massless sensors driven straight from
    // node.worldPosition by PhysicsSystem, so there is no centre of mass to get wrong.
    if (json.trigger)
      setShapes(json.trigger.shapes, node.setTrigger());

    if (json.children) {
      for (const child of json.children)
        parseChild(node, child);
    }
    parent.addChild(node);
    node._afterParse(json);
  }

  /**
   * Post-attach restore, for state that only makes sense once the children exist and the node is in the
   * tree — `LodGroupNode` picking its initial level, `CameraNode` restoring `active` and its screen passes.
   */
  protected _afterParse(_json: any): void { }

  public static parse(parent: Node, json: any) {
    const node = new Node(json.name, json.type, json.id);
    Node.finishParse(node, parent, json);
  }

  /** This node's unique id. Stable across serialization; assigned once at construction. */
  public get id(): string { return this._id; }
  /** This node's display name. Not unique — several nodes may share one. */
  public get name(): string { return this._name; }
  public set name(name: string) {
    this._name = name;
    // The scene indexes nodes by name for getNodesByName/findNode; a rename must invalidate that index.
    engineEventBus.emit('SCENE_CHANGED', { kind: 'name', node: this });
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
   * {@link removeChild} and their bookkeeping. Treat it as read-only, and copy it before a loop that may
   * add or remove children.
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
    this._notifyChange('variable', name, existing?.value, value);
  }
  public removeVariable(name: string): void {
    const existing = this._variables.get(name);
    this._variables.delete(name);
    this._notifyChange('variable', name, existing?.value, undefined);
  }

  // --- Scene lookups ----------------------------------------------------------------------------
  // Real methods, not conveniences synthesized by the script proxy: a CLASS-based script runs natively on
  // the node, so without these `this.findNode('Player')` would not exist there. The proxy still intercepts
  // these names ahead of the node, so a legacy script keeps getting access-checked proxies back.

  /**
   * The first node in this node's scene named `name`, or `undefined`. Searches the whole scene, not just
   * this node's children — for those, use {@link getChildByName}.
   *
   *   this.findNode('Door').spawn();
   */
  public findNode(name: string): Node | undefined {
    return this._scene?.findNode(name);
  }

  /** Every node in this node's scene named `name` — names are not unique. Empty if none match. */
  public getNodesByName(name: string): Node[] {
    return this._scene?.getNodesByName(name) ?? [];
  }

  /** The node with this unique id anywhere in the scene, or `undefined`. */
  public getNodeById(id: string): Node | undefined {
    return this._scene?.getNodeById(id);
  }

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
   * script's methods read/write them directly (`this.speed`) rather than through the {@link _variables}
   * Map, which stays for the editor-created variable system.
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
   * Whether this node is awake: rendering, updating, and simulating. `false` means it is dormant — placed in
   * the scene but asleep, either because {@link spawnOnStart} was off or because something called
   * {@link despawn}. Read-only; use {@link spawn} / {@link despawn} to change it.
   */
  public get spawned(): boolean { return this._spawned; }

  /**
   * Whether this node wakes up on its own when the scene starts (default `true`).
   *
   * `false` authors a node in place — positioned, textured, scripted, with its collider — that stays
   * dormant until a script calls {@link spawn} on it. It does not render, update, animate or collide, but
   * IS findable by name and id. Editing scenes ignore the flag (see `Scene.spawnRulesEnabled`).
   */
  public get spawnOnStart(): boolean { return this._spawnOnStart; }
  public set spawnOnStart(value: boolean) {
    const prev = this._spawnOnStart;
    this._spawnOnStart = value;
    this._notifyChange('component', 'spawnOnStart', prev, value);
  }

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
   * actually faces in the world, use {@link worldForward}. Allocates a new vector on every read.
   */
  public get forward(): vec3 {
    let forward = vec3.fromValues(0, 0, 1);
    vec3.transformMat4(forward, forward, this._rotationMatrix);
    vec3.normalize(forward, forward);
    return forward;
  }

  // The four world-space getters below share one contract: each returns the LIVE cached vector, filled
  // lazily on first read after a transform change. Never mutate one and never hold it across a frame —
  // the cache is rewritten in place. Copy with `vec3.clone` to keep a value.

  /**
   * This node's position in world space, with every ancestor transform applied. Live cached reference.
   * To *move* the node, set {@link position} (local space); there is no world-space position setter.
   */
  public get worldPosition(): vec3 {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldPosition;
  }

  /**
   * This node's orientation in world space, normalized and correct under non-uniform ancestor scale.
   * Live cached reference.
   */
  public get worldQuaternion(): quat {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldQuaternion;
  }

  /**
   * This node's accumulated scale in world space (its own scale times every ancestor's).
   * Live cached reference.
   */
  public get worldScale(): vec3 {
    if (this._worldCacheDirty) this._updateWorldCache();
    return this._worldScale;
  }

  /**
   * Unit +Z axis of this node's world orientation — the direction it actually faces in the scene.
   * Prefer this over {@link forward}, which ignores parent transforms. Live cached reference.
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
    vec3.add(this._position, this._position, vec3.scale(vec3.create(), this.forward, value));
    this._updateTranslationMatrix();
  }

  /** Moves by `value` along this node's own right vector (perpendicular to `forward`) — "strafe". */
  public addRight(value: number) {
    vec3.normalize(this.forward, this.forward);
    let right = vec3.cross(vec3.create(), this.forward, vec3.fromValues(0, 1, 0));
    vec3.normalize(right, right);
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

  /**
   * Notify observers (the editor) that a *property* of this node changed, of the given {@link ChangeKind}.
   * Gated on {@link authoring.enabled}, so it is a complete no-op outside the editor's edit mode.
   * Structural changes do NOT go through here: they emit unconditionally, because the Scene relies on
   * them to re-filter its node lists.
   *
   * `prop`/`prev`/`next` are optional detail — a variable name and its old/new value, say.
   */
  protected _notifyChange(kind: ChangeKind, prop?: string, prev?: unknown, next?: unknown): void {
    if (authoring.enabled)
      engineEventBus.emit('SCENE_CHANGED', { kind, node: this, prop, prev, next });
  }

  private _updateTranslationMatrix(): void {
    if (this._body)
      this._body.setPosition(this._position);

    mat4.fromTranslation(this._translationMatrix, this._position);
    this._notifyChange('transform', 'position');
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
   * **yaw = +/-90 degrees**, not pitch. Use `setQuaternion` for orientations that pass through it.
   */
  public setRotation(value: vec3): Node {
    vec3.copy(this._euler, value);
    this._updateRotationMatrix();
    return this;
  }

  /**
   * Sets local-space rotation directly as a quaternion — use this over setRotation to avoid gimbal lock.
   *
   * Keeps `_euler` in sync with the quaternion, because the two are parallel state: without the sync a
   * later `rotateY()` would compose from whatever euler was last written. The euler that comes back is
   * not necessarily the one a caller would have written, but it describes the same rotation.
   *
   * Deliberately does NOT push into the physics body, unlike the `setRotation` path.
   */
  public setQuaternion(quaternion: quat): Node {
    quat.copy(this._quaternion, quaternion);
    eulerFromQuatDeg(this._euler, this._quaternion);
    mat4.fromQuat(this._rotationMatrix, this._quaternion);
    this._notifyChange('transform', 'rotation');
    return this;
  }
  
  private _updateRotationMatrix(): void {
    quat.fromEuler(this._quaternion, this._euler[0], this._euler[1], this._euler[2]);
    if (this._body) this._body.setQuaternion(this._quaternion);
    mat4.fromQuat(this._rotationMatrix, this._quaternion);
    this._notifyChange('transform', 'rotation');
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
    this._notifyChange('transform', 'scale');
  }

  /** This node's rigid body, or `null` if it has none. See {@link setBody}. */
  public get body(): RigidBody | null { return this._body; }

  /**
   * True when this node's rigid body is resting on something solid in the CURRENT gravity direction —
   * "down" is the world's gravity vector, not -Y, so inverted or sideways gravity behaves correctly and
   * nothing is grounded under zero gravity. Answered from physics contacts; always false without a body.
   *
   *   if (this.isGrounded) this.velocity = [v[0], JUMP_SPEED, v[2]];
   *
   * Allows a ~0.1s grace after the last ground contact (see PhysicsSystem's GROUND_GRACE), so it stays
   * true briefly after walking off a ledge — use {@link isFalling} to ask about falling.
   */
  public get isGrounded(): boolean {
    if (!this._body) return false;
    return this._scene?.physics?.isGrounded(this._body) ?? false;
  }

  /**
   * Surface normal of the ground this node is standing on, pointing up out of it: `[0, 1, 0]` on level
   * ground under normal gravity, tilted on a slope. Project a movement direction onto it to move ALONG
   * the ground rather than through it.
   *
   * Falls back to up (gravity reversed) when airborne, bodyless, or under zero gravity, so that projection
   * is a no-op in those cases. Returns a fresh vec3.
   */
  public get groundNormal(): vec3 {
    const up = vec3.fromValues(0, 1, 0);
    if (!this._body) return up;
    return this._scene?.physics?.groundNormal(this._body) ?? up;
  }

  /**
   * This node's world-space velocity, in units per second. Assigning drives the body — the component
   * along gravity is yours to preserve, which is what keeps falling and jumping intact while steering:
   *
   *   const v = this.velocity;
   *   this.velocity = [dirX * speed, v[1], dirZ * speed];
   *
   * A fresh vector each read. Assigning to a node with no body does nothing.
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
   * This node's angular velocity in radians per second, about each world axis. `[0, 2, 0]` is spinning
   * anticlockwise about the world up at 2 rad/s.
   *
   * Commanded, not measured: a body whose `angularConstraints` lock an axis still reports whatever was
   * written to it — {@link turnRate} is what the node actually did. A fresh vector each read.
   */
  public get angularVelocity(): vec3 {
    if (!this._body) return vec3.create();
    const a = this._body.angularVelocity;
    return vec3.fromValues(a.x, a.y, a.z);
  }
  public set angularVelocity(value: vec3) {
    this._body?.angularVelocity.set(value[0], value[1], value[2]);
  }

  // ---- Measured motion -------------------------------------------------------------------------------
  //
  // How fast this node is ACTUALLY moving, measured from its body's position delta each physics step.
  //
  // The counterpart to `velocity`, which is what the body was TOLD to do: these read ~0 while a character
  // is jammed against a wall, and anything that stops you shows up here.
  //
  // All are safe on a node with no body (0 or a zero vector) and every vector is a fresh copy. Bind
  // animation to the smoothed family (`currentVelocity` and what derives from it); `rawVelocity` /
  // `rawSpeed` are the unfiltered per-frame values. See physics/motion.ts for the filtering.

  /** The physics motion record for this node's body, or null. */
  private get _motion(): MotionRecord | null {
    if (!this._body) return null;
    return this._scene?.physics?.motionOf(this._body) ?? null;
  }

  /** World "up" — gravity reversed. Everything planar below is measured against it, not against +Y. */
  private get _up(): vec3 {
    return this._scene?.physics?.up ?? vec3.fromValues(0, 1, 0);
  }

  /**
   * Smoothed measured world velocity, in units per second.
   *
   *   // pressing forward but going nowhere: something is in the way
   *   const stuck = this.moveInput && this.currentSpeed < 0.1;
   */
  public get currentVelocity(): vec3 {
    const m = this._motion;
    return m ? vec3.clone(m.smooth) : vec3.create();
  }

  /** Unfiltered measured world velocity — this frame's delta, no smoothing. */
  public get rawVelocity(): vec3 {
    const m = this._motion;
    return m ? vec3.clone(m.raw) : vec3.create();
  }

  /**
   * How fast this node is actually moving, in units per second. `0` when it is standing still, blocked, or
   * has no body — regardless of what its velocity was set to.
   */
  public get currentSpeed(): number {
    const m = this._motion;
    return m ? vec3.length(m.smooth) : 0;
  }

  /** Unfiltered {@link currentSpeed}, for logic that cannot afford the ~90ms smoothing lag. */
  public get rawSpeed(): number {
    const m = this._motion;
    return m ? vec3.length(m.raw) : 0;
  }

  /**
   * Actual speed across the ground plane — the component perpendicular to gravity. This, not
   * {@link currentSpeed}, is what a locomotion blend wants: falling is fast.
   */
  public get planarSpeed(): number {
    const m = this._motion;
    if (!m) return 0;
    return vec3.length(planarSplit(m.smooth, this._up).planar);
  }

  /**
   * Signed actual speed along gravity — positive rising, negative falling. Correct under any gravity
   * direction, unlike `velocity[1]`, and measured rather than commanded: a body pressed into the floor
   * reports ~0.
   */
  public get verticalSpeed(): number {
    const m = this._motion;
    if (!m) return 0;
    return planarSplit(m.smooth, this._up).vertical;
  }

  /**
   * Unit vector pointing where this node is actually travelling.
   *
   * Holds its last value while the node is still, rather than snapping to zero — see MIN_DIRECTION_SPEED.
   * Zero vector only if the node has never moved at all.
   */
  public get currentDirection(): vec3 {
    const m = this._motion;
    return m ? vec3.clone(m.heading) : vec3.create();
  }

  /** {@link currentDirection} flattened onto the ground plane. Also holds its last value while still. */
  public get planarDirection(): vec3 {
    const m = this._motion;
    return m ? vec3.clone(m.planarHeading) : vec3.create();
  }

  /**
   * Where this node is travelling relative to where it is FACING, in degrees: `0` straight ahead,
   * **`-90` strafing RIGHT, `+90` strafing LEFT**, `±180` backpedalling.
   *
   * **Mind the sign.** Angles here are counter-clockwise, sharing the engine's yaw convention
   * (`atan2(x, z)`, see {@link worldPlanarAngle}): with forward `+Z` and up `+Y` a node's right is
   * `forward x up` = `-X`, so turning right is a NEGATIVE rotation. Lay a strafe blend space out
   * accordingly, or its left and right clips play mirrored.
   *
   * The node's own heading comes from {@link worldForward}, never `rotation[1]`: euler composition is
   * Rz·Ry·Rx, so past a quarter turn a quaternion-oriented node's yaw folds into pitch and roll.
   */
  public get planarAngle(): number {
    const m = this._motion;
    if (!m) return 0;
    return signedAngleBetween(this.worldForward, m.planarHeading, this._up);
  }

  /**
   * Absolute heading of travel, in degrees, in the same convention as a node's yaw — so it can be assigned
   * straight to `setRotation([0, angle, 0])` to face that way. Independent of which way this node is facing.
   */
  public get worldPlanarAngle(): number {
    const m = this._motion;
    if (!m) return 0;
    return headingAngle(m.planarHeading, this._up);
  }

  /**
   * Signed speed along the way this node is FACING: positive walking forward, **negative backpedalling**,
   * ~0 while strafing dead sideways.
   *
   * The only speed here that can go negative — {@link planarSpeed}, {@link currentSpeed} and
   * {@link rawSpeed} are vector magnitudes, so a blend-space sample authored at a negative speed on one of
   * those axes sits where the probe can never reach.
   *
   * A locomotion blend space uses one of two layouts, and mixing them is the trap:
   *
   *   - `forwardSpeed` x {@link lateralSpeed} — signed on both axes, neither wrapping.
   *   - {@link planarAngle} x `planarSpeed` — direction and magnitude, backwards at ±180 on a WRAPPING
   *     direction axis (`AnimationFieldAxis.wrap`).
   */
  public get forwardSpeed(): number {
    const m = this._motion;
    if (!m) return 0;
    return facingComponents(m.smooth, this.worldForward, this._up).forward;
  }

  /**
   * Signed speed across this node's facing — the strafe axis. ~0 walking straight ahead or straight back.
   *
   * **Mind the sign: positive is LEFT.** It shares the counter-clockwise convention of {@link planarAngle},
   * so `atan2(lateralSpeed, forwardSpeed)` in degrees is exactly `planarAngle` and a blend laid out with
   * these two axes agrees with one laid out as angle-and-speed about which side is which.
   */
  public get lateralSpeed(): number {
    const m = this._motion;
    if (!m) return 0;
    return facingComponents(m.smooth, this.worldForward, this._up).lateral;
  }

  // ---- Measured motion: change over time -------------------------------------------------------------
  //
  // Everything above answers "what is this node doing"; these answer "what is it in the middle of doing" —
  // `planarSpeed` says WHERE on the curve, these say WHICH WAY along it, which is what tells a character
  // breaking into a run from one already running at that speed.
  //
  // All measured, all smoothed, all safe on a bodyless node. See physics/motion.ts for the filtering, and
  // `Body.motionSmoothing` to retune it per character.

  /**
   * How hard this node is speeding up or slowing down across the ground plane, in units/second^2. Positive
   * accelerating, negative braking, ~0 at a steady pace or standing still.
   *
   *   // "start running" fires while the character is still slow but clearly committing to it
   *   Idle -> StartRun  when  isMoving AND planarAcceleration > 2
   */
  public get planarAcceleration(): number {
    return this._motion?.accel ?? 0;
  }

  /**
   * True while this node is deliberately gaining planar speed. {@link planarAcceleration} past a threshold
   * (`Body.motionSmoothing`'s config owns the threshold), so it does not fire on solver noise.
   */
  public get isAccelerating(): boolean {
    const m = this._motion;
    return !!m && m.accel > this._motionThresholds.accelThreshold;
  }

  /** True while this node is deliberately losing planar speed — what a stop/skid animation waits for. */
  public get isDecelerating(): boolean {
    const m = this._motion;
    return !!m && m.accel < -this._motionThresholds.accelThreshold;
  }

  /**
   * Whether this node counts as moving across the ground, with hysteresis: the threshold to start moving
   * is higher than the threshold to stop, so a node drifting near it reports one steady answer.
   */
  public get isMoving(): boolean {
    return this._motion?.moving ?? false;
  }

  /** Seconds this node has been continuously {@link isMoving}; 0 while still. */
  public get movingTime(): number {
    return this._motion?.movingTime ?? 0;
  }

  /**
   * Seconds this node has been continuously NOT {@link isMoving}; 0 while moving. The right gate for
   * "settle into idle", where a bare `planarSpeed < 0.1` fires on the first frame it dips.
   */
  public get stillTime(): number {
    return this._motion?.stillTime ?? 0;
  }

  /**
   * How fast this node is turning, in degrees per second, signed. Measured from its body's FACING, not its
   * direction of travel, so it is non-zero for a character turning in place. Wrap-safe: a turn through
   * ±180 reports its true rate rather than a full-circle spike.
   */
  public get turnRate(): number {
    return this._motion?.turnRate ?? 0;
  }

  /** Magnitude of this node's angular velocity, in radians/second. Commanded (solver state), not measured. */
  public get angularSpeed(): number {
    if (!this._body) return 0;
    const a = this._body.angularVelocity;
    return Math.hypot(a.x, a.y, a.z);
  }

  /**
   * True while this node is genuinely falling: off the ground and losing height.
   *
   * Ask this rather than `!isGrounded`, which holds true for a ~0.1s grace after the last ground contact
   * and goes false the instant a character jumps — so its negation reports a fall on the way UP.
   */
  public get isFalling(): boolean {
    return !this.isGrounded && this.verticalSpeed < FALLING_SPEED;
  }

  /** Seconds this node has been continuously airborne (past the grounded grace); 0 while grounded. */
  public get airTime(): number {
    if (!this._body) return 0;
    return this._scene?.physics?.airborneTimes(this._body).airTime ?? 0;
  }

  /** Seconds this node has been continuously grounded; 0 while airborne. */
  public get groundedTime(): number {
    if (!this._body) return 0;
    return this._scene?.physics?.airborneTimes(this._body).groundedTime ?? 0;
  }

  /**
   * Distance from this node's collider to the ground below it, in world units, or `-1` when unknown.
   *
   * Requires a `groundProbeDistance` on the body, and is capped by it — so it answers "how close to
   * landing", not "how high up". `-1`, never 0, for unknown: 0 means resting on the ground.
   */
  public get groundDistance(): number {
    if (!this._body) return -1;
    return this._scene?.physics?.groundDistance(this._body) ?? -1;
  }

  /**
   * Tilt of the ground under this node, in degrees from level: 0 on the flat, 90 against a wall.
   * Derived from {@link groundNormal}, so it reads 0 while airborne (that normal falls back to up).
   */
  public get slopeAngle(): number {
    const n = this.groundNormal;
    const up = this._up;
    const d = Math.max(-1, Math.min(1, vec3.dot(vec3.normalize(vec3.create(), n), up)));
    return Math.acos(d) * 180 / Math.PI;
  }

  /** Motion thresholds in force for this node's body, defaulted when it set none. */
  private get _motionThresholds(): MotionConfig {
    const tau = this._body?.motionSmoothing ?? 0;
    return motionConfig(tau > 0 ? { tau } : null);
  }

  /**
   * Gives this node a rigid body, created at its current world position and orientation, and wires
   * {@link onCollision}. The body drives the node's transform from here on.
   *
   * The body is built from the node's world transform at call time, so set the node's transform *before*
   * calling this. Only meaningful on root-level nodes — a body on a child node does not track its parent.
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
   * @param groundProbeDistance Meters below the collider's feet that still count as grounded, default
   *                          `0` (off — grounding uses solver contacts only). A small value (~0.1–0.2)
   *                          removes `isGrounded` flicker for a character resting on terrain by probing
   *                          the ground each frame instead of trusting the solver's resting contact.
   * @param motionSmoothing   Time constant in seconds for this body's MEASURED motion — `currentSpeed`,
   *                          `planarAcceleration`, `turnRate` and everything else derived from its position
   *                          delta. Default `0` = the engine's ~90ms. Raise it when a blend driven off those
   *                          values vibrates; lower it when a script needs a faster answer.
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
    cameraCollision?: boolean,
    groundProbeDistance?: number,
    motionSmoothing?: number
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
      simulatePhysics, cameraCollision,
      groundProbeDistance, motionSmoothing
    }, this);

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

    this._trigger.addEventListener('collide', (event: any) => {
      if (event.body instanceof RigidBody || event.body instanceof Trigger)
        this.onTrigger(event.body.owner);
    });

    return this._trigger;
  }

  // These four return the node's LIVE internal vectors, so writing through them — `node.position[0] += 1`
  // — skips the setters' bookkeeping: the local matrix is not recomposed and nothing is pushed into the
  // physics body. Read through them; write with setPosition/setRotation/setQuaternion/setScale.

  /** Local-space position, relative to the parent. Live reference — write with {@link setPosition}. */
  public get position(): vec3 { return this._position; }
  /**
   * Local-space rotation as Euler angles in DEGREES `[pitch, yaw, roll]`.
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
    engineEventBus.emit('SCENE_CHANGED', { kind: 'visibility', node: this });
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
   * Cached against `_worldBoxDirty`, so the returned object is a **live reference rewritten in place**.
   * Clone it to keep a box across frames or to compare two nodes' boxes.
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
   *
   * Returns a live cached reference — callers must not mutate it.
   */
  public getBoundingSphere(): { center: vec3; radius: number } {
    if (!this._worldSphereDirty) return this._worldSphere;
    const scale = this.worldScale;
    const maxScale = Math.max(Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2]));
    vec3.copy(this._worldSphere.center, this.worldPosition);
    // Half-diagonal of the scaled unit cube: 0.5 * sqrt(3) per axis, times the largest world scale.
    this._worldSphere.radius = 0.5 * Math.sqrt(3) * maxScale;
    this._worldSphereDirty = false;
    return this._worldSphere;
  }

  /**
   * Force the next {@link getBoundingSphere} / {@link getBoundingBox} to recompute.
   *
   * The world caches are normally invalidated by `updateTransforms`. Editing the underlying VERTICES moves
   * the bounds without moving the node, so call this after such an edit (see `Geometry.invalidateBounds`
   * for the object-space half).
   */
  public invalidateWorldBounds(): void {
    this._worldSphereDirty = true;
    this._worldBoxDirty = true;
  }
}
