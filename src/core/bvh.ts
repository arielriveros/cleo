import { vec3 } from "gl-matrix";

/**
 * Bounding Volume Hierarchy for exact ray/triangle picking against a mesh. The tree is built in the
 * mesh's local (object) space and shared across every instance of that geometry, so a query must
 * transform the ray into object space (inverse world transform) before calling {@link BVH.raycast}.
 */

export interface BVHHit {
    /** Ray parameter of the hit (distance along the ray direction, in the ray's own units). */
    t: number;
    /** Intersection point, in the same space as the queried ray. */
    point: vec3;
    /** Index of the hit triangle in the source geometry. */
    triangle: number;
}

interface BVHNode {
    min: [number, number, number];
    max: [number, number, number];
    left: number;   // child node index, or -1 for a leaf
    right: number;  // child node index (unused for a leaf)
    start: number;  // leaf: first triangle in the ordered index list
    count: number;  // leaf: triangle count
}

/**
 * A built BVH flattened into transferable buffers, so it can be constructed in a worker and adopted on
 * the main thread. `nodes` packs 10 floats per node —
 * [minX,minY,minZ, maxX,maxY,maxZ, left, right, start, count] — as one Float32Array, to transfer in one go.
 */
export interface SerializedBVH {
    positions: Float32Array;
    indices: Uint32Array;
    order: Uint32Array;
    nodes: Float32Array;   // 10 floats per node
    nodeCount: number;
}

const NODE_STRIDE = 10;

// Möller–Trumbore scratch (reused; the routine is never re-entrant with itself).
const _e1 = vec3.create();
const _e2 = vec3.create();
const _pv = vec3.create();
const _tv = vec3.create();
const _qv = vec3.create();

/**
 * Möller–Trumbore ray/triangle intersection.
 * Returns the ray parameter `t` (> 0) of the front/back intersection, or `null` if the ray misses.
 */
export function rayTriangleIntersection(
    origin: vec3, direction: vec3,
    v0: vec3, v1: vec3, v2: vec3
): number | null {
    const EPS = 1e-7;
    vec3.subtract(_e1, v1, v0);
    vec3.subtract(_e2, v2, v0);
    vec3.cross(_pv, direction, _e2);
    const det = vec3.dot(_e1, _pv);
    if (det > -EPS && det < EPS) return null; // ray parallel to triangle
    const invDet = 1.0 / det;

    vec3.subtract(_tv, origin, v0);
    const u = invDet * vec3.dot(_tv, _pv);
    if (u < 0 || u > 1) return null;

    vec3.cross(_qv, _tv, _e1);
    const v = invDet * vec3.dot(direction, _qv);
    if (v < 0 || u + v > 1) return null;

    const t = invDet * vec3.dot(_e2, _qv);
    return t > EPS ? t : null;
}

const LEAF_SIZE = 4;

// Triangle-vertex scratch reused during traversal.
const _v0 = vec3.create();
const _v1 = vec3.create();
const _v2 = vec3.create();

export class BVH {
    private _positions: Float32Array;   // xyz per vertex
    private _indices: Uint32Array;      // 3 vertex indices per triangle
    private _order: Uint32Array;        // triangle permutation grouped by node
    private _centroids: Float32Array;   // xyz per triangle
    private _nodes: BVHNode[] = [];
    private _triCount: number;

    private constructor(positions: Float32Array, indices: Uint32Array) {
        this._positions = positions;
        this._indices = indices;
        this._triCount = Math.floor(indices.length / 3);
        this._order = new Uint32Array(this._triCount);
        this._centroids = new Float32Array(this._triCount * 3);
        if (this._triCount > 0) this._build();
    }

    /**
     * Builds a BVH from a geometry's flat local-space buffers: `positions` as xyz triples, `indices`
     * as a flat triangle index list. Empty `indices` means the positions are a non-indexed soup.
     */
    public static fromBuffers(positions: Float32Array, indices: Uint32Array): BVH {
        return new BVH(positions, indices);
    }

