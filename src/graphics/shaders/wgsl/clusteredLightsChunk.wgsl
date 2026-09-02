// @glsl-chunk
//
// Generates the GLSL form of the clustered light lookup AND the PBR light library for
// `systems/customShaders.ts`, which assembles user-authored GLSL at runtime and pastes the library in
// as text. The twin of shadowsChunk.wgsl; read that one first.
//
// It covers both because it must. This module includes chunks/pbrLighting.wgsl — the cluster decode
// returns a `SpotLight` — so its output is a strict SUPERSET of what the retired pbrLightingChunk.wgsl
// emitted, and pasting the two would redeclare every struct and every BRDF function. So this file
// absorbed that one's keep-alive duties along with its output.
//
// This module exists ONLY to be translated. Its entry point renders nothing, and every accessor a
// custom material can call has to be REACHED below or naga eliminates it and it is silently absent
// from the chunk — no error, just a material that will not compile with a message about an undeclared
// identifier the engine claims to provide.
//
// Unlike shadowsChunk.wgsl this declares one texture and one uniform block, so the Vulkan dialect
// needs the same `layout(set = …, binding = …)` rewrite the shadow library gets. See
// `vulkanClusterLibrary` in customShaders.ts.

#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let N = vec3<f32>(0.0, 1.0, 0.0);
    let V = vec3<f32>(0.0, 0.0, 1.0);
    let zero3 = vec3<f32>(0.0);

    // --- the cluster lookup -------------------------------------------------------------------
    // The whole chain, in the order a material's own loop walks it: fragment to cluster, cluster to a
    // run of entries, entry to a light index, index to a record. Each step keeps the one before it,
    // but `cleoLightTexel` is reached from all of them and the decode from none, so the record read
    // has to appear on its own.
    let cluster = cleoClusterOf(fragCoord.xy, 1.0);
    let first = cleoClusterOffset(cluster);
    let count = cleoClusterCount(cluster);
    let cl = cleoLight(cleoClusterLight(first));
    let clustered = cl.light.color * cl.light.intensity
                  + vec3<f32>(f32(count + cl.spotShadowLayer + cl.pointShadowSlot))
                  + cleoLightTexel(0).rgb;

    // --- the light structs and the BRDF -------------------------------------------------------
    // Inherited wholesale from pbrLightingChunk.wgsl, which this file replaced as the prelude's
    // source: every public function of chunks/pbrLighting.wgsl is CALLED here so that it survives
    // into the chunk. Naga currently emits a module's functions whether or not an entry point reaches
    // them, but that is a property of one backend version and not a guarantee — and a helper silently
    // missing from the chunk fails in a user's material, at runtime, as an undeclared identifier.
    //
    // Constructing each light keeps its STRUCT as well; a struct no function mentions is not emitted.
    let dir = DirectionalLight(N, 1.0, zero3, 0.0);
    let pt = PointLight(zero3, 1.0, zero3, 1.0, 0.05);
    let sp = SpotLight(zero3, 1.0, N, 0.05, zero3, 1.0, 1.0, 0.0);

    // The deprecated trio (DistributionGGX / GeometrySchlickGGX / GeometrySmith) rides along: dead in
    // the engine's own programs, still callable from user-authored GLSL in saved projects.
    let brdf = D_GGX(1.0, 1.0) * V_SmithGGXCorrelated(1.0, 1.0, 1.0)
             * Fd_Burley(1.0, 1.0, 1.0, 1.0)
             * DistributionGGX(N, N, 1.0) * GeometrySmith(N, V, N, 1.0)
             * (EnvBRDFApprox(1.0, 1.0).x + EnvBRDFApprox(1.0, 1.0).y);

    // Area lights. `shadeSurface` is reached through accumulateLight below, but the two SAMPLERS are
    // only reachable from here — a material that wants to build its own area light needs them.
    let sphere = sphereLightSample(V, 1.0, 0.05, N, 1.0);
    let disc = discLightSample(N, 0.00465, V, 1.0);
    let area = sphere.direction * sphere.normalization + disc.direction * disc.normalization;

    // `SkyLight` and `skyIrradiance` are deliberately NOT reached: they are scene-wide indirect light
    // the forward prelude has no uniform for. See pbrLightingChunk.wgsl, which said the same.
    let keepAlive = clustered
                  + evaluateDirectionalLight(dir, N, V, zero3, 0.0, 1.0, 1.0)
                  + evaluatePointLight(pt, zero3, N, V, zero3, 0.0, 1.0, 1.0)
                  + evaluateSpotLight(sp, zero3, N, V, zero3, 0.0, 1.0, 1.0)
                  + fresnelSchlickRoughness(1.0, zero3, 1.0)
                  + vec3<f32>(computeSpecularAO(1.0, 1.0, 1.0))
                  + vec3<f32>(horizonOcclusion(V, N))
                  + energyCompensation(zero3, 1.0, 1.0) * brdf
                  + shadeSurface(N, V, zero3, 0.0, 1.0, N, N, 1.0, zero3)
                  + area * 0.0
                  + accumulateLight(N, V, zero3, 0.0, 1.0, N, zero3);
    return vec4<f32>(keepAlive, 1.0);
}
