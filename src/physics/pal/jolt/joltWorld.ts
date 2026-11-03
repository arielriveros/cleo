import type JoltNS from 'jolt-physics';
import type { PhysicsCapabilities } from '../capabilities';
import { PhysicsEventKind } from '../types';
import type {
    BodyDesc, BodyHandle, BodyType, ColliderDesc, ColliderPart, JointDesc, JointHandle, MassProperties, Out,
    RayHit, RayOptions, ShapeDesc, StepProfile, V3,
} from '../types';
import type { DescribedWorld } from '../copy/describedWorld';
import { boundingRadiusOf, collidersAabb, multiply, partShapeFor, rotate } from '../shapeBounds';
import { fromX, matchedFrame } from '../jointFrames';
import { jolt, type Jolt } from './load';

// The Jolt backend (jolt-physics, JoltPhysics.js; see docs/reference/physics-backends.md for what its spike
// found). Every layer convention holds as on cannon:
//  - a handle is this world's own increasing integer, mapped to Jolt's bodies (a BodyID packs an index and a
//    sequence number, and the simulation depends on it: a copy is built with the same ones);
//  - a body's position is its node origin, which is Jolt's own body position; its collider frame is the
//    centre of mass (the node origin for a body that does not move);
//  - a force lasts one substep (Jolt clears them after each update);
//  - events come per BODY pair (Jolt's contact callbacks are per sub-shape pair), in the order they happened.
//
// Every Jolt object made here is freed here: the WASM heap is a fixed 128 MB, and a world costs ~20 MB of it.

const DEFAULT_FRICTION = 0.3;
const DEFAULT_RESTITUTION = 0;
const LAYER_BITS = 0xFFFF;
/** Bodies a world can hold: Jolt sizes its tables for them up front. */
const MAX_BODIES = 16384;
const MAX_BODY_PAIRS = 65536;
const MAX_CONTACT_CONSTRAINTS = 10240;
/** Jolt clamps velocities (angular to ~47 rad/s by default); cannon never does. */
const MAX_LINEAR_VELOCITY = 1e4;
const MAX_ANGULAR_VELOCITY = 1e4;
/** How far a plane collider reaches each way. */
const PLANE_HALF_EXTENT = 1e4;
/** Jolt's default rounding of convex shapes' corners, kept below each shape's own size. */
const CONVEX_RADIUS = 0.05;

export const JOLT_CAPABILITIES: PhysicsCapabilities = {
    backend: 'jolt',
    nativeCapsule: true,
    collisionGroupBits: 16,
    fractionalAxisFactors: false,
    jointMaxForce: false,
    coneLimit: 'native',
    manualSleep: true,
    profilePhases: [],
    threadable: false,
    precision: 32,
};

/** cannon's damping, `v *= (1 − d)^dt`, as Jolt's rate `c` in `v *= 1 − c·dt`: the same decay for small dt. */
function dampingRate(d: number): number {
    if (!(d > 0)) return 0;
    if (d >= 1) return 1e6;
    return -Math.log(1 - d);
}

/**
 * A joint as built, from which a copy (the physics worker's) builds the same joint whatever the bodies' poses
 * are then: anchors from each body's node origin, and the frames measured from the poses it was made in.
 */
export type JoltJointRecord = { a: BodyHandle; b: BodyHandle; collideConnected: boolean } & (
    /** A's origin and frame, seen from B. */
    | { kind: 'fixed'; anchorB: number[]; frameB: number[] }
    | { kind: 'ball'; anchorA: number[]; anchorB: number[] }
    /** Frames with X along the hinge, Y the zero angle. */
    | { kind: 'hinge'; anchorA: number[]; anchorB: number[]; frameA: number[]; frameB: number[] }
    /** Frames with X the twist axis, Y the plane axis. */
    | { kind: 'cone'; anchorA: number[]; anchorB: number[]; frameA: number[]; frameB: number[]; twist: number; cone: number }
);

interface Entry {
    readonly handle: BodyHandle;
    readonly body: JoltNS.Body;
    /** Jolt's BodyID, index and sequence number. */
    readonly id: number;
    /** The body's address in the WASM heap: what contact callbacks name it by. */
    readonly ptr: number;
    /** What it was made from; the fields below follow later changes. */
    readonly desc: BodyDesc;
    /** Bumped by every change to what it is made of (colliders, layers, response, reporting): what a copy diffs by. */
    configVersion: number;
    readonly type: BodyType;
    readonly mass: number;
    readonly sensor: boolean;
    readonly dofs: number;
    colliderDescs: readonly ColliderDesc[];
    centerOfMass: 'colliders' | 'origin';
    group: number;
    mask: number;
    response: boolean;
    reports: boolean;
    readonly friction: number;
    readonly restitution: number;
    enabled: boolean;
    parts: ColliderPart[] | null;
    radius: number;
    /** The rotation last given to setTransform, as given (see takeWrittenRotation). */
    written: number[] | null;
}

/** The Jolt objects a world owns, freed together (by dispose, or when the world is collected without it). */
interface Native {
    jolt: JoltNS.JoltInterface | null;
    owned: unknown[];
}

const collected = new FinalizationRegistry<Native>(native => freeNative(native));

function freeNative(native: Native): void {
    const J = jolt();
    // The filters and the listener reference the world's tables: freed before it.
    for (const o of native.owned) J.destroy(o);
    native.owned.length = 0;
    if (native.jolt) { J.destroy(native.jolt); native.jolt = null; }
}

export class JoltWorld implements DescribedWorld<JoltJointRecord> {
    public readonly backend = 'jolt' as const;
    public readonly capabilities = JOLT_CAPABILITIES;
    public onPreSubstep: ((dt: number) => void) | null = null;
    public profile = false;

    private readonly _J: Jolt;
    private readonly _native: Native = { jolt: null, owned: [] };
    private _system!: JoltNS.PhysicsSystem;
    private _bi!: JoltNS.BodyInterface;
    private _lock!: JoltNS.BodyLockInterfaceNoLock;
    private _query!: JoltNS.NarrowPhaseQuery;
    private _bpFilter!: JoltNS.DefaultBroadPhaseLayerFilter;
    private _layerFilter!: JoltNS.DefaultObjectLayerFilter;
    private _gravity: V3;
    private _iterations = 10;
    private _time = 0;
    private _version = 0;
    private _nextHandle = 1;
    private _nextJoint = 1;
    private readonly _entries = new Map<number, Entry>();
    private readonly _byId = new Map<number, Entry>();
    private readonly _byPtr = new Map<number, Entry>();
    /** Enabled bodies in the world's order: creation order, a re-enabled body last. */
    private readonly _order: BodyHandle[] = [];
    private _bodyList: BodyHandle[] | null = null;
    private readonly _joints = new Map<number, { constraint: JoltNS.TwoBodyConstraint; record: JoltJointRecord }>();
    /** Body pairs ("lo,hi" handles) a joint keeps from colliding. */
    private readonly _noCollide = new Map<string, number>();
    /** Queued events: [kind, a, b] per event. */
    private _events: number[] = [];
    /** Live sub-shape pairs (see _subPair) → their body pair ("lo,hi"). */
    private readonly _live = new Map<string, string>();
    /**
     * Overlapping sub-shape pairs per body pair, and the bodies in the order the pair began with: a pair
     * begins on the first and ends on the last.
     */
    private readonly _pairCounts = new Map<string, { n: number; a: BodyHandle; b: BodyHandle }>();
    /** The last step's contacts, [a, b, nx, ny, nz] per manifold. */
    private _rows: number[] = [];
    private _rayOptions: RayOptions = { mode: 'all' };
    private readonly _hit: RayHit = { body: 0 as BodyHandle, point: [0, 0, 0], normal: [0, 0, 0], distance: 0 };
    private readonly _v = [0, 0, 0];

