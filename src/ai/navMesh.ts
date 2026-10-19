/**
 * The navigation mesh wrapper: everything the engine knows about Yuka's NavMesh, in one place.
 *
 * A LEAF. It holds a Yuka `NavMesh` and plain records — never a `Node`, never a `Scene`. Off-mesh
 * links and patrol routes live here as coordinates, not as node references, which is what keeps this
 * out of the scene-graph module cycle and testable without standing up a world.
 *
 * ## Why the stored form is "region contours" and not "triangles"
 *
 * Building a navmesh is two stages in Yuka: `fromPolygons` links half-edge twins, then merges
 * coplanar neighbours into the largest convex regions it can. The merge is most of the value — a grid
 * of 12,800 triangles collapses to 80 regions — and it is most of the cost.
 *
 * So we pay it ONCE, at bake time, and store the merged contours. A scene load replays those with
 * `mergeConvexRegions = false`. Measured: 0.36 s to bake that mesh from triangles, **1.8 ms** to
 * replay it. The round trip is exact — same region count, same graph, same funnelled path — because a
 * merged region is just a convex polygon like any other.
 *
 * ## The lifecycle order, which is not guessable
 *
 * `epsilonCoplanarTest` and `mergeConvexRegions` must be set BEFORE `fromPolygons`, because the merge
 * pass reads them. `epsilonContainsTest` must be set AFTER, because `fromPolygons` opens with
 * `clear()`. And it defaults to **1 world unit** — a tolerance so wide that a point a metre off the
 * mesh still "contains", which reads as an agent pathing from thin air.
 *
 * ## Two Yuka behaviours that are traps, both verified against the real runtime
 *
 * 1. **`findPath` waypoints alias live region vertices.** Writing to a returned point mutates the
 *    navmesh. Everything leaving this module is cloned.
 * 2. **`clampMovement` does not write its out-param when the move stays inside the mesh.** It writes
 *    only when it actually clamps, so the caller must pre-seed it with the intended destination —
 *    which {@link CleoNavMesh.clampMovement} does. Pass a fresh vector and you get garbage on every
 *    frame the agent is NOT leaving the mesh, i.e. almost all of them.
 *
 * ## And one limitation that is architectural
 *
 * Yuka's navmesh is **2.5D**: `MathUtils.area` is a signed area in the XZ plane, and it drives the
 * convexity test, the containment test and the funnel. Vertically stacked walkable surfaces at the
 * same XZ misbehave, and "up" is hardcoded +Y. See {@link isNavigableUp}.
 */

import { vec3 } from "gl-matrix";
import { base64ToBytes, bytesToBase64 } from "../core/base64";
import { AStar, Corridor, NavMesh, Polygon, Vector3 } from "./yuka";
import { toYuka } from "./interop";
import type { Vec3Like } from "./interop";

/**
 * A baked navmesh, as stored on a NavMeshNode and as handed to a worker.
 *
 * FLAT typed arrays end to end. `number[][]` is not transferable, structured-clones as one JS object
 * per vertex, and `new Float32Array(number[][])` yields NaN rather than throwing — the trap already
 * written down in `foliageRules.bakeModel` and `pack.ts`.
 */
export interface NavMeshData {
    /** Every region's contour, concatenated as xyz triples. */
    vertices: Float32Array;
    /** Vertex count per region. Sums to `vertices.length / 3`. */
    counts: Uint32Array;
}

export const EMPTY_NAV_MESH_DATA: NavMeshData = {
    vertices: new Float32Array(0),
    counts: new Uint32Array(0),
};

/** An off-mesh connection: a jump, a ladder, a teleport. Coordinates, never node ids. */
export interface OffMeshLink {
    name: string;
    from: [number, number, number];
    to: [number, number, number];
    /** Traversal cost in the graph search — roughly "how many world units is using this worth". */
    cost: number;
    bidirectional: boolean;
}

