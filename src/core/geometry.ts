import { vec2, vec3 } from "gl-matrix";
import { BVH } from "./bvh";

/** Anything the constructor accepts for a vertex attribute: flat typed/plain arrays, or the legacy
 *  array-of-tuples shape. See {@link Geometry} for why both are supported. */
export type AttributeInput = Float32Array | number[] | number[][] | readonly (readonly number[])[];
export type IndexInput = Uint32Array | Uint16Array | number[];

/**
 * Flattens any accepted attribute shape into a `Float32Array` of `count * stride` floats.
 *
 * A `Float32Array` passes through untouched (no copy), which is what makes a worker able to hand
 * geometry across a thread boundary as a transferable and have it used directly.
 */
function toFlat(input: AttributeInput | undefined, stride: number): Float32Array {
    if (!input || (input as ArrayLike<unknown>).length === 0) return EMPTY_F32;
    if (input instanceof Float32Array) return input;

    const arr = input as ArrayLike<unknown>;
    // Legacy nested shape: [[x,y,z], [x,y,z], ...] (elements may themselves be Float32Array(3)).
    if (typeof arr[0] === 'object' && arr[0] !== null) {
        const nested = input as ArrayLike<ArrayLike<number>>;
        const out = new Float32Array(nested.length * stride);
        for (let i = 0; i < nested.length; i++) {
            const v = nested[i];
            for (let c = 0; c < stride; c++) out[i * stride + c] = v[c];
        }
        return out;
    }
    // Already flat, but a plain number[].
    return new Float32Array(input as number[]);
}

const EMPTY_F32 = new Float32Array(0);
const EMPTY_U32 = new Uint32Array(0);

/**
 * Vertex data for a mesh, stored as **flat typed arrays** (`positions[i*3 + 0..2]`).
 *
 * It used to hold arrays-of-tuples, which cost three separate transformations on every import —
 * flat source data was exploded into N little arrays, `getData` flattened them straight back into a
 * `number[]`, and `Mesh.create` copied that into a `Float32Array`. Measured on a 500k-vertex mesh
 * that was ~1s of main-thread work per model, and it also made geometry impossible to hand to a
 * worker: tuple arrays are not transferable and structured-clone walks every element.
 *
 * The constructor still accepts the legacy nested shape, so existing callers and saved projects keep
 * working; it is normalised to flat on the way in.
 */
export class Geometry {
    private _positions: Float32Array;
    private _normals: Float32Array;
    private _uvs: Float32Array;
    private _tangents!: Float32Array;
    private _bitangents!: Float32Array;
    private readonly _indices: Uint32Array;
    private _bvh?: BVH;
    private _boundingSphere?: { center: vec3; radius: number };
    private _boundingBox?: { min: vec3; max: vec3 };

    constructor(
        positions: AttributeInput = EMPTY_F32,
        normals: AttributeInput = EMPTY_F32,
        uvs: AttributeInput = EMPTY_F32,
        tangents: AttributeInput = EMPTY_F32,
        bitangents: AttributeInput = EMPTY_F32,
        indices: IndexInput = EMPTY_U32,
        calculateTangents: boolean = true
    ) {
        this._positions = toFlat(positions, 3);
        this._normals = toFlat(normals, 3);
        this._uvs = toFlat(uvs, 2);
        this._tangents = toFlat(tangents, 3);
        this._bitangents = toFlat(bitangents, 3);
        this._indices = indices instanceof Uint32Array ? indices : Uint32Array.from(indices as ArrayLike<number>);

        if ((this._tangents.length === 0 || this._bitangents.length === 0) && calculateTangents)
            this._calculateTangents();
    }

    // Flat: component `c` of vertex `i` is `positions[i * 3 + c]` (stride 2 for uvs).
    public get positions(): Float32Array { return this._positions; }
    public get normals(): Float32Array { return this._normals; }
    public get uvs(): Float32Array { return this._uvs; }
    public get indices(): Uint32Array { return this._indices; }
    public get tangents(): Float32Array { return this._tangents; }
    public get bitangents(): Float32Array { return this._bitangents; }
    /**
     * Number of vertices — `positions.length`, not the float count.
     *
     * This used to return `positions.length * 3`, i.e. three times the answer its name promises. Every
     * caller feeds it straight to `Mesh.create(data, vertexCount, indices)`, where it becomes the count
     * for the unindexed `drawArrays` path — so an unindexed geometry asked the driver for three times the
     * vertices it has. Masked only because every geometry built today carries indices.
     */
    public get vertexCount(): number { return this._positions.length / 3; }
    /**
     * Bounding Volume Hierarchy over this geometry's triangles, built lazily in object space and
     * memoized. Used for exact ray/triangle picking (see `Raycaster`); shared across every node
     * that references this geometry.
     */
    public get bvh(): BVH {
        if (!this._bvh) {
            // Non-indexed geometry: consecutive triples form triangles, so synthesise the identity
            // index list the BVH needs. (Carried over from the removed BVH.fromGeometry.)
            let indices = this._indices;
            if (indices.length < 3) {
                indices = new Uint32Array(this.vertexCount);
                for (let i = 0; i < indices.length; i++) indices[i] = i;
            }
            this._bvh = BVH.fromBuffers(this._positions, indices);
        }
        return this._bvh;
    }
    /**
     * Object-space bounding sphere (center + radius), computed lazily and cached. Derived from the
     * BVH's root AABB when the geometry has triangles (reusing bounds already computed by the BVH
     * build), otherwise from a single pass over the positions. Purely local-space, so it never
     * invalidates — used for cheap per-object frustum culling (see `Node.getBoundingSphere`).
     */
    public get boundingSphere(): { center: vec3; radius: number } {
        if (this._boundingSphere) return this._boundingSphere;

        let min: [number, number, number];
        let max: [number, number, number];
        const bvh = this.bvh;
        if (bvh.triangleCount > 0) {
            const b = bvh.bounds;
            min = b.min; max = b.max;
        } else if (this._positions.length > 0) {
            min = [Infinity, Infinity, Infinity];
            max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < this._positions.length; i += 3)
                for (let a = 0; a < 3; a++) {
                    const v = this._positions[i + a];
                    if (v < min[a]) min[a] = v;
                    if (v > max[a]) max[a] = v;
                }
        } else {
            min = [0, 0, 0]; max = [0, 0, 0];
        }

