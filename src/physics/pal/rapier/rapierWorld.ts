import type { Collider, ColliderDesc as RColliderDesc, EventQueue, ImpulseJoint, RigidBody, World } from '@dimforge/rapier3d-compat';
import type { PhysicsCapabilities } from '../capabilities';
import { PhysicsEventKind } from '../types';
import type {
    BodyDesc, BodyHandle, BodyType, ColliderDesc, ColliderPart, JointDesc, JointHandle, MassProperties, Out,
    RayHit, RayOptions, ShapeDesc, StepProfile, V3,
} from '../types';
import type { DescribedWorld } from '../copy/describedWorld';
import { boundingRadiusOf, collidersAabb, multiply, partShapeFor, rotate } from '../shapeBounds';
import { fromX, matchedFrame } from '../jointFrames';
import { rapier } from './load';

// The Rapier backend (@dimforge/rapier3d-compat, see docs/reference/physics-backends.md for what its spike
// found). Every layer convention holds as on cannon:
//  - a handle is this world's own increasing integer (Rapier's handles pack an index and a generation into
//    a float, which the engine's pair keys cannot take);
//  - a body's position is its node origin, which is Rapier's own body translation; its collider frame is
//    the centre of mass (the node origin for a body that does not move), so buoyancy, the ground probe and
//    the worker's drawing measure what they did;
//  - a force lasts one substep (Rapier keeps them: reset after every step);
//  - queries see the world as it is now: Rapier refits its query tree only inside a step, so after a body is
//    added, moved or turned, two zero-length steps refit it first (they move nothing);
//  - events come per BODY pair (Rapier's are per collider), in the order they happened.

const DEFAULT_FRICTION = 0.3;
const DEFAULT_RESTITUTION = 0;
const LAYER_BITS = 0xFFFF;

export const RAPIER_CAPABILITIES: PhysicsCapabilities = {
    backend: 'rapier',
    nativeCapsule: true,
    collisionGroupBits: 16,
    fractionalAxisFactors: false,
    jointMaxForce: false,
    coneLimit: 'approximate',
    manualSleep: true,
    profilePhases: ['broadphase', 'narrowphase', 'solve'],
    threadable: true,
    precision: 32,
};

/** Rapier's interaction groups: 16 bits of membership over 16 of filter. */
const groupsOf = (group: number, mask: number): number => ((((group & LAYER_BITS) << 16) | (mask & LAYER_BITS)) >>> 0);

/** cannon's damping, `v *= (1 − d)^dt`, as Rapier's rate `c` in `v *= 1 / (1 + c·dt)`: the same decay for small dt. */
function dampingRate(d: number): number {
    if (!(d > 0)) return 0;
    if (d >= 1) return 1e6;
    return -Math.log(1 - d);
}

/**
 * A joint as built, from which a copy (the physics worker's, replica.ts) builds the same joint whatever the
 * bodies' poses are then: the frames a fixed or cone-twist joint measured from the poses it was made in are
 * kept, not measured again.
 */
export type RapierJointRecord = { a: BodyHandle; b: BodyHandle; collideConnected: boolean } & (
    /** A's origin and frame, seen from B. */
    | { kind: 'fixed'; anchorB: number[]; frameB: number[] }
    | { kind: 'ball'; anchorA: number[]; anchorB: number[] }
    | { kind: 'hinge'; anchorA: number[]; anchorB: number[]; axisA: number[]; axisB: number[] }
    | { kind: 'cone'; anchorA: number[]; anchorB: number[]; frameA: number[]; frameB: number[]; twist: number; cone: number }
);

interface Entry {
    readonly handle: BodyHandle;
    readonly body: RigidBody;
    /** What it was made from; the fields below follow later changes. */
    readonly desc: BodyDesc;
    /** Bumped by every change to what it is made of (colliders, layers, response, reporting): what a copy diffs by. */
    configVersion: number;
    readonly type: BodyType;
    readonly mass: number;
    readonly sensor: boolean;
    colliderDescs: readonly ColliderDesc[];
    centerOfMass: 'colliders' | 'origin';
    colliders: Collider[];
    group: number;
    mask: number;
    response: boolean;
    reports: boolean;
    friction: number;
    restitution: number;
    enabled: boolean;
    parts: ColliderPart[] | null;
    radius: number;
    /**
     * The rotation last given to setTransform, as given: Rapier renormalises what it is set to, and a copy
     * given the renormalised one would renormalise it again, which can move a bit the original never moved.
     */
    written: number[] | null;
}

export class RapierWorld implements DescribedWorld<RapierJointRecord> {
    public readonly backend = 'rapier' as const;
    public readonly capabilities = RAPIER_CAPABILITIES;
    public onPreSubstep: ((dt: number) => void) | null = null;
    public profile = false;

