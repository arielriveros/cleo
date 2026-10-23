#include "./alphaCutout.wgsl"
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
    /**
     * HDR headroom for the emissive colour, default 1.
     *
     * `emissiveFactor` is a COLOUR and the editor authors it through a hex picker, so it cannot exceed
     * 1 on any channel. That put a hard ceiling on how bright an emissive surface could be, and the
     * ceiling sat below the point where anything happens: bloom's threshold is display-referred, so at
     * the default exposure a mid-tone emissive reaches exposed luma 1.0 — exactly the threshold — and
     * contributes nothing. Even pure white only doubles it. There was no setting at which an authored
     * emissive material glowed, which is what this multiplier is for.
     */
    emissiveIntensity: f32,
    metallic: f32,
    roughness: f32,
    /**
     * Dielectric specular level, 0..1, remapped to F0 by `dielectricF0` (0.5 -> the 0.04 every
     * dielectric in this engine used to be hardcoded to). Ignored where `metallic` is 1: a conductor's
     * F0 is its base colour.
     */
    reflectance: f32,
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
     * `invertHeight` says the map is a DEPTH map (white = deep) rather than the height map the engine
     * authors. See parallaxHeight in chunks/parallax.wgsl: the two conventions are indistinguishable
     * from the bytes and the wrong one turns the relief inside out.
     *
     * These three must exist in BOTH this chunk and its forward/deferred twin, or the two paths shade
     * differently and nothing says so. (The camera/sun members below are deferred-only, because the
     * forward twin already has both in its lighting block — those are plumbing, not authored state.)
     */
    dispScale: f32,
    hasDisplacementMap: i32,
    invertHeight: i32,
    /**
     * Whether `dispScale` is a depth in WORLD units (1) or in UV units (0).
     *
     * A UV depth only means something once you know what a UV unit is worth. On a tiling material one
     * repeat is a few centimetres and 0.05 is a sensible few millimetres of relief; on an atlas-mapped
     * scan one repeat is the WHOLE OBJECT and the same number is metres. Measured on a scanned branch:
     * one UV unit was 47.97 world units, so the default asked for 2.4 units of relief on a 12.7-unit
     * branch and the march reached across the atlas for texels on its far side.
     *
     * A flag rather than a silent reinterpretation, because converting a stored number needs the chart
     * scale and that belongs to the MESH, not the material — one material can sit on a cube and on a
     * scan. So: world for anything authored from now on, uv for anything loaded without the marker.
     */
    depthInWorld: i32,
    /**
     * Also discard where the march's hit uv leaves the fragment's own uv TILE, so a FLAT face's
     * silhouette follows the height field instead of staying a straight polygon edge.
     *
     * Curved surfaces need no flag: the march bends its ray with the surface and discards a ray that
     * climbs back out of the relief layer (see parallaxOcclusion), which bites the outline of a sphere
     * or a cylinder on its own. A flat face has no curvature to bend with — its only border is the uv
     * one, and that is what this tests. Clipping cannot add geometry; it only removes fragments, so a
     * corner gets BITTEN INTO rather than made bumpy.
     *
     * Off by default and not inferrable: the tile is a real border only where the surface is mapped
     * 0..1 per face (a cube face, a quad). Tiled ground has no border there.
     *
     * Shadow casters still see the unclipped surface (the shadow passes do not march), and on a closed
     * back-face-culled mesh a clipped fragment shows the background rather than the inside of the notch.
     */
    clipSilhouette: i32,
    /**
     * Geometric specular antialiasing, on or off. Renderer state, not a material constant — the same
     * reason `viewPos` and `sunDirection` below ride in this block: the deferred geometry stage has no
     * other group-1 block to read per-frame values from.
     *
     * See `filterSpecularRoughness` in chunks/modelVarying.wgsl for what it does and why it must be
     * called in uniform control flow.
     */
    specularAA: i32,
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
    /**
     * The camera's view-projection (GL convention, unjittered), for the parallax hit's PIXEL DEPTH
     * OFFSET — see `parallaxDepth`. Per-frame camera state riding in the material block for the same
     * reason `viewPos` does; written beside it in `Renderer._applyMaterialProperties`.
     */
    viewProj: mat4x4<f32>,
    /**
     * Texture mapping — chunks/uvProjection.wgsl. Tiling u/v and offset u/v (every mode); projection
     * 0 mesh uv / 1 box / 2 triplanar; space 0 object / 1 world; metres per repeat; triplanar sharpness.
     */
    uvTransform: vec4<f32>,
    uvProjection: i32,
    uvSpace: i32,
    uvWorldSize: f32,
    uvBlend: f32,
};
@group(1) @binding(1) var<uniform> u_material: PBRMaterial;

