// Deferred geometry pass for terrain.
//
// Composites the landscape's layer stack and writes the shared PBR G-buffer, so the unified deferred
// lighting pass shades terrain like any other surface. The compositing itself lives in
// chunks/terrainStack.wgsl, shared with the forward variant used during light-probe capture.

#include "./chunks/modelVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/terrainStack.wgsl"

struct GBuffer {
    @location(0) albedoMetallic: vec4<f32>,    // rgb = albedo, a = metallic
    @location(1) normalRoughness: vec4<f32>,   // rg = oct normal, b = reflectance, a = roughness
    @location(2) emissiveAO: vec4<f32>,        // rgb = emissive, a = ambient occlusion
};

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    let surface = resolveTerrainSurface(in.fragPos, in.uv, tbnOf(in));

    var out: GBuffer;
    // No height-field self-shadow to fold in any more: it belonged to the parallax march, which the layer
    // stack retired (it was already switched off by TERRAIN_RELIEF_ENABLED).
    out.albedoMetallic = vec4<f32>(surface.albedo, surface.metallic);
    // Filtered roughness, exactly as chunks/pbrGBuffer.wgsl writes it, and for the same reason: the
    // variance has to be measured across one surface's own normal, which only the geometry pass can do.
    // Reflectance 0.5, the neutral dielectric: soil, rock and grass all sit within a few thousandths
    // of F0 0.04, and terrain has one composite material for its whole stack with nowhere to author it.
    let octN = octEncode(surface.normal);
    out.normalRoughness = vec4<f32>(octN.x, octN.y, 0.5,
        filterSpecularRoughness(surface.roughness, surface.normal, u_terrain.u_specularAA));
    // Occlusion, at last, rather than the constant 1.0 this wrote for as long as the channel has
    // existed. It needed no G-buffer change: `gEmissiveAO.a` was always here, terrain simply had
    // nothing to put in it until a layer could carry an occlusion map (the albedo array's alpha).
    out.emissiveAO = vec4<f32>(0.0, 0.0, 0.0, surface.ao);
    return out;
}
