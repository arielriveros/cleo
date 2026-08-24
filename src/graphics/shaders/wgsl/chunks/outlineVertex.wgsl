// Vertex stage for the selection-outline and overdraw passes. The GLSL twin is materials/outline.vs.
//
// It declares POSITION ONLY, and that is a requirement rather than an economy. Neither fragment stage
// reads a normal or a uv — both return a flat colour — and every attribute a vertex stage declares is
// one the pipeline's vertex layout must supply. WebGPU enforces that ("Vertex attribute slot 1 used in
// [EntryPoint \"vs_main\"] is not present in the VertexState") and refuses the pipeline outright;
// WebGL2 quietly hands the shader a generic (0,0,0,1) instead, which is why declaring three worked
// there for as long as it did.
//
// The mesh being drawn decides what is available: `ModelNode.initializeModel` packs the vertex to
// exactly the attributes its MATERIAL's program declares, so a Basic model carries position and uv and
// nothing else. A pass that draws every model in the scene therefore cannot ask for a normal.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

struct OutlineTransform {
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: OutlineTransform;

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model
                 * vec4<f32>(position, 1.0);
    return out;
}
