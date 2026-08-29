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
// a = layer height in 0..1. A layer with a height map but no normal map still binds one here, with a
// flat normal in rgb. Folding height into the normal's unused alpha is what took terrain from 13 bound
// texture units down to 9.
//
// The height drives TWO things, and terrain works the same way a standard PBR material does with a
// height map: a parallax occlusion march (chunks/parallax.wgsl, shared) and the height-aware blend,
// which biases a layer's splat weight by `exp(u_heightBlend_i * h_i)` so a rocky layer's high spots
// poke through the soil painted over them.
//
// The march was removed once, on the grounds that it was not doing what the feature was for, and is
// back because the request was for terrain to behave exactly as normal materials do here. It runs over
// ONE ray through the blended field rather than four independent ones — see the note above marchTerrain.

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
    /**
     * Camera world position — the specular V in terrainForward.
     *
     * Here rather than in the transform block, and that placement is load-bearing: a uniform block
     * read from BOTH stages is emitted by naga as two stage-suffixed blocks with no instance name,
     * and the engine's reflection then cannot tell which `u_transform` a write by name refers to
     * ("Ambiguous field 'u_transform' in blocks ... which don't have instance names"). Every group-1
     * block stays single-stage, and this one is fragment-only.
     */
    u_viewPos: vec3<f32>,
    /**
     * The sun's world direction, for the height-field self-shadow. Zero means "no directional light".
     *
     * In THIS block and not the transform one, deliberately: a uniform block read from both stages is
     * emitted by naga as two stage-suffixed blocks with no instance name, and the engine's by-name
     * reflection then cannot tell them apart ("Ambiguous field 'u_transform' in blocks ..."). Every
     * group-1 block stays single-stage, and this one is fragment-only.
     */
    u_sunDirection: vec3<f32>,
    /**
     * Geometric specular antialiasing, on or off. Renderer state rather than a layer property: it is
     * a rendering choice, not something an author paints, and terrain has one composite material for
     * all four layers anyway. Both terrain programs read it — see filterSpecularRoughness.
     */
    u_specularAA: i32,
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
    // Relief depth per layer, in WORLD METRES as authored. Read by the CPU/compute bake; the march
    // reads `u_marchDepth{i}` below, which is this converted and scaled to the part the march owns.
    u_dispScale0: f32,
    u_dispScale1: f32,
    u_dispScale2: f32,
    u_dispScale3: f32,
    // THE SPLIT. A terrain layer's height map is divided in two at `u_splitLod{i}`, the mip whose texel
    // covers one terrain vertex: everything at or below that frequency becomes real geometry, and
    // everything above it — which at landscape scale is nearly the whole map — is marched here.
    //
    // Before this, a displaced layer was simply removed from the march, so the fine half was computed,
    // discarded, and never drawn. A 200 m terrain at tiling 20 splits at mip 5.3, meaning the geometry
    // received a 26x26 reduction of a 1024 map and the rocks in it reached nothing.
    //
    // In the PACKED texture's mip space, not the raw map's: `TexturePacker` sizes a pack as the max of
    // its sources, so a 2048 normal beside a 1024 height would otherwise shift every level an octave.
    u_splitLod0: f32,
    u_splitLod1: f32,
    u_splitLod2: f32,
    u_splitLod3: f32,
    // The residual's range, `max(H_full - H_low) - min(...)`, and its floor. `layerHeights` normalises
    // the residual to 0..1 with these so the march has a field of the shape it requires.
    u_residRange0: f32,
    u_residRange1: f32,
    u_residRange2: f32,
    u_residRange3: f32,
    u_residBot0: f32,
    u_residBot1: f32,
    u_residBot2: f32,
    u_residBot3: f32,
    // The march's depth for this layer, in BASE uv: `dispScale * residRange / terrainSize`. Converted
    // on the CPU (`Terrain._writeMarchUniforms`) because every term is a per-layer constant, and doing
    // it there keeps the terrain's size out of this block entirely.
    u_marchDepth0: f32,
    u_marchDepth1: f32,
    u_marchDepth2: f32,
    u_marchDepth3: f32,
    // Sharpness of the height-aware blend. 0 is a plain linear splat blend.
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
    /** Occlusion rides in the ALBEDO pack's alpha, the way height rides in the normal's. */
    u_hasAO0: i32,
    u_hasAO1: i32,
    u_hasAO2: i32,
    u_hasAO3: i32,
    u_hasNormal0: i32,
    u_hasNormal1: i32,
    u_hasNormal2: i32,
    u_hasNormal3: i32,
    u_hasHeight0: i32,
    u_hasHeight1: i32,
    u_hasHeight2: i32,
    u_hasHeight3: i32,
    // The source is a DEPTH map (white = deep) rather than the height map the engine authors. Same
    // control a standard material has; see parallaxHeight in chunks/parallax.wgsl.
    u_invertHeight0: i32,
    u_invertHeight1: i32,
    u_invertHeight2: i32,
    u_invertHeight3: i32,
    u_auto0: i32,
    u_auto1: i32,
    u_auto2: i32,
    u_auto3: i32,
};
@group(1) @binding(1) var<uniform> u_terrain: TerrainUniforms;

