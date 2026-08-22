// ---------------------------------------------------------------------------------------------
// Cascaded shadow map sampling — THE single implementation, shared by every lighting path: deferred
// lighting, the forward PBR/Blinn-Phong materials, custom materials, and the volumetric god rays.
//
// This is the WGSL original. The GLSL that custom materials need is GENERATED from it at build time —
// see shadowsChunk.wgsl and tools/wgslTranslate.mjs `extractGlslChunk`. Custom materials assemble
// user-authored GLSL at runtime and paste the library in as text, so a GLSL form has to exist; keeping
// it as a second hand-written copy would mean maintaining this file's bias and cascade arithmetic
// twice, and the failure mode of drift here is shadows that shimmer in one material type and not
// another.
//
// TWO CONSTRAINTS carried over from the GLSL original:
//
//  1. Nothing here may collide with constants.glsl (MAX_POINT_LIGHTS, MAX_SPOTLIGHTS, MAX_BONES) or
//     with the custom-material prelude, which declares those too. There are no include guards, and in
//     the generated chunk a duplicate `const int` is a compile error. Hence CLEO_MAX_SPOTLIGHTS.
//  2. It must be self-contained. The generated chunk is pasted into a program this file knows nothing
//     about.
//
// The cascade maps live in ONE depth texture array with hardware comparison enabled, so a sample
// returns a bilinearly filtered VISIBILITY (1 = lit) rather than a raw depth, and every tap is already
// a 2x2 percentage-closer filter.
// ---------------------------------------------------------------------------------------------

const MAX_CASCADES: i32 = 4;
const MAX_SPOT_SHADOWS: i32 = 4;
const CLEO_MAX_SPOTLIGHTS: i32 = 8;

@group(3) @binding(0) var u_shadowCascades_texture: texture_depth_2d_array;
@group(3) @binding(1) var u_shadowCascades_sampler: sampler_comparison;
@group(3) @binding(2) var u_spotShadows_texture: texture_depth_2d_array;
@group(3) @binding(3) var u_spotShadows_sampler: sampler_comparison;

/**
 * Per-cascade scalars are packed into vec4s, one lane per cascade.
 *
 * Not a style choice: WGSL forbids an array whose element stride is under 16 bytes in the uniform
 * address space, so `array<f32, 4>` is rejected outright. std140 pads such an array to a vec4 stride
 * anyway, so the packed form occupies exactly the same bytes the loose GLSL declaration always did —
 * and the renderer's `Float32Array(4)` upload lands correctly with no change at the call site.
 */
struct ShadowUniforms {
    u_cascadeMatrices: array<mat4x4<f32>, 4>,
    u_spotShadowMatrices: array<mat4x4<f32>, 4>,

    u_cascadeSplits: array<vec4<f32>, 1>,       // view-space far distance of each cascade
    u_cascadeDepthScale: array<vec4<f32>, 1>,   // 1 / world depth range: world bias -> depth units
    u_cascadeTexelSize: array<vec4<f32>, 1>,    // world size of one shadow texel in this cascade
    u_spotShadowTexelScale: array<vec4<f32>, 1>,// per layer: 2*tan(halfFov)/resolution
    // Atlas layer for spot light i, or -1 if it casts no shadow. Eight ints, two lanes of four.
    u_spotShadowLayer: array<vec4<i32>, 2>,

    u_shadowTexel: vec2<f32>,                   // 1 / resolution
    u_spotShadowTexel: vec2<f32>,

    u_shadowDepthBias: f32,                     // world units, along the light
    u_shadowNormalBias: f32,                    // texels, along the surface normal
    u_shadowFilterRadius: f32,                  // texels; 0 collapses the kernel to a single tap
    u_shadowStrength: f32,                      // 0 = shadows fully lifted, 1 = fully dark
    u_cascadeBlend: f32,                        // fraction of a cascade's range used to cross-fade
    u_spotShadowBias: f32,                      // constant bias in DEPTH units (perspective depth is
                                                // non-linear, so no single world scale converts it)
    u_cascadeCount: i32,
    u_shadowFilterMode: i32,                    // 0 = 3x3 grid, 1 = 16-tap rotated Poisson
    // i32 rather than bool throughout: WGSL forbids bool in a uniform buffer. Call sites still pass
    // JavaScript booleans; the std140 writer converts them.
    u_shadowsEnabled: i32,
    u_debugCascades: i32,                       // tint by selected cascade instead of shading
    u_spotShadowsEnabled: i32,
};
@group(4) @binding(0) var<uniform> u_shadow: ShadowUniforms;

