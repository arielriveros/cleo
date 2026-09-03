/**
 * Baking a navigation mesh: world-space triangles in, walkable convex region contours out.
 *
 * A LEAF, and aggressively so. Everything arrives as FLAT typed arrays — no `Node`, no `Scene`, no
 * `Geometry`, nothing that knows what a model is. Gathering the triangles is the caller's job and a
 * genuinely fiddly one (LOD levels, skinned meshes, wireframe helper geometry, instanced foliage,
 * invisible colliders); deciding which of them are walkable is pure geometry, and keeping the two
 * apart is what lets the interesting half be tested in three lines.
 *
 * Flat arrays are also what lets this run in a worker unchanged: `number[][]` is not transferable,
 * structured-clones as one JS object per vertex, and `new Float32Array(number[][])` yields NaN rather
 * than throwing — the trap `foliageRules.bakeModel` and `pack.ts` already record.
 *
 * ## The pipeline
 *
 *   1. **Slope filter.** A triangle whose normal leans further from +Y than `maxSlope` is a wall.
 *   2. **Weld.** Snap positions to a quantisation grid. This is not an optimisation — it is
 *      load-bearing. Yuka matches half-edge twins by **exact float equality**, so two triangles that
 *      share an edge to within a millionth of a unit share *nothing* as far as the graph is
 *      concerned, and the navmesh silently comes out as a pile of disconnected islands.
 *   3. **Merge.** Handed to Yuka, which fuses coplanar neighbours into the largest convex regions it
 *      can. This is the expensive stage and the reason a bake is stored rather than recomputed.
 *   4. **Simplify.** Yuka's merge keeps collinear vertices — a 3x1 strip fusing into one rectangle
 *      comes back with eight points rather than four — and every one of them is stored forever.
 *
 * ## Agent radius is NOT applied here, and that was a considered reversal
 *
 * The obvious approach — clip each region back from its walls by the agent's radius — was built,
 * tested, and does not work. A wall gives you a half-space, and clipping a convex region by it pulls
 * back the WHOLE region, including the stretches of its boundary that are shared with a neighbour
 * rather than walled. Measured on a corridor with a side room: every region shrank correctly and the
 * mesh came apart into three islands with no edges between them, because one side of each shared edge
 * had moved and the other had not. Clipping cannot express "pull back near *this* wall only"; doing
 * it properly means offsetting the mesh's boundary loops, which is a different algorithm.
 *
 * So clearance is applied at PATH time instead — `navPath.insetCorners` pushes a funnelled waypoint
 * off the corner it hugs, along the bisector, into open space. That is local, exact, costs nothing at
 * bake time, and lets two agents of different sizes share one navmesh.
 *
 * ## What this deliberately is not
 *
 * Not Recast. There is no voxelisation, no span merging and no region partitioning, so an overhang
 * does not produce two floors and a staircase does not become a ramp. Yuka's navmesh is XZ-planar
 * anyway (its area, convexity and containment tests all ignore Y), so a voxel front-end would be
 * building detail the consumer cannot represent.
 */

import { CleoNavMesh } from "./navMesh";
import type { NavMeshData } from "./navMesh";
import { Vector3 } from "./yuka";
import { clamp } from "../core/math";

/**
 * Triangles to bake, in WORLD space.
 *
 * `indices` may be empty, in which case consecutive position triples are the triangles — the same
 * fallback `Geometry` itself makes for non-indexed meshes.
 */
export interface TriangleSoup {
    positions: Float32Array;
    indices: Uint32Array;
}

export interface NavBakeSettings {
    /** Steepest walkable incline, in DEGREES from horizontal. 0 accepts only dead-flat ground. */
    maxSlope: number;
    /**
     * Grid the welder snaps to, in world units. Bigger closes wider seams between meshes that were
     * never authored to line up; too big and distinct surfaces fuse into one.
     */
    weldTolerance: number;
    /** Triangles smaller than this are dropped as degenerate slivers. */
    minTriangleArea: number;
    /** How far off a straight line a contour vertex may sit and still be dropped. */
    simplifyTolerance: number;
}