/** One layer's weighted contribution, before the divide by the total weight. */
struct LayerAccum {
    albedo: vec3<f32>,
    ao: f32,
    metallic: f32,
    roughness: f32,
    normal: vec3<f32>,
};

/** What the layer stack resolves to at one fragment, before any lighting. */
struct TerrainSurface {
    albedo: vec3<f32>,
    /**
     * Ambient occlusion, blended per layer from the ALBEDO pack's alpha.
     *
     * Terrain wrote a constant 1.0 here for as long as the G-buffer has had an AO channel, so a
     * hillside took full ambient everywhere while a rock resting on it got map-driven cavity
     * darkening. The two now answer the same question.
     */
    ao: f32,
    metallic: f32,
    roughness: f32,
    normal: vec3<f32>,
    /**
     * Height-field self-shadowing of the SUN, 1 lit to 0 fully occluded.
     *
     * Returned rather than applied, because the two consumers spend it differently. The forward pass
     * has the light list and multiplies it into the directional term, where it belongs. The deferred
     * pass writes a G-buffer with no spare channel to carry it, so geometryTerrain folds it into
     * albedo instead — see the note there for what that approximation costs.
     */
    shadow: f32,
};

fn band(range: vec2<f32>, v: f32, edge: f32) -> f32 {
    let lo = smoothstep(range.x - edge, range.x + edge, v);
    let hi = 1.0 - smoothstep(range.y - edge, range.y + edge, v);
    return clamp(lo * hi, 0.0, 1.0);
}

// NO IMPLICIT DERIVATIVE IS TAKEN BELOW THIS POINT. The layer surfaces are fetched with
// `textureSampleGrad` from gradients captured once at the top of `resolveTerrainSurface`; the height
// path is fetched with `textureSampleLevel` from a level derived by hand (`parallaxLod`). Both exist
// for the same reason: WGSL allows implicit derivatives only in uniform control flow, and the march
// below is not.
//
// That constraint UNLOCKS the rest of this file rather than merely costing something. With no implicit
// derivative left anywhere, a zero-weight layer can be skipped, and the unpainted-terrain fallback can
// be a real early return instead of four calls whose results are multiplied by zero. See the note on
// that branch for what it cost when a `textureSample` was still reachable below it.

/** A layer contributing less than this is not sampled at all. */
const LAYER_MIN_W: f32 = 1e-3;
/** Smallest usable tiling. Mirrors `TILING_EPSILON` in `systems/displacement.ts`. */
const TILING_EPSILON: f32 = 0.01;

/**
 * Each layer's packed height at one BASE-space uv; zero for a layer with no map or no weight.
 *
 * Returned per layer rather than blended in place: the height-aware blend needs each one against its
 * own `u_heightBlend_i`, and a pre-blended scalar has already thrown that away.
 *
 * `ddx * t` is the exact derivative of `baseUv * t` — the tiled uv is linear in screen space — so a
 * layer with no height map resolves bit-identically to the `textureSample` this replaced.
 */
fn layerHeights(baseUv: vec2<f32>, w: vec4<f32>, lod: f32) -> vec4<f32> {
    var h = vec4<f32>(0.0);
    if (u_terrain.u_hasHeight0 == 1 && w.x > LAYER_MIN_W) {
        let t = max(u_terrain.u_tiling0, TILING_EPSILON);
        // `max(.., 0.0)` for the same reason as `residualHeight`: the clamp belongs in the layer's own
        // space, after `log2(t)`, not in the base uv the level arrives in.
        let r = textureSampleLevel(u_normal0_texture, u_normal0_sampler, baseUv * t,
                                   max(lod + log2(t), 0.0)).a;
        h.x = select(r, 1.0 - r, u_terrain.u_invertHeight0 == 1);
    }
    if (u_terrain.u_hasHeight1 == 1 && w.y > LAYER_MIN_W) {
        let t = max(u_terrain.u_tiling1, TILING_EPSILON);
        let r = textureSampleLevel(u_normal1_texture, u_normal1_sampler, baseUv * t,
                                   max(lod + log2(t), 0.0)).a;
        h.y = select(r, 1.0 - r, u_terrain.u_invertHeight1 == 1);
    }
    if (u_terrain.u_hasHeight2 == 1 && w.z > LAYER_MIN_W) {
        let t = max(u_terrain.u_tiling2, TILING_EPSILON);
        let r = textureSampleLevel(u_normal2_texture, u_normal2_sampler, baseUv * t,
                                   max(lod + log2(t), 0.0)).a;
        h.z = select(r, 1.0 - r, u_terrain.u_invertHeight2 == 1);
    }
    if (u_terrain.u_hasHeight3 == 1 && w.w > LAYER_MIN_W) {
        let t = max(u_terrain.u_tiling3, TILING_EPSILON);
        let r = textureSampleLevel(u_normal3_texture, u_normal3_sampler, baseUv * t,
                                   max(lod + log2(t), 0.0)).a;
        h.w = select(r, 1.0 - r, u_terrain.u_invertHeight3 == 1);
    }
    return h;
}