        const center = vec3.fromValues((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
        const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
        const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
        this._boundingSphere = { center, radius };
        return this._boundingSphere;
    }
    /**
     * Object-space axis-aligned bounding box, computed lazily and cached. Local-space, so like
     * {@link boundingSphere} it only invalidates when the vertices themselves change ({@link scale}).
     *
     * Deliberately computed from a direct pass over the positions rather than from `this.bvh.bounds`
     * (which is where {@link boundingSphere} gets its extents): touching `bvh` force-builds the whole
     * hierarchy, an O(n log n) job heavy enough to hitch a frame on a dense mesh. Camera collision
     * queries this every frame, so it must never be able to trigger that build.
     *
     * Returns a live cached reference — callers must not mutate it.
     */
    public get boundingBox(): { min: vec3; max: vec3 } {
        if (this._boundingBox) return this._boundingBox;

        const min = vec3.fromValues(Infinity, Infinity, Infinity);
        const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);

        if (this._positions.length === 0) {
            vec3.set(min, 0, 0, 0);
            vec3.set(max, 0, 0, 0);
        } else {
            for (let i = 0; i < this._positions.length; i += 3)
                for (let a = 0; a < 3; a++) {
                    const v = this._positions[i + a];
                    if (v < min[a]) min[a] = v;
                    if (v > max[a]) max[a] = v;
                }
        }

        this._boundingBox = { min, max };
        return this._boundingBox;
    }
    /**
     * Uniformly scale the geometry in object (vertex) space, multiplying every position by `factor` and
     * invalidating the cached BVH + bounding sphere/box. Normals/tangents are unaffected by uniform scaling.
     * Used to bake an import-normalization scale into the mesh so the asset keeps an identity transform.
     */
    public scale(factor: number): void {
        if (factor === 1) return;
        for (let i = 0; i < this._positions.length; i++) this._positions[i] *= factor;
        this._bvh = undefined;
        this._boundingSphere = undefined;
        this._boundingBox = undefined;
    }

    /**
     * Interleaves the requested attributes into a single buffer ready for `Mesh.create` to upload.
     *
     * Returns a `Float32Array` written directly rather than a `number[]` built by ~14 `push` calls per
     * vertex — which the caller then had to copy into a `Float32Array` anyway. On a dense mesh that
     * pair of steps was ~380ms; now it is one sized allocation and a linear fill.
     */
    public getData(attributes: string[] = []): Float32Array {
        const count = this.vertexCount;
        if (count === 0) return EMPTY_F32;

        // An attribute contributes only when it was requested AND is actually present, matching the
        // original guards — a geometry with no UVs must not leave a hole in the stride.
        const wantPosition = attributes.includes('position');
        const wantNormal = this._normals.length > 0 && attributes.includes('normal');
        const wantUv = this._uvs.length > 0 && attributes.includes('uv');
        const wantTangent = this._tangents.length > 0 && attributes.includes('tangent');
        const wantBitangent = this._bitangents.length > 0 && attributes.includes('bitangent');

        const stride = (wantPosition ? 3 : 0) + (wantNormal ? 3 : 0) + (wantUv ? 2 : 0)
                     + (wantTangent ? 3 : 0) + (wantBitangent ? 3 : 0);
        if (stride === 0) return EMPTY_F32;

        const out = new Float32Array(count * stride);
        let o = 0;
        for (let i = 0; i < count; i++) {
            const i3 = i * 3, i2 = i * 2;
            if (wantPosition) {
                out[o++] = this._positions[i3]; out[o++] = this._positions[i3 + 1]; out[o++] = this._positions[i3 + 2];
            }
            if (wantNormal) {
                out[o++] = this._normals[i3]; out[o++] = this._normals[i3 + 1]; out[o++] = this._normals[i3 + 2];
            }
            if (wantUv) {
                out[o++] = this._uvs[i2]; out[o++] = this._uvs[i2 + 1];
            }
            if (wantTangent) {
                out[o++] = this._tangents[i3]; out[o++] = this._tangents[i3 + 1]; out[o++] = this._tangents[i3 + 2];
            }
            if (wantBitangent) {
                out[o++] = this._bitangents[i3]; out[o++] = this._bitangents[i3 + 1]; out[o++] = this._bitangents[i3 + 2];
            }
        }
        return out;
    }

    /**
     * Recompute smooth per-vertex normals in place from the current positions and indices
     * (area-weighted face-normal accumulation). Used after deforming positions at runtime
     * (e.g. terrain sculpting). No-op if the geometry is not indexed.
     */
    public computeNormals(): void {
        if (this._indices.length === 0) return;

        // Sized to the positions, not reused: a geometry loaded without normals has an empty array here.
        if (this._normals.length !== this._positions.length) this._normals = new Float32Array(this._positions.length);
        else this._normals.fill(0);

        const pA = vec3.create(), pB = vec3.create(), pC = vec3.create();
        const edge1 = vec3.create(), edge2 = vec3.create(), faceNormal = vec3.create();

        for (let f = 0; f < this._indices.length; f += 3) {
            const a = this._indices[f] * 3, b = this._indices[f + 1] * 3, c = this._indices[f + 2] * 3;
            vec3.set(pA, this._positions[a], this._positions[a + 1], this._positions[a + 2]);
            vec3.set(pB, this._positions[b], this._positions[b + 1], this._positions[b + 2]);
            vec3.set(pC, this._positions[c], this._positions[c + 1], this._positions[c + 2]);
            vec3.subtract(edge1, pB, pA);
            vec3.subtract(edge2, pC, pA);
            // Non-normalized cross => magnitude proportional to face area (area weighting)
            vec3.cross(faceNormal, edge1, edge2);
            this._normals[a] += faceNormal[0]; this._normals[a + 1] += faceNormal[1]; this._normals[a + 2] += faceNormal[2];
            this._normals[b] += faceNormal[0]; this._normals[b + 1] += faceNormal[1]; this._normals[b + 2] += faceNormal[2];
            this._normals[c] += faceNormal[0]; this._normals[c + 1] += faceNormal[1]; this._normals[c + 2] += faceNormal[2];
        }

        const n = vec3.create();
        for (let i = 0; i < this._normals.length; i += 3) {
            vec3.set(n, this._normals[i], this._normals[i + 1], this._normals[i + 2]);
            vec3.normalize(n, n);
            this._normals[i] = n[0]; this._normals[i + 1] = n[1]; this._normals[i + 2] = n[2];
        }
    }