    /** Flatten this tree into transferable buffers. Pair with {@link BVH.fromSerialized}. */
    public serialize(): SerializedBVH {
        const nodes = new Float32Array(this._nodes.length * NODE_STRIDE);
        for (let i = 0; i < this._nodes.length; i++) {
            const n = this._nodes[i];
            const o = i * NODE_STRIDE;
            nodes[o] = n.min[0]; nodes[o + 1] = n.min[1]; nodes[o + 2] = n.min[2];
            nodes[o + 3] = n.max[0]; nodes[o + 4] = n.max[1]; nodes[o + 5] = n.max[2];
            nodes[o + 6] = n.left; nodes[o + 7] = n.right; nodes[o + 8] = n.start; nodes[o + 9] = n.count;
        }
        return {
            positions: this._positions,
            indices: this._indices,
            order: this._order,
            nodes,
            nodeCount: this._nodes.length,
        };
    }

    /** Rebuild a BVH from {@link BVH.serialize} output. Adopts the buffers as-is — no tree build. */
    public static fromSerialized(data: SerializedBVH): BVH {
        const bvh = Object.create(BVH.prototype) as BVH;
        bvh._positions = data.positions;
        bvh._indices = data.indices;
        bvh._order = data.order;
        bvh._triCount = Math.floor(data.indices.length / 3);
        bvh._centroids = new Float32Array(0); // only needed while building
        bvh._nodes = [];
        for (let i = 0; i < data.nodeCount; i++) {
            const o = i * NODE_STRIDE;
            bvh._nodes.push({
                min: [data.nodes[o], data.nodes[o + 1], data.nodes[o + 2]],
                max: [data.nodes[o + 3], data.nodes[o + 4], data.nodes[o + 5]],
                left: data.nodes[o + 6], right: data.nodes[o + 7],
                start: data.nodes[o + 8], count: data.nodes[o + 9],
            });
        }
        return bvh;
    }

    public get triangleCount(): number { return this._triCount; }

    /**
     * Object-space AABB of the whole geometry — the root node's bounds, cached from the build, so no
     * vertex rescan. Empty geometry → a zero box at the origin.
     */
    public get bounds(): { min: [number, number, number]; max: [number, number, number] } {
        if (this._nodes.length === 0)
            return { min: [0, 0, 0], max: [0, 0, 0] };
        const n = this._nodes[0];
        return { min: [n.min[0], n.min[1], n.min[2]], max: [n.max[0], n.max[1], n.max[2]] };
    }

    private _build(): void {
        for (let t = 0; t < this._triCount; t++) {
            this._order[t] = t;
            const i0 = this._indices[t * 3] * 3;
            const i1 = this._indices[t * 3 + 1] * 3;
            const i2 = this._indices[t * 3 + 2] * 3;
            const p = this._positions;
            this._centroids[t * 3] = (p[i0] + p[i1] + p[i2]) / 3;
            this._centroids[t * 3 + 1] = (p[i0 + 1] + p[i1 + 1] + p[i2 + 1]) / 3;
            this._centroids[t * 3 + 2] = (p[i0 + 2] + p[i1 + 2] + p[i2 + 2]) / 3;
        }
        this._buildNode(0, this._triCount);
    }

    // Builds the node covering triangles [start, start + count) and returns its index.
    private _buildNode(start: number, count: number): number {
        const node: BVHNode = {
            min: [Infinity, Infinity, Infinity],
            max: [-Infinity, -Infinity, -Infinity],
            left: -1, right: -1, start, count
        };
        const idx = this._nodes.length;
        this._nodes.push(node);

        // Triangle bounds → node AABB, and centroid bounds → split axis.
        const cMin: [number, number, number] = [Infinity, Infinity, Infinity];
        const cMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let i = start; i < start + count; i++) {
            const t = this._order[i];
            this._expandToTriangle(node.min, node.max, t);
            for (let a = 0; a < 3; a++) {
                const c = this._centroids[t * 3 + a];
                if (c < cMin[a]) cMin[a] = c;
                if (c > cMax[a]) cMax[a] = c;
            }
        }

