// The landscape layer stack: up to MAX_TERRAIN_SURFACES surfaces composited front to back.
//
// Shared by the deferred pass (geometryTerrain) and the forward one (terrainForward). A consumer
// includes this, calls `resolveTerrainSurface()`, and shades however it likes. The CPU twin of every
// function below lives in `src/terrain/terrainLayers.ts`, which says which one it mirrors; foliage
// scatter and coverage queries run that copy, so the two must agree.
//
// THE MODEL (see terrainLayers.ts for the long form). A landscape has a BASE layer covering everything
// and a stack of PAINT layers over it; each layer is a landscape material, and each material is a list
// of SLOTS. Flattened, that is an ordered list of SURFACES, bottom to top. A surface's alpha is its
// layer's paint mask times its blend rule (elevation, slope, noise, height blend, opacity), and each
// surface is laid OVER everything below it. Erasing a road reveals whatever was under it.
//
// THREE TEXTURES, WHATEVER THE SURFACE COUNT. Every surface's albedo+AO and normal+height live in two
// 2D ARRAYS at one common size (built by TexturePacker.bakeInto), and the paint masks in a third, four
// layers per RGBA slice. The old stack bound nine textures for four layers; this binds three for
// sixteen, which is the whole reason more slots became possible at all.
//
// FRONT TO BACK, WITH AN EARLY OUT. Iterating top-down, each surface takes its alpha of whatever is
// still uncovered, and the loop stops once nothing is. The base surface covers, so a fragment pays for
// the surfaces actually visible there — typically two or three — not for the stack.
//
// NO IMPLICIT DERIVATIVE BELOW THE FIRST TWO LINES. `dpdx`/`dpdy` are taken once, in uniform control
// flow; every fetch after that is `textureSampleGrad`, which WGSL permits in the per-fragment branches
// and the data-dependent `continue`/`break` this loop is made of.

@group(0) @binding(0) var u_masks_texture: texture_2d_array<f32>;
@group(0) @binding(1) var u_masks_sampler: sampler;
@group(0) @binding(2) var u_surfAlbedo_texture: texture_2d_array<f32>;
@group(0) @binding(3) var u_surfAlbedo_sampler: sampler;
@group(0) @binding(4) var u_surfNormal_texture: texture_2d_array<f32>;
@group(0) @binding(5) var u_surfNormal_sampler: sampler;

/** Mirrors `MAX_TERRAIN_SURFACES` in terrainLayers.ts. The arrays below are sized by it. */
const MAX_TERRAIN_SURFACES: i32 = 16;
/** Mirrors `SURFACE_EPSILON`: below this a surface is not sampled at all. */
const SURFACE_EPSILON: f32 = 1e-3;
/** Mirrors `RANGE_FALLOFF_MIN`: a zero falloff is a hard edge, but smoothstep may not have equal edges. */
const RANGE_FALLOFF_MIN: f32 = 1e-4;
/** Smallest usable tiling, as the old stack had it. */
const TILING_EPSILON: f32 = 0.01;
/** Once less than this is uncovered, nothing further down can change the fragment visibly. */
const REMAINING_EPSILON: f32 = 0.004;

// Every per-surface member is a parallel `array<vec4<f32>, 16>` rather than an array of structs, and
// none of their names ends in a digit: `UniformBlockSet` writes arrays by name with the driver's own
// stride, and strips one trailing underscore off digit-final names naga escapes. Parallel vec4 arrays
// are the shape the bone and cascade arrays already use, so no new reflection path is involved.
struct TerrainUniforms {
    /** Shown wherever nothing covers — a landscape with no base material yet. sRGB. */
    u_baseColor: vec3<f32>,
    /**
     * Camera world position, the specular V in terrainForward. In THIS block, fragment-only, because a
     * uniform block read from both stages breaks naga's GLSL (see the old stack for the long story).
     */
    u_viewPos: vec3<f32>,
    /** Geometric specular antialiasing on/off; renderer state, see filterSpecularRoughness. */
    u_specularAA: i32,
    /** Surfaces in use, 0..MAX_TERRAIN_SURFACES. */
    u_surfCount: i32,
    /**
     * Authoring view. -1 = off. >= 0 = heat map of that surface's final weight. -2 = every surface in a
     * colour of its own, weighted — the "which layer is where" view.
     */
    u_debugSurface: i32,
    /**
     * Elevation in rule units = fragPos.y * x + y. On a landscape (1, -origin.y): metres above its
     * origin, so moving the landscape does not move its snow line. A preview remaps its small subject
     * onto the material's rule span instead.
     */
    u_elevRemap: vec2<f32>,
    /** rgb = tint (sRGB), a = 1 when the height map is a DEPTH map (white = deep). */
    u_surfColor: array<vec4<f32>, 16>,
    /** x = metallic, y = roughness, z = tiling, w = mask channel (>= 0), -1 = no mask, -2 = fill. */
    u_surfMaterial: array<vec4<f32>, 16>,
    /** Which packed maps are real rather than neutral: albedo, AO, normal, height. 0/1 each. */
    u_surfFlags: array<vec4<f32>, 16>,
    /** Elevation band: min, max, falloff (metres), enabled 0/1. */
    u_surfElevation: array<vec4<f32>, 16>,
    /** Slope band: min, max, falloff (DEGREES), enabled 0/1. */
    u_surfSlope: array<vec4<f32>, 16>,
    /** Noise: amount 0..1, 1/scale (1/metres), seed offset x, seed offset z. */
    u_surfNoise: array<vec4<f32>, 16>,
    /** x = height blend 0..1, y = opacity 0..1 (layer opacity already multiplied in). zw unused. */
    u_surfBlend: array<vec4<f32>, 16>,
};
@group(1) @binding(1) var<uniform> u_terrain: TerrainUniforms;

