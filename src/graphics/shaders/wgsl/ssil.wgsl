// Screen-space indirect lighting with a visibility bitmask (SSILVB): ambient occlusion and one bounce
// of nearby diffuse light, in one horizon-search pass. Therrien, Levesque & Gilet, "Screen Space
// Indirect Lighting with Visibility Bitmask" (The Visual Computer, 2023).
//
// What it replaces, and why. The old pass was a hemisphere kernel: points scattered around the surface,
// each asked "is the depth buffer in front of you". That treats everything in front of a sample as a
// solid wall reaching to infinity, so a lamp post a metre in front of a wall painted a dark halo on the
// wall behind it. Here every depth sample is an occluder of finite THICKNESS: it blocks the arc of
// directions between its front face and a point `u_thickness` behind it, and light passes behind it.
//
// HOW. Per pixel, a few screen-space slices through the view vector. In each, the hemisphere above the
// surface is cut into 32 sectors (one u32). Each depth sample along the slice marks the sectors its
// front-to-back arc covers. The fraction left unmarked at the end is the visibility (AO); and each
// sample that marks sectors NOBODY nearer had marked is what the pixel sees in those directions — so
// last frame's radiance there, weighted by those newly marked sectors, is one bounce of indirect light.
//
// Sectors are spaced in COSINE-WEIGHTED SOLID ANGLE — GTAO's measure, cos(theta - n) |sin theta| along the
// slice — so every sector is the same share of irradiance wherever it points, and slices are weighted
// by how much of the hemisphere they actually carry. That makes both results land in the units the
// deferred pass already uses: visibility is the cosine-weighted unoccluded fraction, and `.rgb` is the
// cosine-weighted average of incoming radiance, i.e. E / pi — the quantity the probe irradiance cubes and
// `skyIrradiance` hold. A pixel ringed by surfaces of radiance L returns L. (The paper spaces sectors
// uniformly in angle; at the foot of a wall that reads about half the occlusion that is there.)
//
// Output: rgb = indirect E/pi (before albedo), a = visibility (1 = open sky), raised to `u_power`.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"

@group(0) @binding(0) var u_gNormalRoughness_texture: texture_2d<f32>;  // rg = oct world normal
@group(0) @binding(1) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(2) var u_gDepth_texture: texture_depth_2d;            // non-linear device depth
@group(0) @binding(3) var u_gDepth_sampler: sampler;
// Last frame's lit opaque colour at this pass's resolution: rgb = linear HDR radiance (pre-exposure),
// a = the view depth it was seen at. See ssilHistory.wgsl.
@group(0) @binding(4) var u_radiance_texture: texture_2d<f32>;
@group(0) @binding(5) var u_radiance_sampler: sampler;

const PI: f32 = 3.14159265;
const HALF_PI: f32 = 1.57079633;
const SECTORS: f32 = 32.0;
const MAX_STEPS: i32 = 16;
const MAX_SLICES: i32 = 4;
/**
 * Sine of the angle above the tangent plane below which a sample is taken to BE the surface, not an
 * occluder on it. Depth is quantized, and the error grows with distance: unprojected, the samples of a
 * flat floor scatter a degree or two either side of it, and the first sectors off the horizon are wide
 * there — sector 0 alone spans 20 degrees. Without this a distant floor reads as grainy occlusion.
 */
const HORIZON_BIAS: f32 = 0.1;

