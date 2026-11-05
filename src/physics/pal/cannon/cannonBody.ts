import { Body, Vec3 } from 'cannon-es';
import type { BodyOptions } from 'cannon-es';
import { bodyCenterOfMass } from './massProperties';

/**
 * A cannon Body that knows where its NODE sits. cannon has no centre of mass of its own: `body.position`
 * IS the centre of mass, and `shapeOffsets` move only the collision geometry. The layer's convention is
 * the node origin (see ../types.ts), so this keeps the offset between the two — {@link setPosition} adds
 * it on the way in, {@link originPosition} takes it off on the way out — and {@link recenterMass} is what
 * puts the mass where the colliders are.
 */
export class CannonBody extends Body {
    /**
     * Where this body's centre of mass sits relative to the node that owns it, in body-local space.
     * Non-zero once {@link recenterMass} has run on a body whose colliders are offset.
     */
    private readonly _com = new Vec3();
    /** The node-space position this body represents, i.e. `position` with `_com` taken back off. */
    private readonly _origin = new Vec3();
    /** Scratch for the rotated centre of mass; never escapes a method. */
    private static readonly _comWorld = new Vec3();

    constructor(options?: BodyOptions) {
        super(options);
        this._origin.copy(this.position);
    }

    /** The centre of mass in the body's frame, measured from the node origin. Zero unless recentred. */
    public get centerOfMassOffset(): Vec3 { return this._com; }

    /** Put the centre of mass back on the node origin, keeping the node where it is (before shapes are rebuilt). */
    public resetCenterOfMass(): void {
        if (this._com.x === 0 && this._com.y === 0 && this._com.z === 0) return;
        this._captureOrigin();
        this._com.set(0, 0, 0);
        this._syncPosition();
        this.aabbNeedsUpdate = true;
    }

    /**
     * Move the body so the NODE that owns it lands on `position`. With an offset centre of mass the
     * body's own `position` ends up elsewhere — see {@link _com}.
     *
     * Mutates cannon's vectors in place rather than replacing them: they are read every step and handed
     * around by reference, and a fresh object per body per frame is pure garbage.
     */
    public setPosition(position: ArrayLike<number>) {
        const p = this.position, x = p.x, y = p.y, z = p.z;
        this._origin.set(position[0], position[1], position[2]);
        this._syncPosition();
        if (p.x !== x || p.y !== y || p.z !== z) this.aabbNeedsUpdate = true;
    }

    /**
     * Rotate the body about its OWNER'S origin, not about its centre of mass — so a node that rotates
     * stays where it is and its collider swings around it, matching what the editor wireframe draws.
     */
    public setQuaternion(quaternion: ArrayLike<number>) {
        // Re-read the origin from where the body actually IS before turning it, so a rotation applied
        // without a preceding setPosition — a script calling node.rotateY, or animator root motion —
        // pivots about the node's current origin rather than a stale one.
        const p = this.position, x = p.x, y = p.y, z = p.z;
        const q = this.quaternion, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
        this._captureOrigin();
        q.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
        this._syncPosition();
        if (p.x !== x || p.y !== y || p.z !== z || q.x !== qx || q.y !== qy || q.z !== qz || q.w !== qw)
            this.aabbNeedsUpdate = true;
    }

    /** Where the owning node sits, written into `out`: this body's position with {@link _com} taken off. */
    public originPosition<T extends { [i: number]: number }>(out: T): T {
        const com = CannonBody._comWorld;
        this.quaternion.vmult(this._com, com);
        out[0] = this.position.x - com.x;
        out[1] = this.position.y - com.y;
        out[2] = this.position.z - com.z;
        return out;
    }

    /**
     * {@link originPosition} for a pose other than the body's own: `pose` is [px py pz qx qy qz qw], a
     * centre of mass and an orientation (the physics worker's drawn pose, see WorkerExecutor.visualPose).
     */
    public originOf(pose: ArrayLike<number>, out: ArrayLike<number> & { [i: number]: number }): typeof out {
        const c = this._com, qx = pose[3], qy = pose[4], qz = pose[5], qw = pose[6];
        // q · com · q⁻¹, written out (Quaternion.vmult).
        const ix = qw * c.x + qy * c.z - qz * c.y, iy = qw * c.y + qz * c.x - qx * c.z;
        const iz = qw * c.z + qx * c.y - qy * c.x, iw = -qx * c.x - qy * c.y - qz * c.z;
        out[0] = pose[0] - (ix * qw + iw * -qx + iy * -qz - iz * -qy);
        out[1] = pose[1] - (iy * qw + iw * -qy + iz * -qx - ix * -qz);
        out[2] = pose[2] - (iz * qw + iw * -qz + ix * -qy - iy * -qx);
        return out;
    }

    /** Take the node origin back off the body's current position, under its current orientation. */
    private _captureOrigin(): void {
        const com = CannonBody._comWorld;
        this.quaternion.vmult(this._com, com);
        this.position.vsub(com, this._origin);
    }

    /** Place `position` (the centre of mass) from the node origin and the current orientation. */
    private _syncPosition(): void {
        const com = CannonBody._comWorld;
        this.quaternion.vmult(this._com, com);
        this._origin.vadd(com, this.position);
        // The AABB is flagged by the CALLERS, and only when the pose really changed: cannon re-measures a
        // body's box only when IT moved the body (integrate), so a static or sleeping body placed from a
        // script must be flagged — but a set to where the body already is happens every frame for bodies
        // following their nodes, and every flag is a re-measure on the next ray or overlap query.
    }

    /**
     * Move this body's origin onto the volume-weighted centre of its shapes, and recompute its mass
     * properties in the body frame. Call ONCE, after every shape is attached.
     *
     * WHY: cannon has no centre of mass — `body.position` is it, and `shapeOffsets` move only the
     * collision geometry. A collider authored with an offset (which is what the editor fits by default:
     * the mesh's AABB centre, typically half the model's height) therefore left the mass at the node
     * origin with the geometry hanging off it. Gravity, acting at the origin, applies no torque; the
     * ground's normal force, acting at the collider, does — so the body rotated until the
     * origin->collider vector lined up with the contact normal. Objects "stood up" and tilted to match
     * the terrain they landed on. Re-basing the shapes puts the mass inside the collider, where it belongs.
     *
     * The compensation is invisible from outside: `position` shifts by exactly what the shapes move
     * back, and {@link originPosition} undoes it for the caller.
     */
    public recenterMass(): void {
        // A static body never rotates under the solver and its pose is authored, not simulated. Skipping
        // it keeps this off terrain-like colliders entirely.
        if (this.mass <= 0 || this.shapes.length === 0) return;

        const com = bodyCenterOfMass(this.shapes, this.shapeOffsets, this.shapeOrientations);
        if (com.length() > 1e-6) {
            for (const offset of this.shapeOffsets) offset.vsub(com, offset);
            this._com.copy(com);
            this._syncPosition();
        }

        // cannon derives inertia from the body's WORLD aabb, and `Node.setBody` creates the body already
        // at its authored orientation — so an author-time rotation used to bake a skewed, oversized
        // tensor into the body frame. Measure it with the rotation taken out, then put the rotation back.
        const qx = this.quaternion.x, qy = this.quaternion.y, qz = this.quaternion.z, qw = this.quaternion.w;
        this.quaternion.set(0, 0, 0, 1);
        this.updateMassProperties();
        this.quaternion.set(qx, qy, qz, qw);
        this.updateInertiaWorld(true);

        this.updateBoundingRadius();
        this.aabbNeedsUpdate = true;
    }
}
