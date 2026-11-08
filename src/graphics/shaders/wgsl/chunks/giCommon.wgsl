// What every GI Volumes pass shares (render/gi/): the hit cache encoding, the octahedral tile maps, the
// sky's radiance. Pure functions, no bindings.
//
// Include AFTER chunks/octNormal.wgsl (octEncode / octDecode / octWrap): the include resolver has no
// include-once guard, so this chunk cannot pull it in itself.
//
// THE HIT CACHE: three RGBA8 textures, one octahedral tile of rays per probe (giLayout.ts).
//   A  rgb = sqrt(albedo * (1 - metallic))      a = 1 front hit, 0.5 back face, 0 miss
//   B  rg  = oct normal * 0.5 + 0.5            ba = distance / maxRayDistance, 16 bits (hi, lo bytes)
//   C  rgb = emissive / 2^e                     a = (e + 128) / 255, absolute (RGBE)
// RGBA8 because WebGL2 reads back RGBA8 only, and these bytes ARE the saved bake.

const GI_HIT_FRONT: f32 = 1.0;
const GI_HIT_BACK: f32 = 0.5;
const GI_PI: f32 = 3.14159265359;

/** A [0, 1] value into two bytes, as two [0, 1] channels. Float math only: no integer bit ops in ES 3.00 paths. */
fn giEncode16(v: f32) -> vec2<f32> {
    let q = round(clamp(v, 0.0, 1.0) * 65535.0);
    let hi = floor(q / 256.0);
    return vec2<f32>(hi, q - hi * 256.0) / 255.0;
}

fn giDecode16(c: vec2<f32>) -> f32 {
    let b = round(c * 255.0);
    return (b.x * 256.0 + b.y) / 65535.0;
}

/** Linear HDR into RGBE bytes: the smallest exponent that keeps the peak at or under 1 (shProject.ts encodeRGBE). */
fn giEncodeRGBE(c: vec3<f32>) -> vec4<f32> {
    let peak = max(c.r, max(c.g, c.b));
    if (!(peak > 1e-30)) { return vec4<f32>(0.0); }
    let e = ceil(log2(peak));
    return vec4<f32>(saturate(c * exp2(-e)), clamp(e + 128.0, 1.0, 255.0) / 255.0);
}

fn giDecodeRGBE(c: vec4<f32>) -> vec3<f32> {
    let a = round(c.a * 255.0);
    if (a < 0.5) { return vec3<f32>(0.0); }
    return c.rgb * exp2(a - 128.0);
}

/** What a ray met, from hit A's alpha: 2 front, 1 back face, 0 miss. */
fn giHitKind(a: f32) -> i32 {
    if (a >= 0.75) { return 2; }
    if (a >= 0.25) { return 1; }
    return 0;
}

/** The fold just outside [-1, 1]^2: past an edge the map continues mirrored, past a corner at the opposite one. */
fn giOctWrapOutside(p: vec2<f32>) -> vec2<f32> {
    var x = p.x;
    var y = p.y;
    if (x > 1.0) { x = 2.0 - x; y = -y; } else if (x < -1.0) { x = -2.0 - x; y = -y; }
    if (y > 1.0) { y = 2.0 - y; x = -x; } else if (y < -1.0) { y = -2.0 - y; x = -x; }
    return vec2<f32>(x, y);
}

/**
 * The direction at tile texel `t` (0..n+1, border included) of an octahedral tile with an `n`-texel
 * interior: the interior texel centres, and the wrapped neighbours on the border.
 */
fn giTileDirection(t: vec2<f32>, n: f32) -> vec3<f32> {
    let p = ((t - vec2<f32>(1.0) + vec2<f32>(0.5)) / n) * 2.0 - 1.0;
    return octDecode(giOctWrapOutside(p));
}

/** The direction of ray texel `t` (0..side-1) of a probe's hit tile (no border). */
fn giRayDirection(t: vec2<f32>, side: f32) -> vec3<f32> {
    return octDecode(((t + vec2<f32>(0.5)) / side) * 2.0 - 1.0);
}

/**
 * Radiance-form L2 SH (SkyLight.sh, shProject.ts) evaluated as RADIANCE in direction `d` — not convolved:
 * the sky a probe ray that hits nothing sees. Clamped at zero, as a strongly directional sky rings negative.
 */
fn giShRadiance(sh: array<vec4<f32>, 9>, d: vec3<f32>) -> vec3<f32> {
    let x = d.x; let y = d.y; let z = d.z;
    let r = sh[0].rgb * 0.282095
          + sh[1].rgb * (0.488603 * y) + sh[2].rgb * (0.488603 * z) + sh[3].rgb * (0.488603 * x)
          + sh[4].rgb * (1.092548 * x * y) + sh[5].rgb * (1.092548 * y * z)
          + sh[6].rgb * (0.315392 * (3.0 * z * z - 1.0))
          + sh[7].rgb * (1.092548 * x * z) + sh[8].rgb * (0.546274 * (x * x - y * y));
    return max(r, vec3<f32>(0.0));
}
