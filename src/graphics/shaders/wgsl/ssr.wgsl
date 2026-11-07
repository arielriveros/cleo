// Screen-space reflections, stage 1 of 3: one stochastic GGX ray per pixel, marched through the depth
// buffer, and the light found where it lands.
//
// THE RAY. A microfacet normal is drawn from the GGX distribution of VISIBLE normals (Heitz, "Sampling
// the GGX Distribution of Visible Normals", JCGT 2018) and the view ray reflected about it. That is the
// lobe a rough surface actually reflects through, so a glossy reflection stretches the way the highlight
// does rather than blurring uniformly. One ray per pixel is noise by design; ssrResolve.wgsl shares rays
// between neighbours and ssrTemporal.wgsl accumulates frames.
//
// THE MARCH. A screen-space DDA (McGuire & Mara, "Efficient GPU Screen-Space Ray Tracing", JCGT 2014):
// the ray's two ends are projected once and the line between them is walked in pixels, interpolating
// 1/w, so the view depth at every step is exact under perspective. A step hits when the ray has passed
// behind the depth buffer by less than `u_thickness` — the depth buffer is a height field, and anything
// it hides is assumed to be that thick. A few bisections then pin the crossing down.
//
// THE LIGHT. Last frame's lit opaque image (sceneRadiance.ts) at the hit, reprojected through last
// frame's camera and checked against the view depth stored beside it, exactly as SSIL does. Last frame's
// image already holds last frame's reflections, so reflections of reflections come for free.
//
// Outputs (both at this pass's resolution):
//   traceRay  xy = the ray's direction (view space, octahedral), z = log2 of its pdf, w = this pixel's
//             view depth, so the resolve can tell its neighbours' surfaces apart without a depth fetch
//             (-1 = no ray: background, too rough, or facing away)
//   traceHit  rgb = the light at the hit, a = how far to trust it (0 = the fallback reflects instead)

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"

@group(0) @binding(0) var u_gNormalRoughness_texture: texture_2d<f32>;  // rg = oct world normal, a = roughness
@group(0) @binding(1) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(2) var u_gDepth_texture: texture_depth_2d;
@group(0) @binding(3) var u_gDepth_sampler: sampler;
// Last frame's lit opaque colour: rgb = linear HDR radiance (pre-exposure), a = the view depth it was
// seen at. See ssilHistory.wgsl.
@group(0) @binding(4) var u_radiance_texture: texture_2d<f32>;
@group(0) @binding(5) var u_radiance_sampler: sampler;

const PI: f32 = 3.14159265;
const MAX_STEPS: i32 = 128;
const REFINE_STEPS: i32 = 5;
/**
 * GGX alpha floor for the SAMPLING only. At the shading floor (perceptual 0.045, alpha 0.002) the pdf of a
 * mirror reaches ~2e4 and its log is still well inside half-float range, so this is about the variance
 * of the first few frames, not overflow: below it every ray is the mirror ray anyway.
 */
const MIN_ALPHA: f32 = 0.002;

struct SsrUniforms {
    u_view: mat4x4<f32>,            // world -> view, for the G-buffer's world-space normals
    u_projection: mat4x4<f32>,      // view -> clip (jittered, uv-producing)
    u_invProjection: mat4x4<f32>,   // clip -> view (jittered, uv-consuming)
    // This frame's view -> LAST frame's clip (uv-producing, unjittered) and view, as in ssil.wgsl.
    u_viewToPrevClip: mat4x4<f32>,
    u_viewToPrevView: mat4x4<f32>,
    /** The z and w rows of `u_invProjection` (see ssilTemporal.wgsl): a view depth in two multiply-adds. */
    u_depthParams: vec4<f32>,
    u_maxDistance: f32,             // world units a ray may travel
    u_thickness: f32,               // world units a depth sample is assumed to extend behind its face
    u_maxRoughness: f32,            // rougher surfaces trace nothing; the fallback reflects for them
    u_near: f32,                    // camera near plane distance: rays are clipped in front of it
    u_sampleBias: f32,              // 0..1 share of the GGX lobe sampled; < 1 drops the noisiest tail
    u_frame: f32,                   // rotates the noise every frame
    u_steps: i32,                   // march steps along the whole on-screen ray
    u_hasRadiance: i32,             // 0 = no usable copy of last frame (first frame, a cut, 8-bit targets)
    /** k_now / k_copy: brings last frame's radiance copy to this frame's pre-exposure. */
    u_radianceRescale: f32,
};
@group(1) @binding(0) var<uniform> u_ssr: SsrUniforms;