/**
 * The fragment coordinate, published by the entry point.
 *
 * Only an entry point receives `@builtin(position)`; a WGSL helper cannot reach it the way GLSL's
 * `gl_FragCoord` is visible everywhere. A private module-scope var keeps `cleoShadowRotation()`
 * argument-free, which matters because the generated GLSL chunk has to preserve the zero-argument
 * `shadowCalculation()` that user-authored custom materials already call.
 *
 * Every consumer must set this before calling into the library.
 */
var<private> cleoFragCoord: vec2<f32>;

/** Interleaved gradient noise — a cheap, well-distributed per-pixel rotation angle. */
fn cleoShadowRotation() -> f32 {
    return fract(52.9829189 * fract(dot(cleoFragCoord, vec2<f32>(0.06711056, 0.00583715)))) * 6.2831853;
}

/**
 * A Poisson disk beats a grid at wide radii: a grid of few taps spread far apart shows its own
 * structure as banding, while an irregular set turns the same undersampling into noise, which the
 * per-pixel rotation then breaks up across neighbouring pixels.
 */
fn cleoPoisson(i: i32) -> vec2<f32> {
    var disk = array<vec2<f32>, 16>(
        vec2<f32>(-0.94201624, -0.39906216), vec2<f32>( 0.94558609, -0.76890725),
        vec2<f32>(-0.09418410, -0.92938870), vec2<f32>( 0.34495938,  0.29387760),
        vec2<f32>(-0.91588581,  0.45771432), vec2<f32>(-0.81544232, -0.87912464),
        vec2<f32>(-0.38277543,  0.27676845), vec2<f32>( 0.97484398,  0.75648379),
        vec2<f32>( 0.44323325, -0.97511554), vec2<f32>( 0.53742981, -0.47373420),
        vec2<f32>(-0.26496911, -0.41893023), vec2<f32>( 0.79197514,  0.19090188),
        vec2<f32>(-0.24188840,  0.99706507), vec2<f32>(-0.81409955,  0.91437590),
        vec2<f32>( 0.19984126,  0.78641367), vec2<f32>( 0.14383161, -0.14100790),
    );
    return disk[i];
}

/** Lane accessors for the vec4-packed per-cascade scalars. */
fn cleoSplit(i: i32) -> f32 { return u_shadow.u_cascadeSplits[0][i]; }
fn cleoDepthScale(i: i32) -> f32 { return u_shadow.u_cascadeDepthScale[0][i]; }
fn cleoTexelSize(i: i32) -> f32 { return u_shadow.u_cascadeTexelSize[0][i]; }
fn cleoSpotTexelScale(i: i32) -> f32 { return u_shadow.u_spotShadowTexelScale[0][i]; }
fn cleoSpotLayer(i: i32) -> i32 { return u_shadow.u_spotShadowLayer[i / 4][i % 4]; }

/** Which cascade covers `viewDepth` (distance in front of the camera, always positive). */
fn cleoCascadeFor(viewDepth: f32) -> i32 {
    var layer = u_shadow.u_cascadeCount - 1;
    for (var i = 0; i < MAX_CASCADES; i++) {
        if (i >= u_shadow.u_cascadeCount) { break; }
        if (viewDepth < cleoSplit(i)) { layer = i; break; }
    }
    return layer;
}

/** One comparison tap against the cascade array. Returns visibility, 1 = lit. */
fn cleoCascadeTap(uv: vec2<f32>, layer: i32, refDepth: f32) -> f32 {
    return textureSampleCompareLevel(u_shadowCascades_texture, u_shadowCascades_sampler, uv, layer, refDepth);
}

