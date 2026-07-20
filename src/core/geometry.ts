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

    public static Circle(diameter: number = 1, segments: number = 32): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const angle = 2 * Math.PI / segments;
        const radius = diameter / 2;

        for (let i = 0; i <= segments; i++) {
            const x = radius * Math.cos(angle * i);
            const y = radius * Math.sin(angle * i);

            positions.push([x, y, 0.0]);
            normals.push([0.0, 0.0, 1.0]);
            uvs.push([0.5 + x / radius / 2, 0.5 + y / radius / 2]);

            indices.push(0);
            indices.push(i + 1);
            indices.push(i + 2);
        }

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

        // top vertices
        const angle = 2 * Math.PI / segments;
        for (let i = 0; i <= segments; i++) {
            const x = radius * Math.cos(angle * i);
            const y = halfHeight;
            const z = radius * Math.sin(angle * i);

            positions.push([x, y, z]);
            normals.push([0.0, 1.0, 0.0]);
            uvs.push([0.5 + x / radius / 2, 0.5 + z / radius / 2]);
        }

        // top indices
        for (let i = 0; i < segments; i++) {
            indices.push(positions.length - 1);
            indices.push(positions.length - i - 2);
            indices.push(positions.length - i - 3);
        }

        // bottom vertices
        for (let i = 0; i <= segments; i++) {
            const x = radius * Math.cos(angle * i);
            const y = -halfHeight;
            const z = radius * Math.sin(angle * i);

            positions.push([x, y, z]);
            normals.push([0.0, -1.0, 0.0]);
            uvs.push([0.5 + x / radius / 2, 0.5 + z / radius / 2]);
        }

        // bottom indices
        for (let i = 0; i < segments; i++) {
            indices.push(positions.length - 1);
            indices.push(positions.length - i - 3);
            indices.push(positions.length - i - 2);
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