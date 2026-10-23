/**
 * A faster `ConvexPolyhedron.findSeparatingAxis` for cannon-es: the separating-axis test behind every
 * convex-convex contact (box/cylinder/hull against box/cylinder/hull, and the convex-vs-pillar half of a
 * convex on a heightfield).
 *
 * ## Why
 *
 * Measured in the Valley (Electron, WebGL2): `ConvexPolyhedron.project` was 37% of ALL physics time, its
 * single biggest self-time entry — characters' capsules (a 16-sided cylinder plus two spheres) leaning on
 * barrels, trunks and each other, and the pond's floaters bumping. A 16-gon prism against a 12-gon one
 * tests 32 face normals and 9 x 7 = 63 edge-edge crosses, projecting all 56 vertices on each, and stock
 * cannon does it with a Vec3 method call per vertex, two frame transforms per projection, six fresh Vec3s
 * per call and the inner edge re-rotated for every outer one.
 *
 * ## What is different, and what is not
 *
 * The axes tested, their order, the depth measured on each and the axis kept are exactly cannon's —
 * except that an axis PARALLEL to one already tested is skipped. Its projections are identical (same
 * overlap, or the same separation, which would already have returned), so skipping it cannot change the
 * answer; and for two upright prisms it is nearly all of the edge-edge work: a horizontal edge crossed with
 * a horizontal edge is the vertical axis, already tested as a cap normal, and a vertical edge crossed with a
 * ring edge is one of the side normals, again already tested. Opposite side faces of a prism are parallel
 * too, which halves the face tests.
 *
 * Projections use the hull's vertices flattened once into a typed array (cached per shape, rebuilt if the
 * vertex count changes), the axis rotated into the hull's frame once per axis, and no allocation per call.
 */

import { ConvexPolyhedron, type Quaternion, type Vec3 } from 'cannon-es';

/** Hull -> its local vertices as xyz triples. */
const flat = new WeakMap<ConvexPolyhedron, Float64Array>();

function verticesOf(hull: ConvexPolyhedron): Float64Array {
    const vs = hull.vertices;
    let f = flat.get(hull);
    if (!f || f.length !== vs.length * 3) {
        f = new Float64Array(vs.length * 3);
        flat.set(hull, f);
    }
    // Refreshed every call: cheap next to the projections, and a hull's vertices CAN be edited in place
    // (scaling a collider rewrites them), which a cache keyed on the count alone would miss.
    for (let i = 0; i < vs.length; i++) { const v = vs[i]; f[i * 3] = v.x; f[i * 3 + 1] = v.y; f[i * 3 + 2] = v.z; }
    return f;
}

// The pair under test, set once per findSeparatingAxis call.
let vA: Float64Array = new Float64Array(0), vB: Float64Array = new Float64Array(0);
let qA: Quaternion, qB: Quaternion, pA: Vec3, pB: Vec3;
/** Axes tested so far this call, xyz triples, for the parallel skip. */
let tested = new Float64Array(3 * 256);
let testedCount = 0;
let dmin = 0, tx = 0, ty = 0, tz = 0;
/** Two axes closer than this to parallel (|cos|) project identically for our purposes. */
const PARALLEL = 1 - 1e-9;

/** Max/min of `verts` (local) on world axis (x, y, z), for a hull at `p`, `q`. Written to projMax/projMin. */
let projMax = 0, projMin = 0;
function project(verts: Float64Array, p: Vec3, q: Quaternion, x: number, y: number, z: number): void {
    // The axis into the hull's frame: conjugate(q) * axis.
    const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    const lx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    const ly = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    const lz = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    let max = -Infinity, min = Infinity;
    for (let i = 0; i < verts.length; i += 3) {
        const d = verts[i] * lx + verts[i + 1] * ly + verts[i + 2] * lz;
        if (d > max) max = d;
        if (d < min) min = d;
    }
    const add = p.x * x + p.y * y + p.z * z;
    projMax = max + add;
    projMin = min + add;
}

/**
 * Test world axis (x, y, z), unit length. Returns false when it separates the pair; otherwise updates the
 * running minimum overlap and returns true. Parallel repeats are skipped (true, nothing changes).
 */
function testAxis(x: number, y: number, z: number): boolean {
    for (let k = 0; k < testedCount * 3; k += 3)
        if (Math.abs(tested[k] * x + tested[k + 1] * y + tested[k + 2] * z) > PARALLEL) return true;
    if (testedCount * 3 >= tested.length) {
        const grown = new Float64Array(tested.length * 2);
        grown.set(tested);
        tested = grown;
    }
    tested[testedCount * 3] = x; tested[testedCount * 3 + 1] = y; tested[testedCount * 3 + 2] = z;
    testedCount++;

    project(vA, pA, qA, x, y, z);
    const maxA = projMax, minA = projMin;
    project(vB, pB, qB, x, y, z);
    const maxB = projMax, minB = projMin;
    if (maxA < minB || maxB < minA) return false;
    const d0 = maxA - minB, d1 = maxB - minA;
    const depth = d0 < d1 ? d0 : d1;
    if (depth < dmin) { dmin = depth; tx = x; ty = y; tz = z; }
    return true;
}

