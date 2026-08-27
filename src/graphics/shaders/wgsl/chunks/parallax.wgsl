// Parallax occlusion mapping: the tangent frame, the ray march, and the height-field self-shadow.
//
// Shared by the terrain layer stack (chunks/terrainLayers.wgsl, which marches a BLENDED field of
// four height maps and so carries its own loop) and by the standard PBR material chunks, which
// march a single one and use `parallaxOcclusion` below verbatim.
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

/** Loop bound. The count actually walked is view-angle and footprint dependent — see parallaxSteps. */
const POM_MAX_STEPS: i32 = 32;
/** Head-on, where the ray crosses little of the field per pixel and few samples suffice. */
const POM_MIN_STEPS: f32 = 8.0;
/** Lateral travel ceiling, in multiples of the depth. See parallaxRay. */
const POM_MAX_RATIO: f32 = 2.0;
/** Below this cos(view, normal) the effect is fully faded out; above POM_GRAZE_HI it is at full
 *  strength. See parallaxGrazeFade for why a footprint fade alone is not enough. */
const POM_GRAZE_LO: f32 = 0.02;
const POM_GRAZE_HI: f32 = 0.15;
/** Footprint, as log2(texels), where the effect starts fading out... */
const POM_FADE_START: f32 = 2.5;
/** ...and where it is gone. Both are mip levels. */
const POM_FADE_END: f32 = 5.5;
/** Steps in the self-shadow march. Shorter than the view march: it only has to find a blocker. */
const POM_SHADOW_STEPS: i32 = 8;

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
    // A fragment with no UV gradient (a degenerate triangle, a collapsed derivative quad) leaves
    // both vectors at zero. Clamping rather than dividing by that yields a zero basis, so the
    // tangent view direction comes out zero, so no offset is applied — the right answer for a
    // surface with no measurable texture mapping, and never a NaN.
    let invmax = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-12));
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
 * Callers scale both the depth AND the step count by this, so a distant fragment costs one
 * iteration and lands on the un-parallaxed uv.
 */
fn parallaxFade(ddx: vec2<f32>, ddy: vec2<f32>, dims: vec2<f32>) -> f32 {
    let px = max(length(ddx * dims), length(ddy * dims));
    return 1.0 - smoothstep(POM_FADE_START, POM_FADE_END, log2(max(px, 1.0)));
}

/**
 * The full-depth UV displacement of a ray.
 *
 * Offset-limited only in the LIMIT. The code this replaces used `vTan.xy` bare — which avoids the
 * grazing-angle blow-up by under-parallaxing at every angle, including the ones that were fine. The
 * true 1/Vz is right until it is not; the ceiling is what stops a near-tangent view smearing a
 * whole texture through one pixel.
 */