/** What the layer stack resolves to at one fragment, before any lighting. */
struct TerrainSurface {
    albedo: vec3<f32>,
    ao: f32,
    metallic: f32,
    roughness: f32,
    normal: vec3<f32>,
};

/** Mirrors `rangeCoverage`: 1 inside min..max, a smoothstep fade to 0 across the falloff outside. */
fn rangeCoverage(r: vec4<f32>, v: f32) -> f32 {
    if (r.w < 0.5) { return 1.0; }
    let f = max(r.z, RANGE_FALLOFF_MIN);
    let lo = smoothstep(r.x - f, r.x, v);
    let hi = 1.0 - smoothstep(r.y, r.y + f, v);
    return lo * hi;
}

/** Mirrors `slopeDegreesFromNormalY`: 0 facing up, 90 vertical, undersides clamped to 90. */
fn slopeDegrees(ny: f32) -> f32 {
    return degrees(acos(clamp(ny, 0.0, 1.0)));
}

/** Mirrors `transitionShift`: moves a partial coverage, never a full or an absent one. */
fn transitionShift(a: f32, t: f32, strength: f32) -> f32 {
    return clamp(a + 4.0 * a * (1.0 - a) * t * strength, 0.0, 1.0);
}

/** Mirrors `hash12` (Hoskins, hash without sine). */
fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

