// Instanced vertex stage: the per-instance world matrix arrives as a vertex attribute at locations
// 5-8 (divisor 1), replacing u_model entirely — the matrices Foliage bakes are already in world space.
// The GLSL twin is deferred/geometry_instanced.vs.
//
// A mat4 vertex attribute is four vec4 locations; WGSL has to spell that out, where GLSL let one
// `in mat4` cover it. The engine binds them by LOCATION (see rhi/vertexLayouts.ts instanceMatrixLayout),
// not by name, so the parameter names here are free.

#include "./modelVarying.wgsl"
#include "./foliageWind.wgsl"

struct InstancedTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    // Foliage wind (chunks/foliageWind.wgsl). Declared in EVERY variant so the block's layout never
    // depends on the variant; only `CLEO_WIND` builds read them.
    u_windGlobal: vec4<f32>,
    u_windTime: vec4<f32>,
    u_windResponse: vec4<f32>,
    u_windShape: vec4<f32>,
    u_windCamera: vec4<f32>,
    // The wind field (chunks/windField.wgsl): x = gustiness, y = veer (rad), z = sources in use; and the
    // sources, the Force Fields that move the air, four texels each (ForceFieldNode.packInto).
    u_windField: vec4<f32>,
    u_windSources: array<vec4<f32>, 32>,
    // Foliage interaction (interactLean): x = stamps, y = bend, z = recovery (s), w = plant radius; and
    // the stamps themselves, two vec4s each (graphics/foliageInteraction.ts).
    u_interact: vec4<f32>,
    u_interactStamps: array<vec4<f32>, 32>,
    // Foliage weather (CLEO_FOLIAGE): x = how far the plant bows under a full load of rain or snow (its
    // materials' weightDroop); the weather at the plant scales it (instanceWeather).
    u_foliageDroop: vec4<f32>,
    // Weather volumes (chunks/weatherVolumes.wgsl), evaluated per plant at its root; written once a frame
    // by render/weather.ts into every instanced program. Declared in every variant, read by the PBR
    // family (CLEO_INSTANCED_WEATHER) and the foliage shadows (CLEO_FOLIAGE).
    u_weatherInv: array<mat4x4<f32>, 4>,
    u_weatherBlend: array<vec4<f32>, 4>,
    u_weatherAmount: array<vec4<f32>, 4>,
    u_weatherShape: array<vec4<f32>, 4>,
    u_weatherInfo: vec4<f32>,
    u_shelterMatrix: mat4x4<f32>,
    u_shelterParams: vec4<f32>,
    // Foliage LOD crossfade, per instance. Band: x..y fade-in ramp, z..w fade-out ramp (metres from
    // the camera; an empty ramp means no fade on that side). Camera: xyz = position, w = mode (0 off,
    // 1 dithered dissolve, 2 shrink — grass). Frame: x = dither phase.
    u_lodBand: vec4<f32>,
    u_lodCamera: vec4<f32>,
    u_lodFrame: vec4<f32>,
    // Camera see-through hole (chunks/cameraHole.wgsl): camera xyz + 1/radius; pivot xyz + strength (0 = off).
    u_camHole: vec4<f32>,
    u_camHolePivot: vec4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: InstancedTransform;

// The wind sources chunks/windField.wgsl sums (MAX_WIND_SOURCES in core/wind/windField.ts).
const WIND_SOURCE_SLOTS: i32 = 8;
fn windSourceCount() -> i32 { return i32(u_transform.u_windField.z); }
fn windSourceTexel(i: i32, k: i32) -> vec4<f32> { return u_transform.u_windSources[i * 4 + k]; }

fn weatherCount() -> i32 { return i32(u_transform.u_weatherInfo.x); }
fn weatherInv(i: i32) -> mat4x4<f32> { return u_transform.u_weatherInv[i]; }
fn weatherBlend(i: i32) -> vec4<f32> { return u_transform.u_weatherBlend[i]; }
fn weatherAmount(i: i32) -> vec4<f32> { return u_transform.u_weatherAmount[i]; }
fn weatherShape(i: i32) -> vec4<f32> { return u_transform.u_weatherShape[i]; }

#include "./weatherVolumes.wgsl"

/** How much the weather bows a plant at `origin` (0..1 of its full droop): rain a little, snow fully. */
fn weatherDroopAt(origin: vec3<f32>) -> f32 {
    if (weatherCount() <= 0) { return 0.0; }
    let w = weatherAt(origin);
    return max(w.wet * 0.4, w.snow);
}

#if CLEO_INSTANCED_WEATHER
// The weather's shelter map (render/shadows.ts `renderShelter`), after the material maps (pbrGBuffer's
// 0-11). Sampled here, once per vertex of a plant at its root, never per fragment: the whole family
// declares and reads it, so the block layout and the bind group never depend on the variant.
@group(0) @binding(12) var u_weatherShelter_texture: texture_depth_2d_array;
@group(0) @binding(13) var u_weatherShelter_sampler: sampler_comparison;

