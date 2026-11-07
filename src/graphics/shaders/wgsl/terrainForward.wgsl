// FORWARD-lit terrain.
//
// The main scene renders terrain through the deferred G-buffer (geometryTerrain), but the light-probe
// capture (and the forward pipeline's main view) is a forward pass with a single colour attachment, so it
// needs a shader that both blends the terrain layers AND lights them in one draw. The weather applies
// here exactly as in the deferred twin. The blend is the shared chunk; the lighting below mirrors
// pbrForward's, minus the parts this pass deliberately cannot afford.
//
// SHADOWED, NO environment cube. The sun's shadow is the frame's cascades in the forward pipeline's main
// view; in a light-probe capture it is the probe's own map (ShadowPasses.beginProbeShadows), one layer fit
// round the probe, so a cliff's shadow falls across the ground a probe sees as it does on screen. Before,
// this pass had no shadows at all and every probe saw a valley lit through its own hills. Point and spot
// shadows apply too: a torch behind a wall does not light the ground through it. The environment cube stays
// out: a capture binds no probe (that would feed back), and the main view's terrain is deferred.

#include "./chunks/modelVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"
#include "./chunks/shadows.wgsl"
#include "./chunks/terrainStack.wgsl"
#include "./chunks/terrainWeather.wgsl"

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
    cleoFragCoord = in.position.xy;
    let tbn = tbnOf(in);
    var surface = resolveTerrainSurface(in.fragPos, in.uv, tbn);
    applyTerrainWeather(&surface, in.fragPos, tbn);

    // Filtered here rather than inside resolveTerrainSurface, because a derivative belongs at the top
    // level of a fragment stage where control flow is still uniform, and the blend runs branches.
    let roughness = filterSpecularRoughness(surface.roughness, surface.normal, u_terrain.u_specularAA);

    let v = normalize(u_terrain.u_viewPos - in.fragPos);
    // Terrain is the reason the sky light is nine uniforms rather than a cube: this shader's layer
    // samplers used to occupy units 0-8, so it could never bind one.
    // This pass has no environment map and no probe, so its indirect term is purely diffuse — which
    // is why occlusion is one multiply here and a split into two lobes in the deferred twin.
    let ambient = (u_lighting.u_sceneAmbient
                   + skyIrradiance(u_lighting.u_skyLight, surface.normal)) * surface.albedo * surface.ao;

    var lo = vec3<f32>(0.0);

    // RADIAL distance for the cascade pick and the cluster, not the planar view depth every other path uses,
    // because this shader has no view matrix: its lighting block carries no `u_view`. In a capture both are
    // degenerate on purpose: the probe's shadow map is one layer whose split covers everything, and the
    // renderer hands the capture a 1x1x1 light grid (see `buildSingleCluster`), so every fragment resolves to
    // cluster 0. Written this way rather than as constants, so a real grid or cascades here would be slightly
    // conservative rather than silently wrong.
    let depth = distance(u_terrain.u_viewPos, in.fragPos);
    let sun = 1.0 - directionalShadow(in.fragPos, surface.normal, depth);
    lo += evaluateDirectionalLight(u_lighting.u_dirLight, surface.normal, v, surface.albedo,
                                   surface.metallic, roughness, sun);

    let cluster = cleoClusterOf(in.position.xy, depth);
    let first = cleoClusterOffset(cluster);
    let count = cleoClusterCount(cluster);
    for (var i = 0; i < count; i++) {
        let cl = cleoLight(cleoClusterLight(first + i));
        if (cleoLightReaches(cl.light, in.fragPos)) {
            let visibility = cleoPunctualVisibility(cl.spotShadowLayer, cl.pointShadowSlot,
                                                    in.fragPos, surface.normal, cl.light.position);
            lo += evaluateSpotLight(cl.light, in.fragPos, surface.normal, v,
                                    surface.albedo, surface.metallic, roughness, visibility);
        }
    }

    // Output stays LINEAR HDR: the probe capture bakes it, and IBL/present tonemap later.
    return vec4<f32>(ambient + lo, 1.0);
}
