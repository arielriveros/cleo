// Depth of field, pass 2 of 3: the bokeh gather.
//
// This is the pass that makes discs instead of smears. A blur convolves a kernel over the image; a
// lens SCATTERS each point across a disc the size of its own circle of confusion, which is why an
// out-of-focus highlight becomes a bright circle rather than a soft blob. Scattering is not something
// a fragment shader can do, so this inverts it — the standard scatter-as-gather: for every tap, ask
// whether THAT sample's disc is wide enough to reach the pixel being shaded, and take it if it is.
//
// Golden-angle spiral rather than concentric rings: the sample count then does not have to be
// factorised into rings and spokes, and the taps stay evenly spaced at every radius instead of
// bunching toward the centre.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_dofTexture_texture: texture_2d<f32>;   // half-res colour + signed CoC
@group(0) @binding(1) var u_dofTexture_sampler: sampler;

struct DofGatherUniforms {
    /** The CoC clamp, expressed in HALF-resolution pixels — this pass works in that grid. */
    u_maxCocHalfPx: f32,
    u_texelSize: vec2<f32>,
};
@group(1) @binding(0) var<uniform> u_dofGather: DofGatherUniforms;

/** Taps in the spiral. 48 holds up to roughly a 16px half-res radius before the disc starts to bead. */
const TAPS: i32 = 48;
/** 2.39996… — the golden angle, in radians. */
const GOLDEN_ANGLE: f32 = 2.3999632;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let centre = textureSampleLevel(u_dofTexture_texture, u_dofTexture_sampler, in.uv, 0.0);
    let centreCoc = centre.a * u_dofGather.u_maxCocHalfPx;

    // The radius to search. A pixel in sharp focus still has to look around, because a blurred
    // NEIGHBOUR may scatter onto it — that is exactly how an out-of-focus foreground spills over a
    // sharp background. Searching only its own CoC would leave every foreground edge hard.
    let radius = u_dofGather.u_maxCocHalfPx;
    if (radius < 0.5) { return vec4<f32>(centre.rgb, 0.0); }

    var accum = centre.rgb;
    var weightSum = 1.0;
    var nearCoverage = max(0.0, -centre.a);

    for (var i: i32 = 0; i < TAPS; i = i + 1) {
        // sqrt distributes the taps by AREA rather than by radius, so the disc is evenly covered
        // instead of dense in the middle.
        let t = (f32(i) + 0.5) / f32(TAPS);
        let r = sqrt(t) * radius;
        let a = f32(i) * GOLDEN_ANGLE;
        let offset = vec2<f32>(cos(a), sin(a)) * r;

        // Explicit LOD: this is a loop, so the sample sits in non-uniform control flow as far as the
        // compiler is concerned, and an implicit derivative there is undefined in WGSL.
        let s = textureSampleLevel(u_dofTexture_texture, u_dofTexture_sampler,
                                   in.uv + offset * u_dofGather.u_texelSize, 0.0);
        let sampleCoc = abs(s.a) * u_dofGather.u_maxCocHalfPx;

        // Does this sample's disc reach us? The +1/-1 band is a one-pixel feather on the disc edge,
        // which is what stops the bokeh from having a hard aliased rim.
        var w = clamp(sampleCoc - r + 1.0, 0.0, 1.0);

        // A sample nearer the camera than us may spill over; one further away may not spill onto
        // something in front of it. Without this test the background bleeds into a sharp foreground
        // and every silhouette grows a halo.
        if (s.a >= 0.0 && sampleCoc < centreCoc) { w = w * clamp(1.0 + centreCoc - r, 0.0, 1.0); }

        accum = accum + s.rgb * w;
        weightSum = weightSum + w;

        // How much NEAR field covers this pixel, carried to the composite in alpha. The near field has
        // to be blended in by coverage rather than by the pixel's own CoC: a sharp pixel behind a
        // blurred foreground has no CoC of its own but must still be painted over.
        if (s.a < 0.0) { nearCoverage = max(nearCoverage, clamp(sampleCoc - r + 1.0, 0.0, 1.0)); }
    }

    return vec4<f32>(accum / weightSum, nearCoverage);
}