/** `q * v` for a cannon Quaternion and a Vec3, into the module scratch rx/ry/rz. */
let rx = 0, ry = 0, rz = 0;
function rotate(q: Quaternion, v: Vec3): void {
    const x = v.x, y = v.y, z = v.z;
    const ix = q.w * x + q.y * z - q.z * y;
    const iy = q.w * y + q.z * x - q.x * z;
    const iz = q.w * z + q.x * y - q.y * x;
    const iw = -q.x * x - q.y * y - q.z * z;
    rx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
    ry = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
    rz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
}

let edgesB = new Float64Array(3 * 64);

function findSeparatingAxis(this: ConvexPolyhedron, hullB: ConvexPolyhedron, posA: Vec3, quatA: Quaternion,
                            posB: Vec3, quatB: Quaternion, target: Vec3,
                            faceListA?: number[] | null, faceListB?: number[] | null): boolean {
    const hullA = this;
    vA = verticesOf(hullA); vB = verticesOf(hullB);
    qA = quatA; qB = quatB; pA = posA; pB = posB;
    testedCount = 0;
    dmin = Number.MAX_VALUE;
    tx = 0; ty = 0; tz = 0;

    // Face normals (or the hull's declared unique axes) of A, then of B — cannon's order.
    if (!hullA.uniqueAxes) {
        const n = faceListA ? faceListA.length : hullA.faces.length;
        for (let i = 0; i < n; i++) {
            rotate(quatA, hullA.faceNormals[faceListA ? faceListA[i] : i]);
            if (!testAxis(rx, ry, rz)) return false;
        }
    } else {
        for (let i = 0; i !== hullA.uniqueAxes.length; i++) {
            rotate(quatA, hullA.uniqueAxes[i]);
            if (!testAxis(rx, ry, rz)) return false;
        }
    }
    if (!hullB.uniqueAxes) {
        const n = faceListB ? faceListB.length : hullB.faces.length;
        for (let i = 0; i < n; i++) {
            rotate(quatB, hullB.faceNormals[faceListB ? faceListB[i] : i]);
            if (!testAxis(rx, ry, rz)) return false;
        }
    } else {
        for (let i = 0; i !== hullB.uniqueAxes.length; i++) {
            rotate(quatB, hullB.uniqueAxes[i]);
            if (!testAxis(rx, ry, rz)) return false;
        }
    }

    // Edge-edge crosses. B's edges rotated once, not once per edge of A.
    const eb = hullB.uniqueEdges;
    if (edgesB.length < eb.length * 3) edgesB = new Float64Array(eb.length * 3);
    for (let j = 0; j < eb.length; j++) { rotate(quatB, eb[j]); edgesB[j * 3] = rx; edgesB[j * 3 + 1] = ry; edgesB[j * 3 + 2] = rz; }
    const ea = hullA.uniqueEdges;
    for (let i = 0; i !== ea.length; i++) {
        rotate(quatA, ea[i]);
        const ax = rx, ay = ry, az = rz;
        for (let j = 0; j !== eb.length; j++) {
            const bx = edgesB[j * 3], by = edgesB[j * 3 + 1], bz = edgesB[j * 3 + 2];
            let cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
            // cannon's Vec3.almostZero: every component within 1e-6.
            if (Math.abs(cx) <= 1e-6 && Math.abs(cy) <= 1e-6 && Math.abs(cz) <= 1e-6) continue;
            const l = Math.sqrt(cx * cx + cy * cy + cz * cz);
            cx /= l; cy /= l; cz /= l;
            if (!testAxis(cx, cy, cz)) return false;
        }
    }

    // Pointing from B toward A, as cannon leaves it.
    if ((posB.x - posA.x) * tx + (posB.y - posA.y) * ty + (posB.z - posA.z) * tz > 0) { tx = -tx; ty = -ty; tz = -tz; }
    target.set(tx, ty, tz);
    return true;
}

let installed = false;

/** Replace cannon's findSeparatingAxis (a prototype method, so every world at once). Idempotent. */
export function installConvexSat(): void {
    if (installed) return;
    installed = true;
    (ConvexPolyhedron.prototype as unknown as { findSeparatingAxis: typeof findSeparatingAxis }).findSeparatingAxis = findSeparatingAxis;
}

/** The stock implementation, kept for the parity tests. */
export const stockFindSeparatingAxis = ConvexPolyhedron.prototype.findSeparatingAxis;
export { findSeparatingAxis as fastFindSeparatingAxis };
