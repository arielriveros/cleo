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
#include "./chunks/terrainLayers.wgsl"

// Mirrors MAX_POINT_LIGHTS / MAX_SPOTLIGHTS in shaders/constants.glsl. Declared here rather than taken
// from chunks/pbrLighting.wgsl because that chunk carries the light STRUCTS only — pbrForward declares
// its own copies too, and the include resolver has no include-once guard, so a shared definition would
// collide for any program that included both.
const MAX_POINT_LIGHTS: i32 = 16;
const MAX_SPOTLIGHTS: i32 = 8;

struct TerrainLightingUniforms {
    u_dirLight: DirectionalLight,
    u_pointLights: array<PointLight, 16>,
    u_spotlights: array<SpotLight, 8>,
    u_numPointLights: i32,
    u_numSpotlights: i32,
};
@group(1) @binding(3) var<uniform> u_lighting: TerrainLightingUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let surface = resolveTerrainSurface(in.fragPos, in.uv, tbnOf(in));

    let v = normalize(u_terrain.u_viewPos - in.fragPos);
    let ambient = u_lighting.u_dirLight.ambient * surface.albedo;

    var lo = vec3<f32>(0.0);

    // A zero direction means "no directional light", which is how the renderer switches the sun off —
    // normalising it would produce NaN rather than darkness.
    let dirD = u_lighting.u_dirLight.direction;
    if (dot(dirD, dirD) > 1e-6) {
        lo += accumulateLight(surface.normal, v, surface.albedo, surface.metallic, surface.roughness,
                              normalize(-dirD), u_lighting.u_dirLight.diffuse);
    }

    for (var i = 0; i < MAX_POINT_LIGHTS; i++) {
        if (i >= u_lighting.u_numPointLights) { break; }
        let p = u_lighting.u_pointLights[i];
        let toLight = p.position - in.fragPos;
        let dist = length(toLight);
        let att = 1.0 / (p.constant + p.linear * dist + p.quadratic * dist * dist);
        lo += accumulateLight(surface.normal, v, surface.albedo, surface.metallic, surface.roughness,
                              normalize(toLight), p.diffuse * att);
    }

    for (var i = 0; i < MAX_SPOTLIGHTS; i++) {
        if (i >= u_lighting.u_numSpotlights) { break; }
        let s = u_lighting.u_spotlights[i];
        let toLight = s.position - in.fragPos;
        let dist = length(toLight);
        let att = 1.0 / (s.constant + s.linear * dist + s.quadratic * dist * dist);
        let l = normalize(toLight);
        let theta = dot(l, normalize(-s.direction));
        // cutOff/outerCutOff are COSINES of the half-angles (see the renderer's spot upload), so the
        // inner one is the LARGER value and the falloff denominator is inner - outer.
        let epsilon = s.cutOff - s.outerCutOff;
        let intensity = clamp((theta - s.outerCutOff) / epsilon, 0.0, 1.0);
        lo += accumulateLight(surface.normal, v, surface.albedo, surface.metallic, surface.roughness,
                              l, s.diffuse * att * intensity);
    }

    // Output stays LINEAR HDR: the probe capture bakes it, and IBL/present tonemap later.
    return vec4<f32>(ambient + lo, 1.0);
}
