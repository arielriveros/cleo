// Screen-space selection outline.
//
// Draws a thick, anti-aliased border just OUTSIDE the selected silhouette, plus a soft glow halo, so a
// selection reads as a pronounced highlight without repainting the object itself. Works by measuring
// the distance in pixels from each background pixel to the nearest silhouette texel within a radius.
//
// This pass writes to the display, so it also performs the final exposure/tonemap/sRGB resolve — it
// REPLACES the normal present pass rather than running before it. That means it must carry the WHOLE
// grade, not just the curve: it used to call the ungraded `tonemap()`, so selecting an object made
// the saturation trim disappear from the frame.

#include "./chunks/fullscreen.wgsl"
// grade.wgsl includes tonemap.wgsl itself; including both would declare toLinear() twice.
// colorLut.wgsl brings bindings 4/5 with it.
#include "./chunks/grade.wgsl"
#include "./chunks/colorLut.wgsl"

/** Search radius in texels. Bounds the maximum outline width. */
const R: i32 = 10;

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;   // composited scene, linear HDR
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
@group(0) @binding(2) var u_maskTexture_texture: texture_2d<f32>;     // silhouette; white = selected
@group(0) @binding(3) var u_maskTexture_sampler: sampler;
// Bindings 4/5 are the colour LUT, declared by chunks/grade.wgsl.

struct OutlinePostUniforms {
    u_texelSize: vec2<f32>,      // 1.0 / mask resolution
    u_outlineColor: vec3<f32>,   // sRGB display colour, composited AFTER tonemapping
    u_outlineWidth: f32,         // outline thickness, in pixels
    u_exposure: f32,
    // The rest of the grade, so this resolve matches present.wgsl's exactly. See the header.
    u_saturation: f32,
    u_toneMapper: i32,
    u_lutIntensity: f32,
    u_lutSize: f32,
};
@group(1) @binding(0) var<uniform> u_outline: OutlinePostUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let hdr = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv).rgb;
    let scene = applyColorLut(
        gradeToDisplay(hdr, u_outline.u_exposure, u_outline.u_saturation, u_outline.u_toneMapper),
        u_outline.u_lutSize, u_outline.u_lutIntensity);
    // The mask is read with `textureSampleLevel` at level 0, both here and in the search loop below.
    // The `center > 0.5` return is a per-fragment branch, so the loop after it is non-uniform control
    // flow, where WGSL forbids `textureSample` and rejects the module — which invalidated `outlinePost`
    // and left the selection outline undrawn. `_outlineMaskFBO` is `mipMap: false`, so level 0 is the
    // only level, and a silhouette read at exact texel offsets never wanted a mip anyway.
    let center = textureSampleLevel(u_maskTexture_texture, u_maskTexture_sampler, in.uv, 0.0).r;
    if (center > 0.5) { return vec4<f32>(scene, 1.0); }   // inside the object: leave untouched

    var best = 1e9;
    for (var y = -R; y <= R; y++) {
        for (var x = -R; x <= R; x++) {
            let d2 = f32(x * x + y * y);
            if (d2 > f32(R * R) || d2 == 0.0) { continue; }
            let uv = in.uv + vec2<f32>(f32(x), f32(y)) * u_outline.u_texelSize;
            if (textureSampleLevel(u_maskTexture_texture, u_maskTexture_sampler, uv, 0.0).r > 0.5) {
                best = min(best, d2);
            }
        }
    }

    let dist = sqrt(best);                          // pixels to the nearest silhouette edge
    let w = u_outline.u_outlineWidth;
    let glow = w * 1.25;                            // soft halo beyond the solid core

    // Solid, anti-aliased core out to `w`, then a faint falloff out to `w + glow`.
    let core = 1.0 - smoothstep(w - 1.0, w, dist);
    let halo = (1.0 - smoothstep(w, w + glow, dist)) * 0.4;
    let a = max(core, halo);

    return vec4<f32>(mix(scene, u_outline.u_outlineColor, a), 1.0);
}
