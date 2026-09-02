import { mat4 } from 'gl-matrix';

// -----------------------------------------------------------------------------------------------
// Clustered light assignment: which lights can reach which part of the view frustum.
//
// Pure math over numbers and typed arrays. No GL, no renderer state, no imports from either — the
// same shape as `shadowMath.ts`, and for the same reason: every claim below is checkable in a unit
// test rather than by looking at a picture.
//
// The frustum is diced into a grid that is UNIFORM in screen space and EXPONENTIAL in depth. Each
// light's bounding sphere is projected to a screen rectangle and a depth-slice range, and its index
// is appended to every cluster that box covers. A fragment then loops over its own cluster's list
// instead of over every light in the scene, which is what removes the fixed `array<PointLight, 16>`
// the four lighting blocks used to carry.
//
// THE OUTPUT IS A COUNTING SORT, deliberately: count per cluster, prefix-sum into offsets, then
// fill. Those are three separable passes over the same data, which is exactly the shape a WGSL
// compute builder takes. When WebGPU grows one it replaces the body of `buildClusters` and nothing
// else — not the texture layout, not a single shader.
//
// CONVENTION. Tile (0, 0) is the corner of the screen at NDC (-1, -1), and slice 0 is nearest the
// camera. Nothing here knows which way up a fragment coordinate runs; that belongs to the renderer,
// which pre-solves it into the scale/bias the shader applies. See `chunks/clusteredLights.wgsl`.
// -----------------------------------------------------------------------------------------------

/** Clusters across the screen, down the screen, and into the distance. */
export interface ClusterGrid {
    x: number;
    y: number;
    z: number;
}

/** The shipped grid. 3456 clusters — one table texel each, so the table is 54 KB. */
export const DEFAULT_CLUSTER_GRID: Readonly<ClusterGrid> = { x: 16, y: 9, z: 24 };

/**
 * The most lights one cluster will hold.
 *
 * A budget, not a correctness bound: past it a light is dropped from that cluster alone, and every
 * other cluster keeps it. It exists because a pathological scene — a hundred overlapping lights with
 * kilometre ranges — would otherwise make the index list quadratic, and the failure mode of an
 * unbounded list is an allocation stall rather than a dark corner.
 */
export const DEFAULT_CLUSTER_LIGHT_CAP = 64;

/** A light reduced to what assignment actually needs: a world-space sphere it cannot reach past. */
export interface ClusterLight {
    position: ArrayLike<number>;
    /** World units. Zero or less removes the light from every cluster. */
    radius: number;
}

/** The camera side of the grid. `far` is the CLUSTERED distance, which is not the camera's own. */
export interface ClusterView {
    view: mat4;
    near: number;
    far: number;
    /** Vertical field of view, in RADIANS. */
    fovY: number;
    /** Width / height. */
    aspect: number;
}

/**
 * The assignment, in the two arrays the data texture carries.
 *
 * Both may be passed back in as `out` to be rewritten in place. `indices` is GROWN by the builder
 * when a frame needs more room than the last one did, so a caller must read the returned object's
 * `indices` rather than keeping the one it passed.
 */
export interface ClusterBuild {
    /** Four floats per cluster: `(offset, count, 0, 0)`. Length is `4 * x * y * z`. */
    table: Float32Array;
    /** Light indices, packed with no per-cluster stride. Only the first `used` are live. */
    indices: Float32Array;
    used: number;
    /** How many times a cluster hit the cap and dropped a light. Diagnostic only. */
    overflowed: number;
}

/** `x + gx * (y + gy * z)`. Slice-major, so one slice's tiles are contiguous. */
export function clusterIndex(x: number, y: number, z: number, grid: ClusterGrid): number {
    return x + grid.x * (y + grid.y * z);
}

/**
 * The depth slicing, pre-solved so the shader spends one `log` and a multiply-add.
 *
 * `slice = log(z) * scale + bias` is the standard exponential subdivision (Olsson): slices are thin
 * near the camera, where a screen tile is small in world units and a light covers few of them, and
 * thick far away, where it covers many. A uniform slicing puts almost every cluster in the last few
 * metres of a long view, which is why the naive version of this does nothing for a landscape.
 */
export function clusterDepthScaleBias(near: number, far: number, slices: number): [number, number] {
    // A near plane at or below zero makes log() explode; the same guard computeCascadeSplits uses.
    const n = Math.max(1e-4, near);
    const f = Math.max(n * (1 + 1e-6), far);
    const scale = slices / Math.log(f / n);
    return [scale, -Math.log(n) * scale];
}

