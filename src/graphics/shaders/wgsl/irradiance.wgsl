// Diffuse IBL: convolves the source environment cubemap into an irradiance map.
//
// Integrates cosine-weighted radiance over the hemisphere around each direction. Rendered per cube
// face, so the fragment's interpolated local position IS the direction being integrated.

#include "./chunks/cubeVertex.wgsl"

const PI: f32 = 3.14159265359;
const SAMPLE_DELTA: f32 = 0.025;

@group(0) @binding(0) var u_envMap_texture: texture_cube<f32>;
@group(0) @binding(1) var u_envMap_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let n = normalize(in.localPos);

    // A tangent frame around N. `up` switches axis near the pole so the cross product cannot
    // degenerate — with N almost parallel to +Y, crossing against +Y gives a zero-length right vector
    // and the whole hemisphere collapses to a line.
    var up = vec3<f32>(1.0, 0.0, 0.0);
    if (abs(n.y) < 0.999) { up = vec3<f32>(0.0, 1.0, 0.0); }
    let right = normalize(cross(up, n));
    up = normalize(cross(n, right));

    var irradiance = vec3<f32>(0.0);
    var samples = 0.0;

    var phi = 0.0;
    while (phi < 2.0 * PI) {
        var theta = 0.0;
        while (theta < 0.5 * PI) {
            // Tangent-space sample -> world.
            let tangentSample = vec3<f32>(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));
            let sampleVec = tangentSample.x * right + tangentSample.y * up + tangentSample.z * n;
            // cos(theta) is the Lambert term, sin(theta) the solid-angle weight of this ring.
            irradiance += textureSample(u_envMap_texture, u_envMap_sampler, sampleVec).rgb
                          * cos(theta) * sin(theta);
            samples += 1.0;
            theta += SAMPLE_DELTA;
        }
        phi += SAMPLE_DELTA;
    }

    return vec4<f32>(PI * irradiance * (1.0 / samples), 1.0);
}
