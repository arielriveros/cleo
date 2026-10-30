#include "./alphaCutout.wgsl"
// Forward PBR (metallic-roughness) shading, shared by the plain and skinned programs.
//
// Computes the same Cook-Torrance result as deferredLighting.wgsl from the same light structures — the
// difference is only where the surface comes from: interpolated varyings here, a G-buffer fetch there.
// Both pull the BRDF and the light types from chunks/pbrLighting.wgsl so the two paths cannot drift
// into subtly different specular.
//
// Uses VertexOutput and tbnOf() without including chunks/modelVarying.wgsl: whichever vertex chunk the
// program included already brought them in, and a second definition is a compile error.

/** Mip of the environment cube taken at full roughness. Declared here rather than in a shared chunk
 *  because the include resolver has no include-once guard and a duplicate `const` is a compile error. */
const MAX_REFLECTION_LOD: f32 = 4.0;

// Samplers are separate globals named `u_material_<field>`, not members of the material struct: WGSL
// has no opaque types in a struct, and no legal identifier generates a dotted GLSL name.
@group(0) @binding(0) var u_material_baseColorTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_baseColorTexture_sampler: sampler;
@group(0) @binding(2) var u_material_ormTexture_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_ormTexture_sampler: sampler;
@group(0) @binding(4) var u_material_normalMap_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_normalMap_sampler: sampler;
@group(0) @binding(6) var u_material_emissiveMap_texture: texture_2d<f32>;
@group(0) @binding(7) var u_material_emissiveMap_sampler: sampler;
@group(0) @binding(8) var u_envMap_texture: texture_cube<f32>;
@group(0) @binding(9) var u_envMap_sampler: sampler;
@group(0) @binding(10) var u_material_displacementMap_texture: texture_2d<f32>;
@group(0) @binding(11) var u_material_displacementMap_sampler: sampler;
@group(0) @binding(12) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(13) var u_material_maskMap_sampler: sampler;