/** Which slice `viewDepth` (distance in front of the camera, positive) falls in. */
export function clusterSliceOf(viewDepth: number, scale: number, bias: number, slices: number): number {
    const raw = Math.floor(Math.log(Math.max(1e-4, viewDepth)) * scale + bias);
    return Math.min(slices - 1, Math.max(0, raw));
}

/**
 * `tile = fragCoord.xy * scale + bias`, pre-solved on the CPU for the same reason a spot light's
 * cone arrives as `coneScale` / `coneOffset`: it is per-frame, not per-pixel, and it is the one
 * place the two backends disagree.
 *
 * Tile (0, 0) is the corner at NDC (-1, -1). Which fragment coordinate that corresponds to differs
 * between the back ends, and the derivation is worth writing down because guessing it wrong flips the
 * grid vertically — lights appear on the wrong half of the screen, which reads as a light-assignment
 * bug rather than an axis one:
 *
 *   - WebGL2: `gl_FragCoord.y` counts UP from the bottom, and clip y = -1 rasterizes to framebuffer
 *     row 0. So row 0 IS tile 0, and no correction is needed.
 *   - WebGPU: `@builtin(position).y` counts DOWN from the top, and `Renderer._clipProjection` leaves Y
 *     alone for an ordinary camera (it adjusts only the depth range). So clip y = +1 rasterizes to row
 *     0, which is the LAST tile, and the axis has to be reversed.
 *
 * A negative `scale.y` with `bias.y` at the grid height does that, costing the shader neither a branch
 * nor a uniform to test. `flipY` says the fragment coordinate runs top-down; the caller states it,
 * because nothing in this file can know which backend it is running under.
 *
 * Note that a pass mapping a fragment coordinate to a UV in a buffer of its OWN orientation needs no
 * such correction — see motionBlurTileMax.wgsl, which is why that shader has none. This one crosses
 * from screen space into a grid the CPU built in NDC, which is exactly the crossing `_uvProducing` and
 * `_uvConsuming` exist for.
 */
export function clusterTileScaleBias(viewportWidth: number, viewportHeight: number,
                                     grid: ClusterGrid, flipY: boolean): [number, number, number, number] {
    const sx = grid.x / Math.max(1, viewportWidth);
    const sy = grid.y / Math.max(1, viewportHeight);
    if (flipY) return [sx, -sy, 0, grid.y];
    return [sx, sy, 0, 0];
}

/**
 * The bounding sphere of a spot light's cone, which is what gets clustered rather than its range
 * sphere.
 *
 * A narrow cone is mostly empty space: a 30-degree spot with a 10 m range fills about a fiftieth of
 * the 10 m sphere around its own position, and clustering that sphere would light every wall behind
 * the fixture. The two cases below are the standard split — past 45 degrees the cone's cap bounds it,
 * below that the sphere circumscribing apex and cap does.
 *
 * THE RESULT IS NOT CONTAINED IN THE RANGE SPHERE, and that surprises people. Its RADIUS is never
 * larger than `range` (the two coincide only at 90 degrees, where the cone is a hemisphere), but it
 * is offset along the axis, so past 45 degrees it pokes out beyond the range sphere on the far side.
 * That is fine and it is not a bug: the only thing a bounding volume owes is to contain the cone,
 * which this does at every angle, and it is strictly smaller in volume than the range sphere at every
 * angle below 90.
 *
 * `direction` must be the direction the cone POINTS, normalized. `halfAngle` is in radians and is
 * the OUTER cutoff, not the inner one: the cone falloff is exactly zero outside it.
 */
export function spotBoundingSphere(position: ArrayLike<number>, direction: ArrayLike<number>,
                                   range: number, halfAngle: number,
                                   out: { center: Float32Array; radius: number }): void {
    const cos = Math.cos(halfAngle);
    const sin = Math.sin(halfAngle);

    let dist: number;
    if (sin * sin > 0.5) {
        dist = cos * range;
        out.radius = sin * range;
    } else {
        // cos is at least sqrt(0.5) in this branch, so the divide is bounded.
        dist = range / (2 * cos);
        out.radius = dist;
    }
    out.center[0] = position[0] + direction[0] * dist;
    out.center[1] = position[1] + direction[1] * dist;
    out.center[2] = position[2] + direction[2] * dist;
}

