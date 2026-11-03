import { touch, type QueryShape } from "./overlap";
import { Logger } from "../core/logger";
import type { ColliderGeometry, ColliderPart } from "./pal/types";

// Trigger volumes overlapping OTHER trigger volumes — a weapon's hitbox entering a character's hurtbox.
//
// cannon cannot report these. Every engine trigger is a mass-0 STATIC body, and cannon's broadphase drops
// any pair whose two bodies are both static or sleeping (`Broadphase.needBroadphaseCollision`), so two
// triggers never even reach its narrowphase. Making triggers kinematic would get them there, but they
// would then be tested every substep at a pose that only changes once a frame, run through cannon's
// full cylinder SAT (a capsule is three shapes, so nine shape pairs), and become candidates for the
// ground ray. Letting static pairs through the broadphase instead would build full contact manifolds
// for the solver to throw away.
//
// So the engine does it, once per frame after the bodies have been moved to their nodes:
//  - candidates are the enabled triggers, and only while at least one of them asks (`detectTriggers`);
//  - broadphase: sort-and-sweep over each trigger's bounding sphere (its swept bounds for a continuous
//    one), on an array kept nearly sorted from frame to frame, so the insertion sort is close to O(n);
//  - layers: a pair overlaps only when each side's mask has the other's group, cannon's own rule;
//  - narrowphase: every collider part becomes a capsule (a sphere is a zero-length one) or a box, in the
//    body's collider frame, cached until the shapes change. A capsule a backend built from a cylinder and
//    two end spheres (cannon) collapses to ONE capsule, since the cylinder tested as a capsule already
//    covers its caps.
//    Capsule against capsule is a segment-segment distance with no allocation;
//  - a `continuous` trigger is tested along the path from last frame's pose to this one, sampled no
//    further apart than its thinnest part, so a blade cannot step over an arm between two frames.
//
// A structural leaf like overlap.ts (no Node, no backend import), so the unit suite loads it directly. A
// trigger's geometry and pose come from a ColliderGeometry (PhysicsSystem's, over its world).

/** What the pass reads from a trigger, besides its geometry. `Trigger` (body.ts) satisfies it. */
export interface TriggerBody {
    id: number;
    collisionFilterGroup: number;
    readonly mask: number;
    readonly enabled: boolean;
    readonly detectTriggers: boolean;
    readonly continuous: boolean;
    readonly shapeVersion: number;
    owner?: unknown;
}

/** One trigger↔trigger overlap found by the pass. Kept and updated in place while it lasts. */
export interface TriggerOverlap {
    a: TriggerBody;
    b: TriggerBody;
    /** The point on `a`'s surface nearest `b`, world space. */
    pointOnA: [number, number, number];
    /** The point on `b`'s surface nearest `a`, world space. */
    pointOnB: [number, number, number];
    /** How far through the frame's sweep they first touched, 0..1; 1 when neither side is continuous. */
    fraction: number;
    /** The pass that last saw it; internal. */
    stamp: number;
}

/** The order-independent key of a pair of bodies, shared with PhysicsSystem's cannon-reported pairs. */
export function pairKey(a: { id: number }, b: { id: number }): number {
    return a.id < b.id ? a.id * 1048576 + b.id : b.id * 1048576 + a.id;
}

// ---------------------------------------------------------------------------------------------------

/** One shape, as a capsule (`box` false; a sphere is a zero-length capsule) or an oriented box. */
interface Prim {
    box: boolean;
    /** Capsule radius; for a box, its smallest half extent (what the sweep steps by). */
    r: number;
    /** Body-space ends of the capsule; for a box, `la` is its centre. */
    la: Float64Array;
    lb: Float64Array;
    /** Box half extents and body-space rotation. */
    half: Float64Array;
    lq: Float64Array;
    /** The same, placed in world space by {@link place}. */
    wa: Float64Array;
    wb: Float64Array;
    wq: Float64Array;
}

