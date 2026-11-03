import { quat, vec3 } from 'gl-matrix';
import type { Node } from '../core/scene/nodes/node';
import type { Shape } from './shape';
import type { PhysicsWorld } from './pal/world';
import type { BodyDesc, BodyHandle, BodyType, ColliderDesc, Out, ShapeDesc } from './pal/types';

// The engine's own rigid body, on any physics backend (see pal/). It holds what the body is made of (a
// BodyDesc: mass, damping, surface, layers, colliders) and, once PhysicsSystem has put it in a world, the
// handle the world gave it. Everything about where it is and how it moves lives in the world: reads come
// from the world (cached until the world's state changes), writes go straight to it.
//
// Out of a world it keeps its own state, which is what the world starts it from when it is added.

/** How a {@link PhysicsBody} starts. Unset fields take the defaults noted. */
export interface PhysicsBodyOptions {
    /** Names it in the stats and warnings. */
    name?: string;
    /** The node it belongs to, if any (what a raycast or overlap reports as its `node`). */
    owner?: Node | null;
    /** Default: dynamic with a mass, else static. */
    type?: BodyType;
    /** kg. Default 0: immovable. */
    mass?: number;
    position?: ArrayLike<number>;
    quaternion?: ArrayLike<number>;
    /** Fraction of velocity lost per second. Default 0.01 for both. */
    linearDamping?: number;
    angularDamping?: number;
    linearFactor?: ArrayLike<number>;
    angularFactor?: ArrayLike<number>;
    /** Surface: grip and bounce. Default 0.3 and 0. */
    friction?: number;
    restitution?: number;
    /** Collision layers it is in and collides with, as bit masks. Default 1 and -1. */
    group?: number;
    mask?: number;
    /** Detects overlaps without colliding. Default false. */
    sensor?: boolean;
    /** Takes part in the solver. Default true. */
    collisionResponse?: boolean;
    /** Where the mass sits. Default 'origin' (the node origin); 'colliders' puts it at their centre. */
    centerOfMass?: 'colliders' | 'origin';
    /** Whether a camera rig's collision probe treats it as solid. Default true. */
    cameraCollision?: boolean;
    /** May be woken by contact when the engine has put it to sleep. Default true. */
    allowSleep?: boolean;
    /** Advisory sleep thresholds (m/s, s). Backend defaults when unset. */
    sleepSpeedLimit?: number;
    sleepTimeLimit?: number;
    /** It is a character's: water leaves it alone unless a volume asks (see buoyancy). */
    character?: boolean;
}

/** Bits of BodyDesc.userData the engine uses. */
export const BODY_CHARACTER = 1;

/** Indices into a body's state block: position, rotation, velocity, angular velocity. */
const P = 0, Q = 3, V = 7, W = 10;

/**
 * A live view of one of a body's vectors: reading it reads the body, writing it writes the body. The same
 * object for the life of the body, so it can be kept. Carries the vector methods engine code uses.
 */
export class BodyVec3 {
    /** @internal */
    constructor(private readonly _body: PhysicsBody, private readonly _at: number) {}

    public get x(): number { return this._body._state()[this._at]; }
    public set x(v: number) { this._body._writeComponent(this._at, v); }
    public get y(): number { return this._body._state()[this._at + 1]; }
    public set y(v: number) { this._body._writeComponent(this._at + 1, v); }
    public get z(): number { return this._body._state()[this._at + 2]; }
    public set z(v: number) { this._body._writeComponent(this._at + 2, v); }