struct SsilUniforms {
    u_view: mat4x4<f32>,            // world -> view, for the G-buffer's world-space normals
    u_projection: mat4x4<f32>,      // view -> clip (jittered, uv-producing)
    u_invProjection: mat4x4<f32>,   // clip -> view (jittered, uv-consuming)
    // LAST frame's camera, unjittered, composed with this frame's view -> world so a sample goes there in
    // one multiply: where it sat on screen when the radiance was captured (uv-producing), and how far
    // from that camera — the second is what rejects radiance from a surface since uncovered.
    u_viewToPrevClip: mat4x4<f32>,
    u_viewToPrevView: mat4x4<f32>,
    u_radius: f32,                  // world units
    u_thickness: f32,               // world units an occluder is assumed to extend behind its face
    u_bias: f32,                    // samples nearer than this are ignored (depth self-shadowing)
    u_power: f32,                   // contrast on the visibility only
    u_slices: i32,
    u_steps: i32,                   // per side of the slice
    u_frame: f32,                   // rotates the noise every frame; the temporal pass averages it out
    u_hasRadiance: i32,             // 0 = AO only (first frame, a cut, no float targets, or switched off)
    u_ortho: i32,
    u_maxRadiusPx: f32,             // screen-space cap on the search, in full-resolution pixels
};
@group(1) @binding(0) var<uniform> u_ssil: SsilUniforms;

// `textureSampleLevel` throughout: every helper here is reached from loops and from behind an early
// return, which WGSL treats as non-uniform control flow — implicit-LOD sampling there is a validation
// error on Dawn that leaves the pipeline invalid and the pass drawing nothing.
fn deviceDepth(uv: vec2<f32>) -> f32 {
    return textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0);
}

/**
 * A uv moved to the centre of the depth texel it falls in. Every position this pass reconstructs goes
 * through here, for the pixel and for each sample alike, so a depth is always unprojected at the uv it
 * was rasterized at. Mixing them — a texel's depth at a point half a texel away, which is exactly what a
 * half-resolution pixel centre is — puts the point off its own surface by half a texel's depth slope:
 * on a wall seen at an angle that is enough to self-occlude, alternately per column, in stripes.
 */
fn snapToTexel(uv: vec2<f32>, dims: vec2<f32>) -> vec2<f32> {
    return (floor(uv * dims) + 0.5) / dims;
}

fn viewPosAt(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let view = u_ssil.u_invProjection * clip;
    return view.xyz / view.w;
}

/** Unit direction from the camera through a view-space point. */
fn viewRay(p: vec3<f32>) -> vec3<f32> {
    if (u_ssil.u_ortho != 0) { return vec3<f32>(0.0, 0.0, -1.0); }
    return normalize(p);
}

/**
 * The G-buffer normal at a uv, in VIEW space. Snapped to the source texel centre: this pass runs below
 * the G-buffer's resolution and its targets are linearly filtered, so an unsnapped fetch averages two
 * octahedral encodings — which is not a direction (see chunks/octNormal.wgsl).
 */
fn viewNormalAt(uv: vec2<f32>) -> vec3<f32> {
    let dims = vec2<f32>(textureDimensions(u_gNormalRoughness_texture, 0));
    let snapped = (floor(uv * dims) + 0.5) / dims;
    let octN = textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, snapped, 0.0).rg;
    let viewRot = mat3x3<f32>(u_ssil.u_view[0].xyz, u_ssil.u_view[1].xyz, u_ssil.u_view[2].xyz);
    return normalize(viewRot * octDecode(octN));
}

/** Interleaved gradient noise (Jimenez). */
fn ign(px: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
}

/**
 * Number of set bits. By hand, NOT `countOneBits`: naga writes that as GLSL `bitCount`, which GLSL ES
 * 3.00 does not have (it arrived in 3.10), so the WebGL2 program would fail to compile. Classic SWAR;
 * u32 arithmetic wraps on both sides, which the final multiply relies on.
 */
fn popcount(x: u32) -> u32 {
    var v = x - ((x >> 1u) & 0x55555555u);
    v = (v & 0x33333333u) + ((v >> 2u) & 0x33333333u);
    return (((v + (v >> 4u)) & 0x0F0F0F0Fu) * 0x01010101u) >> 24u;
}

/**
 * The sectors an arc [a, b] (both in 0..1 cosine-weighted measure, a <= b) covers. A sector counts when
 * at least half of it is inside — the paper's rounding rule, which keeps a sample from marking a sector
 * it only grazes.
 */
