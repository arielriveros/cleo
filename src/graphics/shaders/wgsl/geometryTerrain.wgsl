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
    @location(1) normalRoughness: vec4<f32>,   // rg = oct normal, b = reflectance, a = roughness
    @location(2) emissiveAO: vec4<f32>,        // rgb = emissive, a = ambient occlusion
};

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    let surface = resolveTerrainSurface(in.fragPos, in.uv, tbnOf(in), u_terrain.u_sunDirection);

    var out: GBuffer;
    // The self-shadow is folded into ALBEDO, which is an approximation, and the G-buffer is why. This
    // pass has three targets and no spare channel: rgb+metallic, normal+roughness, emissive+AO. AO
    // cannot carry it — deferredLighting spends AO on the INDIRECT terms only (both lobes, each taking
    // its own occlusion since phase 4), so a sun shadow routed through it would not darken the sun.
    // Albedo does reach the direct term:
    // accumulateLight's diffuse lobe is `albedo * (1 - metallic) * Fd_Burley(...)`, so this darkens
    // direct AND ambient diffuse correctly and misses only the specular lobe, negligible at terrain
    // roughness. terrainForward, which has the light list, applies the same term properly.
    out.albedoMetallic = vec4<f32>(surface.albedo * surface.shadow, surface.metallic);
    // Filtered roughness, exactly as chunks/pbrGBuffer.wgsl writes it, and for the same reason: the
    // variance has to be measured across one surface's own normal, which only the geometry pass can do.
    // Reflectance 0.5, the neutral dielectric: soil, rock and grass all sit within a few thousandths
    // of F0 0.04, and terrain has one composite material for four layers with nowhere to author it.
    let octN = octEncode(surface.normal);
    out.normalRoughness = vec4<f32>(octN.x, octN.y, 0.5,
        filterSpecularRoughness(surface.roughness, surface.normal, u_terrain.u_specularAA));
    // Occlusion, at last, rather than the constant 1.0 this wrote for as long as the channel has
    // existed. It needed no G-buffer change: `gEmissiveAO.a` was always here, terrain simply had
    // nothing to put in it until a layer could carry an occlusion map (see Terrain._syncAlbedoPack).
    out.emissiveAO = vec4<f32>(0.0, 0.0, 0.0, surface.ao);
    return out;
}
