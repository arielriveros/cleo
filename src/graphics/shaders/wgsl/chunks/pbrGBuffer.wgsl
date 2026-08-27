// The PBR G-buffer fragment stage, shared by the plain, skinned and instanced geometry programs.
//
// It uses VertexOutput and tbnOf() without including chunks/modelVarying.wgsl itself: whichever
// vertex chunk the program included already brought them in, and including it here as well would
// define the struct twice. The include resolver has no include-once guard.

// Samplers are separate globals named `u_material_<field>`, not members of the material struct: WGSL
// has no opaque types in a struct, and no legal identifier generates a dotted GLSL name. The GLSL twin
// hoists them the same way, so the renderer names them identically for both.
@group(0) @binding(0) var u_material_baseColorTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_baseColorTexture_sampler: sampler;
@group(0) @binding(2) var u_material_ormTexture_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_ormTexture_sampler: sampler;
@group(0) @binding(4) var u_material_normalMap_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_normalMap_sampler: sampler;
@group(0) @binding(6) var u_material_emissiveMap_texture: texture_2d<f32>;
@group(0) @binding(7) var u_material_emissiveMap_sampler: sampler;
@group(0) @binding(8) var u_material_displacementMap_texture: texture_2d<f32>;
@group(0) @binding(9) var u_material_displacementMap_sampler: sampler;
@group(0) @binding(10) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(11) var u_material_maskMap_sampler: sampler;

struct PBRMaterial {
    baseColor: vec3<f32>,
    emissiveFactor: vec3<f32>,
    metallic: f32,
    roughness: f32,
    opacity: f32,
    /**
     * glTF alphaMode MASK. Below this base-colour alpha the fragment is discarded; 0 disables it.
     *
     * Placed after `opacity` rather than appended: the block's offsets are derived at runtime by both
     * back ends (WebGPU reflects it, WebGL2 asks the driver), so where it sits is free — but it has to
     * exist in BOTH this chunk and its forward/deferred twin, or the two paths shade differently and
     * nothing says so.
     */
    alphaCutoff: f32,
    // Every flag is an i32, not a bool: WGSL forbids bool in a uniform buffer (not host-shareable).
    // Call sites still pass JavaScript booleans — the std140 writer converts them, because the
    // reflected member type is integer.
    hasBaseColorTexture: i32,
    // Occlusion, roughness and metallic are authored as separate maps and combined into ONE texture by
    // systems/texturePacker.ts before they get here (glTF layout: r=AO, g=roughness, b=metallic). Each
    // flag says whether its channel was actually authored; the others fall back to the scalars above.
    hasMetallicMap: i32,
    hasRoughnessMap: i32,
    hasOcclusionMap: i32,
    hasNormalMap: i32,
    hasEmissiveMap: i32,
    /**
     * A dedicated cutout mask, tested against `alphaCutoff` above.
     *
     * Takes PRECEDENCE over the base-colour alpha when present. That ordering is what keeps every
     * existing glTF import rendering identically: `alphaMode: MASK` sets `alphaCutoff` and no mask
     * texture, so it still falls through to the base-colour alpha exactly as before. A mask is what
     * an FBX/OBJ opacity map (aiTextureType_OPACITY) and a hand-authored cutout supply, neither of
     * which has anywhere to live in a base colour's alpha.
     *
     * RED channel, not alpha — see the note on the same member in chunks/basicGBuffer.wgsl.
     */
    hasMaskMap: i32,
    /**
     * Parallax occlusion mapping. `dispScale` is the depth of the height field in UV units; the flag
     * says whether a displacement map was authored.
     *
     * The height field gets its OWN sampler rather than riding in the normal map's alpha the way
     * terrain's does. Terrain packs because it had to - four layers put it at 13 bound units, and
     * folding height into an unused alpha bought it back down to 9. A standard material has units to
     * spare (5 was freed when metallic/roughness/occlusion were packed into one ORM map), and the
     * packed alternative would mean renaming the normal sampler in all four material chunks, routing
     * blinn-phong through the packer as well, and teaching TexturePacker to hold more than one pack
     * per material. A texture unit is the cheaper thing to spend.
     *
     * These two must exist in BOTH this chunk and its forward/deferred twin, or the two paths shade
     * differently and nothing says so. (The camera/sun members below are deferred-only, because the
     * forward twin already has both in its lighting block — those are plumbing, not authored state.)
     */
    dispScale: f32,
    hasDisplacementMap: i32,
    /**
     * Camera and sun, for the parallax march. Per-frame view state rather than material constants,
     * and they sit in the material block anyway because it is the only group-1 block this stage has.
     *
     * Not the transform block: that one is read by the VERTEX stage, and a block read from both
     * stages is emitted by naga as two stage-suffixed blocks with no instance name, which the
     * engine's by-name reflection cannot disambiguate ("Ambiguous field 'u_transform' in blocks
     * ... which don't have instance names"). Terrain solves it the same way — see TerrainUniforms.
     *
     * chunks/pbrForward.wgsl needs neither: it already carries both in `u_lighting`.
     *
     * A zero `sunDirection` means "no directional light", and switches self-shadowing off.
     */
    viewPos: vec3<f32>,
    sunDirection: vec3<f32>,
};
@group(1) @binding(1) var<uniform> u_material: PBRMaterial;

