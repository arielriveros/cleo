// Weather on the landscape: wetness, puddles and snow inside the frame's weather volumes, kept off
// what stands under something solid (the shelter map). Include AFTER chunks/terrainStack.wgsl; call
// `applyTerrainWeather` on the resolved surface, at the top level of the fragment stage.
//
// Written by render/weather.ts once a frame, into every terrain program, through this fragment-only
// block (a block read from both stages breaks naga's GLSL). With no volume `u_weatherInfo.x` is 0 and
// nothing below runs.
//
// NO DERIVATIVES AND NO EARLY RETURN. `filterSpecularRoughness` takes derivatives after this runs, so
// control flow must leave this function uniform: the only branch around the body is on uniforms, and
// every fetch inside is a Grad, Level or CompareLevel.
//
// The snow's maps are ONE MORE LAYER of the landscape's own surface arrays (`u_terrain.u_snowLayer`,
// baked by TerrainLayerStack from the snow volume's material), so they cost no binding of their own and
// tile, anti-tile and pack exactly as the landscape's surfaces do. -1: flat snow, `u_snowColor`.
//
// RAINDROPS. While rain falls (`precipitationAt`, the volumes' rain composited), wet ground stirs: rings
// run out across its puddles and drops hit the ground round them, as strong as the ground is wet, so
// what the shelter keeps dry stays still and the ground goes quiet once the rain stops. Procedural and
// analytic (hashed cells, closed-form gradients), animated by the weather clock `u_weatherInfo.y`, and
// faded out by the pixel's footprint before they alias.

struct TerrainWeatherUniforms {
    u_weatherInv: array<mat4x4<f32>, 4>,
    u_weatherBlend: array<vec4<f32>, 4>,
    u_weatherAmount: array<vec4<f32>, 4>,
    u_weatherShape: array<vec4<f32>, 4>,
    /** x = volume count, y = the weather clock (seconds, wrapped at WEATHER_CLOCK_WRAP). */
    u_weatherInfo: vec4<f32>,
    /** world -> shelter map clip (uv-producing, GL convention: * 0.5 + 0.5 gives uv and depth). */
    u_shelterMatrix: mat4x4<f32>,
    /** x = map present 0/1, y = clearance in depth units, z = one texel in uv. */
    u_shelterParams: vec4<f32>,
    /** Flat snow (no snow material): linear albedo rgb, roughness a. */
    u_snowColor: vec4<f32>,
};
@group(1) @binding(5) var<uniform> u_weather: TerrainWeatherUniforms;

/**
 * The shelter map: the depth, seen from straight above, of everything solid (render/shadows.ts
 * `renderShelter`). In the frame-lighting group, after the shadow maps (0-5) and the light grid (6).
 */
@group(3) @binding(8) var u_weatherShelter_texture: texture_depth_2d_array;
@group(3) @binding(9) var u_weatherShelter_sampler: sampler_comparison;

fn weatherCount() -> i32 { return i32(u_weather.u_weatherInfo.x); }
fn weatherInv(i: i32) -> mat4x4<f32> { return u_weather.u_weatherInv[i]; }
fn weatherBlend(i: i32) -> vec4<f32> { return u_weather.u_weatherBlend[i]; }
fn weatherAmount(i: i32) -> vec4<f32> { return u_weather.u_weatherAmount[i]; }
fn weatherShape(i: i32) -> vec4<f32> { return u_weather.u_weatherShape[i]; }

#include "./weatherVolumes.wgsl"

