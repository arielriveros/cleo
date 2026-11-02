import { Body as CannonBody, Vec3, Quaternion, Sphere, Cylinder } from 'cannon-es'
import { quat, vec3 } from 'gl-matrix';
import { Shape } from './shape';
import { bodyCenterOfMass } from './massProperties';
import { parseSimulationMode } from './simulationRange';
import type { SimulationMode } from './simulationRange';
import type { Node } from '../core/scene/nodes/node';


// Internal — what RigidBody/Trigger pass down to CBody, not the public config. `position` and `quaternion`
// are REQUIRED here: both subclasses default them before calling super(), and CBody dereferences them.
interface BodyConfig {
    owner?: Node;
    name?: string;
    mass?: number;
    position: vec3;
    quaternion: quat;
    linearDamping?: number;
    angularDamping?: number;
    linearFactor?: vec3;
    angularFactor?: vec3;
    allowSleep?: boolean;
    isTrigger?: boolean;
    cameraCollision?: boolean;
}
class CBody extends CannonBody {
    private readonly _name: string;
    private readonly _owner: Node | null = null;

    /**
     * Whether a camera rig's collision probe treats this body as solid. Its own channel, independent of
     * whether the body simulates physically, and read in the probe's callback rather than encoded in
     * `collisionFilterGroup` so it cannot perturb body-body filtering.
     */
    public cameraCollision: boolean;

    /**
     * Where this body's centre of mass sits relative to the node that owns it, in body-local space.
     * Non-zero once {@link recenterMass} has run on a body whose colliders are offset.
     *
     * It exists because cannon has no centre of mass of its own: `body.position` IS the centre of mass,
     * and `shapeOffsets` move only the collision geometry. Everything outside this class keeps thinking
     * in NODE space — {@link setPosition} adds this on the way in, {@link originPosition} takes it off
     * on the way out.
     */
    private readonly _com = new Vec3();
    /** The node-space position this body represents, i.e. `position` with `_com` taken back off. */
    private readonly _origin = new Vec3();
    /** Scratch for the rotated centre of mass; never escapes a method. */
    private static readonly _comWorld = new Vec3();

