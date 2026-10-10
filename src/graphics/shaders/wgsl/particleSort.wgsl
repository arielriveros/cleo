// The particle sort step as a fullscreen draw — WebGL2's ping-pong harness of
// chunks/particleSortCore.wgsl. One fragment per element; the fragment coordinate is its texel.

#include "./chunks/particleSortCore.wgsl"

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let x = f32((index << 1u) & 2u);
    let y = f32(index & 2u);
    return vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let width = u32(u_sort.u_sortSize.x);
    let texel = vec2<u32>(fragCoord.xy);
    return sortValue(texel.y * width + texel.x);
}
