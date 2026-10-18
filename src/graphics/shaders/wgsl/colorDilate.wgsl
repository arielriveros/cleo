// Edge padding ("dilation") of a cutout material's base colour, by push-pull.
//
// THE PROBLEM. A cutout's colour map is usually authored over a background that never draws — black,
// for a grass JPG with a separate mask. The cutout hides those texels up close, but nothing else does:
// bilinear filtering at a blade's edge mixes the black in (the dark fringe no cutoff value removes),
// and every mip level box-filters blade and background together, so at a distance the grass that
// survives the cutout is mostly black. The fix every engine ships is to repaint the hidden texels with
// the colour of the nearest visible ones, so there is no black left for any filter to find.
//
// THE METHOD, run by systems/texturePacker.ts as a chain of fullscreen passes:
//   SEED  (mode 0): premultiply the base colour by its coverage — 1 where the cutout keeps the texel,
//                   0 where it discards it. Covered texels are carried EXACTLY.
//   PUSH  (mode 1): halve the image, averaging premultiplied colour and coverage together (one bilinear
//                   tap at the corner of four texels), down to 1x1. Each level is the coverage-weighted
//                   average colour of the region it covers.
//   TOP   (mode 4): the 1x1 push result, un-premultiplied — the seed of the fill.
//   PULL  (mode 2): back up, filling what a level does not cover from the already-filled level below:
//                   out = fine + (1 - fine.a) * coarse, with `fine` premultiplied and `coarse` a STRAIGHT
//                   colour, so the result is straight too. A covered texel (a = 1) passes through
//                   untouched. Filled levels are stored straight, not premultiplied: in RGBA8 a
//                   premultiplied colour at 2% coverage has five usable steps per channel.
//   FINAL (mode 3): the filled full-size level, with the base map's own alpha put back.
//
// Every fetch is `textureSampleLevel` at level 0: the intermediates have no mips, and the result is
// a straight per-texel function of its inputs.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_src0_texture: texture_2d<f32>;
@group(0) @binding(1) var u_src0_sampler: sampler;
@group(0) @binding(2) var u_src1_texture: texture_2d<f32>;
@group(0) @binding(3) var u_src1_sampler: sampler;

struct ColorDilateUniforms {
    /** 0 seed, 1 push, 2 pull, 3 final, 4 top. */
    u_mode: i32,
    /** Seed: the component of src1 that is coverage — 0 for a mask map (red), 3 for base alpha. */
    u_maskChannel: i32,
    /** Seed: the material's alpha cutoff; coverage is `mask >= cutoff`, i.e. what actually draws. */
    u_cutoff: f32,
    u_pad: f32,
};
@group(1) @binding(0) var<uniform> u_dilate: ColorDilateUniforms;

fn component(c: vec4<f32>, i: i32) -> f32 {
    if (i == 0) { return c.r; }
    if (i == 1) { return c.g; }
    if (i == 2) { return c.b; }
    return c.a;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let a = textureSampleLevel(u_src0_texture, u_src0_sampler, in.uv, 0.0);
    let b = textureSampleLevel(u_src1_texture, u_src1_sampler, in.uv, 0.0);
    // Uniform control flow throughout: `u_mode` is a uniform.
    if (u_dilate.u_mode == 0) {
        // src0 = base colour, src1 = coverage source.
        let w = select(0.0, 1.0, component(b, u_dilate.u_maskChannel) >= u_dilate.u_cutoff);
        return vec4<f32>(a.rgb * w, w);
    }
    if (u_dilate.u_mode == 1) {
        // src0 = the level above, sampled at the shared corner of the 2x2 it collapses.
        return a;
    }
    if (u_dilate.u_mode == 2) {
        // src0 = this level's premultiplied push result, src1 = the filled (straight) level below it.
        return vec4<f32>(a.rgb + (1.0 - a.a) * b.rgb, 1.0);
    }
    if (u_dilate.u_mode == 4) {
        // src0 = the 1x1 push result: the coverage-weighted mean colour of the whole map.
        return vec4<f32>(a.rgb / max(a.a, 1e-4), 1.0);
    }
    // src0 = the filled full-size level, src1 = the original base colour (for its alpha).
    return vec4<f32>(a.rgb, b.a);
}
