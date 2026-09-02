// Temporal antialiasing: blend this frame's jittered sample into an accumulated history, reprojected
// through the velocity buffer.
//
// The whole method in one sentence: the projection is offset by a different sub-pixel amount each
// frame (see utils/taaJitter.ts), so the accumulated image is a supersample of the pixel footprint —
// provided each pixel's history can be found again after the camera and the objects have moved, and
// provided history that no longer describes this pixel is thrown away rather than blended in. Almost
// everything below is the second half of that sentence.
//
// `cloudTemporalResolve.wgsl` is the prior art and several of its comments are the answer to a
// question this pass asks; where they overlap, this file says so rather than restating them.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/depthLinearize.wgsl"

@group(0) @binding(0) var u_current_texture: texture_2d<f32>;      // the lit scene, pre-tonemap HDR
@group(0) @binding(1) var u_current_sampler: sampler;
@group(0) @binding(2) var u_history_texture: texture_2d<f32>;      // last frame's resolved image
@group(0) @binding(3) var u_history_sampler: sampler;
@group(0) @binding(4) var u_velocity_texture: texture_2d<f32>;     // RAW screen motion, UV units
@group(0) @binding(5) var u_velocity_sampler: sampler;
@group(0) @binding(6) var u_depth_texture: texture_depth_2d;       // this frame's opaque depth
@group(0) @binding(7) var u_depth_sampler: sampler;
@group(0) @binding(8) var u_prevDepth_texture: texture_depth_2d;   // the depth that produced the history
@group(0) @binding(9) var u_prevDepth_sampler: sampler;

struct TaaUniforms {
    u_texelSize: vec2<f32>,     // 1 / render size
    u_resolution: vec2<f32>,    // render size (px)
    u_near: f32,
    u_far: f32,
    // The scene buffer is pre-tonemap linear HDR whose absolute magnitude moves with auto-exposure,
    // and the firefly suppression below is scale-dependent. Without this the weighting collapses
    // toward equality in a bright scene and toward the current frame in a dark one.
    u_exposure: f32,
    u_feedbackMin: f32,         // history weight under fast motion
    u_feedbackMax: f32,         // history weight when still
    u_varianceGamma: f32,       // how many standard deviations the clamp box spans
    u_historyValid: i32,
};
@group(1) @binding(0) var<uniform> u_taa: TaaUniforms;

fn luma(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }

// Karis' reversible tonemap. Range-compresses before the blend so one very bright sample cannot drag
// the average for thirty frames, and `untonemap` is its exact inverse: with y = x / (1 + L(x)) we get
// 1 - L(y) = 1 / (1 + L(x)), so x = y / (1 - L(y)). This is the single difference between TAA and a
// smear, and it is why the clamp below also runs in this space rather than on raw HDR.
fn tonemap(c: vec3<f32>) -> vec3<f32> { return c / (1.0 + luma(c)); }
fn untonemap(c: vec3<f32>) -> vec3<f32> { return c / max(1.0 - luma(c), 1e-4); }

// YCoCg, because the clamp wants a space where luminance is one axis. Clamping in RGB moves the three
// channels by different amounts and shifts hue on every clipped pixel; here a clip mostly trades
// brightness, which is what the eye forgives.
fn rgbToYCoCg(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
                     0.5 * c.r - 0.5 * c.b,
                     -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}

