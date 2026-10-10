// The emitter LUT read, for the programs that bind one (the simulation and the renderers; not the sort).

// One LUT row at normalized `t`: two texels and a lerp, exactly as `sampleLut` in curves.ts does it.
// Every module including this chunk declares `u_lut_texture` itself (WGSL resolves module scope out of
// order), so the binding number stays with the program that owns the bind group.
fn particleLut(row: i32, t: f32) -> vec4<f32> {
    let x = clamp(t, 0.0, 1.0) * f32(PARTICLE_LUT_WIDTH - 1);
    let i0 = i32(floor(x));
    let i1 = min(i0 + 1, PARTICLE_LUT_WIDTH - 1);
    let a = textureLoad(u_lut_texture, vec2<i32>(i0, row), 0);
    let b = textureLoad(u_lut_texture, vec2<i32>(i1, row), 0);
    return mix(a, b, x - f32(i0));
}
