import { Body as CannonBody, Vec3, Quaternion} from 'cannon-es'
import { quat, vec3 } from 'gl-matrix';
import { Shape } from './shape';
import { Node } from '../core/scene/node';


// Internal — the shape RigidBody/Trigger pass down to CBody, not the public config. Unlike
// RigidBodyConfig/TriggerConfig (whose fields are genuinely optional to callers), position and quaternion
// are REQUIRED here: both subclasses already default them via a ternary before calling super(), and the
// CBody constructor dereferences them unconditionally. Declaring them optional only made the checker
// disbelieve code that was always correct.
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
}
class CBody extends CannonBody {
    private readonly _name: string;
    private readonly _owner: Node | null = null;

    constructor(config: BodyConfig) {
      super({
        mass: config?.mass || 0,
        position: new Vec3(config.position[0], config.position[1], config.position[2]),
        quaternion: new Quaternion(config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]),
        // `??`, not `||`: an explicit 0 is a real value here. With `||` a body asking for no damping at all
        // silently got 0.25 and coasted to a stop, and no API could reach zero.
        linearDamping: config.linearDamping ?? 0.25,
        angularDamping: config.angularDamping ?? 0.25,
        linearFactor: config?.linearFactor ? new Vec3(config.linearFactor[0], config.linearFactor[1], config.linearFactor[2]) : new Vec3(1, 1, 1),
        angularFactor: config?.angularFactor ? new Vec3(config.angularFactor[0], config.angularFactor[1], config.angularFactor[2]) : new Vec3(1, 1, 1),
        // Same trap, worse: `false || true` is `true`, so this flag could only ever say yes.
        allowSleep: config.allowSleep ?? true,
        // Left null on purpose. PhysicsSystem assigns the material when the body enters the world, because
        // a ContactMaterial can only be registered against a live World. Note cannon only consults one when
        // BOTH bodies carry a material, so a body that never gets here falls back to the world default.
        material: undefined,
        isTrigger: config.isTrigger || false,
      });
      this.sleepTimeLimit = 0.1;
      this._owner = config.owner || null;
      this._name = config.name || 'body';
    }

    /**
     * `offset` is the shape's position in body space and `orientation` its euler rotation (degrees).
     * cannon places a shape at `body.position + bodyQuaternion * offset`, i.e. the offset does not
     * depend on the shape's own rotation — passing anything but the plain offset here would put the
     * collider somewhere other than where the editor draws it.
     */
    public attachShape(shape: Shape, offset: vec3 = [0, 0, 0], orientation: vec3 = [0, 0, 0]): CBody {
        const q = quat.create();
        quat.fromEuler(q, orientation[0], orientation[1], orientation[2]);
        this.addShape(shape.cShape, new Vec3(offset[0], offset[1], offset[2]), new Quaternion(q[0], q[1], q[2], q[3]));
        return this;
    }

    public setPosition(position: vec3) {
        this.position = new Vec3(position[0], position[1], position[2]);
    }

    public setQuaternion(quaternion: quat) {
        this.quaternion = new Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    }

    public get name(): string { return this._name; }
    public get owner(): Node | null { return this._owner; }
}

/** Grip against other surfaces. 0 = frictionless — what a character wants, since its script owns its speed. */
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
}

export class RigidBody extends CBody {
  /**
   * Surface properties, read by PhysicsSystem when this body enters the world and turned into a cannon
   * Material there (a ContactMaterial needs a live World, so it cannot happen in this constructor).
   * Plain fields rather than accessors: cannon's Body has neither name, only `material`.
   */
  public readonly friction: number;
  public readonly restitution: number;

  constructor(config?: RigidBodyConfig, owner?: Node) {
    super({
      name: owner?.name || 'rigidBody',
      owner: owner,
      mass: config?.mass || 0,
      position: config?.position ? [config.position[0], config.position[1], config.position[2]] : [0, 0, 0],
      quaternion: config?.quaternion ? [config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]] : [0, 0, 0, 1],
      // `??`, not `||` — see CBody: an explicit 0 must survive.
      linearDamping: config?.linearDamping ?? 0.25,
      angularDamping: config?.angularDamping ?? 0.25,
      linearFactor: config?.linearConstraints || [1, 1, 1],
      angularFactor: config?.angularConstraints || [1, 1, 1],
      allowSleep: config?.allowSleep ?? true,
      isTrigger: false
    });
    this.friction = config?.friction ?? DEFAULT_FRICTION;
    this.restitution = config?.restitution ?? DEFAULT_RESTITUTION;
  }

  public reset(): void {
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

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