export const NAV_BAKE_DEFAULTS: NavBakeSettings = {
    maxSlope: 45,
    weldTolerance: 0.01,
    minTriangleArea: 1e-4,
    simplifyTolerance: 1e-3,
};

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Every field defaulted and clamped, so a partial or junk record passes. Mirrors `steeringTuning`. */
export function navBakeSettings(over?: Partial<NavBakeSettings> | null): NavBakeSettings {
    const o = (over ?? {}) as Partial<NavBakeSettings>;
    const d = NAV_BAKE_DEFAULTS;
    return {
        maxSlope: clamp(num(o.maxSlope, d.maxSlope), 0, 89),
        // Never zero: welding to a zero grid is not welding, and Yuka's twin matching needs it.
        weldTolerance: Math.max(1e-5, num(o.weldTolerance, d.weldTolerance)),
        minTriangleArea: Math.max(0, num(o.minTriangleArea, d.minTriangleArea)),
        simplifyTolerance: Math.max(0, num(o.simplifyTolerance, d.simplifyTolerance)),
    };
}

export interface NavBakeResult {
    data: NavMeshData;
    /** Triangles that survived the slope filter. */
    walkableTriangles: number;
    /** Triangles rejected as too steep, degenerate or duplicated. */
    rejectedTriangles: number;
    regions: number;
}

export const EMPTY_BAKE_RESULT: NavBakeResult = {
    data: { vertices: new Float32Array(0), counts: new Uint32Array(0) },
    walkableTriangles: 0,
    rejectedTriangles: 0,
    regions: 0,
};

// The bake is XZ-planar because Yuka's navmesh is: MathUtils.area is a signed area in XZ and drives
// convexity, containment and the funnel alike. `isNavigableUp` in navMesh.ts is what refuses a world
// whose gravity disagrees, so this constant is safe rather than an oversight.
const UP_X = 0, UP_Y = 1, UP_Z = 0;

// ---------------------------------------------------------------------------------------------------
// 1-2. Filtering and welding
// ---------------------------------------------------------------------------------------------------

/** One triangle, as three indices into a welded vertex table. */
interface WeldedTriangles {
    vertices: number[]; // flat xyz
    triangles: number[]; // flat index triples
    walkable: number;
    rejected: number;
}

/**
 * Slope-filter and weld in one pass.
 *
 * Welding SECOND would be wrong in a subtle way: quantising first can turn a barely-walkable sliver
 * into a degenerate one, and we want the slope decision made against the geometry as authored.
 */
function filterAndWeld(soup: TriangleSoup, settings: NavBakeSettings): WeldedTriangles {
    const { positions, indices } = soup;
    const out: WeldedTriangles = { vertices: [], triangles: [], walkable: 0, rejected: 0 };

    const count = indices.length > 0 ? indices.length : positions.length / 3;
    if (count < 3) return out;

    const cosLimit = Math.cos(settings.maxSlope * Math.PI / 180);
    const grid = settings.weldTolerance;
    const lookup = new Map<string, number>();
    const seen = new Set<string>();

    const at = (i: number) => (indices.length > 0 ? indices[i] : i) * 3;

    for (let t = 0; t + 2 < count; t += 3) {
        const ia = at(t), ib = at(t + 1), ic = at(t + 2);
        if (ia + 2 >= positions.length || ib + 2 >= positions.length || ic + 2 >= positions.length) break;

        const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
        const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
        const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

        // Newell-free normal: (b - a) x (c - a). Its magnitude is twice the triangle's area, so the
        // degenerate test comes free with the slope test.
        const abx = bx - ax, aby = by - ay, abz = bz - az;
        const acx = cx - ax, acy = cy - ay, acz = cz - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        const length = Math.hypot(nx, ny, nz);

        if (length * 0.5 < settings.minTriangleArea) { out.rejected++; continue; }

        // NOT abs(): a downward-facing triangle is a ceiling, and flipping it would turn the underside
        // of every box collider into a floor buried inside the box.
        const cosSlope = (nx * UP_X + ny * UP_Y + nz * UP_Z) / length;
        if (cosSlope < cosLimit) { out.rejected++; continue; }

        const va = weld(out.vertices, lookup, ax, ay, az, grid);
        const vb = weld(out.vertices, lookup, bx, by, bz, grid);
        const vc = weld(out.vertices, lookup, cx, cy, cz, grid);
        // Welding can collapse a sliver into a line. Such a triangle has no area to contribute and
        // would be a zero-area polygon that throws inside Yuka's funnel much later.
        if (va === vb || vb === vc || va === vc) { out.rejected++; continue; }

        // Two coincident coplanar triangles (an object sitting exactly on the ground, a doubled-up
        // collider) would give Yuka three half-edges on one edge, and its twin matching pairs the
        // first two it meets. The resulting graph is quietly wrong rather than empty.
        const key = [va, vb, vc].sort((p, q) => p - q).join(',');
        if (seen.has(key)) { out.rejected++; continue; }
        seen.add(key);

        out.triangles.push(va, vb, vc);
        out.walkable++;
    }
    return out;
}

