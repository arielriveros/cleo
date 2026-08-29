// The varying contract for the unlit ("basic") material family.
//
// Deliberately not chunks/modelVarying.wgsl: the basic vertex shaders carry NO tangent basis and put
// `a_texCoord` at location 1, where the lit model vertex has `a_normal`. Sharing the lit contract would
// silently re-interpret the second attribute.
//
// Included by each basic VERTEX chunk and by no fragment chunk — a program includes exactly one vertex
// chunk, so this lands once. The include resolver has no include-once guard.

#include "./octNormal.wgsl"

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};
