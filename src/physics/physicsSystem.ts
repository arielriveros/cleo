import { Logger } from "../core/logger";
import { Scene } from "../core/scene/scene";
import { Node } from "../core/scene/nodes/node";
import { ModelNode } from "../core/scene/nodes/modelNode";
import { unwrapScriptNode } from "../core/scene/nodes/nodeScripting";
import { quat, vec3 } from "gl-matrix";
import { authoring } from "../core/eventBus";
import { RigidBody, Trigger, triggerState } from "./body";
import type { TriggerContact } from "./body";
import { TriggerOverlapPass, TriggerOverlap, pairKey } from "./triggerOverlaps";
import { Ragdoll, RagdollOptions } from "./ragdoll";
import { skipCameraHit, CameraProbeBody, skipRayHit, RayHitBody, RayFilter } from "./cameraRayFilter";
import { physicsStats, resetPhysicsStats, PhysicsStats } from "./physicsStats";
import { MotionRecord, MotionConfig, createMotionRecord, sampleMotion, motionConfig } from "./motion";
import { OverlapHit, OverlapOptions, OverlapBody, QueryShape, queryPoses, sweepPoses } from "./overlap";
import { applyBuoyancy, floats } from "./buoyancy";
import { InlineExecutor } from "./executor/inlineExecutor";
import { WorkerExecutor } from "./executor/workerExecutor";
import type { ContactSource, PhysicsExecutor } from "./executor/physicsExecutor";
import { createPhysicsWorld } from "./pal/createWorld";
import type { PhysicsWorld } from "./pal/world";
import { PhysicsEventKind, type BodyHandle, type ColliderGeometry, type ColliderPart } from "./pal/types";
import { CannonWorld } from "./pal/cannon/cannonWorld";
import { PhysicsBody } from "./physicsBody";
import type { JointDesc, JointHandle } from "./pal/types";
import { WorkerPort, type PhysicsPort } from "./worker/ports";
import { effectiveSimulationRange, shouldFreeze, SIMULATION_WAKE_GRACE } from "./simulationRange";


/** Whether a body takes part in overlaps: anything but a disabled trigger. */
const isOn = (body: PhysicsBody): boolean => !(body instanceof Trigger) || body.enabled;
/** A trigger's re-arm count (see Trigger.rearmEpoch); 0 for any other body. */
const epochOf = (body: PhysicsBody): number => (body instanceof Trigger ? body.rearmEpoch : 0);
/** Whether a body is asleep (or held asleep). */
const asleep = (body: PhysicsBody): boolean => body.isSleeping;

/** A joint as PhysicsSystem.addJoint takes it: a JointDesc between two engine bodies. */
export type JointSpec = JointDesc extends infer J ? J extends JointDesc ? Omit<J, 'a' | 'b'> : never : never;

/**
 * A body's forward axis in world space: its local +Z rotated by its orientation, written into `out`.
 * +Z matches the engine's node convention (see `Node.worldForward`).
 */
function bodyForward(body: { quaternion: { x: number; y: number; z: number; w: number } }, out: vec3): vec3 {
  const q = body.quaternion;
  const x = q.x, y = q.y, z = q.z, w = q.w;
  // The third column of the rotation matrix, expanded from the quaternion.
  out[0] = 2 * (x * z + w * y);
  out[1] = 2 * (y * z - w * x);
  out[2] = 1 - 2 * (x * x + y * y);
  return out;
}

/** After the worker fell behind, how long Auto keeps the step on the main thread before trying again. */
const AUTO_RETRY_SECONDS = 30;

