import type { Node } from "../core/scene/nodes/node";
import type { ColliderGeometry } from "./pal/types";
import {
    boxesOverlap, clampToBox, closestOnSegment, closestSegmentBox, closestSegmentSegment, distSq3, dot3, lerp3,
    quatConjugateTuple, quatMultiplyTuple, quatRotateTuple, sub3,
} from "../core/math";
export { closestOnSegment, closestSegmentBox, closestSegmentSegment, quatRotateTuple as rotate } from "../core/math";

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
// The plain-tuple vector helpers (allocation-light: a sweep runs them per sample) and the closest-point and
// box tests are core/math.ts's; the old exported names are re-exported at the top.

const axesOf = (q: readonly number[]): V3[] => [quatRotateTuple(q, [1, 0, 0]), quatRotateTuple(q, [0, 1, 0]), quatRotateTuple(q, [0, 0, 1])];

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
        const off = quatRotateTuple(bq, o);
        const center: V3 = [bp[0] + off[0], bp[1] + off[1], bp[2] + off[2]];
        const q = quatMultiplyTuple(bq, part.rotation);
        if (shape.kind === 'sphere') {
            out.push({ kind: 'capsule', a: center, b: center, radius: shape.radius });
        } else if (shape.kind === 'box') {
            const h = shape.halfExtents;
            out.push({ kind: 'box', center, half: [h[0], h[1], h[2]], rotation: q });
        } else if (shape.kind === 'cylinder' || shape.kind === 'capsule') {
            const half = quatRotateTuple(q, [0, shape.height / 2, 0]);
            const radius = shape.kind === 'capsule' ? shape.radius : Math.max(shape.radiusTop, shape.radiusBottom);
            out.push({ kind: 'capsule', a: sub3(center, half), b: [center[0] + half[0], center[1] + half[1], center[2] + half[2]], radius });
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
        const inv = quatConjugateTuple(target.rotation);
        const la = quatRotateTuple(inv, sub3(query.a, target.center)), lb = quatRotateTuple(inv, sub3(query.b, target.center));
        const { onBox, dist2: d } = closestSegmentBox(la, lb, target.half);
        if (d > query.radius * query.radius) return null;
        const w = quatRotateTuple(target.rotation, onBox);
        return { point: [w[0] + target.center[0], w[1] + target.center[1], w[2] + target.center[2]], gap: Math.sqrt(d) - query.radius };
    }
    if (query.kind === 'box' && target.kind === 'capsule') {
        const inv = quatConjugateTuple(query.rotation);
        const la = quatRotateTuple(inv, sub3(target.a, query.center)), lb = quatRotateTuple(inv, sub3(target.b, query.center));
        const { onSegment, onBox, dist2: d } = closestSegmentBox(la, lb, query.half);
        if (d > target.radius * target.radius) return null;
        const seg = quatRotateTuple(query.rotation, onSegment), box = quatRotateTuple(query.rotation, onBox);
        const ws: V3 = [seg[0] + query.center[0], seg[1] + query.center[1], seg[2] + query.center[2]];
        const wb: V3 = [box[0] + query.center[0], box[1] + query.center[1], box[2] + query.center[2]];
        return { point: surfacePoint(ws, wb, target.radius), gap: Math.sqrt(d) - target.radius };
    }
    if (query.kind === 'box' && target.kind === 'box') {
        if (!boxesOverlap(query.center, query.half, axesOf(query.rotation), target.center, target.half, axesOf(target.rotation))) return null;
        // The target's point nearest the query centre stands in for a contact point.
        const inv = quatConjugateTuple(target.rotation);
        const local = clampToBox(quatRotateTuple(inv, sub3(query.center, target.center)), target.half);
        const w = quatRotateTuple(target.rotation, local);
        return { point: [w[0] + target.center[0], w[1] + target.center[1], w[2] + target.center[2]], gap: 0 };
    }
    return null;
}

/** The point on a rounded target's surface, from its core point towards the query. */
function surfacePoint(core: V3, toward: V3, radius: number): V3 {
    const d = sub3(toward, core);
    const len = Math.sqrt(dot3(d, d));
    if (len < 1e-9 || radius === 0) return core;
    const k = radius / len;
    return [core[0] + d[0] * k, core[1] + d[1] * k, core[2] + d[2] * k];
}

/** A bounding sphere for the query, so a body far away is rejected before any shape test. */
function querySphere(q: QueryShape): { c: V3; r: number } {
    if (q.kind === 'capsule') {
        const c = lerp3(q.a, q.b, 0.5);
        return { c, r: Math.sqrt(distSq3(q.a, q.b)) / 2 + q.radius };
    }
    return { c: q.center, r: Math.sqrt(dot3(q.half, q.half)) };
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
        c = lerp3(first.c, last.c, 0.5);
        r = 0;
        for (const s of spheres) r = Math.max(r, Math.sqrt(distSq3(c, s.c)) + s.r);
    }

    const ignore = ignoreList(opts?.ignore);
    const byKey = new Map<object, OverlapHit<TBody> & { d: number }>();
    for (const body of bodies) {
        if (!keep(body, opts, ignore)) continue;
        const bound = geometry.colliderFrame(body, FRAME);
        const bp: V3 = [FRAME[0], FRAME[1], FRAME[2]];
        const reach = r + (bound || 0);
        if (distSq3(bp, c) > reach * reach) continue;

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
    const travel = Math.max(Math.sqrt(distSq3(a0, a1)), Math.sqrt(distSq3(b0, b1)));
    const step = Math.max(radius, 1e-3);
    const n = Math.min(maxSamples, Math.max(1, Math.ceil(travel / step)));
    const length = Math.sqrt(distSq3(a0, b0));
    const poses: QueryShape[] = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        let a = lerp3(a0, a1, t), b = lerp3(b0, b1, t);
        // A blade that turns while it moves shortens when its ends are lerped; restore its length about
        // the middle so a swinging sword does not shrink to half its reach mid-arc.
        const len = Math.sqrt(distSq3(a, b));
        if (len > 1e-6 && Math.abs(len - length) > 1e-6) {
            const mid = lerp3(a, b, 0.5), k = length / len / 2;
            const half: V3 = [(b[0] - a[0]) * k, (b[1] - a[1]) * k, (b[2] - a[2]) * k];
            a = sub3(mid, half); b = [mid[0] + half[0], mid[1] + half[1], mid[2] + half[2]];
        }
        poses.push({ kind: 'capsule', a, b, radius });
    }
    return poses;
}
