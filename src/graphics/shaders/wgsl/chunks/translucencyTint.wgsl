// The colour light takes on through a thin translucent surface. Back-lit leaves are not just a brighter
// version of their front: light crossing the blade loses its blues and comes out yellow-green, and an
// autumn leaf glows orange. A material's `translucencyTint` (rgb = the colour, a = how far the transmitted
// light blends toward it) says which.
//
// The tint carries HUE and SATURATION only: it is matched to the surface's own luminance, so it recolours
// the glow without brightening or darkening it -- `translucency` stays the one intensity control.
//
// The G-buffer has no colour channel to spare, so a translucent texel packs its tint into the reflectance
// channel (gNormalRoughness.b) as an 11-bit integer, exact in rgba16float: 5 bits of hue, 3 of saturation,
// 3 of blend. Reflectance is meaningless there -- a translucent surface is a dielectric leaf or blade -- and
// deferredLighting.wgsl reads it back as the default 0.5 for those texels.

const TINT_LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);

/** The light transmitted through a surface of `albedo`, blended toward `tint` (luminance-matched). */
fn transmissionAlbedo(albedo: vec3<f32>, tint: vec3<f32>, blend: f32) -> vec3<f32> {
    if (blend <= 0.0) { return albedo; }
    let tl = max(dot(tint, TINT_LUMA), 1e-4);
    return mix(albedo, tint * (dot(albedo, TINT_LUMA) / tl), saturate(blend));
}

fn tintHsv(c: vec3<f32>) -> vec2<f32> {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let d = mx - mn;
    var h = 0.0;
    if (d > 1e-5) {
        if (mx == c.r) { h = (c.g - c.b) / d; }
        else if (mx == c.g) { h = 2.0 + (c.b - c.r) / d; }
        else { h = 4.0 + (c.r - c.g) / d; }
        h = fract(h / 6.0 + 1.0);
    }
    return vec2<f32>(h, select(0.0, d / mx, mx > 1e-5));
}

fn tintRgb(h: f32, s: f32) -> vec3<f32> {
    let p = abs(fract(vec3<f32>(h) + vec3<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return mix(vec3<f32>(1.0), saturate(p - 1.0), s);
}

/** A tint (rgb, a = blend) as the integer the G-buffer stores in place of reflectance. */
fn packTranslucencyTint(tint: vec4<f32>) -> f32 {
    let hs = tintHsv(saturate(tint.rgb));
    let h = round(hs.x * 32.0) % 32.0;
    let s = round(saturate(hs.y) * 7.0);
    let b = round(saturate(tint.a) * 7.0);
    return h * 64.0 + s * 8.0 + b;
}

/** Back from the G-buffer: rgb = the tint colour, a = its blend. */
fn unpackTranslucencyTint(code: f32) -> vec4<f32> {
    let c = round(max(code, 0.0));
    let h = floor(c / 64.0);
    let s = floor((c - h * 64.0) / 8.0);
    let b = c - h * 64.0 - s * 8.0;
    return vec4<f32>(tintRgb(h / 32.0, s / 7.0), b / 7.0);
}
