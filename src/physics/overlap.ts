import type { Node } from "../core/scene/nodes/node";
import type { ColliderGeometry } from "./pal/types";

// Shape-overlap queries: "which bodies does this sphere / capsule / box touch right now", and the swept
// version, "which bodies did it touch on its way from here to there". cannon has raycasts but nothing
// volumetric, and a ray is the wrong tool for a blade — it is a line with no thickness, so it slips
// between a thin sword and a shoulder, and a fast swing teleports clean past a target between frames.
//
// Geometry is exact for what characters and props are made of: spheres, boxes and capsules (on a backend
// that builds a capsule from a cylinder and two spheres, the cylinder part is tested as a capsule of the
// same radius and length, which its two end spheres make exact). Convex hulls, trimeshes, heightfields and
// planes are not tested: the queries are for hitting things, not for terrain. Bodies are measured from
// their collider parts (pal/types.ts ColliderPart), exactly as their backend simulates them.

type V3 = [number, number, number];

/**
 * What a query reads from a body, besides its geometry (which comes from a ColliderGeometry). Structural,
 * so this module stays a leaf the unit suite loads.
 */
export interface OverlapBody {
    id: number;
    isTrigger?: boolean;
    /** False on a switched-off trigger (Trigger.enabled), which no query sees. */
    enabled?: boolean;
    collisionResponse?: boolean;
    collisionFilterGroup?: number;
    mass?: number;
    owner?: Node | null;
}

/** One body a query touched. Vectors are world space and freshly allocated. */
export interface OverlapHit<TBody = OverlapBody> {
    /** The Node owning the body, or null for an ownerless body. */
    node: Node | null;
    body: TBody;
    /** The closest point ON THE BODY to the query shape at the moment of contact. */
    point: V3;
    /**
     * How far along a sweep the first contact happened, 0 (start pose) to 1 (end pose). Always 0 for a
     * plain overlap. Comparing two hits' fractions says which one the sweep reached first.
     */
    fraction: number;
}

export interface OverlapOptions<TBody = OverlapBody> {
    /** Nodes to skip — nearly always the caster itself, whose own body the query starts inside. */
    ignore?: Node | Node[] | null;
    /** Let trigger volumes count. Default false. */
    includeTriggers?: boolean;
    /** Let ghost bodies (`simulatePhysics = false`) count. Default false. */
    includeGhosts?: boolean;
    /** Let ragdoll bone bodies count. Default false — a corpse's limbs are not a target. */
    includeRagdolls?: boolean;
    /**
     * Only bodies in one of these collision layers (`collisionFilterGroup & layerMask`), e.g. just the
     * hurtbox triggers. Checked before any geometry, so it is the cheap way to narrow a query. Default: all.
     */
    layerMask?: number;
    /** Last word on each candidate. Return true to KEEP it. `node` is null for an ownerless body. */
    filter?: (node: Node | null, body: TBody) => boolean;
}

/** The collision group ragdoll bone bodies are put in (see Ragdoll). */
export const RAGDOLL_GROUP = 2;

// ---------------------------------------------------------------------------------------------------
// Query shapes, in world space. A sphere is a capsule whose two ends coincide.

export type QueryShape =
    | { kind: 'capsule'; a: V3; b: V3; radius: number }
    | { kind: 'box'; center: V3; half: V3; /** Unit quaternion [x,y,z,w]. */ rotation: [number, number, number, number] };

// ---------------------------------------------------------------------------------------------------
// Vector helpers on plain tuples. Kept local and allocation-light: a sweep runs these per sample.

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dist2 = (a: V3, b: V3) => { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; };
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Rotate `v` by the unit quaternion `q` ([x,y,z,w]). */
export function rotate(q: readonly number[], v: readonly number[]): V3 {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    // t = 2 * cross(q.xyz, v); v' = v + w*t + cross(q.xyz, t)
    const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
    return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}
const conj = (q: readonly number[]): [number, number, number, number] => [-q[0], -q[1], -q[2], q[3]];
function qmul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}

/** Closest point on segment ab to p. */
export function closestOnSegment(p: V3, a: V3, b: V3): V3 {
    const ab = sub(b, a);
    const len2 = dot(ab, ab);
    if (len2 < 1e-12) return [a[0], a[1], a[2]];
    return lerp(a, b, clamp01(dot(sub(p, a), ab) / len2));
}

