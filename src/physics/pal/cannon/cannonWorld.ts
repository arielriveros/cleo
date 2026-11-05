import {
    AABB, Body, ConeTwistConstraint, Constraint, HingeConstraint, LockConstraint, Material, PointToPointConstraint,
    Quaternion, Ray, RaycastResult, Vec3, World,
} from 'cannon-es';
import type { PhysicsCapabilities } from '../capabilities';
import { PhysicsEventKind } from '../types';
import type {
    BodyDesc, BodyHandle, ColliderDesc, ColliderPart, JointDesc, JointHandle, MassProperties, Out, RayHit, RayOptions, StepProfile, V3,
} from '../types';
import type { PhysicsWorld } from '../world';
import { CannonBody } from './cannonBody';
import { cannonParts } from './shapes';
import { cannonColliderParts } from './parts';
import { createCannonWorld } from './worldConfig';
import { MaterialTable } from './materialTable';
import { broadphaseBodyCount, clearWorld } from './worldTeardown';

/** Grip and bounce of a body that brings no surface of its own: cannon's own defaults. */
export const DEFAULT_FRICTION = 0.3;
export const DEFAULT_RESTITUTION = 0;

export const CANNON_CAPABILITIES: PhysicsCapabilities = {
    backend: 'cannon',
    nativeCapsule: false,
    collisionGroupBits: 32,
    fractionalAxisFactors: true,
    jointMaxForce: true,
    coneLimit: 'native',
    manualSleep: true,
    profilePhases: ['broadphase', 'narrowphase', 'solve', 'integrate'],
    threadable: true,
    precision: 64,
};

/**
 * The cannon-es backend. Wraps one cannon World built the engine's way (worldConfig.ts: its broadphase,
 * its heightfield and convex patches, no automatic sleep), with surfaces from a MaterialTable. A body's
 * handle is its cannon `id`, so a handle stays valid for exactly as long as cannon knows the body.
 *
 * Bodies made through {@link createBody} are CannonBody (cannonBody.ts), which keeps the node origin
 * apart from cannon's centre of mass. The members after the interface's — `raw`, `materials`, `bodyOf`,
 * `materialFor`, `touch`, `raise` — are cannon-only ways in, for the copy of the world in the physics worker
 * (mirror.ts, replica.ts); nothing outside pal/cannon/ may use them.
 */
export class CannonWorld implements PhysicsWorld {
    public readonly backend = 'cannon' as const;
    public readonly capabilities = CANNON_CAPABILITIES;
    /** The cannon World itself. */
    public readonly raw: World;
    public readonly materials: MaterialTable;
    public onPreSubstep: ((dt: number) => void) | null = null;
    public profile = false;

    private _version = 0;
    /** Queued events: [kind, a, b] per event. */
    private _events: number[] = [];
    private _bodyList: BodyHandle[] | null = null;
    /** Bodies taken out of the world but kept (setEnabled false): readable and writable, not simulated. */
    private readonly _disabled = new Map<number, Body>();
    private readonly _joints = new Map<number, Constraint>();
    private _nextJoint = 1;
    private readonly _profile: StepProfile = { broadphaseMs: 0, narrowphaseMs: 0, solveMs: 0, integrateMs: 0 };
    private readonly _hit: RayHit = { body: 0 as BodyHandle, point: [0, 0, 0], normal: [0, 0, 0], distance: 0 };

    constructor(gravity: ArrayLike<number> = [0, -9.82, 0]) {
        const world = this.raw = createCannonWorld(gravity);
        this.materials = new MaterialTable(world);
        // Overlaps involving a sensor (cannon's trigger). cannon diffs its overlap keeper every step into
        // these two; a body removed since comes back missing, and its pair is dropped with it.
        world.addEventListener('beginContact', (e: any) => this._pair(e.bodyA, e.bodyB, PhysicsEventKind.SensorBegin));
        world.addEventListener('endContact', (e: any) => this._pair(e.bodyA, e.bodyB, PhysicsEventKind.SensorEnd));
        // After cannon has added gravity and before it integrates: forces added here are integrated exactly
        // like gravity is, in this substep.
        world.addEventListener('preStep', () => this.onPreSubstep?.(world.dt));
        world.addEventListener('addBody', () => { this._bodyList = null; });
        world.addEventListener('removeBody', () => { this._bodyList = null; });
    }

    // ---- world ----

