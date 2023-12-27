import { Scene } from "../core/scene/scene";
import { World, Vec3, Quaternion, Plane } from 'cannon';
import { Body } from "./body";
import { Shape } from "./shape";

interface PhysicsSystemConfig {
    gravity?: number[];
    killZHeight?: number;
}

export class PhysicsSystem {
    private _scene!: Scene;
    private _world!: World;
    private _bodies!: Body[];
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

        this._bodies = [];

        // Kill z plane
        const quat = new Quaternion();
        quat.setFromAxisAngle(new Vec3(1, 0, 0), -Math.PI / 2);
        const killZPlane = new Body({
            mass: 0,
            position: [0, this._killZHeight, 0],
            quaternion: [quat.x, quat.y, quat.z, quat.w],
            shape: Shape.Plane()
        });
        this._world.addBody(killZPlane);

        killZPlane.addEventListener('collide', (e: any) => {
            const body = e.body;
            if (!body) return;
            const name = body.name;
            if (!name) return;
            this._scene.removeNodeByName(name);
            // TODO: Remove from physics system, this does not work
            //this._world.remove(body);
        });
    }

    public update(deltaTime: number): void {
        this._world?.step(1 / 60, deltaTime, 3);

        if (!this._scene) return;
        const nodes = this._scene.nodes;
        for (const node of nodes) {
            if (!node.body) continue;
            const body = node.body;

            if (this._world.bodies.indexOf(body) === -1)
                this._world.addBody(body);

            const pos = body.position;
            node.setPosition([pos.x, pos.y, pos.z]);
        }
    }
}