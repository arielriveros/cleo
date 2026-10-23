import { Body, ConvexPolyhedron, Heightfield, Quaternion, Ray, Shape, Sphere, Transform, Vec3, World } from 'cannon-es';

/**
 * Terrain collision that only ever looks at the part of the heightfield a body is touching.
 *
 * ## What cannon does, and why it cost what it did
 *
 * cannon-es already narrows a heightfield contact to the cells under a body, but three things made those
 * few cells expensive on a real landscape (measured against the Valley: 2049x2049 samples, 1 m cells,
 * heights from -1 to 430 m):
 *
 * 1. **Every pillar reached the field's GLOBAL minimum.** A cell is tested as a triangular prism whose
 *    floor sits at the lowest height anywhere in the field, so on a 300 m hillside each prism was 300 m
 *    tall, its bounding sphere ~150 m, and the bounding-sphere cull in front of every SAT test could never
 *    reject anything. Every cell in range paid a full convex-vs-convex separating-axis test.
 * 2. **No per-cell height test.** A capsule's 16-segment cylinder hovering 0.3 m above flat ground was
 *    SAT-tested against every cell under it, every substep, though it could not touch any of them.
 * 3. **An unbounded, string-keyed pillar cache** — one `ConvexPolyhedron` per cell ever visited, never
 *    evicted, keyed by a template string built per lookup.
 *
 * Rays were worse: `Ray._intersectHeightfield` walked the ray's whole XY bounding RECTANGLE (a 20 m
 * diagonal line of sight is ~400 cells) and allocated per call.
 *
 * ## What this does instead
 *
 * - The cell range comes from the shape's AABB in heightfield space, without cannon's extra ring.
 * - A triangle whose highest corner is below the shape (or whose pillar floor is above it) is skipped
 *   before anything else is built. On level ground that removes the capsule's cylinder entirely.
 * - Pillars are SHALLOW: the triangle down to its own lowest corner minus {@link PILLAR_DEPTH}, so the
 *   bounding-sphere cull works again. A body pushed deeper than that into the ground is not recovered —
 *   cannon's ran to the field minimum, so this is the one place the two can disagree.
 * - Spheres (the capsule's two caps, every sphere collider) are tested directly against the triangles:
 *   closest point on the triangle, or the face normal when the centre has sunk below the surface.
 * - The pillar cache is per shape, integer-keyed and bounded (LRU).
 * - Rays walk only the cells the segment crosses (a 2D DDA), clip to the field's height range first, and
 *   reject a cell whose height range the segment does not reach before testing its two triangles.
 *
 * Everything is installed by REPLACING cannon's resolvers, never by editing the bundle: the narrowphase
 * reads `sphereHeightfield` & co. through getters off the instance (`cannon-es.js`, Narrowphase), and the
 * ray reads `_intersectHeightfield` through a getter off its prototype. See {@link installHeightfieldCollision}.
 */

/** How far a pillar extends below its triangle's lowest corner, in field units (metres here). */
export const PILLAR_DEPTH = 4;
/** Pillars kept per heightfield. Each is a 6-vertex ConvexPolyhedron, ~1-2 KB. */
export const PILLAR_CACHE_LIMIT = 2048;
/** Contacts one sphere may take from one heightfield in one step. */
const MAX_SPHERE_CONTACTS = 4;
/** Slack on the per-triangle height cull, so a contact about to form is never culled a step early. */
const HEIGHT_MARGIN = 0.05;

interface PillarEntry { convex: ConvexPolyhedron; offset: Vec3 }

/** Per-heightfield state that cannon's shape does not carry. Rebuilt whenever the shape is replaced. */
interface FieldAccel {
    nx: number;
    ny: number;
    pillars: Map<number, PillarEntry>;
}

const accelByShape = new WeakMap<Heightfield, FieldAccel>();

function accelOf(shape: Heightfield): FieldAccel {
    let accel = accelByShape.get(shape);
    if (!accel || accel.nx !== shape.data.length) {
        accel = { nx: shape.data.length, ny: shape.data[0]?.length ?? 0, pillars: new Map() };
        accelByShape.set(shape, accel);
    }
    return accel;
}

/** Drop a field's cached pillars. Call after editing its `data` in place. */
export function invalidateHeightfieldCache(shape: Heightfield): void {
    accelByShape.delete(shape);
}