    public set(x: number, y: number, z: number): this { this._body._writeVector(this._at, x, y, z); return this; }
    public copy(v: { x: number; y: number; z: number }): this { return this.set(v.x, v.y, v.z); }
    public lengthSquared(): number { const s = this._body._state(), i = this._at; return s[i] * s[i] + s[i + 1] * s[i + 1] + s[i + 2] * s[i + 2]; }
    public length(): number { return Math.sqrt(this.lengthSquared()); }
    /** `this + v`, into `target` when given (which may be this view), else as a new plain vector. */
    public vadd(v: { x: number; y: number; z: number }, target?: { set(x: number, y: number, z: number): unknown }): { x: number; y: number; z: number } {
        const x = v.x + this.x, y = v.y + this.y, z = v.z + this.z;
        if (target) { target.set(x, y, z); return target as unknown as { x: number; y: number; z: number }; }
        return { x, y, z };
    }
    /** `this * s`, into `target` when given (which may be this view), else as a new plain vector. */
    public scale(s: number, target?: { set(x: number, y: number, z: number): unknown }): { x: number; y: number; z: number } {
        const x = s * this.x, y = s * this.y, z = s * this.z;
        if (target) { target.set(x, y, z); return target as unknown as { x: number; y: number; z: number }; }
        return { x, y, z };
    }
    public toArray(): [number, number, number] { return [this.x, this.y, this.z]; }
}

/** A live view of a body's rotation, [x y z w]. See {@link BodyVec3}. */
export class BodyQuat {
    /** @internal */
    constructor(private readonly _body: PhysicsBody) {}

    public get x(): number { return this._body._state()[Q]; }
    public set x(v: number) { this._body._writeComponent(Q, v); }
    public get y(): number { return this._body._state()[Q + 1]; }
    public set y(v: number) { this._body._writeComponent(Q + 1, v); }
    public get z(): number { return this._body._state()[Q + 2]; }
    public set z(v: number) { this._body._writeComponent(Q + 2, v); }
    public get w(): number { return this._body._state()[Q + 3]; }
    public set w(v: number) { this._body._writeComponent(Q + 3, v); }

    public set(x: number, y: number, z: number, w: number): this { this._body._writeRotation(x, y, z, w); return this; }
    public copy(q: { x: number; y: number; z: number; w: number }): this { return this.set(q.x, q.y, q.z, q.w); }
    /** `v` rotated by this rotation, as a new plain vector (cannon's Quaternion.vmult). */
    public vmult(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
        const s = this._body._state(), qx = s[Q], qy = s[Q + 1], qz = s[Q + 2], qw = s[Q + 3];
        const ix = qw * v.x + qy * v.z - qz * v.y, iy = qw * v.y + qz * v.x - qx * v.z;
        const iz = qw * v.z + qx * v.y - qy * v.x, iw = -qx * v.x - qy * v.y - qz * v.z;
        return {
            x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
            y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
            z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
        };
    }
    public toArray(): [number, number, number, number] { return [this.x, this.y, this.z, this.w]; }
}

export class PhysicsBody {
    private readonly _name: string;
    private readonly _owner: Node | null;
    /** Whether a camera rig's collision probe treats it as solid (see cameraRayFilter.ts). */
    public cameraCollision: boolean;
    /** A 'dither' camera rig sees through it (foliage rules that ask for it). */
    public cameraDither = false;

    /** @internal What the body is made of: handed to the world when it is added. */
    protected readonly _desc: BodyDesc & { colliders: ColliderDesc[] };

    private _world: PhysicsWorld | null = null;
    private _handle = -1 as BodyHandle;
    /** Position, rotation, velocity, angular velocity: the world's (cached) or, out of a world, its own. */
    private readonly _s = new Float64Array(13);
    private readonly _velocity = this._s.subarray(V, V + 6);
    /** The world's `stateVersion` `_s` was read at; -1 forces a read. */
    private _readAt = -1;

    public readonly position = new BodyVec3(this, P);
    public readonly quaternion = new BodyQuat(this);
    public readonly velocity = new BodyVec3(this, V);
    public readonly angularVelocity = new BodyVec3(this, W);

