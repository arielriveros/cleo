#include "./alphaCutout.wgsl"
// Unlit forward shading. The GLSL twin is materials/basic.fs.
//
// Uses VertexOutput from whichever basic vertex chunk the program included.

@group(0) @binding(0) var u_material_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_texture_sampler: sampler;
@group(0) @binding(2) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_maskMap_sampler: sampler;
// The opaque scene's depth snapshot (Renderer._copySceneDepth): a soft sprite fades into what is behind it.
@group(0) @binding(4) var u_sceneDepth_texture: texture_depth_2d;
@group(0) @binding(5) var u_sceneDepth_sampler: sampler;

struct BasicMaterial {
    color: vec3<f32>,
    opacity: f32,
    // i32 rather than bool: WGSL forbids bool in a uniform buffer. Call sites still pass a boolean.
    hasTexture: i32,
    /**
     * Alpha cutout. Below this the fragment is DISCARDED; 0 disables it (that is the "off" encoding,
     * so 0 is not a valid threshold).
     *
     * The value tested is the mask texture's RED channel. Red rather than alpha, despite the name:
     * it is the engine's convention for a standalone single-channel map (see the reflectivity note in
     * systems/texturePacker.ts), it is what Blinn-Phong's mask has always read, and it is what the
     * assimp opacity-map import (aiTextureType_OPACITY) feeds into this slot. A grayscale mask has
     * r == g == b, so red is the only channel that works for the maps this slot actually receives.
     *
     * Discard, not a blend: this material also renders through the deferred G-buffer, which has no
     * alpha channel to carry coverage, so a cutout is the only mechanism that behaves the same in
     * both pipelines.
     */
    alphaCutoff: f32,
    hasMaskMap: i32,
    /**
     * Linear colour multiplier past what `color` can reach (it stops at white): a sprite's tileset
     * OVERDRIVE (Tileset.overdriveOf), which lets fire or magic cross the bloom threshold. 1 = as authored;
     * Material.Basic defaults it, so every other Basic surface is unchanged.
     */
    intensity: f32,
    /**
     * A sprite's soft fade (Sprite.softness), metres: it fades out as it nears the opaque surface behind
     * it, over this distance, instead of being cut by it along a hard line -- a flame set into its torch
     * head or logs. 0 is off (every other Basic surface). The renderer sets it per sprite draw.
     */
    softness: f32,
    /** x near, y far, z 1 = orthographic, w 1 = the depth snapshot is live: for `softness`. */
    depthParams: vec4<f32>,
};
@group(1) @binding(1) var<uniform> u_material: BasicMaterial;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // A despawn dissolve: see Node.remove and chunks/dither.wgsl.
    if (!dissolveKeeps(in.dissolve, in.position.xy)) { discard; }
    // The cutout first, before any other work — a discarded fragment costs nothing downstream. Its
    // gradients are taken here, in uniform control flow, for the mip-aware alpha (chunks/alphaCutout).
    let cutDx = dpdx(in.uv);
    let cutDy = dpdy(in.uv);
    if (u_material.hasMaskMap != 0 && u_material.alphaCutoff > 0.0) {
        let mask = cutoutAlpha(textureSample(u_material_maskMap_texture, u_material_maskMap_sampler, in.uv).r,
                               cutDx, cutDy, textureDimensions(u_material_maskMap_texture, 0));
        if (mask < u_material.alphaCutoff) { discard; }
    }

    // Decode the sRGB-authored colour/texture to linear; this shader writes into the linear-HDR scene
    // buffer and is tonemapped once at the final present like every other surface.
    var color = toLinear(u_material.color);
    var alpha = u_material.opacity;

    if (u_material.hasTexture != 0) {
        let texColor = textureSample(u_material_texture_texture, u_material_texture_sampler, in.uv);
        color *= toLinear(texColor.rgb);
        alpha *= texColor.a;
    }

    // Soft fade: the view depths of the scene behind and of this fragment, from the same window depth.
    let softness = u_material.softness;
    if (softness > 0.0 && u_material.depthParams.w > 0.5) {
        let uv = in.position.xy / vec2<f32>(textureDimensions(u_sceneDepth_texture, 0));
        let scene = basicViewDepth(textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, uv, 0));
        alpha *= clamp((scene - basicViewDepth(in.position.z)) / softness, 0.0, 1.0);
    }

    return vec4<f32>(color * u_material.intensity, alpha);
}

/** A window depth's distance along the camera axis (as particleDraw.wgsl `linearSceneDepth`). */
fn basicViewDepth(d: f32) -> f32 {
    let near = u_material.depthParams.x;
    let far = u_material.depthParams.y;
    if (u_material.depthParams.z > 0.5) { return near + d * (far - near); }
    let z = d * 2.0 - 1.0;
    return 2.0 * near * far / (far + near - z * (far - near));
}
