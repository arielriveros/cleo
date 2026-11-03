import { quat, vec3 } from 'gl-matrix';
import { PhysicsBody } from './physicsBody';
import type { Shape } from './shape';
import type { ColliderDesc } from './pal/types';
import { parseSimulationMode } from './simulationRange';
import type { SimulationMode } from './simulationRange';
import type { Node } from '../core/scene/nodes/node';

// A node's physics: RigidBody (Node.setBody) and Trigger (Node.setTrigger). Both are engine bodies
// (physicsBody.ts), so they live on whatever physics backend the world runs (see pal/).

/** Grip against other surfaces. 0 = frictionless. */
export const DEFAULT_FRICTION = 0.3;
/** Bounciness. 0 = dead stop, 1 = rebounds at the speed it landed. */
export const DEFAULT_RESTITUTION = 0;

interface RigidBodyConfig {
    mass?: number;
    position?: vec3;
    quaternion?: quat;
    linearDamping?: number;
    angularDamping?: number;
    linearConstraints?: vec3;
    angularConstraints?: vec3;
    allowSleep?: boolean;
    friction?: number;
    restitution?: number;
    /** Participate in physical simulation (collide, push, be pushed). Default true. */
    simulatePhysics?: boolean;
    /** Block a camera rig's collision probe. Default true. */
    cameraCollision?: boolean;
    /**
     * Meters below the collider's feet that still count as grounded. `0` = off, grounding uses solver
     * contacts only. A small value (~0.1-0.2) removes `isGrounded` flicker for characters on terrain,
     * since cannon drops a perfectly resting contact for the odd frame but a raycast never vanishes.
     */
    groundProbeDistance?: number;
    /**
     * Time constant, in SECONDS, for this body's measured motion (`Node.currentSpeed` and everything derived
     * from it). `0` = the engine default (~90ms). Raise it where measured speed is noisy enough to vibrate
     * an animation blend, lower it where the body must react instantly. Frame-rate independent either way.
     */
    motionSmoothing?: number;
    /**
     * Where this body's simulation range comes from: the project's (`'project'`, the default), nowhere
     * (`'always'`: never frozen), or {@link simulationRange} (`'custom'`). See physics/simulationRange.ts.
     */
    simulationMode?: SimulationMode;
    /** Metres from the camera past which a `'custom'` body freezes. `0` = unlimited. */
    simulationRange?: number;
    /**
     * Put the body to sleep once it has come to rest, until something hits, pushes or moves it. Off by
     * default — a script that writes `body.velocity` directly will not wake it (Node.velocity does).
     */
    canSleep?: boolean;
}

export class RigidBody extends PhysicsBody {
  /** Surface properties: grip and bounce. Paired with the other side's when they touch (min / max). */
  public readonly friction: number;
  public readonly restitution: number;
  /** See {@link RigidBodyConfig.groundProbeDistance}. Read by PhysicsSystem's per-frame ground probe. */
  public readonly groundProbeDistance: number;
  /** See {@link RigidBodyConfig.motionSmoothing}. Read by PhysicsSystem when it samples measured motion. */
  public readonly motionSmoothing: number;
  /** See {@link RigidBodyConfig.simulationMode}. */
  public simulationMode: SimulationMode;
  /** See {@link RigidBodyConfig.simulationRange}. */
  public simulationRange: number;
  /** See {@link RigidBodyConfig.canSleep}. */
  public canSleep: boolean;
  /**
   * True while PhysicsSystem holds this body frozen for being out of range. Script-driven velocity does not
   * wake such a body (that would undo the freeze every frame an AI steers); a hit or an impulse does.
   */
  public rangeFrozen: boolean = false;

  constructor(config?: RigidBodyConfig, owner?: Node) {
    const friction = config?.friction ?? DEFAULT_FRICTION, restitution = config?.restitution ?? DEFAULT_RESTITUTION;
    super({
      name: owner?.name || 'rigidBody',
      owner: owner ?? null,
      mass: config?.mass || 0,
      position: config?.position ?? [0, 0, 0],
      quaternion: config?.quaternion ?? [0, 0, 0, 1],
      // `??`, not `||`: an explicit 0 must survive.
      linearDamping: config?.linearDamping ?? 0.25,
      angularDamping: config?.angularDamping ?? 0.25,
      linearFactor: config?.linearConstraints || [1, 1, 1],
      angularFactor: config?.angularConstraints || [1, 1, 1],
      allowSleep: config?.allowSleep ?? true,
      sleepTimeLimit: 0.1,
      friction, restitution,
      collisionResponse: config?.simulatePhysics ?? true,
      cameraCollision: config?.cameraCollision ?? true,
      character: owner?.nodeType === 'character',
    });
    this.friction = friction;
    this.restitution = restitution;
    this.groundProbeDistance = config?.groundProbeDistance ?? 0;
    this.motionSmoothing = config?.motionSmoothing ?? 0;
    this.simulationMode = parseSimulationMode(config?.simulationMode);
    this.simulationRange = Math.max(0, config?.simulationRange ?? 0);
    this.canSleep = config?.canSleep ?? false;
  }

