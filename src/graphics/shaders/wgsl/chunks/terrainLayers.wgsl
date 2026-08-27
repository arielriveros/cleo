// The terrain layer stack: four tiled PBR layers blended by an RGBA splat map.
//
// Shared by the deferred pass (geometryTerrain) and the forward one (terrainForward). Those two carried
// verbatim copies of all of this — nine sampler declarations, ~50 uniforms, `band`, `addLayer` and the
// whole blend — differing only in what they did with the result. That is exactly the duplication this
// migration exists to remove: one of the two was always going to get a fix the other did not.
//
// A consumer includes this, calls `resolveTerrainSurface()`, and shades however it likes.
//
// `u_normalN` is a PACKED texture built by systems/texturePacker.ts: rgb = tangent-space normal,
// a = displacement height in 0..1. A layer with a height map but no normal map still binds one here,
// with a flat normal in rgb. Folding height into the normal's unused alpha is what took terrain from
// 13 bound texture units down to 9 — and it is also why parallax occlusion mapping costs this shader
// no extra sampler and no extra bind: the height field was already in hand.
//
// The parallax itself is the second half of this file, and the shared machinery it runs on lives in
// chunks/parallax.wgsl.

@group(0) @binding(0)  var u_splat_texture: texture_2d<f32>;
@group(0) @binding(1)  var u_splat_sampler: sampler;
@group(0) @binding(2)  var u_albedo0_texture: texture_2d<f32>;
@group(0) @binding(3)  var u_albedo0_sampler: sampler;
@group(0) @binding(4)  var u_albedo1_texture: texture_2d<f32>;
@group(0) @binding(5)  var u_albedo1_sampler: sampler;
@group(0) @binding(6)  var u_albedo2_texture: texture_2d<f32>;
@group(0) @binding(7)  var u_albedo2_sampler: sampler;
@group(0) @binding(8)  var u_albedo3_texture: texture_2d<f32>;
@group(0) @binding(9)  var u_albedo3_sampler: sampler;
@group(0) @binding(10) var u_normal0_texture: texture_2d<f32>;
@group(0) @binding(11) var u_normal0_sampler: sampler;
@group(0) @binding(12) var u_normal1_texture: texture_2d<f32>;
@group(0) @binding(13) var u_normal1_sampler: sampler;
@group(0) @binding(14) var u_normal2_texture: texture_2d<f32>;
@group(0) @binding(15) var u_normal2_sampler: sampler;
@group(0) @binding(16) var u_normal3_texture: texture_2d<f32>;
@group(0) @binding(17) var u_normal3_sampler: sampler;