/** A named patrol route. Plain points, so a duplicated navmesh needs no id remapping. */
export interface NavRoute {
    name: string;
    points: [number, number, number][];
    loop: boolean;
}

export interface NavMeshBuildOptions {
    /**
     * Merge coplanar neighbours into larger convex regions. TRUE when baking from raw triangles,
     * FALSE when replaying already-merged contours — see the module header.
     */
    merge?: boolean;
    /** Coplanarity tolerance for the merge pass. Read before the build. */
    epsilonCoplanar?: number;
    /** Containment tolerance. Yuka's default of 1 world unit is far too loose. */
    epsilonContains?: number;
}

const DEFAULT_EPSILON_COPLANAR = 1e-3;
const DEFAULT_EPSILON_CONTAINS = 1e-3;

/**
 * How far a query point may sit ABOVE / BELOW a region's surface and still be "on" it.
 *
 * Yuka's own test asks for the point to be within `epsilonContainsTest` of the region's PLANE -- 1 mm.
 * An agent's feet are never that close to a decimated terrain or a capsule resting on a box, so every
 * real query missed, fell back to the region with the nearest 3D CENTROID, and planned from a guess: a
 * wall top four metres up, or a triangle three cells over. Agents doubled back and zig-zagged.
 * Containment is decided in XZ (that is all Yuka's 2.5D mesh means anyway) inside this band.
 */
const REACH_ABOVE = 2.5;
const REACH_BELOW = 1.0;

interface Located { region: Polygon; x: number; y: number; z: number; }

type Edge = { vertex: Vector3; prev: Edge; next: Edge; twin: Edge | null; polygon: Polygon };
const edgeOf = (region: Polygon) => (region as unknown as { edge: Edge }).edge;

/** Signed XZ area, Yuka's convention: >= 0 means `c` is on the inner side of edge a -> b. */
function areaXZ(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
    return (cx - ax) * (bz - az) - (bx - ax) * (cz - az);
}

function insideXZ(region: Polygon, x: number, z: number, eps = 1e-6): boolean {
    const first = edgeOf(region);
    let edge = first;
    do {
        const a = edge.prev.vertex, b = edge.vertex;
        if (areaXZ(a.x, a.z, b.x, b.z, x, z) < -eps) return false;
        edge = edge.next;
    } while (edge !== first);
    return true;
}

/** The closest point of a region to (x, z), in XZ: the point itself when inside, else on its border. */
function closestOnRegionXZ(region: Polygon, x: number, z: number): [number, number] | null {
    if (insideXZ(region, x, z)) return [x, z];
    let best: [number, number] | null = null, bestD = Infinity;
    const first = edgeOf(region);
    let edge = first;
    do {
        const a = edge.prev.vertex, b = edge.vertex;
        const ex = b.x - a.x, ez = b.z - a.z;
        const len2 = ex * ex + ez * ez;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / len2)) : 0;
        const px = a.x + ex * t, pz = a.z + ez * t;
        const d = (px - x) ** 2 + (pz - z) ** 2;
        if (d < bestD) { bestD = d; best = [px, pz]; }
        edge = edge.next;
    } while (edge !== first);
    return best;
}

/**
 * A region's plane as [nx, ny, nz, d], by Newell's method over the whole contour.
 *
 * Not Yuka's `region.plane`: that comes from the FIRST THREE contour points, and a stored merged contour
 * keeps collinear vertices (a 3x1 strip comes back with eight points), so a replayed region whose first
 * three points line up has a zero normal and no height anywhere.
 */
function planeOf(region: Polygon): [number, number, number, number] {
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, n = 0;
    const first = edgeOf(region);
    let edge = first;
    do {
        const a = edge.prev.vertex, b = edge.vertex;
        nx += (a.y - b.y) * (a.z + b.z);
        ny += (a.z - b.z) * (a.x + b.x);
        nz += (a.x - b.x) * (a.y + b.y);
        cx += b.x; cy += b.y; cz += b.z; n++;
        edge = edge.next;
    } while (edge !== first);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    return [nx, ny, nz, -(nx * cx + ny * cy + nz * cz) / n];
}

