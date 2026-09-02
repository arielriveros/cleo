// Shared colour-space and tone-mapping helpers — the small, widely included half. The operators,
// the artist grade and the colour LUT live next door in chunks/grade.wgsl, which includes this and
// is taken only by the two programs that resolve to the display.
//
// Colour-space contract for the whole renderer: every surface/sky shader lights and writes into the
// scene framebuffer in LINEAR HDR (no gamma, no tonemap). Tone mapping, exposure and sRGB encode are
// applied exactly once, at the final present. Input colour textures are sRGB-authored and must be
// decoded with toLinear() before use.

// sRGB <-> linear (approximate gamma 2.2; matches the pow(2.2) decode used in the geometry pass).
fn toLinear(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }
fn toSrgb(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(1.0 / 2.2)); }

// Filmic HDR -> LDR tonemap (Narkowicz 2015 ACES fit). Rolls bright values off to [0,1] instead of
// hard-clipping.
fn acesFilm(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Full display resolve: scale linear HDR by exposure, tonemap, then sRGB-encode for the display.
fn tonemap(hdr: vec3<f32>, exposure: f32) -> vec3<f32> {
    return toSrgb(acesFilm(hdr * exposure));
}