struct PBRMaterial {
    baseColor: vec3<f32>,       // fallback if no baseColorTexture
    emissiveFactor: vec3<f32>,
    /** HDR headroom for the emissive colour, default 1. See chunks/pbrGBuffer.wgsl for why. */
    emissiveIntensity: f32,
    metallic: f32,              // fallback if the ORM texture has no metallic channel
    roughness: f32,
    /** Dielectric specular level, 0..1 -> F0 via `dielectricF0`. Must match the G-buffer twin. */
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
    /** Thin-surface diffuse transmission, 0..1. See the same member in chunks/pbrGBuffer.wgsl. */
    translucency: f32,
    // Every flag is an i32: WGSL forbids bool in a uniform buffer. Call sites still pass booleans.
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
     * The camera's view-projection (GL convention, unjittered), for the parallax hit's PIXEL DEPTH
     * OFFSET — see `parallaxDepth`. Per-frame camera state riding in the material block for the same
     * reason `viewPos` does; written beside it in `Renderer._applyMaterialProperties`.
     */
    viewProj: mat4x4<f32>,
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

struct ForwardLighting {
    u_view: mat4x4<f32>,        // only to get the view-space depth that selects a cascade
    u_dirLight: DirectionalLight,
    u_skyLight: SkyLight,
    u_viewPos: vec3<f32>,
    /** Scene-wide indirect fill, in internal radiance units. Replaces the per-light ambient. */
    u_sceneAmbient: vec3<f32>,
    u_useEnvMap: i32,
    u_envMapLinear: i32,        // env cube is linear HDR (a light probe) -> skip the sRGB decode
    /** 0 restores the pre-phase-4 behaviour of occluding both lobes by the same hemisphere term. */
    u_specularOcclusion: i32,
    /** 0 lets a normal-mapped surface keep reflecting the sky along rays that point into itself. */
    u_horizonOcclusion: i32,
    u_isTransparent: i32,       // set by the renderer from material.config.transparent
};
@group(1) @binding(3) var<uniform> u_lighting: ForwardLighting;

/** The shading normal, flipped for a BACK face — see chunks/pbrGBuffer.wgsl. */
fn getNormal(in: VertexOutput, front: bool, su: SurfaceUv, uv: vec2<f32>) -> vec3<f32> {
    let ddx = su.dx0;
    let ddy = su.dy0;
    // The ORIGINAL tbn, not the parallax frame - this is a normal-map decode, and its bitangent sign
    // is the engine-wide green-channel convention. See chunks/parallax.wgsl.
    let tbn = tbnOf(in);
    var N = tbn[2];
    if (u_material.hasNormalMap != 0) {
        // Explicit gradients from the UN-offset uv; see the twin in chunks/pbrGBuffer.wgsl.
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

#if CLEO_POM
/**
 * The `pom` variants' output: the colour, and the parallax hit's depth (see parallaxDepth). Only
 * those variants write frag_depth, because writing it costs early-Z for the whole draw.
 */
struct PomForwardOut {
    // NOT `color`: naga's GLSL backend names the fragment output after this member, and the stage
    // already has a local `color` (vec3) — the two collide and WebGL2 rejects the program.
    @location(0) pomColor: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};
#endif

@fragment
// See chunks/pbrGBuffer.wgsl for why this is a separate parameter and not a VertexOutput member.
#if CLEO_POM
fn fs_main(in: VertexOutput, @builtin(front_facing) front: bool) -> PomForwardOut {
#else
fn fs_main(in: VertexOutput, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
#endif
    // The shadow library reads the fragment coordinate through a module-scope global, because only an
    // entry point receives @builtin(position). Publish it before calling in.
    cleoFragCoord = in.position.xy;
    // A despawn dissolve (and, on instanced draws, the foliage LOD crossfade): see chunks/modelVarying.
    if (!lodFadeKeeps(in.lodFade, in.position.xy)) { discard; }

    let fragPos = in.fragPos;

    // Gradients and the parallax frame, in UNIFORM control flow - above the discard and every
    // per-fragment branch below. See the twin in chunks/pbrGBuffer.wgsl for why that matters.
    // The material's mapping (mesh uv / box / triplanar), with its gradients — taken here, in uniform
    // control flow. `ddx`/`ddy` are chart 0's, which is THE chart in mesh and box modes.
    let su = surfaceUvOf(in, materialUv());
    let ddx = su.dx0;
    let ddy = su.dy0;
    let toEye = normalize(u_lighting.u_viewPos - fragPos);
    let basis = parallaxFrame(fragPos, ddx, ddy, tbnOf(in), toEye);
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
        pomDepth = parallaxDepth(in.position.z, fragPos, toEye, hit.dist, u_material.viewProj);
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
        // The sun comes from the light list this pass already shades with, not from u_transform, so
        // the two can never disagree about where it is.
        let sunDir = u_lighting.u_dirLight.direction;
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

    // Base colour / albedo. Every fetch from here down reads the parallax-offset uv - all of them, or
    // the maps come apart.
    // The mask cutout, before the base-colour fetch: a discarded fragment writes no G-buffer at all.
    // Explicit gradients from the UN-offset uv, like every other fetch below.
    if (u_material.hasMaskMap != 0 && u_material.alphaCutoff > 0.0) {
        let mask = cutoutAlpha(sampleSurface(u_material_maskMap_texture, u_material_maskMap_sampler, su, uv).r,
                               su.dx0, su.dy0, textureDimensions(u_material_maskMap_texture, 0));
        if (mask < u_material.alphaCutoff) { discard; }
    }

    var albedo = u_material.baseColor;
    if (u_material.hasBaseColorTexture != 0) {
        let texel = sampleSurface(u_material_baseColorTexture_texture, u_material_baseColorTexture_sampler, su, uv);
        // See chunks/pbrGBuffer.wgsl — the same cutout, applied before the lighting work below.
        // Only when there is no mask texture — that one has already been tested above.
        if (u_material.hasMaskMap == 0 && u_material.alphaCutoff > 0.0
            && cutoutAlpha(texel.a, su.dx0, su.dy0, textureDimensions(u_material_baseColorTexture_texture, 0))
               < u_material.alphaCutoff) { discard; }
        albedo *= toLinear(texel.rgb);
    }

    // One fetch for all three surface scalars. This used to be two — a metallic/roughness sample and an
    // occlusion sample further down — on textures that are now the same texture.
    var metallic = u_material.metallic;
    var roughness = u_material.roughness;
    var ao = 1.0;
    if (u_material.hasMetallicMap != 0 || u_material.hasRoughnessMap != 0 || u_material.hasOcclusionMap != 0) {
        let orm = sampleSurface(u_material_ormTexture_texture, u_material_ormTexture_sampler, su, uv).rgb;
        if (u_material.hasOcclusionMap != 0) { ao = orm.r; }
        if (u_material.hasRoughnessMap != 0) { roughness = orm.g; }
        if (u_material.hasMetallicMap != 0) { metallic = orm.b; }
    }

    let N = getNormal(in, front, su, uv);
    // Inline, where the deferred twin bakes it into the G-buffer instead. Same filter, same constants,
    // so a surface still shades identically down both paths.
    roughness = filterSpecularRoughness(roughness, N, u_material.specularAA);
    let V = normalize(u_lighting.u_viewPos - fragPos);

    // Ambient (IBL approximation), kept SPLIT: the two lobes are occluded differently. See
    // `computeSpecularAO` in chunks/pbrLighting.wgsl.
    // Read from the material directly, where the deferred twin reads it out of the G-buffer's freed
    // blue channel. Same remapping, same result.
    let F0 = mix(vec3<f32>(dielectricF0(u_material.reflectance)), albedo, metallic);
    let NoV = max(dot(N, V), 0.0);

    // Scene-wide indirect fill. This was the DIRECTIONAL light's own `ambient`, which every path added
    // to every pixel whether or not that light reached it — per-light in name, scene-wide in behaviour.
    // Translucency: the front keeps `1 - t` of the diffuse and the rest leaves the unlit side (see
    // thinTransmission). Only the DIFFUSE uses the scaled albedo; F0 above already took the real one.
    let translucency = saturate(u_material.translucency);
    let surfaceAlbedo = albedo;
    let frontAlbedo = albedo * (1.0 - translucency);
    var ambientDiffuse = (u_lighting.u_sceneAmbient
                          + skyIrradiance(u_lighting.u_skyLight, N)) * frontAlbedo;
    if (translucency > 0.0) {
        ambientDiffuse += (u_lighting.u_sceneAmbient + skyIrradiance(u_lighting.u_skyLight, -N))
                        * surfaceAlbedo * translucency;
    }
    var ambientSpecular = vec3<f32>(0.0);
    if (u_lighting.u_useEnvMap != 0) {
        let R = reflect(normalize(fragPos - u_lighting.u_viewPos), N);
        let envC = textureSampleLevel(u_envMap_texture, u_envMap_sampler, R,
                                      roughness * MAX_REFLECTION_LOD).rgb;
        var env = toLinear(envC);
        if (u_lighting.u_envMapLinear != 0) { env = envC; }
        // The DFG pair is the ENERGY, replacing the `kS` Fresnel this used to use. The roughness ramp
        // covers what the mip chain cannot: `generateMipmap` box-filters each face on its own, which is
        // not a GGX prefilter and does not cross face seams on WebGL2. Identical to deferredLighting,
        // deliberately — see the longer note there.
        let dfg = EnvBRDFApprox(NoV, roughness);
        let sharpnessFade = pow(1.0 - roughness, 4.0);
        ambientSpecular = env * (F0 * dfg.x + dfg.y)
                        * energyCompensation(F0, NoV, roughness) * sharpnessFade;
    }

    var Lo = vec3<f32>(0.0);

    // Two occlusion terms, and they are different things: the cascade map is what the rest of the
    // scene casts onto this fragment; `selfShadow` is the height field occluding itself, which the
    // cascade map is far too coarse to resolve. Both attenuate the SUN's radiance, which is where a
    // self-shadow belongs. The deferred twin cannot do this — it has no light list — and folds
    // selfShadow into albedo instead; see chunks/pbrGBuffer.wgsl.
    let viewDepth = -(u_lighting.u_view * vec4<f32>(fragPos, 1.0)).z;
    let sunShadowN = select(N, -N, translucency > 0.0 && dot(N, -u_lighting.u_dirLight.direction) < 0.0);
    let sunVisibility = (1.0 - directionalShadow(fragPos, sunShadowN, viewDepth)) * selfShadow;
    Lo += evaluateDirectionalLight(u_lighting.u_dirLight, N, V, frontAlbedo, metallic, roughness, sunVisibility);
    if (translucency > 0.0) {
        Lo += evaluateDirectionalTransmission(u_lighting.u_dirLight, N, V, surfaceAlbedo, translucency,
                                              sunVisibility);
    }

    // Every punctual light that reaches THIS fragment, and no others. The two loops this replaced ran
    // over fixed 16- and 8-element arrays for every fragment in the scene, including lights whose own
    // falloff guarantees they contribute nothing here.
    let cluster = cleoClusterOf(cleoFragCoord, viewDepth);
    let first = cleoClusterOffset(cluster);
    let count = cleoClusterCount(cluster);
    for (var i = 0; i < count; i++) {
        let cl = cleoLight(cleoClusterLight(first + i));
        if (cleoLightReaches(cl.light, fragPos)) {
            let shadowN = select(N, -N, translucency > 0.0 && dot(N, cl.light.position - fragPos) < 0.0);
            let visibility = cleoPunctualVisibility(cl.spotShadowLayer, cl.pointShadowSlot,
                                                    fragPos, shadowN, cl.light.position);
            Lo += evaluateSpotLight(cl.light, fragPos, N, V, frontAlbedo, metallic, roughness, visibility);
            if (translucency > 0.0) {
                Lo += evaluateSpotTransmission(cl.light, fragPos, N, V, surfaceAlbedo, translucency, visibility);
            }
        }
    }

    // Occlusion came out of the ORM fetch above, and the two indirect lobes take DIFFERENT amounts of
    // it: a hemisphere-wide AO term is right for diffuse and wrong for a narrow specular cone.
    // No SSAO here — that is a deferred-only screen-space pass — so `ao` is the material map alone.
    var specularAO = ao;
    if (u_lighting.u_specularOcclusion != 0) {
        specularAO = computeSpecularAO(NoV, ao, roughness);
    }
    // Horizon occlusion, on the same factor as its deferred twin. THE GEOMETRIC NORMAL IS FREE HERE —
    // `tbnOf(in)[2]` is the interpolated vertex normal, before the normal map touched it, which is
    // precisely what the deferred pass has to rebuild from depth because the G-buffer never carried it.
    // The two paths therefore agree in intent but not bit-for-bit: this one is the smooth interpolated
    // normal, that one the faceted surface. See DIRECT_LIGHTING_ROADMAP.md.
    //
    // Flipped by `front` exactly as `getNormal` flips the shading normal. A double-sided leaf shows its
    // back face with the interpolated normal pointing away, and an unflipped Ng would put every
    // reflection on the far side of it below the horizon — erasing the specular on half the foliage.
    if (u_lighting.u_horizonOcclusion != 0) {
        var Ng = normalize(tbnOf(in)[2]);
        if (!front) { Ng = -Ng; }
        specularAO *= horizonOcclusion(reflect(-V, N), Ng);
    }
    var color = ambientDiffuse * ao + ambientSpecular * specularAO + Lo;

    // Emission (sRGB-decoded map). Output stays LINEAR HDR — tonemap and gamma happen at the present.
    if (u_material.hasEmissiveMap != 0) {
        color += toLinear(sampleSurface(u_material_emissiveMap_texture, u_material_emissiveMap_sampler, su, uv).rgb)
                 * u_material.emissiveFactor * u_material.emissiveIntensity;
    } else {
        color += u_material.emissiveFactor * u_material.emissiveIntensity;
    }

    var alpha = 1.0;
    if (u_lighting.u_isTransparent != 0) { alpha = u_material.opacity; }
#if CLEO_POM
    return PomForwardOut(vec4<f32>(color, alpha), pomDepth);
#else
    return vec4<f32>(color, alpha);
#endif
}
