// Shared color-space + tone-mapping helpers.
//
// Color-space contract for the whole renderer: every surface/sky shader lights and writes into the
// scene framebuffer in LINEAR HDR (no gamma, no tonemap). Tone mapping + exposure + sRGB encode are
// applied exactly once, at the final present (screen.fs / outline.fs). Input color textures (albedo,
// emissive, sky) are sRGB-authored and must be decoded with toLinear() before use.

// sRGB <-> linear (approximate gamma 2.2; matches the pow(2.2) decode used in the geometry pass).
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(c, vec3(1.0 / 2.2)); }

// Filmic HDR -> LDR tonemap (Narkowicz 2015 ACES fit). Rolls bright values off to [0,1] instead of
// hard-clipping.
vec3 acesFilm(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Full display resolve: scale linear HDR by exposure, tonemap, then sRGB-encode for the display.
vec3 tonemap(vec3 hdr, float exposure) {
    return toSrgb(acesFilm(hdr * exposure));
}
