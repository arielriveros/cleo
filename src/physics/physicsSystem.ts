import { Logger } from "../cleo";
import { Scene } from "../core/scene/scene";
import { Node } from "../core/scene/nodes/node";
import { ModelNode } from "../core/scene/nodes/modelNode";
import { unwrapScriptNode } from "../core/scene/nodes/nodeScripting";
import { World, Body, Constraint, Material, ContactMaterial, Vec3, SAPBroadphase } from 'cannon-es';
import { vec3 } from "gl-matrix";
import { RigidBody, DEFAULT_FRICTION, DEFAULT_RESTITUTION } from "./body";
import { Ragdoll, RagdollOptions } from "./ragdoll";
import { skipCameraHit, CameraProbeBody, skipRayHit, RayHitBody, RayFilter } from "./cameraRayFilter";
import { physicsStats, resetPhysicsStats, PhysicsStats } from "./physicsStats";
import { clearWorld, broadphaseBodyCount } from "./worldTeardown";
import { MotionRecord, MotionConfig, createMotionRecord, sampleMotion, motionConfig } from "./motion";

/**
 * A body's forward axis in world space: its local +Z rotated by its orientation, written into `out`.
 * +Z matches the engine's node convention (see `Node.worldForward`).
 */
function bodyForward(body: Body, out: vec3): vec3 {
  const q = body.quaternion;
  const x = q.x, y = q.y, z = q.z, w = q.w;
  // The third column of the rotation matrix, expanded from the quaternion.
  out[0] = 2 * (x * z + w * y);
  out[1] = 2 * (y * z - w * x);
  out[2] = 1 - 2 * (x * x + y * y);
  return out;
}

interface PhysicsSystemConfig {
  gravity?: number[];
}

/** A single hit from {@link PhysicsSystem.raycast}. Vectors are world space and freshly allocated. */
export interface PhysicsRaycastHit {
  point: vec3;
  /** Surface normal, pointing back out of the surface towards the ray's origin. */
  normal: vec3;
  /** Distance from the ray's start, in world units. */
  distance: number;
  body: Body;
  /** The Node that owns `body`, or null for bodies with no owner — the terrain heightfield, for instance. */
  node: Node | null;
}

export interface PhysicsRaycastOptions {
  /**
   * Hand cannon's own `collisionResponse` filter to the broad phase. Default true. The camera probe turns it
   * off so a body that is a ghost to the SOLVER still blocks the boom; the two channels are independent.
   */
  checkCollisionResponse?: boolean;
  /** Bodies to skip. Nearly always the caster's own body, since a ray usually starts inside it. */
  ignore?: Body | Body[] | null;
  /** Let trigger volumes count as hits. Default false — walking through a trigger is not walking into a wall. */
  includeTriggers?: boolean;
  /** Let bodies with `simulatePhysics = false` count as hits. Default false. */
  includeGhosts?: boolean;
  /** Last word on each candidate. Return true to skip it. `owner` is null for a body with no Node. */
  reject?: (owner: Node | null, body: Body) => boolean;
}

/**
 * Seconds {@link PhysicsSystem.isGrounded} keeps reporting true after the last real ground contact.
 * Load-bearing: cannon drops the contact of a body resting perfectly still (~2 frames in 240 on a flat
 * heightfield), so a strictly per-frame answer flickers. The side effect is coyote time.
 */
const GROUND_GRACE = 0.1;