/**
 * Visibility (1 = lit) of `worldPos` in one cascade.
 *
 * Both biases are expressed in world units and converted here, because the cascades have wildly
 * different scales — cascade 0 might span 30 world units of depth and cascade 3 six hundred, so one raw
 * depth constant would be twenty times too strong (or too weak) depending where a pixel landed.
 */
fn cleoCascadeVisibility(layer: i32, worldPos: vec3<f32>, N: vec3<f32>) -> f32 {
    // Normal offset: push the sample off the surface before projecting. This is what kills acne on
    // steeply lit geometry without the peter-panning a large depth bias would cause, since it moves the
    // lookup sideways across the shadow map rather than pulling the whole surface toward the light.
    let p = worldPos + N * (u_shadow.u_shadowNormalBias * cleoTexelSize(layer));

    let posLS = u_shadow.u_cascadeMatrices[layer] * vec4<f32>(p, 1.0);
    var proj = posLS.xyz / posLS.w;
    proj = proj * 0.5 + 0.5;

    // Outside this cascade's footprint there is nothing to compare against; clamp-to-edge would
    // otherwise smear the border texels across the whole world outside the box.
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) { return 1.0; }

    let refDepth = proj.z - u_shadow.u_shadowDepthBias * cleoDepthScale(layer);

    if (u_shadow.u_shadowFilterRadius <= 0.0) {
        return cleoCascadeTap(proj.xy, layer, refDepth);
    }

    let texStep = u_shadow.u_shadowTexel * u_shadow.u_shadowFilterRadius;
    var sum = 0.0;

    if (u_shadow.u_shadowFilterMode == 0) {
        for (var x = -1; x <= 1; x++) {
            for (var y = -1; y <= 1; y++) {
                sum += cleoCascadeTap(proj.xy + vec2<f32>(f32(x), f32(y)) * texStep, layer, refDepth);
            }
        }
        return sum / 9.0;
    }

    let a = cleoShadowRotation();
    let rot = vec2<f32>(cos(a), sin(a));
    for (var i = 0; i < 16; i++) {
        let o = cleoPoisson(i);
        let r = vec2<f32>(o.x * rot.x - o.y * rot.y, o.x * rot.y + o.y * rot.x);
        sum += cleoCascadeTap(proj.xy + r * texStep, layer, refDepth);
    }
    return sum / 16.0;
}

/**
 * Shadow amount at `worldPos` — 0 is fully lit, 1 is fully shadowed (multiply light by 1 - this).
 * `viewDepth` is the positive distance in front of the camera; `N` the shading normal.
 */
fn directionalShadow(worldPos: vec3<f32>, N: vec3<f32>, viewDepth: f32) -> f32 {
    if (u_shadow.u_shadowsEnabled == 0 || u_shadow.u_cascadeCount <= 0) { return 0.0; }

    let layer = cleoCascadeFor(viewDepth);
    var vis = cleoCascadeVisibility(layer, worldPos, N);

    // Cross-fade over the last slice of each cascade. Without it the resolution step at a split shows
    // up as a hard line across the ground, which reads as a rendering artifact rather than a shadow.
    if (u_shadow.u_cascadeBlend > 0.0 && layer + 1 < u_shadow.u_cascadeCount) {
        let farD = cleoSplit(layer);
        var nearD = 0.0;
        if (layer != 0) { nearD = cleoSplit(layer - 1); }
        let band = u_shadow.u_cascadeBlend * (farD - nearD);
        if (band > 0.0) {
            let t = clamp((viewDepth - (farD - band)) / band, 0.0, 1.0);
            if (t > 0.0) { vis = mix(vis, cleoCascadeVisibility(layer + 1, worldPos, N), t); }
        }
    }

    return (1.0 - vis) * u_shadow.u_shadowStrength;
}

/**
 * Visibility (1 = lit) for callers with no surface normal and no filtering budget — the volumetric god
 * rays, which march up to 128 samples through empty air per pixel. A single unfiltered tap is the right
 * call twice over: there is no surface for a normal-offset bias to offset along, and the march already
 * averages many samples, so a 16-tap kernel at every step would buy nothing for 16x the cost.
 */
