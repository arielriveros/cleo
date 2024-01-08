import { Body as CannonBody, Vec3, Quaternion} from 'cannon-es'
import { quat, vec3 } from 'gl-matrix';
import { Shape } from './shape';

interface BodyConfig {
    name?: string;
    mass?: number;
    position?: vec3;
    quaternion?: quat;
    linearDamping?: number;
    angularDamping?: number;
}

export class Body extends CannonBody {
    private _name: string;

    constructor(config?: BodyConfig) {
        super(
            {
                mass: config?.mass || 0,
                position: config?.position ? new Vec3(config.position[0], config.position[1], config.position[2]) : new Vec3(0, 0, 0),
                quaternion: config?.quaternion ? new Quaternion(config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]) : new Quaternion(0, 0, 0, 1),
                linearDamping: config?.linearDamping || 0.25,
                angularDamping: config?.angularDamping || 0.25,
                material: undefined,
            }
        );
        this._name = config?.name || ''
        this.sleepTimeLimit = 0.25;
    }

    public impulse(impulse: vec3): void {
        /* super.applyImpulse(
            new Vec3(impulse[0], impulse[1], impulse[2]),
            this.position
        ) */
        super.applyImpulse(
            new Vec3(impulse[0], impulse[1], impulse[2]),
            new Vec3(0, 0, 0)
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
        return this;
    }

    public get name(): string { return this._name; }
    public set name(name: string) { this._name = name; }
}