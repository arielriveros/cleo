// The cube vertex stage, shared by every pass that renders a unit cube from its centre: the IBL
// convolutions and the sky-atmosphere bake.
//
// The interpolated LOCAL position is the whole point — each fragment's local position is its sample
// direction, which is what turns one cube draw into a per-face directional integration.
//
// The GLSL twin was environment/cube.vs. Vertex inputs are declared WITHOUT the engine's `a_` prefix;
// the loader adds it. See tools/wgslTranslate.mjs for why that separation is load-bearing.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) localPos: vec3<f32>,
};

struct CubeTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_cube: CubeTransform;

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.localPos = position;
    out.position = u_cube.u_projection * u_cube.u_view * vec4<f32>(position, 1.0);
    return out;
}