    public get time(): number { return this.raw.time; }
    public set time(t: number) { (this.raw as { time: number }).time = t; }

    public get gravity(): V3 { const g = this.raw.gravity; return [g.x, g.y, g.z]; }
    public set gravity(g: V3) { this.raw.gravity.set(g[0], g[1], g[2]); }

    public get solverIterations(): number {
        return (this.raw.solver as unknown as { iterations?: number }).iterations ?? 0;
    }
    public set solverIterations(n: number) {
        const solver = this.raw.solver as unknown as { iterations?: number };
        if (typeof solver.iterations === 'number') solver.iterations = n;
    }

    public get stateVersion(): number { return this._version; }

    // ---- bodies ----

    public createBody(desc: BodyDesc): BodyHandle {
        const p = desc.position, q = desc.rotation;
        const body = new CannonBody({
            mass: desc.mass,
            type: desc.type === 'kinematic' ? Body.KINEMATIC : desc.type === 'static' ? Body.STATIC : undefined,
            position: new Vec3(p[0], p[1], p[2]),
            quaternion: new Quaternion(q[0], q[1], q[2], q[3]),
            linearDamping: desc.linearDamping ?? 0.01,
            angularDamping: desc.angularDamping ?? 0.01,
            linearFactor: desc.linearFactor ? new Vec3(desc.linearFactor[0], desc.linearFactor[1], desc.linearFactor[2]) : undefined,
            angularFactor: desc.angularFactor ? new Vec3(desc.angularFactor[0], desc.angularFactor[1], desc.angularFactor[2]) : undefined,
            allowSleep: desc.sleep?.allow ?? true,
            collisionFilterGroup: desc.group ?? 1,
            collisionFilterMask: desc.mask ?? -1,
            isTrigger: !!desc.sensor,
            collisionResponse: desc.collisionResponse ?? true,
        });
        if (desc.sleep?.speedLimit !== undefined) body.sleepSpeedLimit = desc.sleep.speedLimit;
        if (desc.sleep?.timeLimit !== undefined) body.sleepTimeLimit = desc.sleep.timeLimit;
        (body as { userData?: number }).userData = desc.userData ?? 0;
        if (desc.reportContacts) this._reportContacts(body);
        this._addColliders(body, desc.colliders);
        if ((desc.centerOfMass ?? 'colliders') === 'colliders') body.recenterMass();
        body.material = this.materialFor(desc.friction ?? DEFAULT_FRICTION, desc.restitution ?? DEFAULT_RESTITUTION);
        this.raw.addBody(body);
        return body.id as BodyHandle;
    }

    public destroyBody(h: BodyHandle): void {
        if (this._disabled.delete(h)) return;
        const body = this.raw.getBodyById(h);
        if (!body) return;
        this.raw.removeBody(body);
        this._dropEvents(h);
    }

    public hasBody(h: BodyHandle): boolean { return this.bodyOf(h) !== undefined; }

    public setEnabled(h: BodyHandle, enabled: boolean): void {
        if (enabled) {
            const body = this._disabled.get(h);
            if (!body) return;
            this._disabled.delete(h);
            this.raw.addBody(body);
        } else {
            const body = this.raw.getBodyById(h);
            if (!body) return;
            this.raw.removeBody(body);
            this._disabled.set(h, body);
            this._dropEvents(h);
        }
    }

    public isEnabled(h: BodyHandle): boolean { return this.raw.getBodyById(h) !== undefined; }

    public bodies(): readonly BodyHandle[] {
        return this._bodyList ??= this.raw.bodies.map(b => b.id as BodyHandle);
    }

    public get bodyCount(): number { return this.raw.bodies.length; }

    /** See worldTeardown for how a cannon world leaks bodies into its broadphase. */
    public broadphaseBodyCount(): number { return broadphaseBodyCount(this.raw); }

    public setCollisionFilter(h: BodyHandle, group: number, mask: number): void {
        const body = this._body(h);
        body.collisionFilterGroup = group;
        body.collisionFilterMask = mask;
    }

    public setColliders(h: BodyHandle, colliders: readonly ColliderDesc[], centerOfMass?: 'colliders' | 'origin'): void {
        const body = this._body(h);
        if (centerOfMass && body instanceof CannonBody) body.resetCenterOfMass();
        for (let i = body.shapes.length - 1; i >= 0; i--) body.removeShape(body.shapes[i]);
        this._addColliders(body, colliders);
        if (centerOfMass === 'colliders' && body instanceof CannonBody) body.recenterMass();
        else body.updateMassProperties();
        body.updateBoundingRadius();
        body.aabbNeedsUpdate = true;
        this._version++;
    }