struct GBuffer {
    @location(0) gAlbedoMetallic: vec4<f32>,    // rgb = albedo, a = metallic
    @location(1) gNormalRoughness: vec4<f32>,   // rgb = world normal, a = roughness
    @location(2) gEmissiveAO: vec4<f32>,        // rgb = emissive, a = ambient occlusion
};

/**
 * The shading normal, flipped for a BACK face.
 *
 * A `side: 'double'` material draws both windings, but the interpolated normal always belongs to the
 * front. Shading a back face with it means every surface seen from behind is lit as though it faced
 * away from the light — which for thin, two-sided geometry is half of it. That is why the imported
 * foliage rendered black: a leaf card, a grass blade and a pine needle are each one double-sided
 * sheet, and roughly half of every one of them was facing away at any moment.
 *
 * Single-sided materials are unaffected: their back faces are culled, so `front` is always true.
 */
fn getNormal(in: VertexOutput, front: bool, uv: vec2<f32>, ddx: vec2<f32>, ddy: vec2<f32>) -> vec3<f32> {
    // `tbn`, not the parallax frame: this is a normal-map decode, and its bitangent sign is the
    // engine-wide green-channel convention. chunks/parallax.wgsl explains why the two differ.
    let tbn = tbnOf(in);
    var N = tbn[2];
    if (u_material.hasNormalMap != 0) {
        // Explicit gradients, from the UN-offset uv. Parallax makes `uv` discontinuous wherever the
        // ray crosses a cliff in the height field, so its own derivatives would pick a wildly wrong
        // mip along every such seam. With no displacement map this is bit-identical to the implicit
        // sample it replaces: uv is then in.uv, whose screen-space derivative is exactly ddx/ddy.
        var n = textureSampleGrad(u_material_normalMap_texture, u_material_normalMap_sampler,
                                  uv, ddx, ddy).rgb;
        n = normalize(n * 2.0 - 1.0);
        N = normalize(tbn * n);
    }
    if (!front) { N = -N; }
    return N;
}