    // Reused native scratch (freed with the world).
    private readonly _vec: JoltNS.Vec3;
    private readonly _vec2: JoltNS.Vec3;
    private readonly _rvec: JoltNS.RVec3;
    private readonly _quat: JoltNS.Quat;
    private readonly _ray: JoltNS.RRayCast;
    private readonly _raySettings: JoltNS.RayCastSettings;
    private readonly _closest: JoltNS.CastRayClosestHitCollisionCollector;
    private readonly _all: JoltNS.CastRayAllHitCollisionCollector;
    private readonly _anyBody: JoltNS.BodyFilter;
    private readonly _rayBodies: JoltNS.BodyFilterJS;
    private readonly _anyShape: JoltNS.ShapeFilter;
    private readonly _listener: JoltNS.ContactListenerJS;

    constructor(gravity: ArrayLike<number> = [0, -9.81, 0]) {
        const J = this._J = jolt();
        this._gravity = [gravity[0], gravity[1], gravity[2]];
        const own = <T>(o: T): T => { this._native.owned.push(o); return o; };
        this._vec = own(new J.Vec3(0, 0, 0));
        this._vec2 = own(new J.Vec3(0, 0, 0));
        this._rvec = own(new J.RVec3(0, 0, 0));
        this._quat = own(new J.Quat(0, 0, 0, 1));
        this._ray = own(new J.RRayCast());
        this._raySettings = own(new J.RayCastSettings());
        // Not solid, both faces: a ray meets a body's entry and exit faces, and one that starts inside meets
        // the way out, never 0 (as on cannon).
        this._raySettings.mTreatConvexAsSolid = false;
        this._raySettings.mBackFaceModeConvex = J.EBackFaceMode_CollideWithBackFaces;
        this._raySettings.mBackFaceModeTriangles = J.EBackFaceMode_CollideWithBackFaces;
        this._closest = own(new J.CastRayClosestHitCollisionCollector());
        this._all = own(new J.CastRayAllHitCollisionCollector());
        this._anyBody = own(new J.BodyFilter());
        this._anyShape = own(new J.ShapeFilter());

        this._rayBodies = own(new J.BodyFilterJS());
        this._listener = own(new J.ContactListenerJS());
        JoltWorld._bind(J, this._listener, this._rayBodies, new WeakRef(this));

        this._build();
        collected.register(this, this._native, this);
    }

    // ---- world ----

    public get time(): number { return this._time; }
    public set time(t: number) { this._time = t; }

    public get gravity(): V3 { return [this._gravity[0], this._gravity[1], this._gravity[2]]; }
    public set gravity(g: V3) {
        this._gravity = [g[0], g[1], g[2]];
        this._system.SetGravity(this._v3(g[0], g[1], g[2]));
    }

    public get solverIterations(): number { return this._iterations; }
    public set solverIterations(n: number) {
        if (!(n > 0)) return;
        this._iterations = n;
        const settings = this._system.GetPhysicsSettings();
        settings.mNumVelocitySteps = n;
        this._system.SetPhysicsSettings(settings);
    }

    public get stateVersion(): number { return this._version; }

    // ---- bodies ----

    public createBody(desc: BodyDesc): BodyHandle { return this._create(desc, undefined); }

    public destroyBody(h: BodyHandle): void {
        const e = this._entries.get(h);
        if (!e) return;
        // Jolt keeps a joint's bodies by pointer: its joints go first.
        for (const [id, j] of [...this._joints]) if (j.record.a === h || j.record.b === h) this.destroyJoint(id as JointHandle);
        const id = e.body.GetID();
        if (e.enabled) this._bi.RemoveBody(id);
        this._bi.DestroyBody(id);
        this._entries.delete(h);
        this._byId.delete(e.id);
        this._byPtr.delete(e.ptr);
        if (e.enabled) this._removeFromOrder(h);
        this._forget(h);
        this._version++;
    }

    public hasBody(h: BodyHandle): boolean { return this._entries.has(h); }

    public setEnabled(h: BodyHandle, enabled: boolean): void {
        const e = this._entries.get(h);
        if (!e || e.enabled === enabled) return;
        e.enabled = enabled;
        // A joint on a body out of the world must not pull on it.
        for (const j of this._joints.values()) if (j.record.a === h || j.record.b === h) j.constraint.SetEnabled(enabled && this._bothEnabled(j.record));
        if (enabled) {
            this._bi.AddBody(e.body.GetID(), e.type === 'static' ? this._J.EActivation_DontActivate : this._J.EActivation_Activate);
            this._order.push(h);
            this._bodyList = null;
        } else {
            this._bi.RemoveBody(e.body.GetID());
            this._removeFromOrder(h);
            this._forget(h);
        }
    }

    public isEnabled(h: BodyHandle): boolean { return this._entries.get(h)?.enabled ?? false; }

    public bodies(): readonly BodyHandle[] { return this._bodyList ??= this._order.slice(); }

    public get bodyCount(): number { return this._order.length; }

    public setColliders(h: BodyHandle, colliders: readonly ColliderDesc[], centerOfMass?: 'colliders' | 'origin'): void {
        const e = this._entry(h);
        if (centerOfMass) e.centerOfMass = centerOfMass;
        e.colliderDescs = [...colliders];
        const shape = this._shape(e.colliderDescs, e.type === 'dynamic' ? e.centerOfMass : 'colliders');
        // The node origin stays where it is (Jolt moves its centre of mass with the shape).
        this._bi.SetShape(e.body.GetID(), shape, false, this._J.EActivation_DontActivate);
        shape.Release();
        if (e.type === 'dynamic') this._applyMass(e);
        e.parts = null;
        e.configVersion++;
        this._version++;
    }

    public setCollisionFilter(h: BodyHandle, group: number, mask: number): void {
        const e = this._entry(h);
        e.group = group; e.mask = mask;
        this._bi.SetObjectLayer(e.body.GetID(), this._layer(group, mask));
        e.configVersion++;
    }

    public setCollisionResponse(h: BodyHandle, response: boolean): void {
        const e = this._entry(h);
        e.response = response;
        e.configVersion++;
    }

    public setReportContacts(h: BodyHandle, report: boolean): void {
        const e = this._entry(h);
        e.reports = report;
        e.configVersion++;
    }