    public setCollisionResponse(h: BodyHandle, response: boolean): void { this._body(h).collisionResponse = response; }

    public setReportContacts(h: BodyHandle, report: boolean): void {
        const body = this._body(h) as Body & { __reports?: boolean };
        if (report) this._reportContacts(body);
        else body.__reports = false;
    }

    public getMassProperties(h: BodyHandle, out: MassProperties): MassProperties {
        const body = this._body(h);
        out.mass = body.mass;
        const com = body instanceof CannonBody ? body.centerOfMassOffset : null;
        out.centerOfMass[0] = com?.x ?? 0; out.centerOfMass[1] = com?.y ?? 0; out.centerOfMass[2] = com?.z ?? 0;
        out.inertia[0] = body.inertia.x; out.inertia[1] = body.inertia.y; out.inertia[2] = body.inertia.z;
        return out;
    }

    public getTransform(h: BodyHandle, out: Out): void {
        const body = this._body(h);
        if (body instanceof CannonBody) body.originPosition(out);
        else { out[0] = body.position.x; out[1] = body.position.y; out[2] = body.position.z; }
        const q = body.quaternion;
        out[3] = q.x; out[4] = q.y; out[5] = q.z; out[6] = q.w;
    }

    public setTransform(h: BodyHandle, position: ArrayLike<number> | null, rotation: ArrayLike<number> | null): void {
        const body = this._body(h);
        if (body instanceof CannonBody) {
            if (position) body.setPosition(position);
            if (rotation) body.setQuaternion(rotation);
        } else {
            const p = body.position, q = body.quaternion;
            let moved = false;
            if (position && (p.x !== position[0] || p.y !== position[1] || p.z !== position[2])) {
                p.set(position[0], position[1], position[2]);
                moved = true;
            }
            if (rotation && (q.x !== rotation[0] || q.y !== rotation[1] || q.z !== rotation[2] || q.w !== rotation[3])) {
                q.set(rotation[0], rotation[1], rotation[2], rotation[3]);
                moved = true;
            }
            // Re-measured on the next query only when it actually moved — see CannonBody._syncPosition.
            if (moved) body.aabbNeedsUpdate = true;
        }
        this._version++;
    }

    public getVelocity(h: BodyHandle, out: Out): void {
        const body = this._body(h), v = body.velocity, w = body.angularVelocity;
        out[0] = v.x; out[1] = v.y; out[2] = v.z; out[3] = w.x; out[4] = w.y; out[5] = w.z;
    }

    public setLinearVelocity(h: BodyHandle, x: number, y: number, z: number): void {
        this._body(h).velocity.set(x, y, z);
        this._version++;
    }

    public setAngularVelocity(h: BodyHandle, x: number, y: number, z: number): void {
        this._body(h).angularVelocity.set(x, y, z);
        this._version++;
    }

    public applyImpulse(h: BodyHandle, impulse: ArrayLike<number>, relativePoint?: ArrayLike<number>): void {
        const a = CannonWorld._a.set(impulse[0], impulse[1], impulse[2]);
        const r = relativePoint ? CannonWorld._b.set(relativePoint[0], relativePoint[1], relativePoint[2]) : CannonWorld._b.set(0, 0, 0);
        this._body(h).applyImpulse(a, r);
        this._version++;
    }

    public applyForce(h: BodyHandle, force: ArrayLike<number>, relativePoint?: ArrayLike<number>): void {
        const f = CannonWorld._a.set(force[0], force[1], force[2]);
        const r = relativePoint ? CannonWorld._b.set(relativePoint[0], relativePoint[1], relativePoint[2]) : CannonWorld._b.set(0, 0, 0);
        this._body(h).applyForce(f, r);
    }

    public clearForces(h: BodyHandle): void {
        const body = this._body(h);
        body.force.set(0, 0, 0);
        body.torque.set(0, 0, 0);
    }

    public sleep(h: BodyHandle): void { this._body(h).sleep(); }
    public wakeUp(h: BodyHandle): void { this._body(h).wakeUp(); }
    public isSleeping(h: BodyHandle): boolean { return this._body(h).sleepState === Body.SLEEPING; }

