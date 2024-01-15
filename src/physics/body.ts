import { Body as CannonBody, Vec3, Quaternion} from 'cannon-es'
import { quat, vec3 } from 'gl-matrix';
import { Shape } from './shape';
import { ModelNode, Node } from '../core/scene/node';

interface BodyConfig {
    mass?: number;
    position?: vec3;
    quaternion?: quat;
    linearDamping?: number;
    angularDamping?: number;
    allowSleep?: boolean;
}

export class Body extends CannonBody {
    private readonly _name: string;
    private readonly _owner: Node | null = null;

    public onCollision: (other: Node) => void = () => {};

    constructor(config?: BodyConfig, owner?: Node) {
        super(
            {
                mass: config?.mass || 0,
                position: config?.position ? new Vec3(config.position[0], config.position[1], config.position[2]) : new Vec3(0, 0, 0),
                quaternion: config?.quaternion ? new Quaternion(config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]) : new Quaternion(0, 0, 0, 1),
                linearDamping: config?.linearDamping || 0.25,
                angularDamping: config?.angularDamping || 0.25,
                material: undefined,
                allowSleep: config?.allowSleep || true
            }
        );
        this._owner = owner || null;
        this._name = this._owner ? this._owner.name : 'body';
        this.sleepTimeLimit = 0.1;
        this.addEventListener('collide', (event: any) => {
            if (event.body instanceof Body)
                this.onCollision(event.body.owner);
        });
    }

    public impulse(impulse: vec3, relativePoint: vec3 = vec3.create()): void {
        super.applyImpulse(
            new Vec3(impulse[0], impulse[1], impulse[2]),
            new Vec3(relativePoint[0], relativePoint[1], relativePoint[2])
        )
    }

    public attachShape(shape: Shape, offset: vec3 = [0, 0, 0], orientation: vec3 = [0, 0, 0]): Body {
        let q = quat.create();
        quat.fromEuler(q, orientation[0], orientation[1], orientation[2]);
        let q2 = quat.create();
        quat.invert(q2, q);
        let v = vec3.create();
        vec3.transformQuat(v, offset, q2);
        offset = v;
        this.addShape(shape.cShape, new Vec3(offset[0], offset[1], offset[2]), new Quaternion(q[0], q[1], q[2], q[3]));
        if (shape.debugModel) {
            shape.debugModel.material.properties.set('color', [1, 0, 0]);
            const model = new ModelNode(`debug_shape ${Math.random()}`, shape.debugModel);
            model.onUpdate = (node: Node) => {
                // The debug model must compensate for any scaling applied to the owner
                // This is because a rigid body should never change scale
                let inverseScale: vec3 = vec3.divide(vec3.create(), vec3.fromValues(1, 1, 1), this.owner?.scale || vec3.fromValues(1, 1, 1));
                node.setPosition(vec3.multiply(vec3.create(), offset, inverseScale));
                node.setQuaternion(q);
                node.setScale(inverseScale);
            }
            this.owner?.addChild(model);
        }
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