/** Closest points between segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function closestSegmentSegment(p1: V3, q1: V3, p2: V3, q2: V3): { c1: V3; c2: V3; dist2: number } {
    const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
    const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
    let s: number, t: number;
    if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
    else if (a <= 1e-12) { s = 0; t = clamp01(f / e); }
    else {
        const c = dot(d1, r);
        if (e <= 1e-12) { t = 0; s = clamp01(-c / a); }
        else {
            const b = dot(d1, d2), denom = a * e - b * b;
            s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = clamp01(-c / a); }
            else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
        }
    }
    const c1 = lerp(p1, q1, s), c2 = lerp(p2, q2, t);
    return { c1, c2, dist2: dist2(c1, c2) };
}

/** Closest point on an axis-aligned box (centred at the origin, half extents `h`) to p. */
function clampToBox(p: V3, h: V3): V3 {
    return [Math.max(-h[0], Math.min(h[0], p[0])), Math.max(-h[1], Math.min(h[1], p[1])), Math.max(-h[2], Math.min(h[2], p[2]))];
}

/**
 * Closest points between segment ab and an origin-centred axis-aligned box. The distance from a point
 * on the segment to a convex set is a convex function of the segment parameter, so a golden-section
 * search finds its minimum exactly (to float precision) without the 13-case analytic version.
 */
export function closestSegmentBox(a: V3, b: V3, h: V3): { onSegment: V3; onBox: V3; dist2: number } {
    const at = (t: number) => { const p = lerp(a, b, t); const q = clampToBox(p, h); return { p, q, d: dist2(p, q) }; };
    let lo = 0, hi = 1;
    const g = 0.6180339887498949;
    let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
    let f1 = at(x1).d, f2 = at(x2).d;
    for (let i = 0; i < 40 && hi - lo > 1e-6; i++) {
        if (f1 <= f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = at(x1).d; }
        else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = at(x2).d; }
    }
    // The ends can beat an interior minimum only when the function is flat; check them anyway.
    let best = at((lo + hi) / 2);
    for (const t of [0, 1]) { const c = at(t); if (c.d < best.d) best = c; }
    return { onSegment: best.p, onBox: best.q, dist2: best.d };
}

/** Separating-axis test between two oriented boxes. Rotations are 3x3 column bases. */
function boxesOverlap(ca: V3, ha: V3, axesA: V3[], cb: V3, hb: V3, axesB: V3[]): boolean {
    const t = sub(cb, ca);
    const test = (axis: V3) => {
        const len2 = dot(axis, axis);
        if (len2 < 1e-10) return true;            // parallel edges: the face axes already covered it
        const ra = ha[0] * Math.abs(dot(axesA[0], axis)) + ha[1] * Math.abs(dot(axesA[1], axis)) + ha[2] * Math.abs(dot(axesA[2], axis));
        const rb = hb[0] * Math.abs(dot(axesB[0], axis)) + hb[1] * Math.abs(dot(axesB[1], axis)) + hb[2] * Math.abs(dot(axesB[2], axis));
        return Math.abs(dot(t, axis)) <= ra + rb;
    };
    for (const ax of axesA) if (!test(ax)) return false;
    for (const ax of axesB) if (!test(ax)) return false;
    for (const u of axesA) for (const v of axesB) {
        if (!test([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]])) return false;
    }
    return true;
}
const axesOf = (q: readonly number[]): V3[] => [rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])];

// ---------------------------------------------------------------------------------------------------
// Target shapes: one collider part of a body, resolved into world space.

type Target =
    | { kind: 'capsule'; a: V3; b: V3; radius: number }
    | { kind: 'box'; center: V3; half: V3; rotation: [number, number, number, number] };

const FRAME: number[] = [0, 0, 0, 0, 0, 0, 1];

/** A body's testable shapes in world space. Unsupported shape types are left out. */
export function bodyTargets<TBody>(body: TBody, geometry: ColliderGeometry<TBody>): Target[] {
    const out: Target[] = [];
    geometry.colliderFrame(body, FRAME);
    const bq = [FRAME[3], FRAME[4], FRAME[5], FRAME[6]];
    const bp: V3 = [FRAME[0], FRAME[1], FRAME[2]];
    for (const part of geometry.colliderParts(body)) {
        const shape = part.shape, o = part.offset;
        const off = rotate(bq, o);
        const center: V3 = [bp[0] + off[0], bp[1] + off[1], bp[2] + off[2]];
        const q = qmul(bq, part.rotation);
        if (shape.kind === 'sphere') {
            out.push({ kind: 'capsule', a: center, b: center, radius: shape.radius });
        } else if (shape.kind === 'box') {
            const h = shape.halfExtents;
            out.push({ kind: 'box', center, half: [h[0], h[1], h[2]], rotation: q });
        } else if (shape.kind === 'cylinder' || shape.kind === 'capsule') {
            const half = rotate(q, [0, shape.height / 2, 0]);
            const radius = shape.kind === 'capsule' ? shape.radius : Math.max(shape.radiusTop, shape.radiusBottom);
            out.push({ kind: 'capsule', a: sub(center, half), b: [center[0] + half[0], center[1] + half[1], center[2] + half[2]], radius });
        }
    }
    return out;
}

