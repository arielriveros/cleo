/**
 * CPU half of compute-shader tessellation: the pieces the dispatch cannot derive for itself.
 *
 * The GPU generates every displaced VERTEX implicitly — a compute invocation turns its own
 * `global_invocation_id` into `(triangle, i, j)` on a barycentric grid, so there is no per-vertex
 * topology buffer at all. Two things it cannot work out on its own live here:
 *
 *  - the INDEX pattern, which is the same for every triangle and is built once (see {@link buildTessIndices});
 *  - the per-base-vertex DISPLACEMENT ATTRIBUTES, which need to be shared across a uv seam and so need
 *    the position grouping only the CPU has (see {@link buildDisplaceAttributes}).
 *
 * WHY NO DEDUPLICATION, and why that is still watertight. Adjacent output triangles are not welded to
 * each other, and do not need to be: two input triangles sharing an edge generate the SAME barycentric
 * samples along it, and every term the displacement depends on is interpolated from the two shared
 * endpoint vertices. Both copies therefore land on the same displaced point. It is the same reason
 * hardware tessellation is crack-free when the edge factors match, and it is what lets this skip the
 * edge-keyed midpoint map a CPU subdivider would need.
 */

/** Segments per triangle edge at subdivision level `level`. Level 0 is the mesh as authored. */
export function tessSegments(level: number): number {
    return 1 << Math.max(0, Math.min(MAX_TESS_LEVEL, Math.floor(level)));
}

/**
 * Ceiling on the subdivision level, and it is a memory bound rather than an arithmetic one.
 *
 * Each input triangle becomes `4^level` triangles: on the 3941-triangle scan this exists for, level 4
 * is 1.01M triangles and 33.8 MB of vertex data for ONE model. Level 5 would be 135 MB, which is not a
 * setting anyone should reach for by accident.
 */
export const MAX_TESS_LEVEL = 4;

/**
 * Vertices one input triangle expands to: the triangular number `(n+1)(n+2)/2`.
 *
 * The grid is barycentric — rows `j = 0..n`, and row `j` holds `n - j + 1` samples — so this is not
 * `(n+1)^2`. At level 3 (`n = 8`) it is 45 vertices and 64 triangles per input triangle.
 */
export function tessVertsPerTri(segments: number): number {
    const n = Math.max(1, segments);
    return ((n + 1) * (n + 2)) / 2;
}

/** Triangles one input triangle expands to: `n^2`. */
export function tessTrisPerTri(segments: number): number {
    const n = Math.max(1, segments);
    return n * n;
}

/**
 * Slot of the barycentric sample at row `j`, column `i`, within one triangle's block.
 *
 * Rows are laid out longest-first (`j = 0` has `n + 1` samples), so the offset of row `j` is the sum of
 * the rows above it. The compute shader inverts this from its invocation id; keeping the forward
 * mapping here is what lets a test pin the two against each other.
 */
export function tessSlot(segments: number, i: number, j: number): number {
    const n = Math.max(1, segments);
    // Sum of (n+1) + n + ... + (n-j+2) — the rows before this one.
    return (j * (2 * n + 3 - j)) / 2 + i;
}

/**
 * The index buffer for a tessellated mesh: the same grid pattern repeated per input triangle.
 *
 * Two triangles per grid cell, except the last column of each row which has only the upward one. Winding
 * follows the input triangle's, because every output vertex is a positive barycentric combination of its
 * corners — so a mesh that was front-facing stays front-facing and `side: 'front'` materials do not
 * silently flip.
 *
 * `Uint32Array` unconditionally: at level 3 a 3941-triangle mesh has 177k vertices, well past what
 * `uint16` addresses, and choosing per-mesh would only save memory on inputs small enough not to care.
 */
