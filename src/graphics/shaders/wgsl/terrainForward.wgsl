// FORWARD-lit terrain.
//
// The main scene renders terrain through the deferred G-buffer (geometryTerrain), but the light-probe
// capture is a forward pass with a single colour attachment, so it needs a shader that both blends the
// terrain layers AND lights them in one draw. The blend is the shared chunk; the lighting below mirrors
// pbrForward's, minus the parts this pass deliberately cannot afford.
//
// NO shadow cascades and NO environment cube here, and that is a hard constraint rather than an
// omission: the terrain layer samplers occupy texture units 0..8, which collide with the shared shadow
// unit (6) and the env cube (7) — and two sampler TYPES on one unit is a GLES draw error. This shader
// only runs during probe capture, where shadows are suppressed anyway, so it costs nothing. If shadows
// are ever wanted here, drop u_normal3 rather than renumbering the shared reservation.

#include "./chunks/modelVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"
#include "./chunks/terrainLayers.wgsl"

struct TerrainLightingUniforms {
    u_dirLight: DirectionalLight,
    u_skyLight: SkyLight,
    u_sceneAmbient: vec3<f32>,
};
@group(1) @binding(3) var<uniform> u_lighting: TerrainLightingUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The sun comes from the light list here, not from u_transform: this pass HAS the light list, and
    // taking it from the same place it lights with keeps the two from ever disagreeing.
    let surface = resolveTerrainSurface(in.fragPos, in.uv, tbnOf(in), u_lighting.u_dirLight.direction);

    // Filtered here rather than inside resolveTerrainSurface, because a derivative belongs at the top
    // level of a fragment stage where control flow is still uniform, and the blend runs branches.
    let roughness = filterSpecularRoughness(surface.roughness, surface.normal, u_terrain.u_specularAA);

    let v = normalize(u_terrain.u_viewPos - in.fragPos);
    // Terrain is the reason the sky light is nine uniforms rather than a cube: this shader's layer
    // samplers occupy units 0-8, so it can never bind one.
    // This pass has no environment map and no probe, so its indirect term is purely diffuse — which
    // is why occlusion is one multiply here and a split into two lobes in the deferred twin.
    let ambient = (u_lighting.u_sceneAmbient
                   + skyIrradiance(u_lighting.u_skyLight, surface.normal)) * surface.albedo * surface.ao;

    var lo = vec3<f32>(0.0);

    // Self-shadowing applied to the SUN's visibility, which is what it actually describes. The
    // deferred twin has to fold it into albedo instead; see geometryTerrain.
    lo += evaluateDirectionalLight(u_lighting.u_dirLight, surface.normal, v, surface.albedo,
                                   surface.metallic, roughness, surface.shadow);

    // Visibility is a flat 1.0: this pass has no shadow maps bound at all (see the header), so there
    // is nothing to ask. That is also why it can skip `cleoPunctualVisibility`, which lives in
    // chunks/shadows.wgsl and would drag the whole shadow group in with it.
    //
    // RADIAL distance, not the planar view depth every other path uses, because this shader has no
    // view matrix — its lighting block carries no `u_view`. The renderer hands the probe capture a
    // DEGENERATE 1x1x1 grid (see `buildSingleCluster`), since the grid describes the main camera and
    // means nothing to a cube face, so every fragment resolves to cluster 0 and the difference cannot
    // matter. It is written this way rather than as a hard-coded 0 so that a real grid here would be
    // slightly conservative rather than silently wrong.
    let cluster = cleoClusterOf(in.position.xy, distance(u_terrain.u_viewPos, in.fragPos));
    let first = cleoClusterOffset(cluster);
    let count = cleoClusterCount(cluster);
    for (var i = 0; i < count; i++) {
        let cl = cleoLight(cleoClusterLight(first + i));
        lo += evaluateSpotLight(cl.light, in.fragPos, surface.normal, v,
                                surface.albedo, surface.metallic, roughness, 1.0);
    }

    // Output stays LINEAR HDR: the probe capture bakes it, and IBL/present tonemap later.
    return vec4<f32>(ambient + lo, 1.0);
}
