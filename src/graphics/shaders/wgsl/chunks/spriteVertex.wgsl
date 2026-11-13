// The batched sprite's vertex stage (sprite.wgsl). One draw holds many sprites: each instance is a record
// of the per-object table (chunks/objectData.wgsl, graphics/objectData.ts `packSpriteRecord`), picked by
// `instance_index` = the batch's first record + the instance. Its matrix, tile and dissolve are basicVertex's;
// what a single sprite draw used to take as uniforms (tint, opacity, intensity, soft fade) is handed to the
// fragment stage flat, the same for the whole quad.

#include "./dither.wgsl"
#include "./objectData.wgsl"

struct SpriteVaryings {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    // Despawn dissolve (x = how far gone, y = dither phase); zero keeps everything. See dissolveKeeps.
    @location(1) dissolve: vec2<f32>,
    // (tint r, g, b as authored in sRGB, opacity)
    @location(2) @interpolate(flat) look: vec4<f32>,
    // (intensity, soft fade in metres)
    @location(3) @interpolate(flat) params: vec2<f32>,
};

// The block the Basic and lit sprite programs read too (chunks/basicVertex.wgsl), so the 2D pass's
// per-pass uploads land alike.
struct BasicTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    // The despawn dither phase (per frame); how far gone is per sprite, objectParams().x. See Node.remove.
    u_ditherPhase: f32,
};
@group(1) @binding(0) var<uniform> u_transform: BasicTransform;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
    @builtin(instance_index) objectIndex: u32,
) -> SpriteVaryings {
    let model = objectModel(objectIndex);
    let uvt = objectUvTransform(objectIndex);
    let params = objectParams(objectIndex);
    var out: SpriteVaryings;
    out.uv = texCoord * uvt.xy + uvt.zw;
    out.dissolve = vec2<f32>(params.x, u_transform.u_ditherPhase);
    out.look = objectSpriteLook(objectIndex);
    out.params = vec2<f32>(objectSpriteExtra(objectIndex).x, params.w);
    out.position = u_transform.u_projection * u_transform.u_view * model
                 * vec4<f32>(position, 1.0);
    return out;
}
