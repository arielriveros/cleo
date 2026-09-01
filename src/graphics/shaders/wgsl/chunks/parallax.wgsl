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
 * The WORST texels per step the march may degrade to before the RAY is shortened instead.
 *
 * `parallaxSteps` asks for one step per texel and is capped at POM_MAX_STEPS. Past that cap the
 * request is simply not met: the ray keeps its full length and the step grows. Measured against this
 * file's own arithmetic, dispScale 0.05 at mip 0:
 *
 *     angle      1024 map     2048 map
 *     45 deg      1.00         1.60
 *     60 deg      1.38         2.77
 *     70 deg      2.19         4.38
 *     80 deg      4.28         8.55
 *
 * A step of eight texels walks clean over every feature in the height field, so the march reports the
 * first sample that happens to land under the ray rather than the first intersection — a hit far from
 * the fragment, in a direction that swings with the view. That is the grazing SMEAR, and no amount of
 * secant refinement fixes it: the bracket is already eight texels wide.
 *
 * So bound what cannot be sampled. Two things could give: the step count (POM_MAX_STEPS, which costs
 * fragments that are the cheapest in the frame to get wrong) or the ray's reach. Shortening the reach
 * is Drobot's "limit stop condition to the LOD level" stated as a length, and it is self-correcting:
 * the limit is in TEXELS, so it widens automatically with the mip as the surface minifies.
 *
 * 2, not 1. A bound equal to the target would clamp wherever the count is merely at its cap, which on
 * a 2048 map starts at 45 degrees and would take 38% of the relief off a moderate view. At 2 nothing
 * below ~60 degrees moves at all and the cap on undersampling is one octave — a bracket the secant
 * step still resolves well. It is the knob for this trade: lower is flatter and cleaner at grazing,
 * higher is deeper and streakier.
 */
const POM_MAX_TEXELS_PER_STEP: f32 = 2.0;
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
 * The world -> uv basis the march runs in: how far u and v move per unit of world displacement.
 *
 * NOT an orthonormal rotation, and that is the whole point of this revision. `parallaxToTangent` reads
 * it with three dot products, which is the RECIPROCAL (dual) basis' defining operation, not a
 * transpose that happens to need orthonormality. Written this way the frame is exact for any chart —
 * skewed, stretched, mirrored — instead of exact only for a square one.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE ORTHONORMAL VERSION SHEARED, and why it looked fine until the camera orbited.
 *
 * The previous frame took the chart's u axis and then FORCED `B = cross(n, T)`, i.e. perpendicular to
 * it. A uv chart is under no obligation to be perpendicular. Measured over the 3941 triangles of a
 * photogrammetry scan: |90 - angle(dP/du, dP/dv)| is 5 degrees median, 12.5 at p75, **23.9 at p90**,
 * 34.5 at p95 and 81.5 at worst — **31% of the mesh more than 10 degrees off square**.
 *
 * Forcing perpendicularity there does not shrink the offset, it ROTATES it, by an amount that depends
 * on where the view sits relative to the skew. Checked against the analytic offset
 * `-D * (v.T*, v.B*) / (v.n)`, on a p90 chart (24 degrees skew, 1.5 anisotropy) at a 60 degree view:
 *
 *     azimuth 30 deg:  0.4 degrees of direction error, magnitude 1.10x
 *     azimuth 75 deg: 28.7 degrees of direction error, magnitude 1.13x
 *
 * Same surface, same view angle, only the camera moved AROUND it. That is why zooming looked correct
 * while rotating or panning broke the illusion, and why it was worst on triangles turned away from the
 * camera: the offset grows as `tan(theta)`, so the same angular error covers more texels. The dual
 * form below is exact — 0.00 degrees, 1.000x — in every one of those cases, and reduces to exactly the
 * old frame on a square chart, so a cube, a plane and a sphere do not move at all.
 *
 * THE VERTEX TANGENT CANNOT FIX THIS, which is why this no longer prefers it. `Geometry
 * ._calculateTangents` stores `bitangent = cross(N, T) * w` — perpendicular BY CONSTRUCTION — so the
 * varying basis carries no skew to correct with. Skew lives only in the derivatives. (The weld it was
 * introduced alongside stays: `Geometry.weldSmooth` is worth having on its own, and it more than
 * halves the vertex count of a converted mesh.) If both are ever wanted at once, the change needed is
 * on the CPU: store the accumulated dP/dv instead of a forced perpendicular, which `_calculateTangents`
 * already computes for its handedness test and then throws away.
 *
 * Built from SCREEN-SPACE DERIVATIVES. Those measure the mapping this fragment actually has, where the
 * tangent varyings measure the mapping the exporter recorded — and the two disagree about skew, which
 * is the quantity that matters here. They are also the only source that does not need a sign
 * convention: chunks/modelVarying.wgsl negates the bitangent for the green-down normal-map decode and
 * src/terrain/terrain.ts pushes [0,0,-1] to cancel it, so `tbn[1]` means the opposite thing on a mesh
 * and on terrain. Nothing below reads it.
 *
 * CALL THIS IN UNIFORM CONTROL FLOW — above every per-fragment branch, exactly like the gradients.
 * `dpdx`/`dpdy` carry the same rule `textureSample` does, and a call sited below a per-fragment early
 * return puts them in non-uniform flow. naga's validator lets that through; Dawn's does not, and a
 * module Dawn rejects takes its pipeline, its bind groups and the whole pass down with it.
 *
 * `tbn` itself is left untouched for normal-map decoding; only its normal is read here.
 */