// Every scalar name here ends in a layer index, which is exactly the shape naga escapes: it emits
// `u_tiling0` as `u_tiling0_`. `UniformBlockSet` un-mangles the trailing underscore, and it has to —
// without that, all forty of these resolve to nothing and terrain renders with a zeroed layout.
struct TerrainUniforms {
    u_baseColor: vec3<f32>,
    u_viewPos: vec3<f32>,          // camera world position: parallax view vector, and specular V
    /**
     * The sun's world direction, for parallax self-shadowing. Zero means "no directional light".
     *
     * Here rather than in the transform block, and that placement is load-bearing: a uniform block
     * read from BOTH stages is emitted by naga as two stage-suffixed blocks with no instance name,
     * and the engine's reflection then cannot tell which `u_transform` a write by name refers to
     * ("Ambiguous field 'u_transform' in blocks ... which don't have instance names"). Every group-1
     * block stays single-stage. This one is fragment-only, so the sun belongs in it.
     */
    u_sunDirection: vec3<f32>,
    u_color0: vec3<f32>,
    u_color1: vec3<f32>,
    u_color2: vec3<f32>,
    u_color3: vec3<f32>,
    // A world-Y band per layer, for the automatic height mask.
    u_hRange0: vec2<f32>,
    u_hRange1: vec2<f32>,
    u_hRange2: vec2<f32>,
    u_hRange3: vec2<f32>,
    // A slope band per layer, where slope = 1 - N.y (0 flat .. 1 vertical).
    u_sRange0: vec2<f32>,
    u_sRange1: vec2<f32>,
    u_sRange2: vec2<f32>,
    u_sRange3: vec2<f32>,
    u_metallic0: f32,
    u_metallic1: f32,
    u_metallic2: f32,
    u_metallic3: f32,
    u_roughness0: f32,
    u_roughness1: f32,
    u_roughness2: f32,
    u_roughness3: f32,
    u_tiling0: f32,
    u_tiling1: f32,
    u_tiling2: f32,
    u_tiling3: f32,
    u_dispScale0: f32,
    u_dispScale1: f32,
    u_dispScale2: f32,
    u_dispScale3: f32,
    u_heightBlend0: f32,
    u_heightBlend1: f32,
    u_heightBlend2: f32,
    u_heightBlend3: f32,
    // Every flag is an i32: WGSL forbids bool in a uniform buffer. Call sites still pass booleans.
    u_layerCount: i32,
    u_useAuto: i32,
    u_hasAlbedo0: i32,
    u_hasAlbedo1: i32,
    u_hasAlbedo2: i32,
    u_hasAlbedo3: i32,
    u_hasNormal0: i32,
    u_hasNormal1: i32,
    u_hasNormal2: i32,
    u_hasNormal3: i32,
    u_hasDisp0: i32,
    u_hasDisp1: i32,
    u_hasDisp2: i32,
    u_hasDisp3: i32,
    u_auto0: i32,
    u_auto1: i32,
    u_auto2: i32,
    u_auto3: i32,
};
@group(1) @binding(1) var<uniform> u_terrain: TerrainUniforms;

/** One layer's weighted contribution, before the divide by the total weight. */
struct LayerAccum {
    albedo: vec3<f32>,
    metallic: f32,
    roughness: f32,
    normal: vec3<f32>,
};

/** What the layer stack resolves to at one fragment, before any lighting. */
struct TerrainSurface {
    albedo: vec3<f32>,
    metallic: f32,
    roughness: f32,
    normal: vec3<f32>,
    /**
     * Height-field self-shadowing of the SUN, 1 lit to 0 fully occluded.
     *
     * Returned rather than applied, because the two consumers have to spend it differently. The
     * forward pass has the light list and multiplies it into the directional term, where it belongs.
     * The deferred pass has no light at all — it writes a G-buffer — and the G-buffer has no spare
     * channel to carry it into the lighting pass, so geometryTerrain folds it into albedo instead.
     * See the note there for what that approximation costs.
     */
    shadow: f32,
};

fn band(range: vec2<f32>, v: f32, edge: f32) -> f32 {
    let lo = smoothstep(range.x - edge, range.x + edge, v);
    let hi = 1.0 - smoothstep(range.y - edge, range.y + edge, v);
    return clamp(lo * hi, 0.0, 1.0);
}

// -------------------------------------------------------------------------------------------------
// Parallax occlusion mapping over the layer stack.
//
// ONE ray, marched through ONE height field: the splat-weighted blend of the four layers' packed
// heights, in BASE uv space. What this replaced offset each layer independently by a single tap —
// `uv -= V.xy * h * scale` — which had four separate problems, all of them visible:
//
//   * The V axis was mirrored. `tbn[1]` is not dP/dv (see parallaxFrame in chunks/parallax.wgsl), so
//     U shifted one way and V the other: a sheared, wrong-way relief.
//   * One tap cannot occlude. The surface smeared instead of hiding behind itself.
//   * `h` was used raw, with no `1 - h`, so the reference plane was the BOTTOM of the field and the
//     whole surface slid sideways rather than recessing into the geometry.
//   * Four independent offsets cannot stay registered — against each other, or against the splat
//     mask and the height-aware bias, which were both still read at the UN-offset uv.
//
// The last one is why this is a single shared ray rather than four. The worst case costs the same
// (four fetches per step against four one-fetch marches), the common case costs the same (both
// collapse through the same zero-weight skip), and one refinement is done instead of four — but only
// the shared ray describes what is actually there, which is one surface, not four stacked at the
// same place.
//
// `u_dispScale_i` is authored in a layer's TILED uv while the ray travels in BASE uv, so the
// conversion is `dispScale_i / tiling_i`. An authored value therefore keeps exactly the apparent
// depth it always described.
//
// Every fetch below is `textureSampleGrad`, gradients captured once at the top of
// resolveTerrainSurface. That is forced — WGSL allows implicit derivatives only in uniform control
// flow, and a march is not — but it also UNLOCKS the rest of this file. With no implicit derivative
// left anywhere, a zero-weight layer can be skipped, and the unpainted-terrain fallback can finally
// be a real early return instead of four calls whose results are multiplied by zero. See the note
// that used to sit on that branch.
// -------------------------------------------------------------------------------------------------

