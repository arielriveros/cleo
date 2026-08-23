// Equirectangular (lat/long) unwrap of a probe's captured cubemap, for the editor preview thumbnail.
//
// The screen quad supplies uv in [0,1]; map it to a spherical direction, sample the cube, then tonemap
// the linear HDR capture down to a displayable sRGB image.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/tonemap.wgsl"

const PI: f32 = 3.14159265359;

@group(0) @binding(0) var u_cube_texture: texture_cube<f32>;
@group(0) @binding(1) var u_cube_sampler: sampler;

struct ProbePreviewUniforms {
    u_exposure: f32,
};
@group(1) @binding(0) var<uniform> u_preview: ProbePreviewUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // u -> longitude [-PI, PI], v -> latitude [-PI/2, PI/2] (v=0 bottom, v=1 top).
    let lon = (in.uv.x - 0.5) * 2.0 * PI;
    let lat = (in.uv.y - 0.5) * PI;
    let cosLat = cos(lat);
    let dir = vec3<f32>(cosLat * sin(lon), sin(lat), -cosLat * cos(lon));

    let hdr = textureSample(u_cube_texture, u_cube_sampler, normalize(dir)).rgb;
    return vec4<f32>(tonemap(hdr, u_preview.u_exposure), 1.0);
}
