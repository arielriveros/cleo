// Decal volumes — the shared half of decalSurface.wgsl and decalColor.wgsl.
//
// A decal is an oriented box (`DecalNode`, core/scene/nodes/decalNode.ts). The renderer rasterises the
// box's BACK faces with no depth test, so every pixel whose view ray crosses the volume is shaded
// exactly once, with the camera outside the box or inside it. Nothing about the box's own surface is
// used: each fragment reads the SCENE depth under it, rebuilds the world position there, and asks
// whether that position lies inside the unit box. That is the whole projection — it is how Unreal's
// deferred decals and HDRP's DecalProjector work, and why a decal hugs whatever geometry it overlaps.
//
// NO DISCARD, anywhere. A pixel outside the volume returns zero coverage, which the premultiplied
// blends the renderer uses turn into "leave the target alone". Keeping every fragment alive keeps the
// whole stage in uniform control flow, so the derivatives below never become illegal.
//
// NO IMPLICIT DERIVATIVES either — no dpdx, no fwidth, no textureSample. Screen-space derivatives of a
// RECONSTRUCTED position explode at every silhouette (one quad neighbour sits on the wall behind), so
// the decal's uv gradients, its ring width and its geometric normal all come from explicit
// neighbour-depth taps with min-abs neighbour selection, exactly as `geometricNormal` in
// deferredLighting.wgsl does. Material maps are then read with textureSampleGrad.
//
// The including program must declare the group-0 material maps it reads; this chunk declares group 1
// (transform, material, decal blocks) and group 2 bindings 0-3 (the depth this pass reconstructs from,
// and the receiver-filter depth). Group 2 bindings 4+ are the including program's.

// --- Group 2: engine textures ---------------------------------------------------------------------
// The opaque depth to project onto: the G-buffer depth for the surface pass, the scene-depth snapshot
// for the emissive and overlay passes. Never the attachment of the pass reading it.
@group(2) @binding(0) var u_decalDepth_texture: texture_depth_2d;
@group(2) @binding(1) var u_decalDepth_sampler: sampler;
// Depth of the RECEIVERS alone (landscape chunks) for `receivers: 'terrain'`; the scene depth again
// when no decal this frame filters, so the binding is always a complete depth texture.
@group(2) @binding(2) var u_receiverDepth_texture: texture_depth_2d;
@group(2) @binding(3) var u_receiverDepth_sampler: sampler;

// --- Group 1: every uniform block, one role per binding (see chunks/modelVertex.wgsl) --------------

// Vertex stage ONLY. A block read from both stages is a GLSL link error ("Ambiguous field").
struct DecalTransform {
    u_model: mat4x4<f32>,       // unit cube -> world: worldTransform x scale(size)
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: DecalTransform;

// The projected PBR material's scalars, by the names `Renderer._applyMaterialProperties` writes
// (`u_material.<property>`). A subset of chunks/pbrGBuffer.wgsl's PBRMaterial; names the renderer sets
// that this struct does not declare are ignored by `setUniform`.
struct DecalMaterial {
    baseColor: vec3<f32>,
    emissiveFactor: vec3<f32>,
    emissiveIntensity: f32,
    metallic: f32,
    roughness: f32,
    opacity: f32,
    // i32, not bool: WGSL forbids bool in a uniform buffer.
    hasBaseColorTexture: i32,
    hasMetallicMap: i32,
    hasRoughnessMap: i32,
    hasOcclusionMap: i32,
    hasNormalMap: i32,
    hasEmissiveMap: i32,
    hasMaskMap: i32,
};
@group(1) @binding(1) var<uniform> u_material: DecalMaterial;

// Per-decal and per-pass state. Binding 4: 0-3 are transform/material/shadow/lighting everywhere.
struct DecalUniforms {
    u_decalInvModel: mat4x4<f32>,   // world -> unit box (inside = |xyz| <= 0.5)
    // Clip -> world for a clip vector built from screen uv (the renderer's `_uvConsuming` form).
    // JITTERED for the passes before the TAA resolve, the STABLE inverse for the overlay after it.
    u_invViewProj: mat4x4<f32>,
    u_decalAxisX: vec3<f32>,        // world-space box +X, normalised: the decal image's +u direction
    u_decalAxisY: vec3<f32>,        // world-space box +Y, normalised: back toward the projector
    u_viewPos: vec3<f32>,
    u_radialInner: vec4<f32>,       // LINEAR rgb + coverage at the centre
    u_radialOuter: vec4<f32>,       // ... at the rim
    u_ringColor: vec4<f32>,         // LINEAR rgb + coverage of the rim outline
    u_decalOpacity: f32,
    u_angleFade: f32,
    u_depthFade: f32,
    u_radialExponent: f32,
    u_radialFalloff: f32,           // the band curves' falloff fraction
    u_ringWidthPx: f32,
    u_radialEmissive: f32,
    u_pattern: i32,                 // 0 = material, 1 = radial gradient
    u_radialCurve: i32,             // DECAL_RADIAL_CURVES index: 0 power, 1 smooth, 2 linear, 3 sphere, 4 tip
    u_radialShape: i32,             // 0 = circle, 1 = square
    u_receiverFilter: i32,          // 1 = land only where the receiver depth says terrain
    u_affectAlbedo: i32,
    u_affectNormal: i32,
    u_affectSurface: i32,
    u_decalMode: i32,               // decalColor only: 0 = emissive, 1 = editor overlay
};
@group(1) @binding(4) var<uniform> u_decal: DecalUniforms;

// --- Vertex stage ---------------------------------------------------------------------------------

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model
                 * vec4<f32>(position, 1.0);
    return out;
}

