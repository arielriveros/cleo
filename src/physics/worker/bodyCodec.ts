import {
    Body, Box, ConeTwistConstraint, Constraint, ConvexPolyhedron, Cylinder, Heightfield, HingeConstraint, LockConstraint,
    Particle, Plane, PointToPointConstraint, Quaternion, Shape, Sphere, Trimesh, Vec3,
} from 'cannon-es';
import type { BodyConfig, ConstraintDef, ShapeDef, ShapeRef } from './protocol';
import { STATE_STRIDE } from './protocol';

// Bodies, shapes and constraints as plain data, and back. Both halves live here so they cannot drift:
// the main thread ENCODES what is in its (mirror) world, the worker DECODES it into its own. Rebuilt
// objects must step exactly like the originals, so everything that feeds the solver travels — inertia
// included, which a body cannot recompute the same way (RigidBody.recenterMass measures it unrotated).
// A leaf: cannon-es only.

// cannon's Shape.types.
const SPHERE = 1, PLANE = 2, BOX = 4, CONVEX = 16, HEIGHTFIELD = 32, PARTICLE = 64, CYLINDER = 128, TRIMESH = 256;

// ---------------------------------------------------------------------------------------------------
// Shapes

export function encodeShape(shape: Shape): ShapeDef | null {
    const s = shape as any;
    switch (shape.type) {
        case SPHERE: return { t: 'sphere', r: s.radius };
        case BOX: return { t: 'box', h: [s.halfExtents.x, s.halfExtents.y, s.halfExtents.z] };
        case CYLINDER: return { t: 'cylinder', rt: s.radiusTop, rb: s.radiusBottom, h: s.height, n: s.numSegments };
        case CONVEX: {
            const v = new Float64Array(s.vertices.length * 3);
            s.vertices.forEach((p: Vec3, i: number) => { v[i * 3] = p.x; v[i * 3 + 1] = p.y; v[i * 3 + 2] = p.z; });
            let axes: Float64Array | null = null;
            if (s.uniqueAxes) {
                axes = new Float64Array(s.uniqueAxes.length * 3);
                s.uniqueAxes.forEach((p: Vec3, i: number) => { axes![i * 3] = p.x; axes![i * 3 + 1] = p.y; axes![i * 3 + 2] = p.z; });
            }
            return { t: 'convex', v, f: s.faces.map((f: number[]) => [...f]), axes };
        }
        case PLANE: return { t: 'plane' };
        case PARTICLE: return { t: 'particle' };
        case HEIGHTFIELD: {
            const rows = s.data.length, cols = rows ? s.data[0].length : 0;
            const data = new Float64Array(rows * cols);
            for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) data[i * cols + j] = s.data[i][j];
            return { t: 'heightfield', data, rows, cols, elementSize: s.elementSize, min: s.minValue, max: s.maxValue };
        }
        case TRIMESH:
            return { t: 'trimesh', v: new Float32Array(s.vertices), i: Int32Array.from(s.indices), scale: [s.scale.x, s.scale.y, s.scale.z] };
        default:
            return null;
    }
}

export function decodeShape(def: ShapeDef): Shape {
    switch (def.t) {
        case 'sphere': return new Sphere(def.r);
        case 'box': return new Box(new Vec3(def.h[0], def.h[1], def.h[2]));
        case 'cylinder': return new Cylinder(def.rt, def.rb, def.h, def.n);
        case 'convex': {
            const vertices: Vec3[] = [];
            for (let i = 0; i < def.v.length; i += 3) vertices.push(new Vec3(def.v[i], def.v[i + 1], def.v[i + 2]));
            const axes: Vec3[] | undefined = def.axes ? [] : undefined;
            if (def.axes) for (let i = 0; i < def.axes.length; i += 3) axes!.push(new Vec3(def.axes[i], def.axes[i + 1], def.axes[i + 2]));
            return new ConvexPolyhedron({ vertices, faces: def.f, axes });
        }
        case 'plane': return new Plane();
        case 'particle': return new Particle();
        case 'heightfield': {
            const data: number[][] = [];
            for (let i = 0; i < def.rows; i++) {
                const row: number[] = [];
                for (let j = 0; j < def.cols; j++) row.push(def.data[i * def.cols + j]);
                data.push(row);
            }
            return new Heightfield(data, { elementSize: def.elementSize, minValue: def.min, maxValue: def.max });
        }
        case 'trimesh': {
            const mesh = new Trimesh(Array.from(def.v), Array.from(def.i));
            mesh.setScale(new Vec3(def.scale[0], def.scale[1], def.scale[2]));
            return mesh;
        }
    }
}

/** Typed arrays a shape definition holds, for the transfer list. */
export function shapeBuffers(def: ShapeDef | undefined): ArrayBuffer[] {
    if (!def) return [];
    switch (def.t) {
        case 'convex': return def.axes ? [def.v.buffer as ArrayBuffer, def.axes.buffer as ArrayBuffer] : [def.v.buffer as ArrayBuffer];
        case 'heightfield': return [def.data.buffer as ArrayBuffer];
        case 'trimesh': return [def.v.buffer as ArrayBuffer, def.i.buffer as ArrayBuffer];
        default: return [];
    }
}

