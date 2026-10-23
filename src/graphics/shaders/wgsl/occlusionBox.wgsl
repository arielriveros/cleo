// GPU occlusion queries: one node's bounding box, rasterized against the scene depth the geometry pass
// just wrote — no colour, no depth write — inside an occlusion query (graphics/gpuOcclusion.ts). A sample
// that passes the depth test means part of the box is in front of what is already drawn, so the node may
// be visible; none means everything it could draw is hidden, and the next frames skip it.
//
// Rasterized with the JITTERED projection, like the depth it is tested against: unjittered, the box and
// the depth would disagree by a TAA offset at every silhouette.

struct OcclusionBoxTransform {
    // The unit cube (Geometry.Cube) onto the node's box, world space.
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> u_box: OcclusionBoxTransform;

// A STRUCT return, not a bare `@builtin(position) vec4<f32>`: the GLSL translator names the vertex inputs
// from a `-> StructName` signature, and without one the attribute kept naga's `_p2vs_location0` — which
// no vertex layout matches, so every box drew nothing and every query came back "hidden".
struct BoxVarying {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> BoxVarying {
    var out: BoxVarying;
    out.position = u_box.u_projection * u_box.u_view * u_box.u_model * vec4<f32>(position, 1.0);
    return out;
}

// No outputs: the pass has no colour target, and the query counts samples, not colours.
@fragment
fn fs_main() {}