/** A layer contributing less than this is not sampled at all. */
const LAYER_MIN_W: f32 = 1e-3;

/** Where the view ray met the blended height field, and each layer's height there. */
struct ParallaxHit {
    uv: vec2<f32>,     // BASE-space uv; each layer re-tiles it
    h: vec4<f32>,      // per-layer height AT the hit, for the height-aware blend
};

/**
 * Each layer's packed height at one BASE-space uv; zero for a layer with no map or no weight.
 *
 * Returned as a vec4 rather than blended in place because the caller needs it both ways: dotted
 * against the weights to get the surface the ray intersects, and kept per layer for the
 * height-aware blend.
 *
 * `ddx * t` is the exact derivative of `baseUv * t` — the tiled uv is linear in screen space — so a
 * layer with no displacement resolves bit-identically to the `textureSample` this replaced.
 */
fn layerHeights(baseUv: vec2<f32>, w: vec4<f32>, ddx: vec2<f32>, ddy: vec2<f32>) -> vec4<f32> {
    var h = vec4<f32>(0.0);
    if (u_terrain.u_hasDisp0 == 1 && w.x > LAYER_MIN_W) {
        let t = u_terrain.u_tiling0;
        h.x = textureSampleGrad(u_normal0_texture, u_normal0_sampler, baseUv * t, ddx * t, ddy * t).a;
    }
    if (u_terrain.u_hasDisp1 == 1 && w.y > LAYER_MIN_W) {
        let t = u_terrain.u_tiling1;
        h.y = textureSampleGrad(u_normal1_texture, u_normal1_sampler, baseUv * t, ddx * t, ddy * t).a;
    }
    if (u_terrain.u_hasDisp2 == 1 && w.z > LAYER_MIN_W) {
        let t = u_terrain.u_tiling2;
        h.z = textureSampleGrad(u_normal2_texture, u_normal2_sampler, baseUv * t, ddx * t, ddy * t).a;
    }
    if (u_terrain.u_hasDisp3 == 1 && w.w > LAYER_MIN_W) {
        let t = u_terrain.u_tiling3;
        h.w = textureSampleGrad(u_normal3_texture, u_normal3_sampler, baseUv * t, ddx * t, ddy * t).a;
    }
    return h;
}

/** The blended field's depth, in BASE uv. Zero when nothing weighted carries a height map. */
fn blendedDepth(wN: vec4<f32>) -> f32 {
    var d = 0.0;
    if (u_terrain.u_hasDisp0 == 1) { d += wN.x * u_terrain.u_dispScale0 / max(u_terrain.u_tiling0, 1e-4); }
    if (u_terrain.u_hasDisp1 == 1) { d += wN.y * u_terrain.u_dispScale1 / max(u_terrain.u_tiling1, 1e-4); }
    if (u_terrain.u_hasDisp2 == 1) { d += wN.z * u_terrain.u_dispScale2 / max(u_terrain.u_tiling2, 1e-4); }
    if (u_terrain.u_hasDisp3 == 1) { d += wN.w * u_terrain.u_dispScale3 / max(u_terrain.u_tiling3, 1e-4); }
    return d;
}