    /** The Rapier world itself. */
    private _raw: World;
    private readonly _queue: EventQueue;
    private _time = 0;
    private _version = 0;
    private _nextHandle = 1;
    private _nextJoint = 1;
    private readonly _entries = new Map<number, Entry>();
    /** Enabled bodies in the world's order: creation order, a re-enabled body last. */
    private readonly _order: BodyHandle[] = [];
    private _bodyList: BodyHandle[] | null = null;
    /** Rapier collider handle → the body handle it belongs to. */
    private readonly _owner = new Map<number, BodyHandle>();
    private readonly _joints = new Map<number, { joint: ImpulseJoint; record: RapierJointRecord }>();
    /** Queued events: [kind, a, b] per event. */
    private _events: number[] = [];
    /** Overlapping collider pairs per body pair ("lo,hi"): a pair begins on the first and ends on the last. */
    private readonly _pairCounts = new Map<string, number>();
    /** Bodies a force or torque was applied to since the last step (Rapier keeps them: reset after it). */
    private readonly _forced = new Set<Entry>();
    /** Something moved since the query tree was refitted (see _syncQueries). */
    private _dirty = true;
    /** The last step's contacts, [a, b, nx, ny, nz] per contact, gathered on first read. */
    private _contacts: number[] | null = null;
    private readonly _profile: StepProfile = { broadphaseMs: 0, narrowphaseMs: 0, solveMs: 0, integrateMs: 0 };
    private readonly _hit: RayHit = { body: 0 as BodyHandle, point: [0, 0, 0], normal: [0, 0, 0], distance: 0 };
    private readonly _v = [0, 0, 0];

    constructor(gravity: ArrayLike<number> = [0, -9.81, 0]) {
        const R = rapier();
        this._raw = new R.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
        this._queue = new R.EventQueue(true);
    }

    /** The Rapier world, for this backend's own worker copy. */
    public get raw(): World { return this._raw; }

    // ---- world ----

    public get time(): number { return this._time; }
    public set time(t: number) { this._time = t; }

    public get gravity(): V3 { const g = this._raw.gravity; return [g.x, g.y, g.z]; }
    public set gravity(g: V3) { this._raw.gravity = { x: g[0], y: g[1], z: g[2] }; }

    public get solverIterations(): number { return this._raw.numSolverIterations; }
    public set solverIterations(n: number) { if (n > 0) this._raw.numSolverIterations = n; }

    public get stateVersion(): number { return this._version; }

    // ---- bodies ----

    public createBody(desc: BodyDesc): BodyHandle {
        const R = rapier();
        const type: BodyType = desc.type ?? (desc.mass > 0 ? 'dynamic' : 'static');
        const p = desc.position, q = desc.rotation;
        const rb = (type === 'dynamic' ? R.RigidBodyDesc.dynamic() : type === 'kinematic' ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.fixed())
            .setTranslation(p[0], p[1], p[2])
            .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
            // The engine puts bodies to sleep itself (its freeze); contact still wakes them.
            .setCanSleep(false)
            .setLinearDamping(dampingRate(desc.linearDamping ?? 0.01))
            .setAngularDamping(dampingRate(desc.angularDamping ?? 0.01));
        const lf = desc.linearFactor, af = desc.angularFactor;
        if (lf) rb.enabledTranslations(lf[0] !== 0, lf[1] !== 0, lf[2] !== 0);
        if (af) rb.enabledRotations(af[0] !== 0, af[1] !== 0, af[2] !== 0);
        const handle = this._nextHandle++ as BodyHandle;
        const entry: Entry = {
            handle, body: this._raw.createRigidBody(rb), desc, configVersion: 0, type, mass: type === 'dynamic' ? desc.mass : 0, sensor: !!desc.sensor,
            colliderDescs: [...desc.colliders], centerOfMass: desc.centerOfMass ?? 'colliders', colliders: [],
            group: desc.group ?? 1, mask: desc.mask ?? -1, response: desc.collisionResponse ?? true, reports: !!desc.reportContacts,
            friction: desc.friction ?? DEFAULT_FRICTION, restitution: desc.restitution ?? DEFAULT_RESTITUTION,
            enabled: true, parts: null, radius: 0, written: null,
        };
        this._entries.set(handle, entry);
        this._attach(entry);
        this._order.push(handle);
        this._bodyList = null;
        this._version++;
        return handle;
    }

    public destroyBody(h: BodyHandle): void {
        const e = this._entries.get(h);
        if (!e) return;
        for (const c of e.colliders) this._owner.delete(c.handle);
        // Rapier removes a body's joints with it.
        for (const [id, j] of this._joints) if (j.record.a === h || j.record.b === h) this._joints.delete(id);
        this._raw.removeRigidBody(e.body);
        this._entries.delete(h);
        this._forced.delete(e);
        this._removeFromOrder(h);
        this._forget(h);
        this._dirty = true;
        this._version++;
    }

    public hasBody(h: BodyHandle): boolean { return this._entries.has(h); }

    public setEnabled(h: BodyHandle, enabled: boolean): void {
        const e = this._entries.get(h);
        if (!e || e.enabled === enabled) return;
        e.enabled = enabled;
        e.body.setEnabled(enabled);
        if (enabled) { this._order.push(h); this._bodyList = null; }
        else { this._removeFromOrder(h); this._forget(h); }
        this._dirty = true;
    }

