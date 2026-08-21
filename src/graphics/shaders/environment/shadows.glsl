// ---------------------------------------------------------------------------------------------
// Cascaded shadow map sampling — THE single implementation, shared by every lighting path:
// deferred lighting, the forward PBR/Blinn-Phong materials, custom materials, and the volumetric
// god rays. It used to be copy-pasted five times with a hardcoded bias in each copy.
//
// TWO HARD CONSTRAINTS on this file:
//
//  1. It must not `#include` anything. The build-time include resolver never runs on it in one
//     consumer: systems/customShaders.ts imports this file as a raw string and pastes it into
//     programs it assembles at runtime, so whatever is written here has to be self-contained.
//  2. It must not redeclare anything from constants.glsl. There are no include guards in this
//     codebase, and every consumer already includes constants.glsl — a second `const int` with the
//     same name is a compile error, not a warning.
//
// The cascade maps live in ONE depth TEXTURE_2D_ARRAY with hardware depth comparison enabled, so
// `texture()` returns a bilinearly filtered VISIBILITY (1 = lit) rather than a raw depth, and every
// tap is already a 2x2 percentage-closer filter. Sampler ARRAYS cannot be dynamically indexed in
// GLSL ES 3.00; a sampler2DArray can, which is what lets the cascade count be a runtime uniform.
// ---------------------------------------------------------------------------------------------

#define MAX_CASCADES 4

uniform bool  u_shadowsEnabled;
uniform int   u_cascadeCount;
// Every declaration below is explicitly highp. This file is included by shaders with different
// DEFAULT float precisions — pbr.fs is highp, default.fs is mediump — and a mediump world position or
// light-space matrix puts the lookup off by a fraction of a world unit at map scale, which reads as
// shadows that crawl and shimmer in one material type and not the other. Shadow samplers additionally
// have no default precision at all in ES 3.00: unqualified, they are a compile error.
uniform highp sampler2DArrayShadow u_shadowCascades;
uniform highp mat4  u_cascadeMatrices[MAX_CASCADES];
uniform highp float u_cascadeSplits[MAX_CASCADES];       // view-space far distance of each cascade
uniform highp float u_cascadeDepthScale[MAX_CASCADES];   // 1 / world depth range: world bias -> depth units
uniform highp float u_cascadeTexelSize[MAX_CASCADES];    // world size of one shadow texel in this cascade
uniform highp vec2  u_shadowTexel;                       // 1 / resolution
uniform highp float u_shadowDepthBias;                   // world units, along the light
uniform highp float u_shadowNormalBias;                  // texels, along the surface normal
uniform highp float u_shadowFilterRadius;                // texels; 0 collapses the kernel to a single tap
uniform int   u_shadowFilterMode;                  // 0 = 3x3 grid, 1 = 16-tap rotated Poisson
uniform highp float u_shadowStrength;              // 0 = shadows fully lifted, 1 = fully dark
uniform highp float u_cascadeBlend;                      // fraction of a cascade's range used to cross-fade
uniform bool  u_debugCascades;                     // tint by selected cascade instead of shading

// A Poisson disk beats a grid at wide radii: a grid of few taps spread far apart shows its own
// structure as banding, while an irregular set turns the same undersampling into noise, which the
// per-pixel rotation below then breaks up across neighbouring pixels.
const highp vec2 CLEO_POISSON[16] = vec2[16](
    vec2(-0.94201624, -0.39906216), vec2( 0.94558609, -0.76890725),
    vec2(-0.09418410, -0.92938870), vec2( 0.34495938,  0.29387760),
    vec2(-0.91588581,  0.45771432), vec2(-0.81544232, -0.87912464),
    vec2(-0.38277543,  0.27676845), vec2( 0.97484398,  0.75648379),
    vec2( 0.44323325, -0.97511554), vec2( 0.53742981, -0.47373420),
    vec2(-0.26496911, -0.41893023), vec2( 0.79197514,  0.19090188),
    vec2(-0.24188840,  0.99706507), vec2(-0.81409955,  0.91437590),
    vec2( 0.19984126,  0.78641367), vec2( 0.14383161, -0.14100790)
);

/** Interleaved gradient noise — a cheap, well-distributed per-pixel rotation angle. */
highp float cleoShadowRotation() {
    return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
}

/** Which cascade covers `viewDepth` (distance in front of the camera, always positive). */
int cleoCascadeFor(highp float viewDepth) {
    int layer = u_cascadeCount - 1;
    for (int i = 0; i < MAX_CASCADES; i++) {
        if (i >= u_cascadeCount) break;
        if (viewDepth < u_cascadeSplits[i]) { layer = i; break; }
    }
    return layer;
}

