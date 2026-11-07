// Weather volumes: what the weather is at a world point (render/weather.ts packs them, at most
// MAX_WEATHER_VOLUMES a frame). The CPU twin is `resolveWeatherAt` in render/weatherPack.ts; the two must
// agree.
//
// The includer owns the uniforms, so this chunk can serve a fragment-only block (the landscape's) and a
// vertex-only one (instanced foliage's) alike — a block read from both stages breaks naga's GLSL. Before
// including it, define:
//   fn weatherCount() -> i32
//   fn weatherInv(i: i32) -> mat4x4<f32>    world -> the volume's unit cube
//   fn weatherBlend(i: i32) -> vec4<f32>    feather fractions xyz, w = 1 unbounded
//   fn weatherAmount(i: i32) -> vec4<f32>   wetness, snow, puddles, shelter 0/1
//   fn weatherShape(i: i32) -> vec4<f32>    cos(snow slope), snow breakup
//
// COMPOSITING: in the order packed (ascending priority), each volume mixed over the ones below it by its
// own weight, so a dry box nested in a snowy one carves out a dry pocket.

#ifndef CLEO_WEATHER_VOLUMES
#define CLEO_WEATHER_VOLUMES 1

/** Mirrors `MAX_WEATHER_VOLUMES` in render/weatherPack.ts. */
const MAX_WEATHER_VOLUMES: i32 = 4;

struct WeatherSample {
    wet: f32,
    snow: f32,
    puddles: f32,
    /** 0..1: how much shelter applies (the volumes' `shelter` flags, weighted). */
    shelter: f32,
    slopeCos: f32,
    breakup: f32,
};

/** Mirrors `packedWeatherWeight` (boxWeight): 1 deep inside, smoothstepping to 0 at the faces. */
fn weatherBoxWeight(i: i32, p: vec3<f32>) -> f32 {
    let b = weatherBlend(i);
    if (b.w > 0.5) { return 1.0; }
    // Not `local`: GLSL reserves it, and naga's rename numbers it across the module (see below).
    let inCube = (weatherInv(i) * vec4<f32>(p, 1.0)).xyz;
    let edge = vec3<f32>(0.5) - abs(inCube);
    // `any`, never `||`: naga lowers a short circuit into a numbered local, and those numbers run across the
    // whole module, so a variant with more of them elsewhere would change this vertex stage's text.
    if (any(edge <= vec3<f32>(0.0))) { return 0.0; }
    let t = clamp(edge / max(b.xyz, vec3<f32>(1e-6)), vec3<f32>(0.0), vec3<f32>(1.0));
    let s = select(t * t * (3.0 - 2.0 * t), vec3<f32>(1.0), b.xyz <= vec3<f32>(0.0));
    return min(s.x, min(s.y, s.z));
}

fn weatherAt(p: vec3<f32>) -> WeatherSample {
    var s = WeatherSample(0.0, 0.0, 0.0, 0.0, 0.70710678, 0.4);
    let n = min(weatherCount(), MAX_WEATHER_VOLUMES);
    for (var i = 0; i < n; i++) {
        let w = weatherBoxWeight(i, p);
        if (w <= 0.0) { continue; }
        let a = weatherAmount(i);
        let sh = weatherShape(i);
        s.wet = mix(s.wet, a.x, w);
        s.snow = mix(s.snow, a.y, w);
        s.puddles = mix(s.puddles, a.z, w);
        s.shelter = mix(s.shelter, a.w, w);
        s.slopeCos = mix(s.slopeCos, sh.x, w);
        s.breakup = mix(s.breakup, sh.y, w);
    }
    return s;
}

#endif
