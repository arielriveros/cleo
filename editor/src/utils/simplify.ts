// Mesh decimation for LOD generation: quadric error metrics (Garland-Heckbert) edge collapse.
//
// Deliberately written against PLAIN TYPED ARRAYS rather than `Geometry`: no GL, no DOM and no `cleo`
// import, so it can run inside projectWorker.ts ("pure data work only") on a mesh heavy enough that
// doing it on the main thread would freeze the editor. `Geometry` wrapping happens at the call site.
//
// It lives in the EDITOR rather than the engine because it is an authoring-time tool — nothing at
// runtime decimates — and because the editor's babel config is package-scoped, so a worker module here
// cannot compile a file from the engine's source tree anyway.
//
// Every invariant this has to hold fails SILENTLY downstream, which is why they are stated here and
// pinned in editor/tests/geometrySimplify.test.ts:
//
//   - the output carries exactly the input's set of non-empty attributes, each exactly
//     `vertexCount * stride` long. `getData` drops an empty attribute and changes the interleaved
//     stride while the VAO keeps the shader's — scrambled vertices, no error;
//   - every index is < vertexCount. A Uint32Array bypasses createIndexArray's validation entirely;
//   - no triangle flips its winding. A flipped triangle passes count, bounds and normal-length checks
//     and renders as a hole under backface culling;
//   - submesh ranges stay parallel to the caller's materials, tile ascending, and each count is a
//     multiple of 3.

/** One slice of the index buffer, drawn with its own material. Mirrors `Submesh` in graphics/model.ts. */
export interface SimplifyRange {
    start: number;
    count: number;
}

/** A geometry's buffers. Attribute strides: 3 for everything except `uvs`, which is 2. */
export interface SimplifyBuffers {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    tangents: Float32Array;
    bitangents: Float32Array;
    indices: Uint32Array;
    /** Absent or a single range = one whole-buffer draw. */
    submeshes?: SimplifyRange[];
}

/**
 * Fraction of the bounding diagonal within which two positions are the SAME surface point.
 *
 * This is a topology decision, not an attribute one: an imported mesh splits vertices per uv island and
 * per hard crease, so one surface point is routinely several vertices. Welding them for the collapse is
 * what lets the surface simplify at all; the attribute vertices stay separate, which is what keeps the
 * seam intact.
 */
const WELD_EPSILON = 1e-5;

/**
 * How hard a boundary edge resists being moved off its own line, relative to a surface plane.
 *
 * Open edges are NOT pinned. Pinning them is the obvious way to protect a silhouette and it is wrong for
 * exactly the meshes this exists for: every edge of a foliage leaf card is a boundary, so pinning would
 * freeze the whole leaf submesh and reduce nothing. Instead each boundary edge contributes a constraint
 * plane perpendicular to its face, so a boundary vertex may slide ALONG the border but pays heavily to
 * leave it — the standard Garland-Heckbert boundary term.
 */
const BOUNDARY_WEIGHT = 1000;

/**
 * Reduce `input` to roughly `targetRatio` of its triangles.
 *
 * Returns the input untouched when there is nothing to do (ratio >= 1, or no triangles). The returned
 * `submeshes` array is **parallel to the input's**, including ranges that decimated to `count: 0` — the
 * caller must drop those together with their material, because a `Model` whose submesh and material
 * counts disagree silently discards the whole submesh list and draws everything with `materials[0]`.
 */