    constructor(config: BodyConfig) {
      super({
        mass: config?.mass || 0,
        position: new Vec3(config.position[0], config.position[1], config.position[2]),
        quaternion: new Quaternion(config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]),
        // `??`, not `||`: an explicit 0 is a real value here.
        linearDamping: config.linearDamping ?? 0.25,
        angularDamping: config.angularDamping ?? 0.25,
        linearFactor: config?.linearFactor ? new Vec3(config.linearFactor[0], config.linearFactor[1], config.linearFactor[2]) : new Vec3(1, 1, 1),
        angularFactor: config?.angularFactor ? new Vec3(config.angularFactor[0], config.angularFactor[1], config.angularFactor[2]) : new Vec3(1, 1, 1),
        // `??`, not `||`: `false || true` is `true`, so this flag could only ever say yes.
        allowSleep: config.allowSleep ?? true,
        // Left null: PhysicsSystem assigns the material when the body enters the world, since a
        // ContactMaterial can only be registered against a live World.
        material: undefined,
        isTrigger: config.isTrigger || false,
      });
      this.sleepTimeLimit = 0.1;
      this._origin.copy(this.position);
      this._owner = config.owner || null;
      this._name = config.name || 'body';
      this.cameraCollision = config.cameraCollision ?? true;
    }

    /**
     * `offset` is the shape's position in body space and `orientation` its euler rotation (DEGREES).
     * cannon places a shape at `body.position + bodyQuaternion * offset`, so the offset must be passed
     * plain — it does not depend on the shape's own rotation.
     */
    public attachShape(shape: Shape, offset: vec3 = [0, 0, 0], orientation: vec3 = [0, 0, 0]): CBody {
        const q = quat.create();
        quat.fromEuler(q, orientation[0], orientation[1], orientation[2]);
        this.addShape(shape.cShape, new Vec3(offset[0], offset[1], offset[2]), new Quaternion(q[0], q[1], q[2], q[3]));
        return this;
    }

    /**
     * Move the body so the NODE that owns it lands on `position`. With an offset centre of mass the
     * body's own `position` ends up elsewhere — see {@link _com}.
     *
     * Mutates cannon's vectors in place rather than replacing them: they are read every step and handed
     * around by reference, and a fresh object per body per frame is pure garbage.
     */
    public setPosition(position: vec3) {
        this._origin.set(position[0], position[1], position[2]);
        this._syncPosition();
    }

    /**
     * Rotate the body about its OWNER'S origin, not about its centre of mass — so a node that rotates
     * stays where it is and its collider swings around it, matching what the editor wireframe draws.
     */
    public setQuaternion(quaternion: quat) {
        // Re-read the origin from where the body actually IS before turning it, so a rotation applied
        // without a preceding setPosition — a script calling node.rotateY, or animator root motion —
        // pivots about the node's current origin rather than a stale one.
        this._captureOrigin();
        this.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
        this._syncPosition();
    }

    /** Where the owning node sits, written into `out`: this body's position with {@link _com} taken off. */
    public originPosition(out: vec3): vec3 {
        const com = CBody._comWorld;
        this.quaternion.vmult(this._com, com);
        out[0] = this.position.x - com.x;
        out[1] = this.position.y - com.y;
        out[2] = this.position.z - com.z;
        return out;
    }

    /** Take the node origin back off the body's current position, under its current orientation. */
    private _captureOrigin(): void {
        const com = CBody._comWorld;
        this.quaternion.vmult(this._com, com);
        this.position.vsub(com, this._origin);
    }

    /** Place `position` (the centre of mass) from the node origin and the current orientation. */
    private _syncPosition(): void {
        const com = CBody._comWorld;
        this.quaternion.vmult(this._com, com);
        this._origin.vadd(com, this.position);
        // cannon only re-measures a body's AABB when IT moved the body (integrate); a static or sleeping
        // body placed from a script would otherwise keep the box it had where it used to be.
        this.aabbNeedsUpdate = true;
    }

    /**
     * Move this body's origin onto the volume-weighted centre of its shapes, and recompute its mass
     * properties in the body frame. Call ONCE, after every shape is attached.
     *
     * WHY: cannon has no centre of mass — `body.position` is it, and `shapeOffsets` move only the
     * collision geometry. A collider authored with an offset (which is what the editor fits by default:
     * the mesh's AABB centre, typically half the model's height) therefore left the mass at the node
     * origin with the geometry hanging off it. Gravity, acting at the origin, applies no torque; the
     * ground's normal force, acting at the collider, does — so the body rotated until the
     * origin->collider vector lined up with the contact normal. Objects "stood up" and tilted to match
     * the terrain they landed on. Re-basing the shapes puts the mass inside the collider, where it belongs.
     *
     * The compensation is invisible from outside: `position` shifts by exactly what the shapes move
     * back, and {@link originPosition} undoes it for the caller.
     */
    public recenterMass(): void {
        // A static body never rotates under the solver and its pose is authored, not simulated. Skipping
        // it keeps this off terrain-like colliders entirely.
        if (this.mass <= 0 || this.shapes.length === 0) return;

        const com = bodyCenterOfMass(this.shapes, this.shapeOffsets, this.shapeOrientations);
        if (com.length() > 1e-6) {
            for (const offset of this.shapeOffsets) offset.vsub(com, offset);
            this._com.copy(com);
            this._syncPosition();
        }

        // cannon derives inertia from the body's WORLD aabb, and `Node.setBody` creates the body already
        // at its authored orientation — so an author-time rotation used to bake a skewed, oversized
        // tensor into the body frame. Measure it with the rotation taken out, then put the rotation back.
        const qx = this.quaternion.x, qy = this.quaternion.y, qz = this.quaternion.z, qw = this.quaternion.w;
        this.quaternion.set(0, 0, 0, 1);
        this.updateMassProperties();
        this.quaternion.set(qx, qy, qz, qw);
        this.updateInertiaWorld(true);

        this.updateBoundingRadius();
        this.aabbNeedsUpdate = true;
    }

    public get name(): string { return this._name; }
    public get owner(): Node | null { return this._owner; }
}

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

