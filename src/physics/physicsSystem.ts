import { Logger } from "../core/logger";
import { logScriptError } from "../core/scripting/scriptErrors";
import { Scene } from "../core/scene/scene";
import { Node } from "../core/scene/nodes/node";
import { ModelNode } from "../core/scene/nodes/modelNode";
import { unwrapScriptNode, routeTrigger } from "../core/scene/nodes/nodeScripting";
import { quat, vec3 } from "gl-matrix";
import { authoring } from "../core/eventBus";
import { RigidBody, Trigger, triggerState } from "./body";
import type { TriggerContact } from "./body";
import { TriggerOverlapPass, TriggerOverlap, pairKey } from "./triggerOverlaps";
import { Ragdoll, RagdollOptions } from "./ragdoll";
import type { Vehicle } from "./vehicle";
import { skipCameraHit, CameraProbeBody, CameraProbeLayers, skipRayHit, RayHitBody, RayFilter } from "./cameraRayFilter";
import { DEFAULT_LAYER_NAMES, layerByName, normalizeLayerNames } from "./collisionLayers";
import { physicsStats, resetPhysicsStats, PhysicsStats } from "./physicsStats";
import { MotionRecord, MotionConfig, createMotionRecord, sampleMotion, motionConfig } from "./motion";
import { OverlapHit, OverlapOptions, OverlapBody, QueryShape, queryPoses, sweepPoses } from "./overlap";
import { applyBuoyancy, floats, type BuoyancyVolume } from "./buoyancy";
import { setWaterClock } from "./water/waterClock";
import { InlineExecutor } from "./executor/inlineExecutor";
import { WorkerExecutor } from "./executor/workerExecutor";
import type { ContactSource, PhysicsExecutor, SubstepHooks } from "./executor/physicsExecutor";
import { CharacterContactRule, type ContactBodyInfo } from "./characterContacts";
import { SlopeHold, type SlopeHoldRequest } from "./slopeHold";
import { acquirePhysicsBackend, createPhysicsWorld, isPhysicsBackendLoaded } from "./pal/createWorld";
import { FALLBACK_PHYSICS_BACKEND, resolvePhysicsBackendRequest } from "./pal/backendSelect";
import type { PhysicsCapabilities } from "./pal/capabilities";
import type { PhysicsWorld } from "./pal/world";
import { PhysicsEventKind, type BodyHandle, type ColliderGeometry, type ColliderPart } from "./pal/types";
import { PhysicsBody } from "./physicsBody";
import type { BodyPin, JointDesc, JointDrive, JointHandle, PhysicsBackendKind } from "./pal/types";
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
  /**
   * The physics engine to simulate with, as a request (see pal/backendSelect.ts): 'jolt' (the default), 'rapier'
   * or 'cannon'. One that cannot run here runs on cannon, and {@link PhysicsSystem.backendFallbackReason} says why.
   */
  backend?: string;
  /** The project's collision layer names (see collisionLayers.ts), for {@link PhysicsSystem.layer}. */
  layers?: readonly string[];
}

