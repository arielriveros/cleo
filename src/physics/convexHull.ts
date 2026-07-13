/**
 * Convex hull generation for collider authoring. cannon-es ships `ConvexPolyhedron` but no hull
 * builder, so this is a self-contained quickhull producing exactly the `{ vertices, faces }` pair
 * cannon expects (faces are index loops, wound CCW seen from outside).
 *
 * The definition levels are an *outer* approximation, never an inner one: the hull is simplified by
 * intersecting supporting half-spaces of the mesh, and a supporting half-space contains every mesh
 * vertex by definition. Dropping planes can therefore only ever add volume, so a lower definition is
 * a looser wrapper around the same mesh — it never cuts into it. Plane selection is incremental, so
 * each level's planes are a superset of the level below: volume shrinks monotonically with quality.
 *
 * Collision support (cannon-es 0.20): convex collides with convex, box, sphere, plane, cylinder,
 * heightfield and particle. There is no convex/trimesh narrowphase.
 */

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
 * Face budgets per quality level. cannon's convex/convex narrowphase tests every face axis plus every
 * edge-edge pair, so this is a real runtime cost and not just a memory one. Six of the budget are
 * spent on the bounding box the hull is carved out of.
 */
export const HULL_BUDGETS: Record<HullQuality, number> = {
    low: 12,
    medium: 24,
    high: 48,
    veryHigh: 96,
};

type V3 = number[];
type Plane = { n: V3; d: number }; // half-space: dot(n, x) <= d
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

function epsilonFor(points: number[][]): number {
    let extent = 0;
    for (const p of points) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
    return Math.max(1e-8, extent * 1e-5);
}

/**
 * Ceiling on how many points the quickhull runs over. Quickhull is superlinear in the number of
 * points that end up *on* the hull, and an organic 40k-vertex mesh puts most of them there — enough
 * to lock the editor up for minutes. It is safe to cap: the hull is only used to propose face
 * normals, and containment comes from measuring each plane's offset against the full point set.
 */
const MAX_HULL_POINTS = 600;

/**
 * Reduce a cloud to at most `budget` points by support mapping: for each of N spread-out directions,
 * keep the furthest point along it. Every point kept is genuinely on the hull, so the normals derived
 * from them are representative of the real silhouette.
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
// Quickhull
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
// Half-space carving
// ---------------------------------------------------------------------------------------------

/**
 * Clip a convex polytope with the half-space `dot(n, x) <= d`. Retained faces keep their winding;
 * the new cut face is wound CCW about `n` so it also faces outward. Returns the polytope unchanged
 * when the plane doesn't cut it.
 */
