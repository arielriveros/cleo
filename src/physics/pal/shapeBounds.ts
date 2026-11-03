import type { ColliderDesc, Out, ShapeDesc } from './types';

// Bounds measured from shape DESCRIPTIONS (types.ts), in the layer's conventions, for any backend: a body's
// box out of a world (PhysicsBody.getAabb), and a backend that keeps its colliders' descriptions (Rapier).

/** A shape's box in its own frame, [min, max]. A plane is a thin, very wide box. */
export function localBounds(shape: ShapeDesc): [number[], number[]] {
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

/** `v` turned by the quaternion `q` ([x y z w]), into `out`. */
export function rotate(q: ArrayLike<number>, x: number, y: number, z: number, out: Out): Out {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    // t = 2 q×v; v' = v + w t + q×t
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
    return out;
}

/** `a · b` as quaternions ([x y z w]), into `out`. */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Out): Out {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}

const _turn = [0, 0, 0, 1], _corner = [0, 0, 0], _off = [0, 0, 0];

/**
 * The world box of colliders on a body at `pose` ([px py pz qx qy qz qw], the node origin): each shape's
 * local box turned and placed, min [3] then max [3] into `out`. A body without colliders is its own point.
 */
export function collidersAabb(colliders: readonly ColliderDesc[], pose: ArrayLike<number>, out: Out): Out {
    out[0] = out[1] = out[2] = Infinity; out[3] = out[4] = out[5] = -Infinity;
    for (const c of colliders) {
        const [lo, hi] = localBounds(c.shape);
        const r = c.rotation ?? [0, 0, 0, 1], o = c.offset ?? [0, 0, 0];
        multiply([pose[3], pose[4], pose[5], pose[6]], r, _turn);
        rotate([pose[3], pose[4], pose[5], pose[6]], o[0], o[1], o[2], _off);
        for (let i = 0; i < 8; i++) {
            rotate(_turn, i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2], _corner);
            for (let k = 0; k < 3; k++) {
                const v = pose[k] + _off[k] + _corner[k];
                if (v < out[k]) out[k] = v;
                if (v > out[k + 3]) out[k + 3] = v;
            }
        }
    }
    if (out[0] === Infinity) { out[0] = out[3] = pose[0]; out[1] = out[4] = pose[1]; out[2] = out[5] = pose[2]; }
    return out;
}