  /**
   * Wake a body a script just gave a velocity — unless it is frozen for being out of range, where an AI
   * writing its steering every frame would otherwise thaw it every frame. A velocity written in place never
   * wakes a body by itself; a force, an impulse or a hit does.
   */
  public wakeForMotion(): void {
    if (this.isSleeping && !this.rangeFrozen) this.wakeUp();
  }

  /**
   * The physical-simulation channel: false leaves the body in the world and still raycastable but with no
   * collision response — a ghost to the solver, still solid to a camera probe.
   */
  public get simulatePhysics(): boolean { return this.collisionResponse; }
  public set simulatePhysics(value: boolean) { this.collisionResponse = value; }

  /** Stop it dead: no velocity, no spin, no force waiting for the next step. */
  public reset(): void {
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.clearForces();
  }

  /**
   * Apply an impulse. `relativePoint` is measured from the CENTRE OF MASS, not from the node origin, which
   * may differ once colliders are offset (see {@link recenterMass}). The default of zero therefore keeps
   * meaning "straight through the centre, no spin".
   */
  public impulse(impulse: vec3 | number[], relativePoint: vec3 | number[] = [0, 0, 0]): void {
    this.applyImpulse(impulse, relativePoint);
  }

  /**
   * Put the mass at the colliders' volume-weighted centre rather than at the node origin. Call once, after
   * every shape is attached: an offset collider (what the editor fits by default — the mesh's bounds centre,
   * typically half the model's height) would otherwise leave the mass at the node origin with the geometry
   * hanging off it. Gravity, acting at the origin, applies no torque; the ground, pushing on the collider,
   * does — so the body rotated until it lined up with whatever it stood on. Invisible from outside: the
   * body still sits, turns and reports its position at the node origin.
   */
  public recenterMass(): void {
    if (this.mass <= 0) return;
    this._setCenterOfMass('colliders');
  }
}

/**
 * How a trigger volume behaves. Each option is also a live property on {@link Trigger}, so a script can
 * change it while the game runs.
 */
export interface TriggerOptions {
  /**
   * Whether the volume detects anything. A disabled trigger stays attached to its node, shapes and all,
   * but physics, overlap queries and the editor's trigger overlay all ignore it, and any overlap it was in
   * ends (an exit is reported). Turning it back on costs nothing: no allocation, no world churn. Default true.
   */
  enabled?: boolean;
  /** The collision layers this volume is in, as a bit mask. Default 1. */
  group?: number;
  /**
   * The layers it detects, as a bit mask. Default -1 (all). A pair only overlaps when each side's mask has
   * the other's group — the same rule cannon applies to bodies.
   */
  mask?: number;
  /**
   * Also detect other trigger volumes (cannon only pairs a trigger with moving bodies). Only one side of a
   * pair has to ask. Default false.
   */
  detectTriggers?: boolean;
  /**
   * Test the volume SWEPT from where it was last frame to where it is now, against other trigger volumes,
   * so a fast mover (a blade) cannot skip past a thin one between two frames. Default false.
   */
  continuous?: boolean;
}

interface TriggerConfig extends TriggerOptions {
  position?: vec3;
  quaternion?: quat;
}

/**
 * Bumped whenever a trigger's membership in the trigger↔trigger pass, or its shapes, change. PhysicsSystem
 * and the editor's trigger overlay rebuild what they cache from it, and only then.
 */
export const triggerState = { version: 0 };

/** One trigger overlap starting or ending, as {@link Trigger.onContact} reports it. */
export interface TriggerContact {
  phase: 'enter' | 'exit';
  /** The trigger the listener is on. */
  self: Trigger;
  /** The body or trigger on the other side. */
  other: PhysicsBody;
  /** The Node owning {@link other}, or null for an ownerless body (a ragdoll bone, a foliage collider). */
  node: Node | null;
  /**
   * World-space point on the other volume nearest this one, for a trigger↔trigger overlap entered this
   * frame. Null for an exit, and for an overlap cannon reported (trigger↔body).
   */
  point: [number, number, number] | null;
  /**
   * For a continuous trigger: how far along this frame's sweep the overlap began, 0 (last frame's pose)
   * to 1 (this frame's). 1 otherwise.
   */
  fraction: number;
}

export class Trigger extends PhysicsBody {
  private _enabled: boolean;
  private _mask: number;
  private _detectTriggers: boolean;
  private _continuous: boolean;
  /**
   * Counts how many times this trigger was switched back on. PhysicsSystem compares it with what it saw
   * when it reported an overlap, so a trigger switched off and on again in one frame (a combo's `hitEnd`
   * and next `hit` landing together) still reports a fresh enter.
   */
  public rearmEpoch = 0;
  /** Bumped whenever the shapes change, so whatever caches them (the overlap pass, the overlay) rebuilds. */
  public shapeVersion = 0;
  private _contactListeners: ((contact: TriggerContact) => void)[] | null = null;