export function buildTessIndices(triangleCount: number, segments: number): Uint32Array {
    const n = Math.max(1, segments);
    const perTri = tessTrisPerTri(n);
    const vertsPerTri = tessVertsPerTri(n);
    const out = new Uint32Array(triangleCount * perTri * 3);

    let o = 0;
    for (let t = 0; t < triangleCount; t++) {
        const base = t * vertsPerTri;
        for (let j = 0; j < n; j++) {
            const rowLen = n - j;
            for (let i = 0; i < rowLen; i++) {
                // Upward triangle: (i,j) (i+1,j) (i,j+1)
                out[o++] = base + tessSlot(n, i, j);
                out[o++] = base + tessSlot(n, i + 1, j);
                out[o++] = base + tessSlot(n, i, j + 1);
                // Downward triangle, absent on the last column of the row.
                if (i < rowLen - 1) {
                    out[o++] = base + tessSlot(n, i + 1, j);
                    out[o++] = base + tessSlot(n, i + 1, j + 1);
                    out[o++] = base + tessSlot(n, i, j + 1);
                }
            }
        }
    }
    return out;
}

/** Floats per base vertex in the buffer {@link buildDisplaceAttributes} produces: `uv` then `normal`. */
export const DISPLACE_ATTRIB_STRIDE = 5;

/**
 * Kept at 180 — every vertex at a position is one cluster — and that is a REVERT, not a default.
 *
 * Splitting at a crease was tried, for a real reason (see {@link buildDisplaceAttributes}), and it tore
 * the mesh apart: "the mesh triangles now float". A displaced surface is crack-free only if every vertex
 * at a shared position lands on the SAME point, which needs the same direction AND the same magnitude —
 * so any split at all opens the edge between the two sides, by an amount proportional to the depth.
 * That is why hard-edged meshes are not displaced in production pipelines; UE's "crack free
 * displacement" fixes uv seams and does not attempt hard edges either.
 *
 * The parameter stays so the trade is visible and testable rather than buried, but nothing should lower
 * it without a plan for the cracks.
 */
export const DISPLACE_CREASE_DEG = 180;

/**
 * Per-base-vertex displacement uv and normal, shared across a UV SEAM but NOT across a HARD EDGE.
 *
 * A uv seam splits a vertex for texturing reasons only: the copies sit at one position, carry the same
 * normal, and differ solely in uv. Left alone they sample different heights and move apart, and 36.3%
 * of the positions on the scan this was written for are seams, so the tear would be everywhere. Both
 * halves of the displacement have to agree there — the MAGNITUDE, via one "dominant" uv (Maya's
 * "dominant UVs", UE's "crack free displacement"), and the DIRECTION, via one averaged normal.
 *
 * THE CREASE TEST, AND WHY IT IS OFF. Grouping by position alone also merges vertices that are
 * genuinely different surface points: three faces meet at a cube's corner with perpendicular normals
 * and three unrelated uv charts, and merged they take one arbitrary uv and a normal averaged down the
 * corner diagonal. So `creaseDeg` was lowered to 45 to split them — and the mesh came apart, because
 * **crack-free requires that every vertex at a position land on the SAME point**, which needs the same
 * direction and the same magnitude. Any split opens the edge between the two sides, proportionally to
 * the depth. Reverted; the parameter survives so the trade stays testable.
 *
 * What that costs is real and worth stating: on a HARD-EDGED mesh a face's corners resolve to uvs from
 * neighbouring faces, so the face samples a scrambled or near-constant height and shows little relief.
 * That is not repairable here — it is why displaced meshes in production pipelines have smooth normals,
 * and why this works on scans, spheres and capsules and not on blockout primitives.
 *
 * Positions are keyed exactly. The splits this has to find are duplicates of one authored vertex, so
 * their coordinates are bit-identical; a tolerance would instead weld genuinely distinct vertices on a
 * dense scan, which is a worse failure and a silent one.
 */
