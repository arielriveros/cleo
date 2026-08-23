// Alpha-cutout depth pass for BILLBOARD foliage.
//
// Grass impostors are crossed quads whose shape lives entirely in the texture's alpha, so a plain
// depth-only pass would rasterize two solid rectangles and cast rectangular shadows. Mirrors the cutout
// in geometryFoliageBillboard.

#include "./chunks/instancedDepthVertex.wgsl"

@group(0) @binding(0) var u_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_texture_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) {
    if (textureSample(u_texture_texture, u_texture_sampler, in.uv).a < 0.5) { discard; }
}