@fragment
// `front_facing` is a second entry-point parameter rather than a member of VertexOutput: that struct
// is the VERTEX stage's output too, and a fragment-only builtin cannot live there.
fn fs_main(in: VertexOutput, @builtin(front_facing) front: bool) -> GBuffer {
    // Gradients and the parallax frame, both taken in UNIFORM control flow - above the discard below
    // and above every per-fragment branch. dpdx/dpdy carry the same rule textureSample does, and a
    // derivative reached past a discard is non-uniform: naga waves that through, Dawn rejects the
    // module, and a rejected module takes its pipeline and every bind group built from it down.
    let ddx = dpdx(in.uv);
    let ddy = dpdy(in.uv);
    // `select`, not an `if`, so the back-face flip introduces no branch at all ahead of the
    // derivative work. A double-sided material shows its back face with the interpolated normal
    // pointing away; marching against that would push the relief out of the surface, not into it.
    let nRaw = normalize(tbnOf(in)[2]);
    let toEye = normalize(u_material.viewPos - in.fragPos);
    let frame = parallaxFrame(in.fragPos, ddx, ddy, nRaw, toEye);

    var uv = in.uv;
    var selfShadow = 1.0;
    if (u_material.hasDisplacementMap != 0) {
        let dims = vec2<f32>(textureDimensions(u_material_displacementMap_texture, 0));
        let fade = parallaxFade(ddx, ddy, dims);
        let vTan = parallaxToTangent(frame, toEye);
        let hit = parallaxOcclusion(u_material_displacementMap_texture,
                                    u_material_displacementMap_sampler,
                                    in.uv, ddx, ddy, vTan, u_material.dispScale, fade);
        uv = hit.xy;
        let sunDir = u_material.sunDirection;
        if (dot(sunDir, sunDir) > 1e-6) {
            let lTan = parallaxToTangent(frame, normalize(-sunDir));
            selfShadow = parallaxShadow(u_material_displacementMap_texture,
                                        u_material_displacementMap_sampler,
                                        uv, ddx, ddy, lTan, hit.z, u_material.dispScale, fade);
        }
    }

    // Every fetch below reads the parallax-offset uv. All of them, or the maps come apart: an albedo
    // displaced while its normal is not is worse than no parallax at all.
    // The mask cutout, before the base-colour fetch: a discarded fragment writes no G-buffer at all.
    // Explicit gradients from the UN-offset uv, like every other fetch below.
    if (u_material.hasMaskMap != 0 && u_material.alphaCutoff > 0.0) {
        let mask = textureSampleGrad(u_material_maskMap_texture, u_material_maskMap_sampler,
                                     uv, ddx, ddy).r;
        if (mask < u_material.alphaCutoff) { discard; }
    }

    var albedo = u_material.baseColor;
    if (u_material.hasBaseColorTexture != 0) {
        let texel = textureSampleGrad(u_material_baseColorTexture_texture,
                                      u_material_baseColorTexture_sampler, uv, ddx, ddy);
        // The cutout, before any other work: a discarded fragment writes no G-buffer at all, so a leaf
        // card's background never becomes depth, normal or albedo for the lighting pass to shade.
        // Only when there is no mask texture — that one has already been tested above.
        if (u_material.hasMaskMap == 0 && u_material.alphaCutoff > 0.0
            && texel.a < u_material.alphaCutoff) { discard; }
        albedo *= pow(texel.rgb, vec3<f32>(2.2));   // sRGB -> linear
    }

    var metallic = u_material.metallic;
    var roughness = u_material.roughness;
    var ao = 1.0;
    if (u_material.hasMetallicMap != 0 || u_material.hasRoughnessMap != 0 || u_material.hasOcclusionMap != 0) {
        let orm = textureSampleGrad(u_material_ormTexture_texture, u_material_ormTexture_sampler,
                                    uv, ddx, ddy).rgb;
        if (u_material.hasOcclusionMap != 0) { ao = orm.r; }
        if (u_material.hasRoughnessMap != 0) { roughness = orm.g; }
        if (u_material.hasMetallicMap != 0) { metallic = orm.b; }
    }

    var emissive = u_material.emissiveFactor;
    if (u_material.hasEmissiveMap != 0) {
        // sRGB -> linear
        let t = textureSampleGrad(u_material_emissiveMap_texture, u_material_emissiveMap_sampler,
                                  uv, ddx, ddy).rgb;
        emissive = pow(t, vec3<f32>(2.2)) * u_material.emissiveFactor;
    }

    let N = normalize(getNormal(in, front, uv, ddx, ddy));

    var out: GBuffer;
    // The parallax self-shadow is folded into ALBEDO - an approximation the G-buffer forces. There is
    // no spare channel, and AO is not a substitute: deferredLighting spends AO on the ambient term
    // only (`ambient * ao * ssao + Lo`), so a sun shadow routed through it would never darken the sun.
    // Albedo does reach the direct term (accumulateLight computes `kD * albedo / PI + specular`), so
    // this darkens direct and ambient diffuse correctly and misses only the specular lobe. The
    // alternatives were all worse: octahedral-packing the normal to free a channel breaks the
    // custom-material G-buffer contract, a fourth target costs bandwidth every frame, and frag_depth
    // would disable early-Z for the entire pass. chunks/pbrForward.wgsl, which has the light list,
    // applies the same term properly.
    out.gAlbedoMetallic = vec4<f32>(albedo * selfShadow, metallic);
    out.gNormalRoughness = vec4<f32>(N, roughness);
    out.gEmissiveAO = vec4<f32>(emissive, ao);
    return out;
}
