import { Logger } from "../cleo";
import { Scene } from "../core/scene/scene";
import { World } from 'cannon-es';

interface PhysicsSystemConfig {
  gravity?: number[];
  killZHeight?: number;
}

export class PhysicsSystem {
  private _scene!: Scene;
  private _world!: World;
  private _gravity: number[];
  private _killZHeight: number;

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
      this._world.quatNormalizeFast = true;
      this._world.accumulator = 1 / 60;
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  public update(deltaTime: number): void {
    try {
      if (!this._scene) return;
      this._world?.step(deltaTime);
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
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  public clear(): void {
    if (!this._world) return;
    this._world.bodies.forEach(body => {
      this._world.removeBody(body);
    });
    this._world.bodies = [];
  }

  public set scene(scene: Scene) {
    this.clear();
    this._scene = scene;
  }
}