// Skinned depth-only shader for the shadow pass. Mirrors shadowMap.wgsl but applies linear-blend
// skinning so a skinned mesh casts its ANIMATED-pose shadow instead of its static bind pose.
//
// Bone attributes sit at locations 5 and 6, matching the LIT skinned families (chunks/skinnedVertex),
// which leave 1-4 to normal/uv/tangent/bitangent. The unlit Basic family has none of those and packs
// bone data at 2 and 3 instead — so this shader's layout is NOT universal, and the shadow pass must
// initialize the animated VAO from THIS program rather than from the node's geometry shader. It used
// to do the latter, which made every Basic-material skinned caster raise GL_INVALID_OPERATION.

#include "./chunks/objectData.wgsl"

const MAX_BONES: i32 = 100;
const MAX_BONE_INFLUENCE: i32 = 4;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

// The caster's world matrix and bone palette come from the per-object table (chunks/objectData.wgsl).
struct ShadowMapSkinnedUniforms {
    u_lightSpace: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_shadow: ShadowMapSkinnedUniforms;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(5) boneIds: vec4<i32>,    // Joint indices (up to 4 bones per vertex)
    @location(6) weights: vec4<f32>,    // Joint weights (up to 4 weights per vertex)
    @builtin(instance_index) objectIndex: u32,
) -> VertexOutput {
    let palette = u32(objectParams(objectIndex).z);
    var totalPosition = vec4<f32>(0.0);

    for (var i = 0; i < MAX_BONE_INFLUENCE; i++) {
        let id = boneIds[i];
        if (id == -1) { continue; }
        if (id >= MAX_BONES) { continue; }

        let localPosition = objectBone(palette, id) * vec4<f32>(position, 1.0);
        totalPosition += localPosition * weights[i];
    }

    // If no bone influences were applied, fall back to the raw bind-pose position.
    if (all(totalPosition == vec4<f32>(0.0))) {
        totalPosition = vec4<f32>(position, 1.0);
    }

    var out: VertexOutput;
    out.position = u_shadow.u_lightSpace * objectModel(objectIndex) * totalPosition;
    return out;
}

@fragment
fn fs_main() {
}