    public getAabb(h: BodyHandle, out: Out): void {
        const body = this._body(h);
        body.updateAABB();
        const lo = body.aabb.lowerBound, hi = body.aabb.upperBound;
        out[0] = lo.x; out[1] = lo.y; out[2] = lo.z; out[3] = hi.x; out[4] = hi.y; out[5] = hi.z;
    }

    public colliderParts(h: BodyHandle): readonly ColliderPart[] { return cannonColliderParts(this._body(h)); }

    public getColliderFrame(h: BodyHandle, out: Out): number {
        const body = this._body(h), p = body.position, q = body.quaternion;
        out[0] = p.x; out[1] = p.y; out[2] = p.z; out[3] = q.x; out[4] = q.y; out[5] = q.z; out[6] = q.w;
        return body.boundingRadius;
    }

    public colliderFrameToOrigin(h: BodyHandle, pose: ArrayLike<number>, out: Out): void {
        const body = this._body(h);
        if (body instanceof CannonBody) body.originOf(pose, out);
        else { out[0] = pose[0]; out[1] = pose[1]; out[2] = pose[2]; }
    }

    // ---- joints ----

    public createJoint(desc: JointDesc): JointHandle {
        const a = this._body(desc.a), b = this._body(desc.b);
        const maxForce = desc.maxForce ?? 1e6;
        // Anchors are from the node origin; cannon's pivots are from the centre of mass.
        const pivot = (body: Body, anchor: V3) => {
            const com = body instanceof CannonBody ? body.centerOfMassOffset : null;
            return com ? new Vec3(anchor[0] - com.x, anchor[1] - com.y, anchor[2] - com.z) : new Vec3(anchor[0], anchor[1], anchor[2]);
        };
        const v = (x: V3) => new Vec3(x[0], x[1], x[2]);
        let joint: Constraint;
        switch (desc.kind) {
            case 'fixed': joint = new LockConstraint(a, b, { maxForce }); break;
            case 'ball': joint = new PointToPointConstraint(a, pivot(a, desc.anchorA), b, pivot(b, desc.anchorB), maxForce); break;
            case 'hinge':
                joint = new HingeConstraint(a, b, { pivotA: pivot(a, desc.anchorA), pivotB: pivot(b, desc.anchorB), axisA: v(desc.axisA), axisB: v(desc.axisB), maxForce });
                break;
            case 'coneTwist':
                joint = new ConeTwistConstraint(a, b, {
                    pivotA: pivot(a, desc.anchorA), pivotB: pivot(b, desc.anchorB), axisA: v(desc.axisA), axisB: v(desc.axisB),
                    angle: desc.coneAngle, twistAngle: desc.twistAngle, maxForce,
                });
                break;
        }
        joint.collideConnected = !!desc.collideConnected;
        this.raw.addConstraint(joint);
        const id = this._nextJoint++;
        this._joints.set(id, joint);
        return id as JointHandle;
    }

    public destroyJoint(j: JointHandle): void {
        const joint = this._joints.get(j);
        if (!joint) return;
        this.raw.removeConstraint(joint);
        this._joints.delete(j);
    }

    // ---- the step ----

    public step(dt: number): void {
        const world = this.raw;
        world.doProfiling = this.profile;
        world.step(dt);
        if (this.profile) {
            const prof = (world as unknown as { profile: Record<string, number> }).profile;
            this._profile.broadphaseMs += prof.broadphase;
            this._profile.narrowphaseMs += prof.narrowphase;
            this._profile.solveMs += prof.solve + prof.makeContactConstraints;
            this._profile.integrateMs += prof.integrate;
        }
        this._version++;
    }

    public readProfile(out: StepProfile): void {
        const p = this._profile;
        out.broadphaseMs += p.broadphaseMs; out.narrowphaseMs += p.narrowphaseMs;
        out.solveMs += p.solveMs; out.integrateMs += p.integrateMs;
        p.broadphaseMs = p.narrowphaseMs = p.solveMs = p.integrateMs = 0;
    }

    public forEachContact(visit: (a: BodyHandle, b: BodyHandle, nx: number, ny: number, nz: number) => void): void {
        const contacts = this.raw.contacts;
        for (let i = 0; i < contacts.length; i++) {
            const c = contacts[i], n = c.ni;
            visit(c.bi.id as BodyHandle, c.bj.id as BodyHandle, n.x, n.y, n.z);
        }
    }

