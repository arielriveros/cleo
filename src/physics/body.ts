import { Body as CannonBody, Vec3, Quaternion} from 'cannon'
import { quat, vec3 } from 'gl-matrix';
import { Shape } from './shape';

interface BodyConfig {
    name?: string;
    mass?: number;
    position?: vec3;
    quaternion?: quat;
    shape?: Shape;
}

export class Body extends CannonBody {
    private _name: string;

    constructor(config?: BodyConfig) {
        super(
            {
                mass: config?.mass || 0,
                position: config?.position ? new Vec3(config.position[0], config.position[1], config.position[2]) : new Vec3(0, 0, 0),
                quaternion: config?.quaternion ? new Quaternion(config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]) : new Quaternion(0, 0, 0, 1),
                shape: config?.shape ? config.shape.cShape : undefined,
                material: undefined
            }
        );
        this._name = config?.name || ''
        this.linearDamping = 0.1;
        this.angularDamping = 0.1;
    }

    public impulse(impulse: vec3): void {
        super.applyImpulse(
            new Vec3(impulse[0], impulse[1], impulse[2]),
            this.position
        )
    }

    public get name(): string { return this._name; }
    public set name(name: string) { this._name = name; }
}