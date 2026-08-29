// @glsl-chunk
//
// Generates the GLSL form of the light structs and the PBR BRDF for `systems/customShaders.ts`, which
// assembles user-authored GLSL at runtime and pastes the library in as text.
//
// This module exists ONLY to be translated. Its entry point renders nothing; it is here because naga
// emits only functions REACHABLE from an entry point, so every function the chunk must export has to be
// called below or it is dead-code eliminated and silently absent. The light STRUCTS are not reachable
// from any function, so they are constructed below for the same reason.
//
// If a new public function is added to chunks/pbrLighting.wgsl, add a call for it here too.
//
// TWO THINGS ARE DELIBERATELY LEFT UNREACHED. `SkyLight` and `skyIrradiance` are scene-wide indirect
// light that the custom-material forward prelude has no uniform for — pulling them in would emit a
// struct the prelude cannot fill. Keep them out of `keepAlive` below.
//
// Unlike shadowsChunk.wgsl this module declares no textures and no uniform blocks, so neither of
// `vulkanShadowLibrary`'s two dialect transforms applies: the emitted GLSL is valid ES 300 *and* valid
// Vulkan GLSL unmodified. The one thing the consumer must still do is strip the `PI` this emits, which
// collides with the one `COMMON_BODY` declares for every mode.

#include "./chunks/pbrLighting.wgsl"

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let N = vec3<f32>(0.0, 1.0, 0.0);
    let V = vec3<f32>(0.0, 0.0, 1.0);
    let zero3 = vec3<f32>(0.0);

    // Constructing each light keeps its STRUCT in the output, and passing it to its evaluate* helper
    // keeps that helper — and everything it reaches — alive too.
    let dir = DirectionalLight(N, 1.0, zero3, 0.0);
    let pt = PointLight(zero3, 1.0, zero3, 1.0, 0.05);
    let sp = SpotLight(zero3, 1.0, N, 0.05, zero3, 1.0, 1.0, 0.0);

    // The BRDF pieces are called individually as well as through accumulateLight: a custom material may
    // want the lobes on their own, and a helper nothing reaches here is SILENTLY absent from the chunk
    // with no error anywhere. The deprecated trio (DistributionGGX / GeometrySchlickGGX /
    // GeometrySmith) rides along through the DistributionGGX and GeometrySmith calls below — they are
    // dead in the engine's own programs but still callable from user-authored GLSL.
    let brdf = D_GGX(1.0, 1.0) * V_SmithGGXCorrelated(1.0, 1.0, 1.0)
             * Fd_Burley(1.0, 1.0, 1.0, 1.0)
             * DistributionGGX(N, N, 1.0) * GeometrySmith(N, V, N, 1.0)
             * (EnvBRDFApprox(1.0, 1.0).x + EnvBRDFApprox(1.0, 1.0).y);

    // Area lights. `shadeSurface` is reached through accumulateLight below, but the two SAMPLERS are
    // only reachable from here — a custom material that wants to build its own area light needs them.
    let sphere = sphereLightSample(V, 1.0, 0.05, N, 1.0);
    let disc = discLightSample(N, 0.00465, V, 1.0);
    let area = sphere.direction * sphere.normalization + disc.direction * disc.normalization;

    let keepAlive = evaluateDirectionalLight(dir, N, V, zero3, 0.0, 1.0, 1.0)
                  + evaluatePointLight(pt, zero3, N, V, zero3, 0.0, 1.0)
                  + evaluateSpotLight(sp, zero3, N, V, zero3, 0.0, 1.0, 1.0)
                  + fresnelSchlickRoughness(1.0, zero3, 1.0)
                  + vec3<f32>(computeSpecularAO(1.0, 1.0, 1.0))
                  + energyCompensation(zero3, 1.0, 1.0) * brdf
                  + shadeSurface(N, V, zero3, 0.0, 1.0, N, N, 1.0, zero3)
                  + area * 0.0
                  + accumulateLight(N, V, zero3, 0.0, 1.0, N, zero3);
    return vec4<f32>(keepAlive, 1.0);
}