    public getMassProperties(h: BodyHandle, out: MassProperties): MassProperties {
        const e = this._entry(h);
        if (e.type !== 'dynamic') {
            out.mass = 0;
            out.centerOfMass[0] = out.centerOfMass[1] = out.centerOfMass[2] = 0;
            out.inertia[0] = out.inertia[1] = out.inertia[2] = 0;
            return out;
        }
        const mp = e.body.GetMotionProperties(), inv = mp.GetInverseMass(), i = mp.GetInverseInertiaDiagonal();
        out.mass = inv > 0 ? e.mass : 0;
        if (e.centerOfMass === 'origin') out.centerOfMass[0] = out.centerOfMass[1] = out.centerOfMass[2] = 0;
        else {
            const c = e.body.GetShape().GetCenterOfMass();
            out.centerOfMass[0] = c.GetX(); out.centerOfMass[1] = c.GetY(); out.centerOfMass[2] = c.GetZ();
        }
        out.inertia[0] = i.GetX() > 0 ? 1 / i.GetX() : 0;
        out.inertia[1] = i.GetY() > 0 ? 1 / i.GetY() : 0;
        out.inertia[2] = i.GetZ() > 0 ? 1 / i.GetZ() : 0;
        return out;
    }

    public getTransform(h: BodyHandle, out: Out): void {
        const b = this._entry(h).body, p = b.GetPosition();
        out[0] = p.GetX(); out[1] = p.GetY(); out[2] = p.GetZ();
        const q = b.GetRotation();
        out[3] = q.GetX(); out[4] = q.GetY(); out[5] = q.GetZ(); out[6] = q.GetW();
    }

    public setTransform(h: BodyHandle, position: ArrayLike<number> | null, rotation: ArrayLike<number> | null): void {
        const e = this._entry(h), id = e.body.GetID(), stay = this._J.EActivation_DontActivate;
        if (position && rotation) this._bi.SetPositionAndRotation(id, this._rv3(position[0], position[1], position[2]), this._q4(rotation), stay);
        else if (position) this._bi.SetPosition(id, this._rv3(position[0], position[1], position[2]), stay);
        else if (rotation) this._bi.SetRotation(id, this._q4(rotation), stay);
        if (rotation) e.written = [rotation[0], rotation[1], rotation[2], rotation[3]];
        this._version++;
    }

    public getVelocity(h: BodyHandle, out: Out): void {
        const b = this._entry(h).body, v = b.GetLinearVelocity();
        out[0] = v.GetX(); out[1] = v.GetY(); out[2] = v.GetZ();
        const w = b.GetAngularVelocity();
        out[3] = w.GetX(); out[4] = w.GetY(); out[5] = w.GetZ();
    }

    // Written through the body, not the body interface: that would wake it. The engine wakes what it means to.
    public setLinearVelocity(h: BodyHandle, x: number, y: number, z: number): void {
        const e = this._entry(h);
        if (e.type !== 'static') e.body.SetLinearVelocity(this._v3(x, y, z));
        this._version++;
    }

    public setAngularVelocity(h: BodyHandle, x: number, y: number, z: number): void {
        const e = this._entry(h);
        if (e.type !== 'static') e.body.SetAngularVelocity(this._v3(x, y, z));
        this._version++;
    }

    public applyImpulse(h: BodyHandle, impulse: ArrayLike<number>, relativePoint?: ArrayLike<number>): void {
        const e = this._entry(h);
        if (e.type !== 'dynamic') return;
        const j = this._v3(impulse[0], impulse[1], impulse[2]);
        if (relativePoint) this._bi.AddImpulse(e.body.GetID(), j, this._atCom(e, relativePoint));
        else this._bi.AddImpulse(e.body.GetID(), j);
        this._version++;
    }

    public applyForce(h: BodyHandle, force: ArrayLike<number>, relativePoint?: ArrayLike<number>): void {
        const e = this._entry(h);
        if (e.type !== 'dynamic') return;
        const f = this._v3(force[0], force[1], force[2]);
        if (relativePoint) this._bi.AddForce(e.body.GetID(), f, this._atCom(e, relativePoint), this._J.EActivation_Activate);
        else this._bi.AddForce(e.body.GetID(), f, this._J.EActivation_Activate);
    }

    public clearForces(h: BodyHandle): void {
        const e = this._entry(h);
        if (e.type !== 'dynamic') return;
        e.body.ResetForce();
        e.body.ResetTorque();
    }

    public sleep(h: BodyHandle): void {
        const e = this._entry(h);
        if (e.type !== 'static' && e.enabled) this._bi.DeactivateBody(e.body.GetID());
    }

    public wakeUp(h: BodyHandle): void {
        const e = this._entry(h);
        if (e.type !== 'static' && e.enabled) this._bi.ActivateBody(e.body.GetID());
    }

    public isSleeping(h: BodyHandle): boolean {
        const e = this._entry(h);
        return e.type !== 'static' && !e.body.IsActive();
    }

    public getAabb(h: BodyHandle, out: Out): void {
        const e = this._entry(h), pose = new Array<number>(7);
        this.getTransform(h, pose);
        collidersAabb(e.colliderDescs, pose, out);
    }

    public colliderParts(h: BodyHandle): readonly ColliderPart[] {
        const e = this._entry(h);
        if (!e.parts) this._buildParts(e);
        return e.parts!;
    }

    public getColliderFrame(h: BodyHandle, out: Out): number {
        const e = this._entry(h), b = e.body;
        const c = e.type === 'dynamic' ? b.GetCenterOfMassPosition() : b.GetPosition();
        out[0] = c.GetX(); out[1] = c.GetY(); out[2] = c.GetZ();
        const q = b.GetRotation();
        out[3] = q.GetX(); out[4] = q.GetY(); out[5] = q.GetZ(); out[6] = q.GetW();
        if (!e.parts) this._buildParts(e);
        return e.radius;
    }

    public colliderFrameToOrigin(h: BodyHandle, pose: ArrayLike<number>, out: Out): void {
        const c = this._localCom(this._entry(h)), v = this._v;
        rotate([pose[3], pose[4], pose[5], pose[6]], c[0], c[1], c[2], v);
        out[0] = pose[0] - v[0]; out[1] = pose[1] - v[1]; out[2] = pose[2] - v[2];
    }

    // ---- joints ----

    public createJoint(desc: JointDesc): JointHandle {
        const ea = this._entry(desc.a), eb = this._entry(desc.b);
        const v = (x: V3) => [x[0], x[1], x[2]];
        const collideConnected = !!desc.collideConnected;
        const qa = this._rotation(ea), qb = this._rotation(eb);
        let record: JoltJointRecord;
        switch (desc.kind) {
            case 'fixed': {
                // Hold the pose the two have now: A's origin and frame, seen from B.
                const ta = this._position(ea), tb = this._position(eb);
                const inv = [-qb[0], -qb[1], -qb[2], qb[3]], d = [0, 0, 0], frame = [0, 0, 0, 1];
                rotate(inv, ta[0] - tb[0], ta[1] - tb[1], ta[2] - tb[2], d);
                multiply(inv, qa, frame);
                record = { kind: 'fixed', a: desc.a, b: desc.b, collideConnected, anchorB: d, frameB: frame };
                break;
            }
            case 'ball':
                record = { kind: 'ball', a: desc.a, b: desc.b, collideConnected, anchorA: v(desc.anchorA), anchorB: v(desc.anchorB) };
                break;
            case 'hinge': {
                // B's zero angle is A's as the two stand now.
                const frameA = fromX(desc.axisA), frameB = matchedFrame(qa, frameA, qb, desc.axisB);
                record = { kind: 'hinge', a: desc.a, b: desc.b, collideConnected, anchorA: v(desc.anchorA), anchorB: v(desc.anchorB), frameA, frameB };
                break;
            }
            case 'coneTwist': {
                // Twist about each body's axis, measured from the pose the joint is made in (see matchedFrame):
                // two frames rolled apart at the start would read as a twist past a tight limit.
                const frameA = fromX(desc.axisA), frameB = matchedFrame(qa, frameA, qb, desc.axisB);
                record = {
                    kind: 'cone', a: desc.a, b: desc.b, collideConnected, anchorA: v(desc.anchorA), anchorB: v(desc.anchorB),
                    frameA, frameB, twist: desc.twistAngle, cone: desc.coneAngle,
                };
                break;
            }
        }
        return this.createJointFromRecord(record);
    }

