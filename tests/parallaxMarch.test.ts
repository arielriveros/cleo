import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The parallax march's secant refinement, guarded where nothing else could see it.
 *
 * This exists because of a bug that every gate in the repo passed. The refinement read
 *
 *     let w = clamp(after / max(after - before, 1e-5), 0.0, 1.0);
 *
 * and `after - before` is STRICTLY NEGATIVE on every exit path — the loop leaves once `ray >= surf`
 * (so `after <= 0`) and only continued while `ray < surf` (so `before > 0`). `max()` therefore
 * replaced the real denominator with `+1e-5`, `w` clamped to 0, and `mix(cur, prev, 0)` returned the
 * raw step. The refinement was dead code for every fragment, the hit was quantised to the march grid
 * and biased half a step too deep, and the surface crawled as the camera moved.
 *
 * `harness:mesh`, `harness:pass` and `harness:backenddiff` were all green throughout, and that is the
 * point worth remembering: a recorded baseline can only detect drift FROM the recording. It cannot
 * tell you the recording was already wrong. Only an invariant that does not depend on a stored image
 * can, which is what these are.
 */

const CHUNKS = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks');
const read = (f: string) => readFileSync(join(CHUNKS, f), 'utf-8');

/**
 * There used to be two marches — terrain carried its own over the blended four-layer field, and the
 * pair were kept twins by a test asserting their refinements were textually identical. Terrain no
 * longer displaces, so `parallaxOcclusion` is the only one left and that twin check went with it.
 */
const MARCHES: [string, string][] = [
    ['parallax.wgsl', 'parallaxOcclusion'],
];

/** Pull a `const NAME: type = value;` out of a WGSL source, as a number. */
const constant = (src: string, name: string): number => {
    const m = code(src).match(new RegExp('const\\s+' + name + '\\s*:\\s*\\w+\\s*=\\s*(-?[\\d.]+)'));
    expect(m, `${name} not found`).not.toBeNull();
    return Number(m![1]);
};

/** Strip line comments so prose about `max(...)` cannot satisfy or break a source assertion. */
const code = (src: string) => src.replace(/\/\/[^\n]*/g, '');

