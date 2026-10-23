// How a material maps its textures onto a surface: the mesh's own uv (tiled and offset), or a
// PROJECTION that ignores the uv entirely — box (the face's dominant axis) or triplanar (all three axes,
// blended by the normal) — in metres, along the object's axes or the world's.
//
// Projection is what stops a texture stretching on scaled geometry. A primitive's uv runs 0..1 per face
// whatever its size, so a 10 m wall built from a unit cube scaled by its node shows ONE repeat squashed
// across it. A projection measures the surface instead: `uvWorldSize` metres per repeat on every face,
// at any scale — Unreal's world-aligned / triplanar textures, Unity ProBuilder's world UVs, Godot's
// UV1 Triplanar.
//
// Rides in chunks/modelVarying.wgsl for the same "exactly once" reason parallax.wgsl does. Takes the
// material's settings as a `UvParams` rather than reading `u_material`, because every material names
// its uniform block differently.
//
// DERIVATIVES ARE TAKEN IN `surfaceUv`, which must therefore be called in uniform control flow — at the
// top of the fragment stage, before any discard. Every fetch afterwards is `textureSampleGrad` with the
// gradients it returns, so the fetches themselves can sit under any branch.

const UV_MESH: i32 = 0;
const UV_BOX: i32 = 1;
const UV_TRIPLANAR: i32 = 2;

/** A material's mapping settings — the `uv*` members every material struct carries. */
struct UvParams {
    /** Tiling u/v, offset u/v. Applied in every mode. */
    transform: vec4<f32>,
    projection: i32,
    /** 0 = object (scaled by the node, sticks to the object), 1 = world (adjacent pieces line up). */
    space: i32,
    /** Metres per texture repeat, for box and triplanar. */
    worldSize: f32,
    /** Triplanar blend sharpness: higher = narrower blend bands at the edges. */
    blend: f32,
};

/**
 * Up to three charts, each with its own gradients. Mesh and box use chart 0 alone (weight 1);
 * triplanar uses all three, weighted by `weights`. `dpx`/`dpy` are the screen derivatives of the world
 * position, kept for building a tangent frame for each chart (`surfaceNormal`).
 */
struct SurfaceUv {
    mode: i32,
    uv0: vec2<f32>, dx0: vec2<f32>, dy0: vec2<f32>,
    uv1: vec2<f32>, dx1: vec2<f32>, dy1: vec2<f32>,
    uv2: vec2<f32>, dx2: vec2<f32>, dy2: vec2<f32>,
    weights: vec3<f32>,
    dpx: vec3<f32>,
    dpy: vec3<f32>,
};

fn signNonZero(x: f32) -> f32 { return select(1.0, -1.0, x < 0.0); }

/**
 * The three planar charts of `p` (already in repeats), oriented so an image reads upright and unmirrored
 * from outside every face: u runs to the viewer's right and v runs UP the image — textures are uploaded
 * bottom row first, so v = 0 is the image's bottom, exactly as on a `Geometry.Cube` face. On a wall v is
 * world-up; a floor reads with its top toward -Z, a ceiling the same seen from below.
 */
fn planarX(p: vec3<f32>, n: vec3<f32>) -> vec2<f32> { return vec2<f32>(-p.z * signNonZero(n.x), p.y); }
fn planarY(p: vec3<f32>, n: vec3<f32>) -> vec2<f32> { return vec2<f32>(p.x * signNonZero(n.y), -p.z); }
fn planarZ(p: vec3<f32>, n: vec3<f32>) -> vec2<f32> { return vec2<f32>(p.x * signNonZero(n.z), p.y); }

/**
 * Resolve the surface's texture coordinates. `meshUv` is the vertex uv; `objPos`/`objNormal` the
 * object-space position (in metres along the object's axes) and normal; `worldPos`/`worldNormal` the
 * world ones. CALL IN UNIFORM CONTROL FLOW (see the header).
 */
fn surfaceUv(params: UvParams, meshUv: vec2<f32>,
             objPos: vec3<f32>, objNormal: vec3<f32>,
             worldPos: vec3<f32>, worldNormal: vec3<f32>) -> SurfaceUv {
    var s: SurfaceUv;
    let scale = params.transform.xy;
    let offset = params.transform.zw;
    s.mode = params.projection;

    // Everything below is computed unconditionally and selected afterwards: the derivatives must be
    // taken by every fragment of the quad, whatever mode a uniform says.
    let world = params.space == 1;
    let p = select(objPos, worldPos, world) / max(params.worldSize, 1e-4);
    let n = normalize(select(objNormal, worldNormal, world));
    let cx = planarX(p, n) * scale + offset;
    let cy = planarY(p, n) * scale + offset;
    let cz = planarZ(p, n) * scale + offset;
    let cm = meshUv * scale + offset;
    let dxX = dpdx(cx); let dyX = dpdy(cx);
    let dxY = dpdx(cy); let dyY = dpdy(cy);
    let dxZ = dpdx(cz); let dyZ = dpdy(cz);
    let dxM = dpdx(cm); let dyM = dpdy(cm);
    s.dpx = dpdx(worldPos);
    s.dpy = dpdy(worldPos);

    let a = abs(n);
    s.uv1 = cy; s.dx1 = dxY; s.dy1 = dyY;
    s.uv2 = cz; s.dx2 = dxZ; s.dy2 = dyZ;
    if (params.projection == UV_TRIPLANAR) {
        s.uv0 = cx; s.dx0 = dxX; s.dy0 = dyX;
        let w = pow(a, vec3<f32>(max(params.blend, 1.0)));
        s.weights = w / max(w.x + w.y + w.z, 1e-6);
    } else if (params.projection == UV_BOX) {
        // The dominant axis: a box face, a floor, a wall. Ties (an exact 45-degree face) go to X then Y.
        if (a.x >= a.y && a.x >= a.z) { s.uv0 = cx; s.dx0 = dxX; s.dy0 = dyX; }
        else if (a.y >= a.z) { s.uv0 = cy; s.dx0 = dxY; s.dy0 = dyY; }
        else { s.uv0 = cz; s.dx0 = dxZ; s.dy0 = dyZ; }
        s.weights = vec3<f32>(1.0, 0.0, 0.0);
    } else {
        s.uv0 = cm; s.dx0 = dxM; s.dy0 = dyM;
        s.weights = vec3<f32>(1.0, 0.0, 0.0);
    }
    return s;
}

