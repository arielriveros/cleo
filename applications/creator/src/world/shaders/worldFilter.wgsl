// The World graph's Erosion Filter node (graph/nodes/erosionNodes.ts; erosionFilter.ts `filterRows` is the
// CPU statement). Fields are storage arrays of 3N floats: heights, then d/du, then d/dv (normalised).
// Outputs: the height, the ridge map (0..1) and the gullies mask, each as a field (zero gradients).

#include "./worldNoiseCommon.wgsl"
#include "./erosionFilterCommon.wgsl"

struct FilterUniforms {
    res: u32,
    /** bit 0 exact gradients, 1 strength mask, 2 detail mask, 3 fade mask. */
    flags: u32,
    seed: u32,
    octaves: u32,
    size: f32,
    height_scale: f32,
    spacing: f32,
    depth: f32,
    gully_weight: f32,
    detail: f32,
    gain: f32,
    lacunarity: f32,
    peak_rounding: f32,
    valley_rounding: f32,
    input_rounding: f32,
    rounding_falloff: f32,
    onset_input: f32,
    onset_octave: f32,
    onset_ridge_input: f32,
    onset_ridge_octave: f32,
    assumed_slope: f32,
    straighten: f32,
    cell_scale: f32,
    normalization: f32,
    valley_level: f32,
    peak_level: f32,
    height_bias: f32,
    keep_altitude: f32,
};

@group(0) @binding(0) var<uniform> u: FilterUniforms;
@group(0) @binding(1) var<storage, read> field_in: array<f32>;
@group(0) @binding(2) var<storage, read> mask_strength: array<f32>;
@group(0) @binding(3) var<storage, read> mask_detail: array<f32>;
@group(0) @binding(4) var<storage, read> mask_fade: array<f32>;
@group(0) @binding(5) var<storage, read_write> out_height: array<f32>;
@group(0) @binding(6) var<storage, read_write> out_ridges: array<f32>;
@group(0) @binding(7) var<storage, read_write> out_gullies: array<f32>;

fn hAt(c: u32, r: u32) -> f32 { return field_in[r * u.res + c]; }

@compute @workgroup_size(8, 8, 1)
fn cs_filter(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= u.res || g.y >= u.res) { return; }
    let n = u.res * u.res;
    let i = g.y * u.res + g.x;
    let h = field_in[i];
    let kh = u.height_scale;

    var slope: vec2<f32>;
    if ((u.flags & 1u) != 0u) {
        slope = vec2<f32>(field_in[n + i], field_in[2u * n + i]) * kh / u.size;
    } else {
        let cell = u.size / f32(u.res - 1u);
        let c0 = select(g.x, g.x - 1u, g.x > 0u);
        let c1 = select(g.x, g.x + 1u, g.x < u.res - 1u);
        let r0 = select(g.y, g.y - 1u, g.y > 0u);
        let r1 = select(g.y, g.y + 1u, g.y < u.res - 1u);
        slope = vec2<f32>(
            (hAt(c1, g.y) - hAt(c0, g.y)) * kh / (f32(c1 - c0) * cell),
            (hAt(g.x, r1) - hAt(g.x, r0)) * kh / (f32(r1 - r0) * cell));
    }

    var fade: f32;
    if ((u.flags & 8u) != 0u) {
        fade = clamp(mask_fade[i], 0.0, 1.0) * 2.0 - 1.0;
    } else {
        let span = u.peak_level - u.valley_level;
        let t = select((h - u.valley_level) / span, 0.5, abs(span) < 1e-9);
        fade = clamp(t * 2.0 - 1.0, -1.0, 1.0);
    }
    var strength = u.depth;
    if ((u.flags & 2u) != 0u) { strength = strength * clamp(mask_strength[i], 0.0, 1.0); }
    var detail = u.detail;
    if ((u.flags & 4u) != 0u) { detail = detail * clamp(mask_detail[i], 0.0, 1.0); }

    var k: FilterParams;
    k.spacing = u.spacing;
    k.depth = u.depth;
    k.gully_weight = u.gully_weight;
    k.detail = u.detail;
    k.gain = u.gain;
    k.lacunarity = u.lacunarity;
    k.peak_rounding = u.peak_rounding;
    k.valley_rounding = u.valley_rounding;
    k.input_rounding = u.input_rounding;
    k.rounding_falloff = u.rounding_falloff;
    k.onset_input = u.onset_input;
    k.onset_octave = u.onset_octave;
    k.onset_ridge_input = u.onset_ridge_input;
    k.onset_ridge_octave = u.onset_ridge_octave;
    k.assumed_slope = u.assumed_slope;
    k.straighten = u.straighten;
    k.cell_scale = u.cell_scale;
    k.normalization = u.normalization;
    k.octaves = i32(u.octaves);
    k.seed = u.seed;

    let step = u.size / f32(u.res - 1u);
    let pt = erosionFilterPoint(vec2<f32>(f32(g.x), f32(g.y)) * step, slope, fade, strength, detail, k);
    let offset = (u.height_bias + (-fade - u.height_bias) * u.keep_altitude) * pt.value.y;
    let d = pt.value.x + offset;
    out_height[i] = h + d / kh;
    out_height[n + i] = 0.0;
    out_height[2u * n + i] = 0.0;
    out_ridges[i] = pt.value.z * 0.5 + 0.5;
    out_ridges[n + i] = 0.0;
    out_ridges[2u * n + i] = 0.0;
    // Carved depth as a mask, as erosionNodes.ts makes it: 1 where the top octave's full depth was cut.
    out_gullies[i] = clamp(-d / max(1e-6, u.depth * u.spacing), 0.0, 1.0);
    out_gullies[n + i] = 0.0;
    out_gullies[2u * n + i] = 0.0;
}
