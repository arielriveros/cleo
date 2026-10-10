// The particle simulation step as a FULLSCREEN DRAW into four colour targets — the WebGL2 harness of
// chunks/particleSimCore.wgsl, translated to GLSL ES 300 at build time like every other program.
//
// WebGL2 has no compute stage and no storage textures, so the state is ping-ponged: the A textures are
// sampled, the B textures are the render target, and every fragment is one slot. Its fragment
// coordinate IS the slot's texel on both backends, because rows count from the framebuffer's own origin
// and `textureLoad` addresses the texture from that same origin.
//
// The vertex stage is a single oversized triangle generated from the vertex index, so the pass needs no
// vertex buffer and no screen quad.

#include "./chunks/particleSimCore.wgsl"

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let x = f32((index << 1u) & 2u);
    let y = f32(index & 2u);
    return vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}

struct ParticleSimTargets {
    @location(0) p0: vec4<f32>,
    @location(1) p1: vec4<f32>,
    @location(2) p2: vec4<f32>,
    @location(3) p3: vec4<f32>,
};

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> ParticleSimTargets {
    let width = u32(u_sim.u_step.w);
    let texel = vec2<i32>(fragCoord.xy);
    let slot = u32(texel.y) * width + u32(texel.x);
    let p = simulateSlot(slot, texel);
    var out: ParticleSimTargets;
    out.p0 = vec4<f32>(p.position, p.age);
    out.p1 = vec4<f32>(p.velocity, p.lifetime);
    out.p2 = vec4<f32>(p.rotation, p.spin, p.size, p.seed);
    out.p3 = p.color;
    return out;
}
