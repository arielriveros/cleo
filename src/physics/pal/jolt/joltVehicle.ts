import type JoltNS from 'jolt-physics';
import type { Out } from '../types';
import type { CurvePoint, NormalizedVehicle, VehicleInput } from '../vehicle/vehicleDesc';
import { castFor } from '../vehicle/vehicleDesc';
import {
    VH_GEAR, VH_RPM, VH_SPEED, VH_WHEELS, W_ANGLE, W_CONTACT, W_LAT_SLIP, W_LENGTH, W_LONG_SLIP, W_NORMAL, W_OMEGA,
    W_POINT, W_STEER, wheelOffset,
} from '../vehicle/vehicleState';
import type { Jolt } from './load';
import { clampTo } from '../math';

/** Jolt's "open differential" is FLT_MAX; Infinity is kept out of the WASM side. */
const FLT_MAX = 3.4e38;
const finiteRatio = (r: number): number => (Number.isFinite(r) ? r : FLT_MAX);

/**
 * A vehicle on Jolt: its own VehicleConstraint and WheeledVehicleController, which do everything natively
 * (wheel casts, suspension as a soft constraint, tyre friction from slip curves, engine, gearbox and
 * differentials solved implicitly, anti-roll bars). Built from the shared description field for field:
 * the description is Jolt's, so nothing is translated but its frame.
 *
 * Jolt keeps the constraint and its step listener by pointer: dispose() takes them out of the system and
 * frees them before the world goes.
 */
export class JoltVehicle {
    private readonly _constraint: JoltNS.VehicleConstraint;
    private readonly _controller: JoltNS.WheeledVehicleController;
    private readonly _listener: JoltNS.VehicleConstraintStepListener;
    private readonly _wheels: JoltNS.WheelWV[];
    private _disposed = false;

    /**
     * @param layer the object layer the wheels' casts collide as: the chassis's own
     */
    constructor(
        private readonly _J: Jolt,
        private readonly _system: JoltNS.PhysicsSystem,
        private readonly _body: JoltNS.Body,
        public readonly vehicle: NormalizedVehicle,
        layer: number,
        casts: readonly ('ray' | 'sphere' | 'cylinder')[],
    ) {
        const J = _J, v = vehicle;
        const temps: unknown[] = [];
        const vec = (a: ArrayLike<number>) => { const o = new J.Vec3(a[0], a[1], a[2]); temps.push(o); return o; };
        const settings = new J.VehicleConstraintSettings();
        settings.mUp = vec(v.up);
        settings.mForward = vec(v.forward);
        settings.mMaxPitchRollAngle = v.maxPitchRollAngle;
        settings.mWheels.clear();
        for (const w of v.wheels) {
            // Ref-counted: the settings' array holds it, the constraint's wheel after.
            const s = new J.WheelSettingsWV();
            s.mPosition = vec(w.position);
            s.mSuspensionDirection = vec(w.suspensionDirection);
            s.mSteeringAxis = vec([-w.suspensionDirection[0], -w.suspensionDirection[1], -w.suspensionDirection[2]]);
            s.mWheelUp = vec(v.up);
            s.mWheelForward = vec(v.forward);
            s.mRadius = w.radius;
            s.mWidth = w.width;
            s.mSuspensionMinLength = w.suspensionMinLength;
            s.mSuspensionMaxLength = w.suspensionMaxLength;
            s.mSuspensionPreloadLength = 0;
            s.mSuspensionSpring.mMode = J.ESpringMode_FrequencyAndDamping;
            s.mSuspensionSpring.mFrequency = w.suspensionFrequency;
            s.mSuspensionSpring.mDamping = w.suspensionDamping;
            s.mMaxSteerAngle = w.maxSteerAngle;
            s.mMaxBrakeTorque = w.maxBrakeTorque;
            s.mMaxHandBrakeTorque = w.maxHandBrakeTorque;
            s.mInertia = w.inertia;
            s.mAngularDamping = w.angularDamping;
            fillCurve(s.mLongitudinalFriction, w.longitudinalFriction);
            fillCurve(s.mLateralFriction, w.lateralFriction);
            settings.mWheels.push_back(s);
        }
        settings.mAntiRollBars.clear();
        if (v.antiRollBars.length > 0) {
            settings.mAntiRollBars.resize(v.antiRollBars.length);
            v.antiRollBars.forEach((b, i) => {
                const bar = settings.mAntiRollBars.at(i);
                bar.mLeftWheel = b.leftWheel; bar.mRightWheel = b.rightWheel; bar.mStiffness = b.stiffness;
            });
        }

        const controller = new J.WheeledVehicleControllerSettings();
        const e = controller.mEngine, t = controller.mTransmission;
        e.mMaxTorque = v.engine.maxTorque;
        e.mMinRPM = v.engine.minRpm;
        e.mMaxRPM = v.engine.maxRpm;
        e.mInertia = v.engine.inertia;
        e.mAngularDamping = v.engine.angularDamping;
        fillCurve(e.mNormalizedTorque, v.engine.torqueCurve);
        t.mMode = J.ETransmissionMode_Auto;
        fillFloats(t.mGearRatios, v.transmission.gearRatios);
        fillFloats(t.mReverseGearRatios, v.transmission.reverseGearRatios);
        t.mSwitchTime = v.transmission.switchTime;
        t.mClutchReleaseTime = v.transmission.clutchReleaseTime;
        t.mSwitchLatency = v.transmission.switchLatency;
        t.mShiftUpRPM = v.transmission.shiftUpRpm;
        t.mShiftDownRPM = v.transmission.shiftDownRpm;
        t.mClutchStrength = v.transmission.clutchStrength;
        controller.mDifferentials.clear();
        if (v.differentials.length > 0) {
            controller.mDifferentials.resize(v.differentials.length);
            v.differentials.forEach((d, i) => {
                const s = controller.mDifferentials.at(i);
                s.mLeftWheel = d.leftWheel; s.mRightWheel = d.rightWheel;
                s.mDifferentialRatio = d.ratio;
                s.mLeftRightSplit = d.leftRightSplit;
                s.mLimitedSlipRatio = finiteRatio(d.limitedSlipRatio);
                s.mEngineTorqueRatio = d.engineTorqueRatio;
            });
        }
        controller.mDifferentialLimitedSlipRatio = finiteRatio(v.differentialLimitedSlipRatio);
        settings.mController = controller;

        const constraint = this._constraint = new J.VehicleConstraint(_body, settings);
        // Held here as well as by the system, so it outlives its removal until its listener is gone.
        constraint.AddRef();
        J.destroy(settings);
        for (const o of temps) J.destroy(o);

        const cast = castFor(v.cast, casts);
        const narrowest = Math.min(...v.wheels.map(w => Math.min(w.radius, w.width * 0.5)));
        const tester = cast === 'cylinder' ? new J.VehicleCollisionTesterCastCylinder(layer, 0.1)
            : cast === 'sphere' ? new J.VehicleCollisionTesterCastSphere(layer, narrowest)
            : new J.VehicleCollisionTesterRay(layer);
        constraint.SetVehicleCollisionTester(tester);
        _system.AddConstraint(constraint);
        this._listener = new J.VehicleConstraintStepListener(constraint);
        _system.AddStepListener(this._listener);
        this._controller = J.castObject(constraint.GetController(), J.WheeledVehicleController);
        this._wheels = v.wheels.map((_, i) => J.castObject(constraint.GetWheel(i), J.WheelWV));
    }