/** Where the physics step may run: see PhysicsSystem.setWorkerMode. */
export type PhysicsWorkerMode = 'off' | 'on' | 'auto';

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
  body: PhysicsBody;
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
  ignore?: PhysicsBody | PhysicsBody[] | null;
  /** Let trigger volumes count as hits. Default false — walking through a trigger is not walking into a wall. */
  includeTriggers?: boolean;
  /** Let bodies with `simulatePhysics = false` count as hits. Default false. */
  includeGhosts?: boolean;
  /** Last word on each candidate. Return true to skip it. `owner` is null for a body with no Node. */
  reject?: (owner: Node | null, body: PhysicsBody) => boolean;
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
  /** The world on its backend (see pal/). Every simulation and query goes through it. */
  private _world!: PhysicsWorld;
  /**
   * The same world as cannon's, for the one thing that still replicates cannon objects: the physics worker
   * (executor/workerExecutor.ts), which mirrors the cannon world shape for shape.
   */
  private _cannon!: CannonWorld;
  private _gravity: number[];
  private _ragdolls: Ragdoll[] = [];
  /** Unpaused seconds of simulated time; the clock GROUND_GRACE is measured against. */
  private _time = 0;
  /** Per body: the most ground-like contact seen recently, its surface normal, and when. See _record. */
  private _ground = new WeakMap<PhysicsBody, {
    time: number;
    dot: number;
    normal: [number, number, number];
    /** Gap under the feet. Only set when the stamp came from a ground probe; undefined for one from a
     *  contact, which knows it is touching but not how far a ray would have travelled. */
    gap?: number;
  }>();
  /** Per body: measured motion (how fast it ACTUALLY moved), sampled in the write-back pass. See motion.ts. */
  private _motion = new WeakMap<PhysicsBody, MotionRecord>();
  /** A static body's node `transformVersion` when its pose was last pushed (see the write-back). */
  private _followVersion = new WeakMap<PhysicsBody, number>();
  /** Per body: the resolved motion tuning. `motionSmoothing` is readonly, so it can only change with the body. */
  private _motionCfg = new WeakMap<PhysicsBody, MotionConfig>();
  /** Per body: how long it has been continuously airborne / grounded, in unpaused seconds. */
  private _airborne = new WeakMap<PhysicsBody, { airTime: number; groundedTime: number }>();
  /** Scratch for the per-frame body facing; never escapes the write-back pass. */
  private _forwardScratch = vec3.create();
  /** Scratch for the per-frame node-space body position; never escapes the write-back pass. */
  private _originScratch = vec3.create();
  /** Where the step runs: this thread, or a Web Worker. See executor/physicsExecutor.ts. */
  private _executor!: PhysicsExecutor;
  private _workerMode: PhysicsWorkerMode = 'off';
  private _workerFactory: (() => PhysicsPort) | null = null;
  /** A worker warming up (see WorkerExecutor.prime): the step stays on this thread until it has answered. */
  private _pendingWorker: WorkerExecutor | null = null;
  /** Set when the step moved to the worker during this frame's update, whose activation has already run. */
  private _activatedThisFrame = false;
  /** Scratch for the worker's drawn pose of a body and the node origin it puts the node at. */
  private _visualPose = new Float64Array(7);
  private _visualRotation = this._visualPose.subarray(3, 7);
  private _visualOrigin = new Float64Array(3);
  private _simRotation = new Float64Array(4);
  /**
   * The auto mode's bookkeeping: seconds watched, the step-time average, whether it gave up for good (the
   * worker failed), the late-frame window, how many windows in a row were bad, and when it may try the
   * worker again after falling behind (seconds watched).
   */
  private _auto = PhysicsSystem._freshAuto();
  private static _freshAuto() {
    return { watched: 0, stepEma: 0, gaveUp: false, workerWatched: 0, lateAt: 0, postedAt: 0, badWindows: 0, retryAt: 0 };
  }
  /** The engine's time scale this frame (see update). */
  private _timeScale = 1;
  /** Why the step last came back to this thread from a worker (or never left), until the mode is set again. */
  private _workerFallback: string | null = null;
  /**
   * Mirror of the world's body membership, so the write-back pass tests it in O(1) rather than by scanning
   * `world.bodies`. Only tracks bodies added THROUGH this system; the foliage collider pool and ragdoll
   * constraints talk to the world directly and manage their own membership.
   */
  private _inWorld = new Set<PhysicsBody>();
  /** The engine bodies in the world (enabled or kept disabled), by handle: what a handle the world reports is. */
  private _bodies = new Map<number, PhysicsBody>();
  /**
   * Trigger overlaps as cannon reports them, by body pair — updated by the world's begin/endContact
   * events during the substeps — and the same set as last REPORTED to scripts. Enter/exit hooks fire from
   * the difference once per frame, so a pair that flickers across substeps never reaches a script.
   */
  private _triggerPairs = new Map<number, { a: PhysicsBody; b: PhysicsBody }>();
  /**
   * What was last reported to scripts, with each side's `rearmEpoch` at the time: a trigger switched off
   * and back on inside one frame still overlaps, but its new enter must be reported (see Trigger.rearmEpoch).
   */
  private _reportedPairs = new Map<number, { a: PhysicsBody; b: PhysicsBody; ea: number; eb: number }>();
  /** Every trigger in the world, for the trigger↔trigger pass and the editor's overlay. */
  private _triggers = new Set<Trigger>();
  /** Bumped when a trigger enters or leaves the world; see {@link triggerVersion}. */
  private _localVersion = 0;
  /** Trigger↔trigger overlaps, which cannon cannot see — see triggerOverlaps.ts. Updated once per frame. */
  private _ttPass = new TriggerOverlapPass();
  private _ttPairs = new Map<number, TriggerOverlap>();
  /** Per trigger: how many reported overlaps it is in, for the overlay's highlight. */
  private _overlapCount = new Map<PhysicsBody, number>();
  /** Bodies this system has put to sleep — out of range, or at rest — and what they were doing. */
  private _frozen = new Map<PhysicsBody, FrozenState>();
  /** When a frozen body was last woken by something else (a hit, an impulse): it gets a grace period. */
  private _wokenAt = new WeakMap<PhysicsBody, number>();
  /** Per `canSleep` body: seconds it has been continuously at rest. */
  private _restTime = new WeakMap<PhysicsBody, number>();

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

  /**
   * Build the world: on `world` when given (a backend the host acquired, see pal/createWorld.ts), else on
   * cannon. Synchronous either way.
   */
  public initialize(world?: PhysicsWorld): void {
    try {
      // Built the same way the physics worker builds its own (pal/cannon/worldConfig.ts), so both step alike.
      this._world = world ?? createPhysicsWorld('cannon', this._gravity);
      if (!(this._world instanceof CannonWorld)) throw new Error(`physics: the ${this._world.backend} backend cannot host the engine's bodies yet`);
      this._cannon = this._world;
      this._world.gravity = [this._gravity[0], this._gravity[1], this._gravity[2]];
      // Buoyancy: once per SUBSTEP, before the solver, so the water's push is integrated exactly like
      // gravity is. See physics/buoyancy.ts. (Trigger enter/exit come from the world's events, drained
      // after each step: see _drainEvents.)
      this._world.onPreSubstep = dt => this._applyWater(dt);
      this._executor = this._inlineExecutor();
      // A mode set before the world existed (the engine constructor) takes effect now.
      if (this._workerMode === 'on') this._useWorker();
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  private _inlineExecutor(): InlineExecutor {
    return new InlineExecutor(() => this._world, dt => PhysicsSystem.substepsFor(dt, this.maxSubsteps), () => this.profileStep);
  }

  /**
   * `deltaTime` is game time: the frame's delta with the engine's time scale applied. `timeScale` is that
   * scale (1 unless slow motion or a hit-stop runs), which the worker predicts its next step's reach by.
   */
  public update(deltaTime: number, timeScale: number = 1): void {
    this._timeScale = timeScale;
    try {
      if (!this._scene) return;
      const frameStart = performance.now();
      resetPhysicsStats();

      // The step (see executor/): inline, the world advances by exactly this frame's delta in equal
      // substeps; with the worker, this applies the step it finished while the last frame rendered.
      const inline = this._executor.kind === 'inline';
      // BEFORE the step: a body frozen this frame must not be integrated by it. (The worker's activation
      // runs in endFrame, just before the step is posted.)
      if (inline) this._updateActivation(deltaTime);
      const result = this._executor.step(deltaTime, timeScale);
      physicsStats.executor = this._executor.kind;
      // What the inline step reported (the worker's arrives with its snapshot, through _onContact).
      this._drainEvents();
      // Seconds actually simulated. Inline, the frame's own; with the worker, its step's — or 0 while it
      // is still running, when nothing below that depends on a step happening runs.
      const stepDt = inline ? deltaTime : result.dt;

      if (inline || stepDt > 0) {
        this._updateRagdolls(stepDt);
        // update() runs only while unpaused, so the grace window cannot expire behind a paused game.
        this._time += stepDt;
        this._stampGroundContacts(result.contacts);
        // Must follow the stamps, so the clocks agree with what isGrounded answers this frame.
        this._updateAirborneTimes(stepDt);
      }
      physicsStats.contacts = result.contacts.contactCount;

      const writeBackStart = performance.now();
      const nodes = this._scene.nodes;
      const worker = this._executor.kind === 'worker' ? this._executor as WorkerExecutor : null;
      // A body moving its node is simulation, never an edit (see authoring.derived).
      authoring.derived++;
      try {
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
            this._enterWorld(bodyToAdd);
          }
        }

        if (node.body) {
          // Where the NODE sits, not where the body's centre of mass does: with an offset collider the
          // two differ by RigidBody's centre-of-mass offset (see RigidBody.recenterMass).
          const pos = node.body.position.toArray();
          const asleep = node.body.isSleeping;

          // Must sample after world.step() and before Scene.update runs every script's onUpdate, so a script
          // reading node.currentSpeed sees the step that just happened rather than last frame's.
          let motion = this._motion.get(node.body);
          if (!motion) { motion = createMotionRecord(); this._motion.set(node.body, motion); }
          // Over the time actually simulated: a frame whose worker step has not come back moved nothing, and
          // sampling it would read as a stop.
          if (stepDt > 0) sampleMotion(
            // The node's own travel, so currentSpeed still measures what the node did — a body spinning
            // about an offset centre of mass would otherwise read as movement.
            motion, [pos[0], pos[1], pos[2]], stepDt, this.up,
            // Facing comes from the BODY, not the node: the node has not been written yet this frame.
            bodyForward(node.body, this._forwardScratch),
            this._motionConfigFor(node.body),
          );

          if (node.body.mass > 0 && worker) {
            // DYNAMIC, WORKER: the node is drawn where its body is at THIS frame's time — the worker's step
            // interpolated (see WorkerExecutor.visualPose) — while the body keeps the latest simulated pose.
            // Written without pushing into the body; the node remembers the gap instead, so a script that
            // then moves or turns it moves the body by the same amount (see Node._showSimulatedPose).
            const q = node.body.quaternion, simRotation = this._simRotation;
            simRotation[0] = q.x; simRotation[1] = q.y; simRotation[2] = q.z; simRotation[3] = q.w;
            const raw = this._cannon.bodyOf(node.body.handle);
            if (raw && worker.visualPose(raw, this._visualPose)) {
              this._world.colliderFrameToOrigin(node.body.handle, this._visualPose, this._visualOrigin);
              node._showSimulatedPose(this._visualOrigin, this._visualRotation, pos, simRotation);
            } else if (!asleep || node._drawnApart) {
              // Its own pose: nothing to interpolate. Once more after it falls asleep, to settle where it is.
              node._showSimulatedPose(pos, simRotation, pos, simRotation);
            }
          } else if (node.body.mass > 0) {
            // DYNAMIC: physics owns the world pose, and the node's local one is rebased from it under
            // whatever parent it has. A moving parent does not drag the body (as in Unity or Godot).
            // A sleeping body did not move: writing its pose back would only dirty the node's transform (and
            // every descendant's) for nothing. Its motion record still samples, so its speed reads 0.
            node._clearSimulatedPose();
            if (!asleep) {
              node.setWorldPosition(pos);
              const quat = node.body.quaternion;
              node.setWorldQuaternion([quat.x, quat.y, quat.z, quat.w]);
            }
          } else if (this._followVersion.get(node.body) !== node.transformVersion) {
            // STATIC: the body follows its node, so colliders in a moved group (or on a moving platform)
            // stay where they are drawn. Only when the node actually moved, which is rare.
            this._followVersion.set(node.body, node.transformVersion);
            node.body.setTransform(node.worldPosition, node.worldQuaternion);
          }
        }

        if (node.trigger) node.trigger.setTransform(node.worldPosition, node.worldQuaternion);
      }
      } finally {
        authoring.derived--;
      }
      physicsStats.writeBackMs = performance.now() - writeBackStart;

      // AFTER the write-back: triggers now sit where their nodes are, so the trigger↔trigger pass tests
      // this frame's poses, and cannon's pairs and the pass's are diffed together, once. A trigger removed
      // by the write-back (its node was removed) reports its exit in this same frame.
      this._detectTriggerOverlaps();
      this._reportTriggerPairs();

      // Terrain: register/refresh the static heightfield collider(s) so any mesh walks over the landscape.
      const terrainStart = performance.now();
      for (const landscape of this._scene.landscapes) {
        if (landscape.markForRemoval) { landscape.terrain.dispose(this); continue; }
        landscape.terrain.setOrigin(landscape.worldPosition);
        landscape.terrain.ensureRegistered(this);
        // Pooled static colliders for collidable foliage near the camera. Driven from here rather than
        // Scene.update: this is where the world reference is, and the editor never steps physics, which
        // keeps foliage bodies out of authoring mode.
        const cam = this._scene.activeCamera;
        landscape.terrain.updateFoliageColliders(this, cam ? (cam.worldPosition as vec3) : null);
      }
      physicsStats.terrainMs = performance.now() - terrainStart;

      // Tilemaps: same contract as terrain, driven from here for the same two reasons.
      const tilemapStart = performance.now();
      let tilemapColliders = 0;
      for (const node of this._scene.tilemaps) {
        if (node.markForRemoval) { node.tilemap.dispose(this); continue; }
        node.tilemap.setOrigin(node.worldPosition);
        node.tilemap.ensureRegistered(this);
        tilemapColliders += node.tilemap.colliderCount;
      }
      physicsStats.tilemapMs = performance.now() - tilemapStart;
      physicsStats.tilemapColliders = tilemapColliders;

      physicsStats.bodies = this._world?.bodyCount ?? 0;
      // Equal to `bodies` in a healthy world. Larger means bodies were removed without the broadphase
      // hearing about it and are still being simulated against — see pal/cannon/worldTeardown.clearWorld.
      physicsStats.broadphaseBodies = this._world ? this._cannon.broadphaseBodyCount() : 0;
      physicsStats.frameMs = performance.now() - frameStart;
      // AFTER this frame's inline step: a worker that takes over now posts its first step at this frame's
      // end, so no frame goes without one.
      if (this._pendingWorker) this._adoptWorker(deltaTime);
      if (this._workerMode === 'auto') this._autoSwitch(deltaTime);
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
      if (!(body instanceof RigidBody) || !body.isDynamic) continue;
      let state = this._frozen.get(body);

      // Something else woke it: a hit from an awake body, an impulse, a force. Let it be. It is moving for
      // a reason, and refreezing it on the spot would swallow that. It may refreeze after a grace period.
      if (state && !body.isSleeping) {
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
  private _holdGround(body: PhysicsBody, state: FrozenState): void {
    if (!state.grounded) return;
    const stamp = this._ground.get(body);
    if (stamp) stamp.time = this._time;
  }

  /** Whether this system is holding `body` asleep (out of range or at rest). For tests and the HUD. */
  public isFrozen(body: PhysicsBody): boolean { return this._frozen.has(body); }

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
  public addGroundPlane(height = 0): PhysicsBody {
    // A wide, thick box rather than a plane: rays (the ragdoll's ground check, foot IK) do not reliably hit
    // an infinite plane, and nothing here needs it to be infinite.
    const body = new PhysicsBody({ name: 'ground', position: [0, height - 0.5, 0] });
    body.addCollider({ shape: { kind: 'box', halfExtents: [500, 0.5, 500] } });
    this.addBody(body);
    return body;
  }

  public addBody(body: PhysicsBody): void {
    if (!this._world) return;
    if (!this._inWorld.has(body)) this._enterWorld(body);
  }

  /** Whether `body` is in the world (added, and not removed since). */
  public hasBody(body: PhysicsBody): boolean { return this._inWorld.has(body); }

  /** The one way a body enters the world through this system: material, membership, trigger bookkeeping. */
  private _enterWorld(body: PhysicsBody): void {
    // Its surface: a RigidBody brings its own, anything else takes the default.
    this._bodies.set(body._addTo(this._world), body);
    this._inWorld.add(body);
    if (body instanceof Trigger) { this._triggers.add(body); this._localVersion++; }
  }

  /**
   * Take a body out of the world. A trigger overlap it was part of ends with it — the exit is reported at
   * the end of the next step. An engine body keeps its state either way and can be added again; `keep`
   * also keeps it built in the world, disabled, so adding it again costs nothing (a pool's bodies).
   */
  public removeBody(body: PhysicsBody, keep = false): void {
    if (!this._world) return;
    const wasIn = this._inWorld.delete(body);
    if (keep) { if (wasIn) body._disable(); }
    else if (body.world === this._world) { this._bodies.delete(body.handle); body._release(true); }
    this._frozen.delete(body);
    if (body instanceof Trigger && this._triggers.delete(body)) this._localVersion++;
    if (this._triggerPairs.size > 0)
      for (const [key, pair] of this._triggerPairs)
        if (pair.a === body || pair.b === body) this._triggerPairs.delete(key);
    if (this._ttPairs.size > 0)
      for (const [key, pair] of this._ttPairs)
        if ((pair.a as unknown) === body || (pair.b as unknown) === body) this._ttPairs.delete(key);
  }

  // ---- Trigger enter / exit ----

  /**
   * What the step reported, in the order the world reported it (see pal/ PhysicsEventKind): trigger
   * enter/exit, kept for the once-a-frame diff, and first contacts, delivered to the bodies that listen.
   */
  private _drainEvents(): void {
    this._world.drainEvents((kind, a, b) => {
      if (kind === PhysicsEventKind.ContactBegin) {
        const self = this._bodyOf(a), other = this._bodyOf(b);
        if (!self || !other) return;
        try { self._emitCollide(other); }
        catch (e) { Logger.error(`Error in a collision listener on ${self.name}: ${e}`, 'Script'); }
      } else {
        this._onContact(this._bodyOf(a) ?? null, this._bodyOf(b) ?? null, kind === PhysicsEventKind.SensorBegin);
      }
    });
  }

  /** The engine body behind a handle the world reported. */
  private _bodyOf(h: BodyHandle): PhysicsBody | undefined { return this._bodies.get(h); }

  private _onContact(a: PhysicsBody | null, b: PhysicsBody | null, begin: boolean): void {
    // A removed body comes back as null: removeBody has already dropped its pairs.
    if (!a || !b || !(a.isTrigger || b.isTrigger)) return;
    const key = pairKey(a, b);
    if (begin) {
      if (this._inWorld.has(a) && this._inWorld.has(b) && isOn(a) && isOn(b)) this._triggerPairs.set(key, { a, b });
    } else this._triggerPairs.delete(key);
  }

  /** Trigger↔trigger overlaps for this frame (cannon cannot report them). See triggerOverlaps.ts. */
  private _detectTriggerOverlaps(): void {
    if (this._triggers.size < 2 && this._ttPairs.size === 0) return;
    const start = performance.now();
    this._ttPass.run(this._triggers, this.triggerVersion, this._ttPairs, this._geometry);
    physicsStats.triggerPassMs = performance.now() - start;
    physicsStats.triggerCandidates = this._ttPass.stats.candidates;
    physicsStats.triggerPairsTested = this._ttPass.stats.tested;
  }

  /**
   * Fire onTriggerEnter / onTriggerExit for what changed since the last frame, on BOTH nodes of a pair,
   * and each Trigger side's `onContact` listeners. Cannon's trigger↔body pairs and the engine's
   * trigger↔trigger pairs go through the same diff.
   */
  private _reportTriggerPairs(): void {
    if (this._triggerPairs.size === 0 && this._ttPairs.size === 0 && this._reportedPairs.size === 0) {
      physicsStats.triggerOverlaps = 0;
      return;
    }
    for (const [key, rep] of this._reportedPairs) {
      const live = (this._triggerPairs.has(key) || this._ttPairs.has(key)) && isOn(rep.a) && isOn(rep.b);
      // Still overlapping, and neither side was switched off and on again since it was reported.
      if (live && epochOf(rep.a) === rep.ea && epochOf(rep.b) === rep.eb) continue;
      // A body put to sleep inside a trigger drops out of cannon's overlap tracking (sleeping-vs-static is
      // skipped in the broadphase), which reads as an exit. It has not moved: hold the overlap until it
      // wakes, when cannon reports the pair again and nothing is re-entered. Only while both are still
      // in the world and switched on — a removed or disabled side really has left.
      if (!live && (asleep(rep.a) || asleep(rep.b))
          && this._inWorld.has(rep.a) && this._inWorld.has(rep.b) && isOn(rep.a) && isOn(rep.b)) continue;
      this._reportedPairs.delete(key);
      this._dispatchTrigger(rep.a, rep.b, 'exit', null, null, 1);
    }
    for (const [key, pair] of this._triggerPairs) {
      if (this._reportedPairs.has(key) || !isOn(pair.a) || !isOn(pair.b)) continue;
      this._reportedPairs.set(key, { a: pair.a, b: pair.b, ea: epochOf(pair.a), eb: epochOf(pair.b) });
      this._dispatchTrigger(pair.a, pair.b, 'enter', null, null, 1);
    }
    for (const [key, hit] of this._ttPairs) {
      if (this._reportedPairs.has(key)) continue;
      const a = hit.a as unknown as PhysicsBody, b = hit.b as unknown as PhysicsBody;
      this._reportedPairs.set(key, { a, b, ea: epochOf(a), eb: epochOf(b) });
      this._dispatchTrigger(a, b, 'enter', hit.pointOnA, hit.pointOnB, hit.fraction);
    }
    physicsStats.triggerOverlaps = this._reportedPairs.size;
  }

  private _dispatchTrigger(a: PhysicsBody, b: PhysicsBody, phase: 'enter' | 'exit',
                           pointOnA: [number, number, number] | null, pointOnB: [number, number, number] | null, fraction: number): void {
    const na = (a as any).owner, nb = (b as any).owner;
    const hook = phase === 'enter' ? 'onTriggerEnter' : 'onTriggerExit';
    if (na instanceof Node && nb instanceof Node && na !== nb) {
      for (const [self, other] of [[na, nb], [nb, na]] as [Node, Node][]) {
        try { self[hook](other); }
        catch (e) { Logger.error(`Error in ${hook} for node ${self.name}: ${e}`, 'Script'); }
      }
    }
    // Each Trigger side: its overlap count (the overlay's highlight) and its own listeners, which also hear
    // about ownerless bodies and get the contact point.
    const sides: [PhysicsBody, PhysicsBody, [number, number, number] | null][] = [[a, b, pointOnB], [b, a, pointOnA]];
    for (const [self, other, point] of sides) {
      if (!(self instanceof Trigger)) continue;
      const count = (this._overlapCount.get(self) ?? 0) + (phase === 'enter' ? 1 : -1);
      if (count > 0) this._overlapCount.set(self, count); else this._overlapCount.delete(self);
      if (!self._hasContactListeners) continue;
      const owner = (other as any).owner;
      const contact: TriggerContact = {
        phase, self, other: other as PhysicsBody, node: owner instanceof Node ? owner : null,
        point: point ? [point[0], point[1], point[2]] : null, fraction,
      };
      try { self._emitContact(contact); }
      catch (e) { Logger.error(`Error in a trigger contact listener on ${self.name}: ${e}`, 'Script'); }
    }
  }

  /** Every trigger volume in the world, enabled or not. Read-only: add and remove them through nodes. */
  public get triggers(): ReadonlySet<Trigger> { return this._triggers; }

  /**
   * Changes whenever a trigger enters or leaves the world, is enabled or disabled, starts or stops
   * detecting triggers, or is reshaped. What caches trigger state (the editor's overlay) rebuilds on it.
   */
  public get triggerVersion(): number { return triggerState.version + this._localVersion; }

  /** Whether `trigger` is in any reported overlap right now. */
  public isTriggerOverlapping(trigger: PhysicsBody): boolean { return (this._overlapCount.get(trigger) ?? 0) > 0; }

  /** How many trigger overlaps are currently reported to scripts. For tests and the stats panel. */
  public get triggerOverlapCount(): number { return this._reportedPairs.size; }

  /**
   * Every body in the world, read-only — including the foliage collider pool and ragdoll bones, which do
   * not go through `addBody`. For systems that read the colliders wholesale (particle collision); scripts
   * want the shape queries below instead.
   */
  public get bodies(): readonly PhysicsBody[] {
    if (!this._world) return [];
    const handles = this._world.bodies();
    if (handles !== this._bodyListOf) {
      this._bodyListOf = handles;
      this._bodyList = [];
      for (const h of handles) { const b = this._bodyOf(h); if (b) this._bodyList.push(b); }
    }
    return this._bodyList;
  }
  /** {@link bodies}, and the world's handle list it was made from (rebuilt only when that changes). */
  private _bodyList: PhysicsBody[] = [];
  private _bodyListOf: readonly BodyHandle[] | null = null;

  /**
   * Where each body's collision geometry is, as the backend simulates it (see pal/types.ts ColliderPart): what
   * the shape queries, the trigger pass and particle collision measure bodies by.
   */
  public get colliderGeometry(): ColliderGeometry<{ id: number }> { return this._geometry; }

  /** A body's collider parts, placed in its collider frame (see {@link colliderGeometry}). */
  public colliderParts(body: { id: number }): readonly ColliderPart[] {
    const h = body.id as BodyHandle;
    return this._world?.hasBody(h) ? this._world.colliderParts(h) : [];
  }

  private readonly _geometry: ColliderGeometry<{ id: number }> = {
    colliderParts: body => this._world.colliderParts(body.id as BodyHandle),
    colliderFrame: (body, out) => this._world.getColliderFrame(body.id as BodyHandle, out),
  };

  /**
   * One substep of buoyancy from every water volume in the scene (the world's `preStep`). Each volume
   * records what it buoyed, for its surface effects. Character bodies are skipped unless a volume asks:
   * a capsule averages ~150 kg/m³ and locomotion carries vertical velocity over, so water would launch it.
   */
  private _applyWater(substep: number): void {
    const volumes = (this._scene as any)?.waterVolumes as Set<any> | undefined;
    if (!volumes?.size || !this._world) return;
    const g = this._gravity;
    const gravity = Math.hypot(g[0], g[1], g[2]);
    const dt = substep > 0 ? substep : PhysicsSystem.MAX_SUBSTEP;
    const time = this._world.time;
    const isCharacter = (b: PhysicsBody) => (b as any).owner?.nodeType === 'character';
    for (const volume of volumes) {
      if (!volume.enabled) continue;
      const spec = volume.buoyancyVolume(time);
      for (const body of this.bodies) {
        // applyForce wakes a sleeping body: a frozen floater would be thawed every substep.
        if (asleep(body)) continue;
        if (!body.isDynamic || !floats(body, spec, isCharacter)) continue;
        const fraction = applyBuoyancy(this._world, body.id as BodyHandle, body.mass, spec, gravity, dt);
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
  public overlapSphere(center: ArrayLike<number>, radius: number, options?: OverlapOptions<PhysicsBody>): OverlapHit<PhysicsBody>[] {
    const c = v3(center);
    return this._query([{ kind: 'capsule', a: c, b: c, radius }], options);
  }

  /** Bodies touching the capsule from `a` to `b` (its two end centres) with `radius`. See {@link overlapSphere}. */
  public overlapCapsule(a: ArrayLike<number>, b: ArrayLike<number>, radius: number, options?: OverlapOptions<PhysicsBody>): OverlapHit<PhysicsBody>[] {
    return this._query([{ kind: 'capsule', a: v3(a), b: v3(b), radius }], options);
  }

  /**
   * Bodies touching an oriented box. `rotation` is a unit quaternion [x, y, z, w] (a node's
   * `worldQuaternion`) and defaults to none. See {@link overlapSphere}.
   */
  public overlapBox(center: ArrayLike<number>, halfExtents: ArrayLike<number>, rotation?: ArrayLike<number> | null, options?: OverlapOptions<PhysicsBody>): OverlapHit<PhysicsBody>[] {
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
                      radius: number, options?: OverlapOptions<PhysicsBody>): OverlapHit<PhysicsBody>[] {
    return this._query(sweepPoses(v3(a0), v3(b0), v3(a1), v3(b1), radius), options);
  }

  /** Bodies a sphere touches moving from `from` to `to`: a thick ray. See {@link sweepCapsule}. */
  public sweepSphere(from: ArrayLike<number>, to: ArrayLike<number>, radius: number, options?: OverlapOptions<PhysicsBody>): OverlapHit<PhysicsBody>[] {
    const f = v3(from), t = v3(to);
    return this._query(sweepPoses(f, f, t, t, radius), options);
  }

  private _query(poses: QueryShape[], options?: OverlapOptions<PhysicsBody>): OverlapHit<PhysicsBody>[] {
    if (!this._world) return [];
    const start = performance.now();
    // Scripts hand over script proxies; owners are compared by identity, so unwrap to the real nodes.
    const opts = options?.ignore
      ? { ...options, ignore: (Array.isArray(options.ignore) ? options.ignore : [options.ignore]).map(n => unwrapScriptNode(n)) }
      : options;
    const hits = queryPoses(this.bodies as unknown as OverlapBody[], poses, this._geometry, opts as OverlapOptions<OverlapBody>);
    physicsStats.rayMs += performance.now() - start;
    physicsStats.rayCount++;
    return hits as unknown as OverlapHit<PhysicsBody>[];
  }

  /**
   * Join two engine bodies (both in the world): see pal/types.ts JointDesc for the kinds. Returns the
   * joint, for {@link removeJoint}; a world clear removes every joint.
   */
  public addJoint(a: PhysicsBody, b: PhysicsBody, joint: JointSpec): JointHandle | null {
    if (!this._world || a.world !== this._world || b.world !== this._world) return null;
    return this._world.createJoint({ ...joint, a: a.handle, b: b.handle } as JointDesc);
  }

  public removeJoint(joint: JointHandle): void {
    this._world?.destroyJoint(joint);
  }

  /**
   * Record how ground-like each body's best contact is this frame. Must run immediately after the step, while
   * `world.contacts` still describes it — the equations are pooled and rewritten in place, so retain nothing.
   */
  private _stampGroundContacts(contacts: ContactSource): void {
    const world = this._world;
    if (!world) return;

    // No gravity means no "down", so nothing can be ground; leaving the stamps alone lets them expire.
    const g = this._gravity;
    const gLength = Math.hypot(g[0], g[1], g[2]);
    if (gLength === 0) return;
    const downX = g[0] / gLength, downY = g[1] / gLength, downZ = g[2] / gLength;

    contacts.forEachContact((a, b, nx, ny, nz) => {
      const bi = this._bodyOf(a), bj = this._bodyOf(b);
      if (!bi || !bj) return;
      // The normal points OUT of bi, i.e. from bi towards bj (negate for bj). Its agreement with gravity IS
      // the measure of ground-likeness.
      const dot = nx * downX + ny * downY + nz * downZ;

      // Trigger volumes reach the contacts: cannon only discards them later, when the solver builds
      // equations. The stored surface normal points back OUT of the ground, hence the negations.
      if (!bj.isTrigger) this._record(bi, dot, [-nx, -ny, -nz]);
      if (!bi.isTrigger) this._record(bj, -dot, [nx, ny, nz]);
    });

    // Ground probe. A resting contact blinks out for the odd frame (see GROUND_GRACE); bodies that opted in
    // (groundProbeDistance > 0) also get a short downward raycast feeding the SAME stamp, which never
    // vanishes. Off by default.
    for (const body of this.bodies) {
      if (!(body instanceof RigidBody) || body.isTrigger || body.groundProbeDistance <= 0) continue;
      // Asleep: it has not moved, and its held stamp (see _holdGround) already answers isGrounded.
      if (body.isSleeping) continue;
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
    body: RigidBody, downX: number, downY: number, downZ: number, probeDistance: number
  ): { dot: number; normal: [number, number, number]; gap: number } | null {
    if (!this._world) return null;

    // Distance from the body's centre (its collider frame: the centre of mass) to the bounds corner reaching
    // furthest along "down"; each axis picks its own further bound, so this holds for any gravity direction.
    const box = body.getAabb(this._probeBox), p = this._probeFrame;
    body.getColliderFrame(p);
    const extent =
      Math.max(downX * (box[0] - p[0]), downX * (box[3] - p[0])) +
      Math.max(downY * (box[1] - p[1]), downY * (box[4] - p[1])) +
      Math.max(downZ * (box[2] - p[2]), downZ * (box[5] - p[2]));
    const reach = extent + probeDistance;
    if (reach <= 0) return null;

    const hit = this.raycast(
      [p[0], p[1], p[2]],
      [p[0] + downX * reach, p[1] + downY * reach, p[2] + downZ * reach],
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

  private readonly _probeBox = new Float64Array(6);
  private readonly _probeFrame = new Float64Array(7);

  private _record(body: PhysicsBody, dot: number, normal: [number, number, number], gap?: number): void {
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
  public isGrounded(body: PhysicsBody, maxSlopeDegrees: number = 60, graceSeconds: number = GROUND_GRACE): boolean {
    // A trigger passes through everything, so it never rests on anything.
    if (!this._world || !body || body.isTrigger) return false;

    const g = this._gravity;
    if (Math.hypot(g[0], g[1], g[2]) === 0) return false;

    const stamp = this._ground.get(body);
    if (!stamp || this._time - stamp.time > graceSeconds) return false;
    return stamp.dot >= Math.cos(maxSlopeDegrees * Math.PI / 180);
  }

  /**
   * Surface normal of the ground `body` is standing on, pointing up out of that surface — [0,1,0] on level
   * ground under normal gravity. Backs {@link Node.groundNormal}. Falls back to UP (gravity reversed) when
   * the body is not grounded, has no stamp, or gravity is zero, so callers can project onto it unguarded.
   */
  public groundNormal(body: PhysicsBody, maxSlopeDegrees: number = 60, graceSeconds: number = GROUND_GRACE): vec3 {
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
  public groundDistance(body: PhysicsBody): number {
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
    const g = this._gravity;
    const length = Math.hypot(g[0], g[1], g[2]);
    if (length === 0) return vec3.fromValues(0, 1, 0);
    return vec3.fromValues(-g[0] / length, -g[1] / length, -g[2] / length);
  }

  /**
   * Measured motion for a body — how fast it ACTUALLY moved, not what was commanded of it. Backs
   * {@link Node.currentSpeed} and family. Undefined until the body has been through a write-back pass.
   */
  public motionOf(body: PhysicsBody): MotionRecord | undefined {
    return this._motion.get(body);
  }

  /** This body's motion tuning, from its own `motionSmoothing` where it set one. Cached per body. */
  private _motionConfigFor(body: PhysicsBody): MotionConfig {
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
  public airborneTimes(body: PhysicsBody): { airTime: number; groundedTime: number } {
    return this._airborne.get(body) ?? { airTime: 0, groundedTime: 0 };
  }

  /**
   * Advance the per-body air/ground clocks. Must run after the ground stamps are in. Only bodies with a
   * motion record are tracked, i.e. the simulated ones, excluding the pooled foliage colliders.
   */
  private _updateAirborneTimes(deltaTime: number): void {
    // initialize() swallows a World construction failure, so every per-frame pass must tolerate no world.
    if (deltaTime <= 0 || !this._world) return;
    for (const body of this.bodies) {
      if (!this._motion.has(body)) continue;
      // Frozen clocks for a frozen body: neither airborne nor grounded time passes for something asleep.
      if (asleep(body)) continue;
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
   * @param seeThrough The probe of a 'dither' camera rig: what opted into the see-through hole
   *               (`cameraDither`) does not block it.
   */
  public raycastCamera(from: vec3, to: vec3, reject?: (owner: Node | null) => boolean, seeThrough: boolean = false): number | null {
    // The standard filters are turned OFF and delegated wholesale to skipCameraHit; applying both would
    // change which bodies block a camera.
    const hit = this.raycast(from, to, {
      checkCollisionResponse: false,
      includeTriggers: true,
      includeGhosts: true,
      reject: (_owner, body) => skipCameraHit(body as CameraProbeBody | null, reject, seeThrough),
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

    let nearest: PhysicsRaycastHit | null = null;
    // Every hit, in the backend's order, keeping the nearest one the filters let through: the backend's
    // `closest` would hand back a trigger volume with no way to reject it and continue.
    world.raycast(from, to, {
      mode: 'all',
      // The solidity filter is on by default; the camera turns it off so ghosts still block the boom.
      includeNoResponse: !(opts.checkCollisionResponse ?? true),
      excludeDynamic: !!opts.groundOnly,
    }, hit => {
      const body = this._bodyOf(hit.body);
      if (!body) return;
      if (nearest !== null && hit.distance >= nearest.distance) return;
      if (skipRayHit(body as unknown as RayHitBody, opts as RayFilter<RayHitBody>)) return;

      const owner = (body as any).owner instanceof Node ? (body as any).owner as Node : null;
      const p = hit.point, n = hit.normal;
      nearest = {
        point: vec3.fromValues(p[0], p[1], p[2]),
        normal: vec3.fromValues(n[0], n[1], n[2]),
        distance: hit.distance,
        body,
        node: owner,
      };
    });

    physicsStats.rayMs += performance.now() - rayStart;
    physicsStats.rayCount++;
    return nearest;
  }

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
    const world = this._world;
    if (!world) return;
    let want = 0;
    for (const r of this._ragdolls) if (!r.frozen && !r.destroyed) want = Math.max(want, r.solverIterations);
    if (want > 0) {
      if (this._baseIterations === null) this._baseIterations = world.solverIterations;
      world.solverIterations = Math.max(this._baseIterations, want);
    } else if (this._baseIterations !== null) {
      world.solverIterations = this._baseIterations;
      this._baseIterations = null;
    }
  }

  /** The solver iteration count in force (for tests and the stats panel). */
  public get solverIterations(): number {
    return this._world?.solverIterations ?? 0;
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

    // The engine bodies keep their last state and forget their handles: a body added again later is made
    // afresh. Then every joint and every body goes (see the cannon backend's clear for the traps that used
    // to strand half of every play session's bodies in its broadphase for the lifetime of the page).
    for (const body of this._bodies.values()) body._release(false);
    this._bodies.clear();
    this._world.clear();
    this._inWorld.clear();
    this._frozen.clear();
    // The scene is going away: no exits are reported for it.
    this._triggerPairs.clear();
    this._reportedPairs.clear();
    this._triggers.clear();
    this._ttPairs.clear();
    this._ttPass.clear();
    this._overlapCount.clear();
    this._localVersion++;
    this._executor?.reset();
    this._pendingWorker?.reset();
  }

  // ---- Where the step runs ----

  /**
   * End of the frame, after every script has run (CleoEngine calls it before rendering). With the worker,
   * this is where the frame's changes are diffed and its step posted — the worker steps while this thread
   * renders, and the next update applies the result. Inline, nothing.
   */
  public endFrame(deltaTime: number, nextTimeScale: number = 1): void {
    if (this._executor?.kind !== 'worker') return;
    try {
      // The worker's activation: what the inline executor does just before stepping. Not twice in the frame
      // the step moved over, whose inline update already ran it.
      if (!this._activatedThisFrame) this._updateActivation(deltaTime);
      this._activatedThisFrame = false;
      this._executor.endFrame(deltaTime, nextTimeScale);
    } catch (e) {
      Logger.error(`Physics: ${e}`);
    }
  }

  /**
   * How this host makes a physics worker, set once at startup by an app that can (the editor, the
   * published player): typically `() => new Worker(new URL(...), { type: 'module' })` with the bundler's
   * syntax for physics/worker/physicsWorker.ts. Left null, every world steps on the main thread.
   */
  public static workerFactory: (() => Worker | PhysicsPort) | null = null;

  /** Where the step runs now: 'inline' (this thread) or 'worker'. */
  public get executor(): 'inline' | 'worker' { return this._executor?.kind ?? 'inline'; }

  /** The mode set with {@link setWorkerMode}. */
  public get workerMode(): PhysicsWorkerMode { return this._workerMode; }

  /**
   * Where the worker stands, for the Performance HUD: `state` is where the step runs now ('starting' while a
   * worker warms up and this thread still steps); `fallback` why it came back to this thread, or could not
   * leave it, since the mode was last set; `autoStepMs` the step-time average the auto mode decides by;
   * `sharedReplies` whether the worker's results are read from shared memory (a cross-origin isolated
   * page) rather than waiting for their message.
   */
  public get workerStatus(): { state: 'inline' | 'starting' | 'worker'; fallback: string | null; autoStepMs: number; sharedReplies: boolean } {
    return {
      state: this._pendingWorker ? 'starting' : this.executor,
      fallback: this._workerFallback,
      autoStepMs: this._auto.stepEma,
      sharedReplies: this._executor.kind === 'worker' && (this._executor as WorkerExecutor).sharedReplies,
    };
  }

  /**
   * Run the step in a Web Worker: `'on'` now, `'auto'` once this world proves heavy enough to gain from it
   * (and back if the worker cannot keep up), `'off'` never. `create` makes the worker — a host-specific
   * bundler import of physics/worker/physicsWorker.ts, a `Worker`, or a port (tests) — and without it the
   * step stays inline whatever the mode. If the worker fails, physics falls back to this thread, where it
   * carries on from the worker's last step.
   */
  public setWorkerMode(mode: PhysicsWorkerMode, create?: (() => Worker | PhysicsPort) | null): void {
    this._workerMode = mode;
    const factory = create !== undefined ? create : PhysicsSystem.workerFactory;
    this._workerFactory = factory ? () => {
      const made = factory();
      return typeof (made as any).postMessage === 'function' && !('poll' in made) ? new WorkerPort(made as Worker) : made as PhysicsPort;
    } : null;
    this._auto = PhysicsSystem._freshAuto();
    this._workerFallback = mode !== 'off' && !factory ? 'This host has no physics worker.' : null;
    if (mode === 'on') this._useWorker();
    else if (mode === 'off') this._useInline();
  }

  /** `frameDt`: called from update() with its delta, whose inline activation has already run; else 0. */
  private _useWorker(frameDt = 0): boolean {
    if (this._executor?.kind === 'worker' || this._pendingWorker) return true;
    if (!this._workerFactory || !this._world) return false;
    // One core: the worker would take its time from the same core the frame needs, and stepping inline
    // costs nothing to copy.
    if (PhysicsSystem.cores() < 2 && typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
      this._workerFallback = 'This device has a single CPU core: the step stays on the main thread.';
      this._auto.gaveUp = true;
      return false;
    }
    try {
      const port = this._workerFactory();
      const worker = new WorkerExecutor({
        world: this._cannon.raw,
        onContact: (a, b, begin) => this._onContact(this._bodyOf(a.id as BodyHandle) ?? null, this._bodyOf(b.id as BodyHandle) ?? null, begin),
        water: () => this._waterSpecs(),
        substepsFor: dt => PhysicsSystem.substepsFor(dt, this.maxSubsteps),
        profileStep: () => this.profileStep,
        stateChanged: () => this._cannon.touch(),
        onFailure: (error) => {
          const reason = error instanceof Error ? error.message : String(error);
          Logger.warn(`Physics worker failed (${reason}); stepping on the main thread instead.`, 'Physics');
          this._workerFallback = `The worker failed: ${reason}`;
          this._auto.gaveUp = true;
          this._useInline();
        },
      }, port);
      // Warm-up: this thread keeps stepping until the worker has the world and has answered, so a worker
      // that takes a moment to start (loading its module, building the big colliders) freezes no frame.
      this._pendingWorker = worker;
      worker.prime();
      this._adoptWorker(frameDt);    // already answered (an in-process port)
      return true;
    } catch (e) {
      Logger.warn(`Physics worker could not start (${e}); stepping on the main thread.`, 'Physics');
      this._workerFallback = `The worker could not start: ${e instanceof Error ? e.message : String(e)}`;
      this._auto.gaveUp = true;
      return false;
    }
  }

  private _useInline(): void {
    this._pendingWorker?.dispose();
    this._pendingWorker = null;
    if (this._executor?.kind === 'inline') return;
    this._executor?.dispose();
    this._executor = this._inlineExecutor();
  }

  /**
   * Hand the step to the warming-up worker once it has answered (see _useWorker). `frameDt` is the delta of
   * the frame doing it, already stepped inline (0 outside a frame): the worker's clock starts with it.
   */
  private _adoptWorker(frameDt: number): void {
    const worker = this._pendingWorker;
    if (!worker || !worker.poll()) return;
    this._pendingWorker = null;
    worker.adopt(frameDt, this._timeScale);
    this._workerFallback = null;   // a retry that worked: nothing to explain any more
    this._executor = worker;
    this._activatedThisFrame = frameDt > 0;
  }

  /**
   * The auto mode. Start inline; after two seconds of play, move the step to the worker if it costs this
   * thread enough (an average of 1.5 ms or more, or 40+ moving bodies) on a machine with cores to spare.
   * Come back if the worker cannot keep up: more than 10% of frames late over three seconds.
   */
  private _autoSwitch(dt: number): void {
    const a = this._auto;
    if (a.gaveUp) return;
    if (this._executor.kind === 'inline') {
      a.watched += dt;
      a.stepEma += (physicsStats.stepMs - a.stepEma) * Math.min(1, dt * 2);
      if (a.watched < a.retryAt) return;            // fell behind a while ago: wait before trying again
      if (a.watched >= 2 && PhysicsSystem.cores() >= 4 && (a.stepEma >= 1.5 || physicsStats.activeBodies >= 40)) {
        if (!this._useWorker(dt)) a.gaveUp = true;
      }
      return;
    }
    const worker = this._executor as WorkerExecutor;
    a.workerWatched += dt;
    if (a.workerWatched < 3) return;
    const posted = worker.postedFrames - a.postedAt, late = worker.lateFrames - a.lateAt;
    a.workerWatched = 0; a.postedAt = worker.postedFrames; a.lateAt = worker.lateFrames;
    // One bad window is a hitch (a GC pause, a shader compile, the tab losing focus), and a late step costs
    // little: its frame draws the bodies carried along their velocities. Only lateness that LASTS — two
    // windows in a row — moves the step back, and not for good: Auto tries the worker again later.
    if (late <= 0.1 * Math.max(1, posted + late)) { a.badWindows = 0; return; }
    if (++a.badWindows < 2) return;
    Logger.warn('Physics worker falls behind on this machine; stepping on the main thread for a while.', 'Physics');
    this._workerFallback = `The worker fell behind: ${late} of ${posted + late} frames late. Auto tries it again in ${AUTO_RETRY_SECONDS} s.`;
    a.badWindows = 0;
    a.retryAt = a.watched + AUTO_RETRY_SECONDS;
    this._useInline();
  }

  /** Logical cores, or 1 where the browser does not say. */
  public static cores(): number {
    const n = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
    return typeof n === 'number' && n > 0 ? n : 1;
  }


  /** The enabled water volumes as plain data for the worker, with where to report what each buoyed. */
  private _waterSpecs(): { spec: import('./waterSurface').WaterSpec; record: (body: { id: number }, fraction: number) => void }[] {
    const volumes = (this._scene as any)?.waterVolumes as Set<any> | undefined;
    if (!volumes?.size) return [];
    const out: { spec: import('./waterSurface').WaterSpec; record: (body: { id: number }, fraction: number) => void }[] = [];
    for (const volume of volumes) {
      if (!volume.enabled || typeof volume.buoyancySpec !== 'function') continue;
      out.push({ spec: volume.buoyancySpec(), record: (body, fraction) => {
        // The worker reports the main thread's copy of the body: the engine body behind it is what floats.
        const engineBody = this._bodyOf(body.id as BodyHandle);
        if (engineBody) volume.recordSubmerged(engineBody, fraction);
      } });
    }
    return out;
  }

  public set scene(scene: Scene) {
    this.clear();
    this._scene = scene;
    scene.physics = this;
  }

  /** Current gravity vector (m/s^2). Settable at runtime. */
  public get gravity(): [number, number, number] {
    return [this._gravity[0], this._gravity[1], this._gravity[2]];
  }
  public set gravity(g: [number, number, number]) {
    this._gravity = [g[0], g[1], g[2]];
    if (this._world) this._world.gravity = g;
  }
}