/** 1 = open sky over the plant's root, 0 = something solid over it. Off the map: open. */
fn instanceShelterOpen(origin: vec3<f32>) -> f32 {
    let params = u_transform.u_shelterParams;
    let c = u_transform.u_shelterMatrix * vec4<f32>(origin, 1.0);
    let q = c.xyz / c.w * 0.5 + 0.5;
    // `all`, never `&&` (see weatherBoxWeight).
    let inside = all(vec4<bool>(params.x > 0.5, all(q.xy >= vec2<f32>(0.0)), all(q.xy <= vec2<f32>(1.0)), q.z <= 1.0));
    let open = textureSampleCompareLevel(u_weatherShelter_texture, u_weatherShelter_sampler, q.xy, 0, q.z - params.y);
    return select(1.0, open, inside);
}

/** The weather a plant shows, per plant: x = wet, y = snow, both kept off it under shelter. */
fn instanceWeather(origin: vec3<f32>) -> vec2<f32> {
    if (weatherCount() <= 0) { return vec2<f32>(0.0); }
    let w = weatherAt(origin);
    let reach = mix(1.0, instanceShelterOpen(origin), w.shelter);
    return vec2<f32>(w.wet, w.snow) * reach;
}
#endif

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
    @location(5) instanceModel0: vec4<f32>,
    @location(6) instanceModel1: vec4<f32>,
    @location(7) instanceModel2: vec4<f32>,
    @location(8) instanceModel3: vec4<f32>,
) -> VertexOutput {
    let model = mat4x4<f32>(instanceModel0, instanceModel1, instanceModel2, instanceModel3);

    var out: VertexOutput;
    fillVarying(&out, model, position, texCoord, normal, tangent, bitangent);

    // Foliage LOD crossfade: each INSTANCE fades by its own distance, so a band edge follows the trees
    // rather than the 13 m cells they are stored in. See foliageLodBands in terrain/foliage.ts.
    var hidden = false;
    let lodMode = u_transform.u_lodCamera.w;
    if (lodMode > 0.5) {
        let d = distance(model[3].xyz, u_transform.u_lodCamera.xyz);
        let band = u_transform.u_lodBand;
        let fadeIn = select(1.0, smoothstep(band.x, band.y, d), band.y > band.x);
        let fadeOut = select(1.0, 1.0 - smoothstep(band.z, band.w, d), band.w > band.z);
        if (lodMode > 1.5) {
            // Grass shrinks into the ground rather than dissolving: a tiny card dithers into noise.
            let o = model[3].xyz;
            out.fragPos = o + (out.fragPos - o) * (fadeIn * fadeOut);
        } else {
            out.lodFade = vec3<f32>(fadeIn, fadeOut, u_transform.u_lodFrame.x);
        }
        hidden = min(fadeIn, fadeOut) <= 0.0;
    }
#if CLEO_WIND
    let wind = WindParams(u_transform.u_windGlobal, u_transform.u_windTime, u_transform.u_windResponse,
                          u_transform.u_windShape, u_transform.u_windCamera, u_transform.u_windField);
    // The wind field once, at the plant's origin: every part of it (and its shadow) bends by this.
    let origin = model[3].xyz;
    let plant = windPlantAt(origin, u_transform.u_windTime.x, wind);
#if CLEO_FOLIAGE
    let push = interactLean(origin, u_transform.u_windTime.x, u_transform.u_interact, u_transform.u_interactStamps);
    // Per plant, from the weather at its root. Never sheltered: the shadow and prepass programs bow it the
    // same way without the shelter map, and their depth must match this pass's exactly.
    let droop = u_transform.u_foliageDroop.x * weatherDroopAt(origin);
    // For the surface (chunks/foliageSurface.wgsl): the plant's hash, the gust it is in, whether it is leaves.
    out.foliage = vec4<f32>(windHash(origin.xz * 1.37 + vec2<f32>(origin.y, 0.0)),
                            plant.gust * plant.strength * plant.fade,
                            u_transform.u_windResponse.w, 0.0);
#else
    // The far cards: wind alone.
    let push = vec2<f32>(0.0);
    let droop = 0.0;
#endif
    out.fragPos = windDisplace(out.fragPos, position, out.normal, model, u_transform.u_windTime.x, wind, push, droop, plant);
#endif
#if CLEO_INSTANCED_WEATHER
    // Every variant of the family reads the shelter map (its resources must not depend on the variant);
    // only the foliage surface shows the result.
    let weather = instanceWeather(model[3].xyz);
#if CLEO_FOLIAGE
    out.foliageWeather = weather;
#endif
#endif
    cameraHoleVarying(&out, u_transform.u_camHole, u_transform.u_camHolePivot, u_transform.u_lodFrame.x);
    // From fragPos, which IS model * position unless the wind moved it.
    out.position = u_transform.u_projection * u_transform.u_view * vec4<f32>(out.fragPos, 1.0);
    // Fully faded: clip the whole instance away before it costs a single fragment.
    if (hidden) { out.position = vec4<f32>(0.0, 0.0, 2.0, 1.0); }
    return out;
}
