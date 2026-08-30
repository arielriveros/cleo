// Parallax occlusion mapping: the tangent frame, the ray march, and the height-field self-shadow.
//
// The march follows https://learnopengl.com/Advanced-Lighting/Parallax-Mapping, and the constants
// below are calibrated to REACH that reference rather than approximate it — see parallaxRay, which
// spent a revision claiming a 1/cos asymptote it never came within 30% of. Used by the standard PBR
// material chunks (pbrGBuffer / pbrForward) AND by terrain, which marches the half of a layer's height
// map its vertices are too coarse to carry — see `residualHeight` in terrainLayers.wgsl. Terrain does
// not call `parallaxOcclusion` itself, because it has four uv spaces at once and has to blend the four
// fields as it goes; it has its own loop and borrows the pieces here (`parallaxFrame`, `parallaxRay`,
// `parallaxSteps`, `parallaxFade`, `parallaxGrazeFade`).
//
// Included from chunks/modelVarying.wgsl rather than from each consumer. The include resolver has
// no include-once guard, and a program includes exactly one vertex chunk, so modelVarying is the
// single place that lands exactly once for every program carrying a TBN — the same reasoning that
// already puts VertexOutput there. Including this from both terrainLayers and pbrGBuffer would
// define every function here twice in any program that pulled in both.
//
// EVERY texture fetch a caller makes inside a march must be `textureSampleGrad`. `textureSample`
// takes implicit derivatives, and WGSL permits those only in uniform control flow — which a ray
// march is not, by construction. The gradients are taken once at the top of the fragment stage,
// where control flow is still uniform, and passed down. `textureSampleLevel(..., 0.0)`, the trick
// the cloud/outline/SSAO shaders use for the same rule, is NOT available here: those buffers are
// built `mipMap: false`, while these textures are tiled and mipped, and level 0 on a minified
// tiled surface aliases violently.

/**
 * Loop bound — the ceiling on the texel-driven count, not a count anyone reaches routinely.
 *
 * 64, not 32. The count is now driven by how many TEXELS the ray crosses (see parallaxSteps), so the
 * bound only binds where the ray is genuinely long, and the explicit-LOD fetches below made each step
 * several times cheaper. Head-on fragments got cheaper at the same time — POM_MIN_STEPS halved.
 */
const POM_MAX_STEPS: i32 = 64;
/** Head-on, where the ray crosses little of the field per pixel and few samples suffice. */
const POM_MIN_STEPS: f32 = 4.0;
/**
 * Texels of the ray's uv path per march step, at the mip actually sampled. 1 means "sample every texel
 * it crosses" — the Nyquist reading, and the point of driving the count this way at all.
 */
const POM_TEXELS_PER_STEP: f32 = 1.0;
/**
 * Lateral travel ceiling, in multiples of the depth — the value `1/cos(view)` saturates toward.
 *
 * 8, not 2. The reference has no ceiling at all: `P = viewDir.xy / viewDir.z` runs to infinity as the
 * view goes edge-on. A ceiling is still wanted, because an unbounded offset near the horizon reaches
 * texels with no relation to the fragment. But it has to sit far enough out to be a LIMIT rather than
 * the operating point, and 2 was not: `1/cos` is >= 1 everywhere, so a soft-min against 2 never had a
 * small argument to select, and the ratio spent its whole domain in [0.894, 2.0]. That is a constant,
 * not a ratio — it under-parallaxed by 10% head-on and by 54% at 75 degrees, which is most of why the
 * effect read as flat. At 8 the ceiling first bites around 80 degrees, where parallaxGrazeFade is
 * already taking over.
 */
const POM_MAX_RATIO: f32 = 8.0;
/** Below this cos(view, normal) the effect is fully faded out; above POM_GRAZE_HI it is at full
 *  strength. See parallaxGrazeFade for why a footprint fade alone is not enough. */