interface Entry {
    body: TriggerBody;
    prims: Prim[];
    shapeVersion: number;
    /** Smallest prim thickness: the sweep's sample spacing. */
    thin: number;
    /** This frame's and last frame's pose: position xyz, quaternion xyzw. */
    cur: Float64Array;
    /** This frame's bounding radius about `cur`. */
    radius: number;
    prev: Float64Array;
    prevValid: boolean;
    min: Float64Array;
    max: Float64Array;
    /** The pose the prims' world arrays currently hold: the pass stamp and sweep parameter. */
    placedStamp: number;
    placedT: number;
}

const PASSES_PER_AXIS_PICK = 60;
const MAX_SWEEP_SAMPLES = 32;

let warned: WeakSet<object> | null = null;

function newPrim(box: boolean, r: number): Prim {
    return {
        box, r,
        la: new Float64Array(3), lb: new Float64Array(3), half: new Float64Array(3), lq: new Float64Array([0, 0, 0, 1]),
        wa: new Float64Array(3), wb: new Float64Array(3), wq: new Float64Array([0, 0, 0, 1]),
    };
}

/** Rotate (x, y, z) by quaternion q (at offset `qi` of `q`) into out[oi..]. */
function rot(q: ArrayLike<number>, qi: number, x: number, y: number, z: number, out: Float64Array, oi: number): void {
    const qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    out[oi] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    out[oi + 1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    out[oi + 2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
}

/** A trigger's collider parts as prims in its collider frame. `owner` names it in a warning. */
export function localPrims(parts: readonly ColliderPart[], owner?: { id: number }): Prim[] {
    const out: Prim[] = [];
    const caps: Prim[] = [];
    const spheres: { c: [number, number, number]; r: number }[] = [];
    const tmp = new Float64Array(3);
    for (const part of parts) {
        const shape = part.shape, o = part.offset, q = part.rotation;
        if (shape.kind === 'sphere') {
            spheres.push({ c: [o[0], o[1], o[2]], r: shape.radius });
        } else if (shape.kind === 'box') {
            const h = shape.halfExtents;
            const p = newPrim(true, Math.min(h[0], h[1], h[2]));
            p.la.set([o[0], o[1], o[2]]); p.half.set([h[0], h[1], h[2]]); p.lq.set(q);
            out.push(p);
        } else if (shape.kind === 'cylinder' || shape.kind === 'capsule') {
            const r = shape.kind === 'capsule' ? shape.radius : Math.max(shape.radiusTop, shape.radiusBottom);
            const p = newPrim(false, r);
            rot(q, 0, 0, shape.height / 2, 0, tmp, 0);
            p.la.set([o[0] - tmp[0], o[1] - tmp[1], o[2] - tmp[2]]);
            p.lb.set([o[0] + tmp[0], o[1] + tmp[1], o[2] + tmp[2]]);
            out.push(p); if (shape.kind === 'cylinder') caps.push(p);
        } else {
            // A convex hull, trimesh, plane or heightfield: its bounding sphere stands in. Triggers are made of
            // spheres, boxes and capsules; anything else is an approximation, said once.
            if (!warned) warned = new WeakSet();
            const key: object = owner ?? parts;
            if (!warned.has(key)) {
                warned.add(key);
                Logger.warn(`Trigger ${owner ? owner.id : '?'}: a shape other than a sphere, box or capsule is approximated by its bounding sphere for trigger-to-trigger overlaps.`, 'Physics');
            }
            spheres.push({ c: [o[0], o[1], o[2]], r: part.boundingRadius ?? 0 });
        }
    }
    // An engine capsule's end spheres sit exactly on its cylinder-capsule's ends: drop them.
    for (const s of spheres) {
        const covered = caps.some(c => s.r <= c.r + 1e-6 && [c.la, c.lb].some(e => Math.hypot(e[0] - s.c[0], e[1] - s.c[1], e[2] - s.c[2]) < 1e-4));
        if (covered) continue;
        const p = newPrim(false, s.r);
        p.la.set(s.c); p.lb.set(s.c);
        out.push(p);
    }
    return out;
}

/** Write the prims' world-space arrays for the body pose `pose` (position xyz, quaternion xyzw). */
function place(prims: Prim[], pose: ArrayLike<number>): void {
    for (const p of prims) {
        rot(pose, 3, p.la[0], p.la[1], p.la[2], p.wa, 0);
        p.wa[0] += pose[0]; p.wa[1] += pose[1]; p.wa[2] += pose[2];
        if (p.box) {
            // wq = pose.q * lq
            const ax = pose[3], ay = pose[4], az = pose[5], aw = pose[6];
            const bx = p.lq[0], by = p.lq[1], bz = p.lq[2], bw = p.lq[3];
            p.wq[0] = aw * bx + ax * bw + ay * bz - az * by;
            p.wq[1] = aw * by - ax * bz + ay * bw + az * bx;
            p.wq[2] = aw * bz + ax * by - ay * bx + az * bw;
            p.wq[3] = aw * bw - ax * bx - ay * by - az * bz;
        } else {
            rot(pose, 3, p.lb[0], p.lb[1], p.lb[2], p.wb, 0);
            p.wb[0] += pose[0]; p.wb[1] += pose[1]; p.wb[2] += pose[2];
        }
    }
}

/** `out` = the pose a fraction `t` of the way from `a` to `b` (lerped position, slerped rotation). */
function lerpPose(a: Float64Array, b: Float64Array, t: number, out: Float64Array): void {
    out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t;
    let bx = b[3], by = b[4], bz = b[5], bw = b[6];
    let cos = a[3] * bx + a[4] * by + a[5] * bz + a[6] * bw;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let s0 = 1 - t, s1 = t;
    if (1 - cos > 1e-6) {
        const omega = Math.acos(Math.min(1, cos)), sin = Math.sin(omega);
        s0 = Math.sin((1 - t) * omega) / sin; s1 = Math.sin(t * omega) / sin;
    }
    out[3] = s0 * a[3] + s1 * bx; out[4] = s0 * a[4] + s1 * by; out[5] = s0 * a[5] + s1 * bz; out[6] = s0 * a[6] + s1 * bw;
}

// Segment-segment closest points (Ericson 5.1.9), scalar and allocation-free. Writes c1 into SEG[0..2] and
// c2 into SEG[3..5] and returns the squared distance.
const SEG = new Float64Array(6);
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
function segSeg(p1: Float64Array, q1: Float64Array, p2: Float64Array, q2: Float64Array): number {
    const d1x = q1[0] - p1[0], d1y = q1[1] - p1[1], d1z = q1[2] - p1[2];
    const d2x = q2[0] - p2[0], d2y = q2[1] - p2[1], d2z = q2[2] - p2[2];
    const rx = p1[0] - p2[0], ry = p1[1] - p2[1], rz = p1[2] - p2[2];
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
    let s: number, t: number;
    if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
    else if (a <= 1e-12) { s = 0; t = clamp01(f / e); }
    else {
        const c = d1x * rx + d1y * ry + d1z * rz;
        if (e <= 1e-12) { t = 0; s = clamp01(-c / a); }
        else {
            const b = d1x * d2x + d1y * d2y + d1z * d2z, denom = a * e - b * b;
            s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = clamp01(-c / a); }
            else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
        }
    }
    SEG[0] = p1[0] + d1x * s; SEG[1] = p1[1] + d1y * s; SEG[2] = p1[2] + d1z * s;
    SEG[3] = p2[0] + d2x * t; SEG[4] = p2[1] + d2y * t; SEG[5] = p2[2] + d2z * t;
    const dx = SEG[0] - SEG[3], dy = SEG[1] - SEG[4], dz = SEG[2] - SEG[5];
    return dx * dx + dy * dy + dz * dz;
}

type V3 = [number, number, number];
const v3 = (a: Float64Array): V3 => [a[0], a[1], a[2]];
function asShape(p: Prim): QueryShape {
    return p.box
        ? { kind: 'box', center: v3(p.wa), half: v3(p.half), rotation: [p.wq[0], p.wq[1], p.wq[2], p.wq[3]] }
        : { kind: 'capsule', a: v3(p.wa), b: v3(p.wb), radius: p.r };
}

/**
 * Whether two placed prim sets touch. On a touch, the closest points of the deepest contact go into
 * `onA`/`onB` (each on its own surface).
 */
function primsTouch(A: Prim[], B: Prim[], onA: number[] | null, onB: number[] | null): boolean {
    let best = Infinity;
    for (const pa of A) for (const pb of B) {
        if (!pa.box && !pb.box) {
            const d2 = segSeg(pa.wa, pa.wb, pb.wa, pb.wb);
            const rr = pa.r + pb.r;
            if (d2 > rr * rr) continue;
            const d = Math.sqrt(d2), gap = d - rr;
            if (gap >= best) continue;
            best = gap;
            if (onA && onB) {
                // Along the axis between the two core points: each surface point is its radius out from its core.
                const nx = d > 1e-9 ? (SEG[3] - SEG[0]) / d : 0, ny = d > 1e-9 ? (SEG[4] - SEG[1]) / d : 0, nz = d > 1e-9 ? (SEG[5] - SEG[2]) / d : 0;
                onA[0] = SEG[0] + nx * pa.r; onA[1] = SEG[1] + ny * pa.r; onA[2] = SEG[2] + nz * pa.r;
                onB[0] = SEG[3] - nx * pb.r; onB[1] = SEG[4] - ny * pb.r; onB[2] = SEG[5] - nz * pb.r;
            }
        } else {
            // Any box: overlap.ts's exact tests (they allocate, but boxes are rare and only reached on a
            // bounds overlap).
            const b = touch(asShape(pa), asShape(pb) as any);
            if (!b || b.gap >= best) continue;
            best = b.gap;
            if (onA && onB) {
                const a = touch(asShape(pb), asShape(pa) as any);
                onB[0] = b.point[0]; onB[1] = b.point[1]; onB[2] = b.point[2];
                const pA = a?.point ?? b.point;
                onA[0] = pA[0]; onA[1] = pA[1]; onA[2] = pA[2];
            }
        }
    }
    return best < Infinity;
}

// ---------------------------------------------------------------------------------------------------

/** Counters from the last {@link TriggerOverlapPass.run}, for the stats panel. */
export interface TriggerPassStats {
    candidates: number;
    tested: number;
    overlaps: number;
}

export class TriggerOverlapPass {
    private readonly _entries = new Map<TriggerBody, Entry>();
    private _list: Entry[] = [];
    private _version = -1;
    private _anyDetector = false;
    private _axis = 0;
    private _passes = 0;
    private _stamp = 0;
    private readonly _poseA = new Float64Array(7);
    private readonly _poseB = new Float64Array(7);
    private readonly _onA: number[] = [0, 0, 0];
    private readonly _onB: number[] = [0, 0, 0];
    public readonly stats: TriggerPassStats = { candidates: 0, tested: 0, overlaps: 0 };

    /**
     * Find every trigger↔trigger overlap among `triggers` (all the triggers in the world; disabled ones are
     * skipped) and bring `out` up to date: pairs still overlapping keep their object, new ones are added,
     * ended ones removed. `version` must change whenever a trigger is added, removed, enabled, disabled or
     * reshaped — the candidate list is only rebuilt then.
     */
    public run(triggers: Iterable<TriggerBody>, version: number, out: Map<number, TriggerOverlap>, geometry: ColliderGeometry<TriggerBody>): void {
        this.stats.candidates = this.stats.tested = this.stats.overlaps = 0;
        if (version !== this._version) this._rebuild(triggers, version, geometry);
        const list = this._list;
        if (!this._anyDetector || list.length < 2) { if (out.size) out.clear(); return; }
        this.stats.candidates = list.length;
        const stamp = ++this._stamp;

        // Poses and swept bounds. A trigger's bounding sphere is centred on its collider frame (its node's
        // origin: triggers are never mass-recentred) and covers every part.
        for (const e of list) {
            const b = e.body;
            if (e.prims.length === 0 || e.shapeVersion !== b.shapeVersion) { e.prims = localPrims(geometry.colliderParts(b), b); e.shapeVersion = b.shapeVersion; e.thin = thinnest(e.prims); }
            e.prev.set(e.cur);
            const r = e.radius = geometry.colliderFrame(b, e.cur);
            for (let k = 0; k < 3; k++) { e.min[k] = e.cur[k] - r; e.max[k] = e.cur[k] + r; }
            if (b.continuous && e.prevValid)
                for (let k = 0; k < 3; k++) { e.min[k] = Math.min(e.min[k], e.prev[k] - r); e.max[k] = Math.max(e.max[k], e.prev[k] + r); }
        }

        if (this._passes++ % PASSES_PER_AXIS_PICK === 0) this._pickAxis();
        const ax = this._axis;
        // Insertion sort: nearly sorted from last frame, so this is close to linear.
        for (let i = 1; i < list.length; i++) {
            const e = list[i], key = e.min[ax];
            let j = i - 1;
            while (j >= 0 && list[j].min[ax] > key) { list[j + 1] = list[j]; j--; }
            list[j + 1] = e;
        }

        const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
        for (let i = 0; i < list.length; i++) {
            const A = list[i];
            for (let j = i + 1; j < list.length; j++) {
                const B = list[j];
                if (B.min[ax] > A.max[ax]) break;
                if (B.min[o1] > A.max[o1] || A.min[o1] > B.max[o1] || B.min[o2] > A.max[o2] || A.min[o2] > B.max[o2]) continue;
                const a = A.body, b = B.body;
                if (!a.detectTriggers && !b.detectTriggers) continue;
                if ((a.collisionFilterGroup & b.mask) === 0 || (b.collisionFilterGroup & a.mask) === 0) continue;
                if (a.owner != null && a.owner === b.owner) continue;
                this.stats.tested++;
                const fraction = this._test(A, B, stamp);
                if (fraction < 0) continue;
                const key = pairKey(a, b);
                let hit = out.get(key);
                if (!hit) { hit = { a, b, pointOnA: [0, 0, 0], pointOnB: [0, 0, 0], fraction, stamp }; out.set(key, hit); }
                // Keep the pair's own a/b order for the stored points.
                const swap = hit.a !== a;
                const pa = swap ? this._onB : this._onA, pb = swap ? this._onA : this._onB;
                hit.pointOnA[0] = pa[0]; hit.pointOnA[1] = pa[1]; hit.pointOnA[2] = pa[2];
                hit.pointOnB[0] = pb[0]; hit.pointOnB[1] = pb[1]; hit.pointOnB[2] = pb[2];
                hit.fraction = fraction;
                hit.stamp = stamp;
            }
        }
        for (const [key, hit] of out) if (hit.stamp !== stamp) out.delete(key);
        this.stats.overlaps = out.size;
        for (const e of list) e.prevValid = true;
    }

    /** Forget every trigger (the world was cleared). */
    public clear(): void {
        this._entries.clear();
        this._list = [];
        this._version = -1;
        this._anyDetector = false;
    }

    private _rebuild(triggers: Iterable<TriggerBody>, version: number, geometry: ColliderGeometry<TriggerBody>): void {
        this._version = version;
        const keep = new Set<TriggerBody>();
        const list: Entry[] = [];
        let any = false;
        for (const body of triggers) {
            if (!body.enabled || geometry.colliderParts(body).length === 0) continue;
            keep.add(body);
            let e = this._entries.get(body);
            if (!e) {
                // A trigger that just came in (or back on) has no previous pose: its first test is discrete.
                e = {
                    body, prims: [], shapeVersion: -1, thin: 0,
                    cur: new Float64Array(7), radius: 0, prev: new Float64Array(7), prevValid: false,
                    min: new Float64Array(3), max: new Float64Array(3), placedStamp: -1, placedT: -1,
                };
                this._entries.set(body, e);
            }
            list.push(e);
            if (body.detectTriggers) any = true;
        }
        for (const body of this._entries.keys()) if (!keep.has(body)) this._entries.delete(body);
        // Keep last frame's order for the survivors, so the sort stays nearly linear.
        const order = new Map(this._list.map((e, i) => [e, i]));
        list.sort((x, y) => (order.get(x) ?? Infinity) - (order.get(y) ?? Infinity));
        this._list = list;
        this._anyDetector = any;
    }

    /** Sweep along the axis the triggers are most spread over (cannon's SAP heuristic). */
    private _pickAxis(): void {
        const list = this._list;
        if (list.length < 2) return;
        let best = 0, bestVar = -1;
        for (let k = 0; k < 3; k++) {
            let sum = 0, sum2 = 0;
            for (const e of list) { const c = (e.min[k] + e.max[k]) / 2; sum += c; sum2 += c * c; }
            const v = sum2 / list.length - (sum / list.length) ** 2;
            if (v > bestVar) { bestVar = v; best = k; }
        }
        this._axis = best;
    }

    /** Place `e`'s prims at sweep parameter `t` of this pass (1 = its current pose). */
    private _placeAt(e: Entry, t: number, stamp: number, scratch: Float64Array): void {
        const sweeping = t < 1 && e.body.continuous && e.prevValid;
        const tt = sweeping ? t : 1;
        if (e.placedStamp === stamp && e.placedT === tt) return;
        if (sweeping) { lerpPose(e.prev, e.cur, tt, scratch); place(e.prims, scratch); }
        else place(e.prims, e.cur);
        e.placedStamp = stamp; e.placedT = tt;
    }

    /** The first sweep parameter at which A and B touch, or -1. Fills `_onA`/`_onB`. */
    private _test(A: Entry, B: Entry, stamp: number): number {
        const sweepA = A.body.continuous && A.prevValid, sweepB = B.body.continuous && B.prevValid;
        if (!sweepA && !sweepB) {
            this._placeAt(A, 1, stamp, this._poseA);
            this._placeAt(B, 1, stamp, this._poseB);
            return primsTouch(A.prims, B.prims, this._onA, this._onB) ? 1 : -1;
        }
        // Samples close enough that nothing as thick as the thinner side can be skipped.
        const travel = Math.max(sweepA ? travelOf(A) : 0, sweepB ? travelOf(B) : 0);
        const step = Math.max(Math.min(A.thin, B.thin), 1e-3);
        const n = Math.min(MAX_SWEEP_SAMPLES, Math.max(1, Math.ceil(travel / step)));
        for (let k = 1; k <= n; k++) {
            const t = k / n;
            this._placeAt(A, t, stamp, this._poseA);
            this._placeAt(B, t, stamp, this._poseB);
            if (primsTouch(A.prims, B.prims, this._onA, this._onB)) return t;
        }
        return -1;
    }
}

function thinnest(prims: Prim[]): number {
    let t = Infinity;
    for (const p of prims) t = Math.min(t, p.r);
    return t === Infinity ? 0 : t;
}

/** An upper bound on how far any point of the trigger moved this frame: its travel plus its turn. */
function travelOf(e: Entry): number {
    const dx = e.cur[0] - e.prev[0], dy = e.cur[1] - e.prev[1], dz = e.cur[2] - e.prev[2];
    const dot = Math.min(1, Math.abs(e.prev[3] * e.cur[3] + e.prev[4] * e.cur[4] + e.prev[5] * e.cur[5] + e.prev[6] * e.cur[6]));
    const angle = 2 * Math.acos(dot);
    return Math.hypot(dx, dy, dz) + angle * e.radius;
}