/** A surface's height at (x, z), or NaN for a (near-)vertical one. */
function heightOn(plane: readonly number[], x: number, z: number): number {
    if (Math.abs(plane[1]) < 1e-4) return NaN;
    return -(plane[0] * x + plane[2] * z + plane[3]) / plane[1];
}

/**
 * Whether a world "up" is one Yuka's navmesh can actually represent.
 *
 * The rest of the engine is gravity-relative on purpose; navigation is the one place that cannot
 * follow, because the XZ-plane assumption is baked into Yuka's own math. Rather than produce a
 * silently wrong mesh under sideways gravity, callers refuse and say why.
 *
 * Checked at BOTH bake and load: a project can be authored at +Y, baked, and then have its gravity
 * changed — and at that point there is no bake left to refuse.
 *
 * A missing `up` passes. `Scene.physics` is genuinely undefined on any scene never handed to
 * `setScene` (every template and preview-tab scene), and "no physics yet" is not a disagreement.
 */
export function isNavigableUp(up: Vec3Like | null | undefined): boolean {
    if (!up) return true;
    const length = Math.hypot(up[0], up[1], up[2]);
    if (length <= 1e-6) return true; // Zero gravity disagrees with nothing.
    // Within ~5 degrees of +Y — a tolerance, not equality, because gravity is an authored float triple
    // and (0, -9.81, 0) does not normalize to exactly (0, 1, 0).
    return up[1] / length > 0.996;
}

/**
 * A built navmesh, ready to answer path queries.
 *
 * Construct through {@link buildNavMesh}. A null result means the data was empty or degenerate, which
 * is a normal state — an unbaked NavMeshNode — rather than an error.
 */
export class CleoNavMesh {
    private readonly _mesh: NavMesh;
    private readonly _links: OffMeshLink[] = [];

    // Per instance, not module-level: two navmeshes answering queries in one frame must not alias.
    private readonly _from = new Vector3();
    private readonly _to = new Vector3();
    private readonly _clamped = new Vector3();

    // An XZ grid over region bounds. Yuka scans EVERY region for both containment and its closest-region
    // fallback (~13 ms per query on a 40k-triangle terrain bake), and finds a node index by indexOf.
    private readonly _nodeIndex = new Map<Polygon, number>();
    private readonly _planes = new Map<Polygon, [number, number, number, number]>();
    private _cells: number[][] = [];
    private _minX = 0;
    private _minZ = 0;
    private _cellSize = 1;
    private _cols = 1;
    private _rows = 1;

    private constructor(mesh: NavMesh) {
        this._mesh = mesh;
        this._buildIndex();
    }

    private _buildIndex(): void {
        const regions = this._mesh.regions;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, area = 0;
        const bounds: number[] = [];
        for (let i = 0; i < regions.length; i++) {
            this._nodeIndex.set(regions[i], i);
            this._planes.set(regions[i], planeOf(regions[i]));
            let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
            const first = edgeOf(regions[i]);
            let edge = first;
            do {
                const v = edge.vertex;
                if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x;
                if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z;
                edge = edge.next;
            } while (edge !== first);
            bounds.push(x0, z0, x1, z1);
            area += (x1 - x0) * (z1 - z0);
            if (x0 < minX) minX = x0; if (z0 < minZ) minZ = z0;
            if (x1 > maxX) maxX = x1; if (z1 > maxZ) maxZ = z1;
        }
        if (regions.length === 0) return;
        // About two regions' worth of footprint per cell, capped so a huge sparse mesh stays small.
        const typical = Math.sqrt(Math.max(area / regions.length, 1e-6));
        let size = Math.max(typical * 1.5, 0.5);
        const span = Math.max(maxX - minX, maxZ - minZ, 1e-3);
        if (span / size > 512) size = span / 512;
        this._minX = minX; this._minZ = minZ; this._cellSize = size;
        this._cols = Math.max(1, Math.ceil((maxX - minX) / size) + 1);
        this._rows = Math.max(1, Math.ceil((maxZ - minZ) / size) + 1);
        this._cells = Array.from({ length: this._cols * this._rows }, () => []);
        for (let i = 0; i < regions.length; i++) {
            const c0 = this._col(bounds[i * 4]), c1 = this._col(bounds[i * 4 + 2]);
            const r0 = this._row(bounds[i * 4 + 1]), r1 = this._row(bounds[i * 4 + 3]);
            for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this._cells[r * this._cols + c].push(i);
        }
    }