    /** Build a joint from its record (createJoint's, or a copy's with its own body handles). */
    public createJointFromRecord(record: JoltJointRecord): JointHandle {
        const J = this._J;
        const ea = this._entry(record.a), eb = this._entry(record.b);
        // Jolt measures a joint's points from each body's centre of mass.
        const ca = this._shapeCom(ea), cb = this._shapeCom(eb);
        const point = (anchor: number[], c: number[]) => new J.RVec3(anchor[0] - c[0], anchor[1] - c[1], anchor[2] - c[2]);
        const axis = (frame: number[], x: number, y: number, z: number) => { const r = rotate(frame, x, y, z, [0, 0, 0]); return new J.Vec3(r[0], r[1], r[2]); };
        const temps: unknown[] = [];
        const t = <T>(o: T): T => { temps.push(o); return o; };
        let settings: JoltNS.TwoBodyConstraintSettings;
        switch (record.kind) {
            case 'fixed': {
                const s = new J.FixedConstraintSettings();
                s.mSpace = J.EConstraintSpace_LocalToBodyCOM;
                s.mAutoDetectPoint = false;
                s.mPoint1 = t(point([0, 0, 0], ca));
                s.mAxisX1 = t(new J.Vec3(1, 0, 0)); s.mAxisY1 = t(new J.Vec3(0, 1, 0));
                s.mPoint2 = t(point(record.anchorB, cb));
                s.mAxisX2 = t(axis(record.frameB, 1, 0, 0)); s.mAxisY2 = t(axis(record.frameB, 0, 1, 0));
                settings = s;
                break;
            }
            case 'ball': {
                const s = new J.PointConstraintSettings();
                s.mSpace = J.EConstraintSpace_LocalToBodyCOM;
                s.mPoint1 = t(point(record.anchorA, ca));
                s.mPoint2 = t(point(record.anchorB, cb));
                settings = s;
                break;
            }
            case 'hinge': {
                const s = new J.HingeConstraintSettings();
                s.mSpace = J.EConstraintSpace_LocalToBodyCOM;
                s.mPoint1 = t(point(record.anchorA, ca));
                s.mHingeAxis1 = t(axis(record.frameA, 1, 0, 0)); s.mNormalAxis1 = t(axis(record.frameA, 0, 1, 0));
                s.mPoint2 = t(point(record.anchorB, cb));
                s.mHingeAxis2 = t(axis(record.frameB, 1, 0, 0)); s.mNormalAxis2 = t(axis(record.frameB, 0, 1, 0));
                settings = s;
                break;
            }
            case 'cone': {
                const s = new J.SwingTwistConstraintSettings();
                s.mSpace = J.EConstraintSpace_LocalToBodyCOM;
                s.mPosition1 = t(point(record.anchorA, ca));
                s.mTwistAxis1 = t(axis(record.frameA, 1, 0, 0)); s.mPlaneAxis1 = t(axis(record.frameA, 0, 1, 0));
                s.mPosition2 = t(point(record.anchorB, cb));
                s.mTwistAxis2 = t(axis(record.frameB, 1, 0, 0)); s.mPlaneAxis2 = t(axis(record.frameB, 0, 1, 0));
                s.mSwingType = J.ESwingType_Cone;
                s.mNormalHalfConeAngle = record.cone;
                s.mPlaneHalfConeAngle = record.cone;
                s.mTwistMinAngle = -record.twist;
                s.mTwistMaxAngle = record.twist;
                settings = s;
                break;
            }
        }
        const constraint = J.castObject(settings.Create(ea.body, eb.body), J.TwoBodyConstraint);
        J.destroy(settings);
        for (const o of temps) J.destroy(o);
        this._system.AddConstraint(constraint);
        constraint.SetEnabled(this._bothEnabled(record));
        if (!record.collideConnected) {
            const key = pairKey(record.a, record.b);
            this._noCollide.set(key, (this._noCollide.get(key) ?? 0) + 1);
        }
        const id = this._nextJoint++;
        this._joints.set(id, { constraint, record });
        return id as JointHandle;
    }

    public destroyJoint(j: JointHandle): void {
        const entry = this._joints.get(j);
        if (!entry) return;
        this._system.RemoveConstraint(entry.constraint);
        this._joints.delete(j);
        if (!entry.record.collideConnected) {
            const key = pairKey(entry.record.a, entry.record.b), n = (this._noCollide.get(key) ?? 1) - 1;
            if (n > 0) this._noCollide.set(key, n); else this._noCollide.delete(key);
        }
    }

    // ---- the step ----

    public step(dt: number): void {
        this.onPreSubstep?.(dt);
        this._rows = [];
        if (dt > 0) this._native.jolt!.Step(dt, 1);
        this._time += dt;
        this._version++;
    }

    public readProfile(_out: StepProfile): void { /* Jolt measures no phases here (profilePhases: []) */ }

    public forEachContact(visit: (a: BodyHandle, b: BodyHandle, nx: number, ny: number, nz: number) => void): void {
        const rows = this._rows;
        for (let i = 0; i < rows.length; i += 5) visit(rows[i] as BodyHandle, rows[i + 1] as BodyHandle, rows[i + 2], rows[i + 3], rows[i + 4]);
    }

    public get contactCount(): number { return this._rows.length / 5; }

    public drainEvents(visit: (kind: PhysicsEventKind, a: BodyHandle, b: BodyHandle) => void): void {
        const events = this._events;
        if (events.length === 0) return;
        this._events = [];
        for (let i = 0; i < events.length; i += 3) visit(events[i] as PhysicsEventKind, events[i + 1] as BodyHandle, events[i + 2] as BodyHandle);
    }

    // ---- queries ----