export class PhysicsSystem {
  private _scene!: Scene;
  private _world!: World;
  private _gravity: number[];
  private _ragdolls: Ragdoll[] = [];
  /** Unpaused seconds of simulated time; the clock GROUND_GRACE is measured against. */
  private _time = 0;
  /** Per body: the most ground-like contact seen recently, its surface normal, and when. See _record. */
  private _ground = new WeakMap<Body, {
    time: number;
    dot: number;
    normal: [number, number, number];
    /** Gap under the feet. Only set when the stamp came from a ground probe; undefined for one from a
     *  contact, which knows it is touching but not how far a ray would have travelled. */
    gap?: number;
  }>();
  /** Per body: measured motion (how fast it ACTUALLY moved), sampled in the write-back pass. See motion.ts. */
  private _motion = new WeakMap<Body, MotionRecord>();
  /** Per body: the resolved motion tuning. `motionSmoothing` is readonly, so it can only change with the body. */
  private _motionCfg = new WeakMap<Body, MotionConfig>();
  /** Per body: how long it has been continuously airborne / grounded, in unpaused seconds. */
  private _airborne = new WeakMap<Body, { airTime: number; groundedTime: number }>();
  /** Scratch for the per-frame body facing; never escapes the write-back pass. */
  private _forwardScratch = vec3.create();
  /** Scratch for the per-frame node-space body position; never escapes the write-back pass. */
  private _originScratch = vec3.create();
  /** Cannon materials by `friction|restitution`, with a ContactMaterial for every pair. See _materialFor. */
  private _materials = new Map<string, Material>();
  /**
   * Mirror of the world's body membership, so the write-back pass tests it in O(1) rather than by scanning
   * `world.bodies`. Only tracks bodies added THROUGH this system; the foliage collider pool and ragdoll
   * constraints talk to the world directly and manage their own membership.
   */
  private _inWorld = new Set<Body>();

  constructor(config?: PhysicsSystemConfig) {
    this._gravity = config?.gravity ? config.gravity: [0, -9.82, 0]; // y = up
  }