export function simplify(input: SimplifyBuffers, targetRatio: number): SimplifyBuffers {
    const triCount = Math.floor(input.indices.length / 3);
    const vertexCount = Math.floor(input.positions.length / 3);
    if (triCount === 0 || vertexCount === 0) return input;
    if (!(targetRatio < 1)) return input;
    const ratio = Math.max(0, targetRatio);

    const P = input.positions;

    // ---- 1. Weld topology by quantised position ----------------------------------------------------
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const inv = 1 / (diag * WELD_EPSILON);

    const topoOf = new Uint32Array(vertexCount);
    const tx: number[] = [], ty: number[] = [], tz: number[] = [];
    // Weld scratch. Declared `let` so it can be released the moment the weld is done — held to the end of
    // the call it is tens of MB of quantised coordinates and one JS array per bucket, all dead.
    let qx: number[] | null = [], qy: number[] | null = [], qz: number[] | null = [];
    // Numeric hash buckets rather than string keys: one string per vertex is a real cost on the meshes
    // this exists for, and the quantised triple is compared exactly inside the bucket anyway.
    let buckets: Map<number, number[]> | null = new Map<number, number[]>();
    for (let i = 0; i < vertexCount; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const ix = Math.round(x * inv), iy = Math.round(y * inv), iz = Math.round(z * inv);
        const h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0;
        let bucket = buckets.get(h);
        let found = -1;
        if (bucket) {
            for (const t of bucket) if (qx[t] === ix && qy[t] === iy && qz[t] === iz) { found = t; break }
        } else {
            bucket = [];
            buckets.set(h, bucket);
        }
        if (found < 0) {
            found = tx.length;
            tx.push(x); ty.push(y); tz.push(z);
            qx.push(ix); qy.push(iy); qz.push(iz);
            bucket.push(found);
        }
        topoOf[i] = found;
    }
    const topoCount = tx.length;
    qx = null; qy = null; qz = null; buckets = null;

    // ---- 2. Triangles, in topology space and attribute space ---------------------------------------
    const ranges: SimplifyRange[] = input.submeshes?.length
        ? input.submeshes
        : [{ start: 0, count: input.indices.length }];

    const triTopo = new Uint32Array(triCount * 3);
    const triAttr = new Uint32Array(triCount * 3);
    const triSub = new Uint32Array(triCount);
    const alive = new Uint8Array(triCount);

    for (let s = 0; s < ranges.length; s++) {
        const start = ranges[s].start, end = start + ranges[s].count;
        for (let i = start; i + 2 < end; i += 3) {
            const t = Math.floor(i / 3);
            if (t < triCount) triSub[t] = s;
        }
    }
    let aliveTris = 0;
    const subAlive = new Uint32Array(ranges.length);
    for (let t = 0; t < triCount; t++) {
        const a = input.indices[t * 3], b = input.indices[t * 3 + 1], c = input.indices[t * 3 + 2];
        const ta = topoOf[a], tb = topoOf[b], tc = topoOf[c];
        triAttr[t * 3] = a; triAttr[t * 3 + 1] = b; triAttr[t * 3 + 2] = c;
        triTopo[t * 3] = ta; triTopo[t * 3 + 1] = tb; triTopo[t * 3 + 2] = tc;
        // A triangle whose corners weld together has no area and no normal; it is already dead.
        if (ta === tb || tb === tc || ta === tc) continue;
        alive[t] = 1;
        aliveTris++;
        subAlive[triSub[t]]++;
    }
    if (aliveTris === 0) return input;

    // ---- 3. Adjacency, and what must never move ----------------------------------------------------
    const vertTris: number[][] = new Array(topoCount);
    for (let v = 0; v < topoCount; v++) vertTris[v] = [];
    const locked = new Uint8Array(topoCount);
    const vertSub = new Int32Array(topoCount).fill(-1);

    for (let t = 0; t < triCount; t++) {
        if (!alive[t]) continue;
        const s = triSub[t];
        for (let k = 0; k < 3; k++) {
            const v = triTopo[t * 3 + k];
            vertTris[v].push(t);
            // A vertex shared by two submeshes may not move: a collapse across the boundary would change
            // which material draws that surface, and a triangle cannot belong to two ranges.
            if (vertSub[v] === -1) vertSub[v] = s;
            else if (vertSub[v] !== s) locked[v] = 1;
        }
    }

    // Edges with anything other than two adjacent faces are boundaries or non-manifold seams. They are
    // constrained below via BOUNDARY_WEIGHT rather than locked; see that constant.
    let edgeFaces: Map<number, number> | null = new Map<number, number>();
    const edgeKey = (a: number, b: number) => (a < b ? a * topoCount + b : b * topoCount + a);
    for (let t = 0; t < triCount; t++) {
        if (!alive[t]) continue;
        for (let k = 0; k < 3; k++) {
            const key = edgeKey(triTopo[t * 3 + k], triTopo[t * 3 + ((k + 1) % 3)]);
            edgeFaces.set(key, (edgeFaces.get(key) ?? 0) + 1);
        }
    }
    // ---- 4. Quadrics -------------------------------------------------------------------------------
    // 10 upper-triangular coefficients of the symmetric 4x4: a2 ab ac ad b2 bc bd c2 cd d2.
    const Q = new Float64Array(topoCount * 10);
    const addPlane = (v: number, a: number, b: number, c: number, d: number) => {
        const o = v * 10;
        Q[o] += a * a; Q[o + 1] += a * b; Q[o + 2] += a * c; Q[o + 3] += a * d;
        Q[o + 4] += b * b; Q[o + 5] += b * c; Q[o + 6] += b * d;
        Q[o + 7] += c * c; Q[o + 8] += c * d;
        Q[o + 9] += d * d;
    };
    const n3: number[] = [0, 0, 0];
    // Cached face normal + length per triangle. `wouldFlip` reads the BEFORE normal of every triangle
    // around a candidate edge, on every candidate it examines — recomputing it there was the single
    // biggest time sink in the whole decimator. Invalidated for the affected triangles on each collapse.
    const faceN = new Float64Array(triCount * 3);
    const faceLen = new Float64Array(triCount).fill(-1);
    const computeFaceNormal = (t: number, out: number[]): number => {
        const a = triTopo[t * 3], b = triTopo[t * 3 + 1], c = triTopo[t * 3 + 2];
        const ux = tx[b] - tx[a], uy = ty[b] - ty[a], uz = tz[b] - tz[a];
        const vx = tx[c] - tx[a], vy = ty[c] - ty[a], vz = tz[c] - tz[a];
        out[0] = uy * vz - uz * vy;
        out[1] = uz * vx - ux * vz;
        out[2] = ux * vy - uy * vx;
        return Math.hypot(out[0], out[1], out[2]);
    };
    const faceNormal = (t: number, out: number[]): number => {
        if (faceLen[t] < 0) {
            faceLen[t] = computeFaceNormal(t, out);
            faceN[t * 3] = out[0]; faceN[t * 3 + 1] = out[1]; faceN[t * 3 + 2] = out[2];
            return faceLen[t];
        }
        out[0] = faceN[t * 3]; out[1] = faceN[t * 3 + 1]; out[2] = faceN[t * 3 + 2];
        return faceLen[t];
    };
    for (let t = 0; t < triCount; t++) {
        if (!alive[t]) continue;
        const len = faceNormal(t, n3);
        if (len <= 1e-20) { alive[t] = 0; aliveTris--; subAlive[triSub[t]]--; continue }
        const a = n3[0] / len, b = n3[1] / len, c = n3[2] / len;
        const v0 = triTopo[t * 3];
        const d = -(a * tx[v0] + b * ty[v0] + c * tz[v0]);
        addPlane(triTopo[t * 3], a, b, c, d);
        addPlane(triTopo[t * 3 + 1], a, b, c, d);
        addPlane(triTopo[t * 3 + 2], a, b, c, d);
    }

    // Boundary term: for every edge without exactly two faces, a plane through the edge PERPENDICULAR to
    // its face, weighted so leaving the border costs far more than sliding along it. This is what lets an
    // open shell — a leaf card, a cloth strip — simplify at all while keeping its outline.
    for (let t = 0; t < triCount; t++) {
        if (!alive[t]) continue;
        const len = faceNormal(t, n3);
        if (len <= 1e-20) continue;
        const fx = n3[0] / len, fy = n3[1] / len, fz = n3[2] / len;
        for (let k = 0; k < 3; k++) {
            const a = triTopo[t * 3 + k], b = triTopo[t * 3 + ((k + 1) % 3)];
            if (edgeFaces.get(edgeKey(a, b)) === 2) continue;
            const ex = tx[b] - tx[a], ey = ty[b] - ty[a], ez = tz[b] - tz[a];
            // edge x faceNormal: perpendicular to the border, lying in the surface.
            let px = ey * fz - ez * fy, py = ez * fx - ex * fz, pz = ex * fy - ey * fx;
            const plen = Math.hypot(px, py, pz);
            if (plen <= 1e-20) continue;
            px /= plen; py /= plen; pz /= plen;
            const d = -(px * tx[a] + py * ty[a] + pz * tz[a]);
            addPlane(a, px * BOUNDARY_WEIGHT, py * BOUNDARY_WEIGHT, pz * BOUNDARY_WEIGHT, d * BOUNDARY_WEIGHT);
            addPlane(b, px * BOUNDARY_WEIGHT, py * BOUNDARY_WEIGHT, pz * BOUNDARY_WEIGHT, d * BOUNDARY_WEIGHT);
        }
    }

    edgeFaces = null; // the boundary term above was its last reader

    /** v^T (Qa + Qb) v — the squared distance to the planes both endpoints came from. */
    const errorAt = (va: number, vb: number, x: number, y: number, z: number): number => {
        const oa = va * 10, ob = vb * 10;
        const a2 = Q[oa] + Q[ob], ab = Q[oa + 1] + Q[ob + 1], ac = Q[oa + 2] + Q[ob + 2], ad = Q[oa + 3] + Q[ob + 3];
        const b2 = Q[oa + 4] + Q[ob + 4], bc = Q[oa + 5] + Q[ob + 5], bd = Q[oa + 6] + Q[ob + 6];
        const c2 = Q[oa + 7] + Q[ob + 7], cd = Q[oa + 8] + Q[ob + 8], d2 = Q[oa + 9] + Q[ob + 9];
        return a2 * x * x + 2 * ab * x * y + 2 * ac * x * z + 2 * ad * x
            + b2 * y * y + 2 * bc * y * z + 2 * bd * y
            + c2 * z * z + 2 * cd * z
            + d2;
    };

    /**
     * The position that minimises the combined quadric: the solve when it is well conditioned, otherwise
     * the cheapest of the two endpoints and the midpoint.
     *
     * The fallback alone is not good enough, and the failure is quiet. On a curved surface the midpoint
     * of a chord lies INSIDE the surface, so collapsing to endpoints-or-midpoint shrinks the model as it
     * simplifies — a cylinder halved lost a third of its volume, closed and correctly wound the whole
     * time. The solve keeps the new vertex on the surface the planes describe. It is skipped where the
     * 3x3 is near-singular, which is any flat or symmetric neighbourhood.
     */
    const bestPosition = (va: number, vb: number, out: number[]): number => {
        const oa = va * 10, ob = vb * 10;
        const a2 = Q[oa] + Q[ob], ab = Q[oa + 1] + Q[ob + 1], ac = Q[oa + 2] + Q[ob + 2], ad = Q[oa + 3] + Q[ob + 3];
        const b2 = Q[oa + 4] + Q[ob + 4], bc = Q[oa + 5] + Q[ob + 5], bd = Q[oa + 6] + Q[ob + 6];
        const c2 = Q[oa + 7] + Q[ob + 7], cd = Q[oa + 8] + Q[ob + 8];

        // det of [[a2 ab ac],[ab b2 bc],[ac bc c2]]
        const det = a2 * (b2 * c2 - bc * bc) - ab * (ab * c2 - bc * ac) + ac * (ab * bc - b2 * ac);
        // Scale-relative threshold: an absolute one would reject every small mesh and accept every large
        // one, and this runs on models of any size.
        const scale = Math.abs(a2) + Math.abs(b2) + Math.abs(c2) + 1e-30;
        if (Math.abs(det) > 1e-8 * scale * scale * scale) {
            const inv = 1 / det;
            const rx = -ad, ry = -bd, rz = -cd;
            const x = inv * (rx * (b2 * c2 - bc * bc) + ry * (ac * bc - ab * c2) + rz * (ab * bc - ac * b2));
            const y = inv * (rx * (bc * ac - ab * c2) + ry * (a2 * c2 - ac * ac) + rz * (ac * ab - a2 * bc));
            const z = inv * (rx * (ab * bc - b2 * ac) + ry * (ab * ac - a2 * bc) + rz * (a2 * b2 - ab * ab));
            // The solve is only trustworthy near the edge it came from. An ill-conditioned quadric can
            // put the minimum far off the surface, which shows up as a level whose bounds EXCEED level
            // 0's — and LodGroupNode culls the whole group off level 0's sphere, so that level pops.
            // Reject rather than clamp: a clamped point is not the minimiser of anything.
            const ex = tx[vb] - tx[va], ey = ty[vb] - ty[va], ez = tz[vb] - tz[va];
            const reach = Math.hypot(ex, ey, ez) + 1e-12;
            const mx = (tx[va] + tx[vb]) * 0.5, my = (ty[va] + ty[vb]) * 0.5, mz = (tz[va] + tz[vb]) * 0.5;
            const strayed = Math.hypot(x - mx, y - my, z - mz) > reach;
            const outside = x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ;
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && !strayed && !outside) {
                out[0] = x; out[1] = y; out[2] = z;
                return errorAt(va, vb, x, y, z);
            }
        }

        const cx = (tx[va] + tx[vb]) * 0.5, cy = (ty[va] + ty[vb]) * 0.5, cz = (tz[va] + tz[vb]) * 0.5;
        let bestErr = errorAt(va, vb, tx[va], ty[va], tz[va]);
        out[0] = tx[va]; out[1] = ty[va]; out[2] = tz[va];
        const eb = errorAt(va, vb, tx[vb], ty[vb], tz[vb]);
        if (eb < bestErr) { bestErr = eb; out[0] = tx[vb]; out[1] = ty[vb]; out[2] = tz[vb] }
        const em = errorAt(va, vb, cx, cy, cz);
        if (em < bestErr) { bestErr = em; out[0] = cx; out[1] = cy; out[2] = cz }
        return bestErr;
    };

    // ---- 5. Collapse ------------------------------------------------------------------------------
    const dead = new Uint8Array(topoCount);
    const version = new Uint32Array(topoCount);
    const collapsedTo = new Int32Array(topoCount).fill(-1);

    interface Entry { cost: number; a: number; b: number; va: number; vb: number }
    const heap: Entry[] = [];
    const push = (e: Entry) => {
        heap.push(e);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p].cost <= heap[i].cost) break;
            const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp;
            i = p;
        }
    };
    const pop = (): Entry | undefined => {
        if (heap.length === 0) return undefined;
        const top = heap[0];
        const last = heap.pop() as Entry;
        if (heap.length) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let m = i;
                if (l < heap.length && heap[l].cost < heap[m].cost) m = l;
                if (r < heap.length && heap[r].cost < heap[m].cost) m = r;
                if (m === i) break;
                const tmp = heap[m]; heap[m] = heap[i]; heap[i] = tmp;
                i = m;
            }
        }
        return top;
    };

    // Reused across collapses in place of a per-collapse Set; see the collapse loop.
    const stamp = new Int32Array(topoCount).fill(-1);
    let epoch = 0;

    const pos3: number[] = [0, 0, 0];
    const considerEdge = (a: number, b: number) => {
        if (a === b || dead[a] || dead[b] || locked[a] || locked[b]) return;
        const cost = bestPosition(a, b, pos3);
        push({ cost, a, b, va: version[a], vb: version[b] });
    };

    let seen: Set<number> | null = new Set<number>();
    for (let t = 0; t < triCount; t++) {
        if (!alive[t]) continue;
        for (let k = 0; k < 3; k++) {
            const a = triTopo[t * 3 + k], b = triTopo[t * 3 + ((k + 1) % 3)];
            const key = edgeKey(a, b);
            if (seen.has(key)) continue;
            seen.add(key);
            considerEdge(a, b);
        }
    }

    seen = null; // seeding is done; this is one boxed key per edge and stays alive otherwise

    // Floor of two triangles per non-empty range. One collapse removes a pair, so a target of 1 overshoots
    // straight to an EMPTY submesh — and an empty range whose material the caller then prunes can leave a
    // level with no geometry at all. Ranges that were already empty stay empty.
    const targets = new Uint32Array(ranges.length);
    for (let s = 0; s < ranges.length; s++)
        targets[s] = subAlive[s] === 0 ? 0 : Math.max(2, Math.round(subAlive[s] * ratio));

    const nBefore: number[] = [0, 0, 0];
    const nAfter: number[] = [0, 0, 0];
    /** Would moving `from` and `other` to `p` invert or flatten any triangle that survives the collapse? */
    const wouldFlip = (from: number, other: number, px: number, py: number, pz: number): boolean => {
        const lists = [vertTris[from], vertTris[other]];
        for (const list of lists) {
            for (const t of list) {
                if (!alive[t]) continue;
                const a = triTopo[t * 3], b = triTopo[t * 3 + 1], c = triTopo[t * 3 + 2];
                const touchesFrom = a === from || b === from || c === from;
                const touchesOther = a === other || b === other || c === other;
                if (touchesFrom && touchesOther) continue; // this one dies in the collapse
                const len = faceNormal(t, nBefore);
                if (len <= 1e-20) continue;
                const moved = (v: number) => v === from || v === other;
                const ax = moved(a) ? px : tx[a], ay = moved(a) ? py : ty[a], az = moved(a) ? pz : tz[a];
                const bx = moved(b) ? px : tx[b], by = moved(b) ? py : ty[b], bz = moved(b) ? pz : tz[b];
                const cx2 = moved(c) ? px : tx[c], cy2 = moved(c) ? py : ty[c], cz2 = moved(c) ? pz : tz[c];
                const ux = bx - ax, uy = by - ay, uz = bz - az;
                const vx = cx2 - ax, vy = cy2 - ay, vz = cz2 - az;
                nAfter[0] = uy * vz - uz * vy;
                nAfter[1] = uz * vx - ux * vz;
                nAfter[2] = ux * vy - uy * vx;
                const after = Math.hypot(nAfter[0], nAfter[1], nAfter[2]);
                if (after <= 1e-20) return true; // collapsed to a sliver
                const dot = (nBefore[0] * nAfter[0] + nBefore[1] * nAfter[1] + nBefore[2] * nAfter[2]) / (len * after);
                if (dot <= 0) return true;
            }
        }
        return false;
    };

    const overBudget = (): number => {
        let n = 0;
        for (let s = 0; s < ranges.length; s++) n += Math.max(0, subAlive[s] - targets[s]);
        return n;
    };

    while (overBudget() > 0) {
        const e = pop();
        if (!e) break;
        const a = e.a, b = e.b;
        if (dead[a] || dead[b] || locked[a] || locked[b]) continue;
        if (version[a] !== e.va || version[b] !== e.vb) continue; // stale: re-costed since it was queued
        const sub = vertSub[a];
        if (sub < 0 || subAlive[sub] <= targets[sub]) continue;
        // No error ceiling: the caller asked for a triangle count and a ceiling turns that into a silent
        // floor (a sphere asked for 10% quietly stopping at 25%). Quality is preserved by the ordering —
        // cheapest collapse first — and correctness by the flip test below, which is the real guard.
        bestPosition(a, b, pos3);
        if (wouldFlip(a, b, pos3[0], pos3[1], pos3[2])) continue;

        // Collapse a into b. Attribute vertices are NOT merged — they follow their topological vertex to
        // the new position and keep their own uv/normal/tangent, which is what preserves a seam.
        tx[b] = pos3[0]; ty[b] = pos3[1]; tz[b] = pos3[2];
        const oa = a * 10, ob = b * 10;
        for (let k = 0; k < 10; k++) Q[ob + k] += Q[oa + k];

        for (const t of vertTris[a]) {
            if (!alive[t]) continue;
            const i0 = t * 3;
            const c0 = triTopo[i0], c1 = triTopo[i0 + 1], c2 = triTopo[i0 + 2];
            if (c0 === b || c1 === b || c2 === b) {
                alive[t] = 0;
                aliveTris--;
                subAlive[triSub[t]]--;
                continue;
            }
            if (c0 === a) triTopo[i0] = b;
            if (c1 === a) triTopo[i0 + 1] = b;
            if (c2 === a) triTopo[i0 + 2] = b;
            faceLen[t] = -1; // its corner moved
            vertTris[b].push(t);
        }
        // b inherits a's whole star, and nothing is ever removed from these lists — dead triangles and
        // transitively-inherited ones accumulate until a hub vertex's list is in the thousands, which the
        // three loops that scan it then pay for on every candidate. Compact when it is mostly dead.
        const list = vertTris[b];
        if (list.length > 16) {
            let live = 0;
            for (const t of list) if (alive[t]) live++;
            if (live * 2 < list.length) vertTris[b] = list.filter(t => alive[t]);
        }
        // Every triangle still touching b has a moved corner.
        for (const t of vertTris[b]) faceLen[t] = -1;
        dead[a] = 1;
        collapsedTo[a] = b;
        version[a]++;
        version[b]++;

        // Re-cost every edge now incident on b.
        //
        // ONLY `a` and `b` have their version bumped, above. Bumping the neighbours too — which this did
        // originally, to "discard their stale entries" — was a correctness bug: an edge (v,w) between two
        // neighbours of b has unchanged endpoints and unchanged quadrics, so it is not stale at all, and
        // invalidating it without re-queueing it destroyed O(valence²) candidates per collapse while
        // replacing only O(valence). The queue starved and the mesh came out silently under-decimated.
        //
        // The stamp buffer replaces a `new Set()` per collapse (~90k of them on a heavy mesh): `epoch`
        // increments, and a vertex counts as seen when its stamp already equals it.
        epoch++;
        for (const t of vertTris[b]) {
            if (!alive[t]) continue;
            for (let k = 0; k < 3; k++) {
                const v = triTopo[t * 3 + k];
                if (v === b || stamp[v] === epoch) continue;
                stamp[v] = epoch;
                considerEdge(b, v);
            }
        }
    }

    // ---- 6. Rebuild --------------------------------------------------------------------------------
    const rootOf = (v: number): number => {
        let r = v;
        while (collapsedTo[r] >= 0) r = collapsedTo[r];
        // Path compression, so a long collapse chain is walked once.
        let w = v;
        while (collapsedTo[w] >= 0) { const next = collapsedTo[w]; collapsedTo[w] = r; w = next }
        return r;
    };

    const hasNormals = input.normals.length > 0;
    const hasUvs = input.uvs.length > 0;
    const hasTangents = input.tangents.length > 0;
    const hasBitangents = input.bitangents.length > 0;

    const remap = new Int32Array(vertexCount).fill(-1);
    const kept: number[] = [];
    const outIndices: number[] = [];
    const outRanges: SimplifyRange[] = [];

    for (let s = 0; s < ranges.length; s++) {
        const start = outIndices.length;
        for (let t = 0; t < triCount; t++) {
            if (!alive[t] || triSub[t] !== s) continue;
            for (let k = 0; k < 3; k++) {
                const v = triAttr[t * 3 + k];
                if (remap[v] < 0) { remap[v] = kept.length; kept.push(v) }
                outIndices.push(remap[v]);
            }
        }
        // Parallel to the caller's materials, zero-count ranges included — see the doc comment.
        outRanges.push({ start, count: outIndices.length - start });
    }

    const outCount = kept.length;
    const positions = new Float32Array(outCount * 3);
    const normals = hasNormals ? new Float32Array(outCount * 3) : new Float32Array(0);
    const uvs = hasUvs ? new Float32Array(outCount * 2) : new Float32Array(0);
    const tangents = hasTangents ? new Float32Array(outCount * 3) : new Float32Array(0);
    const bitangents = hasBitangents ? new Float32Array(outCount * 3) : new Float32Array(0);

    for (let i = 0; i < outCount; i++) {
        const v = kept[i];
        const r = rootOf(topoOf[v]);
        positions[i * 3] = tx[r]; positions[i * 3 + 1] = ty[r]; positions[i * 3 + 2] = tz[r];
        // Attributes are CARRIED, never interpolated: each surviving vertex keeps the normal, uv and
        // tangent frame it was authored with, so hard creases and uv islands survive and the normals
        // stay unit-length with no renormalisation pass. They drift from the new surface as the mesh
        // simplifies, which is the accepted trade at LOD distances.
        if (hasNormals && v * 3 + 2 < input.normals.length) {
            normals[i * 3] = input.normals[v * 3];
            normals[i * 3 + 1] = input.normals[v * 3 + 1];
            normals[i * 3 + 2] = input.normals[v * 3 + 2];
        }
        if (hasUvs && v * 2 + 1 < input.uvs.length) {
            uvs[i * 2] = input.uvs[v * 2];
            uvs[i * 2 + 1] = input.uvs[v * 2 + 1];
        }
        if (hasTangents && v * 3 + 2 < input.tangents.length) {
            tangents[i * 3] = input.tangents[v * 3];
            tangents[i * 3 + 1] = input.tangents[v * 3 + 1];
            tangents[i * 3 + 2] = input.tangents[v * 3 + 2];
        }
        if (hasBitangents && v * 3 + 2 < input.bitangents.length) {
            bitangents[i * 3] = input.bitangents[v * 3];
            bitangents[i * 3 + 1] = input.bitangents[v * 3 + 1];
            bitangents[i * 3 + 2] = input.bitangents[v * 3 + 2];
        }
    }

    return {
        positions, normals, uvs, tangents, bitangents,
        indices: Uint32Array.from(outIndices),
        submeshes: outRanges,
    };
}

/** Triangles in a buffer set, so a caller can report a reduction without reaching for the index buffer. */
export function triangleCount(buffers: Pick<SimplifyBuffers, 'indices'>): number {
    return Math.floor(buffers.indices.length / 3);
}