// Member names are distinct from every local below ON PURPOSE. The GLSL generated for WebGL2 declares
// each member as an `out` global of the same name, so a local called `radiance` would shadow the output
// and the write meant for it would land in the local — a target left blank on WebGL2 alone, no error.
struct SsrOutput {
    @location(0) traceRay: vec4<f32>,
    @location(1) traceHit: vec4<f32>,
};

// `textureSampleLevel` throughout: every fetch below is reached from a loop or from behind an early
// return, which WGSL treats as non-uniform control flow — see ssil.wgsl.
fn deviceDepth(uv: vec2<f32>) -> f32 {
    return textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0);
}

/** A uv moved to the centre of the texel it falls in — see ssil.wgsl's `snapToTexel` for why. */
fn snapToTexel(uv: vec2<f32>, dims: vec2<f32>) -> vec2<f32> {
    return (floor(uv * dims) + 0.5) / dims;
}

fn viewPosAt(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let view = u_ssr.u_invProjection * clip;
    return view.xyz / view.w;
}

/** Distance in front of the camera plane for a device depth. See `u_depthParams`. */
fn linearDepth(depth: f32) -> f32 {
    let z = depth * 2.0 - 1.0;
    let p = u_ssr.u_depthParams;
    return -(z * p.x + p.y) / (z * p.z + p.w);
}

/** The G-buffer normal at a (texel-centred) uv, in view space. */
fn viewNormalAt(uv: vec2<f32>) -> vec3<f32> {
    let octN = textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, uv, 0.0).rg;
    let viewRot = mat3x3<f32>(u_ssr.u_view[0].xyz, u_ssr.u_view[1].xyz, u_ssr.u_view[2].xyz);
    return normalize(viewRot * octDecode(octN));
}

/** Interleaved gradient noise (Jimenez). */
fn ign(px: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
}

/** GGX distribution. `alpha` is roughness squared. */
fn ggxD(NoH: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let f = (NoH * a2 - NoH) * NoH + 1.0;
    return a2 / (PI * f * f);
}

/** Smith's masking for one direction, GGX. */
fn smithG1(NoX: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    return 2.0 * NoX / max(NoX + sqrt(a2 + (1.0 - a2) * NoX * NoX), 1e-6);
}

/**
 * A GGX microfacet normal, in the tangent frame where the macro normal is +Z, drawn in proportion to how
 * much of it the view direction `Ve` sees (Heitz 2018, listing 1). `u` is two uniform numbers.
 */
fn sampleGgxVndf(Ve: vec3<f32>, alpha: f32, u: vec2<f32>) -> vec3<f32> {
    let Vh = normalize(vec3<f32>(alpha * Ve.x, alpha * Ve.y, Ve.z));
    let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
    let T1 = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-Vh.y, Vh.x, 0.0) / sqrt(max(lensq, 1e-12)), lensq > 0.0);
    let T2 = cross(Vh, T1);
    let r = sqrt(u.x);
    let phi = 2.0 * PI * u.y;
    let t1 = r * cos(phi);
    let s = 0.5 * (1.0 + Vh.z);
    let t2 = (1.0 - s) * sqrt(max(1.0 - t1 * t1, 0.0)) + s * (r * sin(phi));
    let Nh = t1 * T1 + t2 * T2 + sqrt(max(1.0 - t1 * t1 - t2 * t2, 0.0)) * Vh;
    return normalize(vec3<f32>(alpha * Nh.x, alpha * Nh.y, max(Nh.z, 0.0)));
}

/** Where along s0 -> s1 (0..1) the segment leaves the screen's pixel centres. */
fn screenExit(s0: vec2<f32>, d: vec2<f32>, dims: vec2<f32>) -> f32 {
    var t = 1.0;
    if (d.x > 1e-6) { t = min(t, (dims.x - 0.5 - s0.x) / d.x); }
    if (d.x < -1e-6) { t = min(t, (0.5 - s0.x) / d.x); }
    if (d.y > 1e-6) { t = min(t, (dims.y - 0.5 - s0.y) / d.y); }
    if (d.y < -1e-6) { t = min(t, (0.5 - s0.y) / d.y); }
    return max(t, 0.0);
}

/** Fade to 0 over the outermost `band` of the screen, so a reflection never ends in a hard edge. */
fn edgeFade(uv: vec2<f32>, band: f32) -> f32 {
    let e = min(uv, vec2<f32>(1.0) - uv);
    let f = clamp(e / band, vec2<f32>(0.0), vec2<f32>(1.0));
    return f.x * f.y;
}

struct MarchHit {
    uv: vec2<f32>,
    distance: f32,  // view-space distance from the origin; 0 = no hit
};