    public isEnabled(h: BodyHandle): boolean { return this._entries.get(h)?.enabled ?? false; }

    public bodies(): readonly BodyHandle[] { return this._bodyList ??= this._order.slice(); }

    public get bodyCount(): number { return this._order.length; }

    public setColliders(h: BodyHandle, colliders: readonly ColliderDesc[], centerOfMass?: 'colliders' | 'origin'): void {
        const e = this._entry(h);
        if (centerOfMass) e.centerOfMass = centerOfMass;
        // The same colliders (recentring the mass): only the mass moves. Rebuilding them would change the
        // world's history for nothing, and a copy built in one go would no longer step like it.
        const same = colliders.length === e.colliderDescs.length && colliders.every((c, i) => c === e.colliderDescs[i]);
        e.colliderDescs = [...colliders];
        if (same) { this._applyMass(e); e.parts = null; } else this._attach(e);
        e.configVersion++;
        this._version++;
    }

    public setCollisionFilter(h: BodyHandle, group: number, mask: number): void {
        const e = this._entry(h);
        e.group = group; e.mask = mask;
        for (const c of e.colliders) { c.setCollisionGroups(groupsOf(group, mask)); c.setSolverGroups(this._solverGroups(e)); }
        e.configVersion++;
    }

    public setCollisionResponse(h: BodyHandle, response: boolean): void {
        const e = this._entry(h);
        e.response = response;
        for (const c of e.colliders) c.setSolverGroups(this._solverGroups(e));
        e.configVersion++;
    }

    public setReportContacts(h: BodyHandle, report: boolean): void {
        const e = this._entry(h);
        e.reports = report;
        const events = this._events_of(e);
        for (const c of e.colliders) c.setActiveEvents(events);
        e.configVersion++;
    }

    public getMassProperties(h: BodyHandle, out: MassProperties): MassProperties {
        const e = this._entry(h), b = e.body;
        out.mass = e.type === 'dynamic' ? b.mass() : 0;
        const c = b.localCom(), i = b.principalInertia();
        out.centerOfMass[0] = c.x; out.centerOfMass[1] = c.y; out.centerOfMass[2] = c.z;
        out.inertia[0] = i.x; out.inertia[1] = i.y; out.inertia[2] = i.z;
        return out;
    }

    public getTransform(h: BodyHandle, out: Out): void {
        const b = this._entry(h).body, t = b.translation(), q = b.rotation();
        out[0] = t.x; out[1] = t.y; out[2] = t.z; out[3] = q.x; out[4] = q.y; out[5] = q.z; out[6] = q.w;
    }