    private _col(x: number): number {
        return Math.min(this._cols - 1, Math.max(0, Math.floor((x - this._minX) / this._cellSize)));
    }
    private _row(z: number): number {
        return Math.min(this._rows - 1, Math.max(0, Math.floor((z - this._minZ) / this._cellSize)));
    }

    /**
     * The region under (or just above) a point, and the point dropped onto its surface.
     *
     * XZ containment within the {@link REACH_ABOVE}/{@link REACH_BELOW} band, preferring the surface the
     * point stands on over one overhead. Off the mesh, the nearest region in XZ (searched outward ring by
     * ring through the grid, never by 3D centroid) and the closest point on its border -- unless `strict`.
     */
    public locate(point: Vec3Like, strict = false): Located | null {
        const regions = this._mesh.regions;
        if (regions.length === 0) return null;
        const [x, y, z] = [point[0], point[1], point[2]];

        let best: Polygon | null = null, bestScore = Infinity, bestY = 0;
        for (const i of this._cells[this._row(z) * this._cols + this._col(x)] ?? []) {
            const region = regions[i];
            if (!insideXZ(region, x, z)) continue;
            const sy = heightOn(this._planes.get(region)!, x, z);
            if (!Number.isFinite(sy)) continue;
            const dy = y - sy;
            if (dy > REACH_ABOVE || dy < -REACH_BELOW) continue;
            // Standing on it beats hanging under it: a bridge deck 0.5 m below the feet wins over the
            // river bed, and a ceiling-level region is chosen only when nothing is underfoot.
            const score = dy >= -0.3 ? dy : 10 - dy;
            if (score < bestScore) { bestScore = score; best = region; bestY = sy; }
        }
        if (best) return { region: best, x, y: bestY, z };
        if (strict) return null;
        return this._nearest(x, y, z);
    }

    private _nearest(x: number, y: number, z: number): Located | null {
        const regions = this._mesh.regions;
        const c = this._col(x), r = this._row(z);
        const seen = new Set<number>();
        let best: Located | null = null, bestD = Infinity;
        const maxRing = Math.max(this._cols, this._rows);
        for (let ring = 0; ring <= maxRing; ring++) {
            // Once something is found, one more ring is enough: nothing beyond it can be nearer.
            if (best && (ring - 1) * this._cellSize > Math.sqrt(bestD)) break;
            for (let rr = r - ring; rr <= r + ring; rr++) {
                if (rr < 0 || rr >= this._rows) continue;
                for (let cc = c - ring; cc <= c + ring; cc++) {
                    if (cc < 0 || cc >= this._cols) continue;
                    if (Math.max(Math.abs(rr - r), Math.abs(cc - c)) !== ring) continue;
                    for (const i of this._cells[rr * this._cols + cc]) {
                        if (seen.has(i)) continue;
                        seen.add(i);
                        const hit = closestOnRegionXZ(regions[i], x, z);
                        if (!hit) continue;
                        const sy = heightOn(this._planes.get(regions[i])!, hit[0], hit[1]);
                        if (!Number.isFinite(sy)) continue;
                        // Planar distance first; height only breaks ties between stacked surfaces.
                        const d = (hit[0] - x) ** 2 + (hit[1] - z) ** 2 + 0.01 * (sy - y) ** 2;
                        if (d < bestD) { bestD = d; best = { region: regions[i], x: hit[0], y: sy, z: hit[1] }; }
                    }
                }
            }
        }
        return best;
    }