export function buildDisplaceAttributes(
    positions: Float32Array, uvs: Float32Array, normals: Float32Array,
    creaseDeg: number = DISPLACE_CREASE_DEG,
): Float32Array {
    const count = Math.floor(positions.length / 3);
    const out = new Float32Array(count * DISPLACE_ATTRIB_STRIDE);
    if (count === 0) return out;

    const hasUvs = uvs.length >= count * 2;
    const hasNormals = normals.length >= count * 3;

    const atPosition = new Map<string, number[]>();
    for (let v = 0; v < count; v++) {
        const p = v * 3;
        const key = `${positions[p]},${positions[p + 1]},${positions[p + 2]}`;
        const bucket = atPosition.get(key);
        if (bucket) bucket.push(v); else atPosition.set(key, [v]);
    }

    const cosCrease = Math.cos(Math.max(0, Math.min(180, creaseDeg)) * Math.PI / 180);
    const normalOf = (v: number): [number, number, number] => hasNormals
        ? [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]]
        : [0, 1, 0];

    for (const bucket of atPosition.values()) {
        for (const v of bucket) {
            // Everything at this position that agrees with THIS vertex about which way the surface
            // faces. One cluster across a uv seam; one per face at a cube's corner.
            const [vx, vy, vz] = normalOf(v);
            const vLen = Math.hypot(vx, vy, vz) || 1;
            const cluster: number[] = [];
            for (const w of bucket) {
                const [wx, wy, wz] = normalOf(w);
                const wLen = Math.hypot(wx, wy, wz) || 1;
                if ((vx * wx + vy * wy + vz * wz) / (vLen * wLen) >= cosCrease) cluster.push(w);
            }

            // Lowest index in the CLUSTER wins the uv — deterministic, and stable across a re-import.
            const dominant = cluster[0];
            const u = hasUvs ? uvs[dominant * 2] : 0;
            const uw = hasUvs ? uvs[dominant * 2 + 1] : 0;

            let nx = 0, ny = 0, nz = 0;
            for (const w of cluster) {
                const [wx, wy, wz] = normalOf(w);
                nx += wx; ny += wy; nz += wz;
            }
            const len = Math.hypot(nx, ny, nz);
            // A cluster whose normals cancel: fall back to this vertex's own, then to any unit vector.
            if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
            else if (vLen > 1e-12) { nx = vx / vLen; ny = vy / vLen; nz = vz / vLen; }
            else { nx = 0; ny = 1; nz = 0; }

            const o = v * DISPLACE_ATTRIB_STRIDE;
            out[o] = u; out[o + 1] = uw;
            out[o + 2] = nx; out[o + 3] = ny; out[o + 4] = nz;
        }
    }
    return out;
}

/** Floats per vertex in `MODEL_VERTEX_LAYOUT`: position 3, normal 3, uv 2, tangent 3, bitangent 3. */
export const MODEL_VERTEX_FLOATS = 14;

/**
 * Levels of subdivision to spend on the CPU BEFORE the dispatch, so a coarse mesh gets a real uv chart.
 *
 * Reported as "on cubes the displacement is done to the undivided triangle faces". The cause is the
 * dominant-uv merge in {@link buildDisplaceAttributes}: three faces meet at a cube's corner, they must
 * share one uv to stay crack-free, and on a 2-triangle face EVERY vertex is such a corner — so the whole
 * face interpolates between uvs belonging to its neighbours and the relief across it is meaningless.
 * The tessellator cannot repair this, because it only ever interpolates the base corners it is given.
 *
 * Subdividing FIRST, while the true per-face uvs are still intact, creates interior vertices that no
 * other face touches. Only the ring on the shared cube EDGES is still merged, which is unavoidable and
 * is what a properly modelled subdivided cube would also do.
 *
 * Spent out of the user's level rather than on top of it, so the output triangle count is unchanged:
 * `4^pre * 4^(level-pre) = 4^level` exactly. And only for meshes coarse enough to have the problem —
 * a sphere or a scan gets 0 and takes a byte-identical path to before.
 */
export const PRESUBDIVIDE_MIN_TRIANGLES = 256;

/** @see PRESUBDIVIDE_MIN_TRIANGLES */
export function presubdivideLevels(triangleCount: number, level: number): number {
    let pre = 0;
    const cap = Math.min(level, 2);
    while (pre < cap && triangleCount * Math.pow(4, pre) < PRESUBDIVIDE_MIN_TRIANGLES) pre++;
    return pre;
}

/** A base mesh ready for the dispatch: interleaved vertices plus the loose arrays the seam pass needs. */
export interface DisplaceBase {
    vertices: Float32Array;
    indices: Uint32Array;
    positions: Float32Array;
    uvs: Float32Array;
    normals: Float32Array;
    triangleCount: number;
}

