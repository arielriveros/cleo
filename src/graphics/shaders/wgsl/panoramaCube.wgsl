// A 2:1 equirectangular (lat/long) panorama, wrapped onto a cubemap: what a custom material's
// `samplerCube` uniform samples (render/panoramaCubes.ts). Rendered per cube face, so the fragment's
// interpolated local position IS the direction whose texel this is.
//
// The mapping is probePreview.wgsl's, inverted. That one unwraps a cube with
//   dir = (cos(lat) sin(lon), sin(lat), -cos(lat) cos(lon)),  lon = (u - 0.5) 2 PI,  lat = (v - 0.5) PI
// so the panorama's centre column faces -Z, its left and right edges meet behind, at +Z, and its top
// row is straight up.
//
// The value is copied as sampled, not decoded or tonemapped: a cubemap uniform reads what the same
// image would read through a `sampler2D`.

#include "./chunks/cubeVertex.wgsl"

const PI: f32 = 3.14159265359;

@group(0) @binding(0) var u_panorama_texture: texture_2d<f32>;
@group(0) @binding(1) var u_panorama_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let d = normalize(in.localPos);
    let lon = atan2(d.x, -d.z);
    let lat = asin(clamp(d.y, -1.0, 1.0));
    let uv = vec2<f32>(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
    // Level 0 explicitly. The derivatives a cube face gives mean nothing (see irradiance.wgsl), and at
    // the seam, where u jumps from 1 back to 0 between neighbouring fragments, they would pick the
    // panorama's smallest mip and draw a line of its average colour down the back of the cube.
    return textureSampleLevel(u_panorama_texture, u_panorama_sampler, uv, 0.0);
}