const POM_GRAZE_LO: f32 = 0.02;
const POM_GRAZE_HI: f32 = 0.15;
/**
 * Footprint, as log2(texels), where the effect starts fading out...
 *
 * 4.5/7.5, not 2.5/5.5. The old band put half strength at ~16 texels/pixel, which on a 2 m camera over
 * a 256 texel/m ground is ELEVEN METRES, and zero at eighteen — so the feature was off across most of
 * the screen area of the exact surface it was asked for, and what survived was the near strip with the
 * least of it. The reference fades nothing; this band is an aliasing floor, so it belongs at genuine
 * minification (half strength ~22 m, gone ~36 m), not at conversational distance.
 */
const POM_FADE_START: f32 = 4.5;
/** ...and where it is gone. Both are mip levels. */
const POM_FADE_END: f32 = 7.5;
/** Steps in the self-shadow march. Shorter than the view march: it only has to find a blocker. */
const POM_SHADOW_STEPS: i32 = 8;
/**
 * The furthest, in UV, that a SILHOUETTE-CLIPPED surface may travel laterally. See parallaxBoundedDepth.
 *
 * Only materials with clipping on are bounded by this. The clipped band and the relief depth are the
 * same quantity — the band is exactly how far the ray walks before leaving the face — so there is no
 * way to keep a deep offset and a narrow bite. Unbounded, `tan(t) * dispScale` reaches 24% of a face at
 * 63 degrees and 29% at 67, and a cube losing a third of a face to a discard reads as being cut apart
 * rather than nibbled.
 */
const POM_CLIP_REACH: f32 = 0.12;

/**
 * An ORTHONORMAL world<-tangent basis whose first two columns are the TRUE dP/du and dP/dv.
 *
 * Deliberately not built from the tangent varyings, and deliberately not `tbn` with its bitangent
 * flipped back. Two independent things make the vertex frame unusable as a world->tangent transform:
 *
 * Its bitangent's sign is not a fact about the surface. chunks/modelVarying.wgsl negates the
 * bitangent for the green-down normal-map convention the importers produce, and
 * Geometry._calculateTangents FORCES bitangent = -(N x T) rather than reading the mesh's real
 * dP/dv. So tbn[1] lands on -dP/dv for terrain (whose UVs are left-handed: u -> +X, v -> +Z, giving
 * T x B = -N) and on +dP/dv for a right-handed mesh. One flip cannot serve both, and both run
 * through this code: the editor's terrain-material tab previews a TerrainMaterial on a SPHERE.
 * Getting that sign wrong mirrors the V half of the offset against the U half — a sheared,
 * wrong-way relief, which is exactly what this whole change exists to fix.
 *
 * And it is not orthonormal. Terrain pins T and B to world +X/+Z per vertex while N follows the
 * heightfield, so on any slope the columns are not mutually perpendicular, `transpose` is not
 * `inverse`, and the offset direction skews. Nothing re-orthogonalises after interpolation either.
 *
 * Derivatives cannot be wrong about either one: they measure the mapping this fragment actually
 * has. The cost is two dpdx/dpdy and two cross products, paid only by surfaces doing parallax; the
 * uv's own derivatives are taken by the caller, which needs them for every textureSampleGrad anyway.
 *
 * CALL THIS IN UNIFORM CONTROL FLOW — above every per-fragment branch, exactly like the gradients.
 * `dpdx`/`dpdy` carry the same rule `textureSample` does, and a call sited below a per-fragment
 * early return puts them in non-uniform flow. naga's validator lets that through; Dawn's does not,
 * and a module Dawn rejects takes its pipeline, its bind groups and the whole pass down with it.
 *
 * `tbn` itself is left untouched for normal-map decoding. The green-down convention is shared by
 * pbrGBuffer, pbrForward, both blinnPhong chunks, the hand-written materials/pbr.vs and the
 * custom-material varying contract; changing it would flip lit relief across the whole engine.
 */