export class RigidBody extends CBody {
  /**
   * Surface properties, turned into a cannon Material by PhysicsSystem when this body enters the world
   * (a ContactMaterial needs a live World, so it cannot happen in this constructor).
   */
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
    super({
      name: owner?.name || 'rigidBody',
      owner: owner,
      mass: config?.mass || 0,
      position: config?.position ? [config.position[0], config.position[1], config.position[2]] : [0, 0, 0],
      quaternion: config?.quaternion ? [config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]] : [0, 0, 0, 1],
      // `??`, not `||`: an explicit 0 must survive.
      linearDamping: config?.linearDamping ?? 0.25,
      angularDamping: config?.angularDamping ?? 0.25,
      linearFactor: config?.linearConstraints || [1, 1, 1],
      angularFactor: config?.angularConstraints || [1, 1, 1],
      allowSleep: config?.allowSleep ?? true,
      isTrigger: false,
      cameraCollision: config?.cameraCollision ?? true
    });
    this.friction = config?.friction ?? DEFAULT_FRICTION;
    this.restitution = config?.restitution ?? DEFAULT_RESTITUTION;
    this.groundProbeDistance = config?.groundProbeDistance ?? 0;
    this.motionSmoothing = config?.motionSmoothing ?? 0;
    this.simulatePhysics = config?.simulatePhysics ?? true;
    this.simulationMode = parseSimulationMode(config?.simulationMode);
    this.simulationRange = Math.max(0, config?.simulationRange ?? 0);
    this.canSleep = config?.canSleep ?? false;
  }

  /**
   * Wake a body a script just gave a velocity — unless it is frozen for being out of range, where an AI
   * writing its steering every frame would otherwise thaw it every frame. cannon itself only wakes on a
   * force, an impulse or a hit, never on a velocity written in place.
   */
  public wakeForMotion(): void {
    if (this.sleepState === CannonBody.SLEEPING && !this.rangeFrozen) this.wakeUp();
  }

  /**
   * The physical-simulation channel: false leaves the body in the world and still raycastable but with no
   * collision response — a ghost to the solver, still solid to a camera probe. Backed directly by cannon's
   * `collisionResponse`.
   */
  public get simulatePhysics(): boolean { return this.collisionResponse; }
  public set simulatePhysics(value: boolean) { this.collisionResponse = value; }

  public reset(): void {
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /**
   * Apply an impulse. `relativePoint` is measured from the CENTRE OF MASS, cannon's own convention — not
   * from the node origin, which may differ once colliders are offset (see `CBody.recenterMass`). The
   * default of zero therefore keeps meaning "straight through the centre, no spin".
   */
  public impulse(impulse: vec3, relativePoint: vec3 = vec3.create()): void {
    super.applyImpulse(
      new Vec3(impulse[0], impulse[1], impulse[2]),
      new Vec3(relativePoint[0], relativePoint[1], relativePoint[2])
    )
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
  other: CannonBody;
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

export class Trigger extends CBody {
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

  constructor(config?: TriggerConfig, owner?: Node) {
    super({
      name: owner?.name || 'trigger',
      owner: owner,
      mass: 0,
      position: config?.position ? [config.position[0], config.position[1], config.position[2]] : [0, 0, 0],
      quaternion: config?.quaternion ? [config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]] : [0, 0, 0, 1],
      isTrigger: true
    });
    this._enabled = config?.enabled ?? true;
    this._mask = config?.mask ?? -1;
    this._detectTriggers = !!config?.detectTriggers;
    this._continuous = !!config?.continuous;
    this.collisionFilterGroup = config?.group ?? 1;
    // A disabled trigger's mask is 0 in cannon, which drops every pair in the broadphase and every ray;
    // the logical mask is kept aside for when it comes back on.
    this.collisionFilterMask = this._enabled ? this._mask : 0;
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

  public attachShape(shape: Shape, offset: vec3 = [0, 0, 0], orientation: vec3 = [0, 0, 0]): Trigger {
    super.attachShape(shape, offset, orientation);
    this._shapesChanged();
    return this;
  }

  /**
   * Replace every shape with one capsule running from `a` to `b` (body-local, i.e. in the owning node's
   * space) with the given radius: what a blade or a limb is. Built as the engine's capsule always is — a
   * cylinder plus two end spheres — and collapsing to a single sphere when the two ends coincide.
   */
  public setCapsule(a: vec3, b: vec3, radius: number, segments = 8): Trigger {
    this._removeAllShapes();
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6) {
      this.addShape(new Sphere(radius), new Vec3(a[0], a[1], a[2]));
    } else {
      // cannon's Cylinder runs along its local Y.
      const q = quat.rotationTo(quat.create(), [0, 1, 0], [dx / length, dy / length, dz / length]);
      this.addShape(new Cylinder(radius, radius, length, segments),
        new Vec3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), new Quaternion(q[0], q[1], q[2], q[3]));
      this.addShape(new Sphere(radius), new Vec3(a[0], a[1], a[2]));
      this.addShape(new Sphere(radius), new Vec3(b[0], b[1], b[2]));
    }
    this._shapesChanged();
    return this;
  }

  /** Remove every shape. The trigger stays on its node, detecting nothing until shapes are attached again. */
  public clearShapes(): Trigger {
    this._removeAllShapes();
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
    const handler = (event: any) => listener(event.contact as TriggerContact);
    this.addEventListener('triggerContact', handler);
    return () => { this.removeEventListener('triggerContact', handler); };
  }

  private _removeAllShapes(): void {
    for (let i = this.shapes.length - 1; i >= 0; i--) this.removeShape(this.shapes[i]);
  }

  private _shapesChanged(): void {
    this.shapeVersion++;
    this.updateBoundingRadius();
    this.aabbNeedsUpdate = true;
    triggerState.version++;
  }
}