/**
 * Subdivide a mesh on the CPU, interpolating only — no displacement, no smoothing, no welding.
 *
 * The same barycentric grid the dispatch uses, so `buildTessIndices` describes the result unchanged and
 * the two stay watertight for the same reason: adjacent triangles generate identical samples along a
 * shared edge, and every attribute there is interpolated from the two shared endpoints.
 *
 * Deliberately does NOT deduplicate. The coincident copies along a shared edge are what
 * {@link buildDisplaceAttributes} then groups by position, which is where crack-freeness comes from.
 */
export function presubdivideBase(
    positions: Float32Array, normals: Float32Array, uvs: Float32Array,
    tangents: Float32Array, bitangents: Float32Array, indices: Uint32Array, levels: number,
): DisplaceBase {
    const n = tessSegments(levels);
    const triangleCount = Math.floor(indices.length / 3);
    const perTri = tessVertsPerTri(n);
    const count = triangleCount * perTri;

    const outVerts = new Float32Array(count * MODEL_VERTEX_FLOATS);
    const outPos = new Float32Array(count * 3);
    const outUv = new Float32Array(count * 2);
    const outNrm = new Float32Array(count * 3);

    // Renormalised after interpolation: three unit vectors averaged are shorter than one, and a zero
    // would become a NaN direction the moment anything divides by it.
    const unit = (a: Float32Array, o: number) => {
        const l = Math.hypot(a[o], a[o + 1], a[o + 2]);
        if (l > 1e-12) { a[o] /= l; a[o + 1] /= l; a[o + 2] /= l; }
    };

    for (let t = 0; t < triangleCount; t++) {
        const c = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
        const base = t * perTri;
        for (let j = 0; j <= n; j++) {
            for (let i = 0; i + j <= n; i++) {
                // The dispatch's own convention: w1 from the column, w2 from the row.
                const w = [1 - i / n - j / n, i / n, j / n];
                const v = base + tessSlot(n, i, j);
                const o = v * MODEL_VERTEX_FLOATS;
                for (let k = 0; k < 3; k++) {
                    const src = c[k] * 3, su = c[k] * 2, wk = w[k];
                    for (let d = 0; d < 3; d++) {
                        outVerts[o + d] += positions[src + d] * wk;
                        outVerts[o + 3 + d] += (normals[src + d] ?? 0) * wk;
                        outVerts[o + 8 + d] += (tangents[src + d] ?? 0) * wk;
                        outVerts[o + 11 + d] += (bitangents[src + d] ?? 0) * wk;
                    }
                    outVerts[o + 6] += (uvs[su] ?? 0) * wk;
                    outVerts[o + 7] += (uvs[su + 1] ?? 0) * wk;
                }
                unit(outVerts, o + 3); unit(outVerts, o + 8); unit(outVerts, o + 11);

                outPos[v * 3] = outVerts[o]; outPos[v * 3 + 1] = outVerts[o + 1];
                outPos[v * 3 + 2] = outVerts[o + 2];
                outNrm[v * 3] = outVerts[o + 3]; outNrm[v * 3 + 1] = outVerts[o + 4];
                outNrm[v * 3 + 2] = outVerts[o + 5];
                outUv[v * 2] = outVerts[o + 6]; outUv[v * 2 + 1] = outVerts[o + 7];
            }
        }
    }

    return {
        vertices: outVerts, indices: buildTessIndices(triangleCount, n),
        positions: outPos, uvs: outUv, normals: outNrm,
        triangleCount: triangleCount * tessTrisPerTri(n),
    };
}

/** Vertices, triangles and vertex bytes a mesh expands to — for the editor's readout and for sizing. */
export function tessBudget(triangleCount: number, segments: number, vertexFloats: number) {
    const vertices = triangleCount * tessVertsPerTri(segments);
    return {
        vertices,
        triangles: triangleCount * tessTrisPerTri(segments),
        vertexBytes: vertices * vertexFloats * 4,
        indexBytes: triangleCount * tessTrisPerTri(segments) * 3 * 4,
    };
}