/**
 * One layer's RESIDUAL height, normalised to 0..1 — the field the march actually intersects.
 *
 * `full - low` is what is left of the map once the band the terrain's vertices already carry is taken
 * out of it, and `(r - bot) / range` puts that on the 0..1 scale the march requires, 1 at the residual's
 * highest point. Paired with `u_marchDepth{i}` the two reconstruct the map exactly: the bake lifted its
 * surface by `amplitude * top`, and `(1 - hRes) * depth` carves back `amplitude * (top - r)`, so what is
 * drawn is `amplitude * (H_full - mean)` — the whole height map, split across the only two mechanisms
 * that can each carry their half.
 *
 * `max(l, split)` rather than `split`: where the fragment's own footprint is already coarser than the
 * split, the two samples coincide, the residual goes to zero and the march flattens out by itself —
 * which is the right answer at that distance and costs no branch to get.
 */
fn residualHeight(tex: texture_2d<f32>, samp: sampler, baseUv: vec2<f32>, lod: f32,
                  tiling: f32, split: f32, range: f32, bot: f32, invert: i32) -> f32 {
    let t = max(tiling, TILING_EPSILON);
    // CLAMPED AFTER THE SHIFT, never before. `lod` is a base-uv footprint and may be negative; adding
    // `log2(t)` is what puts it in THIS layer's space, and only there does "below mip 0" mean anything.
    // Flooring in base uv instead cost this march four of its five octaves — see `parallaxLodRaw`.
    let l = max(lod + log2(t), 0.0);
    let full = textureSampleLevel(tex, samp, baseUv * t, l).a;
    let low = textureSampleLevel(tex, samp, baseUv * t, max(l, split)).a;
    // Inverting both halves and subtracting is the same as negating the difference, so `invert` stays a
    // negated relief rather than a different offset — the property `_displacementAt` keeps as well.
    let r = select(full - low, low - full, invert == 1);
    return clamp((r - bot) / max(range, 1e-6), 0.0, 1.0);
}

/** The four residual heights, for the march. `layerHeights` stays the FULL field, for the blend. */
fn layerResiduals(baseUv: vec2<f32>, w: vec4<f32>, lod: f32) -> vec4<f32> {
    var h = vec4<f32>(0.0);
    if (u_terrain.u_hasHeight0 == 1 && w.x > LAYER_MIN_W) {
        h.x = residualHeight(u_normal0_texture, u_normal0_sampler, baseUv, lod, u_terrain.u_tiling0,
                             u_terrain.u_splitLod0, u_terrain.u_residRange0, u_terrain.u_residBot0,
                             u_terrain.u_invertHeight0);
    }
    if (u_terrain.u_hasHeight1 == 1 && w.y > LAYER_MIN_W) {
        h.y = residualHeight(u_normal1_texture, u_normal1_sampler, baseUv, lod, u_terrain.u_tiling1,
                             u_terrain.u_splitLod1, u_terrain.u_residRange1, u_terrain.u_residBot1,
                             u_terrain.u_invertHeight1);
    }
    if (u_terrain.u_hasHeight2 == 1 && w.z > LAYER_MIN_W) {
        h.z = residualHeight(u_normal2_texture, u_normal2_sampler, baseUv, lod, u_terrain.u_tiling2,
                             u_terrain.u_splitLod2, u_terrain.u_residRange2, u_terrain.u_residBot2,
                             u_terrain.u_invertHeight2);
    }
    if (u_terrain.u_hasHeight3 == 1 && w.w > LAYER_MIN_W) {
        h.w = residualHeight(u_normal3_texture, u_normal3_sampler, baseUv, lod, u_terrain.u_tiling3,
                             u_terrain.u_splitLod3, u_terrain.u_residRange3, u_terrain.u_residBot3,
                             u_terrain.u_invertHeight3);
    }
    return h;
}