        if (count <= LEAF_SIZE) return idx; // leaf

        // Split along the widest centroid extent; degenerate spread → leaf.
        let axis = 0;
        let extent = cMax[0] - cMin[0];
        if (cMax[1] - cMin[1] > extent) { axis = 1; extent = cMax[1] - cMin[1]; }
        if (cMax[2] - cMin[2] > extent) { axis = 2; extent = cMax[2] - cMin[2]; }
        if (extent < 1e-8) return idx;

        // Median split: sort this range by centroid on the chosen axis, split in half.
        const slice = Array.from(this._order.subarray(start, start + count));
        slice.sort((a, b) => this._centroids[a * 3 + axis] - this._centroids[b * 3 + axis]);
        this._order.set(slice, start);

        const mid = start + (count >> 1);
        node.left = this._buildNode(start, mid - start);
        node.right = this._buildNode(mid, start + count - mid);
        return idx;
    }

    private _expandToTriangle(min: number[], max: number[], tri: number): void {
        const p = this._positions;
        for (let k = 0; k < 3; k++) {
            const base = this._indices[tri * 3 + k] * 3;
            for (let a = 0; a < 3; a++) {
                const val = p[base + a];
                if (val < min[a]) min[a] = val;
                if (val > max[a]) max[a] = val;
            }
        }
    }

    /**
     * Casts a ray (in this BVH's local space) and returns the nearest triangle hit, or `null`.
     * `direction` need not be normalized; `t` is returned in units of `direction`'s length.
     */
    public raycast(origin: vec3, direction: vec3): BVHHit | null {
        if (this._nodes.length === 0) return null;

        let closest = Infinity;
        let hitTri = -1;
        const stack: number[] = [0];

        while (stack.length > 0) {
            const node = this._nodes[stack.pop()!];
            if (this._rayBox(origin, direction, node.min, node.max) >= closest) continue;

            if (node.left === -1) {
                for (let i = 0; i < node.count; i++) {
                    const tri = this._order[node.start + i];
                    this._triangleVerts(tri);
                    const t = rayTriangleIntersection(origin, direction, _v0, _v1, _v2);
                    if (t !== null && t < closest) { closest = t; hitTri = tri; }
                }
            } else {
                stack.push(node.left, node.right);
            }
        }

        if (hitTri === -1) return null;
        const point = vec3.scaleAndAdd(vec3.create(), origin, direction, closest);
        return { t: closest, point, triangle: hitTri };
    }

    private _triangleVerts(tri: number): void {
        const p = this._positions;
        const i0 = this._indices[tri * 3] * 3;
        const i1 = this._indices[tri * 3 + 1] * 3;
        const i2 = this._indices[tri * 3 + 2] * 3;
        vec3.set(_v0, p[i0], p[i0 + 1], p[i0 + 2]);
        vec3.set(_v1, p[i1], p[i1 + 1], p[i1 + 2]);
        vec3.set(_v2, p[i2], p[i2 + 1], p[i2 + 2]);
    }

    // Ray/AABB slab test. Returns the entry distance (>= 0 when the origin is outside, 0 when
    // inside), or +Infinity when the ray misses — so callers can prune with `>= closest`.
    private _rayBox(origin: vec3, direction: vec3, min: number[], max: number[]): number {
        let tMin = -Infinity;
        let tMax = Infinity;
        for (let a = 0; a < 3; a++) {
            const d = direction[a];
            if (Math.abs(d) < 1e-8) {
                if (origin[a] < min[a] || origin[a] > max[a]) return Infinity;
            } else {
                const inv = 1 / d;
                let t1 = (min[a] - origin[a]) * inv;
                let t2 = (max[a] - origin[a]) * inv;
                if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > tMin) tMin = t1;
                if (t2 < tMax) tMax = t2;
                if (tMin > tMax) return Infinity;
            }
        }
        if (tMax < 0) return Infinity;
        return tMin > 0 ? tMin : 0;
    }
}
