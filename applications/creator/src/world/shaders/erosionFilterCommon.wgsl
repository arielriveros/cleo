/*
 * The erosion filter on the GPU: the WGSL twin of world/erosionFilter.ts, operation for operation.
 *
 * Advanced Terrain Erosion Filter and Phacelle Noise copyright (c) 2025 Rune Skovbo Johansen.
 * https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the
 * MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Needs worldNoiseCommon.wgsl (latticeUnit2, easeOut, powInv, smoothStart) included first, and the
 * includer's `FilterParams` values passed in.
 */

const EF_TAU: f32 = 6.28318530718;
const EF_MAX_OCTAVES: i32 = 10;
/** Squared distance at which the cell bell reaches 0 (erosionFilter.ts BELL_END_D2). */
const EF_BELL_END_D2: f32 = 2.2499548;

struct FilterParams {
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
    octaves: i32,
    seed: u32,
};

/** (cos, sin, sideX, sideY): the stripe pattern along unit `dir`, blended from the 4x4 cells around p. */
fn phacelle(p: vec2<f32>, dir: vec2<f32>, freq: f32, offset: f32, normalization: f32, seed: u32) -> vec4<f32> {
    let side = vec2<f32>(-dir.y, dir.x) * freq * EF_TAU;
    let off = offset * EF_TAU;
    let pi = floor(p);
    let pf = p - pi;
    let ix = i32(pi.x);
    let iy = i32(pi.y);
    var phase = vec2<f32>(0.0, 0.0);
    var ws = 0.0;
    for (var i = -1; i <= 2; i = i + 1) {
        for (var j = -1; j <= 2; j = j + 1) {
            let jitter = latticeUnit2(ix + i, iy + j, seed) * 0.5;
            let v = pf - vec2<f32>(f32(i), f32(j)) - jitter;
            let d2 = dot(v, v);
            if (d2 >= EF_BELL_END_D2) { continue; }
            let w = max(0.0, exp(-2.0 * d2) - 0.01111);
            ws = ws + w;
            let a = dot(v, side) + off;
            phase = phase + vec2<f32>(cos(a), sin(a)) * w;
        }
    }
    let interp = phase / ws;
    let mag = max(1.0 - normalization, length(interp));
    return vec4<f32>(interp / mag, side);
}

struct FilterPoint {
    /** x = height delta (m), y = magnitude (m), z = ridge map (-1 creases .. 1 ridges). */
    value: vec3<f32>,
};

fn erosionFilterPoint(p: vec2<f32>, slope: vec2<f32>, fade_in: f32, strength_in: f32, detail: f32, k: FilterParams) -> FilterPoint {
    let scale = k.spacing;
    var strength = strength_in * scale;
    var fade = clamp(fade_in, -1.0, 1.0);
    var hx = 0.0;
    var freq = 1.0 / (scale * k.cell_scale);
    let slope_len = max(length(slope), 1e-10);
    var magnitude = 0.0;
    var rounding_mult = 1.0;

    let rounding_input = mix(k.valley_rounding, k.peak_rounding, clamp(fade + 0.5, 0.0, 1.0)) * k.input_rounding;
    var combi = easeOut(smoothStart(slope_len * k.onset_input, rounding_input * k.onset_input));
    var ridge_combi = easeOut(slope_len * k.onset_ridge_input);
    var ridge_fade = fade;

    var gully_slope = slope + (slope / slope_len * k.assumed_slope - slope) * k.straighten;

    let octaves = clamp(k.octaves, 0, EF_MAX_OCTAVES);
    for (var o = 0; o < octaves; o = o + 1) {
        let gl = length(gully_slope);
        let dir = select(vec2<f32>(0.0, 0.0), gully_slope / gl, gl > 1e-20);
        let ph = phacelle(p * freq, dir, k.cell_scale, 0.25, k.normalization, k.seed);
        let z = ph.zw * -freq;
        let sloping = abs(ph.y);
        gully_slope = gully_slope + sign(ph.y) * z * strength * k.gully_weight;

        let fh = fade + (ph.x * k.gully_weight - fade) * combi;
        hx = hx + fh * strength;
        magnitude = magnitude + strength;
        fade = fh;

        let rounding_octave = mix(k.valley_rounding, k.peak_rounding, clamp(ph.x + 0.5, 0.0, 1.0)) * rounding_mult;
        let new_mask = easeOut(smoothStart(sloping * k.onset_octave, rounding_octave * k.onset_octave));
        combi = powInv(combi, detail) * new_mask;

        ridge_fade = ridge_fade + (ph.x - ridge_fade) * ridge_combi;
        ridge_combi = ridge_combi * easeOut(sloping * k.onset_ridge_octave);

        strength = strength * k.gain;
        freq = freq * k.lacunarity;
        rounding_mult = rounding_mult * k.rounding_falloff;
    }
    var out: FilterPoint;
    out.value = vec3<f32>(hx, magnitude, ridge_fade * (1.0 - ridge_combi));
    return out;
}
