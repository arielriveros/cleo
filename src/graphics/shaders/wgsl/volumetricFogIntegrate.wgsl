// Volumetric fog, pass 2: integrate each froxel column front to back. One fragment per froxel marches from
// the camera to the far edge of its own slice (so no pass reads what it writes), with the energy-conserving
// step of Hillaire 2015: a slice of extinction sigma and in-scatter S, `d` metres long along the ray, adds
// `T * S * (1 - e^{-sigma d}) / sigma` and dims what is behind it by `e^{-sigma d}`. See
// chunks/volumetricFogCommon.wgsl.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/volumetricFogCommon.wgsl"

@group(0) @binding(0) var u_inject_texture: texture_2d<f32>;
@group(0) @binding(1) var u_inject_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let fx = fogFroxelOf(in.position.xy);
    let uv = (vec2<f32>(fx.xy) + 0.5) / u_fogv.u_grid.xy;
    // View depth runs along the camera axis; the ray through this tile is longer by 1 / cos.
    let rayScale = 1.0 / max(dot(fogRayDir(uv), u_fogv.u_camForward), 1e-3);
    var scattered = vec3<f32>(0.0);
    var transmittance = 1.0;
    var front = u_fogv.u_near;
    let n = i32(u_fogv.u_grid.z);
    for (var s = 0; s < 128; s++) {
        if (s > fx.z || s >= n) { break; }
        let back = fogSliceDepth(f32(s + 1));
        let len = (back - front) * rayScale;
        let froxel = textureLoad(u_inject_texture, fogAtlasTexel(fx.x, fx.y, s), 0);
        let sigma = max(froxel.a, 0.0);
        let stepT = exp(-sigma * len);
        // As sigma -> 0 the step tends to S * len: the limit, not a division by zero.
        var integral = froxel.rgb * len;
        if (sigma > 1e-5) { integral = froxel.rgb * (1.0 - stepT) / sigma; }
        scattered += transmittance * integral;
        transmittance *= stepT;
        front = back;
    }
    return vec4<f32>(min(scattered, vec3<f32>(32768.0)), transmittance);
}