    public raycast(from: ArrayLike<number>, to: ArrayLike<number>, options: RayOptions, onHit: (hit: RayHit) => void): void {
        const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
        const length = Math.hypot(dx, dy, dz);
        if (!(length > 0)) return;
        const ray = this._ray;
        ray.mOrigin = this._rv3(from[0], from[1], from[2]);
        ray.mDirection = this._v3(dx, dy, dz);
        this._rayOptions = options;
        // Bodies with collisionResponse off are skipped unless asked for, as cannon's rays skip them.
        const filtered = options.excludeDynamic || !options.includeNoResponse;
        const bodies = filtered ? this._rayBodies : this._anyBody;
        const report = (result: JoltNS.RayCastResult): void => {
            const e = this._byId.get(result.mBodyID.GetIndexAndSequenceNumber());
            if (!e) return;
            const f = result.mFraction, hit = this._hit;
            hit.body = e.handle;
            hit.point[0] = from[0] + dx * f; hit.point[1] = from[1] + dy * f; hit.point[2] = from[2] + dz * f;
            const n = e.body.GetWorldSpaceSurfaceNormal(result.mSubShapeID2, this._rv3(hit.point[0], hit.point[1], hit.point[2]));
            hit.normal[0] = n.GetX(); hit.normal[1] = n.GetY(); hit.normal[2] = n.GetZ();
            hit.distance = f * length;
            onHit(hit);
        };
        if (options.mode === 'closest') {
            const c = this._closest;
            c.Reset();
            this._query.CastRay(ray, this._raySettings, c, this._bpFilter, this._layerFilter, bodies, this._anyShape);
            if (c.HadHit()) report(c.mHit);
            return;
        }
        const c = this._all;
        c.Reset();
        this._query.CastRay(ray, this._raySettings, c, this._bpFilter, this._layerFilter, bodies, this._anyShape);
        if (!c.HadHit()) return;
        c.Sort();
        const hits = c.mHits;
        for (let i = 0, n = hits.size(); i < n; i++) report(hits.at(i));
    }

    public clear(): void {
        this._native.jolt && this._freeWorld();
        this._entries.clear();
        this._byId.clear();
        this._byPtr.clear();
        this._order.length = 0;
        this._bodyList = null;
        this._joints.clear();
        this._noCollide.clear();
        this._events = [];
        this._live.clear();
        this._pairCounts.clear();
        this._rows = [];
        this._build();
        this._version++;
    }

    public dispose(): void {
        collected.unregister(this);
        this._freeWorld();
        freeNative(this._native);
        this._entries.clear();
        this._byId.clear();
        this._byPtr.clear();
        this._order.length = 0;
        this._joints.clear();
        this.onPreSubstep = null;
    }

    // ---- for the copy in the physics worker (copy/describedMirror.ts, describedReplica.ts) ----

    /** What a body is made of now, as a description a copy can build it from (at its current pose). */
    public descOf(h: BodyHandle): BodyDesc {
        const e = this._entry(h), pose = new Array<number>(7);
        this.getTransform(h, pose);
        return {
            ...e.desc,
            position: [pose[0], pose[1], pose[2]], rotation: [pose[3], pose[4], pose[5], pose[6]],
            colliders: e.colliderDescs, centerOfMass: e.centerOfMass,
            group: e.group, mask: e.mask, collisionResponse: e.response, reportContacts: e.reports,
        };
    }

    public configVersionOf(h: BodyHandle): number { return this._entry(h).configVersion; }

    /** Jolt's BodyID of a body: a copy gives its body the same one, or it would not step alike. */
    public nativeIdOf(h: BodyHandle): number { return this._entry(h).id; }

    /** createBody, the body taking the BodyID the original's has (see nativeIdOf). */
    public createBodyWithNativeId(desc: BodyDesc, nativeId: number): BodyHandle { return this._create(desc, nativeId); }

    public takeWrittenRotation(h: BodyHandle): number[] | null {
        const e = this._entry(h), r = e.written;
        e.written = null;
        return r;
    }

    public jointRecords(): IterableIterator<[number, { readonly record: JoltJointRecord }]> { return this._joints.entries(); }

    public pendingForces(h: BodyHandle, out: Out): void {
        const e = this._entry(h);
        if (e.type !== 'dynamic') { for (let i = 0; i < 6; i++) out[i] = 0; return; }
        const f = e.body.GetAccumulatedForce();
        out[0] = f.GetX(); out[1] = f.GetY(); out[2] = f.GetZ();
        const t = e.body.GetAccumulatedTorque();
        out[3] = t.GetX(); out[4] = t.GetY(); out[5] = t.GetZ();
    }

    public addTorque(h: BodyHandle, x: number, y: number, z: number): void {
        const e = this._entry(h);
        if (e.type === 'dynamic') this._bi.AddTorque(e.body.GetID(), this._v3(x, y, z), this._J.EActivation_Activate);
    }

    public raise(kind: PhysicsEventKind, a: BodyHandle, b: BodyHandle): void { this._events.push(kind, a, b); }

    public touch(): void {
        this._version++;
        this._rows = [];
    }

    public isDynamic(h: BodyHandle): boolean { return this._entry(h).type === 'dynamic'; }

    public floaterOf(h: BodyHandle): { mass: number; isTrigger: boolean; collisionResponse: boolean; character: boolean } | undefined {
        const e = this._entry(h);
        if (e.type !== 'dynamic') return undefined;
        return { mass: e.mass, isTrigger: e.sensor, collisionResponse: e.response, character: ((e.desc.userData ?? 0) & 1) !== 0 };
    }

    // ---- internals ----

    /** Make the Jolt world itself (again, after a clear), with this world's gravity and settings. */
    private _build(): void {
        const J = this._J;
        const settings = new J.JoltSettings();
        settings.mMaxBodies = MAX_BODIES;
        settings.mMaxBodyPairs = MAX_BODY_PAIRS;
        settings.mMaxContactConstraints = MAX_CONTACT_CONSTRAINTS;
        settings.mMaxWorkerThreads = 0;
        // One broadphase layer; collision layers are the bodies' object layers (16-bit group, 16-bit mask).
        const bp = new J.BroadPhaseLayerInterfaceMask(1), layer = new J.BroadPhaseLayer(0);
        bp.ConfigureLayer(layer, LAYER_BITS, 0);
        J.destroy(layer);
        settings.mObjectLayerPairFilter = new J.ObjectLayerPairFilterMask();
        settings.mBroadPhaseLayerInterface = bp;
        settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterMask(bp);
        const world = this._native.jolt = new J.JoltInterface(settings);
        J.destroy(settings);
        this._system = world.GetPhysicsSystem();
        this._bi = this._system.GetBodyInterfaceNoLock();
        this._lock = this._system.GetBodyLockInterfaceNoLock();
        this._query = this._system.GetNarrowPhaseQueryNoLock();
        this._system.SetContactListener(this._listener);
        this._system.SetGravity(this._v3(this._gravity[0], this._gravity[1], this._gravity[2]));
        const physics = this._system.GetPhysicsSettings();
        physics.mNumVelocitySteps = this._iterations;
        this._system.SetPhysicsSettings(physics);
        // Rays are in every layer and collide with every one: a body whose mask (or group) is 0 is skipped,
        // as a cannon ray skips it.
        const rayLayer = this._layer(LAYER_BITS, LAYER_BITS);
        this._bpFilter = new J.DefaultBroadPhaseLayerFilter(world.GetObjectVsBroadPhaseLayerFilter(), rayLayer);
        this._layerFilter = new J.DefaultObjectLayerFilter(world.GetObjectLayerPairFilter(), rayLayer);
    }