    public setTransform(h: BodyHandle, position: ArrayLike<number> | null, rotation: ArrayLike<number> | null): void {
        const e = this._entry(h), b = e.body;
        if (position) b.setTranslation({ x: position[0], y: position[1], z: position[2] }, false);
        if (rotation) {
            b.setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] }, false);
            e.written = [rotation[0], rotation[1], rotation[2], rotation[3]];
        }
        this._dirty = true;
        this._version++;
    }

    public getVelocity(h: BodyHandle, out: Out): void {
        const b = this._entry(h).body, v = b.linvel(), w = b.angvel();
        out[0] = v.x; out[1] = v.y; out[2] = v.z; out[3] = w.x; out[4] = w.y; out[5] = w.z;
    }

    // Writing a velocity does not wake a body: the engine wakes what it means to (as on cannon).
    public setLinearVelocity(h: BodyHandle, x: number, y: number, z: number): void {
        this._entry(h).body.setLinvel({ x, y, z }, false);
        this._version++;
    }

    public setAngularVelocity(h: BodyHandle, x: number, y: number, z: number): void {
        this._entry(h).body.setAngvel({ x, y, z }, false);
        this._version++;
    }

    public applyImpulse(h: BodyHandle, impulse: ArrayLike<number>, relativePoint?: ArrayLike<number>): void {
        const b = this._entry(h).body, j = { x: impulse[0], y: impulse[1], z: impulse[2] };
        if (relativePoint) b.applyImpulseAtPoint(j, this._atCom(b, relativePoint), true);
        else b.applyImpulse(j, true);
        this._version++;
    }

    public applyForce(h: BodyHandle, force: ArrayLike<number>, relativePoint?: ArrayLike<number>): void {
        const e = this._entry(h), f = { x: force[0], y: force[1], z: force[2] };
        if (relativePoint) e.body.addForceAtPoint(f, this._atCom(e.body, relativePoint), true);
        else e.body.addForce(f, true);
        this._forced.add(e);
    }

    public clearForces(h: BodyHandle): void {
        const e = this._entry(h);
        e.body.resetForces(false);
        e.body.resetTorques(false);
        this._forced.delete(e);
    }

    public sleep(h: BodyHandle): void { this._entry(h).body.sleep(); }
    public wakeUp(h: BodyHandle): void { this._entry(h).body.wakeUp(); }
    public isSleeping(h: BodyHandle): boolean { return this._entry(h).body.isSleeping(); }

    public getAabb(h: BodyHandle, out: Out): void {
        const e = this._entry(h), t = e.body.translation(), q = e.body.rotation();
        collidersAabb(e.colliderDescs, [t.x, t.y, t.z, q.x, q.y, q.z, q.w], out);
    }

    public colliderParts(h: BodyHandle): readonly ColliderPart[] {
        const e = this._entry(h);
        if (!e.parts) this._buildParts(e);
        return e.parts!;
    }

    public getColliderFrame(h: BodyHandle, out: Out): number {
        const e = this._entry(h), c = e.type === 'dynamic' ? e.body.worldCom() : e.body.translation(), q = e.body.rotation();
        out[0] = c.x; out[1] = c.y; out[2] = c.z; out[3] = q.x; out[4] = q.y; out[5] = q.z; out[6] = q.w;
        if (!e.parts) this._buildParts(e);
        return e.radius;
    }

    public colliderFrameToOrigin(h: BodyHandle, pose: ArrayLike<number>, out: Out): void {
        const c = this._localCom(this._entry(h)), v = this._v;
        rotate([pose[3], pose[4], pose[5], pose[6]], c.x, c.y, c.z, v);
        out[0] = pose[0] - v[0]; out[1] = pose[1] - v[1]; out[2] = pose[2] - v[2];
    }

    // ---- joints ----

    public createJoint(desc: JointDesc): JointHandle {
        const a = this._entry(desc.a).body, b = this._entry(desc.b).body;
        const v = (x: V3) => [x[0], x[1], x[2]];
        const collideConnected = !!desc.collideConnected;
        let record: RapierJointRecord;
        switch (desc.kind) {
            case 'fixed': {
                // Hold the pose the two have now: A's origin and frame, seen from B.
                const ta = a.translation(), qa = a.rotation(), tb = b.translation(), qb = b.rotation();
                const inv = [-qb.x, -qb.y, -qb.z, qb.w], d = [0, 0, 0], frame = [0, 0, 0, 1];
                rotate(inv, ta.x - tb.x, ta.y - tb.y, ta.z - tb.z, d);
                multiply(inv, [qa.x, qa.y, qa.z, qa.w], frame);
                record = { kind: 'fixed', a: desc.a, b: desc.b, collideConnected, anchorB: d, frameB: frame };
                break;
            }
            case 'ball':
                record = { kind: 'ball', a: desc.a, b: desc.b, collideConnected, anchorA: v(desc.anchorA), anchorB: v(desc.anchorB) };
                break;
            case 'hinge':
                record = { kind: 'hinge', a: desc.a, b: desc.b, collideConnected, anchorA: v(desc.anchorA), anchorB: v(desc.anchorB), axisA: v(desc.axisA), axisB: v(desc.axisB) };
                break;
            case 'coneTwist': {
                // A spherical joint whose frames put each body's axis on the joint's X: twist is about X, the
                // cone is a swing limit on Y and Z (a box of swing rather than a cone: 'approximate'). B's
                // frame takes its roll about the axis from A's as the two stand now, so the twist is measured
                // from the pose the joint is made in: two frames rolled apart at the start would read as a
                // twist past a tight limit, which the solver fights for as long as the joint lives.
                const qa = a.rotation(), qb = b.rotation();
                const frameA = fromX(desc.axisA), frameB = matchedFrame([qa.x, qa.y, qa.z, qa.w], frameA, [qb.x, qb.y, qb.z, qb.w], desc.axisB);
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
    public createJointFromRecord(record: RapierJointRecord): JointHandle {
        const R = rapier();
        const a = this._entry(record.a).body, b = this._entry(record.b).body;
        const v = (x: number[]) => ({ x: x[0], y: x[1], z: x[2] });
        const q = (x: number[]) => ({ x: x[0], y: x[1], z: x[2], w: x[3] });
        let joint: ImpulseJoint;
        switch (record.kind) {
            case 'fixed':
                joint = this._raw.createImpulseJoint(R.JointData.fixed({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, v(record.anchorB), q(record.frameB)), a, b, true);
                break;
            case 'ball':
                joint = this._raw.createImpulseJoint(R.JointData.spherical(v(record.anchorA), v(record.anchorB)), a, b, true);
                break;
            case 'hinge':
                joint = this._raw.createImpulseJoint(R.JointData.revoluteWithAxes(v(record.anchorA), v(record.anchorB), v(record.axisA), v(record.axisB)), a, b, true);
                break;
            case 'cone': {
                joint = this._raw.createImpulseJoint(R.JointData.spherical(v(record.anchorA), v(record.anchorB)), a, b, true);
                joint.setFrameX1(q(record.frameA));
                joint.setFrameX2(q(record.frameB));
                const raw = (joint as unknown as { rawSet: { jointSetLimits(h: number, axis: number, min: number, max: number): void } }).rawSet;
                raw.jointSetLimits(joint.handle, R.JointAxis.AngX, -record.twist, record.twist);
                raw.jointSetLimits(joint.handle, R.JointAxis.AngY, -record.cone, record.cone);
                raw.jointSetLimits(joint.handle, R.JointAxis.AngZ, -record.cone, record.cone);
                break;
            }
        }
        joint.setContactsEnabled(record.collideConnected);
        const id = this._nextJoint++;
        this._joints.set(id, { joint, record });
        return id as JointHandle;
    }

    public destroyJoint(j: JointHandle): void {
        const entry = this._joints.get(j);
        if (!entry) return;
        if (entry.joint.isValid()) this._raw.removeImpulseJoint(entry.joint, true);
        this._joints.delete(j);
    }

    // ---- the step ----

    public step(dt: number): void {
        this.onPreSubstep?.(dt);
        const w = this._raw;
        w.timestep = dt;
        w.profilerEnabled = this.profile;
        w.step(this._queue);
        this._drainCollisions();
        for (const e of this._forced) { e.body.resetForces(false); e.body.resetTorques(false); }
        this._forced.clear();
        if (this.profile) {
            this._profile.broadphaseMs += w.timingBroadPhase();
            this._profile.narrowphaseMs += w.timingNarrowPhase();
            this._profile.solveMs += w.timingSolver();
        }
        this._time += dt;
        this._contacts = null;
        this._dirty = false;
        this._version++;
    }

    public readProfile(out: StepProfile): void {
        const p = this._profile;
        out.broadphaseMs += p.broadphaseMs; out.narrowphaseMs += p.narrowphaseMs;
        out.solveMs += p.solveMs; out.integrateMs += p.integrateMs;
        p.broadphaseMs = p.narrowphaseMs = p.solveMs = p.integrateMs = 0;
    }

    public forEachContact(visit: (a: BodyHandle, b: BodyHandle, nx: number, ny: number, nz: number) => void): void {
        const rows = this._contactRows();
        for (let i = 0; i < rows.length; i += 5) visit(rows[i] as BodyHandle, rows[i + 1] as BodyHandle, rows[i + 2], rows[i + 3], rows[i + 4]);
    }

    public get contactCount(): number { return this._contactRows().length / 5; }

    public drainEvents(visit: (kind: PhysicsEventKind, a: BodyHandle, b: BodyHandle) => void): void {
        const events = this._events;
        if (events.length === 0) return;
        this._events = [];
        for (let i = 0; i < events.length; i += 3) visit(events[i] as PhysicsEventKind, events[i + 1] as BodyHandle, events[i + 2] as BodyHandle);
    }

    // ---- queries ----

    public raycast(from: ArrayLike<number>, to: ArrayLike<number>, options: RayOptions, onHit: (hit: RayHit) => void): void {
        const R = rapier();
        this._syncQueries();
        const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
        const length = Math.hypot(dx, dy, dz);
        if (!(length > 0)) return;
        const ray = new R.Ray({ x: from[0], y: from[1], z: from[2] }, { x: dx / length, y: dy / length, z: dz / length });
        const flags = options.excludeDynamic ? R.QueryFilterFlags.EXCLUDE_DYNAMIC : undefined;
        // Bodies with collisionResponse off are skipped unless asked for, as cannon's rays skip them.
        const predicate = options.includeNoResponse ? undefined : (collider: Collider) => {
            const owner = this._owner.get(collider.handle);
            return owner !== undefined && (this._entries.get(owner)?.response ?? false);
        };
        const hit = this._hit;
        const report = (collider: Collider, toi: number, n: { x: number; y: number; z: number }): void => {
            const owner = this._owner.get(collider.handle);
            if (owner === undefined) return;
            hit.body = owner;
            hit.point[0] = from[0] + ray.dir.x * toi; hit.point[1] = from[1] + ray.dir.y * toi; hit.point[2] = from[2] + ray.dir.z * toi;
            hit.normal[0] = n.x; hit.normal[1] = n.y; hit.normal[2] = n.z;
            hit.distance = toi;
            onHit(hit);
        };
        // Not solid: a ray that starts inside a shape hits its surface on the way out, as on cannon, never at 0.
        // Groups 0xFFFFFFFF skip a collider whose filter is 0, as a cannon ray skips a body whose mask is.
        if (options.mode === 'closest') {
            const r = this._raw.castRayAndGetNormal(ray, length, false, flags, 0xFFFFFFFF, undefined, undefined, predicate);
            if (r) report(r.collider, r.timeOfImpact, r.normal);
            return;
        }
        this._raw.intersectionsWithRay(ray, length, false, i => { report(i.collider, i.timeOfImpact, i.normal); return true; },
            flags, 0xFFFFFFFF, undefined, undefined, predicate);
    }

    public clear(): void {
        const R = rapier();
        const g = this._raw.gravity, iterations = this._raw.numSolverIterations;
        this._raw.free();
        this._raw = new R.World({ x: g.x, y: g.y, z: g.z });
        this._raw.numSolverIterations = iterations;
        this._entries.clear();
        this._order.length = 0;
        this._bodyList = null;
        this._owner.clear();
        this._joints.clear();
        this._events = [];
        this._pairCounts.clear();
        this._forced.clear();
        this._contacts = null;
        this._dirty = true;
        this._version++;
    }

    public dispose(): void {
        this.clear();
        this._raw.free();
        this._queue.free();
        this.onPreSubstep = null;
    }

    // ---- for the copy in the physics worker (copy/describedMirror.ts, describedReplica.ts) ----

    /** What a body is made of now, as a description a copy can build it from (at its current pose). */
    public descOf(h: BodyHandle): BodyDesc {
        const e = this._entry(h), t = e.body.translation(), q = e.body.rotation();
        return {
            ...e.desc,
            position: [t.x, t.y, t.z], rotation: [q.x, q.y, q.z, q.w],
            colliders: e.colliderDescs, centerOfMass: e.centerOfMass,
            group: e.group, mask: e.mask, collisionResponse: e.response, reportContacts: e.reports,
        };
    }

    /** Bumped by every change to what the body is made of. */
    public configVersionOf(h: BodyHandle): number { return this._entry(h).configVersion; }

    /**
     * The rotation last given to setTransform, as given (see Entry.written), and forget it: what a copy is
     * sent instead of the renormalised one. Null when none was given since the last call.
     */
    public takeWrittenRotation(h: BodyHandle): number[] | null {
        const e = this._entry(h), r = e.written;
        e.written = null;
        return r;
    }

    /** The joints, with what they were built from. */
    public jointRecords(): IterableIterator<[number, { readonly record: RapierJointRecord }]> { return this._joints.entries(); }

    /** The force and torque applied since the last step, [fx fy fz tx ty tz] into `out` (they act in the next). */
    public pendingForces(h: BodyHandle, out: Out): void {
        const b = this._entry(h).body, f = b.userForce(), t = b.userTorque();
        out[0] = f.x; out[1] = f.y; out[2] = f.z; out[3] = t.x; out[4] = t.y; out[5] = t.z;
    }

    /** A torque acting over the next substep. */
    public addTorque(h: BodyHandle, x: number, y: number, z: number): void {
        const e = this._entry(h);
        e.body.addTorque({ x, y, z }, true);
        this._forced.add(e);
    }

    /** Queue an event a step elsewhere raised (the worker's, landing through mirror.ts): drainEvents delivers it. */
    public raise(kind: PhysicsEventKind, a: BodyHandle, b: BodyHandle): void { this._events.push(kind, a, b); }

    /** The bodies were written from elsewhere (the worker's step landing): state caches and queries must catch up. */
    public touch(): void {
        this._version++;
        this._dirty = true;
        this._contacts = null;
    }

    /** Whether the body is dynamic (what a copy reports back). */
    public isDynamic(h: BodyHandle): boolean { return this._entry(h).type === 'dynamic'; }

    /** A dynamic body as water reads it, or undefined for any other body. */
    public floaterOf(h: BodyHandle): { mass: number; isTrigger: boolean; collisionResponse: boolean; character: boolean } | undefined {
        const e = this._entry(h);
        if (e.type !== 'dynamic') return undefined;
        return { mass: e.mass, isTrigger: e.sensor, collisionResponse: e.response, character: ((e.desc.userData ?? 0) & 1) !== 0 };
    }

    // ---- internals ----

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
        for (const key of [...this._pairCounts.keys()]) {
            const [lo, hi] = key.split(',').map(Number);
            if (lo === h || hi === h) this._pairCounts.delete(key);
        }
    }

    /** A point measured from the body's centre of mass, in world space. */
    private _atCom(b: RigidBody, rel: ArrayLike<number>): { x: number; y: number; z: number } {
        const c = b.worldCom();
        return { x: c.x + rel[0], y: c.y + rel[1], z: c.z + rel[2] };
    }

    private _solverGroups(e: Entry): number { return e.response ? groupsOf(e.group, e.mask) : groupsOf(e.group, 0); }

    private _events_of(e: Entry): number {
        const R = rapier();
        return e.sensor || e.reports ? R.ActiveEvents.COLLISION_EVENTS : R.ActiveEvents.NONE;
    }

    /** (Re)build a body's colliders from its descriptions, and its mass. */
    private _attach(e: Entry): void {
        const R = rapier();
        for (const c of e.colliders) { this._owner.delete(c.handle); this._raw.removeCollider(c, false); }
        e.colliders = [];
        const groups = groupsOf(e.group, e.mask), solver = this._solverGroups(e), events = this._events_of(e);
        for (const collider of e.colliderDescs) {
            const built = colliderDescFor(collider.shape);
            if (!built) continue;
            const o = collider.offset ?? [0, 0, 0], r = collider.rotation ?? [0, 0, 0, 1];
            // The shape's own placement (a heightfield's centre) inside the collider, then the collider's.
            const inner = rotate(r, built.inner[0], built.inner[1], built.inner[2], [0, 0, 0]);
            built.desc
                .setTranslation(o[0] + inner[0], o[1] + inner[1], o[2] + inner[2])
                .setRotation({ x: r[0], y: r[1], z: r[2], w: r[3] })
                .setFriction(e.friction).setFrictionCombineRule(R.CoefficientCombineRule.Min)
                .setRestitution(e.restitution).setRestitutionCombineRule(R.CoefficientCombineRule.Max)
                .setSensor(e.sensor)
                .setCollisionGroups(groups).setSolverGroups(solver)
                .setActiveEvents(events)
                .setDensity(1);
            if (e.sensor) built.desc.setActiveCollisionTypes(R.ActiveCollisionTypes.DEFAULT | R.ActiveCollisionTypes.KINEMATIC_FIXED);
            const c = this._raw.createCollider(built.desc, e.body);
            e.colliders.push(c);
            this._owner.set(c.handle, e.handle);
        }
        this._applyMass(e);
        e.parts = null;
        this._contacts = null;
        this._dirty = true;
    }

    /**
     * The body's mass is the one it was given, wherever its colliders' volume puts it: measured from the
     * colliders at density 1 (their centre of mass and inertia), then set explicitly with the colliders
     * weightless. `'origin'` keeps the mass at the node origin instead.
     */
    private _applyMass(e: Entry): void {
        const b = e.body;
        if (e.type !== 'dynamic') return;
        // Measured afresh: the colliders' own mass at density 1, with nothing left of the last time.
        b.setAdditionalMassProperties(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, false);
        for (const c of e.colliders) c.setDensity(1);
        b.recomputeMassPropertiesFromColliders();
        const measured = b.mass();
        const com = e.centerOfMass === 'origin' ? { x: 0, y: 0, z: 0 } : b.localCom();
        let inertia = { x: 0.1 * e.mass, y: 0.1 * e.mass, z: 0.1 * e.mass };
        let frame = { x: 0, y: 0, z: 0, w: 1 };
        if (measured > 0) {
            const s = e.mass / measured, i = b.principalInertia();
            inertia = { x: i.x * s, y: i.y * s, z: i.z * s };
            frame = b.principalInertiaLocalFrame();
        }
        for (const c of e.colliders) c.setDensity(0);
        b.setAdditionalMassProperties(e.mass, com, inertia, frame, false);
        b.recomputeMassPropertiesFromColliders();
    }

    /**
     * The collider frame's origin in the body: the centre of mass of a dynamic body, the node origin of any
     * other (whose mass nothing moves), as on cannon.
     */
    private _localCom(e: Entry): { x: number; y: number; z: number } {
        return e.type === 'dynamic' ? e.body.localCom() : { x: 0, y: 0, z: 0 };
    }

    /** The body's parts from its descriptions, placed from its collider frame, and its bounding radius. */
    private _buildParts(e: Entry): void {
        const c = this._localCom(e);
        let radius = 0;
        e.parts = [];
        for (const collider of e.colliderDescs) {
            const o = collider.offset ?? [0, 0, 0], r = collider.rotation ?? [0, 0, 0, 1];
            const shape = partShapeFor(collider.shape);
            const boundingRadius = boundingRadiusOf(collider.shape);
            const offset: V3 = [o[0] - c.x, o[1] - c.y, o[2] - c.z];
            e.parts.push({ shape, offset, rotation: [r[0], r[1], r[2], r[3]], boundingRadius });
            radius = Math.max(radius, Math.hypot(offset[0], offset[1], offset[2]) + boundingRadius);
        }
        // Rapier keeps the centre of mass in single precision: a bound a hair wide of it still bounds.
        e.radius = radius * (1 + 1e-6) + 1e-6;
    }

    /**
     * Rapier refits its query tree only inside a step: a body added, moved or turned since is invisible to
     * rays. Two zero-length steps refit it and change no position or velocity. Events they raise are real
     * (an overlap that began with the move) and are kept; the next real step does not raise them again.
     */
    private _syncQueries(): void {
        if (!this._dirty) return;
        const w = this._raw, dt = w.timestep;
        // A sleeping body that was moved by hand (a step landing from the physics worker writes every body)
        // is woken by the next step, even a zero-length one. These refits must change nothing: what slept
        // goes back to sleep, its velocity as it was.
        const sleeping: { body: RigidBody; v: { x: number; y: number; z: number }; w: { x: number; y: number; z: number } }[] = [];
        for (const e of this._entries.values()) if (e.enabled && e.body.isSleeping()) sleeping.push({ body: e.body, v: e.body.linvel(), w: e.body.angvel() });
        w.timestep = 0;
        w.step(this._queue);
        w.step(this._queue);
        w.timestep = dt;
        for (const s of sleeping) {
            if (s.body.isSleeping()) continue;
            s.body.sleep();
            s.body.setLinvel(s.v, false);
            s.body.setAngvel(s.w, false);
        }
        this._drainCollisions();
        this._contacts = null;
        this._dirty = false;
    }

    /** Rapier's collider events as the layer's body events, counted per body pair (see _pairCounts). */
    private _drainCollisions(): void {
        this._queue.drainCollisionEvents((c1, c2, started) => {
            const a = this._owner.get(c1), b = this._owner.get(c2);
            if (a === undefined || b === undefined || a === b) return;
            const ea = this._entries.get(a), eb = this._entries.get(b);
            if (!ea?.enabled || !eb?.enabled) return;
            // Sensor against sensor is the engine's own pass (triggerOverlaps.ts), as on cannon.
            if (ea.sensor && eb.sensor) return;
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            const was = this._pairCounts.get(key) ?? 0;
            const sensor = ea.sensor || eb.sensor;
            if (started) {
                this._pairCounts.set(key, was + 1);
                if (was > 0) return;
                if (sensor) this._events.push(PhysicsEventKind.SensorBegin, a, b);
                else {
                    if (ea.reports) this._events.push(PhysicsEventKind.ContactBegin, a, b);
                    if (eb.reports) this._events.push(PhysicsEventKind.ContactBegin, b, a);
                }
            } else {
                if (was <= 1) {
                    this._pairCounts.delete(key);
                    if (was === 1 && sensor) this._events.push(PhysicsEventKind.SensorEnd, a, b);
                } else this._pairCounts.set(key, was - 1);
            }
        });
    }

    /** The last step's contacts of every enabled dynamic body: one row per contact manifold. */
    private _contactRows(): number[] {
        if (this._contacts) return this._contacts;
        const rows: number[] = [];
        const seen = new Set<string>();
        for (const h of this._order) {
            const e = this._entries.get(h)!;
            if (e.type !== 'dynamic') continue;
            for (const c of e.colliders) {
                this._raw.contactPairsWith(c, other => {
                    const ob = this._owner.get(other.handle);
                    if (ob === undefined || ob === h) return;
                    const key = c.handle < other.handle ? `${c.handle},${other.handle}` : `${other.handle},${c.handle}`;
                    if (seen.has(key)) return;
                    seen.add(key);
                    // The manifold's normal points from its first collider to its second; `flipped` says the
                    // pair is stored the other way round from how it was asked.
                    this._raw.contactPair(c, other, (m, flipped) => {
                        if (m.numContacts() === 0) return;
                        const n = m.normal(), s = flipped ? -1 : 1;
                        rows.push(h, ob, s * n.x, s * n.y, s * n.z);
                    });
                });
            }
        }
        return this._contacts = rows;
    }
}

/** A Rapier collider for a shape description, with where the shape sits inside its collider (a heightfield is centred). */
function colliderDescFor(shape: ShapeDesc): { desc: RColliderDesc; inner: V3 } | null {
    const R = rapier();
    const at = (desc: RColliderDesc | null, inner: V3 = [0, 0, 0]) => (desc ? { desc, inner } : null);
    switch (shape.kind) {
        case 'sphere': return at(R.ColliderDesc.ball(shape.radius));
        case 'box': return at(R.ColliderDesc.cuboid(shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2]));
        case 'capsule': return at(shape.height > 0 ? R.ColliderDesc.capsule(shape.height / 2, shape.radius) : R.ColliderDesc.ball(shape.radius));
        case 'cylinder': {
            if (shape.radiusTop === shape.radiusBottom) return at(R.ColliderDesc.cylinder(shape.height / 2, shape.radiusTop));
            // A tapered cylinder: the hull of its two rings.
            const n = Math.max(3, shape.segments ?? 8), points = new Float32Array(n * 6);
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
                points.set([shape.radiusTop * c, shape.height / 2, shape.radiusTop * s, shape.radiusBottom * c, -shape.height / 2, shape.radiusBottom * s], i * 6);
            }
            return at(R.ColliderDesc.convexHull(points));
        }
        case 'convex': {
            const points = new Float32Array(shape.vertices.length * 3);
            shape.vertices.forEach((v, i) => points.set([v[0], v[1], v[2]], i * 3));
            return at(R.ColliderDesc.convexHull(points));
        }
        case 'trimesh': {
            const sc = shape.scale ?? [1, 1, 1], p = shape.positions, vertices = new Float32Array(p.length);
            for (let i = 0; i < p.length; i++) vertices[i] = p[i] * sc[i % 3];
            // FIX_INTERNAL_EDGES: a body sliding across two triangles is not bumped by the edge between them.
            return at(R.ColliderDesc.trimesh(vertices, Uint32Array.from(shape.indices), R.TriMeshFlags.FIX_INTERNAL_EDGES));
        }
        case 'heightfield': {
            // The layer's field starts at its corner and runs along +X (i) and −Z (j); Rapier's is centred and
            // column-major, rows along +Z, columns along +X: transposed, Z flipped, offset by half its size.
            const H = shape.heights, I = H.length, J = I ? H[0].length : 0, e = shape.elementSize;
            if (I < 2 || J < 2) return null;
            const data = new Float32Array(I * J);
            for (let c = 0; c < I; c++) for (let r = 0; r < J; r++) data[c * J + r] = H[c][J - 1 - r];
            const sx = (I - 1) * e, sz = (J - 1) * e;
            // FIX_INTERNAL_EDGES: a character walking across cell boundaries is not stopped by them (a ghost
            // collision with the edge between two triangles), as cannon's own heightfield patch ensures.
            return at(R.ColliderDesc.heightfield(J - 1, I - 1, data, { x: sx, y: 1, z: sz }, R.HeightFieldFlags.FIX_INTERNAL_EDGES), [sx / 2, 0, -sz / 2]);
        }
        case 'plane': return at(new R.ColliderDesc(new R.HalfSpace({ x: 0, y: 1, z: 0 })));
    }
}