/**
 * March the view ray into the blended height field.
 *
 * `wN` is the NORMALISED weight set and is held FIXED for the whole march. The ray needs a static
 * scalar field to intersect; re-deriving the weights per step would be chasing a surface that moves
 * as the ray does, and it would not converge.
 */
fn marchTerrain(baseUv: vec2<f32>, wN: vec4<f32>, vTan: vec3<f32>,
                ddx: vec2<f32>, ddy: vec2<f32>, fade: f32) -> ParallaxHit {
    var hit: ParallaxHit;
    hit.uv = baseUv;

    let depth = blendedDepth(wN) * fade * parallaxGrazeFade(vTan.z);

    // Nothing displaced, or minified past the fade, or too edge-on for a flat-surface approximation. The heights are still wanted either way: the
    // height-aware blend reads them whether or not anything was offset.
    if (depth <= 1e-7) {
        hit.h = layerHeights(baseUv, wN, ddx, ddy);
        return hit;
    }

    let pMax = parallaxRay(vTan, depth);
    let steps = parallaxSteps(vTan.z, fade);
    let dStep = 1.0 / steps;

    // `1.0 - h`: the packed alpha is 1 at the TOP of the field, so this is depth below the geometric
    // surface. `ray` walks the same axis, 0 at the surface down to 1 at the floor.
    var ray = 0.0;
    var uv = baseUv;
    var hs = layerHeights(uv, wN, ddx, ddy);
    var surf = 1.0 - dot(hs, wN);
    var prevUv = uv;
    var prevRay = ray;
    var prevSurf = surf;

    for (var i = 0; i < POM_MAX_STEPS; i++) {
        if (f32(i) >= steps || ray >= surf) { break; }
        prevUv = uv;
        prevRay = ray;
        prevSurf = surf;
        ray += dStep;
        // Recomputed from `ray` rather than subtracted step by step: a base-uv offset here runs to a
        // few thousandths, and repeatedly accumulating an increment that small is worse conditioned.
        uv = baseUv - pMax * ray;
        hs = layerHeights(uv, wN, ddx, ddy);
        surf = 1.0 - dot(hs, wN);
    }

    // One secant refinement across the crossing. See the twin in chunks/parallax.wgsl for why the
    // guard is `min(denom, -1e-8)` and not `max(denom, 1e-5)`: `denom` is strictly negative on every
    // exit path, a positive floor on it pinned `t` to zero, and the refinement was dead code.
    //
    // Terrain paid for that twice over. The quantised hit feeds `exp(u_heightBlend * hit.h)` below,
    // which turns a sub-pixel UV staircase into hard layer-identity flips, and it feeds
    // `terrainSelfShadow`, where `(1 - h)` scales both the shadow ray's rise and its reach — so a hit
    // one step deep changed the entire shadow geometry, not just where it started.
    let after = surf - ray;
    let before = prevSurf - prevRay;
    let t = clamp(after / min(after - before, -1e-8), 0.0, 1.0);
    hit.uv = mix(uv, prevUv, t);
    hit.h = layerHeights(hit.uv, wN, ddx, ddy);
    return hit;
}

/** Soft self-shadowing of the blended field, marched from the hit toward the sun. See parallaxShadow. */
fn terrainSelfShadow(uv: vec2<f32>, wN: vec4<f32>, lTan: vec3<f32>,
                     ddx: vec2<f32>, ddy: vec2<f32>, h: f32, fade: f32) -> f32 {
    let depth = blendedDepth(wN) * fade * parallaxGrazeFade(lTan.z);
    if (depth <= 1e-7 || lTan.z <= 0.0) { return 1.0; }

    let pMax = parallaxRay(lTan, depth);
    let steps = f32(POM_SHADOW_STEPS);
    let dh = (1.0 - h) / steps;
    // `pMax` is the displacement for a FULL 0->1 traverse of the field, but this ray only climbs the
    // (1 - h) that is left above the hit. Scaling the horizontal travel by that same fraction is what
    // keeps the ray's slope equal to the light's: without it a deep hit (small h) marched the full
    // width while rising only part of the height, sampling texels far from the blocker it was meant
    // to test. That reads as noise, and it is the kind of noise two backends disagree about loudly.
    let reach = pMax * (1.0 - h);

    var occ = 0.0;
    for (var i = 1; i <= POM_SHADOW_STEPS; i++) {
        let f = f32(i) / steps;
        let sampleH = dot(layerHeights(uv + reach * f, wN, ddx, ddy), wN);
        let rayH = h + dh * f32(i);
        if (sampleH > rayH) {
            // Nearer blockers weigh more; the falloff keeps this soft rather than binary.
            occ = max(occ, (sampleH - rayH) * (1.0 - f));
        }
    }
    return clamp(1.0 - occ, 0.0, 1.0);
}

