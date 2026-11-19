import { Body, RaycastResult, RaycastVehicle, Vec3, WheelInfo } from 'cannon-es';
import type { Out } from '../types';
import type { NormalizedVehicle, VehicleInput } from '../vehicle/vehicleDesc';
import { dominantAxis, wheelRight } from '../vehicle/vehicleDesc';
import { BULLET_ROLL_INFLUENCE, RaycastDrive, type ChassisMotion, type RaycastWheelReading } from '../vehicle/raycastDrive';
import { CannonBody } from './cannonBody';

/** The closest ground below a wheel: what the world casts for it (its own filtered ray, see CannonWorld). */
export type WheelRay = (from: Vec3, to: Vec3, chassis: Body, out: RaycastResult) => void;

const _rayVector = new Vec3();
const _target = new Vec3();
const _velocity = new Vec3();

/**
 * cannon's RaycastVehicle with its ray cast through the backend's own filtered query (the world's
 * broadphase is the engine's, and its rays skip sensors and bodies the chassis does not collide with)
 * instead of `world.rayTest`. Otherwise cannon's own: the same suspension, friction and clamps.
 */
class EngineRaycastVehicle extends RaycastVehicle {
    constructor(chassisBody: Body, axes: { right: number; forward: number; up: number }, private readonly _ray: WheelRay) {
        super({ chassisBody, indexRightAxis: axes.right, indexForwardAxis: axes.forward, indexUpAxis: axes.up });
    }

    public override castRay(wheel: WheelInfo): number {
        this.updateWheelTransformWorld(wheel);
        const chassis = this.chassisBody;
        let depth = -1;
        const rayLength = wheel.suspensionRestLength + wheel.radius;
        wheel.directionWorld.scale(rayLength, _rayVector);
        const source = wheel.chassisConnectionPointWorld;
        source.vadd(_rayVector, _target);
        const result = wheel.raycastResult;
        result.reset();
        this._ray(source, _target, chassis, result);
        result.groundObject = 0;
        if (result.body) {
            depth = result.distance;
            wheel.isInContact = true;
            wheel.suspensionLength = result.distance - wheel.radius;
            const min = wheel.suspensionRestLength - wheel.maxSuspensionTravel;
            const max = wheel.suspensionRestLength + wheel.maxSuspensionTravel;
            if (wheel.suspensionLength < min) wheel.suspensionLength = min;
            if (wheel.suspensionLength > max) { wheel.suspensionLength = max; result.reset(); }
            const denominator = result.hitNormalWorld.dot(wheel.directionWorld);
            chassis.getVelocityAtWorldPoint(result.hitPointWorld, _velocity);
            const projected = result.hitNormalWorld.dot(_velocity);
            if (denominator >= -0.1) {
                wheel.suspensionRelativeVelocity = 0;
                wheel.clippedInvContactDotSuspension = 1 / 0.1;
            } else {
                const inv = -1 / denominator;
                wheel.suspensionRelativeVelocity = projected * inv;
                wheel.clippedInvContactDotSuspension = inv;
            }
        } else {
            wheel.suspensionLength = wheel.suspensionRestLength;
            wheel.suspensionRelativeVelocity = 0;
            wheel.directionWorld.scale(-1, result.hitNormalWorld);
            wheel.clippedInvContactDotSuspension = 1;
        }
        return depth;
    }
}

/**
 * A vehicle on cannon: its RaycastVehicle (Bullet's, ported) finds the ground, springs the suspension and
 * solves the tyres; the shared RaycastDrive supplies the engine, gearbox, brakes and anti-roll bars it lacks.
 * Stepped from the world's preStep, after gravity and before integration, as cannon's own addToWorld would.
 */
export class CannonVehicle {
    public readonly drive: RaycastDrive;
    private readonly _raycast: EngineRaycastVehicle;
    private readonly _readings: RaycastWheelReading[];
    /** cannon's friction reads its axle as +X, +Y or +Z of the chassis: −1 when the wheels' right is the negative one. */
    private readonly _axleSign: number;
    private readonly _motion: ChassisMotion = { com: [0, 0, 0], rotation: [0, 0, 0, 1], linear: [0, 0, 0], angular: [0, 0, 0] };
    private static readonly _impulse = new Vec3();
    private static readonly _rel = new Vec3();
    private static readonly _up = new Vec3();
    private static readonly _lean = [0, 0, 0];

