// Selection MASK: fill the selected silhouette with a flat colour (white while building the mask).
// The screen-space pass in outlinePost.wgsl turns that silhouette into a border.
//
// POSITION ONLY, and that is a requirement rather than an economy. The fragment stage returns a flat
// colour, and every attribute a vertex stage declares is one the pipeline's vertex layout must supply.
// This pass draws whatever the user selected, and `ModelNode.initializeModel` packs each mesh to its
// own material program's attributes — a Basic model carries position and uv and no normal at all.
// WebGPU refuses such a pipeline outright; WebGL2 quietly substitutes a generic (0,0,0,1), which is
// why asking for three worked there for as long as it did.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
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
// POSITION ONLY. The fragment stage below returns a flat colour, and every attribute declared here
// is one the vertex layout must supply — a Basic model's buffer has no normal at all, and WebGPU
// refuses a pipeline whose vertex stage asks for one that is not there. See chunks/outlineVertex.wgsl.
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model
                   * vec4<f32>(position, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(u_outline.u_outlineColor, 1.0);
}
