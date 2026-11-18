import type { Collider, DynamicRayCastVehicleController, RigidBody, World } from '@dimforge/rapier3d-compat';
import type { Out } from '../types';
import type { NormalizedVehicle, VehicleInput } from '../vehicle/vehicleDesc';
import { dominantAxis, wheelRight } from '../vehicle/vehicleDesc';
import { RaycastDrive, type ChassisMotion, type RaycastWheelReading } from '../vehicle/raycastDrive';
import { rotate } from '../shapeBounds';

/**
 * A vehicle on Rapier: its DynamicRayCastVehicleController (a port of Bullet's raycast vehicle) finds the
 * ground, springs the suspension and solves the tyres; the shared RaycastDrive supplies the engine, gearbox,
 * brakes and anti-roll bars it lacks. Stepped by RapierWorld.step before Rapier's own step.
 */
export class RapierVehicle {
    public readonly drive: RaycastDrive;
    private readonly _controller: DynamicRayCastVehicleController;
    private readonly _readings: RaycastWheelReading[];
    private readonly _motion: ChassisMotion = { com: [0, 0, 0], rotation: [0, 0, 0, 1], linear: [0, 0, 0], angular: [0, 0, 0] };
    private readonly _up = [0, 0, 0];
    private readonly _hard = [0, 0, 0];
    private readonly _spent: number[] = [];

    /**
     * @param groups the chassis's interaction groups: the wheels meet what the chassis meets
     * @param skip whether a collider is not ground (the chassis's own, a sensor, one without response)
     */
    constructor(
        private readonly _world: World,
        public readonly chassis: RigidBody,
        public readonly vehicle: NormalizedVehicle,
        private readonly _groups: number,
        private readonly _skip: (collider: Collider) => boolean,
    ) {
        const com = chassis.localCom(), inertia = chassis.principalInertia();
        this.drive = new RaycastDrive(vehicle, chassis.mass(), [inertia.x, inertia.y, inertia.z], [com.x, com.y, com.z]);
        const c = this._controller = _world.createVehicleController(chassis);
        const axle = wheelRight(vehicle);
        c.indexUpAxis = dominantAxis(vehicle.up);
        c.setIndexForwardAxis = dominantAxis(vehicle.forward);
        vehicle.wheels.forEach((w, i) => {
            const t = this.drive.tuning[i], p = w.position, d = w.suspensionDirection;
            c.addWheel({ x: p[0], y: p[1], z: p[2] }, { x: d[0], y: d[1], z: d[2] }, { x: axle[0], y: axle[1], z: axle[2] }, t.restLength, w.radius);
            c.setWheelSuspensionStiffness(i, t.stiffness);
            c.setWheelSuspensionCompression(i, t.compression);
            c.setWheelSuspensionRelaxation(i, t.relaxation);
            c.setWheelMaxSuspensionTravel(i, t.maxTravel);
            c.setWheelMaxSuspensionForce(i, t.maxSuspensionForce);
            c.setWheelFrictionSlip(i, t.frictionSlip);
            c.setWheelSideFrictionStiffness(i, 1);
        });
        this._readings = vehicle.wheels.map(w => ({ contact: false, length: w.suspensionMaxLength, suspensionForce: 0, point: [0, 0, 0], normal: [0, 0, 0] }));
    }

    public setInput(input: VehicleInput): void { Object.assign(this.drive.input, input); }

    /** One substep's worth, before Rapier's step integrates what it applied. */
    public update(dt: number): void {
        if (!(dt > 0)) return;
        const c = this._controller, drive = this.drive, n = this._readings.length;
        drive.prepare(dt, this._readings);
        for (let i = 0; i < n; i++) {
            c.setWheelSteering(i, drive.steering[i]);
            c.setWheelEngineForce(i, drive.engineForce[i]);
            c.setWheelBrake(i, drive.brakeImpulse[i]);
        }
        c.updateVehicle(dt, undefined, this._groups, collider => !this._skip(collider));
        for (let i = 0; i < n; i++) {
            const r = this._readings[i];
            r.contact = c.wheelIsInContact(i);
            r.length = c.wheelSuspensionLength(i) ?? this.vehicle.wheels[i].suspensionMaxLength;
            r.suspensionForce = r.contact ? c.wheelSuspensionForce(i) ?? 0 : 0;
            const p = c.wheelContactPoint(i), nrm = c.wheelContactNormal(i);
            if (p) { r.point[0] = p.x; r.point[1] = p.y; r.point[2] = p.z; }
            if (nrm) { r.normal[0] = nrm.x; r.normal[1] = nrm.y; r.normal[2] = nrm.z; }
        }
        this._antiRoll();
        // Rapier splits each wheel's rolling friction among the wheels on the ground: what is left of the brake is held here.
        const spent = this._spent;
        for (let i = 0; i < n; i++) spent[i] = c.wheelForwardImpulse(i) ?? 0;
        this._readMotion();
        drive.holdBrakes(this._readings, this._motion, spent, (x, y, z, p) =>
            this.chassis.applyImpulseAtPoint({ x, y, z }, { x: p[0], y: p[1], z: p[2] }, true));
        this._readMotion();
        drive.finish(dt, this._readings, this._motion);
    }

    private _readMotion(): void {
        const m = this._motion, b = this.chassis;
        const com = b.worldCom(), q = b.rotation(), v = b.linvel(), w = b.angvel();
        m.com[0] = com.x; m.com[1] = com.y; m.com[2] = com.z;
        m.rotation[0] = q.x; m.rotation[1] = q.y; m.rotation[2] = q.z; m.rotation[3] = q.w;
        m.linear[0] = v.x; m.linear[1] = v.y; m.linear[2] = v.z;
        m.angular[0] = w.x; m.angular[1] = w.y; m.angular[2] = w.z;
    }

    public read(out: Out): void { this.drive.write(this._readings, out); }

    public dispose(): void {
        if (this._world.vehicleControllers.has(this._controller)) this._world.removeVehicleController(this._controller);
    }

    private _antiRoll(): void {
        const impulses = this.drive.antiRoll, b = this.chassis;
        const t = b.translation(), q = b.rotation(), qa = [q.x, q.y, q.z, q.w], up = this._up, hard = this._hard, u = this.vehicle.up;
        rotate(qa, u[0], u[1], u[2], up);
        for (let i = 0; i < impulses.length; i++) {
            const j = impulses[i];
            if (j === 0) continue;
            const p = this.vehicle.wheels[i].position;
            rotate(qa, p[0], p[1], p[2], hard);
            b.applyImpulseAtPoint({ x: up[0] * j, y: up[1] * j, z: up[2] * j }, { x: t.x + hard[0], y: t.y + hard[1], z: t.z + hard[2] }, true);
        }
    }
}
