/**
 * Convex hull generation for collider authoring: a self-contained quickhull producing the
 * `{ vertices, faces }` pair cannon expects (index loops, wound CCW seen from outside).
 *
 * Definition semantics: Low is exactly the mesh's bounding box; higher levels carve it with
 * supporting half-spaces whose offsets are measured against every mesh position, so plane sets are
 * a superset of the level below and volume shrinks monotonically with quality. Every carve step is
 * validated and skipped on failure, and a final containment audit falls back to the box outright —
 * degradation is allowed, a vertex outside the hull is not.
 *
 * cannon-es 0.20 collides convex with convex, box, sphere, plane, cylinder, heightfield and
 * particle. There is no convex/trimesh narrowphase.
 */

import { Logger } from "../core/logger";

export type Hull = {
    /** Hull points, recentred so the centroid sits at the origin (see `center`). */
    vertices: number[][];
    /** Index loops into `vertices`, CCW from outside. Faces may be polygons, not just triangles. */
    faces: number[][];
    /** Where the hull's centroid was in the source point cloud; add it to the shape offset. */
    center: number[];
};

export type HullQuality = 'low' | 'medium' | 'high' | 'veryHigh';

/**
 * Total face budgets per quality level: the 6 bounding-box planes plus carve planes. cannon's
 * convex/convex narrowphase tests every face axis plus every edge-edge pair, so faces cost runtime.
 */
export const HULL_BUDGETS: Record<HullQuality, number> = {
    low: 6,       // the bounding box, untouched
    medium: 14,   // + up to 8 carve planes
    high: 26,     // + up to 20
    veryHigh: 50, // + up to 44
};

type V3 = number[];
type Poly = { vertices: V3[]; faces: number[][] };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const length = (a: V3): number => Math.sqrt(dot(a, a));