/**
 * Snap a position to the weld grid and return its index in the shared table.
 *
 * The stored position is the SNAPPED one, not the original. Storing the original would defeat the
 * purpose: Yuka compares twin vertices with `===`, so two triangles must end up with bit-identical
 * coordinates on their shared edge, not merely near-identical ones.
 */
function weld(
    vertices: number[], lookup: Map<string, number>, x: number, y: number, z: number, grid: number,
): number {
    const qx = Math.round(x / grid);
    const qy = Math.round(y / grid);
    const qz = Math.round(z / grid);
    const key = `${qx},${qy},${qz}`;
    const found = lookup.get(key);
    if (found !== undefined) return found;

    const index = vertices.length / 3;
    vertices.push(qx * grid, qy * grid, qz * grid);
    lookup.set(key, index);
    return index;
}

// ---------------------------------------------------------------------------------------------------
// 3. T-junctions
// ---------------------------------------------------------------------------------------------------

/**
 * Split every triangle edge that another vertex lands in the middle of.
 *
 * **This is why a bake of real level geometry connects at all.** Yuka twins two half-edges only when
 * they run between the *same two vertices*. A 6x2 floor slab meeting a 2x2 platform shares a 2-unit
 * stretch of boundary, but the slab's edge is 6 units long and the platform's is 2 — different
 * endpoints, no twin, and the two surfaces end up in separate graph islands. Every path between them
 * then comes back empty, with nothing anywhere to say why.
 *
 * Welding cannot fix this; the vertices already coincide, it is the EDGES that disagree. So each
 * triangle edge collects the welded vertices lying strictly inside it, and the triangle is re-fanned
 * around the resulting boundary loop. The loop is still convex (a triangle plus collinear boundary
 * points), so a fan from its first vertex is a valid triangulation.
 *
 * Candidates come from a coarse hash of the vertex table rather than a scan: the AABB of a floor
 * edge is thin, so this touches a handful of buckets instead of every vertex in the level.
 */
