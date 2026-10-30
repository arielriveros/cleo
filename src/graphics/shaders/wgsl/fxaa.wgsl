// FXAA 3.11 (Lottes), quality variant: find the edge through each pixel from luma contrast, walk along
// it in both directions to find where it ends, and resample across it by the fraction of the edge
// this pixel covers. Plus the sub-pixel term, which blurs isolated single-pixel features toward their
// neighbourhood average.
//
// A post-process: it sees one frame and no motion, so unlike TAA it has nothing to ghost and nothing
// to lose under a moving camera — it simply smooths whatever stair-steps are on screen. That makes it
// the cheap AA on its own and a good companion to TAA, catching the edges TAA rejected history for
// (disocclusions, fast motion, `objectOnly` blur).
//
// On linear HDR, BEFORE the tone curve, because that is the last point in the chain; the edge test
// runs on an exposure-scaled, range-compressed, gamma-ish luma so its thresholds behave the way
// they were tuned to on an 8-bit display image.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct FxaaUniforms {
    u_texelSize: vec2<f32>,
    u_exposure: f32,
    /** Minimum local contrast, relative to the brightest neighbour, for a pixel to count as an edge. */
    u_edgeThreshold: f32,
    /** 0 = no sub-pixel smoothing, 1 = full (softer). */
    u_subpixel: f32,
    /** How many steps the edge search may take in each direction. */
    u_searchSteps: i32,
};
@group(1) @binding(0) var<uniform> u_fxaa: FxaaUniforms;

// Absolute contrast floor, so near-black noise is never treated as an edge.
const EDGE_THRESHOLD_MIN: f32 = 0.0312;
const MAX_STEPS: i32 = 12;

fn stepScale(i: i32) -> f32 {
    // FXAA_QUALITY__P0..P11 of the 39 preset: small steps first, then larger ones to reach long edges.
    if (i < 5) { return 1.0; }
    if (i == 5) { return 1.5; }
    if (i < 10) { return 2.0; }
    if (i == 10) { return 4.0; }
    return 8.0;
}