fn shadowVisibility(worldPos: vec3<f32>, viewDepth: f32) -> f32 {
    if (u_shadow.u_shadowsEnabled == 0 || u_shadow.u_cascadeCount <= 0) { return 1.0; }

    let layer = cleoCascadeFor(viewDepth);
    let posLS = u_shadow.u_cascadeMatrices[layer] * vec4<f32>(worldPos, 1.0);
    var proj = posLS.xyz / posLS.w;
    proj = proj * 0.5 + 0.5;
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) { return 1.0; }

    let refDepth = proj.z - u_shadow.u_shadowDepthBias * cleoDepthScale(layer);
    return cleoCascadeTap(proj.xy, layer, refDepth);
}

// -------------------------------------------------------------------------------------------
// Spot-light shadows.
//
// A second depth array, one layer per shadow-casting spot light, with a PERSPECTIVE matrix per layer
// matching the light's own cone. Layers are assigned by node id, never by the light's array index —
// Scene renumbers those on any structural change (see SpotShadowSlots).
// -------------------------------------------------------------------------------------------

fn cleoSpotTap(uv: vec2<f32>, layer: i32, refDepth: f32) -> f32 {
    return textureSampleCompareLevel(u_spotShadows_texture, u_spotShadows_sampler, uv, layer, refDepth);
}

/**
 * Shadow amount for one spot light — 0 fully lit, 1 fully shadowed.
 *
 * The normal offset scales with distance from the light because a perspective shadow map's texel covers
 * more world the further out it lands; a fixed world offset would be far too large next to the light and
 * far too small at the end of the cone.
 */
fn spotShadow(layer: i32, worldPos: vec3<f32>, N: vec3<f32>, lightPos: vec3<f32>) -> f32 {
    if (u_shadow.u_spotShadowsEnabled == 0 || layer < 0) { return 0.0; }

    let texelWorld = cleoSpotTexelScale(layer) * distance(lightPos, worldPos);
    let p = worldPos + N * (u_shadow.u_shadowNormalBias * texelWorld);

    let posLS = u_shadow.u_spotShadowMatrices[layer] * vec4<f32>(p, 1.0);
    if (posLS.w <= 0.0) { return 0.0; }                 // behind the light
    var proj = posLS.xyz / posLS.w;
    proj = proj * 0.5 + 0.5;
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) { return 0.0; }

    let refDepth = proj.z - u_shadow.u_spotShadowBias;

    if (u_shadow.u_shadowFilterRadius <= 0.0) {
        return (1.0 - cleoSpotTap(proj.xy, layer, refDepth)) * u_shadow.u_shadowStrength;
    }

    // Always the 3x3 grid, never the 16-tap disk: this runs inside the per-spot-light loop, so its cost
    // is multiplied by the number of spot lights touching the pixel.
    let texStep = u_shadow.u_spotShadowTexel * u_shadow.u_shadowFilterRadius;
    var sum = 0.0;
    for (var x = -1; x <= 1; x++) {
        for (var y = -1; y <= 1; y++) {
            sum += cleoSpotTap(proj.xy + vec2<f32>(f32(x), f32(y)) * texStep, layer, refDepth);
        }
    }
    return (1.0 - sum / 9.0) * u_shadow.u_shadowStrength;
}

/** Convenience for the light loops: resolves spot light `i`'s layer and samples it. */
fn spotShadowFor(i: i32, worldPos: vec3<f32>, N: vec3<f32>, lightPos: vec3<f32>) -> f32 {
    if (u_shadow.u_spotShadowsEnabled == 0 || i >= CLEO_MAX_SPOTLIGHTS) { return 0.0; }
    return spotShadow(cleoSpotLayer(i), worldPos, N, lightPos);
}

/** Debug tint identifying the cascade a pixel selected. Red/green/blue/yellow, near to far. */
fn cascadeDebugTint(viewDepth: f32) -> vec3<f32> {
    let layer = cleoCascadeFor(viewDepth);
    if (layer == 0) { return vec3<f32>(1.0, 0.35, 0.35); }
    if (layer == 1) { return vec3<f32>(0.35, 1.0, 0.35); }
    if (layer == 2) { return vec3<f32>(0.35, 0.55, 1.0); }
    return vec3<f32>(1.0, 0.95, 0.35);
}