function splitTJunctions(welded: WeldedTriangles, tolerance: number): void {
    const { vertices, triangles } = welded;
    const vertexCount = vertices.length / 3;
    if (vertexCount === 0 || triangles.length === 0) return;

    // A cell large enough that a typical edge spans few of them, but small enough to stay selective.
    const cell = Math.max(tolerance * 64, 0.5);
    const key = (x: number, y: number, z: number) =>
        `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

    const buckets = new Map<string, number[]>();
    for (let v = 0; v < vertexCount; v++) {
        const k = key(vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]);
        const bucket = buckets.get(k);
        if (bucket) bucket.push(v); else buckets.set(k, [v]);
    }

    /** Welded vertices strictly between `a` and `b`, ordered along the edge. */
    const between = (a: number, b: number): number[] => {
        const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
        const bx = vertices[b * 3], by = vertices[b * 3 + 1], bz = vertices[b * 3 + 2];
        const dx = bx - ax, dy = by - ay, dz = bz - az;
        const lengthSq = dx * dx + dy * dy + dz * dz;
        if (lengthSq <= 1e-12) return [];

        const found: { v: number; t: number }[] = [];
        const x0 = Math.floor(Math.min(ax, bx) / cell), x1 = Math.floor(Math.max(ax, bx) / cell);
        const y0 = Math.floor(Math.min(ay, by) / cell), y1 = Math.floor(Math.max(ay, by) / cell);
        const z0 = Math.floor(Math.min(az, bz) / cell), z1 = Math.floor(Math.max(az, bz) / cell);

        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
            const bucket = buckets.get(`${x},${y},${z}`);
            if (!bucket) continue;
            for (const v of bucket) {
                if (v === a || v === b) continue;
                const px = vertices[v * 3] - ax, py = vertices[v * 3 + 1] - ay, pz = vertices[v * 3 + 2] - az;
                const t = (px * dx + py * dy + pz * dz) / lengthSq;
                // Strictly inside: an endpoint is not a T-junction.
                if (t <= 1e-6 || t >= 1 - 1e-6) continue;
                // And actually ON the line, not merely alongside it.
                const cx = px - dx * t, cy = py - dy * t, cz = pz - dz * t;
                if (cx * cx + cy * cy + cz * cz > tolerance * tolerance) continue;
                found.push({ v, t });
            }
        }
        found.sort((p, q) => p.t - q.t);
        return found.map(f => f.v);
    };

    const out: number[] = [];
    for (let t = 0; t < triangles.length; t += 3) {
        const tri = [triangles[t], triangles[t + 1], triangles[t + 2]];
        const loop: number[] = [];
        let split = false;
        for (let e = 0; e < 3; e++) {
            const a = tri[e], b = tri[(e + 1) % 3];
            loop.push(a);
            const inner = between(a, b);
            if (inner.length > 0) split = true;
            for (const v of inner) loop.push(v);
        }
        if (!split) {
            out.push(tri[0], tri[1], tri[2]);
            continue;
        }
        // Fan from the loop's first vertex. Valid because the loop is a triangle plus points that lie
        // on its own edges, so it stays convex.
        for (let i = 1; i + 1 < loop.length; i++) {
            if (loop[0] === loop[i] || loop[i] === loop[i + 1] || loop[0] === loop[i + 1]) continue;
            out.push(loop[0], loop[i], loop[i + 1]);
        }
    }

    triangles.length = 0;
    for (const i of out) triangles.push(i);
}

// ---------------------------------------------------------------------------------------------------
// 4. Simplification
// ---------------------------------------------------------------------------------------------------

/**
 * Drop vertices that sit on the straight line between their neighbours.
 *
 * Yuka's merge never removes them: fusing a 3x1 strip of quads into one rectangle yields an
 * eight-point contour, and every one of those points is stored in the scene file forever.
 *
 * **`pinned` is what stops this undoing the T-junction pass.** A vertex sitting mid-way along a wide
 * region's edge is exactly the vertex that lets a narrower neighbour twin against it, and it is also,
 * geometrically, perfectly collinear — so a naive simplifier deletes it and silently re-creates the
 * disconnection that `splitTJunctions` existed to fix. A vertex may only be dropped when BOTH
 * half-edges meeting at it are twinless, i.e. nothing on the other side depends on it.
 */
export function simplifyContour(
    points: number[], tolerance: number, pinned?: readonly boolean[],
): number[] {
    let count = points.length / 3;
    if (count < 4 || tolerance <= 0) return points;

    let current = points;
    let pins = pinned ? pinned.slice() : null;
    // Repeat to a fixed point: removing one vertex can make its neighbour collinear in turn.
    let changed = true;
    while (changed && count > 3) {
        changed = false;
        const out: number[] = [];
        const outPins: boolean[] = [];
        for (let i = 0; i < count; i++) {
            const p = ((i - 1 + count) % count) * 3;
            const c = i * 3;
            const n = ((i + 1) % count) * 3;

            const ax = current[c] - current[p], az = current[c + 2] - current[p + 2];
            const bx = current[n] - current[c], bz = current[n + 2] - current[c + 2];
            // Twice the area of the triangle p-c-n. Zero means c is on the line p->n.
            const cross = Math.abs(ax * bz - az * bx);
            const span = Math.hypot(current[n] - current[p], current[n + 2] - current[p + 2]);
            const removable = !pins || !pins[i];
            // Perpendicular distance from c to the line, compared against the tolerance.
            if (removable && span > 1e-9 && cross / span < tolerance
                && out.length / 3 + (count - i - 1) >= 3) {
                changed = true;
                continue;
            }
            out.push(current[c], current[c + 1], current[c + 2]);
            if (pins) outPins.push(pins[i]);
        }
        current = out;
        if (pins) pins = outPins;
        count = current.length / 3;
    }
    return current;
}

// ---------------------------------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------------------------------

/**
 * Bake a triangle soup into storable navmesh data.
 *
 * Never throws: an empty or hopeless input is an empty result, because "nothing here is walkable" is
 * a legitimate answer for a scene with no floor yet.
 */
export function bakeNavMesh(soup: TriangleSoup, over?: Partial<NavBakeSettings> | null): NavBakeResult {
    const settings = navBakeSettings(over);
    const welded = filterAndWeld(soup, settings);
    if (welded.triangles.length === 0) {
        return { ...EMPTY_BAKE_RESULT, rejectedTriangles: welded.rejected };
    }
    // Before the merge: two surfaces meeting at a T-junction are not neighbours until their edges
    // agree, and the merge only ever fuses actual neighbours.
    splitTJunctions(welded, settings.weldTolerance);

    // Emit every surviving triangle as its own region and let Yuka fuse them.
    const vertices = new Float32Array(welded.triangles.length * 3);
    const counts = new Uint32Array(welded.triangles.length / 3);
    for (let t = 0; t < welded.triangles.length / 3; t++) {
        counts[t] = 3;
        for (let k = 0; k < 3; k++) {
            const v = welded.triangles[t * 3 + k] * 3;
            const b = (t * 3 + k) * 3;
            vertices[b] = welded.vertices[v];
            vertices[b + 1] = welded.vertices[v + 1];
            vertices[b + 2] = welded.vertices[v + 2];
        }
    }

    const merged = CleoNavMesh.build({ vertices, counts }, { merge: true });
    if (!merged) {
        return { ...EMPTY_BAKE_RESULT, walkableTriangles: welded.walkable, rejectedTriangles: welded.rejected };
    }

    // Harvest the merged contours, re-snapped to the weld grid. Yuka's merge can emit a vertex a
    // float-epsilon off the grid its inputs were on, and the rebuild below twins by exact equality.
    const grid = settings.weldTolerance;
    const merged_contours: number[][] = [];
    for (const region of merged.raw.regions as unknown as Region[]) {
        const contour = contourOf((region as unknown as { getContour(r: Vector3[]): Vector3[] }).getContour([]));
        if (contour.length < 9) continue;
        for (let i = 0; i < contour.length; i++) contour[i] = Math.round(contour[i] / grid) * grid;
        merged_contours.push(contour);
    }
    if (merged_contours.length === 0) {
        return {
            ...EMPTY_BAKE_RESULT,
            walkableTriangles: welded.walkable,
            rejectedTriangles: welded.rejected,
        };
    }

    // Rebuild so simplification sees the FINAL topology. Pinning against the pre-merge mesh would pin
    // the wrong vertices, and dropping a vertex a neighbour twins against silently re-creates the
    // disconnection `splitTJunctions` exists to prevent.
    const final = CleoNavMesh.build(packContours(merged_contours), { merge: false });
    const contours: number[][] = [];
    if (final) {
        for (const region of final.raw.regions as unknown as Region[]) {
            const contour = contourOf((region as unknown as { getContour(r: Vector3[]): Vector3[] }).getContour([]));
            const simplified = simplifyContour(contour, settings.simplifyTolerance, pinnedVertices(region));
            if (simplified.length >= 9) contours.push(simplified);
        }
    } else {
        // The re-snapped soup would not rebuild. Ship it unsimplified rather than losing the bake.
        for (const contour of merged_contours) contours.push(contour);
    }

    return {
        data: packContours(contours),
        walkableTriangles: welded.walkable,
        rejectedTriangles: welded.rejected,
        regions: contours.length,
    };
}

function contourOf(points: Vector3[]): number[] {
    const out: number[] = [];
    for (const p of points) out.push(p.x, p.y, p.z);
    return out;
}

/** Yuka half-edge, as much of it as this module needs. */
type Edge = { vertex: Vector3; next: Edge | null; twin: Edge | null };
type Region = { edge: unknown; centroid: Vector3 };

/** Walk a region's half-edge ring. `getContour` walks the same ring in the same order. */
function forEachEdge(region: Region, visit: (edge: Edge, next: Edge, index: number) => void): void {
    const start = region.edge as Edge | null;
    if (!start) return;
    let edge: Edge | null = start;
    let index = 0;
    do {
        const next: Edge | null = edge!.next;
        if (!next) return;
        visit(edge!, next, index++);
        edge = next;
    } while (edge && edge !== start && index < 4096);
}

/**
 * Which contour vertices must survive simplification.
 *
 * A vertex is pinned when either half-edge meeting at it has a twin — something on the other side is
 * relying on that exact coordinate to twin against.
 *
 * The indexing is the subtle part. `getContour` walks the ring pushing `edge.vertex`, and
 * `edge.vertex` is the half-edge's **head** (Yuka's `tail()` reads `prev.vertex`). So contour vertex
 * i is the head of half-edge i and the tail of half-edge i+1 — not i-1, which pins the wrong end and
 * lets simplification delete exactly the vertices `splitTJunctions` inserted.
 */
function pinnedVertices(region: Region): boolean[] {
    const twinned: boolean[] = [];
    forEachEdge(region, (edge) => { twinned.push(edge.twin !== null); });

    const count = twinned.length;
    const pinned: boolean[] = new Array(count).fill(false);
    for (let i = 0; i < count; i++) {
        pinned[i] = twinned[i] || twinned[(i + 1) % count];
    }
    return pinned;
}

function packContours(contours: readonly number[][]): NavMeshData {
    let total = 0;
    for (const c of contours) total += c.length;
    const vertices = new Float32Array(total);
    const counts = new Uint32Array(contours.length);
    let v = 0;
    for (let i = 0; i < contours.length; i++) {
        counts[i] = contours[i].length / 3;
        for (const n of contours[i]) vertices[v++] = n;
    }
    return { vertices, counts };
}