/**
 * The screen extent of a sphere along ONE axis, in NDC, from the tangent lines through the eye.
 *
 * Exact, and that is the whole reason it is written out rather than done by projecting the eight
 * corners of the sphere's bounding box. The corner method is not merely looser — it is WRONG in the
 * one case that matters, a sphere the camera is inside or nearly inside, where a corner behind the
 * eye projects to the opposite side of the screen and the rectangle silently collapses to nothing.
 * Here that case is detected (the eye inside the circle, or a tangent point at or behind the eye
 * plane) and REPORTED, so the caller widens to the whole axis instead of losing the light.
 *
 * `a` is the sphere centre's coordinate on this axis in VIEW space, `z` its distance in front of the
 * camera (positive), `tanHalf` the tangent of the half field of view on this axis.
 *
 * Returns false when the extent is unbounded and the caller must take the whole axis.
 */
export function sphereAxisExtent(a: number, z: number, r: number, tanHalf: number,
                                 out: [number, number]): boolean {
    const d2 = a * a + z * z;
    const r2 = r * r;
    // The eye is inside the sphere (in this plane): there are no tangent lines through it.
    if (d2 <= r2) return false;

    const d = Math.sqrt(d2);
    const len = Math.sqrt(d2 - r2);      // eye to either tangent point
    const cos = len / d;
    const sin = r / d;
    const ua = a / d;
    const uz = z / d;

    // The two tangent points: the unit direction to the centre rotated by +-asin(r/d), scaled by the
    // tangent length.
    const p1a = len * (cos * ua - sin * uz);
    const p1z = len * (sin * ua + cos * uz);
    const p2a = len * (cos * ua + sin * uz);
    const p2z = len * (cos * uz - sin * ua);

    // A tangent point at or behind the eye plane means the silhouette wraps around the camera on
    // this axis, and no finite rectangle contains it.
    if (p1z <= 1e-6 || p2z <= 1e-6) return false;

    const n1 = (p1a / p1z) / tanHalf;
    const n2 = (p2a / p2z) / tanHalf;
    out[0] = Math.min(n1, n2);
    out[1] = Math.max(n1, n2);
    return true;
}

/** NDC on one axis to a tile index, clamped into the grid. */
function tileOf(ndc: number, tiles: number): number {
    const t = Math.floor((ndc * 0.5 + 0.5) * tiles);
    return Math.min(tiles - 1, Math.max(0, t));
}

/** Six int32 per light: the tile and slice range its sphere covers. Reused across frames. */
let _ranges = new Int32Array(0);
/** Per cluster: a count in pass 1, then a write cursor in pass 3. */
let _cursor = new Int32Array(0);
const _extent: [number, number] = [0, 0];

/**
 * Assign every light to the clusters it can reach.
 *
 * Three passes over the same per-light ranges: count, prefix-sum, fill. The ranges are computed once
 * in pass 1 and cached in `_ranges`, because the projection is the expensive part of the whole
 * function and recomputing it in pass 3 doubles the cost of the frame for nothing.
 *
 * A light with an empty x range (`r[0] > r[1]`) reaches no cluster at all, which is how a light
 * behind the camera or past `far` leaves without a second flag to check.
 */
