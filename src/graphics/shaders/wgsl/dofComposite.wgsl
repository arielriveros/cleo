// Depth of field, pass 3 of 3: blend the half-resolution bokeh back over the sharp image.
//
// The CoC is recomputed here at FULL resolution rather than upsampled from the prefilter, and that is
// the point of the pass. The blend factor is what decides where the image stops being sharp, so an
// upsampled one would put that boundary on the half-res grid — a visibly stepped edge along every
// silhouette that crosses the focal plane. One depth tap and a few multiplies is cheap next to that.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/depthLinearize.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;   // the sharp, full-res chain
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
@group(0) @binding(2) var u_dofTexture_texture: texture_2d<f32>;      // half-res bokeh + near coverage
@group(0) @binding(3) var u_dofTexture_sampler: sampler;
@group(0) @binding(4) var u_depth_texture: texture_depth_2d;
@group(0) @binding(5) var u_depth_sampler: sampler;

struct DofCompositeUniforms {
    u_near: f32,
    u_far: f32,
    u_focusDistance: f32,
    u_focusHalfRange: f32,
    u_focalLength: f32,
    u_cocScale: f32,
    u_maxCocPx: f32,
};
@group(1) @binding(0) var<uniform> u_dofComposite: DofCompositeUniforms;

/** Signed CoC in pixels. The same formula as dofCoc.wgsl and dofMath.ts; keep all three in step. */
fn cocPixels(depth: f32) -> f32 {
    if (depth <= 1e-4) { return 0.0; }
    var focus = u_dofComposite.u_focusDistance;
    let half = max(0.0, u_dofComposite.u_focusHalfRange);
    if (depth < focus - half) { focus = focus - half; }
    else if (depth > focus + half) { focus = focus + half; }
    else { focus = depth; }
    let subject = max(focus, u_dofComposite.u_focalLength * 1.0001);
    let coc = (u_dofComposite.u_cocScale / (subject - u_dofComposite.u_focalLength))
              * ((depth - subject) / depth);
    return clamp(coc, -u_dofComposite.u_maxCocPx, u_dofComposite.u_maxCocPx);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let sharp = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv);
    // Bilinear off the half-res buffer IS the upsample. The bokeh has no detail finer than its own
    // disc, so a wider reconstruction filter would cost taps to soften something already smooth.
    let bokeh = textureSample(u_dofTexture_texture, u_dofTexture_sampler, in.uv);

    let d = textureSample(u_depth_texture, u_depth_sampler, in.uv);
    var coc: f32;
    if (d >= 1.0) { coc = u_dofComposite.u_maxCocPx; }   // sky: at infinity, as in dofCoc.wgsl
    else { coc = cocPixels(linearizeDepth(d, u_dofComposite.u_near, u_dofComposite.u_far)); }

    // Below about a pixel of CoC there is nothing to see and the half-res buffer can only lose detail,
    // so hold the sharp image and fade the bokeh in from there.
    let farBlend = smoothstep(0.75, 2.0, coc);

    // The near field is blended by COVERAGE, not by this pixel's own CoC. A sharp background pixel
    // behind a defocused foreground has a CoC of zero and must still be painted over — that spill is
    // the difference between a foreground that is out of focus and one that is merely soft.
    let blend = clamp(max(farBlend, bokeh.a), 0.0, 1.0);

    // Alpha passed through from the sharp image: it carries the bloom mask, and the gather's alpha is
    // near-field coverage rather than anything to composite.
    return vec4<f32>(mix(sharp.rgb, bokeh.rgb, blend), sharp.a);
}