/**
 * One layer's weighted PBR contribution at the parallax-offset, tiled uv.
 *
 * Gradients come from the UN-offset uv, and that is deliberate twice over. The offset uv is
 * discontinuous wherever the ray crosses a cliff in the height field, so its own derivatives would
 * pick a wildly wrong mip along every such seam. And an explicit gradient carries no uniformity
 * requirement, which is what lets this return early on a zero weight — on a four-layer splat the
 * common fragment has two layers contributing and two not, so that halves the fetches.
 */
fn addLayer(w: f32, uv: vec2<f32>, ddx: vec2<f32>, ddy: vec2<f32>,
            albedoTex: texture_2d<f32>, albedoSmp: sampler, hasAlbedo: i32, color: vec3<f32>,
            normalTex: texture_2d<f32>, normalSmp: sampler, hasNormal: i32,
            metallic: f32, roughness: f32, tbn: mat3x3<f32>) -> LayerAccum {
    var out: LayerAccum;
    out.albedo = vec3<f32>(0.0);
    out.metallic = 0.0;
    out.roughness = 0.0;
    out.normal = vec3<f32>(0.0);
    if (w <= LAYER_MIN_W) { return out; }

    var alb = toLinear(color);   // sRGB layer tint -> linear
    if (hasAlbedo == 1) { alb *= toLinear(textureSampleGrad(albedoTex, albedoSmp, uv, ddx, ddy).rgb); }

    // The ORIGINAL tbn, not the parallax frame: this is a normal-map decode, and its bitangent sign
    // is the engine-wide green-channel convention. See parallaxFrame for why the two differ.
    var nrm = tbn[2];
    if (hasNormal == 1) {
        let tn = textureSampleGrad(normalTex, normalSmp, uv, ddx, ddy).rgb * 2.0 - 1.0;
        nrm = normalize(tbn * tn);
    }

    out.albedo = w * alb;
    out.metallic = w * metallic;
    out.roughness = w * roughness;
    out.normal = w * nrm;
    return out;
}

/**
 * Blend the four layers at this fragment: splat weights, optional height/slope auto-masking, one
 * shared parallax march, height-aware bias, then a weighted average.
 *
 * Falls back to the flat base colour when every weight is ~0 — an unpainted terrain. Without that the
 * normalise below would divide by zero and the whole surface would come out NaN.
 *
 * `sunDir` is the direction the sun travels (the renderer's `u_dirLight.direction` convention), used
 * only for the self-shadow march. A zero vector switches self-shadowing off, which is what a scene
 * with no directional light passes.
 */
