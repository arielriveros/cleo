// Depth-only vertex stage for instanced foliage, shared by the plain and alpha-cutout variants.
//
// The per-instance world matrix arrives as a vertex attribute at locations 5-8 and replaces `u_model`
// entirely — the matrices Foliage bakes are already in world space. Neither WGSL nor GLSL has a mat4
// vertex format, so it is four consecutive vec4 inputs that are reassembled here.
//
// All five per-vertex attributes are declared even though only position and uv are read, and that is
// load-bearing rather than tidy: `Mesh.initializeVAO` packs its interleaved offsets over ONLY the
// attributes a program declares and derives the stride from that subset, so a depth program declaring
// a narrower set would re-stride any mesh initialized from it and corrupt the colour pass. This
// matches geometry_instanced.vs exactly so both passes agree on one VAO layout.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct InstancedDepthUniforms {
    u_lightSpace: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_depth: InstancedDepthUniforms;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
    @location(5) instanceModel0: vec4<f32>,
    @location(6) instanceModel1: vec4<f32>,
    @location(7) instanceModel2: vec4<f32>,
    @location(8) instanceModel3: vec4<f32>,
) -> VertexOutput {
    let instanceModel = mat4x4<f32>(instanceModel0, instanceModel1, instanceModel2, instanceModel3);
    var out: VertexOutput;
    out.uv = texCoord;
    out.position = u_depth.u_lightSpace * instanceModel * vec4<f32>(position, 1.0);
    return out;
}
