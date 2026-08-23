// Vertex stage for the selection-outline and overdraw passes. The GLSL twin is materials/outline.vs.
//
// It declares position, normal and texCoord only — three of the five model attributes — and the GLSL
// original leaves their locations implicit, so the linker assigns 0/1/2. That happens to match the
// canonical model order (see rhi/vertexLayouts.ts MODEL_ATTRIBUTES), which is why it can draw a mesh
// whose VAO was built for the full five-attribute layout. Spelled out explicitly here so the match is
// a stated contract rather than a coincidence of declaration order.

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

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
) -> VertexOutput {
    var out: VertexOutput;
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model
                 * vec4<f32>(position, 1.0);
    // WGSL has no mat3(mat4) narrowing constructor.
    let rot = mat3x3<f32>(u_transform.u_model[0].xyz, u_transform.u_model[1].xyz, u_transform.u_model[2].xyz);
    out.normal = rot * normal;
    out.uv = texCoord;
    return out;
}
