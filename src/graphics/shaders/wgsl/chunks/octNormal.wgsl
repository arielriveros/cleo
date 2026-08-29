// Octahedral normal encoding, and the channel it buys.
//
// The deferred G-buffer is three RGBA targets and twelve channels — `albedo+metallic`,
// `normal+roughness`, `emissive+AO` — with nothing spare. Four features wanted a thirteenth. A unit
// vector, though, does not need three numbers: it has two degrees of freedom, and the octahedral
// mapping (Cigolle et al., "A Survey of Efficient Representations for Independent Unit Vectors")
// carries it in two with a distortion small enough to be irrelevant at the 16-bit float this target
// already uses. So `gNormalRoughness` becomes `rg = normal, b = reflectance, a = roughness` and the
// channel arrives at ZERO bandwidth cost — no fourth attachment, no extra write per fragment.
//
// It is invisible to authored content. A custom deferred material fills a `Surface { normal, ... }`
// struct and never touches a target; `DEFERRED_EPILOGUE` in systems/customShaders.ts does the encode
// on its behalf, in GLSL, from the same formulas below.
//
// THE ONE THING TO KNOW BEFORE READING A DECODED NORMAL: (0, 0) is a VALID direction — it decodes to
// +Z. The G-buffer clears to zero, so "nothing was written here" and "this surface faces the camera"
// are no longer distinguishable in this target, and any consumer that used `dot(n, n) < eps` as a
// background test has to use DEPTH instead. ssao.wgsl did exactly that and now does not.
//
// Included from chunks/modelVarying.wgsl and chunks/basicVarying.wgsl — the two varying chunks each
// program includes exactly one of — plus by hand in the fullscreen passes that read the G-buffer.
// The include resolver has no include-once guard, so it must never be pulled in twice.

/**
 * Fold the tail of the octahedron: the |x| + |y| > 1 region mirrors across the diagonal, carrying the
 * sign of the component it came from.
 */
fn octWrap(v: vec2<f32>) -> vec2<f32> {
    let signs = select(vec2<f32>(-1.0), vec2<f32>(1.0), v >= vec2<f32>(0.0));
    return (1.0 - abs(vec2<f32>(v.y, v.x))) * signs;
}

/** A unit vector to two numbers in [-1, 1]. */
fn octEncode(n: vec3<f32>) -> vec2<f32> {
    // The L1 norm, floored. A zero vector is not a direction, but it does reach here — an unlit
    // material writing a placeholder, a degenerate tangent frame — and dividing by it would put NaN
    // in the G-buffer, which spreads to every lit pixel that samples it.
    let l1 = max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6);
    let p = vec2<f32>(n.x, n.y) * (1.0 / l1);
    return select(octWrap(p), p, n.z >= 0.0);
}

/** ...and back. Normalised, because the mapping is only exact at the octahedron's own surface. */
fn octDecode(e: vec2<f32>) -> vec3<f32> {
    var n = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
    if (n.z < 0.0) {
        let w = octWrap(vec2<f32>(n.x, n.y));
        n = vec3<f32>(w.x, w.y, n.z);
    }
    return normalize(n);
}

/**
 * Dielectric F0 from an authored 0..1 reflectance, Filament's remapping.
 *
 * `0.16 * r^2` puts the default 0.5 at exactly 0.04 — the fixed constant every dielectric in this
 * engine used to get — and spans 0 to 0.16, which covers water (0.02) at the bottom and gemstones
 * (0.08) comfortably in the middle. Squared rather than linear so the authorable range spends its
 * resolution where real materials actually sit.
 */
fn dielectricF0(reflectance: f32) -> f32 {
    return 0.16 * reflectance * reflectance;
}