    public setInput(input: VehicleInput): void {
        this._controller.SetDriverInput(clampTo(input.forward, -1, 1), clampTo(input.right, -1, 1), clampTo(input.brake, 0, 1), clampTo(input.handBrake, 0, 1));
        // A driver's input wakes the vehicle, as a script's force would.
        if (input.forward !== 0 || input.right !== 0) this._system.GetBodyInterfaceNoLock().ActivateBody(this._body.GetID());
    }

    public read(out: Out): void {
        const v = this.vehicle, b = this._body;
        const vel = b.GetLinearVelocity(), q = b.GetRotation();
        // Forward in world space: the chassis's rotation applied to its forward.
        const fw = v.forward;
        const qx = q.GetX(), qy = q.GetY(), qz = q.GetZ(), qw = q.GetW();
        const tx = 2 * (qy * fw[2] - qz * fw[1]), ty = 2 * (qz * fw[0] - qx * fw[2]), tz = 2 * (qx * fw[1] - qy * fw[0]);
        const wx = fw[0] + qw * tx + (qy * tz - qz * ty), wy = fw[1] + qw * ty + (qz * tx - qx * tz), wz = fw[2] + qw * tz + (qx * ty - qy * tx);
        out[VH_SPEED] = vel.GetX() * wx + vel.GetY() * wy + vel.GetZ() * wz;
        out[VH_RPM] = this._controller.GetEngine().GetCurrentRPM();
        out[VH_GEAR] = this._controller.GetTransmission().GetCurrentGear();
        out[VH_WHEELS] = this._wheels.length;
        for (let i = 0; i < this._wheels.length; i++) {
            const w = this._wheels[i], o = wheelOffset(i), contact = w.HasContact();
            out[o + W_CONTACT] = contact ? 1 : 0;
            out[o + W_LENGTH] = w.GetSuspensionLength();
            out[o + W_STEER] = w.GetSteerAngle();
            out[o + W_ANGLE] = w.GetRotationAngle();
            out[o + W_OMEGA] = w.GetAngularVelocity();
            if (contact) {
                const p = w.GetContactPosition(), n = w.GetContactNormal();
                out[o + W_POINT] = p.GetX(); out[o + W_POINT + 1] = p.GetY(); out[o + W_POINT + 2] = p.GetZ();
                out[o + W_NORMAL] = n.GetX(); out[o + W_NORMAL + 1] = n.GetY(); out[o + W_NORMAL + 2] = n.GetZ();
            } else {
                for (let k = 0; k < 3; k++) { out[o + W_POINT + k] = 0; out[o + W_NORMAL + k] = 0; }
            }
            out[o + W_LONG_SLIP] = contact ? w.mLongitudinalSlip : 0;
            out[o + W_LAT_SLIP] = contact ? w.mLateralSlip : 0;
        }
    }

    /** Take it out of the system and free it. Safe to call twice. */
    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._system.RemoveStepListener(this._listener);
        this._J.destroy(this._listener);
        this._system.RemoveConstraint(this._constraint);
        this._constraint.Release();
    }
}


function fillCurve(curve: JoltNS.LinearCurve, points: readonly CurvePoint[]): void {
    curve.Clear();
    for (const p of points) curve.AddPoint(p[0], p[1]);
    curve.Sort();
}

function fillFloats(array: JoltNS.ArrayFloat, values: readonly number[]): void {
    array.clear();
    for (const v of values) array.push_back(v);
}
