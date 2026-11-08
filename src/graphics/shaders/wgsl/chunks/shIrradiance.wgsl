// Irradiance from nine L2 spherical-harmonic coefficients: a light probe's lighting (shProject.ts writes
// them, render/probeLighting.ts packs them), evaluated per pixel by the deferred pass and per draw by the
// forward programs. The same quadratic form as `skyIrradiance` in chunks/pbrLighting.wgsl, apart from it
// ON PURPOSE: that chunk is compiled into the custom-material prelude, whose text is hashed to validate a
// material's stored WGSL (customWgslHash), so a function added there would invalidate every saved custom
// material's translation.

/**
 * The irradiance E arriving at a surface facing `n` from nine radiance-form coefficients, clamped at zero;
 * the caller divides by PI, as `skyIrradiance` explains. Ramamoorthi & Hanrahan 2001.
 *
 * A room lit through one door drives the reconstruction negative in the unlit hemisphere. Clamping is not
 * cosmetic: a negative irradiance subtracts from the direct term and punches black holes in whatever faces
 * away from the light.
 */
fn shEval(sh: array<vec4<f32>, 9>, n: vec3<f32>) -> vec3<f32> {
    let c1 = 0.429043; let c2 = 0.511664; let c3 = 0.743125;
    let c4 = 0.886227; let c5 = 0.247708;
    let x = n.x; let y = n.y; let z = n.z;

    let L00  = sh[0].rgb;
    let L1m1 = sh[1].rgb; let L10 = sh[2].rgb; let L11 = sh[3].rgb;
    let L2m2 = sh[4].rgb; let L2m1 = sh[5].rgb; let L20 = sh[6].rgb;
    let L21  = sh[7].rgb; let L22 = sh[8].rgb;

    let e = c4 * L00
          + 2.0 * c2 * (L11 * x + L1m1 * y + L10 * z)
          + c3 * L20 * (z * z) - c5 * L20
          + c1 * L22 * (x * x - y * y)
          + 2.0 * c1 * (L2m2 * (x * y) + L21 * (x * z) + L2m1 * (y * z));
    return max(e, vec3<f32>(0.0));
}