fn parallaxFrame(fragPos: vec3<f32>, du1: vec2<f32>, du2: vec2<f32>,
                 nGeo: vec3<f32>, toEye: vec3<f32>) -> mat3x3<f32> {
    // Orient the normal by the VIEW VECTOR, not by @builtin(front_facing).
    //
    // The march needs a tangent space whose +z faces the camera: every step divides by vTan.z, and a
    // negative one aims the ray into the surface instead of along it. front_facing looks like the way
    // to get that and is not — naga lowers it to gl_FrontFacing, whose sense depends on the winding
    // the projection ends up with, so the two backends can disagree about the same triangle. The view
    // vector cannot disagree with itself. This also covers a double-sided material's back faces for
    // free, which is what front_facing was there for.
    //
    // The symptom when this was wrong: vTan.z came out negative, parallaxGrazeFade read that as
    // edge-on and returned 0, and the whole effect silently switched itself off.
    let n = select(-nGeo, nGeo, dot(nGeo, toEye) >= 0.0);
    let dp1 = dpdx(fragPos);
    let dp2 = dpdy(fragPos);
    let dp2perp = cross(dp2, n);
    let dp1perp = cross(n, dp1);
    let t = dp2perp * du1.x + dp1perp * du2.x;
    let b = dp2perp * du1.y + dp1perp * du2.y;
    // MEASURE the frame's sign. Do not assume it.
    //
    // Work the algebra of the four lines above through and they come out as `t = det * T` and
    // `b = det * B`, where T and B are the true dP/du and dP/dv and
    //
    //     det = du1.x * du2.y - du2.x * du1.y
    //
    // is the Jacobian determinant of uv with respect to SCREEN space. `invmax` below is an
    // `inverseSqrt` — strictly positive — so it fixes the LENGTH and can do nothing about that factor's
    // sign. Schüler published this frame under OpenGL's y-UP fragment coordinates, where `det` is
    // positive for a front-facing right-handed chart. WGSL's fragment coordinates run y-DOWN, which
    // negates `dpdy` and therefore `det`, so both columns come out negated — on every face, all the
    // time, which is exactly why it never looked like noise.
    //
    // What that cost: `vTan.xy` carried the wrong sign, so `cur = uv - pMax * ray` marched TOWARD the
    // camera instead of away from it and the relief shifted the wrong way as the camera moved. Nothing
    // downstream could catch it, because a negated frame is still a perfectly valid right-handed
    // orthonormal basis: (-T) x (-B) = T x B = n. It surfaced only when silhouette clipping made the
    // direction visible as a shape — the clip fired on the near edge of a cube instead of the far one.
    //
    // `det` is computed from the same derivatives the frame is built from, so this is correct on both
    // backends whichever way their y runs, rather than a constant negation tuned to one of them.
    let det = du1.x * du2.y - du2.x * du1.y;
    let orient = select(-1.0, 1.0, det >= 0.0);
    // A fragment with no UV gradient (a degenerate triangle, a collapsed derivative quad) leaves
    // both vectors at zero. Clamping rather than dividing by that yields a zero basis, so the
    // tangent view direction comes out zero, so no offset is applied — the right answer for a
    // surface with no measurable texture mapping, and never a NaN.
    let invmax = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-12)) * orient;
    return mat3x3<f32>(t * invmax, b * invmax, n);
}

/** A world direction in the tangent space of a parallaxFrame basis. */
fn parallaxToTangent(frame: mat3x3<f32>, dir: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(dot(dir, frame[0]), dot(dir, frame[1]), dot(dir, frame[2]));
}

/**
 * How much of the effect survives at this fragment's texture footprint, 1 near to 0 far.
 *
 * By MIP LEVEL, not by world distance. Parallax on a minified surface is pure aliasing — the offset
 * is larger than the footprint it is offsetting — and that is the swimming that makes POM look
 * cheap. A world distance cannot know when that begins: it does not know the tiling or the terrain's
 * size. The texture LOD is precisely the quantity in question, and it is already in hand from the
 * gradients the march needs anyway.
 *
 * Callers scale the DEPTH by this and nothing else. It used to divide the step count as well, which
 * is a category error — how far the offset may travel and how finely the ray samples along it are
 * unrelated questions — and a damaging one: past the middle of the band it drove `steps` to 1, and a
 * one-step march is not occlusion mapping at all, it is a single offset tap with no intersection.
 *
 * The footprint is the GEOMETRIC MEAN of the two axes, not the larger of them. `max` is right for
 * choosing a mip (it must not alias on either axis) and wrong for this: on a ground plane the ellipse
 * is anisotropic by 1/cos, so the long axis grows as 1/cos^2 and fired the fade while the field was
 * still perfectly resolvable across the short one — the fade got MORE aggressive exactly as the view
 * flattened, compounding with parallaxGrazeFade instead of being independent of it. The geometric mean
 * is the isotropic-equivalent footprint, which is the quantity actually being asked about.
 */
