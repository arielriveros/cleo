// @glsl-chunk
//
// Generates the GLSL form of the shadow library for `systems/customShaders.ts`, which assembles
// user-authored GLSL at runtime and pastes the library in as text.
//
// This module exists ONLY to be translated. Its entry point renders nothing; it is here because naga
// emits only functions REACHABLE from an entry point, so every function the chunk must export has to be
// called below or it is dead-code eliminated and silently absent. If a new public function is added to
// chunks/shadows.wgsl, add a call for it here too.
//
// `extractGlslChunk` then strips the version header, the precision lines, the fragment output and
// main(), leaving the structs, uniforms, globals and functions to paste.

#include "./chunks/shadows.wgsl"

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    cleoFragCoord = fragCoord.xy;

    let worldPos = vec3<f32>(0.0);
    let N = vec3<f32>(0.0, 1.0, 0.0);
    let keepAlive = directionalShadow(worldPos, N, 1.0)
                  + shadowVisibility(worldPos, 1.0)
                  + cleoPunctualVisibility(0, 0, worldPos, N, worldPos)
                  + cascadeDebugTint(1.0).x;
    return vec4<f32>(keepAlive);
}
