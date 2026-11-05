// The standard model vertex stage, for a mesh drawn with a per-object model matrix.
//
// In the GLSL tree this is materials/pbr.vs, paired by the linker with several different fragment
// shaders. WGSL cannot work that way — naga generates varying names from a module's location numbers,
// so both stages must live in one module — which is why the sharing moves from "one file linked many
// times" to "one chunk included many times". See tools/shaderIncludes.mjs.
//
// Vertex inputs are declared WITHOUT the engine's `a_` prefix; the loader adds it. See
// tools/wgslTranslate.mjs for why that separation is load-bearing rather than stylistic.
//
// While the GLSL twin still exists it must stay in step: it feeds the same varyings to fragment
// shaders that have not been converted yet.

#include "./modelVarying.wgsl"
#include "./objectData.wgsl"

// GROUP 1 IS EVERY UNIFORM BLOCK, one role per binding:
//
//   @binding(0)  transform      (this struct)
//   @binding(1)  material       (per-material constants)
//   @binding(2)  shadow         (chunks/shadows.wgsl)
//   @binding(3)  lighting       (the forward light list)
//
// Textures keep their own groups and are NOT numbered by this table: 0 material/G-buffer maps (and the
// forward probe cube), 2 the per-object table (chunks/objectData.wgsl), 3 shadow maps and the light grid.
// Those are built by hand in the renderer against a literal group index, so moving them would mean
// moving call sites; the uniform blocks are bound from reflection and move for free.
//
// The roles used to have a group EACH - 0 textures, 1 transform, 2 material, 3 shadows, 4 shadow
// uniforms, 5 lighting - which is how a lit program came to declare group 5. `maxBindGroups` defaults
// to 4 and adapters commonly report 4 as their MAXIMUM, so it cannot be requested up. Dawn then rejects
// the pipeline outright ("uses a binding with a group decoration (5) that exceeds the maximum (4)"),
// and an invalid pipeline is not an error at draw time - the draws recorded against it simply do
// nothing while the pass still performs its clear. That is a frame that counts the right number of
// draw calls and renders nothing at all.
//
// A binding is per-role rather than packed densely so that a shader using only some roles still agrees
// with every other shader about what @binding(2) means.

// Only what is the same for every draw of a pass: the per-OBJECT values (world matrix, dissolve, the
// camera-hole opt-in) come from the per-object table through `instance_index`, so a run of draws leaves
// this block untouched instead of re-uploading it at each one. The members carrying per-frame halves
// of old per-draw values have NEW names (u_camHolePass, u_ditherPhase): programs not reading the table
// still declare u_model/u_dissolve/u_camHolePivot with their per-draw meaning, and one set of writes
// serves both kinds.
struct ModelTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    // Camera see-through hole (chunks/cameraHole.wgsl): camera xyz + 1/radius (per frame), and the pivot
    // xyz + this PASS's strength (0 where no hole is shown). A record opts in through objectParams().y.
    u_camHole: vec4<f32>,
    u_camHolePass: vec4<f32>,
    // The despawn dither phase (per frame); how far gone is per object, objectParams().x. See Node.remove.
    u_ditherPhase: f32,
};
@group(1) @binding(0) var<uniform> u_transform: ModelTransform;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
    @builtin(instance_index) objectIndex: u32,
) -> VertexOutput {
    let model = objectModel(objectIndex);
    let params = objectParams(objectIndex);
    var out: VertexOutput;
    fillVarying(&out, model, position, texCoord, normal, tangent, bitangent);
    out.lodFade = dissolveLodFade(vec2<f32>(params.x, u_transform.u_ditherPhase));
    cameraHoleVarying(&out, u_transform.u_camHole,
                      vec4<f32>(u_transform.u_camHolePass.xyz, u_transform.u_camHolePass.w * params.y),
                      u_transform.u_ditherPhase);
    out.position = u_transform.u_projection * u_transform.u_view * model
                 * vec4<f32>(position, 1.0);
    return out;
}