// ---------------------------------------------------------------------------------------------------
// Bodies

/**
 * A body's configuration. `known` says which shape ids the worker already has; a new one carries its
 * definition and is added to the set.
 */
export function encodeConfig(body: Body, known: Set<number>, wantsCollide: boolean): BodyConfig {
    const b = body as any;
    const shapes: ShapeRef[] = body.shapes.map((shape, i) => {
        const o = body.shapeOffsets[i], q = body.shapeOrientations[i];
        const def = known.has(shape.id) ? undefined : encodeShape(shape) ?? undefined;
        if (def) known.add(shape.id);
        return {
            id: shape.id, def, offset: [o.x, o.y, o.z], orient: [q.x, q.y, q.z, q.w],
            collisionResponse: shape.collisionResponse, group: shape.collisionFilterGroup, mask: shape.collisionFilterMask,
        };
    });
    return {
        type: body.type, mass: body.mass,
        inertia: [body.inertia.x, body.inertia.y, body.inertia.z],
        invInertia: [body.invInertia.x, body.invInertia.y, body.invInertia.z],
        invInertiaWorld: [...body.invInertiaWorld.elements],
        linearDamping: body.linearDamping, angularDamping: body.angularDamping,
        linearFactor: [body.linearFactor.x, body.linearFactor.y, body.linearFactor.z],
        angularFactor: [body.angularFactor.x, body.angularFactor.y, body.angularFactor.z],
        fixedRotation: body.fixedRotation, allowSleep: body.allowSleep,
        sleepSpeedLimit: body.sleepSpeedLimit, sleepTimeLimit: body.sleepTimeLimit,
        collisionResponse: body.collisionResponse, group: body.collisionFilterGroup, mask: body.collisionFilterMask,
        isTrigger: body.isTrigger, material: body.material?.name ?? null,
        character: b.owner?.nodeType === 'character', wantsCollide, shapes,
    };
}

/** A body's state into `out` at `offset`: pose, velocities, accumulated force/torque, sleep state. */
export function readState(body: Body, out: Float64Array, offset: number): void {
    const p = body.position, q = body.quaternion, v = body.velocity, w = body.angularVelocity, f = body.force, t = body.torque;
    out[offset] = p.x; out[offset + 1] = p.y; out[offset + 2] = p.z;
    out[offset + 3] = q.x; out[offset + 4] = q.y; out[offset + 5] = q.z; out[offset + 6] = q.w;
    out[offset + 7] = v.x; out[offset + 8] = v.y; out[offset + 9] = v.z;
    out[offset + 10] = w.x; out[offset + 11] = w.y; out[offset + 12] = w.z;
    out[offset + 13] = f.x; out[offset + 14] = f.y; out[offset + 15] = f.z;
    out[offset + 16] = t.x; out[offset + 17] = t.y; out[offset + 18] = t.z;
    out[offset + 19] = body.sleepState;
}

/** Apply a config to a body (a new one, or one the main thread reconfigured). Shapes are resolved by `shapeOf`. */
export function applyConfig(body: Body, config: BodyConfig, shapeOf: (ref: ShapeRef) => Shape, materialOf: (key: string | null) => any): void {
    body.mass = config.mass;
    body.type = config.type as any;
    body.linearDamping = config.linearDamping;
    body.angularDamping = config.angularDamping;
    body.linearFactor.set(...config.linearFactor);
    body.angularFactor.set(...config.angularFactor);
    body.fixedRotation = config.fixedRotation;
    body.allowSleep = config.allowSleep;
    body.sleepSpeedLimit = config.sleepSpeedLimit;
    body.sleepTimeLimit = config.sleepTimeLimit;
    body.collisionResponse = config.collisionResponse;
    body.collisionFilterGroup = config.group;
    body.collisionFilterMask = config.mask;
    body.isTrigger = config.isTrigger;
    body.material = materialOf(config.material);
    (body as any).__character = config.character;

    // Shapes: rebuilt only when they differ from what the body holds.
    const same = body.shapes.length === config.shapes.length
        && config.shapes.every((r, i) => (body.shapes[i] as any).__mainId === r.id);
    if (!same) {
        for (let i = body.shapes.length - 1; i >= 0; i--) body.removeShape(body.shapes[i]);
        for (const ref of config.shapes) {
            const shape = shapeOf(ref);
            body.addShape(shape, new Vec3(...ref.offset), new Quaternion(...ref.orient));
        }
    } else {
        config.shapes.forEach((ref, i) => {
            body.shapeOffsets[i].set(...ref.offset);
            body.shapeOrientations[i].set(...ref.orient);
        });
    }
    config.shapes.forEach((ref, i) => {
        const shape = body.shapes[i];
        shape.collisionResponse = ref.collisionResponse;
        shape.collisionFilterGroup = ref.group;
        shape.collisionFilterMask = ref.mask;
    });
    body.updateMassProperties();
    body.updateBoundingRadius();
    // The main thread's inertia, not one recomputed here (see the header).
    body.inertia.set(...config.inertia);
    body.invInertia.set(...config.invInertia);
    const e = body.invInertiaWorld.elements;
    for (let i = 0; i < 9; i++) e[i] = config.invInertiaWorld[i];
    body.aabbNeedsUpdate = true;
}

