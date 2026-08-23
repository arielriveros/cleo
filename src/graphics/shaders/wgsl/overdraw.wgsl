// Overdraw counter. Every fragment that survives to this shader contributes a fixed increment, which
// the renderer accumulates with additive blending (GL_ONE/GL_ONE) and no depth test, so the red channel
// ends up holding (fragments shaded here) / OVERDRAW_MAX. debugView mode 7 ramps that to a heat map.
//
// Depth testing is deliberately OFF: the point is to count every fragment the rasterizer produced,
// including the ones a depth test would later reject — those still cost the shading that overdraw is
// meant to expose.
//
// It rasterizes SCENE geometry, not a fullscreen quad, so it takes a mesh vertex stage — the same
// one the selection outline uses, which is what the GLSL pairing does too.

#include "./chunks/outlineVertex.wgsl"

struct OverdrawUniforms {
    u_increment: f32,
};
@group(0) @binding(0) var<uniform> u_overdraw: OverdrawUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(u_overdraw.u_increment, 0.0, 0.0, 1.0);
}