fn parallaxFade(lod: f32) -> f32 {
    return 1.0 - smoothstep(POM_FADE_START, POM_FADE_END, lod);
}

/**
 * The mip level this fragment's footprint deserves, as a number, computed BY HAND.
 *
 * Neither backend exposes `textureQueryLod`, so a march that wants an explicit level has to derive it —
 * and it must be the same number the fade uses, or the effect would fade out at one scale while the
 * fetches read another. Hence one function, consumed by `parallaxFade`, by `parallaxSteps`, and by every
 * fetch inside the loops.
 *
 * Take this in UNIFORM control flow and hoist it above the march. It is a pure function of gradients
 * already captured there, and some WebGL2 drivers historically treated `textureLod` as derivative-
 * dependent (Mozilla bug 1237676) — long fixed, but a reason not to recompute it per step anyway.
 *
 * The footprint is the GEOMETRIC MEAN of the two axes, not the larger: `max` is right for choosing a mip
 * that must not alias on either axis, and wrong for asking "can this fragment still resolve the field",
 * because on a ground plane the long axis grows as 1/cos^2 and would answer no while the short axis was
 * still fine.
 */
fn parallaxLodRaw(ddx: vec2<f32>, ddy: vec2<f32>, dims: vec2<f32>) -> f32 {
    // NOT floored at zero, and that is the whole reason this variant exists. A level below 0 means the
    // surface is MAGNIFIED — fewer than one texel per pixel — which is a real, usable answer for any
    // caller that has not yet converted the number into the space it will sample in.
    //
    // Terrain is that caller. It derives one level in BASE uv and each layer adds `log2(tiling)` to
    // reach its own space, so flooring here would clamp a quantity that is not yet a mip index of
    // anything. At tiling 20 a fragment three metres away has a true footprint of 0.0164 texels in base
    // uv — 0.33 in the layer's space, mip 0 — but floored-then-shifted it samples mip 4.32, four levels
    // too coarse, at EVERY distance, because the floor pins it regardless of the camera. That is what
    // "the relief is flat" looked like.
    let px = sqrt(max(length(ddx * dims) * length(ddy * dims), 1e-12));
    return log2(px);
}

/**
 * The same footprint, floored at mip 0 — for a caller that samples in the space it measured in.
 *
 * That is every single-material path: one uv, one texture, so a sub-texel footprint IS mip 0 and the
 * clamp belongs right here. Defined in terms of the raw form rather than beside it so the two cannot
 * drift apart, which is the failure this whole pairing exists to prevent.
 */
fn parallaxLod(ddx: vec2<f32>, ddy: vec2<f32>, dims: vec2<f32>) -> f32 {
    return max(parallaxLodRaw(ddx, ddy, dims), 0.0);
}

/**
 * The full-depth UV displacement of a ray — the reference's `P = viewDir.xy / viewDir.z * depth`,
 * saturated toward POM_MAX_RATIO instead of diverging.
 *
 * Saturated SMOOTHLY rather than clamped with `min`, because a `min` puts a CREASE at a fixed
 * camera-relative distance. On flat ground `vTan.z = h / sqrt(d^2 + h^2)`, so any threshold on it is a
 * ring centred under the camera and rigidly attached to it: `min(1/vTan.z, R)` switches branches at
 * `vTan.z = 1/R`, always the same distance ahead and sliding with the viewer. The value is continuous
 * there but its slope is not.
 *
 * The soft-min is FOURTH order, not second. A second-order blend is smooth but blunt: it is already
 * 30% low a full decade before the ceiling, so with the old POM_MAX_RATIO = 2 the "asymptotic" branch
 * was never reached and the whole function collapsed to a near-constant (see POM_MAX_RATIO). Raising
 * the order sharpens the corner enough that the ratio tracks `1/cos` to within ~1% out to 75 degrees
 * and only then rolls off. Two multiplies and a sqrt more than the old form, on fragments that are
 * about to run a 32-step march.
 *
 * `max(vTan.z, 1e-3)` is a divide guard only. The caller has already faded the depth to zero long
 * before that value could matter.
 */