fn sectorMask(a: f32, b: f32) -> u32 {
    let first = u32(clamp(ceil(a * SECTORS - 0.5), 0.0, SECTORS));
    let last = u32(clamp(floor(b * SECTORS - 0.5) + 1.0, 0.0, SECTORS));
    if (last <= first) { return 0u; }
    let count = last - first;
    // `count` ones, built UP from 1 rather than shifted down from all-ones: on WebGL2 under ANGLE's D3D
    // backend `0xFFFFFFFFu >> n` came back as all-ones whatever n was (the literal is treated as a
    // signed -1 and the shift as arithmetic), which turned every sample into a full hemisphere. A
    // runtime shift by 32 is also taken MODULO 32 in WGSL, so a full mask is its own case either way.
    // `first` is below 32 whenever `count` is non-zero.
    let ones = select((1u << count) - 1u, 0xFFFFFFFFu, count >= 32u);
    return ones << first;
}

/**
 * One slice's measure: angles from V (positive toward T) to a cumulative fraction of the hemisphere's
 * cosine-weighted solid angle, 0 at the horizon below the projected normal and 1 at the one above it.
 *
 * The density along the slice is cos(t - n) |sin t| — the cosine to the normal, times the Jacobian of
 * sweeping a plane about V. With G(t) = -cos(2t - n) / 4 + t sin(n) / 2, the antiderivative of
 * cos(t - n) sin(t), the integral from the lower horizon to theta is G(lo) - G(theta) below V (where
 * sin t < 0) and `below` + G(theta) - G(0) above it. `lo` <= 0 <= `hi` always, since n is clamped to
 * +-pi/2, so those are the only two cases.
 */
struct SliceMeasure {
    n: f32,
    sinN: f32,
    cosN: f32,
    lo: f32,
    hi: f32,
    gLo: f32,
    g0: f32,
    below: f32,   // the measure from `lo` up to V
    total: f32,   // the whole slice's measure; also its share of the hemisphere
};

/**
 * Once per slice. `sinN`/`cosN` come straight from the projected normal's components, and G at the three
 * fixed angles collapses to them — cos(2t - n) is -cos n at both horizons and cos n at V — so the only
 * trig left is the atan2 that gives n itself.
 */
fn sliceMeasureFor(n: f32, sinN: f32, cosN: f32) -> SliceMeasure {
    var m: SliceMeasure;
    m.n = n;
    m.sinN = sinN;
    m.cosN = cosN;
    m.lo = n - HALF_PI;
    m.hi = n + HALF_PI;
    m.gLo = 0.25 * cosN + 0.5 * m.lo * sinN;
    m.g0 = -0.25 * cosN;
    m.below = m.gLo - m.g0;
    m.total = max(m.below + (0.25 * cosN + 0.5 * m.hi * sinN) - m.g0, 1e-6);
    return m;
}

/**
 * acos to about 5e-5 rad (Abramowitz & Stegun 4.4.45) — two orders finer than one of 32 sectors, and
 * several times cheaper than the builtin on the per-sample path.
 */
fn fastAcos(x: f32) -> f32 {
    let a = abs(x);
    let r = sqrt(1.0 - a) * (1.5707288 + a * (-0.2121144 + a * (0.0742610 - 0.0187293 * a)));
    return select(PI - r, r, x >= 0.0);
}

/**
 * Where a direction falls in the slice's measure. `c` is its cosine to V and `side` the side of the
 * slice it was TAKEN from — the side comes from the step direction, never from the vector itself.
 *
 * Why that matters: a sample's back point is pushed `u_thickness` away from the camera, and for a
 * sample within that distance of the pixel it lands BEHIND the pixel, past 180 degrees from V. Taking
 * the side from the vector (an atan2) wraps it onto the far side, and the arc from front to back then
 * spans the whole hemisphere: every texel of a flat floor fully occluded. Measured on its own side it
 * just runs off that side's edge and covers nothing.
 *
 * G(theta) needs cos(2 theta - n), which is (2c^2 - 1) cos n + 2 s c sin n with s = sin(theta) — no
 * trig per sample beyond the one acos the linear term in G cannot do without.
 */
