// Deferred geometry pass for instanced BILLBOARD foliage (grass).
//
// Alpha-tests the layer texture and writes an up-facing, matte surface into the PBR G-buffer. Shares
// the instanced vertex stage with the lit instanced materials, so both agree on the vertex layout.

#include "./chunks/instancedVertex.wgsl"
#include "./chunks/tonemap.wgsl"

@group(0) @binding(0) var u_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_texture_sampler: sampler;

struct GBuffer {
    @location(0) albedoMetallic: vec4<f32>,
    @location(1) normalRoughness: vec4<f32>,
    @location(2) emissiveAO: vec4<f32>,
};

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    let c = textureSample(u_texture_texture, u_texture_sampler, in.uv);
    // Alpha cutout, so blades read as cutouts rather than as the quads they are drawn on.
    if (c.a < 0.5) { discard; }

    var out: GBuffer;
    out.albedoMetallic = vec4<f32>(toLinear(c.rgb), 0.0);   // sRGB -> linear
    // A fixed UP normal rather than the quad's: grass then lights evenly from above instead of
    // flickering dark as the camera orbits the billboards.
    out.normalRoughness = vec4<f32>(0.0, 1.0, 0.0, 0.9);
    out.emissiveAO = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return out;
}