/**
 * The surface the ray actually intersects, from a set of per-layer heights.
 *
 * Height-blended, not linearly averaged. `w_k * exp(heightBlend_k * h_k)` renormalised, so where two
 * layers overlap the one standing HIGHER takes the fragment instead of the two averaging into mud —
 * Drobot's height blend, which he measured at half the cost of an alpha blend for POM, because the
 * blended surface sits higher and the ray terminates sooner.
 *
 * At `heightBlend = 0` this is EXACTLY `dot(h, wN)`: `exp(0) = 1` leaves the weights untouched and `wN`
 * already sums to 1, so the normalise is a divide by one. That identity is what lets this ship without
 * changing a single existing terrain — the operator only bites where the slider was already raised, and
 * it is the same operator the shading blend after the hit has always used.
 *
 * The SPLAT weights stay frozen for the whole march; only the height-derived factor is re-evaluated per
 * sample. Re-deriving the splat would chase a surface that moves as the ray does and would not converge.
 * The height factor is not that — it is part of the definition of the surface, and Drobot's own shader
 * evaluates it per sample (`FinalH *= AlphaBlends; FinalH /= dot(FinalH, 1)`).
 */
fn blendedSurface(h: vec4<f32>, wN: vec4<f32>) -> f32 {
    let hb = wN * exp(vec4<f32>(u_terrain.u_heightBlend0, u_terrain.u_heightBlend1,
                                u_terrain.u_heightBlend2, u_terrain.u_heightBlend3) * h);
    return 1.0 - dot(h, hb) / max(dot(hb, vec4<f32>(1.0)), 1e-5);
}

/** Where the view ray met the blended height field, and each layer's height there. */
struct ParallaxHit {
    uv: vec2<f32>,     // BASE-space uv; each layer re-tiles it
    h: vec4<f32>,      // per-layer FULL height at the hit, for the height-aware blend
    // Per-layer RESIDUAL height at the hit, on the 0..1 scale `layerResiduals` returns. The two are
    // not interchangeable: `h` answers "which layer stands higher here", a question about the whole
    // surface, while this is the field the ray actually intersected. `terrainSelfShadow` needs THIS
    // one, because its `h` argument is where the shadow ray starts on the field it is about to test —
    // start it on one field and test against another and the ray's rise and its reach are scaled by
    // unrelated numbers.
    hRes: vec4<f32>,
};

/**
 * The blended field's depth, in BASE uv. Zero when no weighted layer wants the ray offset.
 *
 * A displaced layer contributes its RESIDUAL depth, not its full one: the band its relief is already in
 * the vertices for is subtracted (see `residualHeight`), so marching what is left applies each half of
 * the height map exactly once. An earlier version excluded displaced layers outright, which avoided the
 * double-application by discarding the fine half altogether — invisible in a screenshot, because the
 * coarse band still moved vertices and the terrain looked plausible.
 *
 * Zero for a layer with no height map, so a terrain with none takes `marchTerrain`'s early return,
 * which is the cheapest possible outcome.
 */
fn blendedDepth(wN: vec4<f32>) -> f32 {
    // Already in base uv and already scaled to the residual — `Terrain._writeMarchUniforms` does both,
    // because every term is a per-layer constant. This used to read `dispScale / tiling`, the
    // conversion from the layer's TILED uv back when depth was authored there. Depth is world metres
    // now, so the conversion is `metres / terrainSize`, and the stale divisor survived only because it
    // was multiplied by nothing: every height-mapped layer was excluded from the march, so this sum was
    // always exactly zero and no amount of looking at the rendered image could have caught it.
    return wN.x * u_terrain.u_marchDepth0 + wN.y * u_terrain.u_marchDepth1
         + wN.z * u_terrain.u_marchDepth2 + wN.w * u_terrain.u_marchDepth3;
}

/**
 * The split the marched depth actually belongs to, in the same mip space `lodAvg` is measured in.
 *
 * Weighted by each layer's CONTRIBUTION TO THE DEPTH, not by its splat weight. A layer with no height
 * map has `u_splitLod{i}` of 0, and averaging those in by weight alone would drag the blended split
 * toward zero wherever a displaced layer neighbours a plain one — fading the march out on exactly the
 * fragments that have relief to show. `u_marchDepth{i}` is zero for those same layers, so weighting by
 * it counts only the layers whose relief is being marched. The denominator is `blendedDepth` itself,
 * and the caller has already established it is non-zero before asking.
 */