fn parallaxRay(vTan: vec3<f32>, depth: f32) -> vec2<f32> {
    let inv = 1.0 / max(vTan.z, 1e-3);
    let a = inv * inv;
    let b = POM_MAX_RATIO * POM_MAX_RATIO;
    let ratio = inv * POM_MAX_RATIO * inverseSqrt(sqrt(a * a + b * b));
    return vTan.xy * ratio * depth;
}

/**
 * How much of the effect survives at this VIEW ANGLE, 1 head-on to 0 edge-on.
 *
 * Distinct from parallaxFade, and both are needed. The footprint fade asks "can this fragment still
 * resolve the height field", which is a question about minification; this one asks "does the flat-
 * surface approximation still hold", which is a question about geometry, and near grazing the answer
 * is no at any resolution. The ray displacement goes as 1/cos, so as a surface turns edge-on the
 * offset diverges while the surface it is offsetting shrinks to nothing — a large plane seen at a
 * shallow angle then smears into a radial starburst around the vanishing point, every fragment
 * reaching a UV far from its own. Capping the ratio bounds that but does not remove it; the cap is
 * still a large offset applied where the approximation has already failed.
 *
 * A large ground plane under a game camera is exactly where this bites.
 *
 * The band is deliberately NARROW and close to zero. A generous one (fully faded below cos 0.4, say)
 * removes the starburst and every bit of visible relief along with it — a ground plane under a normal
 * game camera spends most of its screen area below that, so the feature would switch itself off
 * exactly where it was asked for. This kills the divergence and nothing else.
 *
 * It used to be unreachable in practice: parallaxFade's old band zeroed the effect at ~84 degrees
 * while this was still at 0.36, so on any ground plane the footprint fade always got there first and
 * this was dead code. With that band moved out to where minification actually is, this becomes the
 * grazing-angle guard it was written to be.
 */
fn parallaxGrazeFade(vz: f32) -> f32 {
    return smoothstep(POM_GRAZE_LO, POM_GRAZE_HI, vz);
}

/**
 * Steps to walk: one per TEXEL of the ray's uv path, at the mip actually sampled.
 *
 * Driven by the path length, not by cos(view). `mix(32, 8, cos)` is Tatarchuk's 2006 rule and it is the
 * wrong quantity — it knows nothing about the depth scale, the tiling or the mip, which are exactly what
 * decide how much texture the ray crosses. Normalise so one tile is 1 uv: the path is `tan(t) * depth`,
 * so on a 1024 map tiled 25x with a few centimetres of relief, 85 degrees walks ~175 TEXELS. Under the
 * old rule that was 32 steps — five and a half texels each, stepping clean over every feature. That
 * undersampling is the grazing artifact, and no amount of refinement can fix a bracket that wide.
 *
 * Dividing by the mip's texel size is what stops this exploding at the horizon: the footprint grows with
 * the path, so the count saturates instead of diverging. This is Drobot's "limit stop condition to LOD
 * level computed from current MIP level" stated as an equation.
 *
 * FRACTIONAL on purpose. This used to be wrapped in `floor()`, which made the sampling grid `1/steps`
 * jump at every integer crossing — each jump a ring at a fixed camera-relative distance, one of which
 * landed exactly where parallaxRay used to crease. Keeping it continuous keeps the grid continuous; only
 * the iteration COUNT is discrete, and the secant refinement makes the hit insensitive to that.
 */
fn parallaxSteps(pMax: vec2<f32>, dims: vec2<f32>, lod: f32) -> f32 {
    let texels = length(pMax * dims) / exp2(lod);
    return clamp(texels / POM_TEXELS_PER_STEP, POM_MIN_STEPS, f32(POM_MAX_STEPS));
}


/**
 * Depth reduced so the ray's lateral travel cannot exceed `maxReach` UV.
 *
 * For silhouette clipping only. The offset goes as `tan(t) * depth`, which is unbounded in `t`, and the
 * width of the clipped band goes with it — so a material that clips needs a ceiling the others do not.
 * Capping the DEPTH rather than the offset keeps the march self-consistent: the relief the surface shows
 * and the border the clip carves stay the same surface. The cost is under-parallax at grazing angles, on
 * clipped materials only.
 */