/** Write a packed state row into a body; `mask` (protocol WRITE_*) says which parts, -1 for all. */
export function writeState(body: Body, row: ArrayLike<number>, offset: number, mask: number): void {
    if (mask & 1) {
        body.position.set(row[offset], row[offset + 1], row[offset + 2]);
        body.quaternion.set(row[offset + 3], row[offset + 4], row[offset + 5], row[offset + 6]);
        body.aabbNeedsUpdate = true;
    }
    if (mask & 2) body.velocity.set(row[offset + 7], row[offset + 8], row[offset + 9]);
    if (mask & 4) body.angularVelocity.set(row[offset + 10], row[offset + 11], row[offset + 12]);
    if (mask & 8) body.force.set(row[offset + 13], row[offset + 14], row[offset + 15]);
    if (mask & 16) body.torque.set(row[offset + 16], row[offset + 17], row[offset + 18]);
    if (mask & 32) {
        const sleep = row[offset + 19];
        if (sleep !== body.sleepState) {
            if (sleep === Body.SLEEPING) body.sleep();
            else body.wakeUp();
            body.sleepState = sleep as any;
        }
    }
}

export { STATE_STRIDE };

// ---------------------------------------------------------------------------------------------------
// Constraints

/** A constraint between two bodies with slots, or null for a kind this codec does not carry. */
export function encodeConstraint(c: Constraint, slotOf: (b: Body) => number | undefined): ConstraintDef | null {
    const a = slotOf(c.bodyA), b = slotOf(c.bodyB);
    if (a === undefined || b === undefined) return null;
    const v = (x: Vec3) => [x.x, x.y, x.z];
    const maxForce = c.equations[0]?.maxForce ?? 1e6;
    const collide = c.collideConnected;
    const k = c as any;
    // Most specific first: LockConstraint extends PointToPointConstraint, ConeTwist does too.
    if (c instanceof LockConstraint) {
        const frame = ['pivotA', 'pivotB', 'xA', 'xB', 'yA', 'yB', 'zA', 'zB'].flatMap(key => v(k[key]));
        return { t: 'lock', a, b, maxForce, collide, frame };
    }
    if (c instanceof ConeTwistConstraint)
        return { t: 'cone', a, b, pivotA: v(k.pivotA), pivotB: v(k.pivotB), axisA: v(k.axisA), axisB: v(k.axisB), angle: k.angle, twist: k.twistAngle, maxForce, collide };
    if (c instanceof HingeConstraint)
        return { t: 'hinge', a, b, pivotA: v(k.pivotA), pivotB: v(k.pivotB), axisA: v(k.axisA), axisB: v(k.axisB), maxForce, collide };
    if (c instanceof PointToPointConstraint)
        return { t: 'p2p', a, b, pivotA: v(k.pivotA), pivotB: v(k.pivotB), maxForce, collide };
    return null;
}

export function decodeConstraint(def: ConstraintDef, bodyOf: (slot: number) => Body): Constraint {
    const a = bodyOf(def.a), b = bodyOf(def.b);
    const v = (x: number[]) => new Vec3(x[0], x[1], x[2]);
    switch (def.t) {
        case 'lock': {
            const c = new LockConstraint(a, b, { maxForce: def.maxForce, collideConnected: def.collide } as any) as any;
            // The frame the main thread's lock measured, not one measured again here (see ConstraintDef).
            ['pivotA', 'pivotB', 'xA', 'xB', 'yA', 'yB', 'zA', 'zB'].forEach((key, i) => c[key].set(def.frame[i * 3], def.frame[i * 3 + 1], def.frame[i * 3 + 2]));
            return c;
        }
        case 'cone': return new ConeTwistConstraint(a, b, {
            pivotA: v(def.pivotA), pivotB: v(def.pivotB), axisA: v(def.axisA), axisB: v(def.axisB),
            angle: def.angle, twistAngle: def.twist, maxForce: def.maxForce, collideConnected: def.collide,
        });
        case 'hinge': {
            const c = new HingeConstraint(a, b, {
                pivotA: v(def.pivotA), pivotB: v(def.pivotB), axisA: v(def.axisA), axisB: v(def.axisB),
                maxForce: def.maxForce, collideConnected: def.collide,
            });
            // The constructor normalizes its axes; these already were, and normalizing again can move a bit.
            c.axisA.set(def.axisA[0], def.axisA[1], def.axisA[2]);
            c.axisB.set(def.axisB[0], def.axisB[1], def.axisB[2]);
            return c;
        }
        case 'p2p': {
            const c = new PointToPointConstraint(a, v(def.pivotA), b, v(def.pivotB), def.maxForce);
            c.collideConnected = def.collide;
            return c;
        }
    }
}