fn blendedSplit(wN: vec4<f32>, depth: f32) -> f32 {
    let d = vec4<f32>(u_terrain.u_marchDepth0, u_terrain.u_marchDepth1,
                      u_terrain.u_marchDepth2, u_terrain.u_marchDepth3) * wN;
    let s = vec4<f32>(u_terrain.u_splitLod0, u_terrain.u_splitLod1,
                      u_terrain.u_splitLod2, u_terrain.u_splitLod3);
    return dot(d, s) / max(depth, 1e-12);
}

/**
 * March the view ray into the blended height field.
 *
 * `wN` is the NORMALISED weight set and is held FIXED for the whole march. The ray needs a static
 * scalar field to intersect; re-deriving the weights per step would be chasing a surface that moves
 * as the ray does, and it would not converge.
 */
fn marchTerrain(baseUv: vec2<f32>, wN: vec4<f32>, vTan: vec3<f32>,
                dims: vec2<f32>, lod: f32, lodAvg: f32) -> ParallaxHit {
    var hit: ParallaxHit;
    hit.uv = baseUv;

    // TWO LEVELS, AND THEY ARE NOT INTERCHANGEABLE. `lod` is the footprint in BASE uv, which is what
    // the fetches want because `layerHeights` / `layerResiduals` each add their own `log2(tiling)` to
    // reach their layer's space. `lodAvg` is that same footprint already shifted by the weighted
    // average tiling, which is what the FADE and the STEP COUNT want: both ask about the texture being
    // sampled, and `dims` is likewise passed in pre-scaled by that average.
    //
    // Passing the tiled level to the fetches was the bug that made terrain relief blur out and then
    // disappear. `layerHeights` shifted it a second time, so at tiling 20 every height came from a mip
    // `log2(20) = 4.3` levels too coarse — a 1024-texel map read as 51 texels — and `residualHeight`'s
    // `max(l, split)` then found both taps on the same mip, making the residual identically zero.
    // Faded to the SPLIT, not to the fixed aliasing band. See `parallaxFadeToSplit`: the two bands are
    // set by unrelated quantities, and every octave between them was being dropped by both halves.
    let raw = blendedDepth(wN);
    let depth = raw * parallaxFadeToSplit(lodAvg, blendedSplit(wN, raw)) * parallaxGrazeFade(vTan.z);

    // Nothing displaced, or minified past the fade, or too edge-on for a flat-surface approximation.
    // Both height sets are still wanted either way: the height-aware blend reads `h` whether or not
    // anything was offset, and `hRes` is what the self-shadow starts its ray on.
    if (depth <= 1e-7) {
        hit.h = layerHeights(baseUv, wN, lod);
        hit.hRes = layerResiduals(baseUv, wN, lod);
        return hit;
    }

    let pMax = parallaxRay(vTan, depth);
    let steps = parallaxSteps(pMax, dims, lodAvg);
    let dStep = 1.0 / steps;

    // `1.0 - h`: the packed alpha is 1 at the TOP of the field, so this is depth below the geometric
    // surface. `ray` walks the same axis, 0 at the surface down to 1 at the floor.
    //
    // THE FIELD MARCHED HERE IS THE RESIDUAL, not the full height map, and the distinction is the whole
    // point of the split. The terrain's own vertices already carry everything at or below
    // `u_splitLod{i}`; marching the full map as well would apply that band twice, once as geometry and
    // once as a uv offset. `layerResiduals` returns what the vertices could NOT represent, which the
    // bake has left room for by lifting its surface — see `residualHeight`.
    var ray = 0.0;
    var uv = baseUv;
    var hs = layerResiduals(uv, wN, lod);
    var surf = blendedSurface(hs, wN);
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
        hs = layerResiduals(uv, wN, lod);
        surf = blendedSurface(hs, wN);
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
    // FULL heights at the hit, not residuals. `hit.h` feeds the height-aware layer blend
    // (`exp(u_heightBlend * hit.h)` below), which asks "which layer stands higher here" — a question
    // about the actual surface, not about the half of it the march happens to own. One extra sample set
    // at the hit point, rather than per step.
    hit.h = layerHeights(hit.uv, wN, lod);
    // Re-sampled at the REFINED uv, not carried over from `hs` at the last step — which is precisely
    // the quantisation the paragraph above says the refinement exists to remove. `hRes` is what the
    // self-shadow starts its ray on, and there `(1 - h)` scales both the rise and the reach, so a hit
    // taken one step deep changes the shadow's whole geometry rather than just its origin.
    hit.hRes = layerResiduals(hit.uv, wN, lod);
    return hit;
}

