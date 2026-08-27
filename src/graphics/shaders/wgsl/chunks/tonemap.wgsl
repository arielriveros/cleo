// Shared colour-space and tone-mapping helpers. The WGSL twin of screen/tonemap.glsl.
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

/**
 * The same resolve with a saturation trim, applied in LINEAR HDR before the tonemap.
 *
 * Before, not after, and that is the whole reason this is a separate function rather than a lerp at
 * the end: desaturating after ACES pulls an already-rolled-off highlight toward an already-rolled-off
 * grey, which flattens the filmic shoulder into mush. Doing it in linear lets the tonemapper roll off
 * the corrected colour, so a de-saturated overcast frame keeps its highlight response.
 *
 * The weights are Rec.709 luma, which is the right basis for a linear signal.
 */
fn tonemapGraded(hdr: vec3<f32>, exposure: f32, saturation: f32) -> vec3<f32> {
    let lum = dot(hdr, vec3<f32>(0.2126, 0.7152, 0.0722));
    let graded = mix(vec3<f32>(lum), hdr, saturation);
    return toSrgb(acesFilm(graded * exposure));
}