    // Per-vertex tangent frame from UVs. Accumulate each face's UV-space tangent onto its 3 vertices, then
    // Gram-Schmidt against the vertex normal. (The previous version pushed two tangents PER FACE while the
    // interleaver reads them by VERTEX index — misaligned on any indexed mesh, breaking normal maps/parallax.)
    private _calculateTangents(): void {
        const n = this.vertexCount;
        const acc = new Float32Array(n * 3);
        const hasUvs = this._uvs.length >= n * 2;

        for (let i = 0; i + 2 < this._indices.length; i += 3) {
            const i0 = this._indices[i], i1 = this._indices[i + 1], i2 = this._indices[i + 2];
            // Guards the same out-of-range cases the tuple version caught via undefined elements.
            if (i0 >= n || i1 >= n || i2 >= n || !hasUvs) continue;
            const p0 = i0 * 3, p1 = i1 * 3, p2 = i2 * 3;
            const t0 = i0 * 2, t1 = i1 * 2, t2 = i2 * 2;
            const e1x = this._positions[p1] - this._positions[p0];
            const e1y = this._positions[p1 + 1] - this._positions[p0 + 1];
            const e1z = this._positions[p1 + 2] - this._positions[p0 + 2];
            const e2x = this._positions[p2] - this._positions[p0];
            const e2y = this._positions[p2 + 1] - this._positions[p0 + 1];
            const e2z = this._positions[p2 + 2] - this._positions[p0 + 2];
            const du1 = this._uvs[t1] - this._uvs[t0], dv1 = this._uvs[t1 + 1] - this._uvs[t0 + 1];
            const du2 = this._uvs[t2] - this._uvs[t0], dv2 = this._uvs[t2 + 1] - this._uvs[t0 + 1];
            const denom = du1 * dv2 - du2 * dv1;
            const f = Math.abs(denom) < 1e-8 ? 0 : 1.0 / denom;
            const tx = f * (dv2 * e1x - dv1 * e2x);
            const ty = f * (dv2 * e1y - dv1 * e2y);
            const tz = f * (dv2 * e1z - dv1 * e2z);
            acc[p0] += tx; acc[p0 + 1] += ty; acc[p0 + 2] += tz;
            acc[p1] += tx; acc[p1 + 1] += ty; acc[p1 + 2] += tz;
            acc[p2] += tx; acc[p2 + 1] += ty; acc[p2 + 2] += tz;
        }

        this._tangents = new Float32Array(n * 3);
        this._bitangents = new Float32Array(n * 3);
        const hasNormals = this._normals.length >= n * 3;
        for (let i = 0; i < n; i++) {
            const i3 = i * 3;
            const nx = hasNormals ? this._normals[i3] : 0;
            const ny = hasNormals ? this._normals[i3 + 1] : 1;
            const nz = hasNormals ? this._normals[i3 + 2] : 0;
            let tx = acc[i3], ty = acc[i3 + 1], tz = acc[i3 + 2];
            // Gram-Schmidt: remove the normal component.
            const d = nx * tx + ny * ty + nz * tz;
            tx -= nx * d; ty -= ny * d; tz -= nz * d;
            let len = Math.hypot(tx, ty, tz);
            if (len < 1e-8) {
                // No UV gradient (or degenerate): pick any tangent perpendicular to the normal.
                const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = Math.abs(nx) < 0.9 ? 0 : 1, az = 0;
                tx = ay * nz - az * ny;
                ty = az * nx - ax * nz;
                tz = ax * ny - ay * nx;
                len = Math.hypot(tx, ty, tz) || 1;
            }
            tx /= len; ty /= len; tz /= len;
            this._tangents[i3] = tx; this._tangents[i3 + 1] = ty; this._tangents[i3 + 2] = tz;
            // Bitangent = -(normal x tangent), matching the engine's existing convention (default.vs negates it).
            this._bitangents[i3] = -(ny * tz - nz * ty);
            this._bitangents[i3 + 1] = -(nz * tx - nx * tz);
            this._bitangents[i3 + 2] = -(nx * ty - ny * tx);
        }
    }