/** Soft self-shadowing of the blended field, marched from the hit toward the sun. See parallaxShadow. */
fn terrainSelfShadow(uv: vec2<f32>, wN: vec4<f32>, lTan: vec3<f32>,
                     h: f32, lod: f32, lodAvg: f32) -> f32 {
    // Same split as `marchTerrain`: `lodAvg` for the fade, `lod` for the fetches. And `h` must be on
    // the RESIDUAL scale, because that is the field sampled below.
    // The SAME fade the view march used. A shadow that outlived the relief casting it would darken a
    // surface that is no longer there.
    let raw = blendedDepth(wN);
    let depth = raw * parallaxFadeToSplit(lodAvg, blendedSplit(wN, raw)) * parallaxGrazeFade(lTan.z);
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
        // 1 - blendedSurface, i.e. the same field the view ray intersected. Reading a plain dot here
        // would shadow a different surface than the one on screen.
        let sampleH = 1.0 - blendedSurface(layerResiduals(uv + reach * f, wN, lod), wN);
        let rayH = h + dh * f32(i);
        if (sampleH > rayH) {
            // Nearer blockers weigh more; the falloff keeps this soft rather than binary.
            occ = max(occ, (sampleH - rayH) * (1.0 - f));
        }
    }
    return clamp(1.0 - occ, 0.0, 1.0);
}

/**
 * One layer's weighted PBR contribution at its tiled uv.
 *
 * The gradient is passed in rather than taken here, and that is what lets this return early on a zero
 * weight: an explicit gradient carries no uniformity requirement, while an implicit one below a
 * per-fragment branch is a module WGSL rejects outright. On a four-layer splat the common fragment has
 * two layers contributing and two not, so the early return halves the fetches.
 */