fn resolveTerrainSurface(fragPos: vec3<f32>, baseUv: vec2<f32>, tbn: mat3x3<f32>,
                         sunDir: vec3<f32>) -> TerrainSurface {
    // Screen-space derivatives of the UN-offset uv, taken HERE and nowhere else.
    //
    // `dpdx`/`dpdy` carry the same uniformity rule `textureSample` does: WGSL permits them only in
    // uniform control flow. This is the last point in the function where control flow is uniform —
    // everything below it (the march, the per-weight skips, the unpainted early return) is
    // per-fragment. Captured once here, every fetch downstream is an explicit-gradient one, and the
    // rule stops constraining the shape of the code.
    let ddxUv = dpdx(baseUv);
    let ddyUv = dpdy(baseUv);

    let nGeom = normalize(tbn[2]);
    let height = fragPos.y;
    let slope = clamp(1.0 - nGeom.y, 0.0, 1.0);

    // The parallax frame is built HERE, above the unpainted early return, for the same reason the
    // gradients are: it takes dpdx/dpdy of fragPos internally, and a derivative below a per-fragment
    // branch is non-uniform control flow. naga waves that through; Dawn rejects the module, which
    // would take the pipeline, its bind groups and the entire terrain pass with it. Building it on
    // the fallback path too costs two cross products on fragments that then skip the march anyway.
    let toEye = normalize(u_terrain.u_viewPos - fragPos);
    let frame = parallaxFrame(fragPos, ddxUv, ddyUv, nGeom, toEye);
    let vTan = parallaxToTangent(frame, toEye);

    var w = textureSampleGrad(u_splat_texture, u_splat_sampler, baseUv, ddxUv, ddyUv);

    if (u_terrain.u_layerCount < 1) { w.x = 0.0; }
    if (u_terrain.u_layerCount < 2) { w.y = 0.0; }
    if (u_terrain.u_layerCount < 3) { w.z = 0.0; }
    if (u_terrain.u_layerCount < 4) { w.w = 0.0; }

    if (u_terrain.u_useAuto == 1) {
        if (u_terrain.u_auto0 == 1) { w.x *= band(u_terrain.u_hRange0, height, 2.0) * band(u_terrain.u_sRange0, slope, 0.08); }
        if (u_terrain.u_auto1 == 1) { w.y *= band(u_terrain.u_hRange1, height, 2.0) * band(u_terrain.u_sRange1, slope, 0.08); }
        if (u_terrain.u_auto2 == 1) { w.z *= band(u_terrain.u_hRange2, height, 2.0) * band(u_terrain.u_sRange2, slope, 0.08); }
        if (u_terrain.u_auto3 == 1) { w.w *= band(u_terrain.u_hRange3, height, 2.0) * band(u_terrain.u_sRange3, slope, 0.08); }
    }

    var out: TerrainSurface;
    out.shadow = 1.0;

    // Unpainted terrain. This used to sit AFTER four addLayer calls whose results were multiplied by
    // zero, because a per-fragment return put every `textureSample` below it in non-uniform control
    // flow and WGSL rejected the module outright — "'textureSample' must only be called from uniform
    // control flow" — which invalidated the terrainForward pipeline and every bind group built from
    // its layout, so terrain drew nothing at all. With the gradients already captured and no implicit
    // derivative left downstream, the branch can go where it belongs. It now also skips the ray
    // march, which is the expensive part.
    let wSum = w.x + w.y + w.z + w.w;
    if (wSum < 1e-4) {
        out.albedo = toLinear(u_terrain.u_baseColor);
        out.metallic = 0.0;
        out.roughness = 0.9;
        out.normal = nGeom;
        return out;
    }
    let wN = w / wSum;

    // Fade by texture footprint. The tiling is blended the same way the depth is, so the footprint
    // reflects the layers actually painted here rather than whichever one happens to be slot 0; the
    // packed layer textures are all built by the same packer, so slot 0's dimensions stand for the
    // set. See parallaxFade for why this is a mip level and not a world distance.
    let tAvg = max(wN.x * u_terrain.u_tiling0 + wN.y * u_terrain.u_tiling1
                 + wN.z * u_terrain.u_tiling2 + wN.w * u_terrain.u_tiling3, 1e-4);
    let dims = vec2<f32>(textureDimensions(u_normal0_texture, 0));
    let fade = parallaxFade(ddxUv * tAvg, ddyUv * tAvg, dims);

    let hit = marchTerrain(baseUv, wN, vTan, ddxUv, ddyUv, fade);

    if (dot(sunDir, sunDir) > 1e-6) {
        let lTan = parallaxToTangent(frame, normalize(-sunDir));
        out.shadow = terrainSelfShadow(hit.uv, wN, lTan, ddxUv, ddyUv, dot(hit.h, wN), fade);
    }

    // Height-aware blend, biased by the heights AT THE HIT rather than under it — the whole point of
    // marching is that the surface here is not the surface directly below. With no displacement map
    // h is 0 and the factor is 1, i.e. the original linear blend.
    w.x *= exp(u_terrain.u_heightBlend0 * hit.h.x);
    w.y *= exp(u_terrain.u_heightBlend1 * hit.h.y);
    w.z *= exp(u_terrain.u_heightBlend2 * hit.h.z);
    w.w *= exp(u_terrain.u_heightBlend3 * hit.h.w);

    // Renormalise, THEN drop what `addLayer` is going to skip anyway, then sum.
    //
    // Two things this fixes. `addLayer` contributes nothing at or below LAYER_MIN_W, so a `sum` that
    // still counted that weight divided the blend by a total containing a zero term — a slight dim
    // with a step at the threshold. And LAYER_MIN_W was being applied to two different quantities:
    // `layerHeights` tests the normalised weight, `addLayer` tested this height-biased one, which
    // `exp()` has put on an unrelated scale. Normalising first makes the constant mean one thing.
    //
    // The renormalise is free in the output — it scales the accumulators and `sum` by the same factor
    // — but it is what makes the divide SAFE. Thresholding the un-normalised weights could zero all
    // four (the early return above only guarantees the raw weights sum to 1e-4, which is below the
    // threshold), leaving `sum == 0` and a NaN surface. Normalised, the largest is at least 0.25.
    let biased = w.x + w.y + w.z + w.w;
    w = w / biased;
    w = select(vec4<f32>(0.0), w, w > vec4<f32>(LAYER_MIN_W));
    let sum = w.x + w.y + w.z + w.w;

    let l0 = addLayer(w.x, hit.uv * u_terrain.u_tiling0, ddxUv * u_terrain.u_tiling0, ddyUv * u_terrain.u_tiling0,
                      u_albedo0_texture, u_albedo0_sampler, u_terrain.u_hasAlbedo0,
                      u_terrain.u_color0, u_normal0_texture, u_normal0_sampler,
                      u_terrain.u_hasNormal0, u_terrain.u_metallic0, u_terrain.u_roughness0, tbn);
    let l1 = addLayer(w.y, hit.uv * u_terrain.u_tiling1, ddxUv * u_terrain.u_tiling1, ddyUv * u_terrain.u_tiling1,
                      u_albedo1_texture, u_albedo1_sampler, u_terrain.u_hasAlbedo1,
                      u_terrain.u_color1, u_normal1_texture, u_normal1_sampler,
                      u_terrain.u_hasNormal1, u_terrain.u_metallic1, u_terrain.u_roughness1, tbn);
    let l2 = addLayer(w.z, hit.uv * u_terrain.u_tiling2, ddxUv * u_terrain.u_tiling2, ddyUv * u_terrain.u_tiling2,
                      u_albedo2_texture, u_albedo2_sampler, u_terrain.u_hasAlbedo2,
                      u_terrain.u_color2, u_normal2_texture, u_normal2_sampler,
                      u_terrain.u_hasNormal2, u_terrain.u_metallic2, u_terrain.u_roughness2, tbn);
    let l3 = addLayer(w.w, hit.uv * u_terrain.u_tiling3, ddxUv * u_terrain.u_tiling3, ddyUv * u_terrain.u_tiling3,
                      u_albedo3_texture, u_albedo3_sampler, u_terrain.u_hasAlbedo3,
                      u_terrain.u_color3, u_normal3_texture, u_normal3_sampler,
                      u_terrain.u_hasNormal3, u_terrain.u_metallic3, u_terrain.u_roughness3, tbn);

    out.albedo = (l0.albedo + l1.albedo + l2.albedo + l3.albedo) / sum;
    out.metallic = (l0.metallic + l1.metallic + l2.metallic + l3.metallic) / sum;
    out.roughness = (l0.roughness + l1.roughness + l2.roughness + l3.roughness) / sum;
    out.normal = normalize(l0.normal + l1.normal + l2.normal + l3.normal);
    return out;
}
