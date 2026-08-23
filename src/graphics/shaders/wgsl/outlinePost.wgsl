// Screen-space selection outline.
//
// Draws a thick, anti-aliased border just OUTSIDE the selected silhouette, plus a soft glow halo, so a
// selection reads as a pronounced highlight without repainting the object itself. Works by measuring
// the distance in pixels from each background pixel to the nearest silhouette texel within a radius.
//
// This pass writes to the display, so it also performs the final exposure/ACES/sRGB resolve — it
// REPLACES the normal present pass rather than running before it.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/tonemap.wgsl"

/** Search radius in texels. Bounds the maximum outline width. */
const R: i32 = 10;

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;   // composited scene, linear HDR
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
@group(0) @binding(2) var u_maskTexture_texture: texture_2d<f32>;     // silhouette; white = selected
@group(0) @binding(3) var u_maskTexture_sampler: sampler;

struct OutlinePostUniforms {
    u_texelSize: vec2<f32>,      // 1.0 / mask resolution
    u_outlineColor: vec3<f32>,   // sRGB display colour, composited AFTER tonemapping
    u_outlineWidth: f32,         // outline thickness, in pixels
    u_exposure: f32,
};
@group(1) @binding(0) var<uniform> u_outline: OutlinePostUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let scene = tonemap(textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv).rgb,
                        u_outline.u_exposure);
    let center = textureSample(u_maskTexture_texture, u_maskTexture_sampler, in.uv).r;
    if (center > 0.5) { return vec4<f32>(scene, 1.0); }   // inside the object: leave untouched

    var best = 1e9;
    for (var y = -R; y <= R; y++) {
        for (var x = -R; x <= R; x++) {
            let d2 = f32(x * x + y * y);
            if (d2 > f32(R * R) || d2 == 0.0) { continue; }
            let uv = in.uv + vec2<f32>(f32(x), f32(y)) * u_outline.u_texelSize;
            if (textureSample(u_maskTexture_texture, u_maskTexture_sampler, uv).r > 0.5) {
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