/**
 * Whether the query shape touches the target; if so, the closest point on the target and the `gap`
 * between the two (negative: how deep they interpenetrate). The gap is what picks between the parts of a
 * compound body: a blade grazing a capsule's end sphere but buried in its cylinder reports the cylinder.
 */
export function touch(query: QueryShape, target: Target): { point: V3; gap: number } | null {
    if (query.kind === 'capsule' && target.kind === 'capsule') {
        const { c2, dist2: d } = closestSegmentSegment(query.a, query.b, target.a, target.b);
        const r = query.radius + target.radius;
        if (d > r * r) return null;
        return { point: surfacePoint(c2, closestOnSegment(c2, query.a, query.b), target.radius), gap: Math.sqrt(d) - r };
    }
    if (query.kind === 'capsule' && target.kind === 'box') {
        const inv = conj(target.rotation);
        const la = rotate(inv, sub(query.a, target.center)), lb = rotate(inv, sub(query.b, target.center));
        const { onBox, dist2: d } = closestSegmentBox(la, lb, target.half);
        if (d > query.radius * query.radius) return null;
        const w = rotate(target.rotation, onBox);
        return { point: [w[0] + target.center[0], w[1] + target.center[1], w[2] + target.center[2]], gap: Math.sqrt(d) - query.radius };
    }
    if (query.kind === 'box' && target.kind === 'capsule') {
        const inv = conj(query.rotation);
        const la = rotate(inv, sub(target.a, query.center)), lb = rotate(inv, sub(target.b, query.center));
        const { onSegment, onBox, dist2: d } = closestSegmentBox(la, lb, query.half);
        if (d > target.radius * target.radius) return null;
        const seg = rotate(query.rotation, onSegment), box = rotate(query.rotation, onBox);
        const ws: V3 = [seg[0] + query.center[0], seg[1] + query.center[1], seg[2] + query.center[2]];
        const wb: V3 = [box[0] + query.center[0], box[1] + query.center[1], box[2] + query.center[2]];
        return { point: surfacePoint(ws, wb, target.radius), gap: Math.sqrt(d) - target.radius };
    }
    if (query.kind === 'box' && target.kind === 'box') {
        if (!boxesOverlap(query.center, query.half, axesOf(query.rotation), target.center, target.half, axesOf(target.rotation))) return null;
        // The target's point nearest the query centre stands in for a contact point.
        const inv = conj(target.rotation);
        const local = clampToBox(rotate(inv, sub(query.center, target.center)), target.half);
        const w = rotate(target.rotation, local);
        return { point: [w[0] + target.center[0], w[1] + target.center[1], w[2] + target.center[2]], gap: 0 };
    }
    return null;
}

/** The point on a rounded target's surface, from its core point towards the query. */
function surfacePoint(core: V3, toward: V3, radius: number): V3 {
    const d = sub(toward, core);
    const len = Math.sqrt(dot(d, d));
    if (len < 1e-9 || radius === 0) return core;
    const k = radius / len;
    return [core[0] + d[0] * k, core[1] + d[1] * k, core[2] + d[2] * k];
}

/** A bounding sphere for the query, so a body far away is rejected before any shape test. */
function querySphere(q: QueryShape): { c: V3; r: number } {
    if (q.kind === 'capsule') {
        const c = lerp(q.a, q.b, 0.5);
        return { c, r: Math.sqrt(dist2(q.a, q.b)) / 2 + q.radius };
    }
    return { c: q.center, r: Math.sqrt(dot(q.half, q.half)) };
}

// ---------------------------------------------------------------------------------------------------
// Queries over a set of bodies.

