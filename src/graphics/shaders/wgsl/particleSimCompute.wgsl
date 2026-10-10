// The particle simulation step as a COMPUTE dispatch — the WebGPU harness of chunks/particleSimCore.wgsl.
//
// Reads the A state textures, writes the B set through storage textures; the renderer swaps them
// between steps. One invocation per slot over the state texture's 2D extent.
//
// No GLSL half: ES 300 has no compute stage. WebGL2 runs particleSim.wgsl, the same core as a
// fullscreen draw into four colour targets.

#include "./chunks/particleSimCore.wgsl"

@group(2) @binding(0) var u_out0: texture_storage_2d<rgba32float, write>;
@group(2) @binding(1) var u_out1: texture_storage_2d<rgba32float, write>;
@group(2) @binding(2) var u_out2: texture_storage_2d<rgba32float, write>;
@group(2) @binding(3) var u_out3: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let width = u32(u_sim.u_step.w);
    let capacity = u32(u_sim.u_step.z);
    let height = (capacity + width - 1u) / width;
    if (gid.x >= width || gid.y >= height) { return; }
    let texel = vec2<i32>(gid.xy);
    let slot = gid.y * width + gid.x;
    let p = simulateSlot(slot, texel);
    textureStore(u_out0, texel, vec4<f32>(p.position, p.age));
    textureStore(u_out1, texel, vec4<f32>(p.velocity, p.lifetime));
    textureStore(u_out2, texel, vec4<f32>(p.rotation, p.spin, p.size, p.seed));
    textureStore(u_out3, texel, p.color);
}