fn parallaxBoundedDepth(vTan: vec3<f32>, depth: f32, maxReach: f32) -> f32 {
    let lateral = length(vTan.xy) / max(vTan.z, 1e-3);   // tan(t)
    return min(depth, maxReach / max(lateral, 1e-4));
}

/**
 * The field's HEIGHT at one uv, 1 at the top of the relief and 0 at its floor.
 *
 * Read from the RED channel, and `invert` is which way that channel runs. The engine authors a HEIGHT
 * map (white = high) and every other height in the codebase agrees — Terrain's packed alpha, the
 * material docs. The rest of the world does not: the reference asset, and most downloaded PBR packs,
 * ship a DEPTH map (`*_disp.png`, white = deep). The two are indistinguishable from the bytes, and
 * feeding one to the other does not degrade gracefully — it turns the relief inside out, so brick
 * becomes mortar and the surface reads as sliding rather than recessing. There is nothing to detect
 * here, only something to declare, so the material declares it.
 */
fn parallaxHeight(tex: texture_2d<f32>, smp: sampler, uv: vec2<f32>,
                  ddx: vec2<f32>, ddy: vec2<f32>, invert: bool) -> f32 {
    let r = textureSampleGrad(tex, smp, uv, ddx, ddy).r;
    return select(r, 1.0 - r, invert);
}

/**
 * The same height, at an EXPLICIT mip. This is what the search loop uses.
 *
 * A gradient fetch inside the march is the single most expensive thing this file did. There are up to 34
 * of them per fragment here and 136 in terrain's four-layer version, and `textureSampleGrad` forces the
 * anisotropic path on every one — a measured 6x penalty on its own, and a measured 4.04ms -> 0.65ms when
 * replaced by an explicit level (BTH 2015, 2048^2 worst case; "visual result almost identical").
 *
 * It costs nothing in quality because the search does not need filtering. It needs to know where the
 * surface is, and it needs every sample on the SAME level so the field it is intersecting does not
 * change shape underneath it. The hit is refined by the secant step and then re-read with real gradients
 * for shading, which is the fetch that is actually seen.
 *
 * Bonus, and worth knowing before anyone rearranges this file: `textureSampleLevel` takes no implicit
 * derivative, so it carries NO uniformity requirement. The loop no longer constrains where it may sit.
 * `parallaxFrame`'s `dpdx(fragPos)` still does, so the hoisting above it must stay.
 */
fn parallaxHeightLod(tex: texture_2d<f32>, smp: sampler, uv: vec2<f32>,
                     lod: f32, invert: bool) -> f32 {
    let r = textureSampleLevel(tex, smp, uv, lod).r;
    return select(r, 1.0 - r, invert);
}

/**
 * March a single height field. Returns the offset uv in xy and the height at the hit in z.
 *
 * The loop is https://learnopengl.com/Advanced-Lighting/Parallax-Mapping's `steep parallax mapping`
 * plus its `parallax occlusion` refinement, with the same continue-test and the same secant weight.
 *
 * `1.0 - h` is the depth convention, and its absence was a real defect in the code this replaces. The
 * source is 1 at the TOP of the field; marched raw, the reference plane is the BOTTOM, so the entire
 * surface slides sideways instead of recessing into the geometry.
 */