/** 1 = open sky over `p`, 0 = something solid over it. Off the map (or with no map): open. */
fn weatherShelterAt(p: vec3<f32>) -> f32 {
    let params = u_weather.u_shelterParams;
    let c = u_weather.u_shelterMatrix * vec4<f32>(p, 1.0);
    let q = c.xyz / c.w * 0.5 + 0.5;
    let inside = all(vec4<bool>(params.x > 0.5, all(q.xy >= vec2<f32>(0.0)), all(q.xy <= vec2<f32>(1.0)), q.z <= 1.0));
    // Open sky when the stored depth (the top of whatever is there) is no nearer the sky than the
    // surface less its clearance: a roof well above it shelters it, the ground's own bumps do not.
    let refDepth = q.z - params.y;
    let t = params.z * 0.75;
    var open = 0.0;
    open += textureSampleCompareLevel(u_weatherShelter_texture, u_weatherShelter_sampler, q.xy + vec2<f32>(-t, -t), 0, refDepth);
    open += textureSampleCompareLevel(u_weatherShelter_texture, u_weatherShelter_sampler, q.xy + vec2<f32>(t, -t), 0, refDepth);
    open += textureSampleCompareLevel(u_weatherShelter_texture, u_weatherShelter_sampler, q.xy + vec2<f32>(-t, t), 0, refDepth);
    open += textureSampleCompareLevel(u_weatherShelter_texture, u_weatherShelter_sampler, q.xy + vec2<f32>(t, t), 0, refDepth);
    return select(1.0, open * 0.25, inside);
}

/** Two octaves of the stack's value noise at metre scale `scale`, 0..1. */
fn weatherNoise(xz: vec2<f32>, scale: f32) -> f32 {
    let p = xz / scale;
    return 0.62 * valueNoise(p) + 0.38 * valueNoise(p * 2.13 + vec2<f32>(5.2, 1.7));
}

/**
 * The cycle of each raindrop layer, seconds: two ripple layers, then two drop-hit layers. Mirrors
 * `RAINDROP_PERIODS` in render/weatherPack.ts; each divides the clock's wrap, so the wrap never shows.
 */
const RAINDROP_PERIOD_0: f32 = 1.0;
const RAINDROP_PERIOD_1: f32 = 0.8;
const RAINDROP_PERIOD_2: f32 = 0.5;
const RAINDROP_PERIOD_3: f32 = 0.64;
/** A ripple's wavelets: wave number (2 pi / 3.5 cm), packet width (m), height (m). */
const RIPPLE_K: f32 = 179.5;
const RIPPLE_SIGMA: f32 = 0.03;
const RIPPLE_HEIGHT: f32 = 0.0015;

/** A cell index kept small, so the hash keeps its precision however far the ground is from the origin. */
fn raindropKey(c: vec2<f32>) -> vec2<f32> {
    return c - floor(c / 251.0) * 251.0;
}

/** This cycle's hash of a cell: whether a drop falls in it, and where. */
fn raindropCycleKey(key: vec2<f32>, cycle: f32, seed: f32) -> vec2<f32> {
    let c = cycle - floor(cycle / 61.0) * 61.0;
    return key + vec2<f32>(c * 3.17 + seed, c * 5.71 - seed);
}

/**
 * One layer of rings on standing water at `xz`: the gradient (d/dx, d/dz) of the water's height. Cells
 * `cell` metres across, each cycling every `period` seconds from its own phase; each cycle a drop falls
 * in it with probability `density`, somewhere new, and a ring of wavelets runs out from it, fading as it
 * spreads. The 2x2 nearest cells: a ring never grows past half a cell.
 */
fn rippleLayer(xz: vec2<f32>, t: f32, density: f32, cell: f32, period: f32, seed: f32) -> vec2<f32> {
    let base = floor(xz / cell - 0.5);
    var grad = vec2<f32>(0.0);
    for (var j = 0; j < 4; j++) {
        let c = base + vec2<f32>(f32(j % 2), f32(j / 2));
        let key = raindropKey(c);
        let u = t / period + hash12(key + vec2<f32>(seed, 0.0));
        let cycle = floor(u);
        let life = u - cycle;
        let k = raindropCycleKey(key, cycle, seed);
        let falls = step(hash12(k), density);
        let centre = (c + 0.25 + 0.5 * vec2<f32>(hash12(k + 11.3), hash12(k + 27.9))) * cell;
        let d = xz - centre;
        let dist = length(d);
        let x = dist - life * 0.5 * cell;
        let packet = exp(-x * x / (RIPPLE_SIGMA * RIPPLE_SIGMA));
        let fade = (1.0 - life) * (1.0 - life) * falls;
        let dh = RIPPLE_HEIGHT * fade * packet
            * (RIPPLE_K * cos(RIPPLE_K * x) - 2.0 * x / (RIPPLE_SIGMA * RIPPLE_SIGMA) * sin(RIPPLE_K * x));
        grad += dh * d / max(dist, 1e-4);
    }
    return grad;
}

