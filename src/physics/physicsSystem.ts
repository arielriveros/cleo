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

    public initialize(scene: Scene): void {
        this._scene = scene;
        this._world = new World();
        this._world.gravity.set(this._gravity[0], this._gravity[1], this._gravity[2]);
        this._world.allowSleep = true;
        this._world.quatNormalizeSkip = 0;
        this._world.quatNormalizeFast = true;
    }

    public update(deltaTime: number): void {
        this._world?.step(deltaTime);
        if (!this._scene) return;
        const nodes = this._scene.nodes;
        for (const node of nodes) {
            if (!node.body) continue;
            const body = node.body;

            if (this._world.bodies.indexOf(body) === -1)
                this._world.addBody(body);

            const pos = body.position;
            node.setPosition([pos.x, pos.y, pos.z]);

            const quat = body.quaternion;
            node.setQuaternion([quat.x, quat.y, quat.z, quat.w]);

            if (node.markForRemoval) {
                this._world.removeBody(node.body);
                node.body.removeEventListener('collide', node.body.onCollision);
            }
        }
    }
}