fn addLayer(w: f32, uv: vec2<f32>, ddx: vec2<f32>, ddy: vec2<f32>,
            albedoTex: texture_2d<f32>, albedoSmp: sampler, hasAlbedo: i32, hasAO: i32, color: vec3<f32>,
            normalTex: texture_2d<f32>, normalSmp: sampler, hasNormal: i32,
            metallic: f32, roughness: f32, tbn: mat3x3<f32>) -> LayerAccum {
    var out: LayerAccum;
    out.albedo = vec3<f32>(0.0);
    out.ao = 0.0;
    out.metallic = 0.0;
    out.roughness = 0.0;
    out.normal = vec3<f32>(0.0);
    if (w <= LAYER_MIN_W) { return out; }

    var alb = toLinear(color);   // sRGB layer tint -> linear
    var ao = 1.0;
    // ONE fetch for both. Albedo is sRGB and occlusion is linear, which is why only the rgb goes
    // through `toLinear` — an occlusion map decoded as sRGB would read far too dark.
    if (hasAlbedo == 1 || hasAO == 1) {
        let texel = textureSampleGrad(albedoTex, albedoSmp, uv, ddx, ddy);
        if (hasAlbedo == 1) { alb *= toLinear(texel.rgb); }
        if (hasAO == 1) { ao = texel.a; }
    }

    // The interpolated tbn, whose bitangent sign is the engine-wide green-channel convention.
    var nrm = tbn[2];
    if (hasNormal == 1) {
        let tn = textureSampleGrad(normalTex, normalSmp, uv, ddx, ddy).rgb * 2.0 - 1.0;
        nrm = normalize(tbn * tn);
    }

    out.albedo = w * alb;
    out.ao = w * ao;
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
 * only for the self-shadow march. A zero vector switches self-shadowing off, which is what a scene with
 * no directional light passes.
 */
fn resolveTerrainSurface(fragPos: vec3<f32>, baseUv: vec2<f32>, tbn: mat3x3<f32>,
                         sunDir: vec3<f32>) -> TerrainSurface {
    // Screen-space derivatives of the base uv, taken HERE and nowhere else.
    //
    // `dpdx`/`dpdy` carry the same uniformity rule `textureSample` does: WGSL permits them only in
    // uniform control flow. This is the last point in the function where control flow is uniform —
    // everything below it (the per-weight skips, the unpainted early return) is per-fragment. Captured
    // once here, every fetch downstream is an explicit-gradient one, and the rule stops constraining
    // the shape of the code.
    let ddxUv = dpdx(baseUv);
    let ddyUv = dpdy(baseUv);

    let nGeom = normalize(tbn[2]);
    let height = fragPos.y;
    let slope = clamp(1.0 - nGeom.y, 0.0, 1.0);

    // The parallax frame is built HERE, above the unpainted early return, for the same reason the
    // gradients are: it takes dpdx/dpdy of fragPos internally, and a derivative below a per-fragment
    // branch is non-uniform control flow. naga waves that through; Dawn rejects the module, which takes
    // the pipeline, its bind groups and the entire terrain pass with it.
    let toEye = normalize(u_terrain.u_viewPos - fragPos);
    let frame = parallaxFrame(fragPos, ddxUv, ddyUv, nGeom, toEye);
    let vTan = parallaxToTangent(frame, toEye);

    var w = textureSampleGrad(u_splat_texture, u_splat_sampler, baseUv, ddxUv, ddyUv);

    if (u_terrain.u_layerCount < 1) { w.x = 0.0; }
    if (u_terrain.u_layerCount < 2) { w.y = 0.0; }
    if (u_terrain.u_layerCount < 3) { w.z = 0.0; }
    if (u_terrain.u_layerCount < 4) { w.w = 0.0; }

    if (u_terrain.u_useAuto == 1) {
        let unmasked = w;
        if (u_terrain.u_auto0 == 1) { w.x *= band(u_terrain.u_hRange0, height, 2.0) * band(u_terrain.u_sRange0, slope, 0.08); }
        if (u_terrain.u_auto1 == 1) { w.y *= band(u_terrain.u_hRange1, height, 2.0) * band(u_terrain.u_sRange1, slope, 0.08); }
        if (u_terrain.u_auto2 == 1) { w.z *= band(u_terrain.u_hRange2, height, 2.0) * band(u_terrain.u_sRange2, slope, 0.08); }
        if (u_terrain.u_auto3 == 1) { w.w *= band(u_terrain.u_hRange3, height, 2.0) * band(u_terrain.u_sRange3, slope, 0.08); }
        // THE MASK MAY NOT ERASE THE TERRAIN. `hRange` defaults to [0, 100] and `band` smoothsteps in
        // across `range[0] ± 2`, so it returns 0.5 at y = 0 — where a default terrain sits — and 0
        // below about y = -2. Sculpted valleys, or a landscape moved down, drove every auto layer to
        // zero, `wSum` fell under the unpainted threshold below, and the ground came out flat base
        // colour with its relief gone.
        //
        // The mask exists to CHOOSE between layers; with nothing left to choose between it has no
        // opinion, and the painted splat is a better answer than none. `Terrain._resolveWeights` runs
        // the same fallback — they must agree, or the CPU bake displaces ground this shader draws bare.
        if (w.x + w.y + w.z + w.w < 1e-4) { w = unmasked; }
    }

    var out: TerrainSurface;
    out.shadow = 1.0;

    // Unpainted terrain. This used to sit AFTER four addLayer calls whose results were multiplied by
    // zero, because a per-fragment return put every `textureSample` below it in non-uniform control
    // flow and WGSL rejected the module outright — "'textureSample' must only be called from uniform
    // control flow" — which invalidated the terrainForward pipeline and every bind group built from
    // its layout, so terrain drew nothing at all. With the gradients already captured and no implicit
    // derivative left downstream, the branch can go where it belongs.
    let wSum = w.x + w.y + w.z + w.w;
    if (wSum < 1e-4) {
        out.albedo = toLinear(u_terrain.u_baseColor);
        out.ao = 1.0;
        out.metallic = 0.0;
        out.roughness = 0.9;
        out.normal = nGeom;
        return out;
    }
    let wN = w / wSum;

    // Fade by texture footprint. The tiling is blended the same way the depth is, so the footprint
    // reflects the layers actually painted here rather than whichever one happens to be slot 0; the
    // packed layer textures are all built by the same packer, so slot 0's dimensions stand for the set.
    // ONE lod for the whole march, in BASE uv. `layerHeights` adds `log2(tiling)` per layer, which is
    // exactly the level shift a layer's own tiling implies — so four differently-tiled layers all read
    // the same physical footprint instead of four unrelated ones.
    //
    // The tiling is blended the same way the depth is, so the footprint reflects the layers actually
    // painted here rather than whichever happens to be slot 0; the packed layer textures are all built by
    // the same packer, so slot 0's dimensions stand for the set.
    let tAvg = max(wN.x * u_terrain.u_tiling0 + wN.y * u_terrain.u_tiling1
                 + wN.z * u_terrain.u_tiling2 + wN.w * u_terrain.u_tiling3, 1e-4);
    let dims = vec2<f32>(textureDimensions(u_normal0_texture, 0));
    // IN BASE UV — `ddxUv` is the derivative of `baseUv`, and it is NOT scaled by the tiling here.
    // Every height fetch adds its own layer's `log2(tiling)`, so scaling the derivative as well applied
    // that shift twice: 4.3 mip levels at tiling 20, which is what made a landscape's relief blur into
    // nothing while an 8 m preview patch (rebased to tiling 0.8, where the doubled shift is worth a
    // third of a mip) looked correct. `chunks/pbrGBuffer.wgsl` is the single-uv-space reference: one
    // lod, taken on the derivatives of the uv it actually samples.
    // RAW, i.e. not floored at mip 0. This number is not a mip index of anything yet — each layer adds
    // its own `log2(tiling)` to reach the space it samples in, and the floor belongs there. Flooring
    // here is the second bug this file has had from mixing a base-uv quantity with a per-layer shift;
    // the first was scaling the DERIVATIVE by the tiling. The rule both violate: nothing in base uv may
    // be clamped, faded or compared against a per-layer level until `log2(tiling)` has been added.
    let lod = parallaxLodRaw(ddxUv, ddyUv, dims);
    // The same footprint in the weighted-average layer's space, for the two things that ask about the
    // TEXTURE rather than the terrain: `parallaxFade` and `parallaxSteps`. Clamped, because both treat
    // it as a real mip index — `parallaxSteps` divides by `exp2(lod)`, so a negative level would inflate
    // the step count instead of describing a magnified surface.
    let lodAvg = max(lod + log2(tAvg), 0.0);

    let hit = marchTerrain(baseUv, wN, vTan, dims * tAvg, lod, lodAvg);

    if (dot(sunDir, sunDir) > 1e-6) {
        let lTan = parallaxToTangent(frame, normalize(-sunDir));
        out.shadow = terrainSelfShadow(hit.uv, wN, lTan,
                                       1.0 - blendedSurface(hit.hRes, wN), lod, lodAvg);
    }

    // Height-aware blend, biased by the heights AT THE HIT rather than under it — the whole point of
    // marching is that the surface here is not the surface directly below. With no height map h is 0
    // and every factor is 1, i.e. the plain linear splat blend.
    let h = hit.h;
    w.x *= exp(u_terrain.u_heightBlend0 * h.x);
    w.y *= exp(u_terrain.u_heightBlend1 * h.y);
    w.z *= exp(u_terrain.u_heightBlend2 * h.z);
    w.w *= exp(u_terrain.u_heightBlend3 * h.w);

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
                      u_albedo0_texture, u_albedo0_sampler, u_terrain.u_hasAlbedo0, u_terrain.u_hasAO0,
                      u_terrain.u_color0, u_normal0_texture, u_normal0_sampler,
                      u_terrain.u_hasNormal0, u_terrain.u_metallic0, u_terrain.u_roughness0, tbn);
    let l1 = addLayer(w.y, hit.uv * u_terrain.u_tiling1, ddxUv * u_terrain.u_tiling1, ddyUv * u_terrain.u_tiling1,
                      u_albedo1_texture, u_albedo1_sampler, u_terrain.u_hasAlbedo1, u_terrain.u_hasAO1,
                      u_terrain.u_color1, u_normal1_texture, u_normal1_sampler,
                      u_terrain.u_hasNormal1, u_terrain.u_metallic1, u_terrain.u_roughness1, tbn);
    let l2 = addLayer(w.z, hit.uv * u_terrain.u_tiling2, ddxUv * u_terrain.u_tiling2, ddyUv * u_terrain.u_tiling2,
                      u_albedo2_texture, u_albedo2_sampler, u_terrain.u_hasAlbedo2, u_terrain.u_hasAO2,
                      u_terrain.u_color2, u_normal2_texture, u_normal2_sampler,
                      u_terrain.u_hasNormal2, u_terrain.u_metallic2, u_terrain.u_roughness2, tbn);
    let l3 = addLayer(w.w, hit.uv * u_terrain.u_tiling3, ddxUv * u_terrain.u_tiling3, ddyUv * u_terrain.u_tiling3,
                      u_albedo3_texture, u_albedo3_sampler, u_terrain.u_hasAlbedo3, u_terrain.u_hasAO3,
                      u_terrain.u_color3, u_normal3_texture, u_normal3_sampler,
                      u_terrain.u_hasNormal3, u_terrain.u_metallic3, u_terrain.u_roughness3, tbn);

    out.albedo = (l0.albedo + l1.albedo + l2.albedo + l3.albedo) / sum;
    out.ao = (l0.ao + l1.ao + l2.ao + l3.ao) / sum;
    out.metallic = (l0.metallic + l1.metallic + l2.metallic + l3.metallic) / sum;
    out.roughness = (l0.roughness + l1.roughness + l2.roughness + l3.roughness) / sum;
    out.normal = normalize(l0.normal + l1.normal + l2.normal + l3.normal);
    return out;
}