function normalize(a: V3): V3 {
    const l = length(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** Newell normal of a polygon loop (unnormalized; its length is twice the area). */
function loopNormal(vertices: V3[], loop: number[]): V3 {
    const n: V3 = [0, 0, 0];
    for (let i = 0; i < loop.length; i++) {
        const a = vertices[loop[i]];
        const b = vertices[loop[(i + 1) % loop.length]];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return n;
}

/** Signed volume of a polytope with outward CCW faces (divergence theorem, fan per face). */
function volumeOf(poly: Poly): number {
    let v = 0;
    for (const f of poly.faces) {
        for (let i = 1; i < f.length - 1; i++) {
            const a = poly.vertices[f[0]], b = poly.vertices[f[i]], c = poly.vertices[f[i + 1]];
            v += dot(a, cross(b, c)) / 6;
        }
    }
    return Math.abs(v);
}

function epsilonFor(points: number[][]): number {
    let extent = 0;
    for (const p of points) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
    return Math.max(1e-8, extent * 1e-5);
}

/**
 * Ceiling on how many points the quickhull runs over; it is superlinear in the points that end up
 * ON the hull. Safe to cap: the silhouette hull only proposes carve-plane NORMALS, and containment
 * comes from measuring each plane's offset against the full point set.
 */
const MAX_HULL_POINTS = 600;

/**
 * Reduce a cloud to at most `budget` points by support mapping: for each of N spread-out directions,
 * keep the furthest point along it. Every point kept is genuinely on the hull.
 */
function supportSample(points: V3[], budget: number): V3[] {
    if (points.length <= budget) return points;

    const keep = new Set<number>();
    for (let axis = 0; axis < 3; axis++) {
        let lo = 0, hi = 0;
        for (let i = 1; i < points.length; i++) {
            if (points[i][axis] < points[lo][axis]) lo = i;
            if (points[i][axis] > points[hi][axis]) hi = i;
        }
        keep.add(lo);
        keep.add(hi);
    }

    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < budget; i++) {
        const y = 1 - (2 * i) / Math.max(1, budget - 1);
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        const d: V3 = [Math.cos(theta) * r, y, Math.sin(theta) * r];

        let best = 0;
        let bestDot = -Infinity;
        for (let j = 0; j < points.length; j++) {
            const v = dot(d, points[j]);
            if (v > bestDot) { bestDot = v; best = j; }
        }
        keep.add(best);
    }
    return Array.from(keep).map((i) => points[i]);
}

/** Collapse points that land in the same `eps` grid cell (imported meshes split vertices per-UV). */
function deduplicate(points: number[][], eps: number): V3[] {
    const seen = new Set<string>();
    const out: V3[] = [];
    const inv = 1 / eps;
    for (const p of points) {
        const key = `${Math.round(p[0] * inv)},${Math.round(p[1] * inv)},${Math.round(p[2] * inv)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([p[0], p[1], p[2]]);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Quickhull (exact hull of a point set, triangle output)
// ---------------------------------------------------------------------------------------------

interface Face {
    idx: number[];
    normal: V3;
    offset: number;    // plane: dot(normal, x) = offset
    outside: number[];
    dead: boolean;
}

function makeFace(points: V3[], a: number, b: number, c: number): Face | null {
    const normal = normalize(cross(sub(points[b], points[a]), sub(points[c], points[a])));
    if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return null;
    return { idx: [a, b, c], normal, offset: dot(normal, points[a]), outside: [], dead: false };
}

const distanceTo = (f: Face, p: V3): number => dot(f.normal, p) - f.offset;

/** Seed tetrahedron, or null if the cloud is degenerate (collinear / planar / too small). */
function initialFaces(points: V3[], eps: number): Face[] | null {
    if (points.length < 4) return null;

    const extremes: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
        let lo = 0, hi = 0;
        for (let i = 1; i < points.length; i++) {
            if (points[i][axis] < points[lo][axis]) lo = i;
            if (points[i][axis] > points[hi][axis]) hi = i;
        }
        extremes.push(lo, hi);
    }

    let a = -1, b = -1, bestLen = eps;
    for (let i = 0; i < extremes.length; i++) {
        for (let j = i + 1; j < extremes.length; j++) {
            const d = length(sub(points[extremes[i]], points[extremes[j]]));
            if (d > bestLen) { bestLen = d; a = extremes[i]; b = extremes[j]; }
        }
    }
    if (a < 0) return null; // all points coincident

    const ab = sub(points[b], points[a]);
    let c = -1, bestArea = eps;
    for (let i = 0; i < points.length; i++) {
        const d = length(cross(ab, sub(points[i], points[a]))) / bestLen;
        if (d > bestArea) { bestArea = d; c = i; }
    }
    if (c < 0) return null; // collinear

    const n = normalize(cross(ab, sub(points[c], points[a])));
    const planeOffset = dot(n, points[a]);
    let d = -1, bestDist = eps;
    for (let i = 0; i < points.length; i++) {
        const dist = Math.abs(dot(n, points[i]) - planeOffset);
        if (dist > bestDist) { bestDist = dist; d = i; }
    }
    if (d < 0) return null; // planar

    const centroid: V3 = [0, 1, 2].map((k) =>
        (points[a][k] + points[b][k] + points[c][k] + points[d][k]) / 4);

    const faces: Face[] = [];
    for (const [i, j, k] of [[a, b, c], [a, b, d], [a, c, d], [b, c, d]]) {
        let face = makeFace(points, i, j, k);
        if (!face) return null;
        if (distanceTo(face, centroid) > 0) face = makeFace(points, i, k, j);
        if (!face) return null;
        faces.push(face);
    }
    return faces;
}

/**
 * Exact convex hull of the given points, as triangles. Every input point lies on or inside it.
 * Returns null when the cloud is degenerate (fewer than 4 unique points, collinear, or planar) —
 * cannon's SAT produces NaN axes on a zero-volume polyhedron.
 */
function quickhull(points: V3[], eps: number): Poly | null {
    const faces = initialFaces(points, eps);
    if (!faces) return null;

    const assign = (candidates: number[], targets: Face[]) => {
        for (const i of candidates) {
            for (const f of targets) {
                if (distanceTo(f, points[i]) > eps) { f.outside.push(i); break; }
            }
        }
    };
    assign(points.map((_, i) => i), faces);

    let live = faces.filter((f) => f.outside.length > 0);
    let guard = points.length * 4 + 64; // hard stop against a pathological non-terminating expansion
    while (live.length > 0 && guard-- > 0) {
        const face = live[0];

        let apex = face.outside[0];
        let bestDist = -Infinity;
        for (const i of face.outside) {
            const d = distanceTo(face, points[i]);
            if (d > bestDist) { bestDist = d; apex = i; }
        }

        // Every face the apex can see is removed; the boundary of that region is the horizon.
        const visible = faces.filter((f) => !f.dead && distanceTo(f, points[apex]) > eps);
        const orphans: number[] = [];
        const edges = new Map<string, [number, number]>();
        for (const f of visible) {
            f.dead = true;
            for (const i of f.outside) if (i !== apex) orphans.push(i);
            for (let i = 0; i < f.idx.length; i++) {
                const u = f.idx[i];
                const v = f.idx[(i + 1) % f.idx.length];
                if (edges.has(`${v},${u}`)) edges.delete(`${v},${u}`);
                else edges.set(`${u},${v}`, [u, v]);
            }
        }

        // Cone the horizon back to the apex; the edge keeps its winding, so (u, v, apex) is CCW.
        const created: Face[] = [];
        for (const [u, v] of edges.values()) {
            const f = makeFace(points, u, v, apex);
            if (f) { faces.push(f); created.push(f); }
        }

        assign(orphans, created);

        for (let i = faces.length - 1; i >= 0; i--) if (faces[i].dead) faces.splice(i, 1);
        live = faces.filter((f) => f.outside.length > 0);
    }

    if (faces.length < 4) return null;
    return { vertices: points, faces: faces.map((f) => f.idx) };
}

// ---------------------------------------------------------------------------------------------
// Cleanup: coplanar merge, edge-consistent collinear removal, welding
// ---------------------------------------------------------------------------------------------

/**
 * Merge adjacent coplanar faces into polygon loops, cutting cannon's SAT axis count and its O(E^2)
 * edge construction. A group whose boundary does not walk into one clean loop keeps its triangles.
 */
function mergeCoplanar(poly: Poly, eps: number): Poly {
    const groups: { normal: V3; offset: number; faces: number[][] }[] = [];
    for (const face of poly.faces) {
        const raw = loopNormal(poly.vertices, face);
        const area = length(raw);
        if (area <= eps * eps) continue; // zero-area sliver — drop
        const n: V3 = [raw[0] / area, raw[1] / area, raw[2] / area];
        const offset = dot(n, poly.vertices[face[0]]);
        // The tolerance must stay razor thin: faces on the same carve/box plane are exactly coplanar
        // by construction, and merging planes ~1 mrad apart tilts the representative plane enough to
        // read as a containment violation at the far corners.
        const group = groups.find((g) => dot(g.normal, n) > 1 - 1e-9 && Math.abs(g.offset - offset) < eps * 2);
        if (group) group.faces.push(face);
        else groups.push({ normal: n, offset, faces: [face] });
    }

    const outFaces: number[][] = [];
    for (const group of groups) {
        if (group.faces.length === 1) { outFaces.push(group.faces[0].slice()); continue; }

        // Directed edges without an opposing twin inside the group form the region's boundary.
        const edges = new Map<string, [number, number]>();
        for (const f of group.faces) {
            for (let i = 0; i < f.length; i++) {
                const u = f[i];
                const v = f[(i + 1) % f.length];
                if (edges.has(`${v},${u}`)) edges.delete(`${v},${u}`);
                else edges.set(`${u},${v}`, [u, v]);
            }
        }

        const next = new Map<number, number>();
        let doubled = false;
        for (const [u, v] of edges.values()) { if (next.has(u)) doubled = true; next.set(u, v); }

        const start = edges.values().next().value?.[0];
        const loop: number[] = [];
        if (!doubled && start !== undefined) {
            let cur = start;
            while (loop.length <= next.size) {
                loop.push(cur);
                const nxt = next.get(cur);
                if (nxt === undefined) break;
                cur = nxt;
                if (cur === start) break;
            }
            if (cur === start && loop.length === next.size && loop.length >= 3) {
                outFaces.push(loop);
                continue;
            }
        }
        for (const f of group.faces) outFaces.push(f.slice()); // walk failed — keep triangles
    }
    return { vertices: poly.vertices, faces: outFaces };
}

/**
 * Weld near-coincident vertices and remove collinear ones. Removal must be edge-consistent: a vertex
 * is dropped only when collinear with its neighbours on EVERY face referencing it, or shared edges
 * desync — cannon derives each face's normal from the loop's first three vertices.
 */
function weld(poly: Poly, eps: number): Poly {
    // 1. Weld by epsilon grid (global, so remapping is identical across all faces).
    const cells = new Map<string, number>();
    const vertices: V3[] = [];
    const inv = 1 / (eps * 2);
    const remap = poly.vertices.map((v) => {
        const key = `${Math.round(v[0] * inv)},${Math.round(v[1] * inv)},${Math.round(v[2] * inv)}`;
        let idx = cells.get(key);
        if (idx === undefined) { idx = vertices.length; cells.set(key, idx); vertices.push(v.slice()); }
        return idx;
    });

    let faces = poly.faces
        .map((loop) => {
            const l = loop.map((i) => remap[i]);
            return l.filter((v, i) => v !== l[(i + 1) % l.length]); // drop consecutive duplicates
        })
        .filter((l) => l.length >= 3 && length(loopNormal(vertices, l)) > eps * eps);

    // 2. A vertex is removable only if it adds nothing to ANY face that uses it.
    const removable = new Map<number, boolean>();
    for (const loop of faces) {
        for (let i = 0; i < loop.length; i++) {
            const v = loop[i];
            const prev = vertices[loop[(i - 1 + loop.length) % loop.length]];
            const cur = vertices[v];
            const next = vertices[loop[(i + 1) % loop.length]];
            const a = sub(cur, prev), b = sub(next, cur);
            const collinearHere = length(cross(a, b)) <= eps * Math.max(length(a), length(b));
            removable.set(v, (removable.get(v) ?? true) && collinearHere);
        }
    }

    faces = faces
        .map((loop) => loop.filter((v) => !removable.get(v)))
        .filter((l) => l.length >= 3 && length(loopNormal(vertices, l)) > eps * eps);

    return { vertices, faces };
}

/** Compact to referenced vertices, recentre on the centroid, and guarantee outward CCW winding. */
function finalize(poly: Poly, eps: number, merge: boolean = true): Hull | null {
    const cleaned = weld(merge ? mergeCoplanar(poly, eps) : poly, eps);

    const remap = new Map<number, number>();
    const vertices: V3[] = [];
    const faces = cleaned.faces.map((loop) => loop.map((i) => {
        let mapped = remap.get(i);
        if (mapped === undefined) { mapped = vertices.length; remap.set(i, mapped); vertices.push(cleaned.vertices[i].slice()); }
        return mapped;
    }));
    if (vertices.length < 4 || faces.length < 4) return null;

    // Recentre on the centroid — cannon validates every face plane against the origin.
    const center: V3 = [0, 0, 0];
    for (const v of vertices) { center[0] += v[0]; center[1] += v[1]; center[2] += v[2]; }
    center[0] /= vertices.length; center[1] /= vertices.length; center[2] /= vertices.length;
    for (const v of vertices) { v[0] -= center[0]; v[1] -= center[1]; v[2] -= center[2]; }

    for (const face of faces) if (dot(loopNormal(vertices, face), vertices[face[0]]) < 0) face.reverse();

    return { vertices, faces, center };
}

/** Exact convex hull of a point cloud. Null when degenerate. */
export function convexHull(points: number[][], eps?: number): Hull | null {
    if (points.length < 4) return null;
    const epsilon = eps ?? epsilonFor(points);
    const poly = quickhull(deduplicate(points, epsilon), epsilon);
    return poly ? finalize(poly, epsilon) : null;
}

// ---------------------------------------------------------------------------------------------
// Definition carve: AABB progressively cut by supporting half-spaces
// ---------------------------------------------------------------------------------------------

/**
 * Distinct face normals of the silhouette hull, deduplicated and returned largest-area first, capped.
 * These are the carve-plane candidates; `hullFromPositions` picks among them greedily by cut depth,
 * NOT by angular spread, which fills the budget with planes coincident with the bounding box.
 */
function candidateNormals(poly: Poly, cap: number): V3[] {
    const list: { n: V3; area: number }[] = [];
    for (const loop of poly.faces) {
        const raw = loopNormal(poly.vertices, loop);
        const area = length(raw);
        if (area <= 0) continue;
        const n: V3 = [raw[0] / area, raw[1] / area, raw[2] / area];
        const existing = list.find((c) => dot(c.n, n) > 1 - 1e-9);
        if (existing) existing.area += area;
        else list.push({ n, area });
    }
    list.sort((a, b) => b.area - a.area);
    return list.slice(0, cap).map((c) => c.n);
}

/** The mesh's axis-aligned bounding box as a polytope (8 vertices, 6 quads, CCW outward). */
function boundingBoxPoly(positions: number[][]): Poly | null {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of positions)
        for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
    if (!(max[0] > min[0]) || !(max[1] > min[1]) || !(max[2] > min[2])) return null; // flat or empty

    return {
        vertices: [
            [min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]],
            [min[0], min[1], max[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]],
        ],
        faces: [
            [3, 2, 1, 0], // -Z
            [4, 5, 6, 7], // +Z
            [0, 1, 5, 4], // -Y
            [2, 3, 7, 6], // +Y
            [0, 4, 7, 3], // -X
            [1, 2, 6, 5], // +X
        ],
    };
}

/**
 * Cut `poly` with the half-space `dot(n, x) <= d`, rebuilding topology with quickhull: the clipped
 * polytope is the convex hull of the kept vertices plus the plane/edge crossings. Vertices within
 * eps of the plane count as kept and crossings only come from strict sign changes, bounding the
 * interpolation denominator below by 2·eps. Returns null when the cut degenerates.
 */
function cutPoly(poly: Poly, n: V3, d: number, eps: number): Poly | null {
    const dist = poly.vertices.map((v) => dot(n, v) - d);

    let overshoot = 0;
    for (const x of dist) overshoot = Math.max(overshoot, x);
    if (overshoot <= 2 * eps) return poly; // plane doesn't meaningfully cut

    const points: V3[] = [];
    for (let i = 0; i < poly.vertices.length; i++)
        if (dist[i] <= eps) points.push(poly.vertices[i]);

    // Unique undirected edges from the face loops.
    const seen = new Set<string>();
    for (const loop of poly.faces) {
        for (let i = 0; i < loop.length; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % loop.length];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            if (seen.has(key)) continue;
            seen.add(key);

            // Strict crossing only: one end clearly inside, the other clearly outside.
            const lo = dist[a] < dist[b] ? a : b;
            const hi = lo === a ? b : a;
            if (dist[lo] >= -eps || dist[hi] <= eps) continue;

            const t = Math.min(1, Math.max(0, dist[lo] / (dist[lo] - dist[hi])));
            const va = poly.vertices[lo], vb = poly.vertices[hi];
            points.push([va[0] + (vb[0] - va[0]) * t, va[1] + (vb[1] - va[1]) * t, va[2] + (vb[2] - va[2]) * t]);
        }
    }

    if (points.length < 4) return null;
    return quickhull(points, eps);
}

/**
 * Convex hull of a mesh at the requested definition. Low is the mesh's bounding box; higher levels
 * carve it with supporting half-spaces measured against every input position, so the result always
 * contains the whole mesh. Null only for degenerate geometry (flat, or fewer than 4 distinct points).
 */
export function hullFromPositions(positions: number[][], quality: HullQuality): Hull | null {
    if (positions.length < 4) return null;

    const eps = epsilonFor(positions);
    let poly = boundingBoxPoly(positions);
    if (!poly) return null;
    const box = poly;

    let extent = 0;
    for (const p of positions) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));

    // An unrecognized quality value must degrade to medium, not to a NaN budget that skips the carve.
    const planeBudget = (HULL_BUDGETS[quality] ?? HULL_BUDGETS.medium) - 6;
    if (planeBudget > 0) {
        // Candidate normals come from the exact hull of a bounded silhouette sample; offsets are
        // measured against the FULL point set, which is what makes containment exact.
        const silhouette = quickhull(supportSample(deduplicate(positions, eps), MAX_HULL_POINTS), eps);
        if (!silhouette) {
            Logger.warn(`convexHull: silhouette hull failed (${positions.length} positions); the '${quality}' hull stays at the bounding box.`, 'Physics');
        } else {
            const support = (n: V3): number => {
                let max = -Infinity;
                for (const p of positions) max = Math.max(max, dot(n, p));
                return max;
            };

            const candidates = candidateNormals(silhouette, 256);
            const supports = candidates.map((n) => support(n));
            const used: boolean[] = new Array(candidates.length).fill(false);

            // Greedy deepest-cut-first, until the budget is filled or nothing cuts deeper than
            // tolerance. The sequence is deterministic and quality-independent, so a higher
            // definition always extends the lower one's cuts and volume stays monotone.
            let cut = 0, failed = 0;
            let vol = volumeOf(poly);
            while (cut < planeBudget) {
                let best = -1;
                let bestDepth = 2 * eps;
                for (let i = 0; i < candidates.length; i++) {
                    if (used[i]) continue;
                    let depth = -Infinity;
                    for (const v of poly.vertices) depth = Math.max(depth, dot(candidates[i], v));
                    depth -= supports[i];
                    if (depth > bestDepth) { bestDepth = depth; best = i; }
                }
                if (best < 0) break; // nothing left that would cut — the hull IS this polytope

                used[best] = true;
                const next = cutPoly(poly, candidates[best], supports[best], eps);
                if (!next || next === poly) { failed++; continue; }
                // A cut can only remove volume; growth means the step went numerically wrong.
                const nextVol = volumeOf(next);
                if (next.faces.length < 4 || nextVol > vol + eps) { failed++; continue; }
                poly = next;
                vol = nextVol;
                cut++;
            }

            if (cut === 0 && failed > 0) {
                // Candidates wanted to cut but every attempt degenerated. A boxy mesh where nothing
                // cuts at all is normal and stays silent.
                Logger.warn(
                    `convexHull: all ${failed} cutting planes failed (quality='${quality}'). ` +
                    `candidates=${candidates.length} positions=${positions.length} extent=${extent.toExponential(3)} eps=${eps.toExponential(3)}. ` +
                    `Mesh captured in __cleoHullDebug — run copy(JSON.stringify(__cleoHullDebug)) to export it.`,
                    'Physics'
                );
                try { (globalThis as any).__cleoHullDebug = { quality, positions }; } catch { /* ignore */ }
            }
        }
    }

    // Containment audit: every input vertex must be on or inside every face plane. Each plane is
    // anchored at its own loop's outermost vertex, and the tolerance covers the eps-scale drift
    // finalize introduces through weld snapping and coplanar merging.
    const tol = Math.max(eps * 20, extent * 5e-4);
    const containsAll = (hull: Hull): boolean => {
        const planes = hull.faces.map((f) => {
            const n = normalize(loopNormal(hull.vertices, f));
            let d = -Infinity;
            for (const i of f) d = Math.max(d, dot(n, hull.vertices[i]));
            return { n, d };
        });
        for (const p of positions) {
            const local = [p[0] - hull.center[0], p[1] - hull.center[1], p[2] - hull.center[2]];
            for (const pl of planes) {
                if (dot(pl.n, local) - pl.d > tol) return false;
            }
        }
        return true;
    };

    // Failure ladder: a bad coplanar merge must cost faces, never definition. The unmerged variant
    // keeps the carve's exact planes as triangles, so only a carve bug reaches the box fallback.
    const merged = finalize(poly, eps);
    if (merged && containsAll(merged)) return merged;

    const unmerged = finalize(poly, eps, false);
    if (unmerged && containsAll(unmerged)) {
        Logger.warn('convexHull: coplanar merge violated containment; using unmerged hull faces.', 'Physics');
        return unmerged;
    }

    Logger.warn('convexHull: carve failed the containment audit; falling back to the bounding box.', 'Physics');
    return finalize(box, eps);
}