/** {@link PhysicsSystem.raycastCamera}'s layers when none are given: every solid body blocks. */
const EVERY_LAYER_BLOCKS: CameraProbeLayers = Object.freeze({ blockedBy: -1, seeThrough: 0 });

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
  /** A ragdoll's body: the ragdoll, and which of its parts (Ragdoll.parts) was hit. */
  ragdoll?: Ragdoll;
  part?: number;
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
  /**
   * Only bodies on one of these collision layers (`collisionFilterGroup & layerMask`), as the overlap queries'
   * `layerMask`. Build one with {@link PhysicsSystem.layers}. Bodies the engine makes itself (terrain, the
   * ground plane, tilemaps, foliage without a layer) are on the Default layer. Default: every layer.
   */
  layerMask?: number;
  /**
   * Only what this body would collide with: its mask holds the hit's layer AND the hit's mask holds its layer.
   * What a body's own "what is under me" probe wants.
   */
  collidingWith?: PhysicsBody | null;
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
  /**
   * Node bodies taken out of the world for now (ColliderNode.physicsEnabled false), and whether each stood on
   * the ground when it left: a character carried in a car seat neither falls nor lands while it rides.
   */
  private _suspended = new Map<PhysicsBody, { grounded: boolean }>();
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
  /** Vehicles carried by bodies of this world (see addVehicle). */
  private readonly _vehicles = new Set<Vehicle>();
  /** When a frozen body was last woken by something else (a hit, an impulse): it gets a grace period. */
  private _wokenAt = new WeakMap<PhysicsBody, number>();
  /** Per `canSleep` body: seconds it has been continuously at rest. */
  private _restTime = new WeakMap<PhysicsBody, number>();
  /**
   * Per dynamic body: the other dynamic bodies it touched in the last step. A resting body sleeps only with
   * everything it touches (see _updateActivation), as the backends' own sleep does by islands.
   */
  private _touching = new Map<PhysicsBody, PhysicsBody[]>();
  /** This frame's resting bodies, while _updateActivation decides which of them sleep. */
  private readonly _resting = new Set<RigidBody>();

  constructor(config?: PhysicsSystemConfig) {
    this._gravity = config?.gravity ? config.gravity: [0, -9.82, 0]; // y = up
    this._backendRequest = config?.backend ?? null;
    if (config?.layers) this.layerNames = config.layers;
  }

  private _layerNames: readonly string[] = DEFAULT_LAYER_NAMES;
  private readonly _unknownLayers = new Set<string>();

  /**
   * The project's collision layer names (Options > Project > Layers), index 0 being layer 1. The first
   * four are the engine's: Default, Ragdoll, See Through and No Camera. An unnamed layer is "Layer N".
   */
  public get layerNames(): readonly string[] { return this._layerNames; }
  public set layerNames(names: readonly string[]) { this._layerNames = normalizeLayerNames(names); }

  /**
   * The bit of the collision layer called `name` ("Default", "No Camera", a project's own, or "Layer 7"), for a
   * collider's `layer` or a query's mask. 0, with a warning once per name, for a layer the project does not have.
   */
  public layer(name: string): number {
    const bit = layerByName(this._layerNames, name);
    if (bit === 0 && !this._unknownLayers.has(name)) {
      this._unknownLayers.add(name);
      Logger.warn(`There is no collision layer called '${name}' (Options > Project > Layers).`, 'Physics');
    }
    return bit;
  }

  /** The mask of every collision layer named: `physics.raycast(a, b, { layerMask: physics.layers('Default', 'Stairs') })`. */
  public layers(...names: string[]): number {
    let mask = 0;
    for (const name of names) mask |= this.layer(name);
    return mask;
  }

  private readonly _backendRequest: string | null;
  private _backendFallbackReason: string | null = null;
  /** {@link load} under way or done; why the backend could not be loaded, when it could not. */
  private _loading: Promise<void> | null = null;
  private _loadFailure: string | null = null;

  /** The physics engine simulating (see pal/). Before {@link initialize}, the one that will. */
  public get backend(): PhysicsBackendKind { return this._world?.backend ?? resolvePhysicsBackendRequest(this._backendRequest).kind; }

  /** The physics engine asked for. Differs from {@link backend} when the request could not be met. */
  public get requestedBackend(): string { return this._backendRequest ?? this.backend; }

  /** Why {@link backend} is not {@link requestedBackend}, or null when the request was met. */
  public get backendFallbackReason(): string | null { return this._backendFallbackReason; }

  /** What the backend can do (see pal/capabilities.ts); null before {@link initialize}. */
  public get capabilities(): PhysicsCapabilities | null { return this._world?.capabilities ?? null; }

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
   * Where simulation range is measured from, in place of the active camera: a body is in range when it is
   * near any of these points. A NetSync host, which has no camera, measures from its players' characters.
   * `null` (the default) is the camera. No points: nothing is frozen for range, as with no camera.
   */
  public simulationOrigins: (() => readonly ArrayLike<number>[]) | null = null;

  /**
   * Measure the backend's own split of the step (the phases its capabilities list) into the stats. Costs a few
   * `performance.now()` per substep, so the performance HUD turns it on only while it is showing.
   */
  public profileStep: boolean = false;

  /**
   * Build the world: on `world` when given (a backend the host acquired, see pal/createWorld.ts), else on
   * the backend the config asked for (see pal/backendSelect.ts). Synchronous either way.
   */
  public initialize(world?: PhysicsWorld): void {
    try {
      if (!world) {
        let { kind, reason } = resolvePhysicsBackendRequest(this._backendRequest);
        // A backend whose library loads first (see load) and has not: cannon, which needs no loading, saying why.
        // Not the default: that is a backend that loads first too.
        if (!isPhysicsBackendLoaded(kind)) {
          const notLoaded = this._loadFailure ?? `the ${kind} backend was not loaded before the world was built`;
          reason = reason ? `${reason}, and ${notLoaded}` : notLoaded;
          kind = FALLBACK_PHYSICS_BACKEND;
        }
        this._backendFallbackReason = reason;
        // Built the same way the physics worker builds its own, so both step alike.
        world = createPhysicsWorld(kind, this._gravity);
      }
      this._world = world;
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

  /**
   * Load what the requested backend needs before it can build a world (a WASM engine's library), so that
   * {@link initialize} can build it. Started early by the engine and awaited before initialize; cannon
   * needs nothing. Never rejects: a backend that cannot load is reported, and initialize falls back.
   */
  public load(): Promise<void> {
    return this._loading ??= (async () => {
      const { kind } = resolvePhysicsBackendRequest(this._backendRequest);
      try {
        await acquirePhysicsBackend(kind);
      } catch (e) {
        this._loadFailure = `the ${kind} backend failed to load: ${e instanceof Error ? e.message : String(e)}`;
      }
    })();
  }

  private _inlineExecutor(): InlineExecutor {
    return new InlineExecutor(() => this._world, dt => PhysicsSystem.substepsFor(dt, this.maxSubsteps), () => this.profileStep, this._substepHooks);
  }

  // A character is not pushed about by lighter bodies (physics/characterContacts.ts): the rule runs around each
  // substep, here and, with the worker, in WorkerCore on the same terms.
  private readonly _characterRule = new CharacterContactRule();
  private readonly _characterList: { handle: BodyHandle; mass: number }[] = [];
  /** A body as the rule reads it: an engine body is one when it is dynamic; anything else is solid. */
  private readonly _contactInfo = (h: BodyHandle): ContactBodyInfo | undefined => {
    const b = this._bodies.get(h);
    return b && b.isDynamic ? b : undefined;
  };
  private readonly _substepHooks: SubstepHooks = {
    begin: world => {
      const list = this._characterList;
      list.length = 0;
      for (const [handle, body] of this._bodies) if (body.isCharacter && body.isDynamic && body.world === world) list.push({ handle: handle as BodyHandle, mass: body.mass });
      this._characterRule.watch(list);
      // The holds asked for while the last frame's scene ran (physics/slopeHold.ts).
      this._slopeHold.hold(this._slopeHoldsOf(this._holdFrame - 1, world));
    },
    // The contact rule reads what a step added past the gravity it applied, which the hold changes.
    before: world => { this._slopeHold.before(world); this._characterRule.before(world); },
    after: (world, h) => { this._slopeHold.after(world, this._standable); this._characterRule.after(world, h, this._contactInfo, this._heldGravity); },
  };

  // A character standing on a slope does not slide down it (physics/slopeHold.ts). It asks every frame it stands
  // on walkable ground (CharacterNode, `slopeLimit`); the next step holds it, and only that one.
  private readonly _slopeHold = new SlopeHold();
  private readonly _holdRequests = new Map<PhysicsBody, { cosLimit: number; frame: number }>();
  private readonly _holdList: SlopeHoldRequest[] = [];
  /** Counts updates: what a hold request is stamped with, so a request is used by the next step alone. */
  private _holdFrame = 0;
  private readonly _heldGravity = (h: BodyHandle) => this._slopeHold.gravityOf(h);
  /** What a held character can stand on: not a trigger, not a body the solver ignores. */
  private readonly _standable = (h: BodyHandle): boolean => {
    const b = this._bodies.get(h);
    return !b || (!b.isTrigger && b.collisionResponse);
  };

  /**
   * Hold `body` on its slope over the next step: the share of gravity along the ground it stands on is taken off
   * it, on ground no steeper than `maxSlopeDegrees`, so it stands without sliding down and starts, brakes and
   * climbs as on the flat. A request for the coming step only: ask again every frame it should hold. What a
   * Character does with its `slopeLimit`; a dynamic body only.
   */
  public holdOnSlope(body: PhysicsBody, maxSlopeDegrees: number): void {
    if (!body || !body.isDynamic || !(maxSlopeDegrees > 0)) return;
    const degrees = Math.min(89, maxSlopeDegrees);
    this._holdRequests.set(body, { cosLimit: Math.cos(degrees * Math.PI / 180), frame: this._holdFrame });
  }

  /** The holds stamped `frame` on bodies of `world` (older ones are dropped), as a step reads them. */
  private _slopeHoldsOf(frame: number, world: PhysicsWorld): SlopeHoldRequest[] {
    const list = this._holdList;
    list.length = 0;
    for (const [body, r] of this._holdRequests) {
      if (r.frame < frame) { this._holdRequests.delete(body); continue; }
      if (r.frame !== frame || body.world !== world || body.handle < 0) continue;
      list.push({ handle: body.handle, mass: body.mass, cosLimit: r.cosLimit });
    }
    return list;
  }

  /**
   * `deltaTime` is game time: the frame's delta with the engine's time scale applied. `timeScale` is that
   * scale (1 unless slow motion or a hit-stop runs), which the worker predicts its next step's reach by.
   */
  public update(deltaTime: number, timeScale: number = 1): void {
    this._timeScale = timeScale;
    this._holdFrame++;
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
      // This frame's driver input, into vehicles built where their chassis is now.
      if (inline) this._syncVehicles();
      const result = this._executor.step(deltaTime, timeScale);
      // What the step (inline, or the worker's just applied) left them at.
      this._readVehicles();
      physicsStats.executor = this._executor.kind;
      // What the step reported: inline, as it ran; with the worker, as its result was applied just now.
      this._drainEvents();
      // Seconds actually simulated. Inline, the frame's own; with the worker, its step's — or 0 while it
      // is still running, when nothing below that depends on a step happening runs.
      const stepDt = inline ? deltaTime : result.dt;

      if (inline || stepDt > 0) {
        this._updateRagdolls(stepDt);
        // update() runs only while unpaused, so the grace window cannot expire behind a paused game.
        this._time += stepDt;
        this._stampGroundContacts(result.contacts);
        this._holdSuspendedGround();
        this._recordTouching(result.contacts);
        // Must follow the stamps, so the clocks agree with what isGrounded answers this frame.
        this._updateAirborneTimes(stepDt);
      }
      physicsStats.contacts = result.contacts.contactCount;

      const writeBackStart = performance.now();
      const nodes = this._scene.nodes;
      const spawnRules = this._scene.spawnRulesEnabled !== false;
      const worker = this._executor.kind === 'worker' ? this._executor as WorkerExecutor : null;
      // The water's clock, in a scene that runs: the time the bodies are drawn at, so the waves drawn under
      // a floating crate are the waves the crate rides (physics/water/waterClock.ts).
      if (spawnRules && this._world) setWaterClock(worker ? worker.drawnTime : this._world.time);
      // A body moving its node is simulation, never an edit (see authoring.derived).
      authoring.derived++;
      try {
      for (const node of nodes) {
        // A node's OWN body: a Character's `body` is its Collider's, which that collider syncs itself.
        // A Collider or Trigger node built in code (never parsed into a running scene) builds it now -- in a
        // scene that runs. One that authors (spawn rules off: the editor's) steps physics for its previews,
        // and must never give a Collider it is editing a body.
        if (node.wantsPhysicsBuild && spawnRules) node.buildPhysics();
        const ownBody = node.ownBody;
        if ((!ownBody && !node.trigger) || !node.hasStarted) continue;

        // Its body turned off or back on (ColliderNode.physicsEnabled) before there was a body or a system to
        // tell: applied now. A suspended body stays out of the world and its node moves on its own.
        const suspended = !!ownBody && node._bodySuspended && !node.markForRemoval;
        if (ownBody && !node.markForRemoval && suspended !== this._suspended.has(ownBody)) {
          if (suspended) this.suspendBody(ownBody);
          else this.resumeBody(ownBody, node.worldPosition, node.worldQuaternion);
        }

        // BOTH, when a node has both: a solid door or gate with an interaction zone around it. This used to
        // be `node.body || node.trigger`, which silently left such a node's trigger out of the world.
        for (const bodyToAdd of [ownBody, node.trigger]) {
          if (!bodyToAdd) continue;
          if (node.markForRemoval) {
            // Removing the body is what stops the callbacks: the 'collide' listener registered in
            // Node.setBody/setTrigger is an anonymous arrow, so removeEventListener can never match it.
            this.removeBody(bodyToAdd);
          } else if (!this._inWorld.has(bodyToAdd) && !(suspended && bodyToAdd === ownBody)) {
            this._enterWorld(bodyToAdd);
          }
        }

        if (ownBody && !suspended) {
          // Where the NODE sits, not where the body's centre of mass does: with an offset collider the
          // two differ by RigidBody's centre-of-mass offset (see RigidBody.recenterMass).
          const pos = ownBody.position.toArray();
          const asleep = ownBody.isSleeping;

          // Must sample after world.step() and before Scene.update runs every script's onUpdate, so a script
          // reading node.currentSpeed sees the step that just happened rather than last frame's.
          let motion = this._motion.get(ownBody);
          if (!motion) { motion = createMotionRecord(); this._motion.set(ownBody, motion); }
          // Over the time actually simulated: a frame whose worker step has not come back moved nothing, and
          // sampling it would read as a stop.
          if (stepDt > 0) sampleMotion(
            // The node's own travel, so currentSpeed still measures what the node did — a body spinning
            // about an offset centre of mass would otherwise read as movement.
            motion, [pos[0], pos[1], pos[2]], stepDt, this.up,
            // Facing comes from the BODY, not the node: the node has not been written yet this frame.
            bodyForward(ownBody, this._forwardScratch),
            this._motionConfigFor(ownBody),
          );

          if (ownBody.mass > 0 && worker) {
            // DYNAMIC, WORKER: the node is drawn where its body is at THIS frame's time — the worker's step
            // interpolated (see WorkerExecutor.visualPose) — while the body keeps the latest simulated pose.
            // Written without pushing into the body; the node remembers the gap instead, so a script that
            // then moves or turns it moves the body by the same amount (see Node._showSimulatedPose).
            const q = ownBody.quaternion, simRotation = this._simRotation;
            simRotation[0] = q.x; simRotation[1] = q.y; simRotation[2] = q.z; simRotation[3] = q.w;
            if (worker.visualPose(ownBody.handle, this._visualPose)) {
              this._world.colliderFrameToOrigin(ownBody.handle, this._visualPose, this._visualOrigin);
              node._showSimulatedPose(this._visualOrigin, this._visualRotation, pos, simRotation);
            } else if (!asleep || node._drawnApart) {
              // Its own pose: nothing to interpolate. Once more after it falls asleep, to settle where it is.
              node._showSimulatedPose(pos, simRotation, pos, simRotation);
            }
          } else if (ownBody.mass > 0) {
            // DYNAMIC: physics owns the world pose, and the node's local one is rebased from it under
            // whatever parent it has. A moving parent does not drag the body (as in Unity or Godot).
            // A sleeping body did not move: writing its pose back would only dirty the node's transform (and
            // every descendant's) for nothing. Its motion record still samples, so its speed reads 0.
            node._clearSimulatedPose();
            if (!asleep) {
              node.setWorldPosition(pos);
              const quat = ownBody.quaternion;
              node.setWorldQuaternion([quat.x, quat.y, quat.z, quat.w]);
            }
          } else if (this._followVersion.get(ownBody) !== node.transformVersion) {
            // STATIC: the body follows its node, so colliders in a moved group (or on a moving platform)
            // stay where they are drawn. Only when the node actually moved, which is rare.
            this._followVersion.set(ownBody, node.transformVersion);
            ownBody.setTransform(node.worldPosition, node.worldQuaternion);
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
        // A map only 2D bodies walk on (src/physics2d reads its cells directly) builds no 3D colliders.
        if (!node.tilemap.colliders3D) { node.tilemap.removeColliders(this); continue; }
        node.tilemap.ensureRegistered(this);
        tilemapColliders += node.tilemap.colliderCount;
      }
      physicsStats.tilemapMs = performance.now() - tilemapStart;
      physicsStats.tilemapColliders = tilemapColliders;

      physicsStats.bodies = this._world?.bodyCount ?? 0;
      // Equal to `bodies` in a healthy world. Larger means bodies were removed without the broadphase
      // hearing about it and are still being simulated against — see pal/cannon/worldTeardown.clearWorld.
      physicsStats.broadphaseBodies = this._world?.broadphaseBodyCount?.() ?? physicsStats.bodies;
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
    let origins: readonly ArrayLike<number>[];
    if (this.simulationOrigins) origins = this.simulationOrigins();
    else {
      const cam = this._scene?.activeCamera;
      origins = cam ? [cam.worldPosition] : [];
    }
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
      if (origins.length > 0 && Number.isFinite(range)) {
        const p = body.position;
        let nearest = Infinity;
        for (const o of origins) {
          const dx = p.x - o[0], dy = p.y - o[1], dz = p.z - o[2];
          nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
        }
        outOfRange = shouldFreeze(state?.reason === 'range', nearest, range);
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

      // At rest: a candidate to sleep, once everything it touches can sleep with it (below).
      if (body.canSleep && this._atRest(body, dt)) { this._resting.add(body); continue; }
      active++;
    }

    // A resting body sleeps only together with every dynamic body it touches: each of them asleep already, or
    // resting this frame too. Put to sleep under a crate still settling on it, a body stops answering it on
    // Rapier (a pair already in contact when one side is put to sleep is no longer solved), and the crate sinks
    // into it, then is thrown out when they wake; the backends' own sleep goes by islands for the same reason.
    for (const body of this._resting) {
      if (this._touchesAwake(body)) { active++; continue; }
      this._freeze(body, 'rest');
      resting++;
    }
    this._resting.clear();
    physicsStats.activeBodies = active;
    physicsStats.frozenBodies = frozen;
    physicsStats.restingBodies = resting;
  }

  /** Whether `body` touched, in the last step, a dynamic body that neither sleeps nor rests this frame. */
  private _touchesAwake(body: RigidBody): boolean {
    for (const other of this._touching.get(body) ?? []) {
      if (this._frozen.has(other) || other.isSleeping) continue;
      if (!(other instanceof RigidBody) || !this._resting.has(other)) return true;
    }
    return false;
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

  /**
   * Take a node's body out of the world for now, keeping it built (see ColliderNode.physicsEnabled): no
   * collisions, no gravity, nothing read back to its node, which moves freely meanwhile (carried by a parent,
   * moved by a script or by root motion). Its measured speed reads 0. Whether it stood on the ground is kept, so
   * it neither falls nor lands while out, nor when it comes back.
   */
  public suspendBody(body: PhysicsBody): void {
    if (!this._world || this._suspended.has(body)) return;
    this._suspended.set(body, { grounded: this.isGrounded(body) });
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    this.removeBody(body, true);
    this._motion.set(body, createMotionRecord());
    this._holdRequests.delete(body);
    this._restTime.delete(body);
  }

  /** Put a body {@link suspendBody} took out back in the world, at the node pose given, at rest. */
  public resumeBody(body: PhysicsBody, position: ArrayLike<number>, rotation: ArrayLike<number>): void {
    const was = this._suspended.get(body);
    if (!this._world || !was) return;
    this._suspended.delete(body);
    body.setTransform(position, rotation);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    if (!this._inWorld.has(body)) this._enterWorld(body);
    this._motion.set(body, createMotionRecord());
    if (was.grounded) {
      const stamp = this._ground.get(body);
      if (stamp) stamp.time = this._time;
    }
  }

  /** Whether {@link suspendBody} has `body` out of the world. */
  public isSuspended(body: PhysicsBody): boolean { return this._suspended.has(body); }

  /** A suspended body that stood on the ground still does: its stamp kept fresh (see _holdGround). */
  private _holdSuspendedGround(): void {
    if (this._suspended.size === 0) return;
    for (const [body, state] of this._suspended) {
      if (!state.grounded) continue;
      const stamp = this._ground.get(body);
      if (stamp) stamp.time = this._time;
    }
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
    if (!keep) this._suspended.delete(body);
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
        catch (e) { logScriptError(`Error in a collision listener on ${self.name}`, e, 'Script'); }
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
        catch (e) { logScriptError(`Error in ${hook} for node ${self.name}`, e, 'Script'); }
        routeTrigger(self, phase, other);   // @onEnter / @onExit methods
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
      catch (e) { logScriptError(`Error in a trigger contact listener on ${self.name}`, e, 'Script'); }
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
    const isCharacter = (b: PhysicsBody) => b.isCharacter;
    const nodes: any[] = [], specs: BuoyancyVolume[] = [];
    for (const volume of volumes) {
      if (!volume.enabled) continue;
      nodes.push(volume);
      specs.push(volume.buoyancyVolume(time));
    }
    if (!specs.length) return;
    // Every water a body could be in, together: where two overlap (a river's mouth in its lake) each point of
    // the body is in one of them, never buoyed twice.
    const mine: BuoyancyVolume[] = [], owners: any[] = [];
    for (const body of this.bodies) {
      // applyForce wakes a sleeping body: a frozen floater would be thawed every substep.
      if (asleep(body) || !body.isDynamic) continue;
      mine.length = 0; owners.length = 0;
      for (let i = 0; i < specs.length; i++) {
        if (!floats(body, specs[i], isCharacter)) continue;
        mine.push(specs[i]); owners.push(nodes[i]);
      }
      if (!mine.length) continue;
      applyBuoyancy(this._world, body.id as BodyHandle, body.mass, mine, gravity, dt,
                    (i, fraction) => owners[i].recordSubmerged(body, fraction));
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

  // ---- muscles and puppet strings (pal/drive/driveSolver.ts): what a powered ragdoll moves by ----

  /**
   * Give a joint a muscle (see JointDrive), or take it away (null). `subtree`: the bodies it holds up, which
   * its gravity compensation weighs. Its target starts at the rotation the bodies hold now.
   */
  public setJointDrive(joint: JointHandle, drive: JointDrive | null, subtree?: readonly PhysicsBody[]): void {
    const world = this._world;
    if (!world) return;
    let handles: BodyHandle[] | undefined;
    if (subtree) { handles = []; for (const b of subtree) if (b.world === world) handles.push(b.handle); }
    world.setJointDrive(joint, drive, handles);
  }

  /** Where a driven joint turns body A: A's rotation in B's frame [x y z w], and that target's spin in B's frame. */
  public setJointTarget(joint: JointHandle, rotation: ArrayLike<number>, angularVelocity?: ArrayLike<number> | null): void {
    this._world?.setJointTarget(joint, rotation, angularVelocity);
  }

  /** What a driven joint did in the last substep: [torque N·m, saturation 0..1, angle still to go rad]. */
  public readJointDrive(joint: JointHandle, out: number[]): number[] {
    if (this._world) this._world.readJointDrive(joint, out);
    else { out[0] = out[1] = out[2] = 0; }
    return out;
  }

  /** Pin a body to a pose in the world (see BodyPin), or let it go (null). */
  public setBodyPin(body: PhysicsBody, pin: BodyPin | null): void {
    if (this._world && body.world === this._world) this._world.setBodyPin(body.handle, pin);
  }

  /** A pinned body's target: node-origin pose [px py pz qx qy qz qw], and its velocity [vx vy vz wx wy wz]. */
  public setBodyPinTarget(body: PhysicsBody, pose: ArrayLike<number>, velocity?: ArrayLike<number> | null): void {
    if (this._world && body.world === this._world) this._world.setBodyPinTarget(body.handle, pose, velocity);
  }

  /** Every ragdoll body, by body: which ragdoll and which part. What resolves a ray's hit to a limb. */
  private readonly _ragdollParts = new WeakMap<PhysicsBody, { ragdoll: Ragdoll; part: number }>();

  /** @internal The bodies a profile ragdoll made, in its parts' order (ragdoll.ts). */
  public _registerRagdollParts(ragdoll: Ragdoll, bodies: readonly PhysicsBody[]): void {
    bodies.forEach((body, part) => this._ragdollParts.set(body, { ragdoll, part }));
  }

  /** The ragdoll part a body is, or null for any other body. */
  public ragdollPartOf(body: PhysicsBody | null | undefined): { ragdoll: Ragdoll; part: number } | null {
    if (!body) return null;
    const hit = this._ragdollParts.get(body);
    return hit && !hit.ragdoll.destroyed ? hit : null;
  }

  /** Who touched whom in the last step, for the rest sleep (see _updateActivation): dynamic bodies only. */
  private _recordTouching(contacts: ContactSource): void {
    const touching = this._touching;
    touching.clear();
    if (contacts.contactCount === 0) return;
    const touch = (x: PhysicsBody, y: PhysicsBody) => {
      const list = touching.get(x);
      if (!list) touching.set(x, [y]); else if (!list.includes(y)) list.push(y);
    };
    contacts.forEachContact((a, b) => {
      const bi = this._bodyOf(a), bj = this._bodyOf(b);
      if (bi && bj && bi.isDynamic && bj.isDynamic && !bi.isTrigger && !bj.isTrigger) { touch(bi, bj); touch(bj, bi); }
    });
  }

  /**
   * Put a vehicle on a dynamic body: its wheels carry, drive and steer it from the next step on, on every
   * backend (see physics/vehicle.ts). It follows the body through the world: rebuilt if the body leaves and
   * comes back, idle while it is out. A world clear removes every vehicle.
   */
  public addVehicle(chassis: PhysicsBody, vehicle: Vehicle): Vehicle {
    vehicle._attach(chassis);
    this._vehicles.add(vehicle);
    return vehicle;
  }

  public removeVehicle(vehicle: Vehicle): void {
    if (!this._vehicles.delete(vehicle)) return;
    vehicle._detach();
  }

  /** The vehicles in this world. */
  public get vehicles(): ReadonlySet<Vehicle> { return this._vehicles; }

  private _syncVehicles(): void {
    for (const v of this._vehicles) {
      // Its chassis left the world: the node that put it here adds it again if the body comes back.
      if (!v.chassis || !this._inWorld.has(v.chassis)) { this.removeVehicle(v); continue; }
      try { v._sync(); } catch (e) { logScriptError('Physics', e, 'Runtime'); }
    }
  }

  private _readVehicles(): void {
    for (const v of this._vehicles) v._read();
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
      // Only what it stands on: a step it walks through on its way up a stair ramp is no ground of its own.
      { ignore: body, collidingWith: body });
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
   * Distance from `from` to the nearest surface a camera rig's probe stops at along the SEGMENT `from -> to`,
   * or null when nothing blocks it. The boom length must be baked into `to`, not passed as a max distance.
   * A body blocks when its layer is in `layers.blockedBy` and not in `layers.seeThrough` (see
   * cameraRayFilter.ts); `simulatePhysics = false` ghosts block too: the solver and the camera are independent.
   * @param reject Called with the owning Node of each candidate hit (null for bodies with no owner, e.g.
   *               the terrain heightfield — those should normally be kept). Return true to skip.
   * @param layers A rig's Blocked by and See through. Default: blocked by every layer, seeing through none.
   */
  public raycastCamera(from: vec3, to: vec3, reject?: (owner: Node | null) => boolean, layers: CameraProbeLayers = EVERY_LAYER_BLOCKS): number | null {
    // The standard filters are turned OFF and delegated wholesale to skipCameraHit; applying both would
    // change which bodies block a camera.
    const hit = this.raycast(from, to, {
      checkCollisionResponse: false,
      includeTriggers: true,
      includeGhosts: true,
      reject: (_owner, body) => skipCameraHit(body as CameraProbeBody | null, layers, reject),
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
      // Hints, so the backend skips before testing what `skipRayHit` below would throw away on sight:
      // sensors (hit boxes and trigger zones riding animated bones) and the caster's own body.
      excludeSensors: !opts.includeTriggers,
      ignore: this._rayIgnoreHandles(opts.ignore),
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
    if (nearest) {
      const hit = nearest as PhysicsRaycastHit;
      const part = this.ragdollPartOf(hit.body);
      if (part) { hit.ragdoll = part.ragdoll; hit.part = part.part; }
    }
    return nearest;
  }

  /** `ignore` as backend handles for the ray hint; a list is written into one reused array. */
  private _rayIgnoreHandles(ignore: PhysicsBody | PhysicsBody[] | null | undefined): BodyHandle | readonly BodyHandle[] | undefined {
    if (!ignore) return undefined;
    if (!Array.isArray(ignore)) return typeof ignore.handle === 'number' ? ignore.handle : undefined;
    const list = this._rayIgnoreList;
    list.length = 0;
    for (const body of ignore) if (body && typeof body.handle === 'number') list.push(body.handle);
    return list;
  }
  private readonly _rayIgnoreList: BodyHandle[] = [];

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
    for (const vehicle of this._vehicles) vehicle._detach();
    this._vehicles.clear();

    // The engine bodies keep their last state and forget their handles: a body added again later is made
    // afresh. Then every joint and every body goes (see the cannon backend's clear for the traps that used
    // to strand half of every play session's bodies in its broadphase for the lifetime of the page).
    for (const body of this._bodies.values()) body._release(false);
    this._bodies.clear();
    this._touching.clear();
    this._world.clear();
    this._inWorld.clear();
    this._frozen.clear();
    this._suspended.clear();
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

  /**
   * Done with this system: everything in it goes, its worker stops and its world is freed. A WASM backend's
   * world holds memory of its own (Jolt's whole heap is a fixed 128 MB), so a system replaced by another
   * (CleoEngine.replacePhysics, a test) is disposed rather than dropped. Nothing may use it afterwards.
   */
  public dispose(): void {
    try { this.clear(); } catch (e) { Logger.warn(`Physics: clearing a disposed world failed: ${e}`); }
    this._pendingWorker?.dispose();
    this._pendingWorker = null;
    this._executor?.dispose();
    this._executor = undefined as any;
    const world = this._world;
    this._world = undefined as any;
    if (world) { world.onPreSubstep = null; world.dispose(); }
    this._scene = undefined as any;
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
      // The input this frame's scripts set, diffed out with the step.
      this._syncVehicles();
      this._executor.endFrame(deltaTime, nextTimeScale);
    } catch (e) {
      logScriptError(`Physics`, e, 'Runtime');
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
    // A backend that cannot copy its world into a worker (no mirror and replica, see pal/replication.ts).
    if (!this._world.capabilities.threadable) {
      this._workerFallback = `The ${this._world.backend} physics backend runs on the main thread only.`;
      this._auto.gaveUp = true;
      return false;
    }
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
        world: this._world,
        water: () => this._waterSpecs(),
        // Posted at the end of the frame whose scene asked: this frame's requests.
        slopeHolds: () => this._slopeHoldsOf(this._holdFrame, this._world!).map(r => ({ body: r.handle, cosLimit: r.cosLimit })),
        substepsFor: dt => PhysicsSystem.substepsFor(dt, this.maxSubsteps),
        profileStep: () => this.profileStep,
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
  private _waterSpecs(): { spec: import('./waterSurface').WaterSpec; record: (body: BodyHandle, fraction: number) => void }[] {
    const volumes = (this._scene as any)?.waterVolumes as Set<any> | undefined;
    if (!volumes?.size) return [];
    const out: { spec: import('./waterSurface').WaterSpec; record: (body: BodyHandle, fraction: number) => void }[] = [];
    for (const volume of volumes) {
      if (!volume.enabled || typeof volume.buoyancySpec !== 'function') continue;
      out.push({ spec: volume.buoyancySpec(), record: (body, fraction) => {
        // The worker reports a handle: the engine body behind it is what floats.
        const engineBody = this._bodyOf(body);
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

  /** Let go of the scene: every body goes, and nothing steps until a scene is bound again (a project closing). */
  public releaseScene(): void {
    this.clear();
    this._scene = undefined as any;
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