struct ParallaxBasis {
    /**
     * World -> uv. Columns 0 and 1 are the reciprocal basis scaled by `worldPerUv`, so
     * `dot(dir, frame[0])` is the u-rate; column 2 is the shading normal, oriented to the eye.
     *
     * Deliberately NOT orthonormal: a skewed chart has non-perpendicular duals and forcing them square
     * is what rotated the offset. Do not "fix" this by normalising the columns.
     */
    frame: mat3x3<f32>,
    /**
     * World units spanned by ONE UV UNIT, isotropic-equivalent — `sqrt(|dP/du| * |dP/dv|)`.
     *
     * The number that decides whether a depth expressed in uv means millimetres or metres, and what
     * lets a material author relief in WORLD units and read the same on a cube, on tiled ground and on
     * a photogrammetry scan. Measured on a scanned branch whose 0..1 atlas covers the whole 62-unit
     * object: 47.97 — so a default depth of 0.05 uv asked for 2.4 units of relief on a branch 12.7
     * units thick, and the march reached across the atlas for texels belonging to its far side.
     *
     * The geometric mean, matching `parallaxFade`/`parallaxLodRaw`: `max` is the right reading when
     * asking whether something aliases on either axis, and the wrong one for "how big is this chart".
     */
    worldPerUv: f32,
};

