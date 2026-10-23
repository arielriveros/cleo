import { Logger } from "../core/logger";
import { Scene } from "../core/scene/scene";
import { Node } from "../core/scene/nodes/node";
import { ModelNode } from "../core/scene/nodes/modelNode";
import { unwrapScriptNode } from "../core/scene/nodes/nodeScripting";
import { World, Body, Constraint, Material, ContactMaterial, Vec3, Ray, RaycastResult, AABB, Box } from 'cannon-es';
import { vec3 } from "gl-matrix";
import { RigidBody, DEFAULT_FRICTION, DEFAULT_RESTITUTION } from "./body";
import { Ragdoll, RagdollOptions } from "./ragdoll";
import { skipCameraHit, CameraProbeBody, skipRayHit, RayHitBody, RayFilter } from "./cameraRayFilter";
import { physicsStats, resetPhysicsStats, PhysicsStats } from "./physicsStats";
import { clearWorld, broadphaseBodyCount } from "./worldTeardown";
import { MotionRecord, MotionConfig, createMotionRecord, sampleMotion, motionConfig } from "./motion";
import { OverlapHit, OverlapOptions, OverlapBody, QueryShape, queryPoses, sweepPoses } from "./overlap";
import { applyBuoyancy, floats } from "./buoyancy";
import { CleoSAPBroadphase } from "./cleoBroadphase";
import { installHeightfieldCollision } from "./heightfieldCollision";
import { installConvexSat } from "./convexSat";
import { effectiveSimulationRange, shouldFreeze, SIMULATION_WAKE_GRACE } from "./simulationRange";

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
  /**
   * Only what a character can stand on: DYNAMIC bodies (other characters' capsules, ragdoll limbs, loose
   * props) are dropped before any shape is tested, which is most of what a short downward ray costs.
   * Static and kinematic bodies — level geometry, moving platforms — still count.
   */
  groundOnly?: boolean;
}

/**
 * Seconds {@link PhysicsSystem.isGrounded} keeps reporting true after the last real ground contact.
 * Load-bearing: cannon drops the contact of a body resting perfectly still (~2 frames in 240 on a flat
 * heightfield), so a strictly per-frame answer flickers. The side effect is coyote time.
 */
const GROUND_GRACE = 0.1;

/**
 * Ground-likeness at or above which a contact counts as a surface you could stand on, and so as a candidate
 * to REPLACE the current stamp rather than merely compete with it. cos(60 deg), matching the default
 * `maxSlopeDegrees` of {@link PhysicsSystem.isGrounded} - every caller in the engine uses that default.
 * See _record for why the two rules differ either side of this line.
 */
const WALKABLE_DOT = Math.cos(60 * Math.PI / 180);

const v3 = (v: ArrayLike<number>): [number, number, number] => [v[0], v[1], v[2]];

/** Whether `node` and every ancestor are spawned: a despawned subtree stops simulating. */
function isSpawnedInScene(node: { spawned: boolean; parent: any }): boolean {
  for (let n: any = node; n; n = n.parent) if (n.spawned === false) return false;
  return true;
}

/** Below these speeds a `canSleep` body counts as resting (m/s, rad/s). */
const REST_LINEAR_SPEED = 0.05;
const REST_ANGULAR_SPEED = 0.05;
/** Seconds a `canSleep` body must rest before it sleeps. */
const REST_SECONDS = 1.0;

