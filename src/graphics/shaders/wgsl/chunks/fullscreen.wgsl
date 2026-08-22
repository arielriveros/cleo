// The fullscreen-quad vertex stage, shared by every screen-space pass.
//
// In the GLSL tree this was one file (screen/screen.vs) paired with 27 different fragment shaders. WGSL
// cannot work that way: naga generates varying names from a module's location numbers, so both stages
// have to live in one module or they will not agree on them. The sharing therefore moves from "one file
// linked many times" to "one chunk included many times", which is what tools/shaderIncludes.mjs is for.
//
// Vertex inputs are declared WITHOUT the engine's `a_` prefix — the loader adds it. See
// tools/wgslTranslate.mjs for why that separation is load-bearing rather than stylistic.

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
