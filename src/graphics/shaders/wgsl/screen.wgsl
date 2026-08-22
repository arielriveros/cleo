// Fullscreen blit: sample one texture over a screen-filling quad.
//
// The simplest program in the engine, and deliberately the first one moved to WGSL: one sampler, no
// scalar uniforms, so naga emits no uniform block and the pilot proves the loader -> naga -> Shader
// path without needing the uniform-buffer work first.
//
// Both stages live in one module because naga generates varying names from a module's location
// numbers; two separately translated modules would not agree on them.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
) -> VertexOutput {
    var out: VertexOutput;
    out.uv = texCoord;
    out.position = vec4<f32>(position, 1.0);
    return out;
}

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv);
}