    constructor(options: PhysicsBodyOptions = {}) {
        this._name = options.name ?? 'body';
        this._owner = options.owner ?? null;
        this.cameraCollision = options.cameraCollision ?? true;
        const p = options.position ?? [0, 0, 0], q = options.quaternion ?? [0, 0, 0, 1];
        const v3 = (a: ArrayLike<number> | undefined) => (a ? [a[0], a[1], a[2]] as const : undefined);
        this._desc = {
            type: options.type,
            position: [p[0], p[1], p[2]],
            rotation: [q[0], q[1], q[2], q[3]],
            mass: options.mass ?? 0,
            centerOfMass: options.centerOfMass ?? 'origin',
            linearDamping: options.linearDamping,
            angularDamping: options.angularDamping,
            linearFactor: v3(options.linearFactor),
            angularFactor: v3(options.angularFactor),
            friction: options.friction,
            restitution: options.restitution,
            group: options.group,
            mask: options.mask,
            sensor: options.sensor,
            collisionResponse: options.collisionResponse,
            sleep: options.allowSleep === undefined && options.sleepSpeedLimit === undefined && options.sleepTimeLimit === undefined
                ? undefined : { allow: options.allowSleep, speedLimit: options.sleepSpeedLimit, timeLimit: options.sleepTimeLimit },
            userData: options.character ? BODY_CHARACTER : 0,
            colliders: [],
        };
        this._s.set([p[0], p[1], p[2], q[0], q[1], q[2], q[3]], P);
    }

    public get name(): string { return this._name; }
    public get owner(): Node | null { return this._owner; }
    /** The world's handle for this body, or -1 out of a world. */
    public get id(): number { return this._handle; }
    /** @internal */
    public get handle(): BodyHandle { return this._handle; }
    /** @internal The world it was made in (null until added, and after its world was cleared). */
    public get world(): PhysicsWorld | null { return this._world; }

    public get mass(): number { return this._desc.mass; }
    /** Moved by the simulation (not static, not kinematic). */
    public get isDynamic(): boolean { return this._desc.type ? this._desc.type === 'dynamic' : this._desc.mass > 0; }
    public get isTrigger(): boolean { return !!this._desc.sensor; }
    /** Per world axis, 1 = free, 0 = locked (see PhysicsBodyOptions). */
    public get linearFactor(): { x: number; y: number; z: number } { return xyz(this._desc.linearFactor); }
    public get angularFactor(): { x: number; y: number; z: number } { return xyz(this._desc.angularFactor); }
    /** Takes part in the solver. False: still contacts and raycasts, pushes and is pushed by nothing. */
    public get collisionResponse(): boolean { return this._desc.collisionResponse ?? true; }
    public set collisionResponse(response: boolean) {
        this._desc.collisionResponse = response;
        if (this._world) this._world.setCollisionResponse(this._handle, response);
    }
    public get collisionFilterGroup(): number { return this._desc.group ?? 1; }
    public set collisionFilterGroup(group: number) { this._desc.group = group; this._pushFilter(); }
    public get collisionFilterMask(): number { return this._desc.mask ?? -1; }
    public set collisionFilterMask(mask: number) { this._desc.mask = mask; this._pushFilter(); }

    /** A radius about its collider frame that bounds every collider (0 out of a world). */
    public get boundingRadius(): number {
        return this._world ? this._world.getColliderFrame(this._handle, PhysicsBody._frame) : 0;
    }
    private static readonly _frame = new Float64Array(7);

    /** Its colliders, as described. */
    public get colliders(): readonly ColliderDesc[] { return this._desc.colliders; }

    /**
     * Add a collider: `shape` at `offset` in the body's frame, turned by `orientation` (euler DEGREES).
     * Before the body is in a world, or after: the world rebuilds its shapes.
     */
    public attachShape(shape: Shape, offset: vec3 | number[] = [0, 0, 0], orientation: vec3 | number[] = [0, 0, 0]): this {
        const q = quat.fromEuler(quat.create(), orientation[0], orientation[1], orientation[2]);
        return this.addCollider({ shape: shape.desc, offset: [offset[0], offset[1], offset[2]], rotation: [q[0], q[1], q[2], q[3]] });
    }

