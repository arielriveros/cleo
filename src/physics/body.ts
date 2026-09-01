import { Body as CannonBody, Vec3, Quaternion} from 'cannon-es'
import { quat, vec3 } from 'gl-matrix';
import { Shape } from './shape';
import { bodyCenterOfMass } from './massProperties';
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

interface TriggerConfig {
  position?: vec3;
  quaternion?: quat;
}
export class Trigger extends CBody {
  constructor(config?: TriggerConfig, owner?: Node) {
    super({
      name: owner?.name || 'trigger',
      owner: owner,
      mass: 0,
      position: config?.position ? [config.position[0], config.position[1], config.position[2]] : [0, 0, 0],
      quaternion: config?.quaternion ? [config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]] : [0, 0, 0, 1],
      isTrigger: true
    });
  }
}