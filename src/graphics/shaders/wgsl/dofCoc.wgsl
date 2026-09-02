// Depth of field, pass 1 of 3: circle of confusion, and the half-resolution image the gather works on.
//
// The CoC is a THIN LENS, not a ramp from the focal plane, and the difference is the whole reason an
// f-stop means anything here: the near field blurs far harder than the far field at the same distance
// from focus, and the far field saturates at infinity instead of growing without bound. `dofMath.ts`
// holds the same formula in TypeScript and is where it is tested — keep the two in step.
//
// Output is `vec3 colour` plus the SIGNED, normalised CoC in alpha. The sign is load-bearing: a near
// field spreads over what is behind it, a far field is occluded by what is in front, and a gather that
// only had a magnitude would have to guess and would halo every foreground silhouette.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/depthLinearize.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
// A DEPTH texture, declared as one. A depth format cannot satisfy a `texture_2d<f32>` binding on
// WebGPU — the bind group is refused outright and the pass blanks, with nothing said about why.
@group(0) @binding(2) var u_depth_texture: texture_depth_2d;
@group(0) @binding(3) var u_depth_sampler: sampler;

struct DofUniforms {
    u_near: f32,
    u_far: f32,
    /** Metres. Either the authored distance or, when the camera has a focus target, its view depth. */
    u_focusDistance: f32,
    /** Half the band around the focal plane that stays perfectly sharp. See `effectiveFocusDistance`. */
    u_focusHalfRange: f32,
    u_focalLength: f32,
    /** `f*f / N / sensorHeight * screenHeight` — everything in the CoC that is constant per frame. */
    u_cocScale: f32,
    /** Clamp on the CoC in full-resolution pixels. A cost control: the gather samples for a radius. */
    u_maxCocPx: f32,
    u_srcTexelSize: vec2<f32>,
};
@group(1) @binding(0) var<uniform> u_dof: DofUniforms;

/** Signed CoC in pixels at a view depth, mirroring `circleOfConfusion` in dofMath.ts. */
fn cocPixels(depth: f32) -> f32 {
    if (depth <= 1e-4) { return 0.0; }

    // The sharp band, measured from its EDGE rather than its centre — zeroing the CoC inside instead
    // leaves a visible step where a pixel just outside jumps to the CoC it would have had at the centre.
    var focus = u_dof.u_focusDistance;
    let half = max(0.0, u_dof.u_focusHalfRange);
    if (depth < focus - half) { focus = focus - half; }
    else if (depth > focus + half) { focus = focus + half; }
    else { focus = depth; }

    // Focusing at or inside the focal length is not a configuration a lens has, and would flip the
    // sign of the whole expression rather than failing visibly.
    let subject = max(focus, u_dof.u_focalLength * 1.0001);
    let coc = (u_dof.u_cocScale / (subject - u_dof.u_focalLength)) * ((depth - subject) / depth);
    return clamp(coc, -u_dof.u_maxCocPx, u_dof.u_maxCocPx);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // A 2x2 box off the full-resolution source, which is the downsample. Taken at the four texel
    // centres of the block this half-res pixel covers, so the filter is a true average rather than a
    // point sample of one corner.
    let o = u_dof.u_srcTexelSize * 0.5;
    let c0 = textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, in.uv + vec2<f32>(-o.x, -o.y), 0.0).rgb;
    let c1 = textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, in.uv + vec2<f32>( o.x, -o.y), 0.0).rgb;
    let c2 = textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, in.uv + vec2<f32>(-o.x,  o.y), 0.0).rgb;
    let c3 = textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, in.uv + vec2<f32>( o.x,  o.y), 0.0).rgb;
    let color = (c0 + c1 + c2 + c3) * 0.25;

    // Depth is NOT averaged — it is point-sampled, and it must be. `depth24plus` is not a filterable
    // format, and averaging depths across a silhouette invents a surface halfway between the two that
    // is at neither distance, which then focuses as though it were real.
    // The level is an INTEGER here, not 0.0: `textureSampleLevel` on a depth texture takes an i32
    // level, and a float is a hard WGSL validation error rather than an implicit conversion.
    let d = textureSampleLevel(u_depth_texture, u_depth_sampler, in.uv, 0);

    // Sky. The depth buffer holds the clear value there — nothing wrote it — and linearising that
    // lands somewhere arbitrary near the far plane. Treat it as genuinely at infinity, which is what
    // it is, so a scene focused on the foreground blurs its background by the full CoC rather than by
    // whatever the far plane happens to be set to.
    var cocN: f32;
    if (d >= 1.0) { cocN = select(0.0, 1.0, u_dof.u_maxCocPx > 0.0); }
    else { cocN = cocPixels(linearizeDepth(d, u_dof.u_near, u_dof.u_far)) / max(1e-4, u_dof.u_maxCocPx); }

    return vec4<f32>(color, cocN);
}