    /** Add a collider as a description (see pal/types.ts ColliderDesc). */
    public addCollider(collider: ColliderDesc): this {
        this._desc.colliders.push(collider);
        if (this._world) this._world.setColliders(this._handle, this._desc.colliders);
        return this;
    }

    /** @internal Replace every collider. */
    protected _setColliders(colliders: ColliderDesc[]): void {
        this._desc.colliders = colliders;
        if (this._world) this._world.setColliders(this._handle, colliders);
    }

    /** @internal Where the mass sits from now on (see PhysicsBodyOptions.centerOfMass). */
    protected _setCenterOfMass(mode: 'colliders' | 'origin'): void {
        this._desc.centerOfMass = mode;
        if (this._world) this._world.setColliders(this._handle, this._desc.colliders, mode);
    }

    /** Move the body so its node origin lands on `position`. */
    public setPosition(position: ArrayLike<number>): void { this._writeVector(P, position[0], position[1], position[2]); }

    /** Turn the body about its node origin. */
    public setQuaternion(rotation: ArrayLike<number>): void { this._writeRotation(rotation[0], rotation[1], rotation[2], rotation[3]); }

    /** Place and turn it at once (the position first, then the turn about it). */
    public setTransform(position: ArrayLike<number>, rotation: ArrayLike<number>): void {
        const world = this._world;
        if (!world) { this.setPosition(position); this.setQuaternion(rotation); return; }
        world.setTransform(this._handle, position, rotation);
    }

    /** Node-origin position [3] and rotation [4] into `out`. */
    public getTransform<T extends Out>(out: T): T {
        const s = this._state();
        for (let i = 0; i < 7; i++) out[i] = s[i];
        return out;
    }

    /**
     * Its collision frame (the centre of mass on a backend that has no other, see
     * PhysicsWorld.getColliderFrame) into `out`; returns the radius bounding its colliders about it. Out of
     * a world, its node pose and 0.
     */
    public getColliderFrame<T extends Out>(out: T): number {
        if (this._world) return this._world.getColliderFrame(this._handle, out);
        this.getTransform(out);
        return 0;
    }

    /** Drop the force and torque applied since the last substep. */
    public clearForces(): void { if (this._world) this._world.clearForces(this._handle); }

    // ---- first contacts ----

    private _collideListeners: ((other: PhysicsBody) => void)[] | null = null;

    /**
     * Hear about each body this one starts touching (once per contact, until they part), after the step that
     * made it. Returns the unsubscribe.
     */
    public onCollide(listener: (other: PhysicsBody) => void): () => void {
        (this._collideListeners ??= []).push(listener);
        if (!this._desc.reportContacts) {
            this._desc.reportContacts = true;
            if (this._world) this._world.setReportContacts(this._handle, true);
        }
        return () => {
            const list = this._collideListeners;
            const i = list ? list.indexOf(listener) : -1;
            if (i >= 0) list!.splice(i, 1);
        };
    }

    /** @internal PhysicsSystem: this body first touched `other`. */
    public _emitCollide(other: PhysicsBody): void {
        const list = this._collideListeners;
        if (list) for (const listener of [...list]) listener(other);
    }

