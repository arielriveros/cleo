// The colour-grading LUT: a 3D lookup applied to the DISPLAY colour, after the tone curve.
//
// After, and in display space, because that is what every LUT authoring tool assumes — a .cube from
// Resolve or a strip graded in Photoshop describes a mapping of 0..1 sRGB onto 0..1 sRGB. Applying
// one in linear would grade a signal it was never measured against.
//
// This chunk OWNS @group(0) @binding(4) and (5), so it is separate from chunks/grade.wgsl: a
// program that only wants the tone curve should not inherit a binding it must then satisfy on every
// frame. Its two includers (present.wgsl, outlinePost.wgsl) both use 0/1 and 2/3 for their own
// texture pairs, so the LUT lands third in _textureBindGroup's (texture, sampler) pairing. A third
// includer has to have the same shape, or it collides.
//
// See graphics/colorGrading.ts for how the volume is built, and for the strip convention (red
// across a tile, green DOWN from the top row, blue across the tiles).

@group(0) @binding(4) var u_colorLut_texture: texture_3d<f32>;
@group(0) @binding(5) var u_colorLut_sampler: sampler;

/**
 * Look the display colour up in the grading LUT and blend by `intensity`.
 *
 * `size` is the LUT's edge length: 2 for the identity volume, 16 or 32 for a real one. The
 * scale/offset is the half-texel inset every 3D LUT needs — a LUT's outermost entries describe the
 * values AT 0 and AT 1, which live at the CENTRES of the first and last texels. Mapping 0..1
 * straight onto uvw reads half a texel outside the data at both ends, clamps, and flattens the
 * extremes: black stops being black.
 *
 * textureSampleLevel, not textureSample: the volume has exactly one level, and this call sits
 * downstream of a per-fragment early return in outlinePost, where WGSL forbids the derivative-taking
 * form. That is not hypothetical here — see the comment in outlinePost.wgsl.
 */
fn applyColorLut(display: vec3<f32>, size: f32, intensity: f32) -> vec3<f32> {
    let c = clamp(display, vec3<f32>(0.0), vec3<f32>(1.0));
    let uvw = c * ((size - 1.0) / size) + (0.5 / size);
    let graded = textureSampleLevel(u_colorLut_texture, u_colorLut_sampler, uvw, 0.0).rgb;
    return mix(c, graded, intensity);
}