fn yCoCgToRgb(c: vec3<f32>) -> vec3<f32> {
    let t = c.x - c.z;
    return vec3<f32>(t + c.y, c.x + c.z, t - c.y);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // EVERY fetch below is `textureSampleLevel` at level 0, never `textureSample`. This function is a
    // chain of per-fragment early returns, so most of it sits in non-uniform control flow, where WGSL
    // forbids the derivative-taking form and rejects the module outright — see
    // cloudTemporalResolve.wgsl, which learned it the hard way. Note it is a hard error only on the
    // WGSL backend and silently accepted by the generated GLSL, so tests/taaResolveShader.test.ts
    // scans for it rather than trusting this comment.
    let uv = in.uv;
    let current = textureSampleLevel(u_current_texture, u_current_sampler, uv, 0.0);

    // First frame, a camera cut, a resize: there is nothing to blend with, and the pass still writes
    // this out so the next frame has a history to find.
    if (u_taa.u_historyValid == 0) { return current; }

    // ---- Where was this pixel last frame? --------------------------------------------------------
    // The velocity of the NEAREST fragment in the 3x3, not this one's. On the background side of a
    // moving silhouette the centre texel carries the background's velocity while the pixel is about to
    // be covered by the object, and reprojecting it as background is what tears thin moving edges.
    // Nine depth taps buy one correct velocity tap.
    var closestUV = uv;
    var closestDepth = 2.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let o = uv + vec2<f32>(f32(x), f32(y)) * u_taa.u_texelSize;
            let d = textureSampleLevel(u_depth_texture, u_depth_sampler, o, 0);
            if (d < closestDepth) { closestDepth = d; closestUV = o; }
        }
    }

    // `.z` is the motion-blur opt-out flag and is deliberately NOT read here. It used to arrive with a
    // zeroed `.xy`, which would have forced this pass to discard history for those objects; the
    // encoder now keeps the true velocity and TileMax skips the flagged texels instead, so an object
    // excluded from motion blur is still antialiased. See chunks/objectVelocity.wgsl.
    let motion = textureSampleLevel(u_velocity_texture, u_velocity_sampler, closestUV, 0.0);

    // `.w = 0` marks a vector that is deliberately NOT the screen-space delta: the 'objectOnly' blur
    // mode divides the camera term out on purpose. Reprojecting through it under a moving camera would
    // fetch the wrong history and ghost the object, so it forfeits temporal AA and stays aliased.
    if (motion.w < 0.5) { return current; }

    let velocity = motion.xy;
    let prevUV = uv - velocity;

    // Off screen last frame: no history existed to accumulate.
    if (any(prevUV < vec2<f32>(0.0)) || any(prevUV > vec2<f32>(1.0))) { return current; }

    // ---- Is that history still describing this surface? ------------------------------------------
    // On LINEARIZED depth, with a RELATIVE tolerance. Device depth cannot work: it is so compressed
    // toward 1.0 that a mesh at 20 m and the sky behind it differ by thousandths, so any epsilon loose
    // enough to keep genuine same-surface neighbours also admits the sky (cloudTemporalResolve.wgsl
    // makes the same argument at length). Relative, because under camera motion the same surface
    // legitimately changes depth — a fixed epsilon would reject everything far away or nothing nearby.
    // This is what the previous-depth buffer exists for, and it closes the one residual the cloud
    // resolve documents and cannot fix: a pixel that was BEHIND geometry last frame and is sky now.
    let linCur = linearizeDepth(textureSampleLevel(u_depth_texture, u_depth_sampler, uv, 0),
                                u_taa.u_near, u_taa.u_far);
    let linPrev = linearizeDepth(textureSampleLevel(u_prevDepth_texture, u_prevDepth_sampler, prevUV, 0),
                                 u_taa.u_near, u_taa.u_far);
    if (abs(linCur - linPrev) > max(0.02 * linCur, 0.1)) { return current; }

    // ---- Constrain the history to colours this neighbourhood could plausibly produce -------------
    // Variance clipping, intersected with the true min/max box. The box on its own is defined by its
    // outliers, so a single firefly widens it until it constrains nothing — which is the mechanism by
    // which HDR TAA ghosts. The mean and variance cost nothing extra here: the taps are already
    // fetched for the box.
    let exposure = max(u_taa.u_exposure, 1e-4);
    var m1 = vec3<f32>(0.0);
    var m2 = vec3<f32>(0.0);
    var boxMin = vec3<f32>(1e9);
    var boxMax = vec3<f32>(-1e9);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let o = uv + vec2<f32>(f32(x), f32(y)) * u_taa.u_texelSize;
            let s = textureSampleLevel(u_current_texture, u_current_sampler, o, 0.0).rgb;
            let c = rgbToYCoCg(tonemap(s * exposure));
            m1 += c;
            m2 += c * c;
            boxMin = min(boxMin, c);
            boxMax = max(boxMax, c);
        }
    }
    let mu = m1 / 9.0;
    let sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3<f32>(0.0)));
    let lo = max(mu - u_taa.u_varianceGamma * sigma, boxMin);
    let hi = min(mu + u_taa.u_varianceGamma * sigma, boxMax);

    // CLIP toward the centre along the segment, rather than clamping per component. A per-component
    // clamp moves the three axes by different amounts and changes the colour's hue on every pixel it
    // touches; this moves it along the line it already sat on and only shortens it.
    var history = rgbToYCoCg(tonemap(
        textureSampleLevel(u_history_texture, u_history_sampler, prevUV, 0.0).rgb * exposure));
    let centre = 0.5 * (lo + hi);
    let extent = max(0.5 * (hi - lo), vec3<f32>(1e-5));
    let offset = history - centre;
    let reach = abs(offset / extent);
    let worst = max(reach.x, max(reach.y, reach.z));
    if (worst > 1.0) { history = centre + offset / worst; }

    // ---- Blend -----------------------------------------------------------------------------------
    // In tonemapped space, which is where the range compression above does its work. Less history
    // under fast motion: the reprojection is least trustworthy exactly when the image is moving too
    // fast for the eye to resolve the aliasing anyway, so trading convergence for a lack of ghosting
    // is free there and nowhere else. 20 px is one motion-blur tile, for no deeper reason than that
    // both are "far enough that a pixel has left its own neighbourhood".
    let velocityPx = length(velocity * u_taa.u_resolution);
    let feedback = mix(u_taa.u_feedbackMax, u_taa.u_feedbackMin, clamp(velocityPx / 20.0, 0.0, 1.0));

    let currentYCoCg = rgbToYCoCg(tonemap(current.rgb * exposure));
    let resolved = untonemap(yCoCgToRgb(mix(currentYCoCg, history, feedback))) / exposure;

    // Alpha is the BLOOM MASK, not coverage, and it passes through unfiltered. Temporally filtering a
    // mask that only ever feeds a blur buys nothing, and clamping it against a colour neighbourhood
    // would not even be meaningful.
    return vec4<f32>(resolved, current.a);
}