    /**
     * World bounds, min [3] then max [3]: the world's own in a world; out of one, measured from its colliders
     * as described (each shape's local box, turned and placed), at its own pose.
     */
    public getAabb<T extends Out>(out: T): T {
        if (this._world) { this._world.getAabb(this._handle, out); return out; }
        const s = this._s, body = quat.fromValues(s[3], s[4], s[5], s[6]);
        out[0] = out[1] = out[2] = Infinity; out[3] = out[4] = out[5] = -Infinity;
        const corner = vec3.create(), turn = quat.create();
        for (const c of this._desc.colliders) {
            const [lo, hi] = localBounds(c.shape);
            const r = c.rotation ?? [0, 0, 0, 1], o = c.offset ?? [0, 0, 0];
            quat.multiply(turn, body, quat.fromValues(r[0], r[1], r[2], r[3]));
            for (let i = 0; i < 8; i++) {
                vec3.set(corner, i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
                vec3.transformQuat(corner, corner, turn);
                const off = vec3.transformQuat(vec3.create(), [o[0], o[1], o[2]], body);
                for (let k = 0; k < 3; k++) {
                    const v = s[k] + off[k] + corner[k];
                    if (v < out[k]) out[k] = v;
                    if (v > out[k + 3]) out[k + 3] = v;
                }
            }
        }
        if (out[0] === Infinity) { out[0] = out[3] = s[0]; out[1] = out[4] = s[1]; out[2] = out[5] = s[2]; }
        return out;
    }

    /** An impulse at a point measured from the centre of mass (default: through it). In a world only. */
    public applyImpulse(impulse: ArrayLike<number> | { x: number; y: number; z: number }, relativePoint?: ArrayLike<number> | { x: number; y: number; z: number }): void {
        if (!this._world) return;
        this._world.applyImpulse(this._handle, toArray(impulse), relativePoint ? toArray(relativePoint) : undefined);
    }

    /** A force at a point measured from the centre of mass, for the next substep. In a world only. */
    public applyForce(force: ArrayLike<number> | { x: number; y: number; z: number }, relativePoint?: ArrayLike<number> | { x: number; y: number; z: number }): void {
        if (!this._world) return;
        this._world.applyForce(this._handle, toArray(force), relativePoint ? toArray(relativePoint) : undefined);
    }

    public sleep(): void { if (this._world) this._world.sleep(this._handle); }
    public wakeUp(): void { if (this._world) this._world.wakeUp(this._handle); }
    public get isSleeping(): boolean { return !!this._world && this._world.isSleeping(this._handle); }

    // ---- state ----

    /** @internal The state block, fresh. */
    public _state(): Float64Array {
        const world = this._world;
        if (world && this._readAt !== world.stateVersion) {
            world.getTransform(this._handle, this._s);
            world.getVelocity(this._handle, this._velocity);
            this._readAt = world.stateVersion;
        }
        return this._s;
    }

    /** @internal One component of the state block written. */
    public _writeComponent(at: number, value: number): void {
        const s = this._state();
        if (at < V) {
            const base = at < Q ? P : Q;
            if (base === P) this._writeVector(P, at === 0 ? value : s[0], at === 1 ? value : s[1], at === 2 ? value : s[2]);
            else this._writeRotation(at === 3 ? value : s[3], at === 4 ? value : s[4], at === 5 ? value : s[5], at === 6 ? value : s[6]);
        } else {
            const base = at < W ? V : W, i = at - base;
            this._writeVector(base, i === 0 ? value : s[base], i === 1 ? value : s[base + 1], i === 2 ? value : s[base + 2]);
        }
    }

    /** @internal A whole vector of the state block written: position, velocity or angular velocity. */
    public _writeVector(at: number, x: number, y: number, z: number): void {
        const world = this._world;
        if (!world) { this._s[at] = x; this._s[at + 1] = y; this._s[at + 2] = z; return; }
        if (at === P) world.setTransform(this._handle, [x, y, z], null);
        else if (at === V) world.setLinearVelocity(this._handle, x, y, z);
        else world.setAngularVelocity(this._handle, x, y, z);
    }

    /** @internal The rotation written. */
    public _writeRotation(x: number, y: number, z: number, w: number): void {
        const world = this._world;
        if (!world) { this._s[Q] = x; this._s[Q + 1] = y; this._s[Q + 2] = z; this._s[Q + 3] = w; return; }
        world.setTransform(this._handle, null, [x, y, z, w]);
    }

    // ---- membership: PhysicsSystem's ----

    /**
     * @internal Put the body in `world`: made there from its description and its own state the first time,
     * enabled again after a remove. Returns its handle.
     */
    public _addTo(world: PhysicsWorld): BodyHandle {
        if (this._world === world && world.hasBody(this._handle)) {
            world.setEnabled(this._handle, true);
            return this._handle;
        }
        const s = this._s;
        const desc = this._desc;
        desc.position = [s[0], s[1], s[2]];
        desc.rotation = [s[3], s[4], s[5], s[6]];
        this._handle = world.createBody(desc);
        this._world = world;
        if (s[V] !== 0 || s[V + 1] !== 0 || s[V + 2] !== 0) world.setLinearVelocity(this._handle, s[V], s[V + 1], s[V + 2]);
        if (s[W] !== 0 || s[W + 1] !== 0 || s[W + 2] !== 0) world.setAngularVelocity(this._handle, s[W], s[W + 1], s[W + 2]);
        this._readAt = -1;
        return this._handle;
    }

    /** @internal Take it out of the simulation, keeping it ready to come back. */
    public _disable(): void {
        if (this._world && this._world.hasBody(this._handle)) this._world.setEnabled(this._handle, false);
    }

    /**
     * @internal Its world is going away or dropping it for good: keep the state it had, forget the handle.
     * `destroy` also removes it from the world (a world being cleared removes everything itself).
     */
    public _release(destroy: boolean): void {
        const world = this._world;
        if (!world) return;
        if (world.hasBody(this._handle)) {
            this._state();
            if (destroy) world.destroyBody(this._handle);
        }
        this._world = null;
        this._handle = -1 as BodyHandle;
        this._readAt = -1;
    }

    private _pushFilter(): void {
        if (this._world) this._world.setCollisionFilter(this._handle, this.collisionFilterGroup, this.collisionFilterMask);
    }
}

function toArray(v: ArrayLike<number> | { x: number; y: number; z: number }): ArrayLike<number> {
    // A cannon Vec3 has a length() METHOD; an array-like has a numeric length.
    return typeof (v as ArrayLike<number>).length === 'number' ? v as ArrayLike<number> : [(v as { x: number }).x, (v as { y: number }).y, (v as { z: number }).z];
}

function xyz(v: readonly number[] | undefined): { x: number; y: number; z: number } {
    return v ? { x: v[0], y: v[1], z: v[2] } : { x: 1, y: 1, z: 1 };
}

/** A shape's own bounds, [min, max], in its frame. */
function localBounds(shape: ShapeDesc): [number[], number[]] {
    const box = (x: number, y: number, z: number): [number[], number[]] => [[-x, -y, -z], [x, y, z]];
    switch (shape.kind) {
        case 'sphere': return box(shape.radius, shape.radius, shape.radius);
        case 'box': return box(shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2]);
        case 'cylinder': { const r = Math.max(shape.radiusTop, shape.radiusBottom); return box(r, shape.height / 2, r); }
        case 'capsule': return box(shape.radius, shape.height / 2 + shape.radius, shape.radius);
        case 'convex': {
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            for (const v of shape.vertices) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
            return [lo, hi];
        }
        case 'trimesh': {
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], sc = shape.scale ?? [1, 1, 1];
            for (let i = 0; i + 2 < shape.positions.length; i += 3)
                for (let k = 0; k < 3; k++) { const v = shape.positions[i + k] * sc[k]; lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); }
            return [lo, hi];
        }
        case 'heightfield': {
            let min = Infinity, max = -Infinity;
            for (const row of shape.heights) for (const h of row) { min = Math.min(min, h); max = Math.max(max, h); }
            const rows = shape.heights.length, cols = rows ? shape.heights[0].length : 0;
            return [[0, min, -(cols - 1) * shape.elementSize], [(rows - 1) * shape.elementSize, max, 0]];
        }
        case 'plane': return box(1e6, 0, 1e6);
    }
}
