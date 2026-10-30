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
                          u_transform.u_windShape, u_transform.u_windCamera);
    out.fragPos = windDisplace(out.fragPos, position, out.normal, model, u_transform.u_windTime.x, wind);
#endif
    cameraHoleVarying(&out, u_transform.u_camHole, u_transform.u_camHolePivot, u_transform.u_lodFrame.x);
    // From fragPos, which IS model * position unless the wind moved it.
    out.position = u_transform.u_projection * u_transform.u_view * vec4<f32>(out.fragPos, 1.0);
    // Fully faded: clip the whole instance away before it costs a single fragment.
    if (hidden) { out.position = vec4<f32>(0.0, 0.0, 2.0, 1.0); }
    return out;
}
