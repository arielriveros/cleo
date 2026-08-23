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
    let surface = resolveTerrainSurface(in.fragPos, in.uv, tbnOf(in));

    var out: GBuffer;
    out.albedoMetallic = vec4<f32>(surface.albedo, surface.metallic);
    out.normalRoughness = vec4<f32>(surface.normal, surface.roughness);
    out.emissiveAO = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return out;
}