  constructor(config?: TriggerConfig, owner?: Node) {
    const enabled = config?.enabled ?? true, mask = config?.mask ?? -1;
    super({
      name: owner?.name || 'trigger',
      owner: owner ?? null,
      mass: 0,
      position: config?.position ?? [0, 0, 0],
      quaternion: config?.quaternion ?? [0, 0, 0, 1],
      linearDamping: 0.25,
      angularDamping: 0.25,
      allowSleep: true,
      sleepTimeLimit: 0.1,
      sensor: true,
      group: config?.group ?? 1,
      // A disabled trigger's mask is 0, which drops every pair in the broadphase and every ray; the logical
      // mask is kept aside for when it comes back on.
      mask: enabled ? mask : 0,
      character: owner?.nodeType === 'character',
    });
    this._enabled = enabled;
    this._mask = mask;
    this._detectTriggers = !!config?.detectTriggers;
    this._continuous = !!config?.continuous;
  }

  /** See {@link TriggerOptions.enabled}. */
  public get enabled(): boolean { return this._enabled; }
  public set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    this.collisionFilterMask = value ? this._mask : 0;
    if (value) this.rearmEpoch++;
    triggerState.version++;
  }

  /** See {@link TriggerOptions.group}. */
  public get group(): number { return this.collisionFilterGroup; }
  public set group(value: number) { this.collisionFilterGroup = value; }

  /** See {@link TriggerOptions.mask}. */
  public get mask(): number { return this._mask; }
  public set mask(value: number) {
    this._mask = value;
    if (this._enabled) this.collisionFilterMask = value;
  }

  /** See {@link TriggerOptions.detectTriggers}. */
  public get detectTriggers(): boolean { return this._detectTriggers; }
  public set detectTriggers(value: boolean) {
    if (value === this._detectTriggers) return;
    this._detectTriggers = value;
    triggerState.version++;
  }

  /** See {@link TriggerOptions.continuous}. */
  public get continuous(): boolean { return this._continuous; }
  public set continuous(value: boolean) {
    if (value === this._continuous) return;
    this._continuous = value;
    triggerState.version++;
  }

  public attachShape(shape: Shape, offset: vec3 | number[] = [0, 0, 0], orientation: vec3 | number[] = [0, 0, 0]): this {
    super.attachShape(shape, offset, orientation);
    this._shapesChanged();
    return this;
  }

  /**
   * Replace every shape with one capsule running from `a` to `b` (body-local, i.e. in the owning node's
   * space) with the given radius: what a blade or a limb is. Collapses to a single sphere when the two
   * ends coincide.
   */
  public setCapsule(a: vec3 | number[], b: vec3 | number[], radius: number, segments = 8): this {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const length = Math.hypot(dx, dy, dz);
    const colliders: ColliderDesc[] = [];
    if (length < 1e-6) {
      colliders.push({ shape: { kind: 'sphere', radius }, offset: [a[0], a[1], a[2]] });
    } else {
      // A capsule runs along its local Y.
      const q = quat.rotationTo(quat.create(), [0, 1, 0], [dx / length, dy / length, dz / length]);
      colliders.push({
        shape: { kind: 'capsule', radius, height: length, segments },
        offset: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], rotation: [q[0], q[1], q[2], q[3]],
      });
    }
    this._setColliders(colliders);
    this._shapesChanged();
    return this;
  }

  /** Remove every shape. The trigger stays on its node, detecting nothing until shapes are attached again. */
  public clearShapes(): this {
    this._setColliders([]);
    this._shapesChanged();
    return this;
  }

  /**
   * Listen for this trigger's overlaps starting and ending. Unlike the owning node's
   * `onTriggerEnter`/`onTriggerExit` hooks, the payload carries where the overlap happened and, for a
   * {@link continuous} trigger, how far through the frame's sweep. Returns the unsubscribe; keep it and
   * call it when the listener's owner goes away.
   */
  public onContact(listener: (contact: TriggerContact) => void): () => void {
    (this._contactListeners ??= []).push(listener);
    return () => {
      const list = this._contactListeners;
      const i = list ? list.indexOf(listener) : -1;
      if (i >= 0) list!.splice(i, 1);
    };
  }

  /** @internal Whether anything listens through {@link onContact}. */
  public get _hasContactListeners(): boolean { return !!this._contactListeners?.length; }

  /** @internal PhysicsSystem: an overlap started or ended. */
  public _emitContact(contact: TriggerContact): void {
    const list = this._contactListeners;
    if (list) for (const listener of [...list]) listener(contact);
  }

  private _shapesChanged(): void {
    this.shapeVersion++;
    triggerState.version++;
  }
}