fn parallaxOcclusion(tex: texture_2d<f32>, smp: sampler, uv: vec2<f32>,
                     ddx: vec2<f32>, ddy: vec2<f32>, vTan: vec3<f32>,
                     depth: f32, dims: vec2<f32>, lod: f32, invert: bool) -> vec3<f32> {
    let d = depth * parallaxFade(lod) * parallaxGrazeFade(vTan.z);
    if (d <= 1e-7) {
        return vec3<f32>(uv, parallaxHeight(tex, smp, uv, ddx, ddy, invert));
    }

    let pMax = parallaxRay(vTan, d);
    let steps = parallaxSteps(pMax, dims, lod);
    let dStep = 1.0 / steps;

    var ray = 0.0;                 // 0 at the geometric surface, 1 at the floor of the field
    var cur = uv;
    var surf = 1.0 - parallaxHeightLod(tex, smp, cur, lod, invert);
    var prev = cur;
    var prevRay = ray;
    var prevSurf = surf;

    for (var i = 0; i < POM_MAX_STEPS; i++) {
        if (f32(i) >= steps || ray >= surf) { break; }
        prev = cur;
        prevRay = ray;
        prevSurf = surf;
        ray += dStep;
        // Recomputed from `ray` rather than subtracted step by step. These offsets can run to a few
        // thousandths of a uv, and repeatedly accumulating an increment that small is the worse
        // conditioning of the two.
        cur = uv - pMax * ray;
        surf = 1.0 - parallaxHeightLod(tex, smp, cur, lod, invert);
    }

    // One secant refinement across the crossing. A binary search costs log2(N) more fetches for a
    // difference parallaxFade removes before it is ever visible.
    //
    // `min(denom, -1e-8)`, not `max(denom, 1e-5)`. The loop exits once `ray >= surf`, so `after <= 0`,
    // and it only continued while `ray < surf`, so `before > 0` — which makes `denom` STRICTLY
    // NEGATIVE on every exit path. A positive floor on it is not a divide-by-zero guard, it replaces
    // the real denominator with +1e-5, drives `w` large and negative, and clamps it to 0. That is
    // exactly what happened here: `w` was identically zero, `mix(cur, prev, 0)` returned `cur`, and
    // the refinement was dead code for every fragment.
    //
    // The cost of that was not subtle. Without it the hit can only land on one of `steps` discrete
    // positions, always on the far side of the surface, so the relief was quantised AND biased half a
    // step too deep — and because the grid is a function of camera position, neighbouring fragments
    // crossed grid levels at different moments as the camera moved. That is the crawl, and it is what
    // turned every ring above into a visible seam.
    let after = surf - ray;
    let before = prevSurf - prevRay;
    let w = clamp(after / min(after - before, -1e-8), 0.0, 1.0);
    let hitUv = mix(cur, prev, w);
    return vec3<f32>(hitUv, parallaxHeight(tex, smp, hitUv, ddx, ddy, invert));
}

/**
 * Soft self-shadowing of the height field, 1 lit to 0 fully occluded.
 *
 * Marches from the hit point toward the light, looking for anything standing above the ray. A
 * blocker close to the hit shadows harder than a distant one, which is what turns a hard binary
 * test into the soft contact darkening the eye reads as depth.
 *
 * `lTan.z <= 0` means the light is below the tangent plane: the surface is already turned away, the
 * lambert term has gone to zero, and marching would be wasted work.
 */
fn parallaxShadow(tex: texture_2d<f32>, smp: sampler, uv: vec2<f32>,
                  lTan: vec3<f32>, h: f32, depth: f32, lod: f32, invert: bool) -> f32 {
    // Faded by the LIGHT's angle as well as the view's: a sun at the horizon has the same 1/cos
    // divergence the view does, and an unbounded shadow ray reaches texels with no relation to the
    // point it is meant to be shadowing.
    let d = depth * parallaxFade(lod) * parallaxGrazeFade(lTan.z);
    if (d <= 1e-7 || lTan.z <= 0.0) { return 1.0; }

    let pMax = parallaxRay(lTan, d);
    let steps = f32(POM_SHADOW_STEPS);
    // The ray climbs from the hit height to the top of the field, so the rise per step depends on
    // how deep the hit was: a hit at the very top has nothing above it and shadows nothing.
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
        // Explicit level, like the view march: this loop is a search too, and it must intersect the
        // same field the view ray did or the relief and its shadow disagree about where the surface is.
        let sampleH = parallaxHeightLod(tex, smp, uv + reach * f, lod, invert);
        let rayH = h + dh * f32(i);
        if (sampleH > rayH) {
            // Nearer blockers weigh more; the falloff is what keeps this soft rather than binary.
            occ = max(occ, (sampleH - rayH) * (1.0 - f));
        }
    }
    return clamp(1.0 - occ, 0.0, 1.0);
}
