// The tileable cloud-noise FIELD, with no opinion about how it is written out.
//
// Extracted from `cloudNoiseBake.wgsl` when the bake gained a second implementation: WebGPU cannot
// render into a 3D texture's z-slice at all (a render attachment must be a 2D or 2D-array view), so
// the volume is filled there by a compute shader writing a storage texture instead. Two entry points,
// one field — and the field is what has to stay bit-identical, because the WebGL2 path's baked volume
// is compared against a recorded pixel signature.
//
// Nothing in here binds anything. The uniform struct that supplies `period`/`octaves`/`detail` stays
// with each entry point, since the raster module needs a `u_slice` the compute module has no use for.

/**
 * Hash of an INTEGER lattice cell.
 *
 * Taking a vec3 of whole numbers — already wrapped to the period by the caller — rather than a
 * continuous position is what makes the field exactly periodic.
 */
fn hashCell(cell: vec3<f32>) -> f32 {
    var c = fract(cell * 0.1031);
    c += vec3<f32>(dot(c, c.zyx + 31.32));
    return fract((c.x + c.y) * c.z);
}

/**
 * Value noise with an explicit lattice period: cells wrap at `period`, so the field tiles seamlessly
 * when the texture is sampled with REPEAT wrapping.
 */
fn valueNoiseTiled(x: vec3<f32>, period: f32) -> f32 {
    let i = floor(x);
    var f = fract(x);
    f = f * f * (3.0 - 2.0 * f);   // smoothstep interpolant, matching the procedural noise it replaced

    // The modulo on the cell index (and on index+1) is the entire trick: the cell one past the end of
    // the period IS the cell at the start, so opposite faces of the volume interpolate into each other.
    let i0 = i % vec3<f32>(period);
    let i1 = (i + 1.0) % vec3<f32>(period);

    let n000 = hashCell(vec3<f32>(i0.x, i0.y, i0.z));
    let n100 = hashCell(vec3<f32>(i1.x, i0.y, i0.z));
    let n010 = hashCell(vec3<f32>(i0.x, i1.y, i0.z));
    let n110 = hashCell(vec3<f32>(i1.x, i1.y, i0.z));
    let n001 = hashCell(vec3<f32>(i0.x, i0.y, i1.z));
    let n101 = hashCell(vec3<f32>(i1.x, i0.y, i1.z));
    let n011 = hashCell(vec3<f32>(i0.x, i1.y, i1.z));
    let n111 = hashCell(vec3<f32>(i1.x, i1.y, i1.z));

    let nx00 = mix(n000, n100, f.x);
    let nx10 = mix(n010, n110, f.x);
    let nx01 = mix(n001, n101, f.x);
    let nx11 = mix(n011, n111, f.x);
    let nxy0 = mix(nx00, nx10, f.y);
    let nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
}

/**
 * Tileable FBM.
 *
 * Frequency doubles per octave and so does the period, which keeps every octave periodic over the SAME
 * volume — the reason the octave scale here is exactly 2.0 rather than the 2.02/2.03 the procedural
 * version used to break up lattice alignment.
 */
fn fbmTiled(p: vec3<f32>, period: f32, octaves: i32) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var norm = 0.0;
    var per = period;
    for (var i = 0; i < 6; i++) {
        if (i >= octaves) { break; }
        sum += amp * valueNoiseTiled(p * (per / period), per);
        norm += amp;
        per *= 2.0;
        amp *= 0.5;
    }
    return sum / max(norm, 1e-5);
}

/**
 * One texel of a noise volume, at lattice position `p` (i.e. [0,1] across the volume times `period`).
 *
 * The two branches are the two volumes the renderer bakes, and both are reproduced here EXACTLY as
 * they were written inline in the raster shader — including the detail branch's hardcoded 3/3/2 and
 * the fact that it ignores `octaves` entirely. That looks like a bug and is not one to fix here: the
 * WebGL2 output of this function is pinned by a recorded pixel signature, so "correcting" it would
 * move a baseline for no visual gain. The renderer already passes 3 for the detail volume, which is
 * what the first two bands hardcode anyway.
 */
fn cloudNoiseTexel(p: vec3<f32>, period: f32, octaves: i32, detail: i32) -> vec4<f32> {
    if (detail != 0) {
        // Detail volume: three progressively finer erosion bands. Only RGB is used.
        return vec4<f32>(
            fbmTiled(p, period, 3),
            fbmTiled(p * 2.0, period * 2.0, 3),
            fbmTiled(p * 4.0, period * 4.0, 2),
            1.0);
    }

    // Base volume:
    //   R = the low-frequency shape field  (stands in for the old 4-octave fbm)
    //   G = a medium band                  (stands in for the old 3-octave fbm3)
    //   B = a finer band                   (extra erosion / variety)
    //   A = a single octave                (stands in for the hash33 curl warp source)
    return vec4<f32>(
        fbmTiled(p, period, octaves),
        fbmTiled(p * 2.0, period * 2.0, 3),
        fbmTiled(p * 4.0, period * 4.0, 3),
        valueNoiseTiled(p * 2.0, period * 2.0));
}
