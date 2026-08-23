// Unlit forward shading. The GLSL twin is materials/basic.fs.
//
// Uses VertexOutput from whichever basic vertex chunk the program included.

@group(0) @binding(0) var u_material_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_texture_sampler: sampler;

struct BasicMaterial {
    color: vec3<f32>,
    opacity: f32,
    // i32 rather than bool: WGSL forbids bool in a uniform buffer. Call sites still pass a boolean.
    hasTexture: i32,
};
@group(2) @binding(0) var<uniform> u_material: BasicMaterial;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Decode the sRGB-authored colour/texture to linear; this shader writes into the linear-HDR scene
    // buffer and is tonemapped once at the final present like every other surface.
    var color = toLinear(u_material.color);
    var alpha = u_material.opacity;

    if (u_material.hasTexture != 0) {
        let texColor = textureSample(u_material_texture_texture, u_material_texture_sampler, in.uv);
        color *= toLinear(texColor.rgb);
        alpha *= texColor.a;
    }

    return vec4<f32>(color, alpha);
}