export function buildClusters(lights: readonly ClusterLight[], camera: ClusterView,
                              grid: ClusterGrid = DEFAULT_CLUSTER_GRID,
                              perClusterCap: number = DEFAULT_CLUSTER_LIGHT_CAP,
                              out?: ClusterBuild): ClusterBuild {
    const clusters = grid.x * grid.y * grid.z;
    const result: ClusterBuild = out ?? {
        table: new Float32Array(clusters * 4),
        indices: new Float32Array(1024),
        used: 0,
        overflowed: 0,
    };
    if (result.table.length < clusters * 4) result.table = new Float32Array(clusters * 4);
    result.table.fill(0);
    result.used = 0;
    result.overflowed = 0;

    const n = lights.length;
    if (_ranges.length < n * 6) _ranges = new Int32Array(Math.max(64, n * 2) * 6);
    if (_cursor.length < clusters) _cursor = new Int32Array(clusters);
    _cursor.fill(0, 0, clusters);

    const [zScale, zBias] = clusterDepthScaleBias(camera.near, camera.far, grid.z);
    const tanY = Math.tan(camera.fovY * 0.5);
    const tanX = tanY * camera.aspect;
    const v = camera.view;

    // --- pass 1: project each light, and count what each cluster owes ----------------------------
    let counted = 0;
    for (let i = 0; i < n; i++) {
        const base = i * 6;
        _ranges[base] = 1;                  // an empty x range: reaches nothing
        _ranges[base + 1] = 0;

        const light = lights[i];
        const radius = light.radius;
        if (!(radius > 0)) continue;

        // World to view. Column-major, gl-matrix's layout.
        const px = light.position[0], py = light.position[1], pz = light.position[2];
        const vx = v[0] * px + v[4] * py + v[8] * pz + v[12];
        const vy = v[1] * px + v[5] * py + v[9] * pz + v[13];
        const vz = v[2] * px + v[6] * py + v[10] * pz + v[14];
        const depth = -vz;                  // distance in FRONT of the camera; the view looks down -Z

        // Not a clamp: a sphere entirely behind the near plane or entirely past the clustered far
        // distance reaches nothing the grid describes.
        if (depth + radius <= camera.near || depth - radius >= camera.far) continue;

        _ranges[base + 4] = clusterSliceOf(Math.max(camera.near, depth - radius), zScale, zBias, grid.z);
        _ranges[base + 5] = clusterSliceOf(Math.min(camera.far, depth + radius), zScale, zBias, grid.z);

        if (sphereAxisExtent(vx, depth, radius, tanX, _extent)) {
            _ranges[base] = tileOf(_extent[0], grid.x);
            _ranges[base + 1] = tileOf(_extent[1], grid.x);
        } else {
            _ranges[base] = 0;
            _ranges[base + 1] = grid.x - 1;
        }
        if (sphereAxisExtent(vy, depth, radius, tanY, _extent)) {
            _ranges[base + 2] = tileOf(_extent[0], grid.y);
            _ranges[base + 3] = tileOf(_extent[1], grid.y);
        } else {
            _ranges[base + 2] = 0;
            _ranges[base + 3] = grid.y - 1;
        }

        for (let z = _ranges[base + 4]; z <= _ranges[base + 5]; z++)
            for (let y = _ranges[base + 2]; y <= _ranges[base + 3]; y++)
                for (let x = _ranges[base]; x <= _ranges[base + 1]; x++) {
                    const c = clusterIndex(x, y, z, grid);
                    if (_cursor[c] >= perClusterCap) { result.overflowed++; continue; }
                    _cursor[c]++;
                    counted++;
                }
    }

    // --- pass 2: prefix-sum the counts into offsets ----------------------------------------------
    let offset = 0;
    for (let c = 0; c < clusters; c++) {
        result.table[c * 4] = offset;
        result.table[c * 4 + 1] = _cursor[c];
        offset += _cursor[c];
        // Rewound to the offset, so pass 3 uses it as the write cursor and the count marks the end.
        _cursor[c] = result.table[c * 4];
    }
    result.used = counted;
    if (result.indices.length < counted)
        result.indices = new Float32Array(Math.max(1024, 1 << Math.ceil(Math.log2(counted))));

    // --- pass 3: fill -----------------------------------------------------------------------------
    const indices = result.indices;
    for (let i = 0; i < n; i++) {
        const base = i * 6;
        for (let z = _ranges[base + 4]; z <= _ranges[base + 5]; z++)
            for (let y = _ranges[base + 2]; y <= _ranges[base + 3]; y++)
                for (let x = _ranges[base]; x <= _ranges[base + 1]; x++) {
                    const c = clusterIndex(x, y, z, grid);
                    const end = result.table[c * 4] + result.table[c * 4 + 1];
                    if (_cursor[c] >= end) continue;      // this cluster reached the cap in pass 1
                    indices[_cursor[c]++] = i;
                }
    }

    return result;
}

/**
 * One cluster holding every light, for a view the grid was not built for.
 *
 * The light-probe capture renders six faces from a cube camera while the grid describes the MAIN
 * camera, so its clusters mean nothing there. Rebuilding the grid per face would cost six
 * assignments for a bake that is rare and low-resolution; handing that pass a degenerate 1x1x1 grid
 * costs one loop over the lights and needs no second code path in any shader.
 */
export function buildSingleCluster(lightCount: number, out?: ClusterBuild): ClusterBuild {
    const result: ClusterBuild = out ?? {
        table: new Float32Array(4),
        indices: new Float32Array(Math.max(1, lightCount)),
        used: 0,
        overflowed: 0,
    };
    if (result.table.length < 4) result.table = new Float32Array(4);
    if (result.indices.length < lightCount) result.indices = new Float32Array(lightCount);
    result.table[0] = 0;
    result.table[1] = lightCount;
    result.table[2] = 0;
    result.table[3] = 0;
    for (let i = 0; i < lightCount; i++) result.indices[i] = i;
    result.used = lightCount;
    result.overflowed = 0;
    return result;
}