describe('the secant refinement is guarded on the side its denominator is actually on', () => {
    for (const [file, fn] of MARCHES) {
        it(`${file} (${fn}) divides by a negative-guarded denominator`, () => {
            const src = code(read(file));

            // The refinement line, whatever the local variable is called (`w` here, `t` there).
            const refine = src.match(/clamp\(\s*after\s*\/\s*(.+?),\s*0\.0,\s*1\.0\s*\)/s);
            expect(refine, `no secant refinement found in ${file}`).not.toBeNull();

            const denominator = refine![1];
            expect(
                denominator,
                `${file}: the denominator is (after - before), which is STRICTLY NEGATIVE whenever the ` +
                `march crossed the surface. Flooring it with max(..., +eps) does not guard a divide by ` +
                `zero — it replaces the value, pins the weight to 0 and disables the refinement ` +
                `entirely. Guard with min(..., -eps).`,
            ).toMatch(/min\(/);
            expect(denominator, `${file}: guard must clamp toward negative`).toMatch(/-\s*1e-/);
            expect(denominator, `${file}: max() on this denominator is the bug this test exists for`)
                .not.toMatch(/max\(/);
        });
    }
});

describe('nothing in the march quantises on a camera-relative threshold', () => {
    /**
     * `vTan.z` is `h / sqrt(d^2 + h^2)` on flat ground, so ANY threshold on it is a ring centred under
     * the camera and rigidly attached to it. A `floor()` there is a value discontinuity — 23 of them,
     * one of which (`mix(32, 8, 0.5) == 20` exactly) landed on the same cosine where the ray ratio was
     * clamped, stacking a step on a crease at d = sqrt(3)*h. That was the visible seam.
     */
    it('parallaxSteps returns a continuous (unfloored) count', () => {
        const src = code(read('parallax.wgsl'));
        const fn = src.match(/fn\s+parallaxSteps[^{]*\{([^}]*)\}/);
        expect(fn, 'parallaxSteps not found').not.toBeNull();
        expect(
            fn![1],
            'parallaxSteps must stay fractional: floor() makes the sampling grid 1/steps jump at every ' +
            'integer crossing, and each crossing is a ring at a fixed distance in front of the camera.',
        ).not.toMatch(/floor\(/);
    });

    it('parallaxRay saturates smoothly instead of clamping the ratio with min()', () => {
        const src = code(read('parallax.wgsl'));
        const fn = src.match(/fn\s+parallaxRay[^{]*\{([\s\S]*?)\n\}/);
        expect(fn, 'parallaxRay not found').not.toBeNull();
        expect(
            fn![1],
            'min(1/vTan.z, POM_MAX_RATIO) creases where the branches meet (vTan.z = 0.5, i.e. ' +
            'd = sqrt(3) * camera height) — a slope discontinuity at a fixed distance ahead of the ' +
            'viewer. Saturate smoothly instead.',
        ).not.toMatch(/min\(/);
    });
});

describe('the secant step itself', () => {
    /**
     * The arithmetic the shader performs, in isolation. `after <= 0` (the sample that overshot) and
     * `before > 0` (the one before it); the weight is the fraction of the way BACK toward `prev`.
     */
    const weight = (after: number, before: number) => {
        const denom = Math.min(after - before, -1e-8);
        return Math.min(Math.max(after / denom, 0), 1);
    };

    it('lands strictly between the bracketing samples', () => {
        const w = weight(-0.25, 0.75);
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThan(1);
    });

    it('recovers the exact crossing of a linear field', () => {
        // A surface crossed 30% of the way back from the overshooting sample toward the previous one.
        expect(weight(-0.3, 0.7)).toBeCloseTo(0.3, 12);
        expect(weight(-0.9, 0.1)).toBeCloseTo(0.9, 12);
    });

    it('keeps the overshooting sample when the crossing is exactly on it', () => {
        expect(weight(0, 1)).toBe(0);
    });

    it('is never zero for a genuine bracket — the shape of the original bug', () => {
        // Every one of these produced 0 under `max(after - before, 1e-5)`.
        for (const [after, before] of [[-0.1, 0.9], [-0.5, 0.5], [-0.01, 0.99], [-0.99, 0.01]]) {
            expect(weight(after, before), `bracket ${after}/${before} collapsed to the raw step`)
                .toBeGreaterThan(0);
        }
    });

    it('degenerates safely when there is no bracket at all', () => {
        expect(Number.isFinite(weight(0, 0))).toBe(true);
    });
});

/**
 * The offset actually reaches the reference.
 *
 * These exist because the damping that made POM read as flat was invisible to every gate in the repo
 * AND to the doc comment sitting on top of it, which asserted a `1/cos` asymptote the code never came
 * within 30% of. The bug was a soft-min whose ceiling sat below its own operating range: `1/cos` is
 * >= 1 everywhere, so blending it against a ceiling of 2 never had a small argument to select and the
 * whole function collapsed to a near-constant in [0.894, 2.0]. Nothing about the source LOOKS wrong.
 * Only evaluating it does, which is what these do.
 */
describe('parallaxRay tracks 1/cos rather than saturating inside its own domain', () => {
    const src = () => read('parallax.wgsl');

    /** The shader's ratio, in JS, read from the shader's own constant. */
    const ratio = (cosTheta: number, R: number) => {
        const inv = 1 / Math.max(cosTheta, 1e-3);
        const a = inv * inv, b = R * R;
        return (inv * R) / Math.sqrt(Math.sqrt(a * a + b * b));
    };

    it.each([[1, 0.02], [Math.cos(Math.PI / 4), 0.02], [Math.cos(Math.PI / 3), 0.02],
             [Math.cos(5 * Math.PI / 12), 0.03]])(
        'is within tolerance of 1/cos at cos=%f', (c, tol) => {
            const R = constant(src(), 'POM_MAX_RATIO');
            const err = Math.abs(ratio(c, R) - 1 / c) / (1 / c);
            expect(err, `ratio ${ratio(c, R).toFixed(3)} vs 1/cos ${(1 / c).toFixed(3)}`)
                .toBeLessThan(tol);
        });

    it('still saturates near grazing, so a near-tangent view cannot smear a whole texture', () => {
        const R = constant(src(), 'POM_MAX_RATIO');
        // 88 degrees: 1/cos is ~28.6, and the offset must be nowhere near that.
        expect(ratio(Math.cos(88 * Math.PI / 180), R)).toBeLessThan(R * 1.01);
    });

    it('keeps the ceiling above the range it is meant to be a ceiling FOR', () => {
        // The whole shape of the original bug in one number. With R = 2 the ratio at normal incidence
        // was 0.894 — under-parallaxed head-on, by the thing whose entire job was to bound the
        // grazing case. A ceiling below ~4 cannot help but bite in the middle of the domain.
        expect(constant(src(), 'POM_MAX_RATIO')).toBeGreaterThanOrEqual(4);
    });
});

describe('the fade attenuates depth only, and only at real minification', () => {
    it('parallaxSteps takes no fade — a one-step march is not occlusion mapping', () => {
        // Multiplying the step count by a footprint attenuation drove it to 1 well inside the band.
        // A single step has no bracket to refine, so it took the no-hit exit and returned the
        // full-depth offset with no intersection found: a hard smear dressed as occlusion.
        const fn = code(read('parallax.wgsl')).match(/fn\s+parallaxSteps\(([^)]*)\)[^{]*\{([^}]*)\}/);
        expect(fn, 'parallaxSteps not found').not.toBeNull();
        expect(fn![1], 'parallaxSteps must not accept a fade').not.toMatch(/fade/);
        expect(fn![2], 'parallaxSteps must not scale by a fade').not.toMatch(/fade/);
    });

    it('the fade band sits far enough out to survive normal viewing distance', () => {
        // POM_FADE_START is a mip level: half strength lands at 2^((start+end)/2) texels per pixel.
        // At 2.5/5.5 that was 16 texels/px, which on a 2 m camera over 256 texel/m ground is ELEVEN
        // METRES — the feature switched itself off across most of the surface it was asked for.
        const src = read('parallax.wgsl');
        const start = constant(src, 'POM_FADE_START');
        const end = constant(src, 'POM_FADE_END');
        expect(start, 'the fade must not begin before ~23 texels/pixel').toBeGreaterThanOrEqual(4);
        expect(end).toBeGreaterThan(start);
    });

    it('measures the footprint isotropically, not by its long axis', () => {
        // `max(len(ddx), len(ddy))` is the anisotropic maximum. On a ground plane it grows as
        // 1/cos^2, so it fired while the field was still resolvable across the short axis — and it
        // fired HARDER the flatter the view, compounding with parallaxGrazeFade instead of being
        // independent of it. The geometric mean is the isotropic-equivalent footprint.
        // The footprint derivation lives in parallaxLod now, which parallaxFade, the step count and
        // every explicit-level fetch all consume — one number, so they cannot disagree about the mip.
        // `parallaxLodRaw` explicitly: the derivation moved there when the floored `parallaxLod` became
        // a wrapper around it, and naming the function that actually holds the arithmetic keeps this from
        // passing by accident on a prefix match.
        const fn = code(read('parallax.wgsl')).match(/fn\s+parallaxLodRaw[^{]*\{([\s\S]*?)\n\}/);
        expect(fn, 'parallaxLodRaw not found').not.toBeNull();
        // The two axis lengths must be COMBINED (a product under a sqrt), never selected between.
        expect(fn![1], 'parallaxLod must combine the two axes, not pick the longer')
            .toMatch(/length\([^;]*?\)\s*\*\s*length\(/);
        expect(fn![1], 'the long axis alone is 1/cos^2 on a ground plane')
            .not.toMatch(/max\(\s*length\([^;]*?\)\s*,\s*length\(/);
    });
});

/**
 * The forward and deferred PBR chunks are twins. A parallax member added to one and not the other
 * makes the two paths shade differently with nothing to say so — the same failure mode the terrain
 * twin check used to guard, which is why it moves here rather than disappearing.
 */
describe('the two PBR chunks declare the same parallax state', () => {
    const members = (file: string) => {
        const src = code(read(file));
        return ['dispScale', 'hasDisplacementMap', 'invertHeight', 'clipSilhouette']
            .filter(m => new RegExp('\\n\\s*' + m + '\\s*:\\s*\\w+\\s*,').test(src));
    };

    it('both carry every parallax member — a member in one chunk and not the other is the bug', () => {
        expect(members('pbrGBuffer.wgsl')).toEqual(['dispScale', 'hasDisplacementMap', 'invertHeight', 'clipSilhouette']);
        expect(members('pbrForward.wgsl')).toEqual(members('pbrGBuffer.wgsl'));
    });

    it('both pass the invert flag into the march and the self-shadow', () => {
        for (const file of ['pbrGBuffer.wgsl', 'pbrForward.wgsl']) {
            const src = code(read(file));
            expect(src, `${file} must derive the invert flag`).toMatch(/u_material\.invertHeight\s*!=\s*0/);
            // Both calls, or a depth map renders with inverted relief lit by shadows cast from the
            // height map it is not.
            expect((src.match(/lod, invert\)/g) ?? []).length, `${file}: march + shadow`).toBe(2);
        }
    });
});

/**
 * Terrain treats a height map exactly as a standard material does: a parallax march AND the
 * height-aware blend. The march was removed once and restored; these pin both halves, because the two
 * read the same packed alpha and it is easy to keep one while quietly losing the other.
 */
describe('the terrain layer stack marches its height field', () => {
    const src = () => code(readFileSync(join(CHUNKS, 'terrainLayers.wgsl'), 'utf-8'));

    it('carries a per-layer depth and marches one shared ray', () => {
        // ONE ray through the blended field, not four independent ones: four offsets cannot stay
        // registered against each other or against the splat mask, which is read un-offset.
        expect(src()).toMatch(/u_dispScale0/);
        expect(src()).toMatch(/fn\s+marchTerrain/);
        expect(src(), 'depth is authored in TILED uv and converted to base uv').toMatch(/fn\s+blendedDepth/);
    });

    it('shares the standard material machinery rather than reimplementing it', () => {
        const s = src();
        for (const fn of ['parallaxFrame', 'parallaxToTangent', 'parallaxRay', 'parallaxFade'])
            expect(s, `terrain must use ${fn} from chunks/parallax.wgsl`).toMatch(new RegExp(fn));
    });

    it('drives the step count by the texel path, never by the fade', () => {
        // The fade divides the DEPTH, never the sampling density: multiplied into the step count it
        // reached 1 inside the band, and a one-step march is a single offset tap with no intersection.
        //
        // The count is the ray's uv path measured in TEXELS at the sampled mip, which is the quantity
        // that actually decides whether the march steps over features. `cos(view)` did not know the
        // depth scale, the tiling or the mip, which is why it undersampled at the horizon: 175 texels
        // of path walked in 32 steps is five and a half texels a step.
        const call = src().match(/parallaxSteps\(([^)]*)\)/);
        expect(call, 'parallaxSteps call not found').not.toBeNull();
        expect(call![1], 'no fade in the step count').not.toMatch(/fade/);
        expect(call![1], 'texels at the sampled mip').toMatch(/pMax[\s\S]*dims[\s\S]*lod/);
    });

    it('still reads the packed height for the height-aware blend', () => {
        const s = src();
        expect(s).toMatch(/fn\s+layerHeights/);
        expect(s).toMatch(/exp\(u_terrain\.u_heightBlend0/);
        expect(s, 'biased by the heights AT THE HIT, which is the point of marching').toMatch(/hit\.h/);
    });

    it('honours the depth-map invert per layer, as a standard material does', () => {
        expect(src()).toMatch(/u_invertHeight0/);
    });
});

describe('a clipped material is depth-bounded', () => {
    it('parallaxBoundedDepth exists and caps the lateral travel', () => {
        // The clipped band and the relief depth are the SAME quantity — the band is how far the ray
        // walks before leaving the face — so an unbounded `tan(t) * dispScale` reaches ~30% of a face
        // at 67 degrees, and a cube losing a third of a face to a discard reads as being cut apart.
        const src = code(read('parallax.wgsl'));
        expect(src).toMatch(/fn\s+parallaxBoundedDepth/);
        expect(src, 'a ceiling in UV, not in multiples of depth').toMatch(/const\s+POM_CLIP_REACH/);
    });

    it('both chunks bound the depth only when clipping, and shadow the same field', () => {
        for (const file of ['pbrGBuffer.wgsl', 'pbrForward.wgsl']) {
            const src = code(read(file));
            expect(src, `${file} must bound the depth`).toMatch(/parallaxBoundedDepth\([\s\S]{0,80}POM_CLIP_REACH/);
            expect(src, `${file}: bounded only for a clipped material`)
                .toMatch(/select\(u_material\.dispScale,[\s\S]{0,160}clipSilhouette != 0\)/);
            // The self-shadow must march the SAME field the view ray did, or the relief and its
            // shadow disagree about how deep the surface is.
            expect((src.match(/lod, invert\)/g) ?? []).length, `${file}: march + shadow`).toBe(2);
            expect(src, `${file}: shadow uses the bounded depth`).toMatch(/lTan, hit\.z, depth, lod, invert\)/);
        }
    });
});