/** What a frozen (or resting) body was doing when it stopped, so waking can hand it back. */
interface FrozenState {
  reason: 'range' | 'rest';
  vx: number; vy: number; vz: number;
  wx: number; wy: number; wz: number;
  /** Whether it was standing on something: held for the freeze, so a frozen character never "falls". */
  grounded: boolean;
}

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
  /**
   * Trigger overlaps as cannon reports them, by body pair — updated by the world's begin/endContact
   * events during the substeps — and the same set as last REPORTED to scripts. Enter/exit hooks fire from
   * the difference once per frame, so a pair that flickers across substeps never reaches a script.
   */
  private _triggerPairs = new Map<number, { a: Body; b: Body }>();
  private _reportedPairs = new Map<number, { a: Body; b: Body }>();
  /** Bodies this system has put to sleep — out of range, or at rest — and what they were doing. */
  private _frozen = new Map<Body, FrozenState>();
  /** When a frozen body was last woken by something else (a hit, an impulse): it gets a grace period. */
  private _wokenAt = new WeakMap<Body, number>();
  /** Per `canSleep` body: seconds it has been continuously at rest. */
  private _restTime = new WeakMap<Body, number>();

  constructor(config?: PhysicsSystemConfig) {
    this._gravity = config?.gravity ? config.gravity: [0, -9.82, 0]; // y = up
  }

  /** The longest physics substep: what keeps stiff joints and fast contacts stable. */
  public static readonly MAX_SUBSTEP = 1 / 60;
  /** Substeps one frame may take. Frames are clamped (engine MAX_DELTA) so this is never the limit. */
  public static readonly MAX_SUBSTEPS = 8;

  /**
   * How many equal substeps advance the world by `dt`. 0 for a frame with no time in it. `max` caps the
   * count: past it each substep simply grows longer than 1/60 s — the world still advances by exactly
   * `dt`, it just does so in coarser steps.
   */
  public static substepsFor(dt: number, max: number = PhysicsSystem.MAX_SUBSTEPS): number {
    if (!(dt > 0)) return 0;
    return Math.min(Math.max(1, Math.floor(max)), Math.max(1, Math.ceil(dt / PhysicsSystem.MAX_SUBSTEP - 1e-6)));
  }

  /**
   * This world's cap on substeps per frame (project option "Max physics substeps"). Lower trades
   * stability of stiff joints and fast contacts on slow frames for less physics work per frame.
   */
  public maxSubsteps: number = PhysicsSystem.MAX_SUBSTEPS;

  /**
   * The project's simulation range, in metres from the active camera (project option "Simulation range").
   * Dynamic bodies beyond it are frozen in place — still solid, not simulated — unless their own
   * `simulationMode` says otherwise. `0` = unlimited, the default. See physics/simulationRange.ts.
   */
  public simulationRange: number = 0;

  /**
   * Measure cannon's own broadphase / narrowphase / solver / integrate split into the stats. Costs a few
   * `performance.now()` per substep, so the performance HUD turns it on only while it is showing.
   */
  public profileStep: boolean = false;

  public initialize(): void {
    try {
      this._world = new World();
      this._world.gravity.set(this._gravity[0], this._gravity[1], this._gravity[2]);
      // Sweep-and-prune, not cannon's default NaiveBroadphase: hundreds of pooled foliage collider bodies
      // make its O(N^2) pair generation dominate the step.
      // CleoSAPBroadphase rather than cannon's own: its pair loop scanned every static body against every
      // later body regardless of position — see cleoBroadphase.ts.
      this._world.broadphase = new CleoSAPBroadphase(this._world);
      // Terrain contacts and rays that only touch the cells a body or ray actually reaches. See
      // heightfieldCollision.ts for what cannon's own resolvers paid on a large landscape.
      installHeightfieldCollision(this._world);
      // The separating-axis test behind every convex-convex contact, without its parallel repeats and its
      // per-vertex overhead — once measured as 37% of the Valley's physics. See convexSat.ts.
      installConvexSat();
      // cannon's automatic sleep stays off: bodies are put to sleep by this system (out of range, or at
      // rest when they opt in), which knows what may never sleep — a character steered by velocity.
      this._world.allowSleep = false;
      this._world.quatNormalizeSkip = 0;
      // Accurate quaternion normalization: the fast approximation blows cone-twist ragdoll joints up to NaN.
      this._world.quatNormalizeFast = false;
      // Trigger enter/exit. cannon records trigger overlaps in its bodyOverlapKeeper (the `justTest` path of
      // the narrowphase) and diffs them every step into these two events; the per-body 'collide' event that
      // onTrigger uses fires on first contact only and has no exit at all.
      this._world.addEventListener('beginContact', (e: any) => this._onContact(e.bodyA, e.bodyB, true));
      this._world.addEventListener('endContact', (e: any) => this._onContact(e.bodyA, e.bodyB, false));
      // Buoyancy: once per SUBSTEP, after cannon has added gravity and before it integrates, so the water's
      // push is integrated exactly like gravity is. See physics/buoyancy.ts.
      this._world.addEventListener('preStep', () => this._applyWater());
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  public update(deltaTime: number): void {
    try {
      if (!this._scene) return;
      const frameStart = performance.now();
      resetPhysicsStats();

      // The world advances by EXACTLY this frame's delta, in equal substeps no longer than 1/60 s — the
      // same time scripts, locomotion and the animator are about to advance by. It used to be cannon's
      // accumulator, `step(1/60, dt, 5)`, which kept its own clock: it stopped at 5 substeps (0.083 s)
      // while scripts got up to 0.333 s, it abandoned the loop once the substeps took 16.7 ms of wall
      // time, and it threw the leftover away. So below 60 fps — or whenever physics got heavy — bodies
      // covered less ground than the game believed, and a speed-driven locomotion blend slid from
      // sprint to walk; above 60 fps the body moved in 1/60 s jumps that read as 0 and 2x speed on
      // alternate frames. Equal substeps that sum to the frame have none of that, and stay at or under
      // the 1/60 s that keeps ragdoll joints and contacts stable.
      // BEFORE the step: a body frozen this frame must not be integrated by it.
      this._updateActivation(deltaTime);

      const stepStart = performance.now();
      const substeps = PhysicsSystem.substepsFor(deltaTime, this.maxSubsteps);
      const world = this._world;
      if (world) world.doProfiling = this.profileStep;
      if (substeps > 0) {
        const h = deltaTime / substeps;
        for (let i = 0; i < substeps; i++) {
          world?.step(h);
          if (world && this.profileStep) {
            const prof = (world as any).profile;
            physicsStats.broadphaseMs += prof.broadphase;
            physicsStats.narrowphaseMs += prof.narrowphase;
            physicsStats.solveMs += prof.solve + prof.makeContactConstraints;
            physicsStats.integrateMs += prof.integrate;
          }
        }
      }
      physicsStats.stepMs = performance.now() - stepStart;

      this._updateRagdolls(deltaTime);
      this._reportTriggerPairs();

      // update() runs only while unpaused, so the grace window cannot expire behind a paused game.
      this._time += deltaTime;
      this._stampGroundContacts();
      // Must follow the stamps, so the clocks agree with what isGrounded answers this frame.
      this._updateAirborneTimes(deltaTime);

      const writeBackStart = performance.now();
      const nodes = this._scene.nodes;
      for (const node of nodes) {
        if ((!node.body && !node.trigger) || !node.hasStarted) continue;

        // BOTH, when a node has both: a solid door or gate with an interaction zone around it. This used to
        // be `node.body || node.trigger`, which silently left such a node's trigger out of the world.
        for (const bodyToAdd of [node.body, node.trigger]) {
          if (!bodyToAdd) continue;
          if (node.markForRemoval) {
            // Removing the body is what stops the callbacks: the 'collide' listener registered in
            // Node.setBody/setTrigger is an anonymous arrow, so removeEventListener can never match it.
            this.removeBody(bodyToAdd);
          } else if (!this._inWorld.has(bodyToAdd)) {
            this._assignMaterial(bodyToAdd);
            this._world.addBody(bodyToAdd);
            this._inWorld.add(bodyToAdd);
          }
        }

        if (node.body) {
          // Where the NODE sits, not where the body's centre of mass does: with an offset collider the
          // two differ by RigidBody's centre-of-mass offset (see CBody.recenterMass).
          const pos = node.body.originPosition(this._originScratch);
          const asleep = node.body.sleepState === Body.SLEEPING;

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

          // A sleeping body did not move: writing its pose back would only dirty the node's transform (and
          // every descendant's) for nothing. Its motion record still samples, so its speed reads 0.
          if (!asleep) {
            node.setPosition(pos);

            const quat = node.body.quaternion;
            node.setQuaternion([quat.x, quat.y, quat.z, quat.w]);
          }
        }

        if (node.trigger) {
          const pos = node.worldPosition;
          node.trigger.position.set(pos[0], pos[1], pos[2]);

          const quat = node.worldQuaternion;
          node.trigger.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
          // Moved behind cannon's back (it only re-measures what it integrates).
          node.trigger.aabbNeedsUpdate = true;
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

  // ---- Activation: simulation range and resting sleep ----

  /**
   * Freeze dynamic bodies that are out of their simulation range, wake the ones that came back, and put
   * resting `canSleep` bodies to sleep. Once per frame, before the step. See physics/simulationRange.ts.
   *
   * Only bodies that came through this system (node bodies) are considered: ragdoll bones and the foliage
   * pool manage their own lifetimes, and a ragdoll freezes itself once it settles.
   */
  private _updateActivation(dt: number): void {
    const world = this._world;
    if (!world) return;
    const cam = this._scene?.activeCamera;
    const camPos = cam ? cam.worldPosition : null;
    let active = 0, frozen = 0, resting = 0;

    for (const body of this._inWorld) {
      if (!(body instanceof RigidBody) || body.type !== Body.DYNAMIC) continue;
      let state = this._frozen.get(body);

      // Something else woke it: a hit from an awake body, an impulse, a force. Let it be. It is moving for
      // a reason, and refreezing it on the spot would swallow that. It may refreeze after a grace period.
      if (state && body.sleepState !== Body.SLEEPING) {
        this._frozen.delete(body);
        body.rangeFrozen = false;
        this._wokenAt.set(body, this._time);
        state = undefined;
      }

      const range = effectiveSimulationRange(body.simulationMode, body.simulationRange, this.simulationRange);
      let outOfRange = false;
      if (camPos && Number.isFinite(range)) {
        const p = body.position;
        const dx = p.x - camPos[0], dy = p.y - camPos[1], dz = p.z - camPos[2];
        outOfRange = shouldFreeze(state?.reason === 'range', dx * dx + dy * dy + dz * dz, range);
        if (outOfRange && !state) {
          const woken = this._wokenAt.get(body);
          if (woken !== undefined && this._time - woken < SIMULATION_WAKE_GRACE) outOfRange = false;
        }
      }

      if (state) {
        if (state.reason === 'range' && !outOfRange) {
          this._thaw(body, state);
        } else {
          // Out of range, or resting (which ends only when something wakes it): stays asleep. A resting
          // body that drifts out of range is relabelled, so coming back into range wakes it.
          if (outOfRange && state.reason === 'rest') { state.reason = 'range'; body.rangeFrozen = true; }
          this._holdGround(body, state);
          if (state.reason === 'range') frozen++; else resting++;
          continue;
        }
      } else if (outOfRange) {
        this._freeze(body, 'range');
        frozen++;
        continue;
      }

      if (body.canSleep && this._atRest(body, dt)) {
        this._freeze(body, 'rest');
        resting++;
        continue;
      }
      active++;
    }
    physicsStats.activeBodies = active;
    physicsStats.frozenBodies = frozen;
    physicsStats.restingBodies = resting;
  }

  /** Whether a `canSleep` body has been below the rest speeds for {@link REST_SECONDS}. */
  private _atRest(body: RigidBody, dt: number): boolean {
    const v = body.velocity, w = body.angularVelocity;
    const still = v.lengthSquared() < REST_LINEAR_SPEED * REST_LINEAR_SPEED
      && w.lengthSquared() < REST_ANGULAR_SPEED * REST_ANGULAR_SPEED;
    const t = still ? (this._restTime.get(body) ?? 0) + dt : 0;
    this._restTime.set(body, t);
    return t >= REST_SECONDS;
  }

  private _freeze(body: RigidBody, reason: 'range' | 'rest'): void {
    const v = body.velocity, w = body.angularVelocity;
    this._frozen.set(body, {
      reason, vx: v.x, vy: v.y, vz: v.z, wx: w.x, wy: w.y, wz: w.z, grounded: this.isGrounded(body),
    });
    body.rangeFrozen = reason === 'range';
    // cannon's manual sleep: not integrated, skipped against static bodies, still in the world.
    body.sleep();
  }

  private _thaw(body: RigidBody, state: FrozenState): void {
    this._frozen.delete(body);
    body.rangeFrozen = false;
    body.wakeUp();
    // Pick up where it left off: something mid-arc resumes the arc instead of dropping from rest.
    body.velocity.set(state.vx, state.vy, state.vz);
    body.angularVelocity.set(state.wx, state.wy, state.wz);
    this._restTime.set(body, 0);
  }

  /**
   * Keep a frozen body's ground stamp alive if it was standing when it froze. Its contacts are gone (a
   * sleeping body is skipped against static geometry), so without this `isGrounded` would expire after
   * GROUND_GRACE and a frozen character would read as falling, and play its fall.
   */
  private _holdGround(body: Body, state: FrozenState): void {
    if (!state.grounded) return;
    const stamp = this._ground.get(body);
    if (stamp) stamp.time = this._time;
  }

  /** Whether this system is holding `body` asleep (out of range or at rest). For tests and the HUD. */
  public isFrozen(body: Body): boolean { return this._frozen.has(body); }

  /**
   * Per-frame timings and counts for the last completed step. Read by the editor's performance HUD.
   * `rayMs`/`rayCount` cover queries made anywhere in the frame, so the parts do not sum to `frameMs`.
   */
  public get stats(): PhysicsStats { return physicsStats; }

  // ---- Low-level world access (for bodies/constraints not owned by a scene node, e.g. ragdolls) ----

  /** Add a standalone body to the world (deduplicated). Takes the default surface if it has no material. */
  /**
   * A static, infinite ground plane at `height` (facing up), in the world until passed to removeBody. For
   * tools that need something to fall onto in a scene with no level -- the rig editor's ragdoll test.
   */
  public addGroundPlane(height = 0): Body {
    // A wide, thick box rather than a cannon Plane: rays (the ragdoll's ground check, foot IK) do not
    // reliably hit an infinite plane, and nothing here needs it to be infinite.
    const body = new Body({ mass: 0, shape: new Box(new Vec3(500, 0.5, 500)) });
    body.position.set(0, height - 0.5, 0);
    this.addBody(body);
    return body;
  }

  public addBody(body: Body): void {
    if (!this._world) return;
    if (!this._inWorld.has(body)) {
      this._assignMaterial(body);
      this._world.addBody(body);
      this._inWorld.add(body);
    }
  }

  /**
   * Remove a body from the world if present. A trigger overlap it was part of ends with it — the exit is
   * reported at the end of the next step — because cannon reports a removed body's pairs with `null`.
   */
  public removeBody(body: Body): void {
    if (!this._world) return;
    if (this._inWorld.delete(body))
      this._world.removeBody(body);
    this._frozen.delete(body);
    if (this._triggerPairs.size > 0)
      for (const [key, pair] of this._triggerPairs)
        if (pair.a === body || pair.b === body) this._triggerPairs.delete(key);
  }

  // ---- Trigger enter / exit ----

  private static _pairKey(a: Body, b: Body): number {
    return a.id < b.id ? a.id * 1048576 + b.id : b.id * 1048576 + a.id;
  }

  private _onContact(a: Body | null, b: Body | null, begin: boolean): void {
    // A removed body comes back as null: removeBody has already dropped its pairs.
    if (!a || !b || !(a.isTrigger || b.isTrigger)) return;
    const key = PhysicsSystem._pairKey(a, b);
    if (begin) {
      if (this._inWorld.has(a) && this._inWorld.has(b)) this._triggerPairs.set(key, { a, b });
    } else this._triggerPairs.delete(key);
  }

  /** Fire onTriggerEnter / onTriggerExit for what changed since the last frame, on BOTH nodes of a pair. */
  private _reportTriggerPairs(): void {
    if (this._triggerPairs.size === 0 && this._reportedPairs.size === 0) return;
    for (const [key, pair] of this._reportedPairs) {
      if (this._triggerPairs.has(key)) continue;
      // A body put to sleep inside a trigger drops out of cannon's overlap tracking (sleeping-vs-static is
      // skipped in the broadphase), which reads as an exit. It has not moved: hold the overlap until it
      // wakes, when cannon reports the pair again and nothing is re-entered.
      if (pair.a.sleepState === Body.SLEEPING || pair.b.sleepState === Body.SLEEPING) continue;
      this._reportedPairs.delete(key);
      PhysicsSystem._dispatchTrigger(pair, 'onTriggerExit');
    }
    for (const [key, pair] of this._triggerPairs) {
      if (this._reportedPairs.has(key)) continue;
      this._reportedPairs.set(key, pair);
      PhysicsSystem._dispatchTrigger(pair, 'onTriggerEnter');
    }
  }

  private static _dispatchTrigger(pair: { a: Body; b: Body }, hook: 'onTriggerEnter' | 'onTriggerExit'): void {
    const na = (pair.a as any).owner, nb = (pair.b as any).owner;
    if (!(na instanceof Node) || !(nb instanceof Node) || na === nb) return;
    for (const [self, other] of [[na, nb], [nb, na]] as [Node, Node][]) {
      try { self[hook](other); }
      catch (e) { Logger.error(`Error in ${hook} for node ${self.name}: ${e}`, 'Script'); }
    }
  }

  /** How many trigger overlaps are currently reported to scripts. For tests and the stats panel. */
  public get triggerOverlapCount(): number { return this._reportedPairs.size; }

  /**
   * Every body in the world, read-only — including the foliage collider pool and ragdoll bones, which do
   * not go through `addBody`. For systems that read the colliders wholesale (particle collision); scripts
   * want the shape queries below instead.
   */
  public get bodies(): readonly Body[] { return this._world ? this._world.bodies : []; }

  /**
   * One substep of buoyancy from every water volume in the scene (the world's `preStep`). Each volume
   * records what it buoyed, for its surface effects. Character bodies are skipped unless a volume asks:
   * a capsule averages ~150 kg/m³ and locomotion carries vertical velocity over, so water would launch it.
   */
  private _applyWater(): void {
    const volumes = (this._scene as any)?.waterVolumes as Set<any> | undefined;
    if (!volumes?.size || !this._world) return;
    const g = this._world.gravity;
    const gravity = Math.hypot(g.x, g.y, g.z);
    const dt = this._world.dt > 0 ? this._world.dt : PhysicsSystem.MAX_SUBSTEP;
    const time = this._world.time;
    const isCharacter = (b: Body) => (b as any).owner?.nodeType === 'character';
    for (const volume of volumes) {
      if (!volume.enabled) continue;
      const spec = volume.buoyancyVolume(time);
      for (const body of this._world.bodies) {
        // applyForce wakes a sleeping body: a frozen floater would be thawed every substep.
        if (body.sleepState === Body.SLEEPING) continue;
        if (!floats(body, spec, isCharacter)) continue;
        const fraction = applyBuoyancy(body, spec, gravity, dt);
        if (fraction > 0) volume.recordSubmerged(body, fraction);
      }
    }
  }

  // ---- Shape queries ----

  /**
   * Bodies touching a sphere. One hit per node, nearest first. Triggers, ghosts and ragdoll bones are
   * skipped unless asked for. Spheres, boxes and capsules are tested exactly; convex hulls, trimeshes,
   * heightfields and planes are not tested at all: these queries are for hitting things, not terrain.
   */
  public overlapSphere(center: ArrayLike<number>, radius: number, options?: OverlapOptions<Body>): OverlapHit<Body>[] {
    const c = v3(center);
    return this._query([{ kind: 'capsule', a: c, b: c, radius }], options);
  }

  /** Bodies touching the capsule from `a` to `b` (its two end centres) with `radius`. See {@link overlapSphere}. */
  public overlapCapsule(a: ArrayLike<number>, b: ArrayLike<number>, radius: number, options?: OverlapOptions<Body>): OverlapHit<Body>[] {
    return this._query([{ kind: 'capsule', a: v3(a), b: v3(b), radius }], options);
  }

  /**
   * Bodies touching an oriented box. `rotation` is a unit quaternion [x, y, z, w] (a node's
   * `worldQuaternion`) and defaults to none. See {@link overlapSphere}.
   */
  public overlapBox(center: ArrayLike<number>, halfExtents: ArrayLike<number>, rotation?: ArrayLike<number> | null, options?: OverlapOptions<Body>): OverlapHit<Body>[] {
    const q: [number, number, number, number] = rotation ? [rotation[0], rotation[1], rotation[2], rotation[3]] : [0, 0, 0, 1];
    return this._query([{ kind: 'box', center: v3(center), half: v3(halfExtents), rotation: q }], options);
  }

  /**
   * Bodies a capsule touches on its way from one pose (`a0`-`b0`) to another (`a1`-`b1`): a swinging blade
   * from last frame's grip to this frame's. Sampled so consecutive poses are at most `radius` apart, so a
   * fast swing cannot pass through a target between frames. Each hit's `fraction` (0-1) says how far into
   * the sweep it was first touched: compare two to learn which one the swing reached first.
   */
  public sweepCapsule(a0: ArrayLike<number>, b0: ArrayLike<number>, a1: ArrayLike<number>, b1: ArrayLike<number>,
                      radius: number, options?: OverlapOptions<Body>): OverlapHit<Body>[] {
    return this._query(sweepPoses(v3(a0), v3(b0), v3(a1), v3(b1), radius), options);
  }

  /** Bodies a sphere touches moving from `from` to `to`: a thick ray. See {@link sweepCapsule}. */
  public sweepSphere(from: ArrayLike<number>, to: ArrayLike<number>, radius: number, options?: OverlapOptions<Body>): OverlapHit<Body>[] {
    const f = v3(from), t = v3(to);
    return this._query(sweepPoses(f, f, t, t, radius), options);
  }

  private _query(poses: QueryShape[], options?: OverlapOptions<Body>): OverlapHit<Body>[] {
    if (!this._world) return [];
    const start = performance.now();
    // Scripts hand over script proxies; owners are compared by identity, so unwrap to the real nodes.
    const opts = options?.ignore
      ? { ...options, ignore: (Array.isArray(options.ignore) ? options.ignore : [options.ignore]).map(n => unwrapScriptNode(n)) }
      : options;
    const hits = queryPoses(this._world.bodies as unknown as OverlapBody[], poses, opts as OverlapOptions<OverlapBody>);
    physicsStats.rayMs += performance.now() - start;
    physicsStats.rayCount++;
    return hits as unknown as OverlapHit<Body>[];
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
      // Asleep: it has not moved, and its held stamp (see _holdGround) already answers isGrounded.
      if (body.sleepState === Body.SLEEPING) continue;
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

    // Two rules, split at WALKABLE_DOT.
    //
    // A contact you could STAND on always takes the stamp. The max-dot rule below used to apply to these too,
    // which quietly made the ground normal "the flattest thing touched in the last GROUND_GRACE" rather than
    // the facet actually bearing the body - fine for a step, wrong for terrain, where a character straddles
    // several facets continuously (the shipped landscape's are 1.0 m across against a 0.2 m capsule radius, so
    // the cap never sits inside one). Whatever the controller then projected onto was flatter than the hill it
    // was climbing. Last writer wins among walkable surfaces, and since _stampGroundContacts runs the contact
    // loop first and the ground probe last, that makes the probe authoritative for the bodies that enable it.
    //
    // A contact you could NOT stand on still may not displace a better one inside the grace window: that is
    // the step-edge case the rule was written for, where a wall face (dot near 0) is contacted alongside the
    // floor and must not be mistaken for it. An EQUAL dot MUST refresh the stamp - a body resting still
    // reports the same dot every frame, and skipping those would let the grace expire under a body that
    // never moved.
    if (dot < WALKABLE_DOT && prev && this._time - prev.time <= GROUND_GRACE && dot < prev.dot) return;

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
      // Frozen clocks for a frozen body: neither airborne nor grounded time passes for something asleep.
      if (body.sleepState === Body.SLEEPING) continue;
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
    const onHit = (result: RaycastResult) => {
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
    };

    if (opts.groundOnly) {
      this._raycastGround(world, opts.checkCollisionResponse ?? true, onHit);
    } else {
      world.raycastAll(
        PhysicsSystem._rayFrom, PhysicsSystem._rayTo,
        // Defaults to cannon's own solidity filter; the camera turns it off so ghosts still block the boom.
        { checkCollisionResponse: opts.checkCollisionResponse ?? true },
        onHit);
    }

    physicsStats.rayMs += performance.now() - rayStart;
    physicsStats.rayCount++;
    return nearest;
  }

  // Reused across rays to keep the per-frame path allocation-free on our side.
  private static readonly _rayFrom = new Vec3();
  private static readonly _rayTo = new Vec3();

  /**
   * `world.raycastAll` minus every DYNAMIC body, decided before any shape test. Same Ray, same per-body
   * intersection and the same callback contract (mode ALL: every hit, the caller keeps the nearest) — only
   * the candidate list differs: cannon's broad phase hands a ray every body whose box it overlaps, and a
   * foot's ray starts inside its own character's capsule.
   */
  private _raycastGround(world: World, checkCollisionResponse: boolean, onHit: (result: RaycastResult) => void): void {
    const ray = PhysicsSystem._groundRay;
    ray.from.copy(PhysicsSystem._rayFrom);
    ray.to.copy(PhysicsSystem._rayTo);
    ray.mode = Ray.ALL;
    ray.result = PhysicsSystem._groundResult;
    ray.skipBackfaces = false;
    ray.collisionFilterMask = -1;
    ray.collisionFilterGroup = -1;
    ray.checkCollisionResponse = checkCollisionResponse;
    ray.callback = onHit;
    ray.hasHit = false;
    ray.result.reset();
    // Private in cannon's typings, but it is the step `intersectWorld` runs before anything else.
    (ray as unknown as { updateDirection(): void }).updateDirection();

    const box = PhysicsSystem._groundBox;
    ray.getAABB(box);
    const candidates = PhysicsSystem._groundCandidates;
    candidates.length = 0;
    for (const body of world.bodies) {
      if (body.type === Body.DYNAMIC) continue;
      if (body.aabbNeedsUpdate) body.updateAABB();
      if (body.aabb.overlaps(box)) candidates.push(body);
    }
    ray.intersectBodies(candidates);
    candidates.length = 0;
  }
  private static readonly _groundRay = new Ray();
  private static readonly _groundResult = new RaycastResult();
  private static readonly _groundBox = new AABB();
  private static readonly _groundCandidates: Body[] = [];

  /**
   * Turn a skinned ModelNode into a ragdoll and drive its skeleton from physics. A humanoid (or a rig
   * with an authored profile) gets shaped segment bodies with anatomical joints -- see ragdollProfile.ts;
   * anything else gets a body per substantial bone. Returns the Ragdoll handle.
   */
  public startRagdoll(modelNode: ModelNode, options?: RagdollOptions): Ragdoll {
    // Scripts hand over a script proxy; the ragdoll retains the node and the engine compares nodes by
    // identity, so it must be unwrapped to the real one.
    const ragdoll = new Ragdoll(unwrapScriptNode(modelNode), this, options);
    this._ragdolls.push(ragdoll);
    this._applyRagdollIterations();
    return ragdoll;
  }

  /** The solver's own iteration count, from before any ragdoll raised it. */
  private _baseIterations: number | null = null;

  /**
   * A chain of 15 jointed bodies sags and stretches at cannon's 10 solver iterations. Raise the count
   * while a live (unfrozen) ragdoll wants it, and put it back when none does, so nothing pays for it
   * the rest of the time.
   */
  private _applyRagdollIterations(): void {
    const solver = this._world?.solver as unknown as { iterations?: number } | undefined;
    if (!solver || typeof solver.iterations !== 'number') return;
    let want = 0;
    for (const r of this._ragdolls) if (!r.frozen && !r.destroyed) want = Math.max(want, r.solverIterations);
    if (want > 0) {
      if (this._baseIterations === null) this._baseIterations = solver.iterations;
      solver.iterations = Math.max(this._baseIterations, want);
    } else if (this._baseIterations !== null) {
      solver.iterations = this._baseIterations;
      this._baseIterations = null;
    }
  }

  /** The solver iteration count in force (for tests and the stats panel). */
  public get solverIterations(): number {
    return (this._world?.solver as unknown as { iterations?: number } | undefined)?.iterations ?? 0;
  }

  /**
   * End the ragdolls whose model has left the scene (removed, or despawned with its subtree), and
   * freeze the ones that have come to rest. Without this every kill left ~20 bodies and joints in the
   * world for the rest of the session: physics and every raycast slowed down kill by kill.
   */
  private _updateRagdolls(dt: number): void {
    if (this._ragdolls.length === 0) return;
    let kept = 0;
    for (const ragdoll of this._ragdolls) {
      const node = ragdoll.node;
      if (ragdoll.destroyed || !node.scene || node.markForRemoval || !isSpawnedInScene(node)) {
        ragdoll.destroy();
        continue;
      }
      ragdoll.updateSettle(dt);
      this._ragdolls[kept++] = ragdoll;
    }
    this._ragdolls.length = kept;
    this._applyRagdollIterations();
  }

  /** Ragdolls still alive (frozen ones included), for the stats panel and tests. */
  public get ragdollCount(): number { return this._ragdolls.length; }

  /** End the ragdoll driving `modelNode`, if any: its bodies leave the world, the skeleton animates again. */
  public stopRagdoll(modelNode: ModelNode): void {
    const node = unwrapScriptNode(modelNode);
    this._ragdolls = this._ragdolls.filter(r => {
      if (r.node !== node) return true;
      r.destroy();
      return false;
    });
    this._applyRagdollIterations();
  }

  public clear(): void {
    if (!this._world) return;

    for (const ragdoll of this._ragdolls) ragdoll.destroy();
    this._ragdolls = [];
    this._applyRagdollIterations();

    // Remove any remaining constraints before clearing bodies
    for (const constraint of [...this._world.constraints])
      this._world.removeConstraint(constraint);

    // Removing bodies is subtle enough to live in its own module — see clearWorld for the two traps
    // (splice-while-iterating, and truncating world.bodies behind the broadphase's back) that used to
    // strand half of every play session's bodies in the SAPBroadphase for the lifetime of the page.
    clearWorld(this._world);
    this._inWorld.clear();
    this._frozen.clear();
    // The scene is going away: no exits are reported for it.
    this._triggerPairs.clear();
    this._reportedPairs.clear();
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