// --- Projection -----------------------------------------------------------------------------------

/** Everything a decal fragment knows about the surface under it. */
struct DecalSample {
    /** This pixel's uv in the depth texture (pixel centre). */
    screenUv: vec2<f32>,
    /** World position of the surface under the pixel. */
    pos: vec3<f32>,
    /** The same, in unit-box space. */
    local: vec3<f32>,
    /** Decal image uv. */
    uv: vec2<f32>,
    /** uv change per pixel along screen x and y, for textureSampleGrad. */
    ddx: vec2<f32>,
    ddy: vec2<f32>,
    /** Radial pattern distance (0 on the box's vertical axis, 1 at the half-width) and its per-pixel change. */
    t: f32,
    tPerPixel: f32,
    /** Geometric surface normal from the depth taps, oriented toward the viewer. */
    geoNormal: vec3<f32>,
    /** Containment x top/bottom feather x receiver filter; 0 over the background. */
    weight: f32,
};

fn decalDepthAt(uv: vec2<f32>) -> f32 {
    return textureSampleLevel(u_decalDepth_texture, u_decalDepth_sampler, uv, 0);
}

fn decalWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_decal.u_invViewProj * clip;
    return world.xyz / world.w;
}

/** Unit-box position to decal uv. TS twin: `decalLocalToUV` in decalNode.ts. */
fn decalUv(local: vec3<f32>) -> vec2<f32> {
    return vec2<f32>(0.5 + local.x, 0.5 - local.z);
}

/**
 * The radial distance: 1 on the ellipse inscribed in the box's XZ footprint, or on the footprint's own
 * square edge (Chebyshev) for a square pattern. TS twin: `radialDecalT` in decalNode.ts.
 */
fn radialT(local: vec3<f32>) -> f32 {
    let square = max(abs(local.x), abs(local.z)) * 2.0;
    return select(length(local.xz * 2.0), square, u_decal.u_radialShape == 1);
}

/**
 * The radial gradient's weight at `t`, 0 past the rim. TS twin: `radialDecalWeight` in decalNode.ts,
 * which is in turn the terrain brush's `curveWeight` to the digit.
 *
 * Curve 0 is `pow(1 - t, exponent)`, exactly 1 for exponent 0 (a hard disc). The others hold full weight
 * over the inner `1 - falloff` of the radius and fall over the band that remains. Branches on uniforms
 * only, so the stage stays in uniform control flow.
 */
fn radialWeight(t: f32) -> f32 {
    let curve = u_decal.u_radialCurve;
    let e = u_decal.u_radialExponent;
    let f = clamp(u_decal.u_radialFalloff, 0.0, 1.0);
    // How far through the falling band `t` is: 0 at its inner edge, 1 at the rim.
    let u = clamp((t - (1.0 - f)) / max(f, 1e-4), 0.0, 1.0);
    let v = 1.0 - u;
    var w = select(pow(max(1.0 - t, 0.0), max(e, 1e-4)), 1.0, e <= 0.0);
    if (curve == 1) { w = 1.0 - u * u * (3.0 - 2.0 * u); }
    else if (curve == 2) { w = 1.0 - u; }
    else if (curve == 3) { w = sqrt(max(1.0 - u * u, 0.0)); }
    else if (curve == 4) { w = 1.0 - sqrt(max(1.0 - v * v, 0.0)); }
    let hard = (curve == 0 && e <= 0.0) || (curve != 0 && f <= 0.0);
    if (hard) { w = 1.0; }
    // The rim belongs to the pattern only for a hard edge, as in the TS twin.
    return select(select(0.0, 1.0, t <= 1.0 && hard), w, t < 1.0);
}

/**
 * The procedural radial pattern at `t`, straight alpha, linear rgb: the gradient fill from the rim
 * colour to the centre colour with a screen-constant ring over the rim.
 */
fn radialPattern(t: f32, tPerPixel: f32) -> vec4<f32> {
    let w = radialWeight(t);
    var fill = mix(u_decal.u_radialOuter, u_decal.u_radialInner, w);
    fill.a = select(0.0, fill.a, t <= 1.0);

    // The ring: `ringWidthPx` pixels wide just inside t = 1, antialiased by one pixel on each edge.
    let px = max(tPerPixel, 1e-6);
    let inward = 1.0 - t;                                   // > 0 inside the rim
    let width = u_decal.u_ringWidthPx * px;
    let ring = (1.0 - smoothstep(width, width + px, inward)) * smoothstep(-px, 0.0, inward);
    let ringA = clamp(u_decal.u_ringColor.a * ring, 0.0, 1.0);

    // Ring over fill ("over", straight alpha).
    let a = ringA + fill.a * (1.0 - ringA);
    let rgb = (u_decal.u_ringColor.rgb * ringA + fill.rgb * fill.a * (1.0 - ringA)) / max(a, 1e-5);
    return vec4<f32>(rgb, a);
}