/** This material's mapping settings, for chunks/uvProjection.wgsl. */
fn materialUv() -> UvParams {
    return UvParams(u_material.uvTransform, u_material.uvProjection, u_material.uvSpace,
                    u_material.uvWorldSize, u_material.uvBlend);
}

struct GBuffer {
    @location(0) gAlbedoMetallic: vec4<f32>,    // rgb = albedo, a = metallic
    @location(1) gNormalRoughness: vec4<f32>,   // rg = oct normal, b = reflectance, a = roughness
    @location(2) gEmissiveAO: vec4<f32>,        // rgb = emissive, a = ambient occlusion
#if CLEO_POM
    // The parallax hit's depth (see parallaxDepth), so lighting, SSAO and every later depth test see
    // the relief rather than the polygon. `pom` variants only — it disables early-Z for the draw.
    @builtin(frag_depth) depth: f32,
#endif
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
fn getNormal(in: VertexOutput, front: bool, su: SurfaceUv, uv: vec2<f32>) -> vec3<f32> {
    let ddx = su.dx0;
    let ddy = su.dy0;
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
        // Never let a degenerate frame (or map texel) make the normal NaN: see safeNormalize.
        N = select(tbn[2], N, dot(N, N) > 1e-12);
        // A projected surface has no vertex tangents for its charts; see chunks/uvProjection.wgsl.
        if (su.mode != UV_MESH) {
            N = projectedNormal(u_material_normalMap_texture, u_material_normalMap_sampler, su, uv, tbn[2]);
        }
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
    // The material's mapping (mesh uv / box / triplanar), with its gradients — taken here, in uniform
    // control flow. `ddx`/`ddy` are chart 0's, which is THE chart in mesh and box modes.
    let su = surfaceUvOf(in, materialUv());
    let ddx = su.dx0;
    let ddy = su.dy0;
    // `select`, not an `if`, so the back-face flip introduces no branch at all ahead of the
    // derivative work. A double-sided material shows its back face with the interpolated normal
    // pointing away; marching against that would push the relief out of the surface, not into it.
    let toEye = normalize(u_material.viewPos - in.fragPos);
    let basis = parallaxFrame(in.fragPos, ddx, ddy, tbnOf(in), toEye);
    let frame = basis.frame;

    var uv = su.uv0;
    var selfShadow = 1.0;
    // The hit's window depth: the rasterised one unless the march moves it (the `pom` variant only).
    var pomDepth = in.position.z;
    // A height map IS the request — there is no separate switch. Not on triplanar: three blended
    // charts have no single surface for a ray to march.
    //
    // Compiled into the `pom` variants ONLY (programVariants.ts), the editor included: those are the
    // programs that write frag_depth, and writing it costs early-Z for the whole draw, so a material
    // that does not march must never pay for it. The base and `flat` programs take the #else.
#if CLEO_POM
    if (u_material.hasDisplacementMap != 0 && su.mode != UV_TRIPLANAR) {
        let invert = u_material.invertHeight != 0;
        let dims = vec2<f32>(textureDimensions(u_material_displacementMap_texture, 0));
        // One LOD, hoisted: the fade, the step count and every fetch in both marches read it, so they
        // cannot disagree about which mip the surface lives on.
        let lod = parallaxLod(ddx, ddy, dims);
        let vTan = parallaxToTangent(frame, toEye);
        // A clipped material is depth-bounded; see parallaxBoundedDepth. The band the clip carves IS
        // the lateral travel, so the two have to be capped together or a deep surface loses a third of
        // itself to the discard.
        // Whichever unit the material declared. `basis.worldPerUv` is measured from the chart the
        // fragment actually has, so one authored world depth reads the same on a cube, on tiled ground
        // and on a photogrammetry atlas.
        let authored = parallaxDepthUv(u_material.dispScale, basis.worldPerUv,
                                       u_material.depthInWorld != 0);
        let depth = select(authored,
                           parallaxBoundedDepth(vTan, authored, POM_CLIP_REACH),
                           u_material.clipSilhouette != 0);
        let hit = parallaxOcclusion(u_material_displacementMap_texture,
                                    u_material_displacementMap_sampler,
                                    su.uv0, ddx, ddy, vTan, depth, dims,
                                    parallaxCurvature(basis, toEye), basis.worldPerUv, lod, invert);
        // THE CURVED SILHOUETTE: the ray climbed back out of the relief layer without meeting the
        // field, so there is no surface along this pixel's ray. See parallaxOcclusion.
        if (hit.miss) { discard; }
        uv = hit.uv;
        pomDepth = parallaxDepth(in.position.z, in.fragPos, toEye, hit.dist, u_material.viewProj);
        // Safe here: ddx/ddy were taken in uniform control flow at the top of the stage and every fetch
        // below is textureSampleGrad, so this introduces no derivative under a per-fragment branch.
        //
        // Against the fragment's OWN tile, not a literal 0..1. A mesh whose uv runs 0..8 has only one
        // fragment in [0,1]; testing the absolute uv discarded everything outside the first tile, which
        // is not the "grid of holes" the note above once claimed but near-total erasure of the mesh.
        // `floor(in.uv)` is 0 for a 0..1 chart, so this is identical where the feature is meant to be
        // used and merely local where it is not.
        let tile = floor(su.uv0);
        if (u_material.clipSilhouette != 0
            && (any(hit.uv < tile) || any(hit.uv > tile + vec2<f32>(1.0)))) { discard; }
        let sunDir = u_material.sunDirection;
        if (dot(sunDir, sunDir) > 1e-6) {
            let lTan = parallaxToTangent(frame, normalize(-sunDir));
            selfShadow = parallaxShadow(u_material_displacementMap_texture,
                                        u_material_displacementMap_sampler,
                                        uv, lTan, hit.h, depth, lod, invert);
        }
    }
#else
    // CLEO_POM=0 (or undefined — the base program): for materials that never march (no height map,
    // or triplanar). It still READS the height map, behind a test no material passes: WebGPU builds the
    // bind-group layout from what the shader uses, and both variants share one bind group.
    if (u_material.dispScale < -1e30) {
        selfShadow = textureSampleLevel(u_material_displacementMap_texture,
                                        u_material_displacementMap_sampler, su.uv0, 0.0).r;
    }
#endif

    // Every fetch below reads the parallax-offset uv. All of them, or the maps come apart: an albedo
    // displaced while its normal is not is worse than no parallax at all.
    // The mask cutout, before the base-colour fetch: a discarded fragment writes no G-buffer at all.
    // Explicit gradients from the UN-offset uv, like every other fetch below.
    if (u_material.hasMaskMap != 0 && u_material.alphaCutoff > 0.0) {
        let mask = cutoutAlpha(sampleSurface(u_material_maskMap_texture, u_material_maskMap_sampler, su, uv).r,
                               su.dx0, su.dy0, textureDimensions(u_material_maskMap_texture, 0));
        if (mask < u_material.alphaCutoff) { discard; }
    }

    // Foliage LOD crossfade: a screen-door dissolve between levels (always kept outside foliage).
    if (!lodFadeKeeps(in.lodFade, in.position.xy)) { discard; }

    var albedo = u_material.baseColor;
    if (u_material.hasBaseColorTexture != 0) {
        let texel = sampleSurface(u_material_baseColorTexture_texture, u_material_baseColorTexture_sampler, su, uv);
        // The cutout, before any other work: a discarded fragment writes no G-buffer at all, so a leaf
        // card's background never becomes depth, normal or albedo for the lighting pass to shade.
        // Only when there is no mask texture — that one has already been tested above.
        if (u_material.hasMaskMap == 0 && u_material.alphaCutoff > 0.0
            && cutoutAlpha(texel.a, su.dx0, su.dy0, textureDimensions(u_material_baseColorTexture_texture, 0))
               < u_material.alphaCutoff) { discard; }
        albedo *= pow(texel.rgb, vec3<f32>(2.2));   // sRGB -> linear
    }

    var metallic = u_material.metallic;
    var roughness = u_material.roughness;
    var ao = 1.0;
    if (u_material.hasMetallicMap != 0 || u_material.hasRoughnessMap != 0 || u_material.hasOcclusionMap != 0) {
        let orm = sampleSurface(u_material_ormTexture_texture, u_material_ormTexture_sampler, su, uv).rgb;
        if (u_material.hasOcclusionMap != 0) { ao = orm.r; }
        if (u_material.hasRoughnessMap != 0) { roughness = orm.g; }
        if (u_material.hasMetallicMap != 0) { metallic = orm.b; }
    }

    var emissive = u_material.emissiveFactor * u_material.emissiveIntensity;
    if (u_material.hasEmissiveMap != 0) {
        // sRGB -> linear
        let t = sampleSurface(u_material_emissiveMap_texture, u_material_emissiveMap_sampler, su, uv).rgb;
        emissive = pow(t, vec3<f32>(2.2)) * u_material.emissiveFactor * u_material.emissiveIntensity;
    }

    let N = normalize(getNormal(in, front, su, uv));

    var out: GBuffer;
    // The parallax self-shadow is folded into ALBEDO - an approximation the G-buffer forces. There is
    // no spare channel, and AO is not a substitute: deferredLighting spends AO on the INDIRECT terms
    // only, so a sun shadow routed through it would never darken the sun.
    // Albedo does reach the direct term (accumulateLight's diffuse lobe is
    // `albedo * (1 - metallic) * Fd_Burley(...)`), so this darkens direct and ambient diffuse
    // correctly and misses only the specular lobe. Of the alternatives, a fourth target costs
    // bandwidth every frame and frag_depth would disable early-Z for the entire pass.
    //
    // CORRECTION, 2026-08-28. This comment used to also claim that octahedral-packing the normal to
    // free a channel "breaks the custom-material G-buffer contract". That is FALSE, and it was blocking
    // a design decision on a false premise. A custom deferred material fills a `Surface` struct and
    // never writes a target: `DEFERRED_EPILOGUE` in systems/customShaders.ts does
    // `gNormalRoughness = vec4(normalize(s.normal), s.roughness)` after the user's `surface(s)` returns,
    // so how those bits are encoded is entirely the engine's business. Oct-packing IS available, frees
    // exactly one channel, and only four engine-owned consumers decode the normal (deferredLighting,
    // the AO pass (now ssil), debugView, and the hand-written fallback FS in customShaders.ts). One trap
    // if anyone takes it: the old ssao.wgsl's `dot(normalW, normalW) < 1e-6` "nothing was written here" sentinel stops working,
    // because (0,0) is a VALID oct direction.
    //
    // chunks/pbrForward.wgsl, which has the light list, applies the same term properly.
    out.gAlbedoMetallic = vec4<f32>(albedo * selfShadow, metallic);
    // The roughness written here is FILTERED — see filterSpecularRoughness. It has to happen in this
    // pass and not in deferredLighting: taking dpdx of the G-buffer normal in a fullscreen pass would
    // straddle silhouettes, sampling two unrelated surfaces into one variance estimate and painting a
    // rim of blur around every object. Here the derivative is taken across one triangle's own normal.
    let octN = octEncode(N);
    out.gNormalRoughness = vec4<f32>(octN.x, octN.y, u_material.reflectance,
                                     filterSpecularRoughness(roughness, N, u_material.specularAA));
    out.gEmissiveAO = vec4<f32>(emissive, ao);
#if CLEO_POM
    out.depth = pomDepth;
#endif
    return out;
}
