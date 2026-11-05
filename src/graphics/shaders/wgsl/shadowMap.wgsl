// Depth-only pass for one cascade. `u_lightSpace` is that cascade's fitted ortho matrix; the caster's
// world matrix comes from the per-object table (chunks/objectData.wgsl) through `instance_index`.

#include "./chunks/objectData.wgsl"
//
// The explicit location matters: _ensureOverlayMeshes builds position-only VAOs from THIS shader's
// reflected attributes and then draws them with basicInstanced, which hardcodes location 0.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

struct ShadowMapUniforms {
    u_lightSpace: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_shadow: ShadowMapUniforms;

@vertex
fn vs_main(@location(0) position: vec3<f32>, @builtin(instance_index) objectIndex: u32) -> VertexOutput {
    var out: VertexOutput;
    out.position = u_shadow.u_lightSpace * objectModel(objectIndex) * vec4<f32>(position, 1.0);
    return out;
}

// Depth-only: the pass writes nothing but depth, so the fragment stage has no output at all. It still
// has to exist — a program needs both stages linked.
@fragment
fn fs_main() {
}