    public get contactCount(): number { return this.raw.contacts.length; }

    public drainEvents(visit: (kind: PhysicsEventKind, a: BodyHandle, b: BodyHandle) => void): void {
        const events = this._events;
        if (events.length === 0) return;
        this._events = [];
        for (let i = 0; i < events.length; i += 3) visit(events[i] as PhysicsEventKind, events[i + 1] as BodyHandle, events[i + 2] as BodyHandle);
    }

    // ---- queries ----

    public raycast(from: ArrayLike<number>, to: ArrayLike<number>, options: RayOptions, onHit: (hit: RayHit) => void): void {
        CannonWorld._rayFrom.set(from[0], from[1], from[2]);
        CannonWorld._rayTo.set(to[0], to[1], to[2]);
        const checkCollisionResponse = !options.includeNoResponse;
        const hit = this._hit;
        const report = (result: RaycastResult) => {
            // `distance` is only meaningful on a hit; it is -1 after a reset.
            if (!result.hasHit || !result.body) return;
            const p = result.hitPointWorld, n = result.hitNormalWorld;
            hit.body = result.body.id as BodyHandle;
            hit.point[0] = p.x; hit.point[1] = p.y; hit.point[2] = p.z;
            hit.normal[0] = n.x; hit.normal[1] = n.y; hit.normal[2] = n.z;
            hit.distance = result.distance;
            onHit(hit);
        };
        this._raycastFiltered(checkCollisionResponse, options, report);
    }

    /**
     * Every ray, in either mode: cannon's own Ray and per-body intersection over a candidate list gathered
     * here instead of by `broadphase.aabbQuery`. Two reasons:
     *
     * - The broad phase's query is a linear scan either way (cannon's SAP computes the axis bounds and
     *   discards them), and on the main thread of the worker build its axis list is not sorted by anything
     *   — the mirror world never steps. So nothing is lost by walking `bodies`.
     * - Bodies the ray cannot report are dropped BEFORE their box is refreshed or a shape is tested:
     *   cannon's own `intersectBody` predicates (no collision response, a group/mask mismatch) and what the
     *   caller would throw away on sight — dynamic bodies for a ground probe, sensors, the caster's own
     *   body (a foot's or an AI's ray starts inside its own capsule). Sensors are the hit boxes and trigger
     *   zones that follow animated bones: re-measured every frame, they were most of what a ray paid for.
     *
     * The hits are the ones cannon reports for the bodies kept, through the same callback contract (every
     * hit, the caller keeps the nearest); only the candidate ORDER differs, which no caller depends on.
     */
    private _raycastFiltered(checkCollisionResponse: boolean, options: RayOptions,
                             report: (result: RaycastResult) => void): void {
        const mode = options.mode;
        const ray = CannonWorld._groundRay;
        ray.from.copy(CannonWorld._rayFrom);
        ray.to.copy(CannonWorld._rayTo);
        ray.mode = mode === 'closest' ? Ray.CLOSEST : Ray.ALL;
        ray.result = CannonWorld._groundResult;
        ray.skipBackfaces = false;
        ray.collisionFilterMask = -1;
        ray.collisionFilterGroup = -1;
        ray.checkCollisionResponse = checkCollisionResponse;
        ray.callback = report;
        ray.hasHit = false;
        ray.result.reset();
        // Private in cannon's typings, but it is the step `intersectWorld` runs before anything else.
        (ray as unknown as { updateDirection(): void }).updateDirection();

        const box = CannonWorld._groundBox;
        ray.getAABB(box);
        const excludeDynamic = !!options.excludeDynamic, excludeSensors = !!options.excludeSensors;
        const ignore = options.ignore;
        const candidates = CannonWorld._groundCandidates;
        candidates.length = 0;
        for (const body of this.raw.bodies) {
            // cannon's `intersectBody` would return on these two without testing a shape.
            if (checkCollisionResponse && !body.collisionResponse) continue;
            if ((ray.collisionFilterGroup & body.collisionFilterMask) === 0
                || (body.collisionFilterGroup & ray.collisionFilterMask) === 0) continue;
            if (excludeDynamic && body.type === Body.DYNAMIC) continue;
            if (excludeSensors && body.isTrigger) continue;
            if (ignore !== undefined && CannonWorld._ignored(ignore, body.id as BodyHandle)) continue;
            if (body.aabbNeedsUpdate) body.updateAABB();
            if (body.aabb.overlaps(box)) candidates.push(body);
        }
        ray.intersectBodies(candidates);
        candidates.length = 0;
        if (mode === 'closest' && ray.hasHit) report(ray.result);
    }

