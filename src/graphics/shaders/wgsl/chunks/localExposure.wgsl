// Local exposure, stage 3: the per-pixel exposure shift, read in the display resolve (present.wgsl,
// outlinePost.wgsl). Owns bindings 6/7 of group 0; see localExposureLum.wgsl for the whole scheme.
//
// The coarse level holds, per region, how well a brighter, the frame's own and a darker exposure would
// show it. Fusing them is a weighted average of the three exposures' stops — +shadow, 0, -highlight — so a
// region only a lifted exposure shows well moves toward it, and so on. That is read with a JOINT bilateral
// upsample: a 4x4 neighbourhood of coarse texels, weighted by distance and by how close each region's mean
// log luminance is to THIS pixel's. A dark pixel at the edge of a bright region takes the dark region's
// shift, so the lift and the hold stop at the boundary rather than haloing across it.

@group(0) @binding(6) var u_localExposure_texture: texture_2d<f32>;
@group(0) @binding(7) var u_localExposure_sampler: sampler;

/**
 * The local exposure shift in stops at `uv` for a pixel of exposed luminance `exposedLum`. `params` is
 * (strength, shadow stops, highlight stops, guide sharpness in 1/stops^2); strength 0 returns 0 and never
 * reads the texture's contents.
 */
fn localExposureStops(uv: vec2<f32>, exposedLum: f32, params: vec4<f32>) -> f32 {
    if (params.x <= 0.0) { return 0.0; }
    let size = vec2<f32>(textureDimensions(u_localExposure_texture, 0));
    let p = uv * size - 0.5;
    let base = floor(p);
    let logLum = log2(max(exposedLum, 1e-6));
    var sum = 0.0;
    var total = 0.0;
    for (var j = -1; j <= 2; j++) {
        for (var i = -1; i <= 2; i++) {
            let cell = base + vec2<f32>(f32(i), f32(j));
            let t = textureSampleLevel(u_localExposure_texture, u_localExposure_sampler,
                                       (cell + 0.5) / size, 0.0);
            let d = cell - p;
            let spatial = exp(-dot(d, d) * 0.7);
            let dl = logLum - t.a;
            let range = exp(-dl * dl * params.w);
            let weightSum = max(t.r + t.g + t.b, 1e-4);
            let stops = (t.r * params.y - t.b * params.z) / weightSum;
            let w = spatial * range + 1e-6;
            sum += stops * w;
            total += w;
        }
    }
    return params.x * sum / total;
}