    private _freeWorld(): void {
        const J = this._J;
        if (!this._native.jolt) return;
        J.destroy(this._bpFilter);
        J.destroy(this._layerFilter);
        J.destroy(this._native.jolt);
        this._native.jolt = null;
    }

    private _create(desc: BodyDesc, nativeId: number | undefined): BodyHandle {
        const J = this._J;
        const type: BodyType = desc.type ?? (desc.mass > 0 ? 'dynamic' : 'static');
        const centerOfMass = desc.centerOfMass ?? 'colliders';
        const colliders = [...desc.colliders];
        const shape = this._shape(colliders, type === 'dynamic' ? centerOfMass : 'colliders');
        const p = desc.position, q = desc.rotation;
        const motion = type === 'dynamic' ? J.EMotionType_Dynamic : type === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static;
        const group = desc.group ?? 1, mask = desc.mask ?? -1;
        const cs = new J.BodyCreationSettings(shape, this._rv3(p[0], p[1], p[2]), this._q4(q), motion, this._layer(group, mask));
        shape.Release();
        const lf = desc.linearFactor, af = desc.angularFactor;
        let dofs = 0;
        if (!lf || lf[0] !== 0) dofs |= J.EAllowedDOFs_TranslationX;
        if (!lf || lf[1] !== 0) dofs |= J.EAllowedDOFs_TranslationY;
        if (!lf || lf[2] !== 0) dofs |= J.EAllowedDOFs_TranslationZ;
        if (!af || af[0] !== 0) dofs |= J.EAllowedDOFs_RotationX;
        if (!af || af[1] !== 0) dofs |= J.EAllowedDOFs_RotationY;
        if (!af || af[2] !== 0) dofs |= J.EAllowedDOFs_RotationZ;
        const sensor = !!desc.sensor, friction = desc.friction ?? DEFAULT_FRICTION, restitution = desc.restitution ?? DEFAULT_RESTITUTION;
        // The engine puts bodies to sleep itself (its freeze); contact still wakes them.
        cs.mAllowSleeping = false;
        cs.mFriction = friction;
        cs.mRestitution = restitution;
        cs.mLinearDamping = dampingRate(desc.linearDamping ?? 0.01);
        cs.mAngularDamping = dampingRate(desc.angularDamping ?? 0.01);
        cs.mMaxLinearVelocity = MAX_LINEAR_VELOCITY;
        cs.mMaxAngularVelocity = MAX_ANGULAR_VELOCITY;
        cs.mAllowedDOFs = dofs;
        cs.mIsSensor = sensor;
        // A sensor sees static and sleeping bodies too, as a cannon trigger does.
        cs.mCollideKinematicVsNonDynamic = sensor;
        // A body sliding across two triangles is not bumped by the edge between them (cannon's heightfield
        // patch, Rapier's FIX_INTERNAL_EDGES).
        cs.mEnhancedInternalEdgeRemoval = type === 'dynamic';
        const mass = type === 'dynamic' ? desc.mass : 0;
        if (type === 'dynamic') {
            cs.mOverrideMassProperties = J.EOverrideMassProperties_MassAndInertiaProvided;
            const mp = this._massOf(cs.GetShape(), mass);
            cs.mMassPropertiesOverride = mp;
            J.destroy(mp);
        }
        let body: JoltNS.Body;
        if (nativeId === undefined) body = this._bi.CreateBody(cs);
        else {
            const id = new J.BodyID(nativeId);
            body = this._bi.CreateBodyWithID(id, cs);
            J.destroy(id);
        }
        J.destroy(cs);
        if (!body || J.getPointer(body) === 0) throw new Error(`physics: Jolt's world is full (${MAX_BODIES} bodies)`);
        this._bi.AddBody(body.GetID(), type === 'static' ? J.EActivation_DontActivate : J.EActivation_Activate);
        const handle = this._nextHandle++ as BodyHandle;
        const entry: Entry = {
            handle, body, id: body.GetID().GetIndexAndSequenceNumber(), ptr: J.getPointer(body), desc, configVersion: 0, type, mass, sensor, dofs,
            colliderDescs: colliders, centerOfMass, group, mask, response: desc.collisionResponse ?? true, reports: !!desc.reportContacts,
            friction, restitution, enabled: true, parts: null, radius: 0, written: null,
        };
        this._entries.set(handle, entry);
        this._byId.set(entry.id, entry);
        this._byPtr.set(entry.ptr, entry);
        this._order.push(handle);
        this._bodyList = null;
        this._version++;
        return handle;
    }

    private _entry(h: BodyHandle): Entry {
        const e = this._entries.get(h);
        if (!e) throw new Error(`physics: no body ${h} in this world`);
        return e;
    }

    private _removeFromOrder(h: BodyHandle): void {
        const i = this._order.indexOf(h);
        if (i >= 0) this._order.splice(i, 1);
        this._bodyList = null;
    }

    /** Drop a body's queued events and its pair counts: it left the world (or the simulation). */
    private _forget(h: BodyHandle): void {
        const events = this._events;
        let w = 0;
        for (let i = 0; i < events.length; i += 3) {
            if (events[i + 1] === h || events[i + 2] === h) continue;
            events[w++] = events[i]; events[w++] = events[i + 1]; events[w++] = events[i + 2];
        }
        events.length = w;
        const involves = (key: string) => { const [lo, hi] = key.split(',').map(Number); return lo === h || hi === h; };
        for (const [sub, pair] of [...this._live]) if (involves(pair)) this._live.delete(sub);
        for (const key of [...this._pairCounts.keys()]) if (involves(key)) this._pairCounts.delete(key);
    }

    private _bothEnabled(record: JoltJointRecord): boolean {
        return (this._entries.get(record.a)?.enabled ?? false) && (this._entries.get(record.b)?.enabled ?? false);
    }

    private _layer(group: number, mask: number): number {
        return this._J.ObjectLayerPairFilterMask.prototype.sGetObjectLayer(group & LAYER_BITS, mask & LAYER_BITS);
    }

    private _v3(x: number, y: number, z: number): JoltNS.Vec3 { this._vec.Set(x, y, z); return this._vec; }
    private _rv3(x: number, y: number, z: number): JoltNS.RVec3 { this._rvec.Set(x, y, z); return this._rvec; }
    private _q4(q: ArrayLike<number>): JoltNS.Quat { this._quat.Set(q[0], q[1], q[2], q[3]); return this._quat; }

    private _position(e: Entry): number[] { const p = e.body.GetPosition(); return [p.GetX(), p.GetY(), p.GetZ()]; }
    private _rotation(e: Entry): number[] { const q = e.body.GetRotation(); return [q.GetX(), q.GetY(), q.GetZ(), q.GetW()]; }

    /** A point measured from the body's centre of mass, in world space. */
    private _atCom(e: Entry, rel: ArrayLike<number>): JoltNS.RVec3 {
        const c = e.body.GetCenterOfMassPosition();
        return this._rv3(c.GetX() + rel[0], c.GetY() + rel[1], c.GetZ() + rel[2]);
    }

