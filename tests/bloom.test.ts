import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Bloom is GL-bound and so mostly out of scope for this DOM-free suite (see the policy note in
// vitest.config.ts). What IS worth pinning is the class of failure this pass has actually shipped
// twice: a bright pass that is mathematically incapable of emitting anything, and kill switches that
// silence it without any error. Both look identical from the outside — a black image — and neither
// trips a compile error, a type error, or a GL warning.

const SRC = join(__dirname, '..', 'src');
const renderer = readFileSync(join(SRC, 'graphics', 'renderer.ts'), 'utf8');
const bloomShader = readFileSync(join(SRC, 'graphics', 'shaders', 'screen', 'bloom.fs'), 'utf8');
const downsampleShader = readFileSync(join(SRC, 'graphics', 'shaders', 'screen', 'bloomDownsample.fs'), 'utf8');
const upsampleShader = readFileSync(join(SRC, 'graphics', 'shaders', 'screen', 'bloomUpsample.fs'), 'utf8');

/** Body of a `private _name(...)` method, so a uniform upload can be attributed to its own pass. */
function methodBody(source: string, name: string): string {
    const at = source.indexOf(`private ${name}(`);
    expect(at, `method not found: ${name}`).toBeGreaterThan(-1);
    const open = source.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
}

describe('bloom bright-pass threshold space', () => {
    it('measures luminance AFTER exposure', () => {
        // The bug this guards: the bright pass reads pre-exposure scene-linear radiance, but the
        // threshold is authored as a display-referred number. The engine's albedo/PI diffuse puts a
        // white surface under a white light at ~0.3 radiance (which is why the default exposure is
        // ~2), so comparing it against the default threshold of 1.0 gave contribution == 0 for
        // essentially every pixel. Bloom was black no matter what threshold, knee, intensity or
        // exposure were set to — the whole control group was inert.
        expect(bloomShader).toMatch(/uniform float u_exposure/);
        expect(bloomShader).toMatch(/luma = dot\(color \* u_exposure/);
    });

    it('still scales the UN-exposed colour', () => {
        // Only the decision of how much to extract is made in exposed terms. The emitted bloom must
        // stay in pre-exposure linear, because composer.fs adds it to the pre-exposure scene and
        // present.fs applies exposure once, to the sum. Multiplying here as well would double-expose
        // every bloomed pixel.
        expect(bloomShader).toMatch(/brightColor = vec4\(color \* contribution \* mask, 1\.0\);/);
    });

    it('is fed the exposure by the bloom pass itself', () => {
        // A uniform declared and never uploaded reads as 0, which would make luma 0 and take bloom
        // straight back to black — the same failure with a different cause. Scope the check to
        // _bloomPass: the renderer uploads u_exposure in half a dozen other passes.
        const body = methodBody(renderer, '_bloomPass');
        expect(body).toContain("setUniform('u_exposure'");
        expect(body).toContain("setUniform('u_bloomMaskEnabled'");
    });
});

describe('bloom eligibility mask', () => {
    it('is bypassed when disabled', () => {
        // The mask lives in the scene buffer's alpha and only deferred-lit geometry, a baked
        // atmosphere sky and clouds can set it. Sprites, tilemaps, transparents and unlit "basic"
        // materials draw under a mask-preserving blend and *cannot*, so with the mask forced on they
        // are permanently ineligible — a silent no-op for any 2D or unlit project.
        expect(bloomShader).toMatch(/uniform bool\s+u_bloomMaskEnabled/);
        // `uv`, not fragTexCoord: this pass halves resolution, so the mask has to be read on the same
        // snapped source block as the colour or the two disagree along every edge.
        expect(bloomShader).toMatch(/mask = u_bloomMaskEnabled \? step\(0\.5, texture\(u_bloomMask, uv\)\.a\) : 1\.0;/);
    });

    it('defaults to off', () => {
        // Bloom over the whole image is the conventional default; the mask is an artistic filter.
        expect(renderer).toMatch(/_bloomMaskEnabled: boolean = false;/);
    });

    it('survives a settings round trip', () => {
        // Otherwise the toggle silently resets on every project load.
        expect(renderer).toContain('bloomMaskEnabled: this._bloomMaskEnabled,');
        expect(renderer).toContain('if (s.bloomMaskEnabled !== undefined)');
    });
});

describe('bloom diagnosability', () => {
    it('exposes the mask as a debug channel', () => {
        // "Bloom does nothing" is otherwise indistinguishable between an empty mask and a threshold no
        // pixel clears. Mode 2 renders the alpha channel as greyscale (debugView.fs), so this needs no
        // shader work — only the channel wiring, which is exactly what kept getting skipped.
        expect(renderer).toMatch(/'bloomMask'/);
        expect(renderer).toMatch(/case 'bloomMask':\s*tex = this\._sceneFBO\.colors\[0\];\s*mode = 2;/);
    });
});

describe('bloom pyramid grid alignment', () => {
    it('snaps every halving to the source 2x2 block', () => {
        // Viewport sizes are arbitrary and the pyramid halves with floor(), so an odd dimension gives
        // src = 2*dst + 1. Sampling at the raw fragTexCoord then drifts by (j + 0.5)/dst source
        // texels — a full texel by the far edge — and the drift beats against the source grid: sample
        // points land alternately on texel centres and boundaries, producing banding that worsens
        // toward the right/bottom with dark lines where a bright column is skipped outright.
        for (const [name, shader] of [['bloom.fs', bloomShader], ['bloomDownsample.fs', downsampleShader]] as const) {
            expect(shader, name).toMatch(/vec2 sourceBlockUV\(/);
            expect(shader, name).toMatch(/floor\(uv \* dstResolution\) \* 2\.0 \+ 1\.0\) \* srcTexelSize/);
            expect(shader, name).toMatch(/uv = sourceBlockUV\(fragTexCoord/);
        }
    });

    it('never samples the halving passes at the raw fragTexCoord', () => {
        // The whole point: a bare texture(..., fragTexCoord) in a pass that also halves resolution is
        // a point sample of half the source.
        expect(bloomShader).not.toMatch(/texture\(u_screenTexture, fragTexCoord\)/);
        expect(bloomShader).not.toMatch(/texture\(u_bloomMask, fragTexCoord\)/);
        expect(downsampleShader).not.toMatch(/vec2 uv = fragTexCoord;/);
    });

    it('feeds both grids from the renderer', () => {
        // sourceBlockUV needs the destination resolution; unset it reads 0 and floor(0) collapses
        // every texel onto the same source block.
        const body = methodBody(renderer, '_bloomPass');
        expect(body).toContain("setUniform('u_srcTexelSize'");
        expect((body.match(/setUniform\('u_dstResolution'/g) ?? []).length).toBe(2); // bright pass + downsample loop
    });

    it('gives the upsample tent a per-axis radius', () => {
        // One float derived from the source WIDTH, applied to both axes, made the vertical reach short
        // by the aspect ratio — a tent stretched sideways rather than an even spread.
        expect(upsampleShader).toMatch(/uniform vec2 u_filterRadius/);
        expect(upsampleShader).toMatch(/float x = u_filterRadius\.x;/);
        expect(upsampleShader).toMatch(/float y = u_filterRadius\.y;/);
        expect(renderer).toMatch(/BLOOM_FILTER_RADIUS \/ from\.width, Renderer\.BLOOM_FILTER_RADIUS \/ from\.height/);
    });

    it('sizes the half-res scratch buffers with integers', () => {
        // Framebuffer.resize stores its arguments verbatim and reports them back as `width`, so a raw
        // width/2 on an odd width left these at e.g. 645.5: a viewport truncated to 645 with a texel
        // size computed from 645.5.
        expect(renderer).not.toMatch(/_blur_FBOs\[\d\]\.resize\(width \/ 2/);
        expect(renderer).toMatch(/Math\.floor\(width \/ 2\)/);
    });
});
