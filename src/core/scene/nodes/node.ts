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
 * Downward speed (units/s, gravity-relative) past which {@link Node.isFalling} reports true.
 *
 * Not zero: a body resting on a surface is pressed into it by gravity every step and measures a small
 * downward drift, so a zero threshold would call a standing character a falling one.
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

  // Spawn lifecycle. `_spawnOnStart` is authored (inspector + serialized); `_spawned` is the runtime state.
  // Both default to the pre-existing behaviour — every node that never touches them is spawned, always —
  // so old scenes and code-built scenes are unaffected. A dormant node is dropped from the scene's derived
  // lists (Scene._filterByType), which is what makes despawn cover EVERY consumer at once rather than the
  // subset that happens to check `visible`.
  protected _spawnOnStart: boolean = true;
  protected _spawned: boolean = true;
  // onConstruct is once per node per scene load, so it needs its own latch — _hasStarted cannot serve, since
  // a dormant node receives onConstruct and never starts.
  protected _hasConstructed: boolean = false;
  // onSpawn is once per LIFE: set when it fires, cleared by despawn. Without it a node woken from another
  // node's onConstruct would get onSpawn from spawn() and again from Scene.start's spawn pass.
  protected _spawnNotified: boolean = false;

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
   * Called once for **every** node in the scene, spawned or not — the one handler a dormant node still
   * receives. Runs before {@link onSpawn} and {@link onStart}, with {@link scene} already available.
   *
   * This is where a node decides its own fate, since a node flagged `spawnOnStart = false` gets no other
   * handler until something wakes it:
   *
   *   onConstruct() {
   *     if (Game.difficulty > 2) this.spawn();
   *   }
   *
   * Fires once per node per scene load, never again — not on re-parenting, and not on a later
   * spawn/despawn cycle. Note that a script class is never CONSTRUCTED (its methods are bound onto the
   * live node), so this, not a `constructor()`, is the hook that replaces one.
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
   * {@link onConstruct} and before {@link onStart}. A node that is despawned and spawned again gets a fresh
   * one, so this is the place for per-life setup (reset health, clear state); use {@link onStart} for setup
   * that must happen only once, and {@link onConstruct} for anything a dormant node must still do.
   *
   * Re-parenting does not re-fire it: moving a node in the tree does not begin a new life.
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
   *              Undo/redo passes it so restoring a deleted node puts it back where it was rather than
   *              at the end of its siblings.
   */
  public addChild(node: Node, index?: number): void {
    // Where it came from, captured before the detach so the structural event below can describe the whole
    // move as one edit. A recorder that saw only "removed" then "added" would need two undos to put a
    // re-parented node back, and one undo would leave it detached.
    const from = node.parent
      ? { parentId: node.parent.id, index: node.parent._children.indexOf(node) }
      : null;

    // if the node already has a parent, remove it from the parent's children
    if (node.parent) {
      // removeChild emits the detach itself (flagged `reparent-detach`); the emit that used to be
      // duplicated here was byte-identical to it.
      node.parent.removeChild(node, true);
    }

    node.parent = this;
    if (index === undefined || index < 0 || index >= this._children.length) this._children.push(node);
    else this._children.splice(index, 0, node);

    // Scene FIRST, then the handlers. onStart routinely calls this.after/this.every, and those go through
    // `this.scene` — running start() before the scene was attached made every timer scheduled from onStart
    // a silent no-op. It is also what lets start() below read `scene.spawnRulesEnabled`.
    if (this.scene)
      node.scene = this.scene;

    // Only when the scene is already running. During a scene LOAD the parent has not started yet and every
    // node is attached before Scene.start runs the three passes over the finished tree — firing here as well
    // would deliver each handler twice (a descendant fires on its own attach, then again on its parent's).
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
      // The real landing slot, not `length - 1`: an indexed insert (a drag that drops a row *between* two
      // siblings) reports where it actually went, so undo/redo puts it back there rather than at the end.
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
    // A node that is already dormant has had all of this done by despawn() — firing onDespawn again here is
    // what used to make node.remove() deliver it twice (remove() fires it, then the Scene.update sweep
    // reached this line).
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
    // The detach half of a re-parent is flagged so a recorder can ignore it: the addChild that follows
    // describes the same move in full, and treating both as edits would need two undos to reverse one.
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
   * Purely an ordering change — no detach, no handlers, and deliberately no `structure` event, because
   * nothing about which nodes exist has changed. Used by undo to restore sibling order after a subtree
   * has been re-parsed in place (parsing always appends).
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

    // Dormant subtrees cost nothing per frame — nothing reads their matrices while they are asleep, and
    // spawn() recomputes them before anything can.
    for (const child of this._children) {
      if (child._spawned)
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

  /**
   * Destroys this node and its whole subtree: it is {@link despawn}ed immediately (onDespawn, timers
   * cancelled, physics bodies dropped) and unlinked from the scene at the next update.
   *
   * This is permanent — the node cannot be brought back. For something that should reappear later (a pooled
   * projectile, a door, an enemy wave), use {@link despawn} and {@link spawn} instead.
   */
  public remove(): void {
    this.despawn();
    this._forEachInSubtree(n => { n._markForRemoval = true; });
  }

  /**
   * Brings a dormant node (and its subtree) back to life: it renders, updates, animates and simulates again.
   * No-op if it is already spawned.
   *
   * Fires {@link onSpawn} every time. {@link onStart} runs only on the FIRST spawn — a node returning from
   * despawn keeps whatever state it had, so put per-life setup in `onSpawn` and one-time setup in `onStart`.
   *
   *   this.findNode('Door').spawn();
   *
   * Descendants that carry their own `spawnOnStart = false` stay asleep, so waking a spawner does not fire
   * every projectile parked under it. Pass `{ subtree: true }` when you mean the whole group instead:
   *
   *   this.findNode('EnemyCamp').spawn({ subtree: true });
   *
   * @param options `subtree: true` wakes every descendant, ignoring their own spawnOnStart flags.
   */
  public spawn(options: { subtree?: boolean } = {}): void {
    if (this._spawned) return;

    // Exactly which nodes wake, decided before anything fires: this one unconditionally — an explicit spawn
    // overrides its own flag, or it could never be woken at all — and each descendant only if its own
    // spawnOnStart allows. Waking a spawner must not fire every projectile parked under it.
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
      // A pooled node must not resume the momentum it had when it despawned. The body re-enters the world on
      // the next PhysicsSystem.update, which finds it through the scene lists this node just rejoined.
      if (node._body) {
        node._body.velocity.set(0, 0, 0);
        node._body.angularVelocity.set(0, 0, 0);
      }
      node._spawnNotified = true;
      try { node.onSpawn(); } catch (e) { Logger.error(`Error in onSpawn for node ${node.name}: ${e}`); }
    }

    // onStart is once per node lifetime, so a node returning from despawn does not get it again — and none
    // of this runs before the scene itself starts, which will reach these nodes on its own.
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
   * The node stays in the scene tree and remains findable by name/id, so a script can always
   * {@link spawn} it again. Use {@link remove} instead when it should never come back.
   *
   *   this.findNode('Enemy').despawn();
   */
  public despawn(): void {
    if (!this._spawned) return;

    this._forEachInSubtree(n => {
      // A descendant that was already dormant on its own has had all of this done — firing its onDespawn
      // again from an ancestor's despawn would deliver the handler twice for one sleep.
      if (!n._spawned) return;

      // Before onDespawn: a pending this.after/this.every must not fire against a node that is going away.
      n._scene?.cancelTimers(n);
      try { n.onDespawn(); } catch (e) { Logger.error(`Error in onDespawn function for node ${n.name}: ${e}`); }

      // PhysicsSystem walks scene.nodes, which no longer contains this node once the flag is cleared below —
      // so it will never get another chance to drop these itself. Without this the collider keeps blocking
      // and colliding while its mesh is gone.
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
   * Called by `Scene.parse` so the rule takes effect the moment a scene is built rather than at
   * `scene.start()`. Both the editor and the player defer that start behind a timeout, and the engine
   * renders during the gap — so a pool of dormant nodes would otherwise be drawn for a beat and then pop
   * out of existence. Harmless to run twice; `start()` reaches the same state on its own.
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
   * Driven by Scene.start (and by addChild for a node added to a running scene) rather than from the attach
   * itself, so `this.scene` is always live inside the handler — during a load a node is attached to its
   * parent before that parent joins the scene, so at attach time a nested node cannot see the scene at all.
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
    // A node flagged dormant does not start: no onStart, and no descent into its children (a subtree under a
    // dormant root is dormant too). onDespawn is deliberately NOT fired — it never spawned, so there is
    // nothing to tear down. Editor scenes opt out via `scene.spawnRulesEnabled = false` so a node the user
    // has flagged dormant still shows and can be selected while authoring. {@link spawn} is the way past
    // this, and it bypasses the check rather than going through here.
    // `!_hasStarted` guards against undoing an explicit spawn: the scene's start walk reaches nodes in tree
    // order, so a script that spawns something declared LATER in the tree would otherwise have its work
    // reverted a moment later when the walk arrives and re-applies the flag.
    if (!this._hasStarted && !this._spawnOnStart && this._scene?.spawnRulesEnabled !== false) {
      this._forEachInSubtree(n => { n._spawned = false; });
      // The emit is not optional. Scene caches its node lists and only rebuilds them on a structural change;
      // by the time start() runs, the play bootstrap has already rendered frames (setScene -> update, then a
      // deferred start()), so those lists exist and still hold this node. Without this it stays in
      // scene.models forever and keeps drawing, despawned in name only.
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
      // Attributes user-script time separately from the rest of the node loop. Gated because it is
      // two performance.now() calls per node per frame — cheap, but not free on a large scene.
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
   * reimplementing {@link serialize}.
   *
   * May be async: `LightNode` builds its payload from a switch, and nothing stops an override from
   * awaiting. Returning `{}` (the default) means the node is fully described by the common block.
   */
  protected _serializePayload(): any | Promise<any> { return {}; }

  /**
   * Which children go into the serialized subtree.
   *
   * A hook because `LandscapeNode` subdivides itself into generated terrain chunks that are children in the
   * live tree but must never be persisted — they are rebuilt from the heightfield on load.
   */
  protected _serializableChildren(): Node[] { return this._children; }

  /**
   * Serialize this node and its subtree.
   *
   * Deliberately `final` in spirit: every subclass used to carry a byte-identical copy of the nine common
   * keys and append its own on the end — thirteen copies of the same block, which is precisely the kind of
   * duplication that made this file unmanageable. Override {@link _serializePayload} instead.
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

  /**
   * The shared parse tail: transforms, spawn rules, variables, script fields, the script itself, physics
   * shapes, children, and finally attaching the node to its parent.
   *
   * **Attaches the node — never call `addChild` after it.** Eight subclasses used to, adding the node a
   * second time and firing a spurious detach + reparent pair per node on every scene load. `tests/
   * nodeParse.test.ts` pins that at zero.
   */
  protected static finishParse(node: Node, parent: Node, json: any) {
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

    // Absent in scenes saved before the spawn lifecycle existed, which is exactly the `true` default — so
    // every pre-existing scene keeps spawning everything. Must land before the trailing addChild, which is
    // what may immediately start() the node.
    if (json.spawnOnStart === false) node._spawnOnStart = false;

    // Restore custom variables before scripts so onStart can read them.
    Node._parseVariables(node, json.variables);

    // Restore a class-script's native fields as own properties before the script binds, so its methods
    // read them directly (`this.speed`). The editor injects `scriptVars` at serialize time (like it injects
    // `script`), reading each schema field off the node — the engine never has to know the field schema.
    Node._parseScriptVars(node, json.scriptVars);

    if (json.script)
      Node._parseScript(node, json.script);
    else {
      // No-eval (published) path: the source was stripped at publish time and lives as a real function in
      // game.scripts.js. Doing this HERE rather than in a pass over the finished scene is what makes a node
      // created later — by Scene.instantiate — get its script too; `__sourceId` is the template's original
      // id, which is the key those factories are registered under.
      const factory = resolveNodeScript(json.__sourceId ?? json.id);
      if (factory) {
        try { attachScriptFactory(node, factory); }
        catch (e) { Logger.error(`Failed to attach script for node ${node.name}: ${e}`, 'Script'); }
      }
    }

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
            Logger.error(`Shape type ${shape.type} not supported`, 'Physics');
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
        json.body.cameraCollision,
        // Absent in scenes saved before the ground probe existed; RigidBody defaults it to 0 (off).
        json.body.groundProbeDistance,
        // Likewise: absent means 0, which RigidBody reads as "use the engine default".
        json.body.motionSmoothing
      ));
    }

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
   *
   * This hook is why a subclass's `static parse` is now only ever *construct then finishParse*: work that
   * used to trail after the `finishParse` call had a habit of trailing a stray `parent.addChild` with it.
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
    // The scene indexes nodes by name for getNodesByName/findNode; a rename must invalidate that
    // exactly like the visible setter already invalidates scene-derived state below.
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
    this._notifyChange('variable', name, existing?.value, value);
  }
  public removeVariable(name: string): void {
    const existing = this._variables.get(name);
    this._variables.delete(name);
    this._notifyChange('variable', name, existing?.value, undefined);
  }

  // --- Scene lookups ----------------------------------------------------------------------------
  // Real methods, not just conveniences synthesized by the legacy script proxy (wrapNode). A CLASS-based
  // script runs natively on the node — no proxy — so without these `this.findNode('Player')` is simply not a
  // function there, while the identical line works in a legacy `this.onStart = ...` script. The proxy still
  // intercepts these names ahead of the node, so a legacy script keeps getting access-checked proxies back.

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
   * Whether this node is awake: rendering, updating, and simulating. `false` means it is dormant — placed in
   * the scene but asleep, either because {@link spawnOnStart} was off or because something called
   * {@link despawn}. Read-only; use {@link spawn} / {@link despawn} to change it.
   */
  public get spawned(): boolean { return this._spawned; }

  /**
   * Whether this node wakes up on its own when the scene starts (default `true`).
   *
   * Set it `false` to author a node in place — positioned, textured, scripted, with its collider — that stays
   * dormant until a script calls {@link spawn} on it. Nothing else can wake it: it does not render, update,
   * animate or collide, and its {@link onStart} has not run yet. It IS still findable by name and id, which
   * is how a script gets hold of it:
   *
   *   this.findNode('Enemy').spawn();
   *
   * Editing scenes ignore this flag (see `Scene.spawnRulesEnabled`) so the node stays visible in the editor.
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

  /**
   * Notify observers (the editor) that a *property* of this node changed, of the given {@link ChangeKind}.
   * Gated on {@link authoring.enabled}: outside the editor's edit mode this is a complete no-op, so
   * the setters that call it — run every frame by scripts and physics — allocate nothing and never touch
   * the bus in Play mode or a published game. Structural changes do NOT go through here; they emit
   * unconditionally because the Scene relies on them to re-filter its node lists.
   *
   * `prop`/`prev`/`next` are optional detail (e.g. a variable name and its old/new value) — enough for a
   * panel to refresh precisely and for a future undo/redo recorder to build the inverse edit.
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
   * This node's angular velocity in radians per second, about each world axis. `[0, 2, 0]` is spinning
   * anticlockwise about the world up at 2 rad/s.
   *
   * The rotational counterpart to {@link velocity}, and read the same way: commanded, not measured. A body
   * whose `angularConstraints` lock an axis still reports whatever was written to it — {@link turnRate} is
   * what the node actually did. A fresh vector each read; assigning to a bodyless node does nothing.
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
  // This is the counterpart to `velocity`, and the difference matters: `velocity` is what the body was TOLD
  // to do — the value a controller script wrote — so it reads full speed while the character is jammed
  // against a wall. These read ~0, because the body did not move. Anything that stops you shows up here:
  // walls, friction, constraints, a platform carrying you.
  //
  // Every one of them is safe on a node with no body (0 or a zero vector), so a caller never has to check
  // and every vector is a fresh copy. The smoothed family (`currentVelocity` and everything derived from it)
  // is what to bind to animation; `rawVelocity` / `rawSpeed` are the unfiltered per-frame values for logic
  // that needs an immediate answer. See physics/motion.ts for why smoothing is not optional in practice.

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
   * Actual speed across the ground plane — the component perpendicular to gravity.
   *
   * This, not {@link currentSpeed}, is what a locomotion blend wants: falling is fast, and a character in
   * mid-air should not read as sprinting.
   */
  public get planarSpeed(): number {
    const m = this._motion;
    if (!m) return 0;
    return vec3.length(planarSplit(m.smooth, this._up).planar);
  }

  /**
   * Signed actual speed along gravity — positive rising, negative falling.
   *
   * Correct under any gravity direction, unlike reading `velocity[1]`, and measured rather than commanded:
   * a body pressed into the floor reports ~0 instead of the downward velocity gravity keeps applying.
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
   * **Mind the sign.** Angles here are counter-clockwise, because they share the engine's yaw convention
   * (`atan2(x, z)`, see {@link worldPlanarAngle}) — and with forward `+Z` and up `+Y`, a node's right is
   * `forward x up` = `-X`, so turning right is a NEGATIVE rotation. Several engines label strafe-right `+90`;
   * this one cannot, without `planarAngle` contradicting the yaw that every other angle in the engine uses.
   * Lay a strafe blend space out accordingly, or its left and right clips play mirrored.
   *
   * This is the axis a directional locomotion blend needs — it is what picks strafe-left vs strafe-right vs
   * walk-backwards, and it keeps meaning the same thing as the character turns.
   *
   * The node's own heading is derived from {@link worldForward}, never from `rotation[1]`. That is
   * load-bearing: euler composition is Rz·Ry·Rx, so past a quarter turn a quaternion-oriented node's yaw
   * folds into pitch and roll and a node turned 179° reads as 1°.
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
   * This is the only speed that can go negative. {@link planarSpeed}, {@link currentSpeed} and
   * {@link rawSpeed} are vector magnitudes, so a blend-space sample authored at a negative speed on one of
   * those axes sits where the probe can never reach and its clip silently never plays — the gradient band
   * gives it weight exactly 0 at every reachable point.
   *
   * There are two valid ways to lay out a locomotion blend space, and mixing them is the trap:
   *
   *   - `forwardSpeed` x {@link lateralSpeed} — signed on both axes, backwards at negative forward. Neither
   *     axis wraps.
   *   - {@link planarAngle} x `planarSpeed` — direction and magnitude, backwards at ±180 on a WRAPPING
   *     direction axis (`AnimationFieldAxis.wrap`).
   *
   * Pick one. Combining `planarAngle` with a signed speed gives backwards two different coordinates, and the
   * region between them is dead space no clip covers.
   */
  public get forwardSpeed(): number {
    const m = this._motion;
    if (!m) return 0;
    return facingComponents(m.smooth, this.worldForward, this._up).forward;
  }

  /**
   * Signed speed across this node's facing — the strafe axis. ~0 walking straight ahead or straight back.
   *
   * **Mind the sign: positive is LEFT.** It shares the counter-clockwise convention of {@link planarAngle}
   * (see the sign note there), and deliberately so — `atan2(lateralSpeed, forwardSpeed)` in degrees is exactly
   * `planarAngle`, so a blend laid out with these two axes and one laid out with angle-and-speed agree about
   * which side is which. Several engines label strafe-right positive; this one cannot without contradicting
   * the yaw every other angle in the engine uses.
   */
  public get lateralSpeed(): number {
    const m = this._motion;
    if (!m) return 0;
    return facingComponents(m.smooth, this.worldForward, this._up).lateral;
  }

  // ---- Measured motion: change over time -------------------------------------------------------------
  //
  // Everything above answers "what is this node doing"; these answer "what is it in the middle of doing".
  // That distinction is the whole reason they exist: a locomotion machine can pick a gait from `planarSpeed`
  // alone, but it cannot tell a character breaking into a run from one already running at that speed, and so
  // it cannot play a start or a stop. `planarSpeed` says WHERE on the curve; these say WHICH WAY along it.
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
   * Whether this node counts as moving across the ground, with hysteresis.
   *
   * Not the same as `planarSpeed > 0`, and the difference is the point: the threshold to start moving is
   * higher than the threshold to stop, so a node drifting at walking-pace-minus-epsilon reports one steady
   * answer instead of alternating every frame and dragging a state machine with it.
   */
  public get isMoving(): boolean {
    return this._motion?.moving ?? false;
  }

  /** Seconds this node has been continuously {@link isMoving}; 0 while still. */
  public get movingTime(): number {
    return this._motion?.movingTime ?? 0;
  }

  /**
   * Seconds this node has been continuously NOT {@link isMoving}; 0 while moving.
   *
   * The right gate for "settle into idle": `StopRun -> Idle when stillTime > 0.2` waits for the character to
   * have actually stopped, where a bare `planarSpeed < 0.1` fires on the first frame it dips.
   */
  public get stillTime(): number {
    return this._motion?.stillTime ?? 0;
  }

  /**
   * How fast this node is turning, in degrees per second, signed. Measured from its body's FACING, not its
   * direction of travel — so it is non-zero for a character turning in place, where every other value here
   * reads zero.
   *
   * Wrap-safe: a turn through ±180 reports its true rate rather than a full-circle spike.
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
   * Ask this rather than `!isGrounded`. `isGrounded` holds true for a ~0.1s grace after the last ground
   * contact (deliberately — see its own docs), so it is late to report a fall; and it goes false the instant a
   * character jumps, so its negation reports a fall on the way UP.
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
   * Requires a `groundProbeDistance` on the body — the value comes from that probe's raycast, and without one
   * there is nothing measuring the gap. Capped by the probe distance, so it answers "how close to landing",
   * not "how high up". `-1`, never 0, for unknown: 0 means resting on the ground.
   */
  public get groundDistance(): number {
    if (!this._body) return -1;
    return this._scene?.physics?.groundDistance(this._body) ?? -1;
  }

  /**
   * Tilt of the ground under this node, in degrees from level: 0 on the flat, 90 against a wall.
   *
   * Derived from {@link groundNormal}, so it reads 0 while airborne (that normal falls back to up) — which is
   * the harmless answer for the slope-lean blends this feeds.
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
   * The world caches are normally invalidated by `updateTransforms`, which is the only thing that can
   * move a node. Editing the underlying VERTICES moves the bounds without moving the node, so the
   * transform never goes dirty and the stale sphere survives — call this after such an edit (terrain
   * sculpting is the one in-tree case; see `Geometry.invalidateBounds`, which handles the object-space
   * half).
   */
  public invalidateWorldBounds(): void {
    this._worldSphereDirty = true;
    this._worldBoxDirty = true;
  }
}