/**
 * Visibility (1 = lit) of `worldPos` in one cascade.
 *
 * Both biases are expressed in world units and converted here, because the cascades have wildly
 * different scales — cascade 0 might span 30 world units of depth and cascade 3 six hundred, so one
 * raw depth constant would be twenty times too strong (or too weak) depending where a pixel landed.
 */
highp float cleoCascadeVisibility(int layer, highp vec3 worldPos, highp vec3 N) {
    // Normal offset: push the sample off the surface before projecting. This is what kills acne on
    // steeply lit geometry without the peter-panning a large depth bias would cause, since it moves
    // the lookup sideways across the shadow map rather than pulling the whole surface toward the light.
    highp vec3 p = worldPos + N * (u_shadowNormalBias * u_cascadeTexelSize[layer]);

    highp vec4 posLS = u_cascadeMatrices[layer] * vec4(p, 1.0);
    highp vec3 proj = posLS.xyz / posLS.w;
    proj = proj * 0.5 + 0.5;

    // Outside this cascade's footprint there is nothing to compare against; CLAMP_TO_EDGE would
    // otherwise smear the border texels across the whole world outside the box.
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 1.0;

    highp float ref = proj.z - u_shadowDepthBias * u_cascadeDepthScale[layer];
    highp float fLayer = float(layer);

    if (u_shadowFilterRadius <= 0.0)
        return texture(u_shadowCascades, vec4(proj.xy, fLayer, ref));

    highp vec2 texStep = u_shadowTexel * u_shadowFilterRadius;
    highp float sum = 0.0;

    if (u_shadowFilterMode == 0) {
        for (int x = -1; x <= 1; ++x)
            for (int y = -1; y <= 1; ++y)
                sum += texture(u_shadowCascades, vec4(proj.xy + vec2(x, y) * texStep, fLayer, ref));
        return sum / 9.0;
    }

    highp float a = cleoShadowRotation();
    highp vec2 rot = vec2(cos(a), sin(a));
    for (int i = 0; i < 16; i++) {
        highp vec2 o = CLEO_POISSON[i];
        highp vec2 r = vec2(o.x * rot.x - o.y * rot.y, o.x * rot.y + o.y * rot.x);
        sum += texture(u_shadowCascades, vec4(proj.xy + r * texStep, fLayer, ref));
    }
    return sum / 16.0;
}

/**
 * Shadow amount at `worldPos` — 0 is fully lit, 1 is fully shadowed (multiply light by 1 - this).
 * `viewDepth` is the positive distance in front of the camera; `N` the shading normal.
 */
highp float directionalShadow(highp vec3 worldPos, highp vec3 N, highp float viewDepth) {
    if (!u_shadowsEnabled || u_cascadeCount <= 0) return 0.0;

    int layer = cleoCascadeFor(viewDepth);
    highp float vis = cleoCascadeVisibility(layer, worldPos, N);

    // Cross-fade over the last slice of each cascade. Without it the resolution step at a split shows
    // up as a hard line across the ground, which reads as a rendering artifact rather than a shadow.
    if (u_cascadeBlend > 0.0 && layer + 1 < u_cascadeCount) {
        highp float farD = u_cascadeSplits[layer];
        highp float nearD = layer == 0 ? 0.0 : u_cascadeSplits[layer - 1];
        highp float band = u_cascadeBlend * (farD - nearD);
        if (band > 0.0) {
            highp float t = clamp((viewDepth - (farD - band)) / band, 0.0, 1.0);
            if (t > 0.0) vis = mix(vis, cleoCascadeVisibility(layer + 1, worldPos, N), t);
        }
    }

    return (1.0 - vis) * u_shadowStrength;
}

/**
 * Visibility (1 = lit) for callers with no surface normal and no filtering budget — the volumetric
 * god rays, which march up to 128 samples through empty air per pixel. A single unfiltered tap is
 * the right call twice over: there is no surface for a normal-offset bias to offset along, and the
 * march already averages many samples, so a 16-tap kernel at every step would buy nothing for 16x
 * the cost.
 */
highp float shadowVisibility(highp vec3 worldPos, highp float viewDepth) {
    if (!u_shadowsEnabled || u_cascadeCount <= 0) return 1.0;

    int layer = cleoCascadeFor(viewDepth);
    highp vec4 posLS = u_cascadeMatrices[layer] * vec4(worldPos, 1.0);
    highp vec3 proj = posLS.xyz / posLS.w;
    proj = proj * 0.5 + 0.5;
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 1.0;

    highp float ref = proj.z - u_shadowDepthBias * u_cascadeDepthScale[layer];
    return texture(u_shadowCascades, vec4(proj.xy, float(layer), ref));
}