    constructor(public readonly chassis: Body, public readonly vehicle: NormalizedVehicle, ray: WheelRay) {
        const com = chassis instanceof CannonBody ? chassis.centerOfMassOffset : new Vec3();
        const inertia = chassis.inertia;
        this.drive = new RaycastDrive(vehicle, chassis.mass, [inertia.x, inertia.y, inertia.z], [com.x, com.y, com.z]);
        const right = wheelRight(vehicle), rightAxis = dominantAxis(right);
        this._axleSign = right[rightAxis] < 0 ? -1 : 1;
        this._raycast = new EngineRaycastVehicle(chassis, { right: rightAxis, forward: dominantAxis(vehicle.forward), up: dominantAxis(vehicle.up) }, ray);
        const axle = new Vec3(rightAxis === 0 ? 1 : 0, rightAxis === 1 ? 1 : 0, rightAxis === 2 ? 1 : 0);
        vehicle.wheels.forEach((w, i) => {
            const t = this.drive.tuning[i], p = w.position, d = w.suspensionDirection;
            this._raycast.addWheel({
                radius: w.radius,
                // cannon measures from the centre of mass, the layer from the node origin.
                chassisConnectionPointLocal: new Vec3(p[0] - com.x, p[1] - com.y, p[2] - com.z),
                directionLocal: new Vec3(d[0], d[1], d[2]),
                axleLocal: axle.clone(),
                suspensionRestLength: t.restLength,
                maxSuspensionTravel: t.maxTravel,
                suspensionStiffness: t.stiffness,
                dampingCompression: t.compression,
                dampingRelaxation: t.relaxation,
                maxSuspensionForce: t.maxSuspensionForce,
                frictionSlip: t.frictionSlip,
                rollInfluence: BULLET_ROLL_INFLUENCE,
            });
        });
        this._readings = vehicle.wheels.map(w => ({ contact: false, length: w.suspensionMaxLength, suspensionForce: 0, point: [0, 0, 0], normal: [0, 0, 0], sideImpulse: 0 }));
    }

    public setInput(input: VehicleInput): void { Object.assign(this.drive.input, input); }

    public update(dt: number): void {
        if (!(dt > 0)) return;
        const drive = this.drive, rv = this._raycast, n = this._readings.length;
        drive.prepare(dt, this._readings);
        for (let i = 0; i < n; i++) {
            rv.setSteeringValue(drive.steering[i], i);
            rv.applyEngineForce(drive.engineForce[i] * this._axleSign, i);
            rv.setBrake(drive.brakeImpulse[i], i);
        }
        rv.updateVehicle(dt);
        for (let i = 0; i < n; i++) {
            const w = rv.wheelInfos[i], r = this._readings[i], hit = w.raycastResult;
            r.contact = w.isInContact;
            r.length = w.suspensionLength;
            r.suspensionForce = w.isInContact ? Math.min(w.suspensionForce, w.maxSuspensionForce) : 0;
            // cannon's axle is the chassis's +index axis: along the wheels' right, its sign is _axleSign.
            r.sideImpulse = w.isInContact ? w.sideImpulse * this._axleSign : 0;
            r.point[0] = hit.hitPointWorld.x; r.point[1] = hit.hitPointWorld.y; r.point[2] = hit.hitPointWorld.z;
            r.normal[0] = hit.hitNormalWorld.x; r.normal[1] = hit.hitNormalWorld.y; r.normal[2] = hit.hitNormalWorld.z;
        }
        this._antiRoll();
        const m = this._motion, b = this.chassis;
        m.com[0] = b.position.x; m.com[1] = b.position.y; m.com[2] = b.position.z;
        m.rotation[0] = b.quaternion.x; m.rotation[1] = b.quaternion.y; m.rotation[2] = b.quaternion.z; m.rotation[3] = b.quaternion.w;
        m.linear[0] = b.velocity.x; m.linear[1] = b.velocity.y; m.linear[2] = b.velocity.z;
        m.angular[0] = b.angularVelocity.x; m.angular[1] = b.angularVelocity.y; m.angular[2] = b.angularVelocity.z;
        // An angular impulse as a torque over this substep: preStep runs before cannon integrates it.
        const lean = CannonVehicle._lean;
        if (drive.uprightImpulse(dt, this._readings, m, lean)) b.torque.set(b.torque.x + lean[0] / dt, b.torque.y + lean[1] / dt, b.torque.z + lean[2] / dt);
        drive.finish(dt, this._readings, m);
    }

    public read(out: Out): void { this.drive.write(this._readings, out); }

    private _antiRoll(): void {
        const impulses = this.drive.antiRoll, b = this.chassis, u = this.vehicle.up;
        const up = CannonVehicle._up, impulse = CannonVehicle._impulse, rel = CannonVehicle._rel;
        b.quaternion.vmult(up.set(u[0], u[1], u[2]), up);
        for (let i = 0; i < impulses.length; i++) {
            const j = impulses[i];
            if (j === 0) continue;
            this._raycast.wheelInfos[i].chassisConnectionPointWorld.vsub(b.position, rel);
            up.scale(j, impulse);
            b.applyImpulse(impulse, rel);
        }
    }
}