fn lumaAt(uv: vec2<f32>) -> f32 {
    let c = max(textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, uv, 0.0).rgb,
                vec3<f32>(0.0)) * u_fxaa.u_exposure;
    let l = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    // Range-compressed, then square-rooted: roughly the perceptual luma FXAA's constants assume.
    return sqrt(l / (1.0 + l));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let ts = u_fxaa.u_texelSize;
    let centre = textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, uv, 0.0);

    // `1` is the -x / -y side, `2` the +x / +y side.
    let lumaM = lumaAt(uv);
    let lumaN = lumaAt(uv + vec2<f32>(0.0, -ts.y));
    let lumaS = lumaAt(uv + vec2<f32>(0.0, ts.y));
    let lumaW = lumaAt(uv + vec2<f32>(-ts.x, 0.0));
    let lumaE = lumaAt(uv + vec2<f32>(ts.x, 0.0));

    let rangeMax = max(lumaM, max(max(lumaN, lumaS), max(lumaW, lumaE)));
    let rangeMin = min(lumaM, min(min(lumaN, lumaS), min(lumaW, lumaE)));
    let range = rangeMax - rangeMin;
    if (range < max(EDGE_THRESHOLD_MIN, rangeMax * u_fxaa.u_edgeThreshold)) { return centre; }

    let lumaNW = lumaAt(uv + vec2<f32>(-ts.x, -ts.y));
    let lumaNE = lumaAt(uv + vec2<f32>(ts.x, -ts.y));
    let lumaSW = lumaAt(uv + vec2<f32>(-ts.x, ts.y));
    let lumaSE = lumaAt(uv + vec2<f32>(ts.x, ts.y));

    // Which way does the edge run? Second differences across each axis, centre row weighted double.
    let edgeHorz = abs(-2.0 * lumaW + lumaNW + lumaSW) + 2.0 * abs(-2.0 * lumaM + lumaN + lumaS)
                 + abs(-2.0 * lumaE + lumaNE + lumaSE);
    let edgeVert = abs(-2.0 * lumaN + lumaNW + lumaNE) + 2.0 * abs(-2.0 * lumaM + lumaW + lumaE)
                 + abs(-2.0 * lumaS + lumaSW + lumaSE);
    let horizontal = edgeHorz >= edgeVert;

    // Which side of this pixel is the edge on? The steeper of the two gradients across it.
    let luma1 = select(lumaW, lumaN, horizontal);
    let luma2 = select(lumaE, lumaS, horizontal);
    let gradient1 = luma1 - lumaM;
    let gradient2 = luma2 - lumaM;
    let steepest1 = abs(gradient1) >= abs(gradient2);
    let gradientScaled = 0.25 * max(abs(gradient1), abs(gradient2));

    var stepLength = select(ts.x, ts.y, horizontal);
    var lumaLocalAverage = 0.5 * (luma2 + lumaM);
    if (steepest1) {
        stepLength = -stepLength;
        lumaLocalAverage = 0.5 * (luma1 + lumaM);
    }

    // Start half a pixel toward the edge, then search along it both ways.
    var currentUv = uv;
    if (horizontal) { currentUv.y += stepLength * 0.5; } else { currentUv.x += stepLength * 0.5; }
    let offset = select(vec2<f32>(0.0, ts.y), vec2<f32>(ts.x, 0.0), horizontal);

    var uv1 = currentUv - offset;
    var uv2 = currentUv + offset;
    var lumaEnd1 = lumaAt(uv1) - lumaLocalAverage;
    var lumaEnd2 = lumaAt(uv2) - lumaLocalAverage;
    var reached1 = abs(lumaEnd1) >= gradientScaled;
    var reached2 = abs(lumaEnd2) >= gradientScaled;

    let steps = clamp(u_fxaa.u_searchSteps, 1, MAX_STEPS);
    for (var i = 0; i < MAX_STEPS; i++) {
        if (i >= steps || (reached1 && reached2)) { break; }
        let s = stepScale(i);
        if (!reached1) {
            uv1 -= offset * s;
            lumaEnd1 = lumaAt(uv1) - lumaLocalAverage;
            reached1 = abs(lumaEnd1) >= gradientScaled;
        }
        if (!reached2) {
            uv2 += offset * s;
            lumaEnd2 = lumaAt(uv2) - lumaLocalAverage;
            reached2 = abs(lumaEnd2) >= gradientScaled;
        }
    }

    // How far this pixel sits along the edge decides how much of the other side it should take.
    let distance1 = select(uv.y - uv1.y, uv.x - uv1.x, horizontal);
    let distance2 = select(uv2.y - uv.y, uv2.x - uv.x, horizontal);
    let direction1 = distance1 < distance2;
    let distanceFinal = min(distance1, distance2);
    let edgeLength = max(distance1 + distance2, 1e-6);
    let pixelOffset = -distanceFinal / edgeLength + 0.5;

    // Only blend if the nearer end's luma moves the way this pixel's does; otherwise it is the far
    // side of a different edge.
    let centreSmaller = lumaM < lumaLocalAverage;
    let endLuma = select(lumaEnd2, lumaEnd1, direction1);
    let correctVariation = (endLuma < 0.0) != centreSmaller;
    var finalOffset = select(0.0, pixelOffset, correctVariation);

    // Sub-pixel aliasing: a pixel that differs from its whole 3x3 is blurred toward it.
    let lumaAverage = (1.0 / 12.0) * (2.0 * (lumaN + lumaS + lumaW + lumaE) + lumaNW + lumaNE + lumaSW + lumaSE);
    let sub1 = clamp(abs(lumaAverage - lumaM) / range, 0.0, 1.0);
    let sub2 = (-2.0 * sub1 + 3.0) * sub1 * sub1;
    finalOffset = max(finalOffset, sub2 * sub2 * clamp(u_fxaa.u_subpixel, 0.0, 1.0));

    var finalUv = uv;
    if (horizontal) { finalUv.y += finalOffset * stepLength; } else { finalUv.x += finalOffset * stepLength; }
    let rgb = textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, finalUv, 0.0).rgb;

    // Alpha is the bloom mask and passes through from the centre.
    return vec4<f32>(rgb, centre.a);
}