    /** Where Jolt keeps the body's centre of mass, in the body: what its joints are measured from. */
    private _shapeCom(e: Entry): number[] { const c = e.body.GetShape().GetCenterOfMass(); return [c.GetX(), c.GetY(), c.GetZ()]; }

    /**
     * The collider frame's origin in the body: the centre of mass of a dynamic body, the node origin of any
     * other (whose mass nothing moves), as on cannon.
     */
    private _localCom(e: Entry): number[] { return e.type === 'dynamic' ? this._shapeCom(e) : [0, 0, 0]; }

    /** A body's mass properties: its given mass, inertia from its shape (or a solid box's when it has no volume). */
    private _massOf(shape: JoltNS.Shape, mass: number): JoltNS.MassProperties {
        const J = this._J;
        const mp = new J.MassProperties();
        const measured = shape.GetMassProperties();
        if (measured.mMass > 0) {
            mp.mMass = measured.mMass;
            mp.mInertia = measured.mInertia;
        } else {
            // 0.1·m about each axis (Rapier's fallback): a solid box of side √0.6.
            const side = this._v3(Math.sqrt(0.6), Math.sqrt(0.6), Math.sqrt(0.6));
            mp.SetMassAndInertiaOfSolidBox(side, 1);
        }
        mp.ScaleToMass(mass > 0 ? mass : 1);
        return mp;
    }

    /** The body's mass made what it was given again, after its shape changed. */
    private _applyMass(e: Entry): void {
        const mp = this._massOf(e.body.GetShape(), e.mass);
        e.body.GetMotionProperties().SetMassProperties(e.dofs, mp);
        this._J.destroy(mp);
    }

    /**
     * One Jolt shape for a body's colliders (its reference taken: Release it once a body holds it). A collider
     * placed off the origin is a rotated-translated shape, several are a static compound; `'origin'` moves the
     * centre of mass to the node origin.
     */
    private _shape(colliders: readonly ColliderDesc[], centerOfMass: 'colliders' | 'origin'): JoltNS.Shape {
        const J = this._J;
        const built: { settings: JoltNS.ShapeSettings; offset: number[]; rotation: number[] }[] = [];
        for (const c of colliders) {
            const s = this._shapeSettings(c.shape);
            if (s) built.push({ settings: s, offset: [...(c.offset ?? [0, 0, 0])], rotation: [...(c.rotation ?? [0, 0, 0, 1])] });
        }
        let top: JoltNS.ShapeSettings;
        const placed = (b: typeof built[number]) => b.offset.some(v => v !== 0) || b.rotation[0] !== 0 || b.rotation[1] !== 0 || b.rotation[2] !== 0 || b.rotation[3] !== 1;
        if (built.length === 0) top = new J.EmptyShapeSettings();
        else if (built.length === 1 && !placed(built[0])) top = built[0].settings;
        else if (built.length === 1) {
            const b = built[0];
            top = new J.RotatedTranslatedShapeSettings(this._v3(b.offset[0], b.offset[1], b.offset[2]), this._q4(b.rotation), b.settings);
        } else {
            const compound = new J.StaticCompoundShapeSettings();
            for (const [i, b] of built.entries()) compound.AddShape(this._v3(b.offset[0], b.offset[1], b.offset[2]), this._q4(b.rotation), b.settings, i);
            top = compound;
        }
        if (centerOfMass === 'origin' && built.length > 0) {
            const inner = this._create_(top);
            const c = inner.GetCenterOfMass();
            const offset = new J.Vec3(-c.GetX(), -c.GetY(), -c.GetZ());
            inner.Release();
            top = new J.OffsetCenterOfMassShapeSettings(offset, top);
            J.destroy(offset);
        }
        const shape = this._create_(top);
        // The settings and those inside them (held by reference) go with the outermost.
        J.destroy(top);
        return shape;
    }

    /** Create a shape from settings, its reference taken. */
    private _create_(settings: JoltNS.ShapeSettings): JoltNS.Shape {
        const result = settings.Create();
        if (result.HasError()) {
            const message = result.GetError().c_str();
            result.Clear();
            throw new Error(`physics: Jolt could not build a shape: ${message}`);
        }
        const shape = result.Get();
        shape.AddRef();
        return shape;
    }

    /** Jolt's settings for a shape description (a heightfield laid out from its corner), or null for none. */
    private _shapeSettings(shape: ShapeDesc): JoltNS.ShapeSettings | null {
        const J = this._J;
        const rounded = (...sizes: number[]) => Math.max(0, Math.min(CONVEX_RADIUS, ...sizes.map(s => s * 0.5)));
        switch (shape.kind) {
            case 'sphere': return new J.SphereShapeSettings(shape.radius);
            case 'box': {
                const [x, y, z] = shape.halfExtents;
                return new J.BoxShapeSettings(this._v3(x, y, z), rounded(x, y, z));
            }
            case 'capsule': return shape.height > 0 ? new J.CapsuleShapeSettings(shape.height / 2, shape.radius) : new J.SphereShapeSettings(shape.radius);
            case 'cylinder': {
                const h = shape.height / 2, top = shape.radiusTop, bottom = shape.radiusBottom;
                if (top === bottom) return new J.CylinderShapeSettings(h, top, rounded(h, top));
                return new J.TaperedCylinderShapeSettings(h, top, bottom, rounded(h, top, bottom));
            }
            case 'convex': {
                const s = new J.ConvexHullShapeSettings();
                for (const v of shape.vertices) s.mPoints.push_back(this._v3(v[0], v[1], v[2]));
                return s;
            }
            case 'trimesh': {
                const sc = shape.scale ?? [1, 1, 1], p = shape.positions, idx = shape.indices;
                const vertices = new J.VertexList(), triangles = new J.IndexedTriangleList(), materials = new J.PhysicsMaterialList();
                const f = new J.Float3(0, 0, 0);
                for (let i = 0; i + 2 < p.length; i += 3) { f.x = p[i] * sc[0]; f.y = p[i + 1] * sc[1]; f.z = p[i + 2] * sc[2]; vertices.push_back(f); }
                for (let i = 0; i + 2 < idx.length; i += 3) {
                    const t = new J.IndexedTriangle(idx[i], idx[i + 1], idx[i + 2], 0);
                    triangles.push_back(t);
                    J.destroy(t);
                }
                const s = new J.MeshShapeSettings(vertices, triangles, materials);
                for (const o of [f, vertices, triangles, materials]) J.destroy(o);
                return s;
            }
            case 'heightfield': {
                // The layer's field starts at its corner and runs along +X (i) and −Z (j); Jolt's sample (x, z)
                // sits at offset + scale·(x, h, z), z along +Z, in a square: z = J−1−j from an offset of −(J−1)
                // cells, and the rest of the square is holes.
                const H = shape.heights, I = H.length, Jn = I ? H[0].length : 0, e = shape.elementSize;
                if (I < 2 || Jn < 2) return null;
                const N = Math.max(I, Jn);
                const s = new J.HeightFieldShapeSettings();
                s.mOffset = this._v3(0, 0, -(Jn - 1) * e);
                s.mScale = this._v3(e, 1, e);
                s.mSampleCount = N;
                const samples = s.mHeightSamples;
                samples.resize(N * N);
                const at = J.getPointer(samples.data()) >> 2, heap = J.HEAPF32;
                const hole = J.HeightFieldShapeConstantValues.prototype.get_cNoCollisionValue();
                for (let z = 0; z < N; z++) for (let x = 0; x < N; x++)
                    heap[at + z * N + x] = x < I && z < Jn ? H[x][Jn - 1 - z] : hole;
                return s;
            }
            case 'plane': {
                const plane = new J.Plane(this._v3(0, 1, 0), 0);
                const s = new J.PlaneShapeSettings(plane, undefined, PLANE_HALF_EXTENT);
                J.destroy(plane);
                return s;
            }
        }
    }

