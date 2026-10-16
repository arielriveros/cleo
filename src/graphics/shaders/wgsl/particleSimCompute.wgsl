// The particle simulation step as a COMPUTE dispatch — the WebGPU harness of chunks/particleSimCore.wgsl.
//
// Reads the A state textures, writes the B set through storage textures; the renderer swaps them
// between steps. One invocation per slot of the LIVE WINDOW only: `u_mask.z` slots-from-start and
// `u_mask.w` count, wrapping round the ring. Every slot outside it is known dead (particleRuntime.ts).
// Flat 64-wide groups, so a one-row pool does not launch 8x8 groups that are seven-eighths idle.
//
// No GLSL half: ES 300 has no compute stage. WebGL2 runs particleSim.wgsl, the same core as a
// fullscreen draw into four colour targets.

// Variants with whole modules compiled out, keyed by the strip mask the renderer computes per emitter
// (particleVariants.ts: 1 noise, 2 force fields, 4 collision, 8 sub-emitter). Each strips only what the
// emitter's own mask already skips at runtime, so a variant behaves exactly like the full program.
// @variant s1 SIM_STRIP_NOISE
// @variant s2 SIM_STRIP_FIELDS
// @variant s3 SIM_STRIP_NOISE SIM_STRIP_FIELDS
// @variant s4 SIM_STRIP_COLLIDE
// @variant s5 SIM_STRIP_NOISE SIM_STRIP_COLLIDE
// @variant s6 SIM_STRIP_FIELDS SIM_STRIP_COLLIDE
// @variant s7 SIM_STRIP_NOISE SIM_STRIP_FIELDS SIM_STRIP_COLLIDE
// @variant s8 SIM_STRIP_SUB
// @variant s9 SIM_STRIP_NOISE SIM_STRIP_SUB
// @variant s10 SIM_STRIP_FIELDS SIM_STRIP_SUB
// @variant s11 SIM_STRIP_NOISE SIM_STRIP_FIELDS SIM_STRIP_SUB
// @variant s12 SIM_STRIP_COLLIDE SIM_STRIP_SUB
// @variant s13 SIM_STRIP_NOISE SIM_STRIP_COLLIDE SIM_STRIP_SUB
// @variant s14 SIM_STRIP_FIELDS SIM_STRIP_COLLIDE SIM_STRIP_SUB
// @variant s15 SIM_STRIP_NOISE SIM_STRIP_FIELDS SIM_STRIP_COLLIDE SIM_STRIP_SUB

#include "./chunks/particleSimCore.wgsl"

@group(2) @binding(0) var u_out0: texture_storage_2d<rgba32float, write>;
@group(2) @binding(1) var u_out1: texture_storage_2d<rgba32float, write>;
@group(2) @binding(2) var u_out2: texture_storage_2d<rgba32float, write>;
@group(2) @binding(3) var u_out3: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(64, 1, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let width = u32(u_sim.u_step.w);
    let capacity = u32(u_sim.u_step.z);
    if (gid.x >= u32(u_sim.u_mask.w)) { return; }
    let slot = (u32(u_sim.u_mask.z) + gid.x) % capacity;
    let texel = vec2<i32>(i32(slot % width), i32(slot / width));
    let p = simulateSlot(slot, texel);
    textureStore(u_out0, texel, vec4<f32>(p.position, p.age));
    textureStore(u_out1, texel, vec4<f32>(p.velocity, p.lifetime));
    textureStore(u_out2, texel, vec4<f32>(p.rotation, p.spin, p.size, p.seed));
    textureStore(u_out3, texel, p.color);
}