    /**
     * Whether the straight XZ segment a -> b stays on the mesh, walking region to region across shared
     * edges from `start` (which must contain a). A border edge with no twin blocks it.
     */
    private _walkable(start: Polygon, ax: number, az: number, bx: number, bz: number): boolean {
        let region = start;
        let entered: Edge | null = null;
        for (let guard = 0; guard < 4096; guard++) {
            if (insideXZ(region, bx, bz, 1e-5)) return true;
            let exit: Edge | null = null, exitT = -Infinity;
            const first = edgeOf(region);
            let edge = first;
            do {
                if (edge !== entered) {
                    const p = edge.prev.vertex, q = edge.vertex;
                    // Only an edge the destination lies beyond can be the one the segment leaves by.
                    if (areaXZ(p.x, p.z, q.x, q.z, bx, bz) < 0) {
                        const ex = q.x - p.x, ez = q.z - p.z, dx = bx - ax, dz = bz - az;
                        const den = dx * ez - dz * ex;
                        if (Math.abs(den) > 1e-12) {
                            const t = ((p.x - ax) * ez - (p.z - az) * ex) / den;
                            const u = ((p.x - ax) * dz - (p.z - az) * dx) / den;
                            if (u >= -1e-6 && u <= 1 + 1e-6 && t > exitT) { exitT = t; exit = edge; }
                        }
                    }
                }
                edge = edge.next;
            } while (edge !== first);
            if (!exit || !exit.twin) return false;
            entered = exit.twin;
            region = exit.twin.polygon;
        }
        return false;
    }

    /**
     * Drop every waypoint the agent could skip by walking straight on the mesh.
     *
     * A* runs over region CENTROIDS, so on a triangulated terrain it picks one of many equal-cost
     * staircase corridors, and the funnel can only straighten a path WITHIN its corridor: measured
     * 2.2 m median and 20 m worst off the straight line across fully open ground. Greedy line of sight
     * over the mesh itself removes those bends and keeps every corner a real obstacle forced.
     */
    private _stringPull(points: Located[]): Located[] {
        if (points.length <= 2) return points;
        const out: Located[] = [points[0]];
        let i = 0;
        while (i < points.length - 1) {
            let j = points.length - 1;
            for (; j > i + 1; j--) {
                const a = points[i], b = points[j];
                // Corners sit exactly on shared vertices, so nudge a hair toward b to pick the region
                // the segment actually starts in.
                const len = Math.hypot(b.x - a.x, b.z - a.z);
                if (len < 1e-6) break;
                const nx = a.x + (b.x - a.x) / len * 1e-3, nz = a.z + (b.z - a.z) / len * 1e-3;
                const start = this.locate([nx, a.y, nz], true);
                if (start && this._walkable(start.region, nx, nz, b.x, b.z)) break;
            }
            out.push(points[j]);
            i = j;
        }
        return out;
    }

    /** The underlying Yuka mesh — for the overlay builder and the off-mesh link search. */
    public get raw(): NavMesh { return this._mesh; }

    public get regionCount(): number { return this._mesh.regions.length; }
    public get nodeCount(): number { return this._mesh.graph.getNodeCount(); }
    public get edgeCount(): number { return this._mesh.graph.getEdgeCount(); }
    public get links(): readonly OffMeshLink[] { return this._links; }

    public setLinks(links: readonly OffMeshLink[]): void {
        this._links.length = 0;
        for (const link of links) this._links.push(link);
    }