/** How many pillars a field currently caches. For tests and the stats panel. */
export function cachedPillarCount(shape: Heightfield): number {
    return accelByShape.get(shape)?.pillars.size ?? 0;
}

// ---- Triangles ----------------------------------------------------------------------------------------
//
// A cell (i, j) holds two triangles, exactly as cannon splits it:
//   lower: (i, j)     (i+1, j)   (i, j+1)
//   upper: (i+1, j+1) (i, j+1)   (i+1, j)
// Both wind so their normal points along +Z, the field's "up".

/** Write triangle (i, j, upper)'s three corners, in field-local space, into a/b/c. */
function triangle(data: number[][], w: number, i: number, j: number, upper: boolean, a: Vec3, b: Vec3, c: Vec3): void {
    if (upper) {
        a.set((i + 1) * w, (j + 1) * w, data[i + 1][j + 1]);
        b.set(i * w, (j + 1) * w, data[i][j + 1]);
        c.set((i + 1) * w, j * w, data[i + 1][j]);
    } else {
        a.set(i * w, j * w, data[i][j]);
        b.set((i + 1) * w, j * w, data[i + 1][j]);
        c.set(i * w, (j + 1) * w, data[i][j + 1]);
    }
}

/** Lowest and highest corner height of a triangle, without building it. */
function triangleRange(data: number[][], i: number, j: number, upper: boolean, out: [number, number]): void {
    let h0: number, h1: number, h2: number;
    if (upper) { h0 = data[i + 1][j + 1]; h1 = data[i][j + 1]; h2 = data[i + 1][j]; }
    else { h0 = data[i][j]; h1 = data[i + 1][j]; h2 = data[i][j + 1]; }
    out[0] = Math.min(h0, h1, h2);
    out[1] = Math.max(h0, h1, h2);
}

// ---- Shallow pillars ----------------------------------------------------------------------------------

/**
 * Triangle (i, j, upper) as a convex prism from its surface down to `min - PILLAR_DEPTH`, centred on
 * `offset` (field-local). Same vertex order and faces as cannon's `getConvexTrianglePillar`, so
 * `convexConvex` sees the shape it was written against — only the floor moved.
 */