/**
 * One layer of drops hitting wet ground at `xz`: x = how much of a fresh drop covers it, yz = the
 * gradient of the little dome it makes. One drop a cell (`cell` metres) a cycle, as `rippleLayer`, kept
 * inside its own cell so only that cell is looked at; it spreads a little and fades fast.
 */
fn dropHitLayer(xz: vec2<f32>, t: f32, density: f32, cell: f32, period: f32, seed: f32) -> vec3<f32> {
    let c = floor(xz / cell);
    let key = raindropKey(c);
    let u = t / period + hash12(key + vec2<f32>(seed, 0.0));
    let cycle = floor(u);
    let life = u - cycle;
    let k = raindropCycleKey(key, cycle, seed);
    let falls = step(hash12(k), density);
    let centre = (c + 0.3 + 0.4 * vec2<f32>(hash12(k + 11.3), hash12(k + 27.9))) * cell;
    let radius = mix(0.012, 0.024, hash12(k + 41.7)) * (0.6 + 0.4 * life);
    let d = xz - centre;
    let dist = length(d);
    let cover = (1.0 - smoothstep(0.55 * radius, radius, dist)) * pow(1.0 - life, 1.5) * falls;
    // A dome's height falls away from its centre: the gradient points in, steepest at the rim.
    let slope = 0.6 * clamp(dist / radius, 0.0, 1.0) * cover;
    return vec3<f32>(cover, -slope * d / max(dist, 1e-5));
}

/**
 * Weather over a resolved landscape surface at world point `p` with geometric frame `tbn`.
 *
 * WET (Creator floor composite): porous ground darkens, more so the rougher it is, and glosses; water
 * stands where the composited height is low on flat ground, `puddles` deciding how much of it is low
 * enough. SNOW: settles on ground flatter than the volume's slope, low ground first, its edge broken up
 * by noise; drawn with the snow layer's maps, or flat. Both are scaled down by the shelter over `p`
 * wherever the volumes keep shelter. RAINDROPS (while it rains): rings in the puddles, drops hitting the
 * wet ground round them, as strong as the ground is wet.
 */