    /**
     * The shortest path from `from` to `to` as world points, or an empty array when the two are not
     * connected.
     *
     * Waypoints are CLONED — Yuka returns references into `mesh.regions`, so a caller that smoothed or
     * offset a returned point would silently deform the navmesh for every query after it.
     */
    public findPath(from: Vec3Like, to: Vec3Like, out: vec3[] = []): vec3[] {
        out.length = 0;
        if (this._mesh.regions.length === 0) return out;

        // Our own start/goal resolution instead of Yuka's (see REACH_ABOVE), then Yuka's search and
        // funnel over those regions, then line-of-sight smoothing over the mesh.
        const start = this.locate(from);
        const goal = this.locate(to);
        if (!start || !goal) return out;

        let points: Located[];
        if (start.region === goal.region) {
            points = [start, goal];
        } else {
            const source = this._nodeIndex.get(start.region);
            const target = this._nodeIndex.get(goal.region);
            if (source === undefined || target === undefined) return out;
            try {
                const astar = new AStar(this._mesh.graph, source, target);
                astar.search();
                if (!astar.found) return out;
                const regionPath = astar.getPath() as number[];
                const corridor = new Corridor();
                const a = toYuka(this._from, [start.x, start.y, start.z]);
                const b = toYuka(this._to, [goal.x, goal.y, goal.z]);
                corridor.push(a, a);
                const portal: { left: Vector3 | null; right: Vector3 | null } = { left: null, right: null };
                const mesh = this._mesh as unknown as {
                    _getPortalEdge(r1: Polygon, r2: Polygon, out: typeof portal): typeof portal;
                };
                for (let i = 0; i < regionPath.length - 1; i++) {
                    mesh._getPortalEdge(this._mesh.regions[regionPath[i]], this._mesh.regions[regionPath[i + 1]], portal);
                    if (!portal.left || !portal.right) return out;
                    corridor.push(portal.left, portal.right);
                }
                corridor.push(b, b);
                const funnel = corridor.generate() as Vector3[];
                points = funnel.map((p, i) => i === 0 ? start
                    : i === funnel.length - 1 ? goal
                    : { region: start.region, x: p.x, y: p.y, z: p.z });
            } catch {
                // A degenerate region (a bake that produced a zero-area polygon) can throw inside the
                // funnel. An unreachable destination is a normal answer; a crashed frame is not.
                return out;
            }
            points = this._stringPull(points);
        }
        for (const p of points) out.push(vec3.fromValues(p.x, p.y, p.z));
        return out;
    }

    /**
     * Slide a proposed move along the navmesh border instead of letting it leave.
     *
     * Returns true when the move was clamped against a real region. `out` is always written.
     */
    public clampMovement(from: Vec3Like, to: Vec3Like, out: vec3): boolean {
        vec3.set(out, to[0], to[1], to[2]);
        if (this._mesh.regions.length === 0) return false;

        const start = toYuka(this._from, from);
        const end = toYuka(this._to, to);
        const region = this.locate(from, true)?.region;
        if (!region) return false;

        // Seed with the intended destination: Yuka writes this only when it actually clamps.
        this._clamped.copy(end);
        try {
            this._mesh.clampMovement(region, start, end, this._clamped);
        } catch {
            return false;
        }
        vec3.set(out, this._clamped.x, this._clamped.y, this._clamped.z);
        return true;
    }

    /**
     * Whether a point is on the walkable surface: inside a region in XZ and standing on it, within the
     * agent-sized vertical band (an agent's feet are never within a millimetre of the plane).
     */
    public contains(point: Vec3Like): boolean {
        return this.locate(point, true) !== null;
    }

    /** The centroid of a region chosen at random — a wander goal with nowhere particular to go. */
    public randomPoint(out: vec3): boolean {
        if (this._mesh.regions.length === 0) return false;
        const region = this._mesh.getRandomRegion();
        if (!region) return false;
        vec3.set(out, region.centroid.x, region.centroid.y, region.centroid.z);
        return true;
    }