function pillar(shape: Heightfield, accel: FieldAccel, i: number, j: number, upper: boolean): PillarEntry {
    const key = (j * accel.nx + i) * 2 + (upper ? 1 : 0);
    const cache = accel.pillars;
    const hit = cache.get(key);
    if (hit) {
        // Map order is insertion order, so re-inserting is what makes eviction least-recently-used.
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }

    const data = shape.data, w = shape.elementSize;
    const convex = new ConvexPolyhedron();
    const offset = new Vec3();
    const verts: Vec3[] = [];
    for (let k = 0; k < 6; k++) verts.push(new Vec3());

    let h0: number, h1: number, h2: number;
    if (upper) { h0 = data[i + 1][j + 1]; h1 = data[i][j + 1]; h2 = data[i + 1][j]; }
    else { h0 = data[i][j]; h1 = data[i + 1][j]; h2 = data[i][j + 1]; }
    const floor = Math.min(h0, h1, h2) - PILLAR_DEPTH;
    const top = Math.max(h0, h1, h2);
    const mid = (floor + top) / 2;

    if (!upper) {
        offset.set((i + 0.25) * w, (j + 0.25) * w, mid);
        verts[0].set(-0.25 * w, -0.25 * w, h0 - mid);
        verts[1].set(0.75 * w, -0.25 * w, h1 - mid);
        verts[2].set(-0.25 * w, 0.75 * w, h2 - mid);
        verts[3].set(-0.25 * w, -0.25 * w, floor - mid);
        verts[4].set(0.75 * w, -0.25 * w, floor - mid);
        verts[5].set(-0.25 * w, 0.75 * w, floor - mid);
        convex.faces = [[0, 1, 2], [5, 4, 3], [0, 2, 5, 3], [1, 0, 3, 4], [4, 5, 2, 1]];
    } else {
        offset.set((i + 0.75) * w, (j + 0.75) * w, mid);
        verts[0].set(0.25 * w, 0.25 * w, h0 - mid);
        verts[1].set(-0.75 * w, 0.25 * w, h1 - mid);
        verts[2].set(0.25 * w, -0.75 * w, h2 - mid);
        verts[3].set(0.25 * w, 0.25 * w, floor - mid);
        verts[4].set(-0.75 * w, 0.25 * w, floor - mid);
        verts[5].set(0.25 * w, -0.75 * w, floor - mid);
        convex.faces = [[0, 1, 2], [5, 4, 3], [2, 5, 3, 0], [3, 4, 1, 0], [1, 4, 5, 2]];
    }
    convex.vertices = verts;
    convex.computeNormals();
    convex.computeEdges();
    convex.updateBoundingSphereRadius();

    const entry = { convex, offset };
    cache.set(key, entry);
    if (cache.size > PILLAR_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return entry;
}

// ---- Shared range computation -------------------------------------------------------------------------

const _aabbMin = new Vec3();
const _aabbMax = new Vec3();
const _corner = new Vec3();
const _cornerLocal = new Vec3();
const _localMin = new Vec3();
const _localMax = new Vec3();

/**
 * The shape's world AABB, re-expressed as an AABB in the field's local frame (8 corners transformed).
 * Writes `_localMin` / `_localMax`.
 */
function localBounds(shape: Shape, pos: Vec3, quat: Quaternion, hfPos: Vec3, hfQuat: Quaternion): void {
    (shape as any).calculateWorldAABB(pos, quat, _aabbMin, _aabbMax);
    _localMin.set(Infinity, Infinity, Infinity);
    _localMax.set(-Infinity, -Infinity, -Infinity);
    for (let k = 0; k < 8; k++) {
        _corner.set(k & 1 ? _aabbMax.x : _aabbMin.x, k & 2 ? _aabbMax.y : _aabbMin.y, k & 4 ? _aabbMax.z : _aabbMin.z);
        Transform.pointToLocalFrame(hfPos, hfQuat, _corner, _cornerLocal);
        if (_cornerLocal.x < _localMin.x) _localMin.x = _cornerLocal.x;
        if (_cornerLocal.y < _localMin.y) _localMin.y = _cornerLocal.y;
        if (_cornerLocal.z < _localMin.z) _localMin.z = _cornerLocal.z;
        if (_cornerLocal.x > _localMax.x) _localMax.x = _cornerLocal.x;
        if (_cornerLocal.y > _localMax.y) _localMax.y = _cornerLocal.y;
        if (_cornerLocal.z > _localMax.z) _localMax.z = _cornerLocal.z;
    }
}

/** Cells overlapped by a local XY box, clamped to the field: [iMin, iMax] x [jMin, jMax], inclusive. */
interface CellRange { iMin: number; iMax: number; jMin: number; jMax: number }
const _range: CellRange = { iMin: 0, iMax: -1, jMin: 0, jMax: -1 };

function cellRange(shape: Heightfield, minX: number, minY: number, maxX: number, maxY: number): CellRange | null {
    const w = shape.elementSize;
    const cellsX = shape.data.length - 1, cellsY = shape.data[0].length - 1;
    const iMin = Math.max(0, Math.floor(minX / w)), iMax = Math.min(cellsX - 1, Math.floor(maxX / w));
    const jMin = Math.max(0, Math.floor(minY / w)), jMax = Math.min(cellsY - 1, Math.floor(maxY / w));
    if (iMin > iMax || jMin > jMax) return null;
    _range.iMin = iMin; _range.iMax = iMax; _range.jMin = jMin; _range.jMax = jMax;
    return _range;
}

const _triRange: [number, number] = [0, 0];

// ---- Sphere vs heightfield ----------------------------------------------------------------------------

const _sa = new Vec3(), _sb = new Vec3(), _sc = new Vec3();
const _sCenter = new Vec3();
const _sClosest = new Vec3();
const _sNormal = new Vec3();
const _sWorldPoint = new Vec3();
const _sWorldNormal = new Vec3();
const _ab = new Vec3(), _ac = new Vec3(), _ap = new Vec3(), _bp = new Vec3(), _cp = new Vec3();
const _triN = new Vec3();
/** The contact points one sphere has taken this call, xyz-packed, for the duplicate test. */
const _found = new Float64Array(MAX_SPHERE_CONTACTS * 3);

/**
 * Closest point on triangle abc to p, into `out` (Ericson, Real-Time Collision Detection, 5.1.5). Returns
 * true when that point is in the triangle's interior (a face feature rather than an edge or a corner).
 */
function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3, out: Vec3): boolean {
    b.vsub(a, _ab); c.vsub(a, _ac); p.vsub(a, _ap);
    const d1 = _ab.dot(_ap), d2 = _ac.dot(_ap);
    if (d1 <= 0 && d2 <= 0) { out.copy(a); return false; }
    p.vsub(b, _bp);
    const d3 = _ab.dot(_bp), d4 = _ac.dot(_bp);
    if (d3 >= 0 && d4 <= d3) { out.copy(b); return false; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        out.set(a.x + _ab.x * v, a.y + _ab.y * v, a.z + _ab.z * v);
        return false;
    }
    p.vsub(c, _cp);
    const d5 = _ab.dot(_cp), d6 = _ac.dot(_cp);
    if (d6 >= 0 && d5 <= d6) { out.copy(c); return false; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const wv = d2 / (d2 - d6);
        out.set(a.x + _ac.x * wv, a.y + _ac.y * wv, a.z + _ac.z * wv);
        return false;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const wv = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        out.set(b.x + (c.x - b.x) * wv, b.y + (c.y - b.y) * wv, b.z + (c.z - b.z) * wv);
        return false;
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, wv = vc * denom;
    out.set(a.x + _ab.x * v + _ac.x * wv, a.y + _ab.y * v + _ac.y * wv, a.z + _ab.z * v + _ac.z * wv);
    return true;
}

/** Whether p's XY projection falls inside triangle abc's (inclusive). */
function insideXY(p: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
    const s1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const s2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
    const s3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
    const eps = -1e-9;
    return (s1 >= eps && s2 >= eps && s3 >= eps) || (s1 <= -eps && s2 <= -eps && s3 <= -eps);
}

/**
 * Replacement for `Narrowphase.sphereHeightfield`. Same signature and contact conventions as cannon's
 * sphere resolvers: `ni` points from the sphere (body i) into the terrain (body j), `ri`/`rj` are the
 * contact points relative to each body's position.
 */
function sphereHeightfield(this: any, sphereShape: Sphere, hfShape: Heightfield, spherePos: Vec3, hfPos: Vec3,
                           _sphereQuat: Quaternion, hfQuat: Quaternion, sphereBody: Body, hfBody: Body,
                           rsi: Shape, rsj: Shape, justTest: boolean): boolean | void {
    const data = hfShape.data, w = hfShape.elementSize;
    const r = sphereShape.radius;
    Transform.pointToLocalFrame(hfPos, hfQuat, spherePos, _sCenter);
    const range = cellRange(hfShape, _sCenter.x - r, _sCenter.y - r, _sCenter.x + r, _sCenter.y + r);
    if (!range) return;
    const lo = _sCenter.z - r, hi = _sCenter.z + r;
    let found = 0;

    for (let i = range.iMin; i <= range.iMax; i++) {
        for (let j = range.jMin; j <= range.jMax; j++) {
            for (let t = 0; t < 2; t++) {
                const upper = t === 1;
                triangleRange(data, i, j, upper, _triRange);
                // Entirely above the surface, or below the solid it stands for: nothing to touch.
                if (lo > _triRange[1] + HEIGHT_MARGIN || hi < _triRange[0] - PILLAR_DEPTH) continue;

                triangle(data, w, i, j, upper, _sa, _sb, _sc);
                _sb.vsub(_sa, _ab); _sc.vsub(_sa, _ac);
                _ab.cross(_ac, _triN);
                _triN.normalize();
                _sCenter.vsub(_sa, _ap);
                const signed = _ap.dot(_triN);

                let depth: number;
                if (signed < 0) {
                    // The centre has sunk below this triangle's plane. A heightfield is SOLID underneath, so
                    // the way out is straight up the face normal — but only for the triangle the centre is
                    // actually under; a neighbour's plane extended under the centre would push sideways.
                    if (!insideXY(_sCenter, _sa, _sb, _sc) || signed < -PILLAR_DEPTH) continue;
                    _sNormal.copy(_triN);
                    // The projection onto the plane: centre minus the signed distance along the normal.
                    _triN.scale(signed, _sClosest);
                    _sCenter.vsub(_sClosest, _sClosest);
                    depth = r - signed;
                } else {
                    closestOnTriangle(_sCenter, _sa, _sb, _sc, _sClosest);
                    _sCenter.vsub(_sClosest, _sNormal);
                    const dist = _sNormal.length();
                    if (dist >= r) continue;
                    if (dist > 1e-9) _sNormal.scale(1 / dist, _sNormal);
                    else _sNormal.copy(_triN);
                    depth = r - dist;
                }
                if (depth <= 0) continue;
                if (justTest) return true;

                // Two triangles sharing the edge or corner the sphere touches report the same point; one is
                // enough, and a duplicate only over-constrains the solver.
                let duplicate = false;
                for (let f = 0; f < found * 3; f += 3) {
                    if (Math.abs(_found[f] - _sClosest.x) + Math.abs(_found[f + 1] - _sClosest.y)
                        + Math.abs(_found[f + 2] - _sClosest.z) < 1e-4 * w) { duplicate = true; break; }
                }
                if (duplicate) continue;
                _found[found * 3] = _sClosest.x; _found[found * 3 + 1] = _sClosest.y; _found[found * 3 + 2] = _sClosest.z;
                found++;

                const c = this.createContactEquation(sphereBody, hfBody, sphereShape, hfShape, rsi, rsj);
                // World-space normal, from the sphere INTO the terrain.
                Transform.vectorToWorldFrame(hfQuat, _sNormal, _sWorldNormal);
                _sWorldNormal.negate(c.ni);
                c.ni.normalize();
                // ri: centre -> deepest point of the sphere, then relative to the sphere's body.
                c.ni.scale(r, c.ri);
                c.ri.vadd(spherePos, c.ri);
                c.ri.vsub(sphereBody.position, c.ri);
                // rj: the touched point on the terrain, relative to the terrain's body.
                Transform.pointToWorldFrame(hfPos, hfQuat, _sClosest, _sWorldPoint);
                _sWorldPoint.vsub(hfBody.position, c.rj);
                this.result.push(c);
                this.createFrictionEquationsFromContact(c, this.frictionResult);
                if (found >= MAX_SPHERE_CONTACTS) return;
            }
        }
    }
}

// ---- Convex vs heightfield ----------------------------------------------------------------------------

const _worldPillarOffset = new Vec3();
/** Face list cannon hands convexConvex for a heightfield pillar. Kept identical on purpose. */
const CONVEX_FACE_LIST = [0];

/** Replacement for `Narrowphase.convexHeightfield`: shallow, cached pillars and a per-triangle height cull. */
function convexHeightfield(this: any, convexShape: ConvexPolyhedron, hfShape: Heightfield, convexPos: Vec3, hfPos: Vec3,
                           convexQuat: Quaternion, hfQuat: Quaternion, convexBody: Body, hfBody: Body,
                           _rsi: Shape, _rsj: Shape, justTest: boolean): boolean | void {
    localBounds(convexShape, convexPos, convexQuat, hfPos, hfQuat);
    const range = cellRange(hfShape, _localMin.x, _localMin.y, _localMax.x, _localMax.y);
    if (!range) return;
    const lo = _localMin.z, hi = _localMax.z;
    const accel = accelOf(hfShape);
    const data = hfShape.data;

    for (let i = range.iMin; i <= range.iMax; i++) {
        for (let j = range.jMin; j <= range.jMax; j++) {
            for (let t = 0; t < 2; t++) {
                const upper = t === 1;
                triangleRange(data, i, j, upper, _triRange);
                if (lo > _triRange[1] + HEIGHT_MARGIN || hi < _triRange[0] - PILLAR_DEPTH) continue;

                const p = pillar(hfShape, accel, i, j, upper);
                Transform.pointToWorldFrame(hfPos, hfQuat, p.offset, _worldPillarOffset);
                if (convexPos.distanceTo(_worldPillarOffset) >= p.convex.boundingSphereRadius + convexShape.boundingSphereRadius)
                    continue;
                const intersecting = this.convexConvex(convexShape, p.convex, convexPos, _worldPillarOffset, convexQuat,
                    hfQuat, convexBody, hfBody, null, null, justTest, CONVEX_FACE_LIST, null);
                if (justTest && intersecting) return true;
            }
        }
    }
}

function boxHeightfield(this: any, si: any, sj: Heightfield, xi: Vec3, xj: Vec3, qi: Quaternion, qj: Quaternion,
                        bi: Body, bj: Body, _rsi: Shape, _rsj: Shape, justTest: boolean): boolean | void {
    si.convexPolyhedronRepresentation.material = si.material;
    si.convexPolyhedronRepresentation.collisionResponse = si.collisionResponse;
    return convexHeightfield.call(this, si.convexPolyhedronRepresentation, sj, xi, xj, qi, qj, bi, bj, si, sj, justTest);
}

/** cannon dispatches a cylinder (type 128) AFTER the heightfield (32), so its arguments arrive swapped. */
function heightfieldCylinder(this: any, hfShape: Heightfield, convexShape: ConvexPolyhedron, hfPos: Vec3, convexPos: Vec3,
                             hfQuat: Quaternion, convexQuat: Quaternion, hfBody: Body, convexBody: Body,
                             rsi: Shape, rsj: Shape, justTest: boolean): boolean | void {
    return convexHeightfield.call(this, convexShape, hfShape, convexPos, hfPos, convexQuat, hfQuat, convexBody, hfBody, rsi, rsj, justTest);
}

// ---- Rays ---------------------------------------------------------------------------------------------

const _rFrom = new Vec3();
const _rTo = new Vec3();
const _rA = new Vec3(), _rB = new Vec3(), _rC = new Vec3();
const _rE1 = new Vec3(), _rE2 = new Vec3(), _rP = new Vec3(), _rT = new Vec3(), _rQ = new Vec3();
const _rDir = new Vec3();
const _rHitLocal = new Vec3();
const _rHitWorld = new Vec3();
const _rNormalLocal = new Vec3();
const _rNormalWorld = new Vec3();

/**
 * Möller–Trumbore against triangle abc for the segment `_rFrom + t * _rDir`, t in [0, 1]. Returns t, or -1.
 * Barycentric bounds are inclusive with a little slack: a ray running exactly along a shared edge must
 * hit one of the two triangles, never slip between them (the grid-line miss cannon's version had).
 */
function segmentTriangle(a: Vec3, b: Vec3, c: Vec3): number {
    b.vsub(a, _rE1);
    c.vsub(a, _rE2);
    _rDir.cross(_rE2, _rP);
    const det = _rE1.dot(_rP);
    if (Math.abs(det) < 1e-12) return -1;
    const inv = 1 / det;
    _rFrom.vsub(a, _rT);
    const u = _rT.dot(_rP) * inv;
    if (u < -1e-7 || u > 1 + 1e-7) return -1;
    _rT.cross(_rE1, _rQ);
    const v = _rDir.dot(_rQ) * inv;
    if (v < -1e-7 || u + v > 1 + 1e-7) return -1;
    const t = _rE2.dot(_rQ) * inv;
    return t >= 0 && t <= 1 ? t : -1;
}

/**
 * Replacement for `Ray._intersectHeightfield`. Reports hits on the triangles' top faces through the ray's
 * own `reportIntersection`, with the face normal in world space — what cannon's version reported via the
 * pillars' face 0 — so every ray mode (ALL, CLOSEST, ANY) and `skipBackfaces` behave as before.
 */
function intersectHeightfield(this: any, shape: Heightfield, quat: Quaternion, position: Vec3, body: Body,
                              reportedShape: Shape): void {
    const data = shape.data, w = shape.elementSize;
    const cellsX = data.length - 1, cellsY = data[0].length - 1;
    if (cellsX < 1 || cellsY < 1) return;
    Transform.pointToLocalFrame(position, quat, this.from, _rFrom);
    Transform.pointToLocalFrame(position, quat, this.to, _rTo);
    _rTo.vsub(_rFrom, _rDir);

    // Clip the segment to the field's box: its XY footprint and the height range it spans.
    let t0 = 0, t1 = 1;
    const clip = (o: number, d: number, lo: number, hi: number): boolean => {
        if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
        let ta = (lo - o) / d, tb = (hi - o) / d;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        return t0 <= t1;
    };
    if (!clip(_rFrom.x, _rDir.x, 0, cellsX * w)) return;
    if (!clip(_rFrom.y, _rDir.y, 0, cellsY * w)) return;
    const minValue = (shape as any).minValue as number, maxValue = (shape as any).maxValue as number;
    if (Number.isFinite(minValue) && Number.isFinite(maxValue)
        && !clip(_rFrom.z, _rDir.z, minValue - 1e-3, maxValue + 1e-3)) return;

    // 2D DDA over the cells the clipped segment crosses.
    const sx = _rFrom.x + _rDir.x * t0, sy = _rFrom.y + _rDir.y * t0;
    let i = Math.min(cellsX - 1, Math.max(0, Math.floor(sx / w)));
    let j = Math.min(cellsY - 1, Math.max(0, Math.floor(sy / w)));
    const stepI = _rDir.x > 0 ? 1 : _rDir.x < 0 ? -1 : 0;
    const stepJ = _rDir.y > 0 ? 1 : _rDir.y < 0 ? -1 : 0;
    const tDeltaX = stepI !== 0 ? w / Math.abs(_rDir.x) : Infinity;
    const tDeltaY = stepJ !== 0 ? w / Math.abs(_rDir.y) : Infinity;
    let tMaxX = stepI > 0 ? ((i + 1) * w - _rFrom.x) / _rDir.x : stepI < 0 ? (i * w - _rFrom.x) / _rDir.x : Infinity;
    let tMaxY = stepJ > 0 ? ((j + 1) * w - _rFrom.y) / _rDir.y : stepJ < 0 ? (j * w - _rFrom.y) / _rDir.y : Infinity;
    let tEnter = t0;
    const result = this.result;
    const firstHitEnds = this.mode !== Ray.ALL;

    for (let guard = cellsX + cellsY + 4; guard > 0; guard--) {
        const tExit = Math.min(tMaxX, tMaxY, t1);
        // The segment's height over this cell, against the cell's own height range.
        const za = _rFrom.z + _rDir.z * tEnter, zb = _rFrom.z + _rDir.z * tExit;
        const h00 = data[i][j], h10 = data[i + 1][j], h01 = data[i][j + 1], h11 = data[i + 1][j + 1];
        const cMin = Math.min(h00, h10, h01, h11), cMax = Math.max(h00, h10, h01, h11);
        let hitHere = false;
        if (Math.min(za, zb) <= cMax + 1e-6 && Math.max(za, zb) >= cMin - 1e-6) {
            for (let k = 0; k < 2; k++) {
                const upper = k === 1;
                triangle(data, w, i, j, upper, _rA, _rB, _rC);
                const t = segmentTriangle(_rA, _rB, _rC);
                if (t < 0) continue;
                _rDir.scale(t, _rHitLocal);
                _rHitLocal.vadd(_rFrom, _rHitLocal);
                _rB.vsub(_rA, _rE1); _rC.vsub(_rA, _rE2);
                _rE1.cross(_rE2, _rNormalLocal);
                _rNormalLocal.normalize();
                Transform.vectorToWorldFrame(quat, _rNormalLocal, _rNormalWorld);
                Transform.pointToWorldFrame(position, quat, _rHitLocal, _rHitWorld);
                this.reportIntersection(_rNormalWorld, _rHitWorld, reportedShape, body, -1);
                hitHere = true;
                if (result.shouldStop) return;
            }
        }
        // Cells are visited in order along the ray, so the first one with a hit holds the nearest hit.
        if (hitHere && firstHitEnds) return;
        if (tExit >= t1) return;
        if (tMaxX < tMaxY) { i += stepI; tEnter = tMaxX; tMaxX += tDeltaX; }
        else { j += stepJ; tEnter = tMaxY; tMaxY += tDeltaY; }
        if (i < 0 || j < 0 || i >= cellsX || j >= cellsY) return;
    }
}

// ---- Installation -------------------------------------------------------------------------------------

let rayInstalled = false;

/**
 * Route a world's heightfield contacts, and every Ray's heightfield test, through this module. Idempotent.
 * The narrowphase half is per world (its resolvers are instance-level getters); the ray half patches the
 * shared `Ray` prototype once, which is safe because it keeps cannon's reporting contract exactly.
 */
export function installHeightfieldCollision(world: World): void {
    const np = (world as any).narrowphase;
    if (np && !np.__cleoHeightfield) {
        np.sphereHeightfield = sphereHeightfield;
        np.convexHeightfield = convexHeightfield;
        np.boxHeightfield = boxHeightfield;
        np.heightfieldCylinder = heightfieldCylinder;
        np.__cleoHeightfield = true;
    }
    if (!rayInstalled) {
        (Ray.prototype as any)._intersectHeightfield = intersectHeightfield;
        rayInstalled = true;
    }
}

/** For tests: the resolvers, callable against a stock Narrowphase for A/B comparison. */
export const heightfieldResolvers = { sphereHeightfield, convexHeightfield, boxHeightfield, heightfieldCylinder, intersectHeightfield };
