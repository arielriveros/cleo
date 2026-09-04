// Editor overlay composite: put the chrome layer onto the already-resolved image.
//
// The grid, gizmos, helper wireframes and helper icons are drawn into their own buffer during the
// scene render precisely so no post pass ever sees them — they must not bloom, throw lens-flare
// ghosts, blur into depth of field or move the auto-exposure meter. That buffer is composited HERE,
// after `present`, which means its contents are display-referred: this pass encodes to sRGB and does
// nothing else. No exposure, no tone curve, no LUT — deliberately. Chrome is UI, and a gizmo that
// changed colour because the artist hung a teal-and-orange grade on the project would be a bug.
// `outlinePost.wgsl` already treats `u_outlineColor` the same way, for the same reason.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/tonemap.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let src = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv);
    // The overwhelmingly common case, since the layer is mostly empty. Returning zero rather than
    // dividing keeps the unpremultiply below away from alpha 0.
    if (src.a <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }

    // Unpremultiply, encode, re-premultiply. Encoding the premultiplied value directly would bend
    // every partly covered pixel toward white, which reads as a bright fringe along each grid line
    // and gizmo edge. The pass blends with OVERLAY_COMPOSITE_BLEND, whose source factor is `one`.
    let straight = min(src.rgb / src.a, vec3<f32>(1.0));
    return vec4<f32>(toSrgb(straight) * src.a, src.a);
}
