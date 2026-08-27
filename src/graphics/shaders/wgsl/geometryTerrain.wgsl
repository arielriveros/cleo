// Deferred geometry pass for terrain.
//
// Blends the layer stack and writes the shared PBR G-buffer, so the unified deferred lighting pass
// shades terrain like any other surface. The blending itself lives in chunks/terrainLayers.wgsl,
// shared with the forward variant used during light-probe capture.

#include "./chunks/modelVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/terrainLayers.wgsl"

struct GBuffer {
    @location(0) albedoMetallic: vec4<f32>,    // rgb = albedo, a = metallic
    @location(1) normalRoughness: vec4<f32>,   // rgb = world normal, a = roughness
    @location(2) emissiveAO: vec4<f32>,        // rgb = emissive, a = ambient occlusion
};

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    let surface = resolveTerrainSurface(in.fragPos, in.uv, tbnOf(in), u_terrain.u_sunDirection);

    var out: GBuffer;
    // The parallax self-shadow is folded into ALBEDO, which is an approximation, and the G-buffer is
    // why. This pass has three targets and no spare channel: rgb+metallic, normal+roughness,
    // emissive+AO. AO cannot carry it — deferredLighting spends AO on the ambient term only
    // (`ambient * ao * ssao + Lo`), so a sun shadow routed through it would not darken the sun.
    // Albedo does reach the direct term: accumulateLight computes `kD * albedo / PI + specular`, so
    // this darkens direct AND ambient diffuse correctly and misses only the specular lobe, which at
    // terrain roughness is negligible. The alternatives were worse — octahedral-packing the normal to
    // free a channel breaks the custom-material G-buffer contract, a fourth target costs bandwidth
    // every frame, and frag_depth would disable early-Z for the whole pass. terrainForward, which has
    // the light list, applies the same term properly.
    out.albedoMetallic = vec4<f32>(surface.albedo * surface.shadow, surface.metallic);
    out.normalRoughness = vec4<f32>(surface.normal, surface.roughness);
    out.emissiveAO = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return out;
}