function keep<TBody extends OverlapBody>(body: TBody, opts: OverlapOptions<TBody> | undefined, ignore: Node[]): boolean {
    if (!opts?.includeTriggers && body.isTrigger) return false;
    if (body.isTrigger && body.enabled === false) return false;
    if (opts?.layerMask !== undefined && ((body.collisionFilterGroup ?? 1) & opts.layerMask) === 0) return false;
    if (!opts?.includeGhosts && body.collisionResponse === false && !body.isTrigger) return false;
    if (!opts?.includeRagdolls && body.collisionFilterGroup === RAGDOLL_GROUP) return false;
    const node = body.owner ?? null;
    if (node && ignore.includes(node)) return false;
    if (opts?.filter && !opts.filter(node, body)) return false;
    return true;
}

const ignoreList = (ignore: Node | Node[] | null | undefined): Node[] => (!ignore ? [] : Array.isArray(ignore) ? ignore : [ignore]);

/**
 * Every body touched by the query poses, at the first pose (in order) that touches it. One hit per node
 * (a capsule's three cannon parts are one character), ordered by fraction then by distance.
 */
export function queryPoses<TBody extends OverlapBody>(
    bodies: readonly TBody[], poses: readonly QueryShape[], geometry: ColliderGeometry<TBody>, opts?: OverlapOptions<TBody>,
): OverlapHit<TBody>[] {
    if (poses.length === 0) return [];
    // One bounding sphere around every pose: the cheap reject for the whole sweep.
    const spheres = poses.map(querySphere);
    let c = spheres[0].c, r = spheres[0].r;
    if (spheres.length > 1) {
        const first = spheres[0], last = spheres[spheres.length - 1];
        c = lerp(first.c, last.c, 0.5);
        r = 0;
        for (const s of spheres) r = Math.max(r, Math.sqrt(dist2(c, s.c)) + s.r);
    }

    const ignore = ignoreList(opts?.ignore);
    const byKey = new Map<object, OverlapHit<TBody> & { d: number }>();
    for (const body of bodies) {
        if (!keep(body, opts, ignore)) continue;
        const bound = geometry.colliderFrame(body, FRAME);
        const bp: V3 = [FRAME[0], FRAME[1], FRAME[2]];
        const reach = r + (bound || 0);
        if (dist2(bp, c) > reach * reach) continue;

        const targets = bodyTargets(body, geometry);
        if (targets.length === 0) continue;
        const key: object = body.owner ?? body;
        for (let i = 0; i < poses.length; i++) {
            const existing = byKey.get(key);
            const fraction = poses.length === 1 ? 0 : i / (poses.length - 1);
            if (existing && existing.fraction < fraction) break;
            let found: V3 | null = null, foundD = Infinity;
            for (const t of targets) {
                const contact = touch(poses[i], t);
                if (contact && contact.gap < foundD) { found = contact.point; foundD = contact.gap; }
            }
            if (!found) continue;
            if (!existing || fraction < existing.fraction || foundD < existing.d)
                byKey.set(key, { node: body.owner ?? null, body, point: found, fraction, d: foundD });
            break;
        }
    }
    return [...byKey.values()]
        .sort((a, b) => a.fraction - b.fraction || a.d - b.d)
        .map(({ d: _d, ...hit }) => hit);
}

/** The poses a sweep tests: enough that consecutive ones are at most `radius` apart. */
export function sweepPoses(a0: V3, b0: V3, a1: V3, b1: V3, radius: number, maxSamples = 32): QueryShape[] {
    const travel = Math.max(Math.sqrt(dist2(a0, a1)), Math.sqrt(dist2(b0, b1)));
    const step = Math.max(radius, 1e-3);
    const n = Math.min(maxSamples, Math.max(1, Math.ceil(travel / step)));
    const length = Math.sqrt(dist2(a0, b0));
    const poses: QueryShape[] = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        let a = lerp(a0, a1, t), b = lerp(b0, b1, t);
        // A blade that turns while it moves shortens when its ends are lerped; restore its length about
        // the middle so a swinging sword does not shrink to half its reach mid-arc.
        const len = Math.sqrt(dist2(a, b));
        if (len > 1e-6 && Math.abs(len - length) > 1e-6) {
            const mid = lerp(a, b, 0.5), k = length / len / 2;
            const half: V3 = [(b[0] - a[0]) * k, (b[1] - a[1]) * k, (b[2] - a[2]) * k];
            a = sub(mid, half); b = [mid[0] + half[0], mid[1] + half[1], mid[2] + half[2]];
        }
        poses.push({ kind: 'capsule', a, b, radius });
    }
    return poses;
}
