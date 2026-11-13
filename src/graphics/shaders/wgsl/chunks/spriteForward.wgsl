// The batched sprite's fragment stage (sprite.wgsl): chunks/basicForward.wgsl's colour, alpha, soft fade
// and pre-exposure, operation for operation, with the per-sprite values read from the instance
// (SpriteVaryings, chunks/spriteVertex.wgsl) instead of the material block. Sprites carry no mask map, so
// basicForward's cutout has no counterpart here.
//
// What stays in the block is the same for every sprite of a batch: whether the tileset has a texture
// (a uniform branch, which `textureSample` needs), the depth snapshot's parameters, the pre-exposure.

@group(0) @binding(0) var u_material_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_texture_sampler: sampler;
// The opaque scene's depth snapshot (Renderer._copySceneDepth): a soft sprite fades into what is behind it.
@group(0) @binding(2) var u_sceneDepth_texture: texture_depth_2d;
@group(0) @binding(3) var u_sceneDepth_sampler: sampler;

struct SpriteMaterial {
    // i32 rather than bool: WGSL forbids bool in a uniform buffer. Call sites still pass a boolean.
    hasTexture: i32,
    /** x near, y far, z 1 = orthographic, w 1 = the depth snapshot is live: for the soft fade. */
    depthParams: vec4<f32>,
    /**
     * The draw's pre-exposure (FrameView.drawPreExposure): the frame's while the scene draws, 1 for the
     * display-referred editor overlay. 0 — never written — reads as 1.
     */
    preExposure: f32,
};
@group(1) @binding(1) var<uniform> u_material: SpriteMaterial;

@fragment
fn fs_main(in: SpriteVaryings) -> @location(0) vec4<f32> {
    // A despawn dissolve: see Node.remove and chunks/dither.wgsl.
    if (!dissolveKeeps(in.dissolve, in.position.xy)) { discard; }

    // Decode the sRGB-authored colour/texture to linear; this shader writes into the linear-HDR scene
    // buffer and is tonemapped once at the final present like every other surface.
    var color = toLinear(in.look.rgb);
    var alpha = in.look.a;

    if (u_material.hasTexture != 0) {
        let texColor = textureSample(u_material_texture_texture, u_material_texture_sampler, in.uv);
        color *= toLinear(texColor.rgb);
        alpha *= texColor.a;
    }

    // Soft fade: the view depths of the scene behind and of this fragment, from the same window depth.
    let softness = in.params.y;
    if (softness > 0.0 && u_material.depthParams.w > 0.5) {
        let uv = in.position.xy / vec2<f32>(textureDimensions(u_sceneDepth_texture, 0));
        let scene = spriteViewDepth(textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, uv, 0));
        alpha *= clamp((scene - spriteViewDepth(in.position.z)) / softness, 0.0, 1.0);
    }

    let preExposure = select(1.0, u_material.preExposure, u_material.preExposure > 0.0);
    return vec4<f32>(min(color * (in.params.x * preExposure), vec3<f32>(32768.0)), alpha);
}

/** A window depth's distance along the camera axis (as basicForward.wgsl `basicViewDepth`). */
fn spriteViewDepth(d: f32) -> f32 {
    let near = u_material.depthParams.x;
    let far = u_material.depthParams.y;
    if (u_material.depthParams.z > 0.5) { return near + d * (far - near); }
    let z = d * 2.0 - 1.0;
    return 2.0 * near * far / (far + near - z * (far - near));
}
