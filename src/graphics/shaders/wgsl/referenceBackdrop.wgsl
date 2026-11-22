// Reference backdrop: a picture (an animator's reference video frame) behind the scene, in the editor's
// overlay layer.
//
// Drawn FIRST into the overlay buffer, at depth 1.0 (the far plane) under a LEQUAL test against the scene's
// live depth, so it lands only where nothing was drawn: behind the character, never over it. The layer is
// display-referred -- composited after exposure, the tone curve and the grade -- so the frame shows as it
// was filmed. It arrives sRGB-encoded and the composite encodes once more, hence the decode here.
//
// `u_backdropRect` places the picture: its corners as fractions of the view from the top-left, so a
// letterboxed frame (the film gate) or a crop larger than the view both map directly.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_backdrop_texture: texture_2d<f32>;
@group(0) @binding(1) var u_backdrop_sampler: sampler;

struct BackdropUniforms {
    /** x0, y0, x1, y1: the picture's corners, fractions of the view from its top-left. */
    u_backdropRect: vec4<f32>,
    /** x: opacity; y: 1 to mirror left to right; zw unused. */
    u_backdropParams: vec4<f32>,
};
// Not `u_backdrop`: on WebGL2 the texture above becomes a sampler of that name, and a block of it too is a
// link error ("redefinition of an interface block member name") that stopped every program building.
@group(1) @binding(0) var<uniform> u_backdropBlock: BackdropUniforms;

struct BackdropOut {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

@fragment
fn fs_main(in: VertexOutput) -> BackdropOut {
    var out: BackdropOut;
    out.depth = 1.0;
    // The screen quad's uv has its origin bottom-left; the rectangle is measured from the top-left.
    let p = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
    let r = u_backdropBlock.u_backdropRect;
    var t = (p - r.xy) / max(r.zw - r.xy, vec2<f32>(1e-6));
    if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) {
        out.color = vec4<f32>(0.0);
        return out;
    }
    if (u_backdropBlock.u_backdropParams.y > 0.5) { t.x = 1.0 - t.x; }
    // Uploaded the way every image is, which samples with v = 0 at the picture's top: the top-left measure
    // is the texture coordinate as it stands. Sampled at level 0 explicitly: the branch above is not
    // uniform control flow, and the picture has no mips.
    let c = textureSampleLevel(u_backdrop_texture, u_backdrop_sampler, t, 0.0);
    out.color = vec4<f32>(srgbToLinear(c.rgb), clamp(u_backdropBlock.u_backdropParams.x, 0.0, 1.0));
    return out;
}