fn parallaxFrame(fragPos: vec3<f32>, du1: vec2<f32>, du2: vec2<f32>,
                 tbn: mat3x3<f32>, toEye: vec3<f32>) -> ParallaxBasis {
    let dp1 = dpdx(fragPos);
    let dp2 = dpdy(fragPos);

    // THE CHART'S OWN AXES, as LINEAR COMBINATIONS of the derivatives. Invert the chain rule
    //
    //     dp1 = dP/du * du1.x + dP/dv * du1.y      dp2 = dP/du * du2.x + dP/dv * du2.y
    //
    // and the 2x2 solve falls out with `det` as its only denominator, so multiplying through by `det`
    // leaves two vectors carrying the chart's full shape — direction, length AND the angle between
    // them — with no division and no cross product of the derivatives.
    //
    // Linear in `dpdx(fragPos)`, which matters: a cross product of two nearly-parallel derivative
    // vectors can land orders of magnitude below its own terms, and `fragPos` is a world position whose
    // per-pixel delta is already a difference of two nearly equal large numbers. Using one as a
    // DIRECTION put blocky per-2x2-quad noise into a flat cube face; using one as a SIGN flipped
    // between neighbouring quads and marched them in opposite directions. Both were reverted. The only
    // cross products below are of vectors that are already the size of their own result.
    let det = du1.x * du2.y - du2.x * du1.y;
    let tu = dp1 * du2.y - dp2 * du1.y;
    let bu = dp2 * du1.x - dp1 * du2.x;

    // `sqrt(|tu| * |bu|)`, NOT `pow(dot(tu,tu) * dot(bu,bu), 0.25)`.
    //
    // Algebraically the same; numerically not. `|tu|` is `|det| * |dP/du|` and `det` is a per-PIXEL
    // Jacobian, so `dot(tu, tu)` sits near 1e-12 on perfectly ordinary geometry and the PRODUCT of the
    // two lands near 1e-24 — under any floor written to catch an exact zero. Flooring it there does not
    // guard anything, it REPLACES a real value: measured, a chart that should report 1 reported 31623.
    // Taking the lengths first keeps every intermediate the size of its own inputs. Same trap as the
    // guards in `parallaxOcclusion` and the reverted `dot(t,t) < 1e-11`: an absolute threshold on a
    // per-pixel quantity is always wrong here.
    let worldPerUv = sqrt(length(tu) * length(bu)) / max(abs(det), 1e-30);

    // +z must face the camera: every march step divides by `vTan.z`, and a negative one aims the ray
    // into the surface instead of along it. Orient by the VIEW VECTOR, not by @builtin(front_facing) —
    // naga lowers that to gl_FrontFacing, whose sense depends on the winding the projection ends up
    // with, so the two backends can disagree about the same triangle. The view vector cannot disagree
    // with itself, and this covers a double-sided material's back faces for free.
    let nShade = normalize(tbn[2]);
    let n = select(-nShade, nShade, dot(nShade, toEye) >= 0.0);

    // The reciprocal basis, in the SHADING normal's plane.
    //
    // `tp`/`bp` are the chart axes with the normal component removed — glTF's, UE's and Unity's habit
    // of resolving the tangent frame against the shading normal rather than the geometric one, so the
    // relief agrees with the lighting on a smooth-shaded surface. `jac` is the signed area they span,
    // and it carries the chart's HANDEDNESS, so a mirrored uv island needs no separate correction:
    // verified exact against the analytic offset for either sign of `det` and either handedness.
    let tp = tu - n * dot(n, tu);
    let bp = bu - n * dot(n, bu);
    let jac = dot(cross(tp, bp), n);

    // A chart with no measurable area — a degenerate triangle, a collapsed derivative quad, a fragment
    // whose uv does not move. Zero columns give a zero tangent view direction, so no offset is applied:
    // the right answer for a surface with no measurable texture mapping, and never a NaN. Relative to
    // nothing, but `jac` is a product of two quantities already floored above, so an exact-zero test is
    // the only one that can misfire neither way.
    if (abs(jac) < 1e-30) {
        return ParallaxBasis(mat3x3<f32>(vec3<f32>(0.0), vec3<f32>(0.0), n), worldPerUv);
    }

    // `worldPerUv` folds in here so `vTan.xy` is already in the units `parallaxRay` multiplies by a
    // depth: with a world depth D = depth_uv * worldPerUv, the reference's `vTan.xy / vTan.z * depth`
    // comes out as `-D * (v.T*, v.B*) / (v.n)`, which is the exact offset.
    let k = worldPerUv * det / jac;
    return ParallaxBasis(mat3x3<f32>(cross(bp, n) * k, cross(n, tp) * k, n), worldPerUv);
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
 * The authored depth, in UV, whichever unit it was written in.
 *
 * `dispScale` was UV-only, and a UV depth is only meaningful once you know what a UV unit is worth.
 * On a tiling material one repeat is a few centimetres and 0.05 is a sensible few millimetres of
 * relief; on an atlas-mapped scan one repeat is the whole object and the same number is metres. There
 * is no default that serves both, and nothing in the shader could have detected the difference —
 * which is why the control now carries its unit.
 *
 * `worldPerUv` comes from the frame, so this costs one divide and no extra derivatives.
 */
fn parallaxDepthUv(depth: f32, worldPerUv: f32, inWorld: bool) -> f32 {
    return select(depth, depth / max(worldPerUv, 1e-6), inWorld);
}

/**
 * The furthest the ray may travel, in UV, before the march can no longer sample its own path.
 *
 * `POM_MAX_STEPS` steps at `POM_MAX_TEXELS_PER_STEP` texels each, converted out of texels at the mip
 * being sampled. `max(dims.x, dims.y)` because a step must not overshoot on EITHER axis, which is the
 * one place in this file where the anisotropic maximum is the right reading rather than the geometric
 * mean — `parallaxFade` and `parallaxLodRaw` are asking a different question (can this fragment
 * resolve the field at all) and take the mean for that reason.
 */
fn parallaxReachLimit(dims: vec2<f32>, lod: f32) -> f32 {
    return f32(POM_MAX_STEPS) * POM_MAX_TEXELS_PER_STEP * exp2(lod) / max(max(dims.x, dims.y), 1.0);
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
    // Bounded AFTER the two fades, not before: the fades decide how deep the surface is, and this
    // decides how far a ray of that depth is allowed to travel before the step budget stops being
    // able to sample it. Applied here rather than at the call sites so every caller gets it and the
    // bound cannot drift from the `parallaxSteps` it is derived from. It composes with the caller's
    // own `parallaxBoundedDepth` for silhouette clipping — whichever is tighter wins.
    let d = parallaxBoundedDepth(vTan,
                                 depth * parallaxFade(lod) * parallaxGrazeFade(vTan.z),
                                 parallaxReachLimit(dims, lod));
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