    public static Triangle(base: number = 1, height: number = 1): Geometry {
        return new Geometry(
            [
                [-base/2, -height/2, 0.0],
                [base/2, -height/2, 0.0],
                [0.0, height/2, 0.0]
            ],
            [
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0]
            ],
            [
                [0.0, 0.0],
                [1.0, 0.0],
                [0.5, 1.0]
            ],
            [
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0]
            ],
            [
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0]
            ],
            [0, 1, 2],
        );
    }

    public static Quad(base: number = 1, height: number = 1): Geometry {
        return new Geometry(
            [
                [-base/2, -height/2, 0.0],
                [base/2, -height/2, 0.0],
                [base/2, height/2, 0.0],
                [-base/2, height/2, 0.0]
            ],
            [
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0]
            ],
            [
                [0.0, 0.0],
                [1.0, 0.0],
                [1.0, 1.0],
                [0.0, 1.0]
            ],
            [
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0]
            ],
            [
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0]
            ],
            [0, 1, 2, 0, 2, 3]
        );
    }

    /**
     * Flat disc on the XY plane (+Z normal), centred on the origin — a triangle fan around a real centre
     * vertex at index 0, with `segments + 1` rim vertices so the UV seam is duplicated rather than folded.
     */
    public static Circle(diameter: number = 1, segments: number = 32): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const angle = 2 * Math.PI / segments;
        const radius = diameter / 2;

        positions.push([0.0, 0.0, 0.0]);
        normals.push([0.0, 0.0, 1.0]);
        uvs.push([0.5, 0.5]);

        for (let i = 0; i <= segments; i++) {
            const x = radius * Math.cos(angle * i);
            const y = radius * Math.sin(angle * i);

            positions.push([x, y, 0.0]);
            normals.push([0.0, 0.0, 1.0]);
            uvs.push([0.5 + x / radius / 2, 0.5 + y / radius / 2]);
        }

        // i + 2 is in range because the rim runs to index `segments + 1`. The previous loop ran to
        // i === segments and referenced segments + 2, i.e. two triangles pointed past the last vertex.
        for (let i = 0; i < segments; i++)
            indices.push(0, i + 1, i + 2);

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    public static Cube(width: number = 1, height: number = 1, depth: number = 1, asWireframe: boolean = false): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const vertices: [number, number, number][] = [
            [-width/2, -height/2, depth/2],
            [width/2, -height/2, depth/2],
            [width/2, height/2, depth/2],
            [-width/2, height/2, depth/2],
            [-width/2, -height/2, -depth/2],
            [width/2, -height/2, -depth/2],
            [width/2, height/2, -depth/2],
            [-width/2, height/2, -depth/2]
        ];

        const faces = [
            [0, 1, 2, 3], // front
            [1, 5, 6, 2], // right
            [5, 4, 7, 6], // back
            [4, 0, 3, 7], // left
            [3, 2, 6, 7], // top
            [4, 5, 1, 0]  // bottom
        ];

        const faceNormals: [number, number, number][] = [
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            [-1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0]
        ];

        const faceUVs: [number, number][] = [
            [0.0, 0.0],
            [1.0, 0.0],
            [1.0, 1.0],
            [0.0, 1.0]
        ];


        for (let i = 0; i < faces.length; i++) {
            for (let j = 0; j < faces[i].length; j++) {
                positions.push(vertices[faces[i][j]]);
                normals.push(faceNormals[i]);
                uvs.push(faceUVs[j]);
            }
            if (!asWireframe) {
                indices.push(i * 4 + 0);
                indices.push(i * 4 + 1);
                indices.push(i * 4 + 2);
                indices.push(i * 4 + 0);
                indices.push(i * 4 + 2);
                indices.push(i * 4 + 3);
            }
        }

        if (asWireframe) {
            indices.push(0, 1, 1, 2, 2, 3, 3, 0);
            indices.push(1, 5, 5, 6, 6, 2);
            indices.push(0, 9, 9, 10, 10, 3);
            indices.push(5, 9, 6, 10);
        }
        
        return new Geometry(positions, normals, uvs, [], [], indices, !asWireframe);
    }

    /**
     * Wireframe geometry for a convex hull collider. `vertices` are the hull points (typically
     * centered on their centroid, as `convexHull.ts` emits them) and `faces` are index loops.
     * Each hull edge is emitted exactly once as a gl.LINES pair — wireframe materials draw the
     * index buffer as line pairs, so triangle indices would render as edges that don't exist.
     * Normals and uvs are filled for every vertex: `getData()` skips empty attribute arrays while
     * the mesh VAO is strided by the *shader's* attribute list, so a positions-only geometry would
     * be read at the wrong stride and scramble.
     */
    public static ConvexHull(vertices: number[][], faces: number[][]): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];

        // The hull is centered on its centroid, so the outward direction doubles as a normal.
        for (const v of vertices) {
            positions.push([v[0], v[1], v[2]]);
            const l = Math.hypot(v[0], v[1], v[2]) || 1;
            normals.push([v[0] / l, v[1] / l, v[2] / l]);
            uvs.push([0, 0]);
        }

        const indices: number[] = [];
        const seen = new Set<string>();
        for (const face of faces) {
            for (let i = 0; i < face.length; i++) {
                const a = face[i];
                const b = face[(i + 1) % face.length];
                const key = a < b ? `${a},${b}` : `${b},${a}`;
                if (seen.has(key)) continue;
                seen.add(key);
                indices.push(a, b);
            }
        }

        return new Geometry(positions, normals, uvs, [], [], indices, false);
    }

    public static Sphere(segments: number = 32, radius: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        for (let i = 0; i <= segments; ++i)
        {
            let v = i / segments;
            let phi = v * Math.PI;

            for (let j = 0; j <= segments; ++j)
            {
                let u = j / segments;
                let theta = u * 2 * Math.PI;

                const x = Math.cos(theta) * Math.sin(phi) * radius;
                const y = Math.cos(phi) * radius;
                const z = Math.sin(theta) * Math.sin(phi) * radius;

                let pos = [x, y, z];
                let uv = [(segments - j) / segments, v];
                let nor = vec3.normalize(vec3.create(), vec3.fromValues(x,y,z));

                positions.push([pos[0], pos[1], pos[2]]);
                uvs.push([uv[0], uv[1]]);
                normals.push([nor[0], nor[1], nor[2]]);
            }
        }

        // Generate indices
        for (let i = 0; i < segments; ++i)
            for (let j = 0; j < segments; ++j)
            {
                let k1 = i * (segments + 1) + j;
                let k2 = k1 + segments + 1;

                indices.push(k1);
                indices.push(k1 + 1);
                indices.push(k2);

                indices.push(k2);
                indices.push(k1 + 1);
                indices.push(k2 + 1);
            }


        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    public static Cylinder(segments: number = 32, radius: number = 1, height: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];
    
        const halfHeight = height / 2;
    
        // side vertices
        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * 2 * Math.PI;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);
    
            for (let j = 0; j <= 1; j++) {
                const sign = j === 0 ? -1 : 1; // Switch between top and bottom
                const x = cosTheta * radius;
                const y = sign * halfHeight;
                const z = sinTheta * radius;
    
                const u = i / segments;
                const v = (1 + sign) / 2; // Map top to 1 and bottom to 0
    
                const normal = vec3.normalize(vec3.create(), vec3.fromValues(x, 0, z));
    
                positions.push([x, y, z]);
                normals.push([normal[0], normal[1], normal[2]]);
                uvs.push([u, v]);
            }
        }
    
        // side indices
        for (let i = 0; i < segments; ++i) {
            for (let j = 0; j < 1; ++j) {
                const k1 = i * 2 + j;
                const k2 = k1 + 2;
    
                indices.push(k1);
                indices.push(k1 + 1);
                indices.push(k2);
    
                indices.push(k2);
                indices.push(k1 + 1);
                indices.push(k2 + 1);
            }
        }

        // Caps. Each is a triangle fan around a real CENTRE vertex at (0, +/-halfHeight, 0). Previously the
        // fan was hubbed on a rim vertex, which triangulates the disc but leaves it with no centre point:
        // sliver triangles at the hub, and a UV layout that cannot place the middle of the cap texture.
        const angle = 2 * Math.PI / segments;
        for (const sign of [1, -1]) {
            const centre = positions.length;
            positions.push([0.0, sign * halfHeight, 0.0]);
            normals.push([0.0, sign, 0.0]);
            uvs.push([0.5, 0.5]);

            // segments + 1 rim vertices: the seam is duplicated so u wraps cleanly rather than folding back.
            for (let i = 0; i <= segments; i++) {
                const x = radius * Math.cos(angle * i);
                const z = radius * Math.sin(angle * i);

                positions.push([x, sign * halfHeight, z]);
                normals.push([0.0, sign, 0.0]);
                // Mirror v on the bottom cap, otherwise the two faces read as mirror images of each other.
                uvs.push([0.5 + x / radius / 2, 0.5 + sign * z / radius / 2]);
            }

            // Wind CCW as seen from outside the cap, so the two faces front-face in opposite directions.
            for (let i = 0; i < segments; i++) {
                const a = centre + 1 + i;
                const b = centre + 2 + i;
                if (sign > 0) indices.push(centre, b, a);
                else indices.push(centre, a, b);
            }
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Y-aligned capsule centred on the origin — a cylinder capped by two hemispheres.
     *
     * `cylinderHeight` is the STRAIGHT SECTION ONLY: total height is `cylinderHeight + 2 * radius`. This
     * mirrors `Shape.Capsule`, which derives the straight section from the collider's total height.
     * A `cylinderHeight` of 0 degenerates to a sphere, which is exactly right.
     *
     * Built as one lathed surface: both hemispheres are swept as ring stacks, and their equator rings are
     * displaced to +/-cylinderHeight/2. The wall between those two coincident-radius rings IS the straight
     * section, so no separate cylinder pass is needed and the surface stays closed.
     */
    public static Capsule(segments: number = 32, radius: number = 1, cylinderHeight: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const halfCyl = Math.max(0, cylinderHeight) / 2;
        // Stacks per hemisphere. Quartering `segments` keeps a capsule's silhouette about as smooth as a
        // Sphere() of the same segment count, which uses `segments` stacks over the whole 180 degrees.
        const capStacks = Math.max(2, Math.round(segments / 4));

        // Ring profile from the top pole to the bottom pole. `y`/`r` are the ring's position and radius;
        // `ny`/`nr` are its normal's vertical and radial parts — taken from the un-displaced hemisphere, so
        // the straight section's normals come out perfectly horizontal.
        const rings: { y: number, r: number, ny: number, nr: number }[] = [];
        for (let half = 0; half <= 1; ++half) {
            const offset = half === 0 ? halfCyl : -halfCyl;
            for (let i = 0; i <= capStacks; ++i) {
                const phi = (half + i / capStacks) * (Math.PI / 2);
                rings.push({
                    y: Math.cos(phi) * radius + offset, r: Math.sin(phi) * radius,
                    ny: Math.cos(phi), nr: Math.sin(phi),
                });
            }
        }

        for (let i = 0; i < rings.length; ++i) {
            const ring = rings[i];
            for (let j = 0; j <= segments; ++j) {
                const theta = (j / segments) * 2 * Math.PI;
                const cosTheta = Math.cos(theta), sinTheta = Math.sin(theta);

                positions.push([cosTheta * ring.r, ring.y, sinTheta * ring.r]);
                normals.push([cosTheta * ring.nr, ring.ny, sinTheta * ring.nr]);
                uvs.push([(segments - j) / segments, i / (rings.length - 1)]);
            }
        }

        for (let i = 0; i < rings.length - 1; ++i)
            for (let j = 0; j < segments; ++j) {
                const k1 = i * (segments + 1) + j;
                const k2 = k1 + segments + 1;

                indices.push(k1, k1 + 1, k2);
                indices.push(k2, k1 + 1, k2 + 1);
            }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Y-aligned cone centred on the origin: apex at +height/2, base cap at -height/2.
     *
     * The apex is duplicated PER SEGMENT rather than shared, so each side triangle carries its own normal
     * and UV. A single shared apex would have to average every side normal into one straight-up vector,
     * which reads as a pinched, over-bright tip. The base reuses Cylinder's centre-vertex fan.
     */
    public static Cone(segments: number = 32, radius: number = 0.5, height: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const halfHeight = height / 2;
        const angle = 2 * Math.PI / segments;

        // Side. The slope normal tilts by the cone's half-angle: for a profile running (radius, -h/2) to
        // (0, +h/2), the outward normal is proportional to (cos * height, radius, sin * height).
        for (let i = 0; i < segments; i++) {
            // Apex normal is the MIDPOINT of the segment it caps, so the shading stays symmetric about it.
            for (const [t, y, r] of [[i + 0.5, halfHeight, 0], [i, -halfHeight, radius], [i + 1, -halfHeight, radius]] as const) {
                const theta = angle * t;
                const cosTheta = Math.cos(theta), sinTheta = Math.sin(theta);
                const normal = vec3.normalize(vec3.create(), vec3.fromValues(cosTheta * height, radius, sinTheta * height));

                positions.push([cosTheta * r, y, sinTheta * r]);
                normals.push([normal[0], normal[1], normal[2]]);
                uvs.push([t / segments, r === 0 ? 1 : 0]);
            }
            const base = i * 3;
            indices.push(base, base + 2, base + 1);
        }

        // Base cap: centre vertex + duplicated-seam rim, wound CCW seen from below.
        const centre = positions.length;
        positions.push([0.0, -halfHeight, 0.0]);
        normals.push([0.0, -1.0, 0.0]);
        uvs.push([0.5, 0.5]);

        for (let i = 0; i <= segments; i++) {
            const x = radius * Math.cos(angle * i);
            const z = radius * Math.sin(angle * i);

            positions.push([x, -halfHeight, z]);
            normals.push([0.0, -1.0, 0.0]);
            uvs.push([0.5 + x / radius / 2, 0.5 - z / radius / 2]);
        }

        for (let i = 0; i < segments; i++)
            indices.push(centre, centre + 1 + i, centre + 2 + i);

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Torus lying in the XZ plane (Y up), centred on the origin. `radius` is the distance from the origin to
     * the centre of the tube; `tube` is the tube's own radius, so the outer extent is `radius + tube`.
     *
     * Both rings carry a duplicated seam vertex (hence the `<=` bounds), which is what lets u and v each run
     * a clean 0..1 instead of wrapping back onto themselves.
     */
    public static Torus(radialSegments: number = 32, tubularSegments: number = 16, radius: number = 0.5, tube: number = 0.2): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        radialSegments = Math.max(3, Math.floor(radialSegments));
        tubularSegments = Math.max(3, Math.floor(tubularSegments));

        for (let i = 0; i <= radialSegments; i++) {
            const u = (i / radialSegments) * 2 * Math.PI;
            const cosU = Math.cos(u), sinU = Math.sin(u);

            for (let j = 0; j <= tubularSegments; j++) {
                const v = (j / tubularSegments) * 2 * Math.PI;
                const cosV = Math.cos(v), sinV = Math.sin(v);

                // The normal is the offset from the tube's centre circle, which is already unit length.
                const nx = cosV * cosU, ny = sinV, nz = cosV * sinU;

                positions.push([(radius + tube * cosV) * cosU, tube * sinV, (radius + tube * cosV) * sinU]);
                normals.push([nx, ny, nz]);
                uvs.push([i / radialSegments, j / tubularSegments]);
            }
        }

        for (let i = 0; i < radialSegments; i++)
            for (let j = 0; j < tubularSegments; j++) {
                const k1 = i * (tubularSegments + 1) + j;
                const k2 = k1 + tubularSegments + 1;

                indices.push(k1, k1 + 1, k2);
                indices.push(k1 + 1, k2 + 1, k2);
            }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Square-based pyramid centred on the origin: apex at +height/2, base at -height/2.
     *
     * Every face owns its vertices. The four sides meet at hard creases and the base is perpendicular to
     * all of them, so sharing corners would average unrelated normals and round off edges that should be
     * sharp — the same reason `Cube` does not share its eight corners.
     */
    public static Pyramid(base: number = 1, height: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const h = height / 2;
        const b = base / 2;
        const apex: [number, number, number] = [0, h, 0];
        // Base corners, counter-clockwise seen from ABOVE.
        const corners: [number, number, number][] = [[-b, -h, b], [b, -h, b], [b, -h, -b], [-b, -h, -b]];

        for (let i = 0; i < 4; i++) {
            const c0 = corners[i];
            const c1 = corners[(i + 1) % 4];

            // Flat face normal from the edge cross product, so it is exact rather than approximated.
            const e0 = vec3.sub(vec3.create(), vec3.fromValues(...c1), vec3.fromValues(...c0));
            const e1 = vec3.sub(vec3.create(), vec3.fromValues(...apex), vec3.fromValues(...c0));
            const n = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), e0, e1));

            const start = positions.length;
            positions.push([...c0], [...c1], [...apex]);
            normals.push([n[0], n[1], n[2]], [n[0], n[1], n[2]], [n[0], n[1], n[2]]);
            uvs.push([0, 0], [1, 0], [0.5, 1]);
            indices.push(start, start + 1, start + 2);
        }

        const start = positions.length;
        for (const c of corners) {
            positions.push([...c]);
            normals.push([0.0, -1.0, 0.0]);
            uvs.push([0.5 + c[0] / base, 0.5 - c[2] / base]);
        }
        // Reversed relative to the CCW-from-above corner order, so the base front-faces downward.
        indices.push(start, start + 2, start + 1);
        indices.push(start, start + 3, start + 2);

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Flat horizontal grid on the XZ plane (Y up), centred on the origin. `cols`/`rows` are the number of
     * quads along X/Z, producing (cols+1)*(rows+1) vertices. Intended as the base mesh for terrain that is
     * then sculpted by mutating the Y of each vertex. UVs span 0..1 across the whole plane.
     */
    public static Plane(width: number = 1, depth: number = 1, cols: number = 1, rows: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        cols = Math.max(1, Math.floor(cols));
        rows = Math.max(1, Math.floor(rows));
        const halfW = width / 2;
        const halfD = depth / 2;

        for (let r = 0; r <= rows; r++) {
            const v = r / rows;
            const z = -halfD + v * depth;
            for (let c = 0; c <= cols; c++) {
                const u = c / cols;
                const x = -halfW + u * width;
                positions.push([x, 0.0, z]);
                normals.push([0.0, 1.0, 0.0]);
                uvs.push([u, v]);
            }
        }

        const stride = cols + 1;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tl = r * stride + c;
                const tr = tl + 1;
                const bl = (r + 1) * stride + c;
                const br = bl + 1;
                // CCW winding, front face up
                indices.push(tl, bl, tr);
                indices.push(tr, bl, br);
            }
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    // ---------------------------------------------------------------------------------------------
    // Complex / structural geometries.
    //
    // These are level-blockout shapes rather than mathematical solids, and several of them are unions of
    // flat faces. The two helpers below exist so that winding, per-face normals and the quad triangulation
    // are written ONCE: an inverted face is invisible under backface culling and passes every count and
    // bounds check, which is exactly how `Torus` shipped inside-out. `tests/geometryPrimitives.test.ts`
    // asserts the winding of every factory against its authored normal.
    // ---------------------------------------------------------------------------------------------

    /**
     * Append one flat quad. `a b c d` must run counter-clockwise as seen from the `normal` side; the quad
     * is split into (a,b,c) + (a,c,d), so it must also be planar and convex.
     */
    private static _pushQuad(
        positions: [number, number, number][], normals: [number, number, number][],
        uvs: [number, number][], indices: number[],
        a: [number, number, number], b: [number, number, number],
        c: [number, number, number], d: [number, number, number],
        normal: [number, number, number],
    ): void {
        const base = positions.length;
        positions.push(a, b, c, d);
        normals.push(normal, normal, normal, normal);
        uvs.push([0, 0], [1, 0], [1, 1], [0, 1]);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    /** Append one flat triangle. `a b c` counter-clockwise as seen from the `normal` side. */
    private static _pushTri(
        positions: [number, number, number][], normals: [number, number, number][],
        uvs: [number, number][], indices: number[],
        a: [number, number, number], b: [number, number, number], c: [number, number, number],
        normal: [number, number, number],
    ): void {
        const base = positions.length;
        positions.push(a, b, c);
        normals.push(normal, normal, normal);
        uvs.push([0, 0], [1, 0], [0.5, 1]);
        indices.push(base, base + 1, base + 2);
    }

    /**
     * Append an axis-aligned box, optionally yawed about +Y. Every face owns its four vertices, matching
     * `Cube` — a box has six hard creases, so sharing corners would average unrelated normals.
     *
     * `centre` is in final coordinates and `yaw` rotates the box about ITS OWN centre. A yaw is a rotation
     * (determinant +1), so it carries the winding and the normals along with it and cannot flip a face.
     */
    private static _pushBox(
        positions: [number, number, number][], normals: [number, number, number][],
        uvs: [number, number][], indices: number[],
        centre: [number, number, number], half: [number, number, number], yaw: number = 0,
    ): void {
        const [hx, hy, hz] = half;
        const cos = Math.cos(yaw), sin = Math.sin(yaw);
        // Rotation about +Y, applied to corner offsets and face normals alike.
        const spin = (v: [number, number, number]): [number, number, number] =>
            yaw === 0 ? [v[0], v[1], v[2]] : [v[0] * cos + v[2] * sin, v[1], -v[0] * sin + v[2] * cos];
        const at = (v: [number, number, number]): [number, number, number] => {
            const r = spin(v);
            return [r[0] + centre[0], r[1] + centre[1], r[2] + centre[2]];
        };

        const c = [
            at([-hx, -hy, hz]), at([hx, -hy, hz]), at([hx, hy, hz]), at([-hx, hy, hz]),
            at([-hx, -hy, -hz]), at([hx, -hy, -hz]), at([hx, hy, -hz]), at([-hx, hy, -hz]),
        ];
        const faces = [[0, 1, 2, 3], [1, 5, 6, 2], [5, 4, 7, 6], [4, 0, 3, 7], [3, 2, 6, 7], [4, 5, 1, 0]];
        const faceNormals: [number, number, number][] = [
            [0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];

        for (let i = 0; i < faces.length; ++i) {
            const f = faces[i];
            Geometry._pushQuad(positions, normals, uvs, indices,
                c[f[0]], c[f[1]], c[f[2]], c[f[3]], spin(faceNormals[i]));
        }
    }

    /**
     * Wedge / triangular prism, centred on the origin: a slope rising toward +Z, from `-height/2` at the
     * `-Z` edge up to `+height/2` at the `+Z` edge. The building block of a blockout ramp.
     */
    public static Ramp(width: number = 1, height: number = 1, depth: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const w = width / 2, h = height / 2, d = depth / 2;
        const A: [number, number, number] = [-w, -h, -d];
        const B: [number, number, number] = [w, -h, -d];
        const C: [number, number, number] = [w, -h, d];
        const D: [number, number, number] = [-w, -h, d];
        const E: [number, number, number] = [-w, h, d];
        const F: [number, number, number] = [w, h, d];

        Geometry._pushQuad(positions, normals, uvs, indices, A, B, C, D, [0, -1, 0]);
        Geometry._pushQuad(positions, normals, uvs, indices, D, C, F, E, [0, 0, 1]);
        // Slope. Its normal leans back toward the low end: (0, depth, -height), normalised.
        const sl = Math.hypot(depth, height);
        Geometry._pushQuad(positions, normals, uvs, indices, A, E, F, B, [0, depth / sl, -height / sl]);
        Geometry._pushTri(positions, normals, uvs, indices, A, D, E, [-1, 0, 0]);
        Geometry._pushTri(positions, normals, uvs, indices, B, F, C, [1, 0, 0]);

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Quarter-pyramid corner piece, centred on the origin: a rectangular base at `-height/2` with the apex
     * directly above the `(+X, +Z)` corner. Mates with `Ramp` at a 90-degree turn.
     */
    public static CornerRamp(width: number = 1, height: number = 1, depth: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const w = width / 2, h = height / 2, d = depth / 2;
        const A: [number, number, number] = [-w, -h, -d];
        const B: [number, number, number] = [w, -h, -d];
        const C: [number, number, number] = [w, -h, d];
        const D: [number, number, number] = [-w, -h, d];
        const P: [number, number, number] = [w, h, d];

        Geometry._pushQuad(positions, normals, uvs, indices, A, B, C, D, [0, -1, 0]);
        Geometry._pushTri(positions, normals, uvs, indices, B, P, C, [1, 0, 0]);
        Geometry._pushTri(positions, normals, uvs, indices, D, C, P, [0, 0, 1]);
        // The two slopes, meeting along the A-P diagonal.
        const sz = Math.hypot(depth, height), sx = Math.hypot(width, height);
        Geometry._pushTri(positions, normals, uvs, indices, A, P, B, [0, depth / sz, -height / sz]);
        Geometry._pushTri(positions, normals, uvs, indices, A, D, P, [-height / sx, width / sx, 0]);

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Straight flight of stairs ascending toward +Z, centred on the origin, solid down to the ground.
     *
     * Built as ONE extruded stepped profile rather than a stack of boxes: no internal faces, no coplanar
     * overlap, and 4n+2 quads instead of 6n. Each side is tiled by n full-height columns, which exactly
     * triangulates the (non-convex) staircase profile without needing a general polygon routine.
     */
    public static Stairs(steps: number = 8, width: number = 1, height: number = 1, depth: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const n = Math.max(1, Math.floor(steps));
        const w = width / 2, h = height / 2, d = depth / 2;
        const rise = height / n, run = depth / n;

        for (let i = 0; i < n; ++i) {
            const z0 = -d + i * run, z1 = z0 + run;
            const y0 = -h + i * rise, y1 = y0 + rise;

            // Riser, facing the approach (-Z).
            Geometry._pushQuad(positions, normals, uvs, indices,
                [w, y0, z0], [-w, y0, z0], [-w, y1, z0], [w, y1, z0], [0, 0, -1]);
            // Tread, facing up.
            Geometry._pushQuad(positions, normals, uvs, indices,
                [-w, y1, z0], [-w, y1, z1], [w, y1, z1], [w, y1, z0], [0, 1, 0]);
            // Side columns run from the ground to this step's tread, so consecutive columns tile the
            // profile edge to edge with no overlap.
            Geometry._pushQuad(positions, normals, uvs, indices,
                [-w, -h, z0], [-w, -h, z1], [-w, y1, z1], [-w, y1, z0], [-1, 0, 0]);
            Geometry._pushQuad(positions, normals, uvs, indices,
                [w, -h, z0], [w, y1, z0], [w, y1, z1], [w, -h, z1], [1, 0, 0]);
        }

        Geometry._pushQuad(positions, normals, uvs, indices,
            [-w, -h, d], [w, -h, d], [w, h, d], [-w, h, d], [0, 0, 1]);        // back wall
        Geometry._pushQuad(positions, normals, uvs, indices,
            [-w, -h, -d], [w, -h, -d], [w, -h, d], [-w, -h, d], [0, -1, 0]);   // underside

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Spiral staircase: `steps` rectangular treads swept around the Y axis, centred on the origin.
     *
     * The treads are straight boxes rather than curved wedges — what a blockout kit uses, and what keeps
     * every face flat. Each tread is `rise` thick so consecutive ones stack flush into a continuous helix;
     * `sweep` is the total turn in radians.
     */
    public static SpiralStairs(
        steps: number = 12, innerRadius: number = 0.15, outerRadius: number = 0.6,
        height: number = 1, sweep: number = Math.PI * 2,
    ): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const n = Math.max(1, Math.floor(steps));
        const inner = Math.max(0, Math.min(innerRadius, outerRadius));
        const rise = height / n;
        const mid = (inner + outerRadius) / 2;
        const radial = Math.max(1e-4, (outerRadius - inner) / 2);
        // Tread width from the arc length at the mid radius, so treads meet without a visible gap.
        const tread = Math.max(1e-4, Math.abs(sweep) / n * mid);

        for (let i = 0; i < n; ++i) {
            const angle = sweep * i / n;
            // The tread's centre, orbited to `angle` by the same rotation _pushBox applies to its corners.
            const centre: [number, number, number] = [
                mid * Math.cos(angle), -height / 2 + (i + 0.5) * rise, -mid * Math.sin(angle)];
            Geometry._pushBox(positions, normals, uvs, indices,
                centre, [radial, rise / 2, tread / 2], angle);
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Hollow open-top box — a room shell: a floor slab plus four walls of `thickness`, centred on the
     * origin. The walls stand ON the floor and the X walls are inset between the Z walls, so the pieces
     * meet face to face without interpenetrating. Coplanar contact faces are safe here because they carry
     * opposite normals: backface culling only ever draws one of the pair.
     */
    public static HollowBox(
        width: number = 1, height: number = 1, depth: number = 1, thickness: number = 0.1,
    ): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        // Clamped so an oversized thickness cannot invert a wall, which would flip its winding.
        const t = Math.max(1e-4, Math.min(thickness, Math.min(width, depth) / 2 - 1e-4, height - 1e-4));
        const w = width / 2, h = height / 2, d = depth / 2;
        const wallH = (height - t) / 2;
        const wallY = -h + t + wallH;
        const box = (centre: [number, number, number], half: [number, number, number]) =>
            Geometry._pushBox(positions, normals, uvs, indices, centre, half);

        box([0, -h + t / 2, 0], [w, t / 2, d]);                 // floor
        box([0, wallY, -d + t / 2], [w, wallH, t / 2]);          // -Z wall
        box([0, wallY, d - t / 2], [w, wallH, t / 2]);           // +Z wall
        box([-w + t / 2, wallY, 0], [t / 2, wallH, d - t]);      // -X wall, inset between the others
        box([w - t / 2, wallY, 0], [t / 2, wallH, d - t]);       // +X wall

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Hollow cylinder (pipe), Y-aligned and centred on the origin: an outer wall, an inward-facing inner
     * wall, and two annular caps. The caps are rings rather than discs, so unlike `Cylinder` there is no
     * centre vertex — there is no centre to have.
     */
    public static Tube(
        segments: number = 32, outerRadius: number = 0.5, innerRadius: number = 0.3, height: number = 1,
    ): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const seg = Math.max(3, Math.floor(segments));
        const outer = Math.max(outerRadius, innerRadius);
        // Kept strictly inside the outer wall: equal radii would collapse every cap quad to zero area.
        const inner = Math.max(1e-4, Math.min(innerRadius, outer - 1e-4));
        const hh = height / 2;
        const step = 2 * Math.PI / seg;

        for (let i = 0; i < seg; ++i) {
            const a0 = step * i, a1 = step * (i + 1);
            const c0 = Math.cos(a0), s0 = Math.sin(a0);
            const c1 = Math.cos(a1), s1 = Math.sin(a1);

            const oTop0: [number, number, number] = [c0 * outer, hh, s0 * outer];
            const oTop1: [number, number, number] = [c1 * outer, hh, s1 * outer];
            const oBot0: [number, number, number] = [c0 * outer, -hh, s0 * outer];
            const oBot1: [number, number, number] = [c1 * outer, -hh, s1 * outer];
            const iTop0: [number, number, number] = [c0 * inner, hh, s0 * inner];
            const iTop1: [number, number, number] = [c1 * inner, hh, s1 * inner];
            const iBot0: [number, number, number] = [c0 * inner, -hh, s0 * inner];
            const iBot1: [number, number, number] = [c1 * inner, -hh, s1 * inner];

            // Flat-shaded per segment: one normal at the segment's mid angle keeps each quad planar-exact.
            const am = (a0 + a1) / 2;
            const outN: [number, number, number] = [Math.cos(am), 0, Math.sin(am)];
            const inN: [number, number, number] = [-outN[0], 0, -outN[2]];

            Geometry._pushQuad(positions, normals, uvs, indices, oBot0, oTop0, oTop1, oBot1, outN);
            Geometry._pushQuad(positions, normals, uvs, indices, iBot1, iTop1, iTop0, iBot0, inN);
            Geometry._pushQuad(positions, normals, uvs, indices, iTop0, iTop1, oTop1, oTop0, [0, 1, 0]);
            Geometry._pushQuad(positions, normals, uvs, indices, oBot0, oBot1, iBot1, iBot0, [0, -1, 0]);
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    /**
     * Archway: an annular sector in the XY plane, extruded along Z. With the default half turn it is a
     * semicircular arch spanning `2 * radius` and rising `radius`.
     *
     * The AABB is re-centred on the origin like every other factory, so for a half turn the springing line
     * sits at `y = -radius / 2` rather than at y = 0.
     */
    public static Arch(
        segments: number = 24, radius: number = 0.5, thickness: number = 0.15,
        depth: number = 0.3, sweep: number = Math.PI,
    ): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const seg = Math.max(2, Math.floor(segments));
        const outer = radius;
        const band = Math.max(1e-4, Math.min(thickness, outer - 1e-4));
        const innerR = outer - band;
        const hd = depth / 2;
        // A half turn spans y in [0, outer]; shift so the bounds straddle the origin like the other shapes.
        const yShift = -outer / 2;
        const step = sweep / seg;
        const at = (r: number, a: number, z: number): [number, number, number] =>
            [Math.cos(a) * r, Math.sin(a) * r + yShift, z];

        for (let i = 0; i < seg; ++i) {
            const a0 = step * i, a1 = step * (i + 1);
            const am = (a0 + a1) / 2;
            const outN: [number, number, number] = [Math.cos(am), Math.sin(am), 0];
            const inN: [number, number, number] = [-outN[0], -outN[1], 0];

            Geometry._pushQuad(positions, normals, uvs, indices,
                at(outer, a0, -hd), at(outer, a1, -hd), at(outer, a1, hd), at(outer, a0, hd), outN);
            Geometry._pushQuad(positions, normals, uvs, indices,
                at(innerR, a1, -hd), at(innerR, a0, -hd), at(innerR, a0, hd), at(innerR, a1, hd), inN);
            Geometry._pushQuad(positions, normals, uvs, indices,
                at(outer, a0, hd), at(outer, a1, hd), at(innerR, a1, hd), at(innerR, a0, hd), [0, 0, 1]);
            Geometry._pushQuad(positions, normals, uvs, indices,
                at(innerR, a0, -hd), at(innerR, a1, -hd), at(outer, a1, -hd), at(outer, a0, -hd), [0, 0, -1]);
        }

        // The two cut ends. Their outward normals are tangential: -theta at the start, +theta at the end.
        const endN = (a: number, sign: number): [number, number, number] =>
            [Math.sin(a) * sign, -Math.cos(a) * sign, 0];
        Geometry._pushQuad(positions, normals, uvs, indices,
            at(innerR, 0, -hd), at(outer, 0, -hd), at(outer, 0, hd), at(innerR, 0, hd), endN(0, 1));
        Geometry._pushQuad(positions, normals, uvs, indices,
            at(outer, sweep, -hd), at(innerR, sweep, -hd), at(innerR, sweep, hd), at(outer, sweep, hd),
            endN(sweep, -1));

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    public static async Terrain(heightmapPath: string): Promise<Geometry> {
        // Imported lazily so this module stays a leaf. A top-level `import { Loader } from "../cleo"`
        // dragged the entire engine barrel in — including a circular dependency back to this file, and
        // every GLSL/WebGL module with it — purely for the one call below, which in turn made Geometry
        // impossible to unit-test without a GL context. `webpackMode: "eager"` keeps the module in the
        // single library bundle instead of emitting a lazily-fetched chunk.
        const { Loader } = await import(/* webpackMode: "eager" */ "../graphics/loader");

        return new Promise<Geometry>((resolve, reject) => {
            const positions: [number, number, number][] = [];
            const normals: [number, number, number][] = [];
            const uvs: [number, number][] = [];
            const indices: number[] = [];

            Loader.ImageToArray(heightmapPath).then((image: { data: Uint8Array, width: number, height: number }) => {
                const width = image.width;
                const height = image.height;
    
                const halfWidth = width / 2;
                const halfHeight = height / 2;
                let data = image.data;

                // calculate amplitude based on width and height of the image
                const amplitude = Math.sqrt(Math.max(width, height)) / 2;
    
                for (let i = 0; i <= width; i++) {
                    for (let j = 0; j <= height; j++) {
                        const x = -halfWidth + j;
                        const y = ((data[(i * height + j) * 4] / 255 ) * 2 - 1) * amplitude;
                        const z = halfHeight - i;
    
                        positions.push([x, y, z]);
                        uvs.push([j / height, i / width]);
                        // calculate normal
                        let normal = vec3.fromValues(0.0, 0.0, 0.0);
                        if (i > 0 && j > 0) {
                            const v1 = vec3.fromValues(positions[i * (height + 1) + j][0], positions[i * (height + 1) + j][1], positions[i * (height + 1) + j][2]);
                            const v2 = vec3.fromValues(positions[(i - 1) * (height + 1) + j][0], positions[(i - 1) * (height + 1) + j][1], positions[(i - 1) * (height + 1) + j][2]);
                            const v3 = vec3.fromValues(positions[i * (height + 1) + j - 1][0], positions[i * (height + 1) + j - 1][1], positions[i * (height + 1) + j - 1][2]);
                            const v4 = vec3.fromValues(positions[(i - 1) * (height + 1) + j - 1][0], positions[(i - 1) * (height + 1) + j - 1][1], positions[(i - 1) * (height + 1) + j - 1][2]);
                            const e1 = vec3.create();
                            const e2 = vec3.create();
                            const e3 = vec3.create();
                            const e4 = vec3.create();
                            vec3.sub(e1, v1, v2);
                            vec3.sub(e2, v1, v3);
                            vec3.sub(e3, v1, v4);
                            vec3.sub(e4, v2, v3);
                            const t1 = vec3.create();
                            const t2 = vec3.create();
                            const t3 = vec3.create();
                            const t4 = vec3.create();
                            vec3.cross(t1, e1, e2);
                            vec3.cross(t2, e1, e3);
                            vec3.cross(t3, e1, e4);
                            vec3.cross(t4, e2, e3);
                            vec3.add(normal, normal, t1);
                            vec3.add(normal, normal, t2);
                            vec3.add(normal, normal, t3);
                            vec3.add(normal, normal, t4);
                            vec3.normalize(normal, normal);
                            vec3.scale(normal, normal, -1.0);
                        }
                        normals.push([normal[0], normal[1], normal[2]]);
                    }
                }
    
                for (let i = 0; i < width - 1; i++) {
                    for (let j = 0; j < height - 1; j++) {
                        const topLeft = i * (height + 1) + j;
                        const topRight = topLeft + 1;
                        const bottomLeft = (i + 1) * (height + 1) + j;
                        const bottomRight = bottomLeft + 1;
                
                        // Change the order of indices to create triangles in a counter-clockwise direction
                        indices.push(topLeft, topRight, bottomLeft);
                        indices.push(topRight, bottomRight, bottomLeft);
                    }
                }
    
                resolve(new Geometry(positions, normals, uvs, [], [], indices));
            }
            ).catch((error: unknown) => {
                reject(error);
            });
        });
    }
}