/** Fade on surfaces turned away from the projector. 0 disables the test (lands on every orientation). */
fn decalAngleWeight(n: vec3<f32>) -> f32 {
    let facing = dot(n, u_decal.u_decalAxisY);
    return select(smoothstep(0.0, max(u_decal.u_angleFade, 1e-4), facing), 1.0,
                  u_decal.u_angleFade <= 0.0);
}

/**
 * Whether the surface under the pixel is a RECEIVER: its depth matches the receiver-only depth at the
 * same pixel, compared as camera distances with a relative tolerance (the two passes draw the same
 * triangles through different programs, so they agree to float noise, not bit-exactly). 1 when no
 * receiver filter is active.
 */
fn decalReceiverMask(screenUv: vec2<f32>, pos: vec3<f32>) -> f32 {
    let rd = textureSampleLevel(u_receiverDepth_texture, u_receiverDepth_sampler, screenUv, 0);
    let rp = decalWorldPos(screenUv, rd);
    let d = distance(pos, u_decal.u_viewPos);
    let sameSurface = abs(d - distance(rp, u_decal.u_viewPos)) <= 0.02 + 0.002 * d;
    let isReceiver = select(0.0, 1.0, sameSurface && rd < 1.0);
    return select(isReceiver, 1.0, u_decal.u_receiverFilter == 0);
}

/**
 * Project the pixel at `fragCoord` into the decal. Every tap is textureSampleLevel on the depth, so
 * this is legal anywhere; the caller still gets gradients and a normal as if it had derivatives.
 */
fn decalSample(fragCoord: vec2<f32>) -> DecalSample {
    let texel = 1.0 / vec2<f32>(textureDimensions(u_decalDepth_texture, 0));
    let uv = fragCoord * texel;
    let dx = vec2<f32>(texel.x, 0.0);
    let dy = vec2<f32>(0.0, texel.y);

    let depth = decalDepthAt(uv);
    let dL = decalDepthAt(uv - dx);
    let dR = decalDepthAt(uv + dx);
    let dU = decalDepthAt(uv - dy);
    let dD = decalDepthAt(uv + dy);

    // Min-abs neighbour selection: per axis, the neighbour whose depth is closer to the centre is the
    // one on the same surface. The sign turns either choice into a +1-pixel difference.
    let leftCloser = abs(dL - depth) < abs(dR - depth);
    let upCloser = abs(dU - depth) < abs(dD - depth);
    let pos = decalWorldPos(uv, depth);
    let posX = decalWorldPos(select(uv + dx, uv - dx, leftCloser), select(dR, dL, leftCloser));
    let posY = decalWorldPos(select(uv + dy, uv - dy, upCloser), select(dD, dU, upCloser));
    let dPdx = (posX - pos) * select(1.0, -1.0, leftCloser);
    let dPdy = (posY - pos) * select(1.0, -1.0, upCloser);

    let inv = u_decal.u_decalInvModel;
    let local = (inv * vec4<f32>(pos, 1.0)).xyz;
    let invLinear = mat3x3<f32>(inv[0].xyz, inv[1].xyz, inv[2].xyz);
    let dLx = invLinear * dPdx;
    let dLy = invLinear * dPdy;

    var s: DecalSample;
    s.screenUv = uv;
    s.pos = pos;
    s.local = local;
    s.uv = decalUv(local);
    // Clamped: a grazing surface can still produce a gradient worth several whole textures per pixel,
    // and past a quarter of the image the answer is "the smallest mip" either way.
    s.ddx = clamp(vec2<f32>(dLx.x, -dLx.z), vec2<f32>(-0.25), vec2<f32>(0.25));
    s.ddy = clamp(vec2<f32>(dLy.x, -dLy.z), vec2<f32>(-0.25), vec2<f32>(0.25));
    s.t = radialT(local);
    s.tPerPixel = abs(radialT(local + dLx) - s.t) + abs(radialT(local + dLy) - s.t);

    let n = cross(dPdx, dPdy);
    let toEye = u_decal.u_viewPos - pos;
    s.geoNormal = select(normalize(n) * select(-1.0, 1.0, dot(n, toEye) >= 0.0),
                         u_decal.u_decalAxisY, dot(n, n) < 1e-20);

    // Containment, then the feather toward the box's top and bottom faces along the projection axis.
    let inside = all(abs(local) <= vec3<f32>(0.5));
    let along = abs(local.y) * 2.0;
    let depthWeight = select(1.0 - smoothstep(1.0 - max(u_decal.u_depthFade, 1e-4), 1.0, along), 1.0,
                             u_decal.u_depthFade <= 0.0);
    let covered = inside && depth < 1.0;
    s.weight = select(0.0, depthWeight * decalReceiverMask(uv, pos), covered);
    return s;
}
