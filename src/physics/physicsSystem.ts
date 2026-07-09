import { Logger } from "../cleo";
import { Scene } from "../core/scene/scene";
import { ModelNode } from "../core/scene/node";
import { World, Body, Constraint } from 'cannon-es';
import { Ragdoll, RagdollOptions } from "./ragdoll";

interface PhysicsSystemConfig {
  gravity?: number[];
  killZHeight?: number;
}

export class PhysicsSystem {
  private _scene!: Scene;
  private _world!: World;
  private _gravity: number[];
  private _killZHeight: number;
  private _ragdolls: Ragdoll[] = [];

  constructor(config?: PhysicsSystemConfig) {
    this._gravity = config?.gravity ? config.gravity: [0, -9.82, 0]; // y = up 
    this._killZHeight = config?.killZHeight || -100;
  }

  public initialize(): void {
    try {
      this._world = new World();
      this._world.gravity.set(this._gravity[0], this._gravity[1], this._gravity[2]);
      this._world.allowSleep = false;
      this._world.quatNormalizeSkip = 0;
      // Accurate quaternion normalization. The fast approximation destabilizes orientation-sensitive
      // constraints (cone-twist ragdoll joints blow up to NaN and the mesh flies off-screen).
      this._world.quatNormalizeFast = false;
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  public update(deltaTime: number): void {
    try {
      if (!this._scene) return;
      // Fixed internal timestep with catch-up substeps: keeps stiff constraints (e.g. ragdoll
      // cone-twist joints) stable and deterministic even when frame delta spikes.
      this._world?.step(1 / 60, deltaTime, 5);
      const nodes = this._scene.nodes;
      for (const node of nodes) {
        if (!(node.body || node.trigger) || !node.hasStarted) continue;
        const bodyToAdd = node.body || node.trigger;

        // If body is not in the world, add it
        if (this._world.bodies.indexOf(bodyToAdd) === -1)
          this._world.addBody(bodyToAdd);

        // If node is marked for removal, remove it from the world
        if (node.markForRemoval) {
          this._world.removeBody(bodyToAdd);
          bodyToAdd.removeEventListener('collide', node.onCollision);
        }

        // If node contains a body, update the position and quaternion of itself
        if (node.body) {
          const pos = node.body.position;
          node.setPosition([pos.x, pos.y, pos.z]);

          const quat = node.body.quaternion;
          node.setQuaternion([quat.x, quat.y, quat.z, quat.w]);
        }

        if (node.trigger) {
          // update the position and quaternion of the trigger
          const pos = node.worldPosition;
          node.trigger.position.set(pos[0], pos[1], pos[2]);

          const quat = node.worldQuaternion;
          node.trigger.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
        }
      }

      // Terrain: register/refresh the static heightfield collider(s) so any mesh walks over the landscape.
      for (const landscape of this._scene.landscapes) {
        if (landscape.markForRemoval) { landscape.terrain.dispose(this._world); continue; }
        landscape.terrain.setOrigin(landscape.worldPosition);
        landscape.terrain.ensureRegistered(this._world);
      }
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  // ---- Low-level world access (for bodies/constraints not owned by a scene node, e.g. ragdolls) ----

  /** Add a standalone body to the world (deduplicated). */
  public addBody(body: Body): void {
    if (!this._world) return;
    if (this._world.bodies.indexOf(body) === -1)
      this._world.addBody(body);
  }

  /** Remove a standalone body from the world if present. */
  public removeBody(body: Body): void {
    if (!this._world) return;
    if (this._world.bodies.indexOf(body) !== -1)
      this._world.removeBody(body);
  }

  public addConstraint(constraint: Constraint): void {
    this._world?.addConstraint(constraint);
  }

  public removeConstraint(constraint: Constraint): void {
    this._world?.removeConstraint(constraint);
  }

  /**
   * Turn a skinned ModelNode into a ragdoll: spawn a rigid body per bone, link them
   * with ball joints, and drive the skeleton from physics. Returns the Ragdoll handle.
   */
  public startRagdoll(modelNode: ModelNode, options?: RagdollOptions): Ragdoll {
    const ragdoll = new Ragdoll(modelNode, this, options);
    this._ragdolls.push(ragdoll);
    return ragdoll;
  }

  public clear(): void {
    if (!this._world) return;

    // Tear down active ragdolls first (removes their bodies + constraints, resets animators)
    for (const ragdoll of this._ragdolls) ragdoll.destroy();
    this._ragdolls = [];

    // Remove any remaining constraints before clearing bodies
    for (const constraint of [...this._world.constraints])
      this._world.removeConstraint(constraint);

    this._world.bodies.forEach(body => {
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.force.set(0, 0, 0);
      body.torque.set(0, 0, 0);
      this._world.removeBody(body);
    });
    this._world.bodies = [];
    this._world.clearForces();
  }

  public set scene(scene: Scene) {
    this.clear();
    this._scene = scene;
    scene.physics = this;
  }
}