/** Mirrors `valueNoise`. */
fn valueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash12(i);
    let b = hash12(i + vec2<f32>(1.0, 0.0));
    let c = hash12(i + vec2<f32>(0.0, 1.0));
    let d = hash12(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Mirrors `ruleNoise`, with the seed offsets pre-multiplied on the CPU. */
fn ruleNoise(noise: vec4<f32>, worldXZ: vec2<f32>) -> f32 {
    let p = worldXZ * noise.y + noise.zw;
    return 0.62 * valueNoise(p) + 0.38 * valueNoise(p * 2.13 + vec2<f32>(5.2, 1.7));
}

/** A colour of its own per surface index, for the -2 debug view. */
fn surfaceDebugColor(i: i32) -> vec3<f32> {
    let h = fract(f32(i) * 0.61803398875);
    let k = vec3<f32>(0.0, 2.0 / 3.0, 1.0 / 3.0);
    return clamp(abs(fract(vec3<f32>(h) + k) * 6.0 - 3.0) - 1.0, vec3<f32>(0.0), vec3<f32>(1.0));
}

/**
 * Composite the stack at this fragment.
 *
 * `baseUv` is the landscape's own 0..1 chart (the paint masks live in it); each surface tiles it by its
 * own tiling. `fragPos` feeds the elevation rule and the noise, `tbn[2]` the slope rule.
 */
fn resolveTerrainSurface(fragPos: vec3<f32>, baseUv: vec2<f32>, tbn: mat3x3<f32>) -> TerrainSurface {
    // The only derivatives in this file, taken where control flow is still uniform.
    let ddxUv = dpdx(baseUv);
    let ddyUv = dpdy(baseUv);

    let nGeom = normalize(tbn[2]);
    let elevation = fragPos.y * u_terrain.u_elevRemap.x + u_terrain.u_elevRemap.y;
    let slope = slopeDegrees(nGeom.y);

    var albedo = vec3<f32>(0.0);
    var ao = 0.0;
    var metallic = 0.0;
    var roughness = 0.0;
    var normal = vec3<f32>(0.0);
    var remaining = 1.0;
    var debugWeight = 0.0;
    var debugColor = vec3<f32>(0.0);

    // One RGBA mask slice holds four layers; consecutive surfaces usually share one, so it is fetched
    // once per slice change rather than once per surface.
    var masks = vec4<f32>(0.0);
    var maskSlice = -1;

    let count = min(u_terrain.u_surfCount, MAX_TERRAIN_SURFACES);
    for (var i = count - 1; i >= 0; i--) {
        let material = u_terrain.u_surfMaterial[i];
        let maskChannel = i32(round(material.w));
        let fill = maskChannel == -2;

        var a = 1.0;
        if (!fill) {
            if (maskChannel >= 0) {
                let slice = maskChannel / 4;
                if (slice != maskSlice) {
                    masks = textureSampleGrad(u_masks_texture, u_masks_sampler, baseUv, slice, ddxUv, ddyUv);
                    maskSlice = slice;
                }
                a = masks[maskChannel % 4];
            }
            a *= rangeCoverage(u_terrain.u_surfElevation[i], elevation)
               * rangeCoverage(u_terrain.u_surfSlope[i], slope);
            let noise = u_terrain.u_surfNoise[i];
            if (noise.x > 0.0) { a = transitionShift(a, ruleNoise(noise, fragPos.xz) * 2.0 - 1.0, noise.x); }
        }
        // transitionShift cannot lift a near-zero coverage (its weight is 4a(1-a)), so nothing below can
        // bring this surface back: skip it without sampling a texel.
        if (a <= SURFACE_EPSILON) { continue; }

        let tiling = max(material.z, TILING_EPSILON);
        let uv = baseUv * tiling;
        let gx = ddxUv * tiling;
        let gy = ddyUv * tiling;
        let flags = u_terrain.u_surfFlags[i];
        let color = u_terrain.u_surfColor[i];

        var alb = toLinear(color.rgb);
        var occlusion = 1.0;
        if (flags.x > 0.5 || flags.y > 0.5) {
            let texel = textureSampleGrad(u_surfAlbedo_texture, u_surfAlbedo_sampler, uv, i, gx, gy);
            // Albedo is sRGB and occlusion linear, so only the rgb goes through toLinear.
            if (flags.x > 0.5) { alb *= toLinear(texel.rgb); }
            if (flags.y > 0.5) { occlusion = texel.a; }
        }

        var n = tbn[2];
        var height = 0.5;
        if (flags.z > 0.5 || flags.w > 0.5) {
            let texel = textureSampleGrad(u_surfNormal_texture, u_surfNormal_sampler, uv, i, gx, gy);
            // The interpolated tbn, whose bitangent sign is the engine-wide green-channel convention.
            if (flags.z > 0.5) { n = normalize(tbn * (texel.rgb * 2.0 - 1.0)); }
            if (flags.w > 0.5) { height = select(texel.a, 1.0 - texel.a, color.a > 0.5); }
        }

        let blend = u_terrain.u_surfBlend[i];
        if (!fill) {
            // Mirrors `surfaceAlpha`'s order: range tests and noise above, then height, then opacity.
            if (blend.x > 0.0) { a = transitionShift(a, height * 2.0 - 1.0, blend.x); }
            a *= clamp(blend.y, 0.0, 1.0);
        }

        let w = a * remaining;
        albedo += w * alb;
        ao += w * occlusion;
        metallic += w * material.x;
        roughness += w * material.y;
        normal += w * n;
        if (i == u_terrain.u_debugSurface) { debugWeight = w; }
        debugColor += w * surfaceDebugColor(i);
        remaining *= 1.0 - a;
        if (remaining <= REMAINING_EPSILON) { break; }
    }

    // Whatever nothing covered shows the landscape's flat base colour — only possible with no base
    // material, since the base surface's alpha is 1.
    if (remaining > 0.0) {
        albedo += remaining * toLinear(u_terrain.u_baseColor);
        ao += remaining;
        roughness += remaining * 0.9;
        normal += remaining * nGeom;
    }

    var out: TerrainSurface;
    out.albedo = albedo;
    out.ao = ao;
    out.metallic = metallic;
    out.roughness = roughness;
    let len = length(normal);
    out.normal = select(nGeom, normal / len, len > 1e-5);

    // Authoring views. Unlit colour would read better, but the G-buffer has no such channel, so the
    // view is carried in albedo and lit like the ground it describes.
    if (u_terrain.u_debugSurface >= 0) {
        out.albedo = mix(vec3<f32>(0.02, 0.02, 0.03), vec3<f32>(1.0, 0.32, 0.04), debugWeight);
        out.metallic = 0.0;
    } else if (u_terrain.u_debugSurface == -2) {
        out.albedo = debugColor + remaining * vec3<f32>(0.05);
        out.metallic = 0.0;
    }
    return out;
}
