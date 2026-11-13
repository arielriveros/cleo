// The per-object table (graphics/objectData.ts): one rgba32float texture holding, per object a submission
// draws, its world matrix, dissolve, camera-hole opt-in, Basic UV transform and bone palette. A draw
// picks its record through `@builtin(instance_index)`, which the engine starts at the record:
// `firstInstance` on WebGPU, naga's `naga_vs_first_instance` uniform on WebGL2.
//
// Group 2 is the table's own: no program that includes this declares anything else there.
// The constants must equal objectData.ts (tests/objectData.test.ts compares them).

@group(2) @binding(0) var u_objectData_texture: texture_2d<f32>;

const OBJECT_TABLE_SHIFT: u32 = 10u;    // OBJECT_TABLE_WIDTH_SHIFT: 1024 texels per row
const OBJECT_TABLE_MASK: u32 = 1023u;
const OBJECT_RECORD_SHIFT: u32 = 3u;    // OBJECT_RECORD_SHIFT: 8 texels per record

fn objectTexel(t: u32) -> vec4<f32> {
    return textureLoad(u_objectData_texture, vec2<i32>(i32(t & OBJECT_TABLE_MASK), i32(t >> OBJECT_TABLE_SHIFT)), 0);
}

fn objectMatrixAt(t: u32) -> mat4x4<f32> {
    return mat4x4<f32>(objectTexel(t), objectTexel(t + 1u), objectTexel(t + 2u), objectTexel(t + 3u));
}

/** The world matrix of record `i`. */
fn objectModel(i: u32) -> mat4x4<f32> { return objectMatrixAt(i << OBJECT_RECORD_SHIFT); }

/** (dissolve, camera-hole opt-in 0/1, bone palette texel, reserved; a sprite's soft fade) of record `i`. */
fn objectParams(i: u32) -> vec4<f32> { return objectTexel((i << OBJECT_RECORD_SHIFT) + 4u); }

/** A Basic material's UV transform: (scale.xy, offset.xy). (1, 1, 0, 0) for every other material. */
fn objectUvTransform(i: u32) -> vec4<f32> { return objectTexel((i << OBJECT_RECORD_SHIFT) + 5u); }

/** A sprite's (tint r, g, b as authored in sRGB, opacity): objectData.ts `packSpriteRecord`. Zero for a model. */
fn objectSpriteLook(i: u32) -> vec4<f32> { return objectTexel((i << OBJECT_RECORD_SHIFT) + 6u); }

/** A sprite's (intensity, lit ambient r, g, b). Its soft fade is objectParams().w. Zero for a model. */
fn objectSpriteExtra(i: u32) -> vec4<f32> { return objectTexel((i << OBJECT_RECORD_SHIFT) + 7u); }

/** Bone `id` of the palette starting at texel `palette`. */
fn objectBone(palette: u32, id: i32) -> mat4x4<f32> { return objectMatrixAt(palette + u32(id) * 4u); }
