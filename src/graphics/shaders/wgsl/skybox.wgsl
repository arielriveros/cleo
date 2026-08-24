// Skybox: a cube drawn at the far plane, sampled by direction.

#include "./chunks/tonemap.wgsl"

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) dir: vec3<f32>,
};

struct SkyboxTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: SkyboxTransform;

@group(0) @binding(0) var u_skybox_texture: texture_cube<f32>;
@group(0) @binding(1) var u_skybox_sampler: sampler;

struct SkyboxUniforms {
    // The scene buffer is linear HDR. A user-supplied cubemap is sRGB-authored and must be decoded to
    // linear; the baked SkyAtmosphere cubemap is already linear HDR and must pass through untouched.
    // i32 rather than bool: WGSL forbids bool in a uniform buffer.
    u_linearInput: i32,
};
@group(1) @binding(1) var<uniform> u_sky: SkyboxUniforms;

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.dir = position;

    // Strip the translation so the cube stays centred on the camera.
    var view = u_transform.u_view;
    view[3][0] = 0.0;
    view[3][1] = 0.0;
    view[3][2] = 0.0;

    let pos = u_transform.u_projection * view * vec4<f32>(position, 1.0);
    // z = w pins the fragment to the far plane, so the sky loses every depth test against real geometry.
    out.position = vec4<f32>(pos.x, pos.y, pos.w, pos.w);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    var c = textureSample(u_skybox_texture, u_skybox_sampler, in.dir).rgb;
    if (u_sky.u_linearInput == 0) { c = toLinear(c); }   // sRGB user cubemap -> linear

    // Bloom mask (alpha): the baked SkyAtmosphere (u_linearInput) feeds bloom so its sun/sky glow
    // blooms; a plain user cubemap is treated as flat background and stays out of the bloom pass.
    var mask = 0.0;
    if (u_sky.u_linearInput != 0) { mask = 1.0; }
    return vec4<f32>(c, mask);
}