    /**
     * Harvest the merged region contours — what gets stored so a scene load can skip the merge.
     *
     * Yuka's merge keeps collinear vertices (a 3x1 strip merging to one rectangle comes back with
     * eight points, not four), so a bake runs `simplifyContour` over this before persisting it.
     */
    public toData(): NavMeshData {
        const contours: Vector3[][] = [];
        let total = 0;
        for (const region of this._mesh.regions) {
            const points = region.getContour([]);
            if (points.length < 3) continue;
            contours.push(points);
            total += points.length;
        }
        const vertices = new Float32Array(total * 3);
        const counts = new Uint32Array(contours.length);
        let v = 0;
        for (let i = 0; i < contours.length; i++) {
            counts[i] = contours[i].length;
            for (const p of contours[i]) {
                vertices[v++] = p.x;
                vertices[v++] = p.y;
                vertices[v++] = p.z;
            }
        }
        return { vertices, counts };
    }

    public static build(data: NavMeshData, options: NavMeshBuildOptions = {}): CleoNavMesh | null {
        const polygons = polygonsFromData(data);
        if (polygons.length === 0) return null;

        const mesh = new NavMesh();
        // BEFORE the build: the merge pass reads both of these.
        mesh.epsilonCoplanarTest = options.epsilonCoplanar ?? DEFAULT_EPSILON_COPLANAR;
        mesh.mergeConvexRegions = options.merge ?? false;
        try {
            fromPolygonsFast(mesh, polygons);
        } catch {
            return null;
        }
        // AFTER: fromPolygons opens with clear(), which would undo this.
        mesh.epsilonContainsTest = options.epsilonContains ?? DEFAULT_EPSILON_CONTAINS;
        if (mesh.regions.length === 0) return null;
        return new CleoNavMesh(mesh);
    }
}

/**
 * Yuka's `fromPolygons`, minus its two quadratic loops.
 *
 * It finds each half-edge's twin by comparing it against EVERY later edge, and `_buildGraph` finds each
 * region's node index with `regions.indexOf`. Both are O(n^2): a 300 x 260 m landscape bake at 2 m
 * (~39k triangles) took 2.6 s to load, on the frame the first enemy started chasing. Same result here
 * -- exact-coordinate twins, the same longest-first merge order, the same graph -- in linear time.
 */
function fromPolygonsFast(mesh: NavMesh, polygons: Polygon[]): void {
    mesh.clear();
    type LinkEdge = Edge & { linkOpponent(e: LinkEdge): void; squaredLength(): number };
    const key = (a: Vector3, b: Vector3) => `${a.x},${a.y},${a.z}|${b.x},${b.y},${b.z}`;
    const open = new Map<string, LinkEdge>();
    const sorted: { cost: number; edge: LinkEdge }[] = [];
    for (const polygon of polygons) {
        mesh.regions.push(polygon);
        const first = edgeOf(polygon) as LinkEdge;
        let edge = first;
        do {
            const tail = edge.prev.vertex, head = edge.vertex;
            // My twin runs head -> tail. Taken at most once, as Yuka's first-match `break` does.
            const twinKey = key(head, tail);
            const twin = open.get(twinKey);
            if (twin && twin.twin === null && edge.twin === null) {
                open.delete(twinKey);
                twin.linkOpponent(edge);
                sorted.push({ cost: twin.squaredLength(), edge: twin });
            } else {
                const own = key(tail, head);
                if (!open.has(own)) open.set(own, edge);
            }
            edge = edge.next as LinkEdge;
        } while (edge !== first);
    }
    sorted.sort((a, b) => b.cost - a.cost);
    const internal = mesh as unknown as {
        _buildRegions(list: typeof sorted): void;
        _buildGraph(): void;
        getNodeIndex(region: Polygon): number;
    };
    internal._buildRegions(sorted);
    // _buildGraph asks for node indices by indexOf; answer from a map for the duration of the build.
    const index = new Map<Polygon, number>();
    mesh.regions.forEach((r, i) => index.set(r, i));
    internal.getNodeIndex = (region: Polygon) => index.get(region) ?? -1;
    try {
        internal._buildGraph();
    } finally {
        delete (internal as { getNodeIndex?: unknown }).getNodeIndex;
    }
}