// -------------------------------------------------------------------------------------------
// Spot-light shadows.
//
// A second depth array, one layer per shadow-casting spot light, with a PERSPECTIVE matrix per layer
// matching the light's own cone. Layers are assigned by node id, never by the light's array index —
// Scene renumbers those on any structural change (see SpotShadowSlots).
//
// CLEO_MAX_SPOTLIGHTS must match MAX_SPOTLIGHTS in constants.glsl. It is spelled differently and as a
// #define rather than a const int because this file must not redeclare anything constants.glsl owns.
// -------------------------------------------------------------------------------------------

#define MAX_SPOT_SHADOWS 4
#define CLEO_MAX_SPOTLIGHTS 8

uniform bool  u_spotShadowsEnabled;
uniform highp sampler2DArrayShadow u_spotShadows;
uniform highp mat4  u_spotShadowMatrices[MAX_SPOT_SHADOWS];
/** Per layer: 2*tan(halfFov)/resolution — one shadow texel's world size PER UNIT of distance. */
uniform highp float u_spotShadowTexelScale[MAX_SPOT_SHADOWS];
/** Atlas layer for spot light i, or -1 if it casts no shadow. Rebuilt whole, every frame. */
uniform int   u_spotShadowLayer[CLEO_MAX_SPOTLIGHTS];
uniform highp vec2  u_spotShadowTexel;
/** Constant bias in DEPTH units. Perspective depth is non-linear, so a world-unit bias would not
 *  convert with a single scale the way a cascade's orthographic depth does. */
uniform highp float u_spotShadowBias;

/**
 * Shadow amount for one spot light — 0 fully lit, 1 fully shadowed.
 *
 * The normal offset scales with distance from the light because a perspective shadow map's texel
 * covers more world the further out it lands; a fixed world offset would be far too large next to the
 * light and far too small at the end of the cone.
 */
highp float spotShadow(int layer, highp vec3 worldPos, highp vec3 N, highp vec3 lightPos) {
    if (!u_spotShadowsEnabled || layer < 0) return 0.0;

    highp float texelWorld = u_spotShadowTexelScale[layer] * distance(lightPos, worldPos);
    highp vec3 p = worldPos + N * (u_shadowNormalBias * texelWorld);

    highp vec4 posLS = u_spotShadowMatrices[layer] * vec4(p, 1.0);
    if (posLS.w <= 0.0) return 0.0;                 // behind the light
    highp vec3 proj = posLS.xyz / posLS.w;
    proj = proj * 0.5 + 0.5;
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 0.0;

    highp float ref = proj.z - u_spotShadowBias;
    highp float fLayer = float(layer);

    if (u_shadowFilterRadius <= 0.0)
        return (1.0 - texture(u_spotShadows, vec4(proj.xy, fLayer, ref))) * u_shadowStrength;

    // Always the 3x3 grid, never the 16-tap disk: this runs inside the per-spot-light loop, so its
    // cost is multiplied by the number of spot lights touching the pixel.
    highp vec2 texStep = u_spotShadowTexel * u_shadowFilterRadius;
    highp float sum = 0.0;
    for (int x = -1; x <= 1; ++x)
        for (int y = -1; y <= 1; ++y)
            sum += texture(u_spotShadows, vec4(proj.xy + vec2(x, y) * texStep, fLayer, ref));
    return (1.0 - sum / 9.0) * u_shadowStrength;
}

/** Convenience for the light loops: resolves spot light `i`'s layer and samples it. */
highp float spotShadowFor(int i, highp vec3 worldPos, highp vec3 N, highp vec3 lightPos) {
    if (!u_spotShadowsEnabled || i >= CLEO_MAX_SPOTLIGHTS) return 0.0;
    return spotShadow(u_spotShadowLayer[i], worldPos, N, lightPos);
}

/** Debug tint identifying the cascade a pixel selected. Red/green/blue/yellow, near to far. */
vec3 cascadeDebugTint(highp float viewDepth) {
    int layer = cleoCascadeFor(viewDepth);
    if (layer == 0) return vec3(1.0, 0.35, 0.35);
    if (layer == 1) return vec3(0.35, 1.0, 0.35);
    if (layer == 2) return vec3(0.35, 0.55, 1.0);
    return vec3(1.0, 0.95, 0.35);
}