fn hemisphereMeasure(c: f32, side: f32, m: SliceMeasure) -> f32 {
    let cc = clamp(c, -1.0, 1.0);
    let theta = side * fastAcos(cc);
    if (theta <= m.lo) { return 0.0; }
    if (theta >= m.hi) { return 1.0; }
    let sn = side * sqrt(max(1.0 - cc * cc, 0.0));
    let g = -0.25 * ((2.0 * cc * cc - 1.0) * m.cosN + 2.0 * sn * cc * m.sinN) + 0.5 * theta * m.sinN;
    var w: f32;
    if (theta <= 0.0) { w = m.gLo - g; }
    else { w = m.below + g - m.g0; }
    return clamp(w / m.total, 0.0, 1.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let depthDims = vec2<f32>(textureDimensions(u_gDepth_texture, 0));
    let uv = snapToTexel(in.uv, depthDims);
    let depth = deviceDepth(uv);
    // Background: open sky, nothing bounced.
    if (depth >= 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }

    let P = viewPosAt(uv, depth);
    let N = viewNormalAt(uv);
    let V = -viewRay(P);

    // The search radius on screen, in full-resolution pixels: the world radius at this depth.
    // A view-space x offset moves clip x by `radius * proj[0].x` and leaves w alone, for a perspective or
    // an orthographic camera alike — so only the w row of the projection is needed here.
    let w = (u_ssil.u_projection * vec4<f32>(P, 1.0)).w;
    let radiusPx = min(abs(u_ssil.u_radius * u_ssil.u_projection[0].x / w) * 0.5 * depthDims.x,
                       u_ssil.u_maxRadiusPx);
    // Smaller than a pixel: nothing in reach can be resolved, so nothing to find.
    if (radiusPx < 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    let texel = 1.0 / depthDims;

    let px = in.position.xy;
    let sliceNoise = ign(px + 5.588238 * u_ssil.u_frame);
    let stepNoise = ign(px.yx + vec2<f32>(17.0, 37.0) + 5.588238 * u_ssil.u_frame);

    let slices = clamp(u_ssil.u_slices, 1, MAX_SLICES);
    let steps = clamp(u_ssil.u_steps, 1, MAX_STEPS);
    var visibility = 0.0;
    var lighting = vec3<f32>(0.0);
    var weightSum = 0.0;

    for (var s = 0; s < MAX_SLICES; s++) {
        if (s >= slices) { break; }
        let angle = (f32(s) + sliceNoise) / f32(slices) * PI;
        let dir = vec2<f32>(cos(angle), sin(angle));

        // The slice's in-plane axis, found by UNPROJECTING a step along `dir` at this pixel's own depth
        // rather than assumed to be view x/y. The two agree on WebGL2 and not on WebGPU, where uv runs
        // the other way up (`_uvConsuming`), and an orthographic camera has its own; asking the matrix
        // is right for all three. `T` points the way positive steps go.
        let P1 = viewPosAt(uv + dir * texel, depth);
        var T = P1 - P;
        T = T - V * dot(T, V);
        let tLen = length(T);
        if (tLen < 1e-8) { continue; }
        T = T / tLen;

        // The normal projected into this slice: its angle from V toward T places the hemisphere, and its
        // length is how much the slice counts — a slice nearly edge-on to the surface holds little of
        // what the surface can see. Clamped: a normal turned away from the camera (a normal map can do
        // it) still has its hemisphere's edge on the near side of V.
        let nT = dot(N, T);
        let nV = dot(N, V);
        let projected = sqrt(nT * nT + nV * nV);
        if (projected < 1e-4) { continue; }
        // Turned away from V (nV < 0, which a normal map can do) the clamp pins n to the horizon, where
        // its cosine is 0 and its sine is the side it leans to.
        let facingV = nV >= 0.0;
        let m = sliceMeasureFor(clamp(atan2(nT, nV), -HALF_PI, HALF_PI),
                                select(sign(nT), nT / projected, facingV),
                                select(0.0, nV / projected, facingV));
        let sliceWeight = projected * m.total;
        var sliceLight = vec3<f32>(0.0);

        var occluded = 0u;
        for (var side = 0; side < 2; side++) {
            let sgn = select(-1.0, 1.0, side == 1);
            for (var i = 0; i < MAX_STEPS; i++) {
                if (i >= steps) { break; }
                // Quadratic spacing: dense near the pixel, where contact occlusion lives. Never less than
                // one texel out, or the first sample is the pixel itself.
                let t = (f32(i) + stepNoise) / f32(steps);
                let dist = max(t * t * radiusPx, 1.0);
                let suv = snapToTexel(uv + sgn * dir * dist * texel, depthDims);
                if (any(suv < vec2<f32>(0.0)) || any(suv > vec2<f32>(1.0))) { break; }

                let sd = deviceDepth(suv);
                if (sd >= 1.0) { continue; }
                let S = viewPosAt(suv, sd);
                let delta = S - P;
                let len = length(delta);
                // Too close to tell from depth noise, or beyond the radius — the latter is what keeps a
                // foreground object far in front of this surface from occluding it at all.
                if (len < u_ssil.u_bias || len > u_ssil.u_radius) { continue; }

                let H = delta / len;
                if (dot(H, N) < HORIZON_BIAS) { continue; }
                let B = S + viewRay(S) * u_ssil.u_thickness;
                let Hb = normalize(B - P);
                let front = hemisphereMeasure(dot(H, V), sgn, m);
                let back = hemisphereMeasure(dot(Hb, V), sgn, m);
                let mask = sectorMask(min(front, back), max(front, back));
                let fresh = mask & ~occluded;

                if (fresh != 0u && u_ssil.u_hasRadiance != 0) {
                    // What this sample shows the pixel: last frame's radiance there, if that frame saw
                    // the same surface. Reprojected through last frame's camera, then checked against the
                    // depth stored beside it — a mismatch means it was hidden then and lit by guesswork.
                    let prevClip = u_ssil.u_viewToPrevClip * vec4<f32>(S, 1.0);
                    let prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
                    if (all(prevUV >= vec2<f32>(0.0)) && all(prevUV <= vec2<f32>(1.0))) {
                        let radiance = textureSampleLevel(u_radiance_texture, u_radiance_sampler, prevUV, 0.0);
                        let expected = -(u_ssil.u_viewToPrevView * vec4<f32>(S, 1.0)).z;
                        if (abs(radiance.a - expected) < 0.05 * expected + 0.05) {
                            // Only the face turned toward the pixel sends it anything. A step rather than
                            // a cosine: the stored value is already radiance, the emitter's own
                            // foreshortening is in it, and a cosine here would count it twice — a wall
                            // seen at a grazing angle from the floor at its foot is still a wall.
                            let facing = smoothstep(0.0, 0.05, dot(viewNormalAt(suv), -H));
                            sliceLight += radiance.rgb * (f32(popcount(fresh)) / SECTORS) * facing;
                        }
                    }
                }
                occluded = occluded | mask;
            }
        }
        visibility += sliceWeight * (1.0 - f32(popcount(occluded)) / SECTORS);
        lighting += sliceWeight * sliceLight;
        weightSum += sliceWeight;
    }

    if (weightSum <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    let inv = 1.0 / weightSum;
    return vec4<f32>(lighting * inv, pow(clamp(visibility * inv, 0.0, 1.0), u_ssil.u_power));
}