/**
 * Rebuild the Yuka polygons a {@link NavMeshData} describes.
 *
 * Drops a bad region rather than throwing: a truncated or hand-edited blob should cost that region,
 * not the whole scene.
 */
export function polygonsFromData(data: NavMeshData): Polygon[] {
    const polygons: Polygon[] = [];
    const { vertices, counts } = data;
    let offset = 0;
    for (let i = 0; i < counts.length; i++) {
        const count = counts[i];
        // A count running off the end means the blob and its index disagree. Stop, rather than read
        // zeros — that would be a degenerate polygon that throws inside the funnel much later.
        if (count < 3 || (offset + count) * 3 > vertices.length) break;
        const points: Vector3[] = [];
        for (let j = 0; j < count; j++) {
            const b = (offset + j) * 3;
            points.push(new Vector3(vertices[b], vertices[b + 1], vertices[b + 2]));
        }
        offset += count;
        try {
            polygons.push(new Polygon().fromContour(points));
        } catch {
            // One self-intersecting contour is a bad region, not a bad scene.
        }
    }
    return polygons;
}

/** Build a navmesh from stored data. Null when there is nothing walkable in it. */
export function buildNavMesh(data: NavMeshData, options?: NavMeshBuildOptions): CleoNavMesh | null {
    return CleoNavMesh.build(data, options);
}

// ---------------------------------------------------------------------------------------------------
// Serialization
//
// Base64, not raw typed arrays. `JSON.stringify` renders a Float32Array as `{"0": ..., "1": ...}` --
// the exact bug PLAYER_CONTRACT 6 was cut for -- and while pack.ts's plainifyBuffers would catch it
// and emit plain number arrays, those cost roughly three times what base64 does.
// ---------------------------------------------------------------------------------------------------

export interface NavMeshJson {
    vertices: string;
    counts: string;
}

/** Null for an empty mesh, so an unbaked node serializes no field at all. */
export function serializeNavMeshData(data: NavMeshData): NavMeshJson | null {
    if (data.counts.length === 0 || data.vertices.length === 0) return null;
    const v = data.vertices;
    const c = data.counts;
    return {
        vertices: bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)),
        counts: bytesToBase64(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)),
    };
}

/** Tolerant: anything unreadable yields an empty mesh rather than throwing. */
export function parseNavMeshData(raw: unknown): NavMeshData {
    if (!raw || typeof raw !== 'object') return EMPTY_NAV_MESH_DATA;
    const json = raw as Partial<NavMeshJson>;
    if (typeof json.vertices !== 'string' || typeof json.counts !== 'string') return EMPTY_NAV_MESH_DATA;
    try {
        const vertexBytes = base64ToBytes(json.vertices);
        const countBytes = base64ToBytes(json.counts);
        // A byte length that is not a whole number of elements means a truncated blob. Refuse, rather
        // than construct a typed array over a partial element.
        if (vertexBytes.byteLength % 4 !== 0 || countBytes.byteLength % 4 !== 0) return EMPTY_NAV_MESH_DATA;
        // `slice` rather than a view: base64ToBytes may hand back a buffer whose byteOffset is not a
        // multiple of 4, and a Float32Array view over that throws.
        return {
            vertices: new Float32Array(vertexBytes.slice().buffer),
            counts: new Uint32Array(countBytes.slice().buffer),
        };
    } catch {
        return EMPTY_NAV_MESH_DATA;
    }
}