/**
 * March `dir` from `origin` (both view space) through the depth buffer. `jitter` (0..1) offsets the
 * first step so neighbouring pixels sample between each other's steps, which TAA and the temporal pass
 * then average into a finer march than any one pixel paid for.
 */
fn march(origin: vec3<f32>, dir: vec3<f32>, jitter: f32, dims: vec2<f32>) -> MarchHit {
    var miss: MarchHit;
    miss.uv = vec2<f32>(0.0);
    miss.distance = 0.0;

    // Keep the far end in front of the near plane: past it the projection divides by a w through zero.
    var rayLen = u_ssr.u_maxDistance;
    if (dir.z > 1e-5) {
        rayLen = min(rayLen, (-u_ssr.u_near - origin.z) / dir.z * 0.99);
    }
    if (rayLen <= 0.0) { return miss; }
    let endP = origin + dir * rayLen;

    let h0 = u_ssr.u_projection * vec4<f32>(origin, 1.0);
    let h1 = u_ssr.u_projection * vec4<f32>(endP, 1.0);
    let k0 = 1.0 / h0.w;
    let k1 = 1.0 / h1.w;
    let s0 = (h0.xy * k0 * 0.5 + 0.5) * dims;
    let s1 = (h1.xy * k1 * 0.5 + 0.5) * dims;
    // View z over w, which — unlike z itself — interpolates linearly in screen space.
    let q0 = origin.z * k0;
    let q1 = endP.z * k1;

    let d = s1 - s0;
    let fullLen = max(abs(d.x), abs(d.y));
    if (fullLen < 1.0) { return miss; }
    let tEnd = screenExit(s0, d, dims);
    let onScreen = fullLen * tEnd;
    if (onScreen < 1.0) { return miss; }

    let steps = clamp(u_ssr.u_steps, 1, MAX_STEPS);
    // At least a pixel per step; spread evenly over the on-screen part when the ray is long.
    let stride = max(1.0, onScreen / f32(steps));
    let dt = stride / fullLen;

    var prevT = 0.0;
    var prevDepth = -1.0;     // the ray's depth at the previous step; < 0 before the first
    var found = false;
    var hitLo = 0.0;
    var hitHi = 0.0;
    for (var i = 0; i < MAX_STEPS; i++) {
        if (i >= steps) { break; }
        // Never the origin pixel itself: the first step is one stride (plus jitter) out.
        let t = (f32(i) + 1.0 + jitter) * dt;
        if (t > tEnd) { break; }
        let s = s0 + d * t;
        let rayDepth = -(mix(q0, q1, t) / mix(k0, k1, t));
        let sd = deviceDepth((floor(s) + 0.5) / dims);
        if (sd < 1.0) {
            let sceneDepth = linearDepth(sd);
            // The ray's depth across this step, against the slab the depth sample stands for. On the
            // first step there is no previous point: the origin is ON a surface, and counting it would
            // report a hit on the surface the ray leaves.
            let lo = select(min(prevDepth, rayDepth), rayDepth, prevDepth < 0.0);
            let hi = max(prevDepth, rayDepth);
            if (hi >= sceneDepth && lo <= sceneDepth + u_ssr.u_thickness) {
                found = true;
                hitLo = prevT;
                hitHi = t;
                break;
            }
        }
        prevT = t;
        prevDepth = rayDepth;
    }
    if (!found) { return miss; }

    // Bisect the step the crossing happened in: the hit is the first point at or behind the surface.
    for (var j = 0; j < REFINE_STEPS; j++) {
        let mid = 0.5 * (hitLo + hitHi);
        let s = s0 + d * mid;
        let rayDepth = -(mix(q0, q1, mid) / mix(k0, k1, mid));
        let sd = deviceDepth((floor(s) + 0.5) / dims);
        let behind = sd < 1.0 && rayDepth >= linearDepth(sd);
        hitHi = select(hitHi, mid, behind);
        hitLo = select(mid, hitLo, behind);
    }

    let sHit = s0 + d * hitHi;
    var hit: MarchHit;
    hit.uv = (floor(sHit) + 0.5) / dims;
    let k = mix(k0, k1, hitHi);
    let pHit = mix(origin * k0, endP * k1, hitHi) / k;
    hit.distance = max(length(pHit - origin), 1e-4);
    return hit;
}