function clipByPlane(poly: Poly, plane: Plane, eps: number): Poly {
    const dist = poly.vertices.map((v) => dot(plane.n, v) - plane.d);
    if (dist.every((x) => x <= eps)) return poly;

    const vertices: V3[] = [];
    const kept = new Map<number, number>();   // old vertex index -> new
    const onEdge = new Map<string, number>(); // edge key -> new vertex on the cut

    const keep = (i: number): number => {
        let mapped = kept.get(i);
        if (mapped === undefined) { mapped = vertices.length; kept.set(i, mapped); vertices.push(poly.vertices[i]); }
        return mapped;
    };
    const cut = (a: number, b: number): number => {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        let mapped = onEdge.get(key);
        if (mapped === undefined) {
            const t = dist[a] / (dist[a] - dist[b]);
            const va = poly.vertices[a], vb = poly.vertices[b];
            mapped = vertices.length;
            onEdge.set(key, mapped);
            vertices.push([va[0] + (vb[0] - va[0]) * t, va[1] + (vb[1] - va[1]) * t, va[2] + (vb[2] - va[2]) * t]);
        }
        return mapped;
    };

    const faces: number[][] = [];
    const capPoints = new Set<number>();

    for (const loop of poly.faces) {
        const out: number[] = [];
        for (let i = 0; i < loop.length; i++) {
            const cur = loop[i];
            const nxt = loop[(i + 1) % loop.length];
            const inCur = dist[cur] <= eps;
            const inNxt = dist[nxt] <= eps;

            if (inCur) out.push(keep(cur));
            if (inCur !== inNxt) { const p = cut(cur, nxt); out.push(p); capPoints.add(p); }
        }
        // Drop consecutive duplicates introduced by vertices sitting exactly on the plane.
        const cleaned = out.filter((v, i) => v !== out[(i + 1) % out.length]);
        if (cleaned.length >= 3) faces.push(cleaned);
    }

    // The cut is a convex planar polygon; order its points by angle about the plane normal so the
    // face comes out CCW from outside (u x v = n makes increasing angle a CCW loop about n).
    if (capPoints.size >= 3) {
        const idx = Array.from(capPoints);
        const c: V3 = [0, 0, 0];
        for (const i of idx) { c[0] += vertices[i][0]; c[1] += vertices[i][1]; c[2] += vertices[i][2]; }
        c[0] /= idx.length; c[1] /= idx.length; c[2] /= idx.length;

        const seed: V3 = Math.abs(plane.n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const u = normalize(cross(plane.n, seed));
        const v = cross(plane.n, u);
        idx.sort((a, b) => {
            const pa = sub(vertices[a], c), pb = sub(vertices[b], c);
            return Math.atan2(dot(pa, v), dot(pa, u)) - Math.atan2(dot(pb, v), dot(pb, u));
        });
        faces.push(idx);
    }

    return { vertices, faces };
}

/**
 * Pick up to `budget` well-spread face normals by farthest-point sampling, seeded from the largest
 * face. The sequence is incremental and depends only on the hull, so a bigger budget always yields a
 * superset of a smaller one — that is what makes higher definitions strictly tighter.
 */
function selectNormals(poly: Poly, budget: number): V3[] {
    const normals: V3[] = [];
    const areas: number[] = [];
    for (const loop of poly.faces) {
        const n = loopNormal(poly.vertices, loop);
        const area = length(n);
        if (area <= 0) continue;
        normals.push([n[0] / area, n[1] / area, n[2] / area]);
        areas.push(area);
    }
    if (normals.length === 0) return [];
    if (normals.length <= budget) return normals;

    let seed = 0;
    for (let i = 1; i < areas.length; i++) if (areas[i] > areas[seed]) seed = i;

    const chosen = [seed];
    // Angular distance to the nearest already-chosen normal, maintained incrementally.
    const closeness = normals.map((n) => dot(n, normals[seed]));
    while (chosen.length < budget) {
        let best = -1;
        let bestCloseness = Infinity;
        for (let i = 0; i < normals.length; i++) {
            if (closeness[i] < bestCloseness) { bestCloseness = closeness[i]; best = i; }
        }
        if (best < 0 || bestCloseness >= 0.9999) break; // nothing meaningfully new left to add
        chosen.push(best);
        for (let i = 0; i < normals.length; i++) closeness[i] = Math.max(closeness[i], dot(normals[i], normals[best]));
    }
    return chosen.map((i) => normals[i]);
}

/**
 * Weld coincident vertices, drop collinear ones from each loop, and discard the degenerate faces
 * that carving leaves behind — a bounding-box face that gets clipped down to a single touch point
 * survives as a zero-area sliver, and cannon would derive a zero-length (i.e. useless) SAT axis from
 * it. Removing them is what turns a carved AABB back into an exact box.
 */
function weld(poly: Poly, eps: number): Poly {
    const cells = new Map<string, number>();
    const vertices: V3[] = [];
    const inv = 1 / eps;
    const remap = poly.vertices.map((v) => {
        const key = `${Math.round(v[0] * inv)},${Math.round(v[1] * inv)},${Math.round(v[2] * inv)}`;
        let idx = cells.get(key);
        if (idx === undefined) { idx = vertices.length; cells.set(key, idx); vertices.push(v.slice()); }
        return idx;
    });

    const faces: number[][] = [];
    for (const original of poly.faces) {
        let loop = original.map((i) => remap[i]);
        loop = loop.filter((v, i) => v !== loop[(i + 1) % loop.length]); // consecutive duplicates

        // Collinear vertices add nothing to the plane but do break cannon's face-normal computation,
        // which reads only the first three vertices of a loop.
        for (let pass = 0; pass < 3 && loop.length >= 3; pass++) {
            const kept = loop.filter((_, i) => {
                const prev = vertices[loop[(i - 1 + loop.length) % loop.length]];
                const cur = vertices[loop[i]];
                const next = vertices[loop[(i + 1) % loop.length]];
                const a = sub(cur, prev), b = sub(next, cur);
                return length(cross(a, b)) > eps * Math.max(length(a), length(b));
            });
            if (kept.length === loop.length) break;
            loop = kept;
        }

        if (loop.length < 3) continue;
        if (length(loopNormal(vertices, loop)) <= eps * eps) continue; // zero area
        faces.push(loop);
    }

    return { vertices, faces };
}

/** Recentre on the centroid — cannon validates face planes against the origin — and compact. */
function finalize(poly: Poly, eps: number): Hull | null {
    const cleaned = weld(poly, eps);

    const remap = new Map<number, number>();
    const vertices: V3[] = [];
    const faces = cleaned.faces.map((loop) => loop.map((i) => {
        let mapped = remap.get(i);
        if (mapped === undefined) { mapped = vertices.length; remap.set(i, mapped); vertices.push(cleaned.vertices[i].slice()); }
        return mapped;
    }));
    if (vertices.length < 4 || faces.length < 4) return null;

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

/**
 * Convex hull of a mesh, simplified to the face budget for `quality`. The result is guaranteed to
 * contain every input position: it is carved out of the mesh's bounding box using only supporting
 * planes, whose offsets are measured against the full point set. Null for degenerate geometry.
 */
export function hullFromPositions(positions: number[][], quality: HullQuality): Hull | null {
    if (positions.length < 4) return null;

    const eps = epsilonFor(positions);
    const silhouette = quickhull(supportSample(deduplicate(positions, eps), MAX_HULL_POINTS), eps);
    if (!silhouette) return null;

    // Support of the *whole* point set along a direction. Measuring against every original position
    // (not the deduplicated/hulled subset) is what makes containment exact rather than approximate.
    const support = (n: V3): number => {
        let max = -Infinity;
        for (const p of positions) max = Math.max(max, dot(n, p));
        return max;
    };

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of positions)
        for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }

    // Start from the bounding box (6 supporting planes) and carve it down with the selected ones.
    let poly: Poly = {
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

    for (const n of selectNormals(silhouette, Math.max(4, HULL_BUDGETS[quality] - 6))) {
        poly = clipByPlane(poly, { n, d: support(n) }, eps);
        if (poly.faces.length < 4) return null;
    }

    return finalize(poly, eps);
}