    private static _ignored(ignore: BodyHandle | readonly BodyHandle[], h: BodyHandle): boolean {
        if (typeof ignore === 'number') return ignore === h;
        for (let i = 0; i < ignore.length; i++) if (ignore[i] === h) return true;
        return false;
    }

    public clear(): void {
        for (const constraint of [...this.raw.constraints]) this.raw.removeConstraint(constraint);
        this._joints.clear();
        // Removing bodies is subtle enough to live in its own module — see clearWorld for the two traps
        // (splice-while-iterating, and truncating world.bodies behind the broadphase's back).
        clearWorld(this.raw);
        this._disabled.clear();
        this._events = [];
        this._version++;
    }

    public dispose(): void {
        this.clear();
        this.onPreSubstep = null;
    }

    // ---- cannon only: for the copy in the physics worker (mirror.ts, replica.ts) ----

    /** The cannon body behind a handle, enabled or not (undefined once destroyed). */
    public bodyOf(h: BodyHandle): Body | undefined { return this.raw.getBodyById(h) ?? this._disabled.get(h); }

    /** The cannon Material for a surface (see MaterialTable). */
    public materialFor(friction: number, restitution: number): Material {
        return this.materials.materialFor(friction, restitution);
    }

    /** Something wrote the cannon bodies directly (the worker's step landing): caches of their state must re-read. */
    public touch(): void { this._version++; }

    /** Queue an event a step elsewhere raised (the worker's, landing through mirror.ts): drainEvents delivers it. */
    public raise(kind: PhysicsEventKind, a: BodyHandle, b: BodyHandle): void { this._events.push(kind, a, b); }

    // ---- internals ----

    private _body(h: BodyHandle): Body {
        const body = this.bodyOf(h);
        if (!body) throw new Error(`physics: no body ${h} in this world`);
        return body;
    }

    private _addColliders(body: Body, colliders: readonly ColliderDesc[]): void {
        for (const collider of colliders) {
            const o = collider.offset, r = collider.rotation;
            const offset = new Vec3(o?.[0] ?? 0, o?.[1] ?? 0, o?.[2] ?? 0);
            const rotation = r ? new Quaternion(r[0], r[1], r[2], r[3]) : new Quaternion();
            for (const part of cannonParts(collider.shape)) {
                // The part's place in the collider, then the collider's in the body.
                const at = rotation.vmult(part.offset).vadd(offset);
                body.addShape(part.shape, at, rotation.mult(part.orientation));
            }
        }
    }

    /**
     * Report a body's first contacts: cannon raises them on the body, mid-step (and the worker executor
     * raises them again as each step lands); queued here, they come out of drainEvents in that order.
     */
    private _reportContacts(body: Body & { __reports?: boolean; __listening?: boolean }): void {
        body.__reports = true;
        if (body.__listening) return;
        body.__listening = true;
        body.addEventListener('collide', (e: { body?: Body | null }) => {
            if (body.__reports && e.body) this._events.push(PhysicsEventKind.ContactBegin, body.id, e.body.id);
        });
    }

    private _pair(a: Body | null | undefined, b: Body | null | undefined, kind: PhysicsEventKind): void {
        if (!a || !b || !(a.isTrigger || b.isTrigger)) return;
        this._events.push(kind, a.id, b.id);
    }

    private _dropEvents(h: BodyHandle): void {
        const events = this._events;
        if (events.length === 0) return;
        let w = 0;
        for (let i = 0; i < events.length; i += 3) {
            if (events[i + 1] === h || events[i + 2] === h) continue;
            events[w++] = events[i]; events[w++] = events[i + 1]; events[w++] = events[i + 2];
        }
        events.length = w;
    }

    private static readonly _a = new Vec3();
    private static readonly _b = new Vec3();
    private static readonly _rayFrom = new Vec3();
    private static readonly _rayTo = new Vec3();
    private static readonly _groundRay = new Ray();
    private static readonly _groundResult = new RaycastResult();
    private static readonly _groundBox = new AABB();
    private static readonly _groundCandidates: Body[] = [];
}