@fragment
fn fs_main(in: VertexOutput) -> SsrOutput {
    var out: SsrOutput;
    out.traceRay = vec4<f32>(0.0, 0.0, 0.0, -1.0);
    out.traceHit = vec4<f32>(0.0);

    let dims = vec2<f32>(textureDimensions(u_gDepth_texture, 0));
    let uv = snapToTexel(in.uv, dims);
    let depth = deviceDepth(uv);
    if (depth >= 1.0) { return out; }

    let normalRoughness = textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, uv, 0.0);
    let roughness = normalRoughness.a;
    if (roughness > u_ssr.u_maxRoughness) { return out; }

    let P = viewPosAt(uv, depth);
    let viewRot = mat3x3<f32>(u_ssr.u_view[0].xyz, u_ssr.u_view[1].xyz, u_ssr.u_view[2].xyz);
    let N = normalize(viewRot * octDecode(normalRoughness.rg));
    let V = -normalize(P);

    // A tangent frame around N (Duff et al., "Building an Orthonormal Basis, Revisited", JCGT 2017).
    let sgn = select(-1.0, 1.0, N.z >= 0.0);
    let a = -1.0 / (sgn + N.z);
    let b = N.x * N.y * a;
    let T = vec3<f32>(1.0 + sgn * N.x * N.x * a, sgn * b, -sgn * N.x);
    let B = vec3<f32>(b, sgn + N.y * N.y * a, -N.y);
    let Ve = vec3<f32>(dot(V, T), dot(V, B), dot(V, N));
    // A normal map can turn the shading normal away from the camera; such a pixel reflects nothing the
    // screen holds, and its lobe is not defined from this side.
    if (Ve.z <= 1e-4) { return out; }

    // Per-pixel noise, rotated every frame along the R2 sequence so successive frames fill the gaps.
    let px = in.position.xy;
    let r2 = fract(vec2<f32>(0.7548776662, 0.5698402910) * u_ssr.u_frame);
    let u = fract(vec2<f32>(ign(px), ign(px + vec2<f32>(113.0, 71.0))) + r2);
    let jitter = fract(ign(px + vec2<f32>(37.0, 191.0)) + 0.618034 * u_ssr.u_frame);

    let alpha = max(roughness * roughness, MIN_ALPHA);
    let He = sampleGgxVndf(Ve, alpha, vec2<f32>(u.x * u_ssr.u_sampleBias, u.y));
    let H = T * He.x + B * He.y + N * He.z;
    let L = reflect(-V, H);
    // pdf of L under visible-normal sampling: G1(V) D(H) / (4 NoV). The truncated tail scales every
    // pdf by the same constant, which the resolve's normalisation cancels.
    let pdf = smithG1(Ve.z, alpha) * ggxD(He.z, alpha) / (4.0 * Ve.z);
    out.traceRay = vec4<f32>(octEncode(L), log2(max(pdf, 1e-30)), -P.z);

    // Below the surface: the sample is real (it counts toward the lobe) but reflects nothing.
    if (dot(N, L) <= 0.0 || u_ssr.u_hasRadiance == 0) { return out; }

    // Off the surface by a hair, scaled with distance because depth precision is.
    let origin = P + N * (0.002 * -P.z + 0.002);
    let hit = march(origin, L, jitter, dims);
    if (hit.distance <= 0.0) { return out; }

    // A hit on a face turned away from the ray is the back of something the screen cannot show.
    let hitN = viewNormalAt(hit.uv);
    if (dot(hitN, L) >= 0.0) { return out; }

    let hitDepth = deviceDepth(hit.uv);
    let Hp = vec4<f32>(viewPosAt(hit.uv, hitDepth), 1.0);
    let prevClip = u_ssr.u_viewToPrevClip * Hp;
    let prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
    if (prevClip.w <= 0.0 || any(prevUV < vec2<f32>(0.0)) || any(prevUV > vec2<f32>(1.0))) { return out; }
    let prevLight = textureSampleLevel(u_radiance_texture, u_radiance_sampler, prevUV, 0.0);
    let expected = -(u_ssr.u_viewToPrevView * Hp).z;
    // Looser than SSIL's 5%: the copy is bilinear and usually smaller than the screen, and a hit lands
    // on silhouettes far more often than an SSIL sample does.
    if (abs(prevLight.a - expected) > 0.1 * expected + 0.1) { return out; }
    let colour = prevLight.rgb * u_ssr.u_radianceRescale;
    if (!(all(colour >= vec3<f32>(0.0)) && all(colour <= vec3<f32>(6.0e4)))) { return out; }

    // How far to trust it: not near the edge of either frame (the reflection would end in a hard line
    // the moment the camera turns), not at the end of the ray's reach, and less for rays that come back
    // toward the camera — those see the backs of things the screen only shows the fronts of.
    let fade = edgeFade(hit.uv, 0.08) * edgeFade(prevUV, 0.04)
             * (1.0 - smoothstep(0.75, 1.0, hit.distance / u_ssr.u_maxDistance))
             * (1.0 - smoothstep(0.4, 0.9, L.z));
    out.traceHit = vec4<f32>(colour, fade);
    return out;
}
