// Depth-only pass for one cascade. `u_lightSpace` is that cascade's fitted ortho matrix.
//
// The explicit location matters: _ensureOverlayMeshes builds position-only VAOs from THIS shader's
// reflected attributes and then draws them with basicInstanced, which hardcodes location 0.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

struct ShadowMapUniforms {
    u_model: mat4x4<f32>,
    u_lightSpace: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_shadow: ShadowMapUniforms;

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.position = u_shadow.u_lightSpace * u_shadow.u_model * vec4<f32>(position, 1.0);
    return out;
}

// Depth-only: the pass writes nothing but depth, so the fragment stage has no output at all. It still
// has to exist — a program needs both stages linked.
@fragment
fn fs_main() {
}
