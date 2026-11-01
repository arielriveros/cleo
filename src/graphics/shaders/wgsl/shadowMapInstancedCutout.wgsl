// Alpha-cutout depth pass for BILLBOARD foliage.
//
// Grass impostors are crossed quads whose shape lives entirely in the texture's alpha, so a plain
// depth-only pass would rasterize two solid rectangles and cast rectangular shadows. Mirrors the cutout
// in geometryFoliageBillboard.

// Build-time variants: the FOLIAGE material's bend (chunks/foliageWind.wgsl: wind, interaction, weather
// droop), so a plant's shadow moves with it; and the far-card wind alone, for billboard layers.
// @variant foliage CLEO_WIND=1 CLEO_FOLIAGE=1
// @variant wind CLEO_WIND=1

#include "./chunks/instancedDepthVertex.wgsl"
#include "./chunks/alphaCutout.wgsl"

@group(0) @binding(0) var u_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_texture_sampler: sampler;

// Shared with the non-instanced cutout variants; see shadowMapCutout.wgsl for what u_useRed selects.
// The threshold used to be a literal 0.5 here, which silently disagreed with whatever the material's
// own alphaCutoff said.
struct CutoutDepthUniforms {
    u_cutoff: f32,
    u_useRed: i32,
};
@group(1) @binding(1) var<uniform> u_cutout: CutoutDepthUniforms;

@fragment
fn fs_main(in: VertexOutput) {
    let texel = textureSample(u_texture_texture, u_texture_sampler, in.uv);
    let coverage = cutoutAlpha(select(texel.a, texel.r, u_cutout.u_useRed != 0),
                               dpdx(in.uv), dpdy(in.uv), textureDimensions(u_texture_texture, 0));
    if (coverage < u_cutout.u_cutoff) { discard; }
}