fn applyTerrainWeather(surface: ptr<function, TerrainSurface>, p: vec3<f32>, tbn: mat3x3<f32>) {
    if (weatherCount() > 0 && u_terrain.u_debugSurface == -1) {
        let w = weatherAt(p);
        let nGeom = normalize(tbn[2]);
        let open = weatherShelterAt(p);
        let reach = mix(1.0, open, w.shelter);
        let wet = w.wet * reach;
        let snow = w.snow * reach;

        if (wet > 0.0) {
            let rough = (*surface).roughness;
            (*surface).albedo *= 1.0 - 0.5 * wet * (0.4 + 0.6 * rough);
            (*surface).roughness = mix(rough, 0.12, wet * 0.85);
            // Standing water: the lowest of the ground (its height maps, broken up by a noise a few
            // metres across so flat maps pool too), on ground flat enough to hold it.
            let level = w.puddles * 0.55;
            let low = 0.6 * (*surface).height + 0.4 * weatherNoise(p.xz, 3.0);
            let flat = smoothstep(0.96, 0.995, nGeom.y);
            let puddle = (1.0 - smoothstep(level - 0.04, level + 0.04, low)) * flat * wet * step(0.001, w.puddles);
            (*surface).albedo *= mix(1.0, 0.7, puddle);
            (*surface).roughness = mix((*surface).roughness, 0.03, puddle);
            (*surface).normal = normalize(mix((*surface).normal, nGeom, puddle));

            // Raindrops: as many as the rain falling here, as strong as the ground is wet (so none where
            // the shelter keeps it dry). Each kind fades out before its pixels get too coarse to draw it;
            // past that, ripples too fine to see still rough the water up a little.
            let falling = clamp(precipitationAt(p).x, 0.0, 1.0);
            if (falling > 0.001) {
                let t = u_weather.u_weatherInfo.y;
                let footprint = (*surface).footprint;
                if (puddle > 0.001) {
                    let fadeRipple = 1.0 - smoothstep(0.006, 0.02, footprint);
                    var g = rippleLayer(p.xz, t, falling, 0.5, RAINDROP_PERIOD_0, 0.0);
                    g += rippleLayer(p.xz, t, falling, 0.37, RAINDROP_PERIOD_1, 17.0);
                    (*surface).normal = normalize((*surface).normal - vec3<f32>(g.x, 0.0, g.y) * puddle * fadeRipple);
                    (*surface).roughness += 0.08 * falling * puddle * (1.0 - fadeRipple);
                }
                let hits = wet * (1.0 - puddle) * (1.0 - smoothstep(0.004, 0.012, footprint))
                    * smoothstep(0.5, 0.9, nGeom.y);
                if (hits > 0.001) {
                    let a = dropHitLayer(p.xz, t, falling, 0.11, RAINDROP_PERIOD_2, 31.0);
                    let b = dropHitLayer(p.xz, t, falling, 0.083, RAINDROP_PERIOD_3, 53.0);
                    let s = max(a.x, b.x) * hits;
                    let g = a.yz + b.yz;
                    (*surface).albedo *= 1.0 - 0.25 * s;
                    (*surface).roughness = mix((*surface).roughness, 0.05, s);
                    (*surface).normal = normalize((*surface).normal - vec3<f32>(g.x, 0.0, g.y) * hits);
                }
            }
        }

        if (snow > 0.0) {
            let slopeMask = smoothstep(w.slopeCos - 0.05, w.slopeCos + 0.05, nGeom.y);
            let n = weatherNoise(p.xz, 2.5);
            let field = snow * 1.25 - ((*surface).height - 0.5) * 0.5 - (n - 0.5) * w.breakup;
            let cover = smoothstep(0.35, 0.65, field) * slopeMask;

            var snowAlbedo = u_weather.u_snowColor.rgb;
            var snowRough = u_weather.u_snowColor.a;
            var snowMetal = 0.0;
            var snowAo = 1.0;
            var snowReflect = 0.5;
            var snowN = normalize(mix((*surface).normal, nGeom, 0.6));
            let layer = u_terrain.u_snowLayer;
            if (layer >= 0) {
                let material = u_terrain.u_surfMaterial[layer];
                let tiling = max(material.z, TILING_EPSILON);
                let uv = (*surface).uv * tiling;
                let gx = (*surface).uvDx * tiling;
                let gy = (*surface).uvDy * tiling;
                let flags = u_terrain.u_surfFlags[layer];
                let blend = u_terrain.u_surfBlend[layer];
                let at = antiTileOf(uv, blend.w);
                snowAlbedo = toLinear(u_terrain.u_surfColor[layer].rgb);
                if (flags.x > 0.5) {
                    snowAlbedo *= toLinear(sampleSurfaceArray(u_surfAlbedo_texture, u_surfAlbedo_sampler, uv, layer, gx, gy, at).rgb);
                }
                snowMetal = material.x;
                snowRough = material.y;
                if (flags.y > 0.5) {
                    let orm = sampleSurfaceArray(u_surfOrm_texture, u_surfOrm_sampler, uv, layer, gx, gy, at);
                    snowAo = orm.r;
                    snowRough = orm.g;
                    snowMetal = orm.b;
                }
                if (flags.z > 0.5) {
                    let texel = sampleSurfaceArray(u_surfNormal_texture, u_surfNormal_sampler, uv, layer, gx, gy, at);
                    let tn = texel.rgb * 2.0 - 1.0;
                    snowN = normalize(tbn * vec3<f32>(tn.xy * blend.z, tn.z));
                }
                snowReflect = u_terrain.u_surfShade[layer].x;
            }
            (*surface).albedo = mix((*surface).albedo, snowAlbedo, cover);
            (*surface).roughness = mix((*surface).roughness, snowRough, cover);
            (*surface).metallic = mix((*surface).metallic, snowMetal, cover);
            (*surface).ao = mix((*surface).ao, snowAo, cover);
            (*surface).reflectance = mix((*surface).reflectance, snowReflect, cover);
            (*surface).normal = normalize(mix((*surface).normal, snowN, cover));
        }
    }
}
