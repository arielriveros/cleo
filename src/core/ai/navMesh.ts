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
import { base64ToBytes, bytesToBase64 } from "../base64";
import { NavMesh, Polygon, Vector3 } from "./yuka";
import { scratchVec3, toYuka } from "./interop";
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

    private constructor(mesh: NavMesh) {
        this._mesh = mesh;
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

        let points: Vector3[];
        try {
            points = this._mesh.findPath(toYuka(this._from, from), toYuka(this._to, to));
        } catch {
            // A degenerate region (a bake that produced a zero-area polygon) can throw inside the
            // funnel. An unreachable destination is a normal answer; a crashed frame is not.
            return out;
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
        const region = this._mesh.getRegionForPoint(start, DEFAULT_EPSILON_CONTAINS);
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

    /** Whether a point is on the walkable surface. */
    public contains(point: Vec3Like): boolean {
        if (this._mesh.regions.length === 0) return false;
        return this._mesh.getRegionForPoint(scratchVec3(point), DEFAULT_EPSILON_CONTAINS) !== null;
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
            mesh.fromPolygons(polygons);
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
