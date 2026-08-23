// One z-slice of a TILEABLE 3D noise volume, baked once at startup and thereafter sampled by
// volumetricClouds instead of being recomputed per raymarch step.
//
// WHY BAKE: the cloud raymarch evaluated a 4-octave FBM (32 hash+lerp taps) for every primary sample
// and a 3-octave FBM again for detail erosion, plus the same 4-octave field for every secondary
// sun-march sample. At 40 primary x 5 light steps that is thousands of hash evaluations per pixel to
// reproduce a field that never changes. Two trilinear texture fetches give the same answer.
//
// WHY TILEABLE, and what it costs: a texture can only stand in for an infinite procedural field if the
// field repeats at the texture's period. So the value noise below hashes lattice cells modulo a
// per-octave period rather than hashing raw coordinates. The visible consequence is that the cloud
// field now repeats — see BASE_PERIOD in the renderer for the world distance that works out to.
//
// The renderer draws this once per slice; `u_slice` is the slice's centre in [0,1] along z. On WebGL2
// that is `framebufferTextureLayer` per slice; on WebGPU a render pass cannot target a 3D texture
// slice at all, so this becomes a compute shader — see WEBGPU_ROADMAP.md M7.6.

#include "./chunks/fullscreen.wgsl"

struct CloudNoiseUniforms {
    u_slice: f32,      // z coordinate of this layer, at texel centre
    u_period: f32,     // lattice cells across the volume at octave 0 (the tiling period)
    u_octaves: i32,    // octaves in the R channel FBM
    u_detail: i32,     // non-zero when baking the small high-frequency detail volume
};
@group(1) @binding(0) var<uniform> u_noise: CloudNoiseUniforms;

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

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Position in lattice space: [0,1] across the volume, scaled to `u_period` cells.
    let p = vec3<f32>(in.uv, u_noise.u_slice) * u_noise.u_period;

    if (u_noise.u_detail != 0) {
        // Detail volume: three progressively finer erosion bands. Only RGB is used.
        return vec4<f32>(
            fbmTiled(p, u_noise.u_period, 3),
            fbmTiled(p * 2.0, u_noise.u_period * 2.0, 3),
            fbmTiled(p * 4.0, u_noise.u_period * 4.0, 2),
            1.0);
    }

    // Base volume:
    //   R = the low-frequency shape field  (stands in for the old 4-octave fbm)
    //   G = a medium band                  (stands in for the old 3-octave fbm3)
    //   B = a finer band                   (extra erosion / variety)
    //   A = a single octave                (stands in for the hash33 curl warp source)
    return vec4<f32>(
        fbmTiled(p, u_noise.u_period, u_noise.u_octaves),
        fbmTiled(p * 2.0, u_noise.u_period * 2.0, 3),
        fbmTiled(p * 4.0, u_noise.u_period * 4.0, 3),
        valueNoiseTiled(p * 2.0, u_noise.u_period * 2.0));
}