    /** The body's parts from its descriptions, placed from its collider frame, and its bounding radius. */
    private _buildParts(e: Entry): void {
        const c = this._localCom(e);
        let radius = 0;
        e.parts = [];
        for (const collider of e.colliderDescs) {
            const o = collider.offset ?? [0, 0, 0], r = collider.rotation ?? [0, 0, 0, 1];
            const boundingRadius = boundingRadiusOf(collider.shape);
            const offset: V3 = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
            e.parts.push({ shape: partShapeFor(collider.shape), offset, rotation: [r[0], r[1], r[2], r[3]], boundingRadius });
            radius = Math.max(radius, Math.hypot(offset[0], offset[1], offset[2]) + boundingRadius);
        }
        // Jolt keeps the centre of mass in single precision: a bound a hair wide of it still bounds.
        e.radius = radius * (1 + 1e-6) + 1e-6;
    }

    // ---- Jolt's callbacks ----

    /**
     * Point Jolt's callbacks at a world through a weak reference: the module keeps every object it made from
     * JavaScript, and a callback holding the world would keep it from being collected (and its Jolt objects
     * freed, see `collected`) when it is dropped without dispose. Static, so the closures hold nothing else.
     */
    private static _bind(J: Jolt, listener: JoltNS.ContactListenerJS, rays: JoltNS.BodyFilterJS, self: WeakRef<JoltWorld>): void {
        rays.ShouldCollide = (idPtr: number) => {
            const w = self.deref();
            return !!w && w._rayKeeps(w._byId.get(J.wrapPointer(idPtr, J.BodyID).GetIndexAndSequenceNumber()));
        };
        rays.ShouldCollideLocked = (bodyPtr: number) => { const w = self.deref(); return !!w && w._rayKeeps(w._byPtr.get(bodyPtr)); };
        listener.OnContactValidate = (b1: number, b2: number) => self.deref()?._validate(b1, b2) ?? J.ValidateResult_AcceptAllContactsForThisBodyPair;
        listener.OnContactAdded = (b1: number, b2: number, m: number, s: number) => self.deref()?._contact(b1, b2, m, s);
        listener.OnContactPersisted = (b1: number, b2: number, m: number, s: number) => self.deref()?._contact(b1, b2, m, s);
        listener.OnContactRemoved = (pair: number) => self.deref()?._removed(pair);
    }

    /** Whether a ray keeps a body, by the options of the ray being cast. */
    private _rayKeeps(e: Entry | undefined): boolean {
        if (!e) return false;
        const o = this._rayOptions;
        if (o.excludeDynamic && e.type === 'dynamic') return false;
        return !!o.includeNoResponse || e.response;
    }

    private _validate(b1: number, b2: number): number {
        const J = this._J;
        if (this._noCollide.size > 0) {
            const a = this._byPtr.get(b1), b = this._byPtr.get(b2);
            if (a && b && this._noCollide.has(pairKey(a.handle, b.handle))) return J.ValidateResult_RejectAllContactsForThisBodyPair;
        }
        return J.ValidateResult_AcceptAllContactsForThisBodyPair;
    }

    /** A contact found this step (added, or persisting from the last): settings, the contact row, and events. */
    private _contact(b1: number, b2: number, manifold: number, settings: number): void {
        const J = this._J;
        const a = this._byPtr.get(b1), b = this._byPtr.get(b2);
        if (!a || !b) return;
        const s = J.wrapPointer(settings, J.ContactSettings);
        // cannon's surfaces: friction combines with the smaller, restitution with the larger.
        s.mCombinedFriction = Math.min(a.friction, b.friction);
        s.mCombinedRestitution = Math.max(a.restitution, b.restitution);
        // A body without collision response touches and reports, but pushes nothing.
        if (!a.response || !b.response) s.mIsSensor = true;
        const sensor = a.sensor || b.sensor;
        const m = J.wrapPointer(manifold, J.ContactManifold);
        if (!sensor && (a.type === 'dynamic' || b.type === 'dynamic')) {
            const n = m.mWorldSpaceNormal;
            this._rows.push(a.handle, b.handle, n.GetX(), n.GetY(), n.GetZ());
        }
        if (!sensor && !a.reports && !b.reports) return;
        // Sensor against sensor is the engine's own pass (triggerOverlaps.ts), as on cannon.
        if (a.sensor && b.sensor) return;
        // A sub-shape pair seen for the first time begins (a persisting one too: its body was taken out and
        // put back since, which forgot it).
        const sub = subPairKey(a.id, m.mSubShapeID1.GetValue(), b.id, m.mSubShapeID2.GetValue());
        if (this._live.has(sub)) return;
        const pair = pairKey(a.handle, b.handle);
        this._live.set(sub, pair);
        const count = this._pairCounts.get(pair);
        if (count) { count.n++; return; }
        this._pairCounts.set(pair, { n: 1, a: a.handle, b: b.handle });
        if (sensor) this._events.push(PhysicsEventKind.SensorBegin, a.handle, b.handle);
        else {
            if (a.reports) this._events.push(PhysicsEventKind.ContactBegin, a.handle, b.handle);
            if (b.reports) this._events.push(PhysicsEventKind.ContactBegin, b.handle, a.handle);
        }
    }

    /** A contact gone this step (also a body's that left: by BodyID, so one reusing its index is not it). */
    private _removed(pairPtr: number): void {
        const J = this._J;
        const p = J.wrapPointer(pairPtr, J.SubShapeIDPair);
        const sub = subPairKey(p.GetBody1ID().GetIndexAndSequenceNumber(), p.GetSubShapeID1().GetValue(), p.GetBody2ID().GetIndexAndSequenceNumber(), p.GetSubShapeID2().GetValue());
        const pair = this._live.get(sub);
        if (pair === undefined) return;
        this._live.delete(sub);
        const count = this._pairCounts.get(pair);
        if (!count) return;
        if (--count.n > 0) return;
        this._pairCounts.delete(pair);
        const a = this._entries.get(count.a), b = this._entries.get(count.b);
        if (a && b && (a.sensor || b.sensor)) this._events.push(PhysicsEventKind.SensorEnd, count.a, count.b);
    }
}

/** A body pair, by handle, either way round. */
function pairKey(a: number, b: number): string { return a < b ? `${a},${b}` : `${b},${a}`; }

/** A sub-shape pair (BodyID and sub-shape id of each), either way round. */
function subPairKey(idA: number, subA: number, idB: number, subB: number): string {
    return idA < idB ? `${idA}:${subA},${idB}:${subB}` : `${idB}:${subB},${idA}:${subA}`;
}