fn parallaxRay(vTan: vec3<f32>, depth: f32) -> vec2<f32> {
    // Saturated smoothly rather than clamped with `min`, because a `min` puts a CREASE at a fixed
    // camera-relative distance. On flat ground `vTan.z = h / sqrt(d^2 + h^2)`, so any threshold on it
    // is a ring centred under the camera and rigidly attached to it: `min(1/vTan.z, 2)` switches
    // branches at `vTan.z = 0.5`, i.e. `d = sqrt(3) * h`, always the same distance ahead and sliding
    // with the viewer. The value is continuous there but its slope jumps by 4 per unit cosine.
    //
    // This form holds both asymptotes — `1/vTan.z` head-on, `POM_MAX_RATIO` at grazing — with no kink
    // anywhere in between. The old `max(vTan.z, 0.05)` went with it: `1/0.05 = 20` is far above
    // POM_MAX_RATIO, so the outer `min` had already selected the constant and the guard could never
    // affect the result.
    let inv = 1.0 / max(vTan.z, 1e-3);
    let ratio = inv * POM_MAX_RATIO * inverseSqrt(inv * inv + POM_MAX_RATIO * POM_MAX_RATIO);
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
 * A ground plane is exactly where this bites, and exactly where terrain lives.
 *
 * The band is deliberately NARROW and close to zero. A generous one (fully faded below cos 0.4, say)
 * removes the starburst and every bit of visible relief along with it — a ground plane under a normal
 * game camera spends most of its screen area below that, so the feature would switch itself off
 * exactly where it was asked for. This kills the divergence and nothing else.
 */
fn parallaxGrazeFade(vz: f32) -> f32 {
    return smoothstep(POM_GRAZE_LO, POM_GRAZE_HI, vz);
}

/**
 * Steps to walk: more at grazing angles, where the ray crosses more of the field per pixel, and
 * fewer where the fade has already shrunk the depth there is to cross.
 *
 * FRACTIONAL on purpose. This used to be wrapped in `floor()`, which made the sampling grid
 * `dStep = 1/steps` jump every time the expression crossed an integer — 23 of them, each a ring at a
 * fixed camera-relative distance (see parallaxRay for why a threshold on vTan.z is a ring). Worse,
 * `mix(32, 8, 0.5)` is exactly 20, so one of those jumps landed precisely on the distance where
 * parallaxRay used to crease: a value discontinuity stacked on a slope discontinuity, at full effect
 * strength, always the same distance in front of the viewer.
 *
 * Keeping it fractional makes the grid vary continuously. Only the iteration COUNT stays discrete —
 * the loop still needs an integer bound — and the secant refinement makes the hit insensitive to that
 * to second order, so it no longer shows.
 */
fn parallaxSteps(vz: f32, fade: f32) -> f32 {
    return max(1.0, mix(f32(POM_MAX_STEPS), POM_MIN_STEPS, clamp(vz, 0.0, 1.0)) * fade);
}

/**
 * March a single height field. Returns the offset uv in xy and the height at the hit in z.
 *
 * Height is the texture's RED channel, matching how a displacement map is authored everywhere else
 * in the engine (Terrain's own layer docs call it "r = height 0..1"). A standard material binds its
 * displacement map to its own sampler; terrain does NOT use this function, because it marches a
 * blend of four fields and reads each one from the alpha of that layer's packed normal+height
 * texture. Same quantity, two different places to keep it.
 *
 * `1.0 - h` is the depth convention, and its absence was a real defect in the code this replaces.
 * The packed alpha is 1 at the TOP of the field; marched raw, the reference plane is the BOTTOM,
 * so the entire surface slides sideways instead of recessing into the geometry.
 */
fn parallaxOcclusion(tex: texture_2d<f32>, smp: sampler, uv: vec2<f32>,
                     ddx: vec2<f32>, ddy: vec2<f32>, vTan: vec3<f32>,
                     depth: f32, fade: f32) -> vec3<f32> {
    let d = depth * fade * parallaxGrazeFade(vTan.z);
    if (d <= 1e-7) {
        return vec3<f32>(uv, textureSampleGrad(tex, smp, uv, ddx, ddy).r);
    }

    let pMax = parallaxRay(vTan, d);
    let steps = parallaxSteps(vTan.z, fade);
    let dStep = 1.0 / steps;

    var ray = 0.0;                 // 0 at the geometric surface, 1 at the floor of the field
    var cur = uv;
    var surf = 1.0 - textureSampleGrad(tex, smp, cur, ddx, ddy).r;
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
        surf = 1.0 - textureSampleGrad(tex, smp, cur, ddx, ddy).r;
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
    return vec3<f32>(hitUv, textureSampleGrad(tex, smp, hitUv, ddx, ddy).r);
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
                  ddx: vec2<f32>, ddy: vec2<f32>, lTan: vec3<f32>,
                  h: f32, depth: f32, fade: f32) -> f32 {
    // Faded by the LIGHT's angle as well as the view's: a sun at the horizon has the same 1/cos
    // divergence the view does, and an unbounded shadow ray reaches texels with no relation to the
    // point it is meant to be shadowing.
    let d = depth * fade * parallaxGrazeFade(lTan.z);
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
        let sampleH = textureSampleGrad(tex, smp, uv + reach * f, ddx, ddy).r;
        let rayH = h + dh * f32(i);
        if (sampleH > rayH) {
            // Nearer blockers weigh more; the falloff is what keeps this soft rather than binary.
            occ = max(occ, (sampleH - rayH) * (1.0 - f));
        }
    }
    return clamp(1.0 - occ, 0.0, 1.0);
}