/**
 * `surfaceUv` for a material that maps by its mesh uv ALONE: one chart and its gradients, without the
 * three planar projections and their eight derivative pairs that the full version takes for every
 * fragment whatever the mode says. The `lean` foliage variants (geometryPBRInstanced.wgsl) use it — a
 * leaf card is shaded millions of times a frame and never projects. Same uniform-control-flow rule.
 */
fn meshSurfaceUv(params: UvParams, meshUv: vec2<f32>) -> SurfaceUv {
    var s: SurfaceUv;
    let cm = meshUv * params.transform.xy + params.transform.zw;
    s.mode = UV_MESH;
    s.uv0 = cm; s.dx0 = dpdx(cm); s.dy0 = dpdy(cm);
    s.uv1 = cm; s.dx1 = s.dx0; s.dy1 = s.dy0;
    s.uv2 = cm; s.dx2 = s.dx0; s.dy2 = s.dy0;
    s.weights = vec3<f32>(1.0, 0.0, 0.0);
    s.dpx = vec3<f32>(0.0);
    s.dpy = vec3<f32>(0.0);
    return s;
}

/**
 * Fetch a texture through the surface mapping. `uv` is chart 0 as the caller has it — possibly offset by
 * a parallax march, which only runs on single-chart modes — and the triplanar charts are read as
 * resolved. Gradients are always the ones `surfaceUv` took.
 */
fn sampleSurface(tex: texture_2d<f32>, smp: sampler, s: SurfaceUv, uv: vec2<f32>) -> vec4<f32> {
    if (s.mode == UV_TRIPLANAR) {
        return textureSampleGrad(tex, smp, uv, s.dx0, s.dy0) * s.weights.x
             + textureSampleGrad(tex, smp, s.uv1, s.dx1, s.dy1) * s.weights.y
             + textureSampleGrad(tex, smp, s.uv2, s.dx2, s.dy2) * s.weights.z;
    }
    return textureSampleGrad(tex, smp, uv, s.dx0, s.dy0);
}

/**
 * A tangent frame for a projected chart, from screen derivatives (Schüler's cotangent frame): a
 * projection has no vertex tangents. The bitangent is NEGATED to match the engine-wide green-channel
 * convention the vertex TBN carries (chunks/modelVarying.wgsl `fillVarying`).
 */
fn chartFrame(N: vec3<f32>, dpx: vec3<f32>, dpy: vec3<f32>, dux: vec2<f32>, duy: vec2<f32>) -> mat3x3<f32> {
    let dp2perp = cross(dpy, N);
    let dp1perp = cross(N, dpx);
    let T = dp2perp * dux.x + dp1perp * duy.x;
    let B = dp2perp * dux.y + dp1perp * duy.y;
    let invmax = inverseSqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
    return mat3x3<f32>(T * invmax, -B * invmax, N);
}

/** Decode one normal-map texel through `frame`. */
fn decodeNormal(texel: vec3<f32>, frame: mat3x3<f32>) -> vec3<f32> {
    return normalize(frame * normalize(texel * 2.0 - 1.0));
}

/**
 * The normal-mapped world normal for a PROJECTED surface (mesh mode decodes through the vertex TBN, as
 * before). `N` is the geometric world normal, facing the viewer's side of the surface as the caller has
 * it. Triplanar decodes each chart in its own frame and blends the results.
 */
fn projectedNormal(normalMap: texture_2d<f32>, smp: sampler, s: SurfaceUv, uv: vec2<f32>,
                   N: vec3<f32>) -> vec3<f32> {
    let f0 = chartFrame(N, s.dpx, s.dpy, s.dx0, s.dy0);
    let n0 = decodeNormal(textureSampleGrad(normalMap, smp, uv, s.dx0, s.dy0).rgb, f0);
    if (s.mode != UV_TRIPLANAR) { return n0; }
    let f1 = chartFrame(N, s.dpx, s.dpy, s.dx1, s.dy1);
    let f2 = chartFrame(N, s.dpx, s.dpy, s.dx2, s.dy2);
    let n1 = decodeNormal(textureSampleGrad(normalMap, smp, s.uv1, s.dx1, s.dy1).rgb, f1);
    let n2 = decodeNormal(textureSampleGrad(normalMap, smp, s.uv2, s.dx2, s.dy2).rgb, f2);
    return normalize(n0 * s.weights.x + n1 * s.weights.y + n2 * s.weights.z);
}