  public initialize(): void {
    try {
      this._world = new World();
      this._world.gravity.set(this._gravity[0], this._gravity[1], this._gravity[2]);
      // Sweep-and-prune, not cannon's default NaiveBroadphase: hundreds of pooled foliage collider bodies
      // make its O(N^2) pair generation dominate the step.
      this._world.broadphase = new SAPBroadphase(this._world);
      this._world.allowSleep = false;
      this._world.quatNormalizeSkip = 0;
      // Accurate quaternion normalization: the fast approximation blows cone-twist ragdoll joints up to NaN.
      this._world.quatNormalizeFast = false;
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  public update(deltaTime: number): void {
    try {
      if (!this._scene) return;
      const frameStart = performance.now();
      resetPhysicsStats();

      // Fixed 1/60 internal timestep with up to 5 catch-up substeps: keeps stiff constraints stable and
      // deterministic across frame-delta spikes.
      const stepStart = performance.now();
      this._world?.step(1 / 60, deltaTime, 5);
      physicsStats.stepMs = performance.now() - stepStart;

      // update() runs only while unpaused, so the grace window cannot expire behind a paused game.
      this._time += deltaTime;
      this._stampGroundContacts();
      // Must follow the stamps, so the clocks agree with what isGrounded answers this frame.
      this._updateAirborneTimes(deltaTime);

      const writeBackStart = performance.now();
      const nodes = this._scene.nodes;
      for (const node of nodes) {
        const bodyToAdd = node.body || node.trigger;
        if (!bodyToAdd || !node.hasStarted) continue;

        if (!this._inWorld.has(bodyToAdd)) {
          this._assignMaterial(bodyToAdd);
          this._world.addBody(bodyToAdd);
          this._inWorld.add(bodyToAdd);
        }

        if (node.markForRemoval) {
          // Removing the body is what stops the callbacks: the 'collide' listener registered in
          // Node.setBody/setTrigger is an anonymous arrow, so removeEventListener can never match it.
          this._world.removeBody(bodyToAdd);
          this._inWorld.delete(bodyToAdd);
        }

        if (node.body) {
          // Where the NODE sits, not where the body's centre of mass does: with an offset collider the
          // two differ by RigidBody's centre-of-mass offset (see CBody.recenterMass).
          const pos = node.body.originPosition(this._originScratch);

          // Must sample after world.step() and before Scene.update runs every script's onUpdate, so a script
          // reading node.currentSpeed sees the step that just happened rather than last frame's.
          let motion = this._motion.get(node.body);
          if (!motion) { motion = createMotionRecord(); this._motion.set(node.body, motion); }
          sampleMotion(
            // The node's own travel, so currentSpeed still measures what the node did — a body spinning
            // about an offset centre of mass would otherwise read as movement.
            motion, [pos[0], pos[1], pos[2]], deltaTime, this.up,
            // Facing comes from the BODY, not the node: the node has not been written yet this frame.
            bodyForward(node.body, this._forwardScratch),
            this._motionConfigFor(node.body),
          );

          node.setPosition(pos);

          const quat = node.body.quaternion;
          node.setQuaternion([quat.x, quat.y, quat.z, quat.w]);
        }

        if (node.trigger) {
          const pos = node.worldPosition;
          node.trigger.position.set(pos[0], pos[1], pos[2]);

          const quat = node.worldQuaternion;
          node.trigger.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
        }
      }
      physicsStats.writeBackMs = performance.now() - writeBackStart;

      // Terrain: register/refresh the static heightfield collider(s) so any mesh walks over the landscape.
      const terrainStart = performance.now();
      for (const landscape of this._scene.landscapes) {
        if (landscape.markForRemoval) { landscape.terrain.dispose(this._world); continue; }
        landscape.terrain.setOrigin(landscape.worldPosition);
        // The terrain body needs a material: cannon only applies a ContactMaterial when BOTH bodies carry
        // one, otherwise the pair falls back to the world default.
        landscape.terrain.ensureRegistered(this._world, this._defaultMaterial);
        // Pooled static colliders for collidable foliage near the camera. Driven from here rather than
        // Scene.update: this is where the world reference is, and the editor never steps physics, which
        // keeps foliage bodies out of authoring mode.
        const cam = this._scene.activeCamera;
        landscape.terrain.updateFoliageColliders(
          this._world, cam ? (cam.worldPosition as vec3) : null, this._defaultMaterial);
      }
      physicsStats.terrainMs = performance.now() - terrainStart;

      // Tilemaps: same contract as terrain, driven from here for the same two reasons.
      const tilemapStart = performance.now();
      let tilemapColliders = 0;
      for (const node of this._scene.tilemaps) {
        if (node.markForRemoval) { node.tilemap.dispose(this._world); continue; }
        node.tilemap.setOrigin(node.worldPosition);
        node.tilemap.ensureRegistered(this._world, this._defaultMaterial);
        tilemapColliders += node.tilemap.colliderCount;
      }
      physicsStats.tilemapMs = performance.now() - tilemapStart;
      physicsStats.tilemapColliders = tilemapColliders;

      physicsStats.bodies = this._world?.bodies.length ?? 0;
      // Equal to `bodies` in a healthy world. Larger means bodies were removed without the broadphase
      // hearing about it and are still being simulated against — see worldTeardown.clearWorld.
      physicsStats.broadphaseBodies = this._world ? broadphaseBodyCount(this._world) : 0;
      physicsStats.contacts = this._world?.contacts.length ?? 0;
      physicsStats.frameMs = performance.now() - frameStart;
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  /**
   * Per-frame timings and counts for the last completed step. Read by the editor's performance HUD.
   * `rayMs`/`rayCount` cover queries made anywhere in the frame, so the parts do not sum to `frameMs`.
   */
  public get stats(): PhysicsStats { return physicsStats; }

  // ---- Low-level world access (for bodies/constraints not owned by a scene node, e.g. ragdolls) ----

  /** Add a standalone body to the world (deduplicated). Takes the default surface if it has no material. */
  public addBody(body: Body): void {
    if (!this._world) return;
    if (!this._inWorld.has(body)) {
      this._assignMaterial(body);
      this._world.addBody(body);
      this._inWorld.add(body);
    }
  }

  /** Remove a standalone body from the world if present. */
  public removeBody(body: Body): void {
    if (!this._world) return;
    if (this._inWorld.delete(body))
      this._world.removeBody(body);
  }

  public addConstraint(constraint: Constraint): void {
    this._world?.addConstraint(constraint);
  }

  public removeConstraint(constraint: Constraint): void {
    this._world?.removeConstraint(constraint);
  }

  /**
   * The cannon Material for a surface, created on first use and paired with every other known material.
   * cannon has no combination rule: it applies a registered ContactMaterial ONLY when both bodies carry a
   * material, else the pair silently falls back to the world default. Friction combines as MIN, restitution
   * as MAX.
   */
  private _materialFor(friction: number, restitution: number): Material {
    const key = `${friction}|${restitution}`;
    const cached = this._materials.get(key);
    if (cached) return cached;

    const material = new Material(key);
    for (const [otherKey, other] of this._materials) {
      const [otherFriction, otherRestitution] = otherKey.split('|').map(Number);
      this._world.addContactMaterial(new ContactMaterial(material, other, {
        friction: Math.min(friction, otherFriction),
        restitution: Math.max(restitution, otherRestitution),
      }));
    }
    this._world.addContactMaterial(new ContactMaterial(material, material, { friction, restitution }));

    this._materials.set(key, material);
    return material;
  }

  /** The surface every body without its own settings uses — matches cannon's own defaults. */
  private get _defaultMaterial(): Material {
    return this._materialFor(DEFAULT_FRICTION, DEFAULT_RESTITUTION);
  }

  /**
   * Give a body its surface, just before it enters the world. Must happen for EVERY body: one material left
   * null drags the whole pair back to the world default. Non-RigidBody bodies take the default.
   */
  private _assignMaterial(body: Body): void {
    if (body.material) return;
    body.material = body instanceof RigidBody
      ? this._materialFor(body.friction, body.restitution)
      : this._defaultMaterial;
  }

  /**
   * Record how ground-like each body's best contact is this frame. Must run immediately after the step, while
   * `world.contacts` still describes it — the equations are pooled and rewritten in place, so retain nothing.
   */
  private _stampGroundContacts(): void {
    const world = this._world;
    if (!world) return;

    // No gravity means no "down", so nothing can be ground; leaving the stamps alone lets them expire.
    const g = world.gravity;
    const gLength = Math.hypot(g.x, g.y, g.z);
    if (gLength === 0) return;
    const downX = g.x / gLength, downY = g.y / gLength, downZ = g.z / gLength;

    for (const contact of world.contacts) {
      // `ni` points OUT of bi, i.e. from bi towards bj (negate for bj). Its agreement with gravity IS the
      // measure of ground-likeness.
      const dot = contact.ni.x * downX + contact.ni.y * downY + contact.ni.z * downZ;
      const n = contact.ni;

      // Trigger volumes reach world.contacts: cannon only discards them later, when the solver builds
      // equations. The stored surface normal points back OUT of the ground, hence the negations.
      if (!contact.bj.isTrigger) this._record(contact.bi, dot, [-n.x, -n.y, -n.z]);
      if (!contact.bi.isTrigger) this._record(contact.bj, -dot, [n.x, n.y, n.z]);
    }

    // Ground probe. A resting contact blinks out for the odd frame (see GROUND_GRACE); bodies that opted in
    // (groundProbeDistance > 0) also get a short downward raycast feeding the SAME stamp, which never
    // vanishes. Off by default.
    for (const body of world.bodies) {
      if (!(body instanceof RigidBody) || body.isTrigger || body.groundProbeDistance <= 0) continue;
      const hit = this._probeGround(body, downX, downY, downZ, body.groundProbeDistance);
      if (hit) this._record(body, hit.dot, hit.normal, hit.gap);
    }
  }

  /**
   * Short downward raycast from a body's feet along gravity, keeping {@link isGrounded} stable for bodies
   * with a groundProbeDistance. Returns the ground-likeness dot (1 on level ground), the nearest SOLID hit's
   * surface normal, and the `gap` from the collider's lowest point to it — or null when nothing is below.
   */
  private _probeGround(
    body: Body, downX: number, downY: number, downZ: number, probeDistance: number
  ): { dot: number; normal: [number, number, number]; gap: number } | null {
    if (!this._world) return null;

    // Distance from the body centre to the AABB corner reaching furthest along "down"; each axis picks its
    // own further bound, so this holds for any gravity direction.
    body.updateAABB();
    const lo = body.aabb.lowerBound, hi = body.aabb.upperBound, p = body.position;
    const extent =
      Math.max(downX * (lo.x - p.x), downX * (hi.x - p.x)) +
      Math.max(downY * (lo.y - p.y), downY * (hi.y - p.y)) +
      Math.max(downZ * (lo.z - p.z), downZ * (hi.z - p.z));
    const reach = extent + probeDistance;
    if (reach <= 0) return null;

    const hit = this.raycast(
      [p.x, p.y, p.z],
      [p.x + downX * reach, p.y + downY * reach, p.z + downZ * reach],
      { ignore: body });
    if (!hit) return null;

    // The normal points back out toward the ray origin; its agreement with world "up" is the ground-likeness,
    // matching the contact path's dot convention.
    const n = hit.normal;
    const dot = -(n[0] * downX + n[1] * downY + n[2] * downZ);
    // The ray starts at the body CENTRE, so subtract the collider's reach for the gap under the feet.
    // Clamped at 0: it goes slightly negative while the collider is penetrating the surface.
    return { dot, normal: [n[0], n[1], n[2]], gap: Math.max(0, hit.distance - extent) };
  }

  private _record(body: Body, dot: number, normal: [number, number, number], gap?: number): void {
    if (body.isTrigger) return;
    const prev = this._ground.get(body);

    // A worse (less ground-like) contact may not overwrite a better one still inside the grace window; past
    // that window anything may take over. An EQUAL dot MUST refresh the stamp: a body resting still reports
    // the same dot every frame, and skipping those would let the grace expire under a body that never moved.
    if (prev && this._time - prev.time <= GROUND_GRACE && dot < prev.dot) return;

    this._ground.set(body, { time: this._time, dot, normal, gap });
  }

  /**
   * True when `body` is resting on something solid in the CURRENT gravity direction. Backs
   * {@link Node.isGrounded}. "Down" is the gravity vector, not -Y; with zero gravity nothing is grounded.
   * @param maxSlopeDegrees How far a surface may tilt away from level and still hold you up.
   * @param graceSeconds How long a body keeps counting as grounded after its last ground contact. A value
   *                     larger than GROUND_GRACE is allowed, but past that window a worse contact may
   *                     already have replaced the stamp.
   */
  public isGrounded(body: Body, maxSlopeDegrees: number = 60, graceSeconds: number = GROUND_GRACE): boolean {
    const world = this._world;
    // A trigger passes through everything, so it never rests on anything.
    if (!world || !body || body.isTrigger) return false;

    const g = world.gravity;
    if (Math.hypot(g.x, g.y, g.z) === 0) return false;

    const stamp = this._ground.get(body);
    if (!stamp || this._time - stamp.time > graceSeconds) return false;
    return stamp.dot >= Math.cos(maxSlopeDegrees * Math.PI / 180);
  }

  /**
   * Surface normal of the ground `body` is standing on, pointing up out of that surface — [0,1,0] on level
   * ground under normal gravity. Backs {@link Node.groundNormal}. Falls back to UP (gravity reversed) when
   * the body is not grounded, has no stamp, or gravity is zero, so callers can project onto it unguarded.
   */
  public groundNormal(body: Body, maxSlopeDegrees: number = 60, graceSeconds: number = GROUND_GRACE): vec3 {
    const up = this.up;
    if (!this.isGrounded(body, maxSlopeDegrees, graceSeconds)) return up;
    const stamp = this._ground.get(body);
    return stamp ? vec3.fromValues(stamp.normal[0], stamp.normal[1], stamp.normal[2]) : up;
  }

  /**
   * Distance from `body`'s feet to the ground below it, in world units, or `-1` when it cannot be answered.
   * Only bodies with a `groundProbeDistance` can answer. `-1` and not 0 for "unknown": 0 means resting on the
   * ground. Capped by the probe distance, so it is a near-ground refinement, not a general altimeter.
   */
  public groundDistance(body: Body): number {
    if (!body || body.isTrigger) return -1;
    const stamp = this._ground.get(body);
    if (!stamp || stamp.gap === undefined) return -1;
    // A stale stamp is not an answer: the body may have left the surface since.
    if (this._time - stamp.time > GROUND_GRACE) return -1;
    return stamp.gap;
  }

  /**
   * The world's "up": gravity reversed and normalized, or [0, 1, 0] under zero gravity. Returns a fresh
   * vector. Everything gravity-relative goes through this one definition rather than hardcoding Y.
   */
  public get up(): vec3 {
    const g = this._world?.gravity;
    const length = g ? Math.hypot(g.x, g.y, g.z) : 0;
    if (length === 0) return vec3.fromValues(0, 1, 0);
    return vec3.fromValues(-g!.x / length, -g!.y / length, -g!.z / length);
  }

  /**
   * Measured motion for a body — how fast it ACTUALLY moved, not what was commanded of it. Backs
   * {@link Node.currentSpeed} and family. Undefined until the body has been through a write-back pass.
   */
  public motionOf(body: Body): MotionRecord | undefined {
    return this._motion.get(body);
  }

  /** This body's motion tuning, from its own `motionSmoothing` where it set one. Cached per body. */
  private _motionConfigFor(body: Body): MotionConfig {
    let cfg = this._motionCfg.get(body);
    if (!cfg) {
      const tau = body instanceof RigidBody ? body.motionSmoothing : 0;
      cfg = motionConfig(tau > 0 ? { tau } : null);
      this._motionCfg.set(body, cfg);
    }
    return cfg;
  }

  /**
   * How long a body has been continuously in the air, and continuously on the ground, in seconds. Inherits
   * the grace window from {@link isGrounded}: `airTime` only climbs once the grace has expired. Both are 0
   * for a body that has never been simulated.
   */
  public airborneTimes(body: Body): { airTime: number; groundedTime: number } {
    return this._airborne.get(body) ?? { airTime: 0, groundedTime: 0 };
  }

  /**
   * Advance the per-body air/ground clocks. Must run after the ground stamps are in. Only bodies with a
   * motion record are tracked, i.e. the simulated ones, excluding the pooled foliage colliders.
   */
  private _updateAirborneTimes(deltaTime: number): void {
    // initialize() swallows a World construction failure, so every per-frame pass must tolerate no world.
    if (deltaTime <= 0 || !this._world) return;
    for (const body of this._world.bodies) {
      if (!this._motion.has(body)) continue;
      let rec = this._airborne.get(body);
      if (!rec) { rec = { airTime: 0, groundedTime: 0 }; this._airborne.set(body, rec); }
      if (this.isGrounded(body)) {
        rec.groundedTime += deltaTime;
        rec.airTime = 0;
      } else {
        rec.airTime += deltaTime;
        rec.groundedTime = 0;
      }
    }
  }

  /**
   * Distance from `from` to the nearest solid surface along the SEGMENT `from -> to`, or null when nothing
   * blocks it. The boom length must be baked into `to`, not passed as a max distance. `simulatePhysics =
   * false` ghosts still block the camera: the solver and camera channels are independent.
   * @param reject Called with the owning Node of each candidate hit (null for bodies with no owner, e.g.
   *               the terrain heightfield — those should normally be kept). Return true to skip.
   */
  public raycastCamera(from: vec3, to: vec3, reject?: (owner: Node | null) => boolean): number | null {
    // The standard filters are turned OFF and delegated wholesale to skipCameraHit; applying both would
    // change which bodies block a camera.
    const hit = this.raycast(from, to, {
      checkCollisionResponse: false,
      includeTriggers: true,
      includeGhosts: true,
      reject: (_owner, body) => skipCameraHit(body as CameraProbeBody | null, reject),
    });
    return hit ? hit.distance : null;
  }

  /**
   * Nearest solid hit along the SEGMENT `from -> to` (bake the length into `to`), with the hit point and
   * surface normal, or null when nothing is in the way. Uses `raycastAll`, not `raycastClosest`: cannon
   * consults `isTrigger` only in the solver, so `raycastClosest` returns trigger volumes with no way to
   * reject one and continue.
   */
  public raycast(from: vec3, to: vec3, options?: PhysicsRaycastOptions): PhysicsRaycastHit | null {
    const world = this._world;
    if (!world) return null;

    const opts = options ?? {};
    const rayStart = performance.now();
    PhysicsSystem._rayFrom.set(from[0], from[1], from[2]);
    PhysicsSystem._rayTo.set(to[0], to[1], to[2]);

    let nearest: PhysicsRaycastHit | null = null;
    world.raycastAll(
      PhysicsSystem._rayFrom, PhysicsSystem._rayTo,
      // Defaults to cannon's own solidity filter; the camera turns it off so ghosts still block the boom.
      { checkCollisionResponse: opts.checkCollisionResponse ?? true },
      (result) => {
        // `distance` is only meaningful on a hit; it is -1 after a reset.
        if (!result.hasHit) return;
        const body = result.body;
        if (!body) return;
        if (nearest !== null && result.distance >= nearest.distance) return;
        if (skipRayHit(body as unknown as RayHitBody, opts as RayFilter<RayHitBody>)) return;

        const owner = (body as any).owner instanceof Node ? (body as any).owner as Node : null;
        const p = result.hitPointWorld;
        const n = result.hitNormalWorld;
        nearest = {
          point: vec3.fromValues(p.x, p.y, p.z),
          normal: vec3.fromValues(n.x, n.y, n.z),
          distance: result.distance,
          body,
          node: owner,
        };
      });

    physicsStats.rayMs += performance.now() - rayStart;
    physicsStats.rayCount++;
    return nearest;
  }

  // Reused across rays to keep the per-frame path allocation-free on our side.
  private static readonly _rayFrom = new Vec3();
  private static readonly _rayTo = new Vec3();

  /**
   * Turn a skinned ModelNode into a ragdoll: spawn a rigid body per bone, link them
   * with ball joints, and drive the skeleton from physics. Returns the Ragdoll handle.
   */
  public startRagdoll(modelNode: ModelNode, options?: RagdollOptions): Ragdoll {
    // Scripts hand over a script proxy; the ragdoll retains the node and the engine compares nodes by
    // identity, so it must be unwrapped to the real one.
    const ragdoll = new Ragdoll(unwrapScriptNode(modelNode), this, options);
    this._ragdolls.push(ragdoll);
    return ragdoll;
  }

  public clear(): void {
    if (!this._world) return;

    for (const ragdoll of this._ragdolls) ragdoll.destroy();
    this._ragdolls = [];

    // Remove any remaining constraints before clearing bodies
    for (const constraint of [...this._world.constraints])
      this._world.removeConstraint(constraint);

    // Removing bodies is subtle enough to live in its own module — see clearWorld for the two traps
    // (splice-while-iterating, and truncating world.bodies behind the broadphase's back) that used to
    // strand half of every play session's bodies in the SAPBroadphase for the lifetime of the page.
    clearWorld(this._world);
    this._inWorld.clear();
  }

  public set scene(scene: Scene) {
    this.clear();
    this._scene = scene;
    scene.physics = this;
  }

  /** Current gravity vector (m/s^2). Settable at runtime. */
  public get gravity(): [number, number, number] {
    return this._world ? [this._world.gravity.x, this._world.gravity.y, this._world.gravity.z] : (this._gravity as [number, number, number]);
  }
  public set gravity(g: [number, number, number]) {
    this._gravity = g;
    this._world?.gravity.set(g[0], g[1], g[2]);
  }
}