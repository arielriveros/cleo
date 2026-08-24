// Selection MASK: fill the selected silhouette with a flat colour (white while building the mask).
// The screen-space pass in outlinePost.wgsl turns that silhouette into a border.
//
// Three vertex attributes, matching the GLSL twin exactly. That is deliberate rather than incidental:
// `Mesh.initializeVAO` derives its stride from the attributes a program declares, so widening this to
// the full model vertex would change the layout of any mesh initialized from it.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) uv: vec2<f32>,
};

struct OutlineTransform {
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: OutlineTransform;

struct OutlineUniforms {
    u_outlineColor: vec3<f32>,
};
@group(1) @binding(1) var<uniform> u_outline: OutlineUniforms;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
) -> VertexOutput {
    var out: VertexOutput;
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model
                   * vec4<f32>(position, 1.0);
    // WGSL has no mat3(mat4) narrowing; take the upper-left 3x3 by columns.
    let m = u_transform.u_model;
    let normalMatrix = mat3x3<f32>(m[0].xyz, m[1].xyz, m[2].xyz);
    out.normal = normalMatrix * normal;
    out.uv = texCoord;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(u_outline.u_outlineColor, 1.0);
}
