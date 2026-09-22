// Colour decals — the two passes that paint a decal onto the IMAGE rather than into the G-buffer.
//
//   mode 0, EMISSIVE: after lighting, additively, into the lit scene buffer. Unreal renders decal
//     emissive the same way, in its own post-lighting pass. Because it reads the full opaque depth
//     snapshot (deferred AND forward opaques), emissive reaches every opaque surface — including the
//     forward-shaded Default and Cel materials the G-buffer path cannot. Output alpha is irrelevant:
//     the renderer's blend leaves the scene buffer's alpha (the bloom mask) untouched.
//   mode 1, OVERLAY: editor chrome, into the overlay layer after the post chain — the landscape brush.
//     Straight-alpha colour with coverage alpha, for the overlay's `OVERLAY_BLEND`. Unlit and
//     exposure-independent, like every other piece of chrome.
//
// The projection itself is chunks/decal.wgsl's, shared with the surface pass.

#include "./chunks/decal.wgsl"

@group(0) @binding(0) var u_material_baseColorTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_baseColorTexture_sampler: sampler;
@group(0) @binding(2) var u_material_emissiveMap_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_emissiveMap_sampler: sampler;
@group(0) @binding(4) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_maskMap_sampler: sampler;

/** Half a texel inside [0, 1], so a repeat-wrapped decal texture cannot bleed in along the border. */
fn insetUv(uv: vec2<f32>, dims: vec2<u32>) -> vec2<f32> {
    let border = 0.5 / max(vec2<f32>(dims), vec2<f32>(1.0));
    return clamp(uv, border, vec2<f32>(1.0) - border);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let s = decalSample(in.position.xy);
    // The G-buffer normal does not exist for a forward-shaded surface, so the angle fade here uses the
    // geometric normal rebuilt from the depth taps — the same surface, without its normal-map detail.
    let coverage = s.weight * decalAngleWeight(s.geoNormal) * u_decal.u_decalOpacity;

    var color = u_material.baseColor;
    var alpha = u_material.opacity;
    // Exactly what chunks/pbrGBuffer.wgsl stores for the same material, so a decal glows as brightly
    // as a mesh wearing it: factor x intensity, times the sRGB-decoded map where there is one.
    var emissive = u_material.emissiveFactor * u_material.emissiveIntensity;
    if (u_decal.u_pattern == 0) {
        if (u_material.hasBaseColorTexture != 0) {
            let texel = textureSampleGrad(u_material_baseColorTexture_texture,
                                          u_material_baseColorTexture_sampler,
                                          insetUv(s.uv, textureDimensions(u_material_baseColorTexture_texture, 0)),
                                          s.ddx, s.ddy);
            color *= pow(texel.rgb, vec3<f32>(2.2));
            alpha *= texel.a;
        }
        if (u_material.hasMaskMap != 0) {
            alpha *= textureSampleGrad(u_material_maskMap_texture, u_material_maskMap_sampler,
                                       insetUv(s.uv, textureDimensions(u_material_maskMap_texture, 0)),
                                       s.ddx, s.ddy).r;
        }
        if (u_material.hasEmissiveMap != 0) {
            let e = textureSampleGrad(u_material_emissiveMap_texture, u_material_emissiveMap_sampler,
                                      insetUv(s.uv, textureDimensions(u_material_emissiveMap_texture, 0)),
                                      s.ddx, s.ddy).rgb;
            emissive = pow(e, vec3<f32>(2.2)) * u_material.emissiveFactor * u_material.emissiveIntensity;
        }
    } else {
        let p = radialPattern(s.t, s.tPerPixel);
        color = p.rgb;
        alpha = p.a;
        emissive = p.rgb * u_decal.u_radialEmissive;
    }
    let a = clamp(alpha * coverage, 0.0, 1.0);

    if (u_decal.u_decalMode == 0) {
        return vec4<f32>(emissive * a, 0.0);
    }
    return vec4<f32>(color, a);
}
