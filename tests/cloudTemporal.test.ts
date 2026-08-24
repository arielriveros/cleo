import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The cloud temporal/noise work is GL-bound and so mostly out of scope for this DOM-free suite (see
// the policy note in vitest.config.ts). What IS testable is the part that silently produces a wrong
// image rather than an error: the Bayer table's coverage, and the fact that two independently
// written pieces of code (the renderer's constants and the shader's constants) have to agree.

const SRC = join(__dirname, '..', 'src');
const renderer = readFileSync(join(SRC, 'graphics', 'renderer.ts'), 'utf8');
// The cloud shaders are authored in WGSL now; the GLSL WebGL2 runs is generated from these at build
// time. Every assertion below moved with them, so they still pin the same behaviour — but against the
// source somebody edits rather than against generated text.
const WGSL = join(SRC, 'graphics', 'shaders', 'wgsl');
const resolveShader = readFileSync(join(WGSL, 'cloudTemporalResolve.wgsl'), 'utf8');
const cloudShader = readFileSync(join(WGSL, 'volumetricClouds.wgsl'), 'utf8');

/**
 * Pull an integer list out of a source file given the identifier that introduces it.
 *
 * Handles the TS form (`X = [ ... ]`) and both shader constructor forms — GLSL's
 * `X[16] = int[16]( ... )` and WGSL's `X = array<i32, 16>( ... )` — by starting at the `=` and
 * skipping any type prefix, which would otherwise parse as the list itself.
 */
function parseIntList(source: string, marker: string): number[] {
    const at = source.indexOf(marker);
    expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
    const body = source.slice(source.indexOf('=', at) + 1)
        .replace(/^\s*int\s*\[\s*\d+\s*\]/, '')
        .replace(/^\s*array\s*<[^>]*>/, '');
    const openParen = body.indexOf('(');
    const openBracket = body.indexOf('[');
    const open = openParen >= 0 && (openBracket < 0 || openParen < openBracket) ? openParen : openBracket;
    const close = body.indexOf(body[open] === '(' ? ')' : ']', open);
    return body.slice(open + 1, close).split(',').map(t => t.trim()).filter(Boolean).map(Number);
}

describe('Bayer subset ordering', () => {
    const order = parseIntList(renderer, 'CLOUD_BAYER_ORDER');

    it('covers every cell of the 4x4 block exactly once', () => {
        // The whole scheme rests on this: if a rank were duplicated or missing, some pixels would be
        // retraced twice per cycle and others would never be refreshed at all — the second group
        // would just hold reprojected history forever and drift.
        expect(order).toHaveLength(16);
        expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    });

    it('is duplicated verbatim in the resolve shader', () => {
        // The renderer picks the sub-position to trace and the shader independently decides which
        // pixels were traced. They index the same table from two different files; if they disagree,
        // every frame writes fresh samples into pixels the resolve thinks are history.
        const shaderOrder = parseIntList(resolveShader, 'BAYER_16');
        expect(shaderOrder).toEqual(order);
    });

    it('spreads consecutive frames across the block', () => {
        // Ordered dithering exists so the image fills in evenly. Consecutive ranks landing in
        // adjacent cells would sweep a visible refresh band across every block instead.
        const posOf = (rank: number) => {
            const i = order.indexOf(rank);
            return { x: i % 4, y: Math.floor(i / 4) };
        };
        for (let rank = 0; rank < 15; rank++) {
            const a = posOf(rank), b = posOf(rank + 1);
            const manhattan = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
            expect(manhattan, `ranks ${rank} and ${rank + 1} are adjacent`).toBeGreaterThan(1);
        }
    });
});

describe('cloud noise sampling', () => {
    it('no longer evaluates procedural FBM in the raymarch', () => {
        // The entire point of baking the volumes. A reintroduced fbm()/valueNoise() in this shader
        // would quietly undo the optimization while still looking correct.
        expect(cloudShader).not.toMatch(/\bfbm\s*\(/);
        expect(cloudShader).not.toMatch(/\bvalueNoise\s*\(/);
        expect(cloudShader).not.toMatch(/\bhash33\s*\(/);
    });

    it('dithers the ray start spatially, stepped per Bayer slot', () => {
        // The dither must NOT redraw at random every frame. The temporal resolve accumulates over a
        // 16-frame Bayer cycle, so a per-frame random offset never averages out — it is simply frozen
        // into history and reads as grain over everything, including the meshes underneath.
        expect(cloudShader).toMatch(/fn ign\(p: vec2<f32>\)/);
        expect(cloudShader).toMatch(/u_jitterSlot: i32/);
        expect(cloudShader).toMatch(/ign\(jitterPx\)/);
        expect(cloudShader).toMatch(/u_jitterSlot/);
        // u_time drives the wind, and must not creep back into the dither.
        expect(cloudShader).not.toMatch(/jitter\s*=[^;]*u_time/);
        expect(cloudShader).not.toMatch(/\bhash13\s*\(/);
    });

    it('keys the dither to the reconstructed full-resolution pixel, not gl_FragCoord', () => {
        // In temporal mode gl_FragCoord is the TRACE buffer's coordinate (1/4 per axis), so keying
        // off it gives one full-res pixel an unrelated offset every time its block comes up — the
        // exact thing the accumulation cannot converge.
        // WGSL has no ternary, so the same decision is an `if`. What matters is unchanged: the key is
        // the reconstructed full-resolution pixel, and it is gated on temporal mode.
        expect(cloudShader).toMatch(/jitterPx = floor\(uv \* u_cloud\.u_traceResolution \* 4\.0\)/);
        expect(cloudShader).toMatch(/u_cloud\.u_temporal != 0.*jitterPx = floor/);
    });

    it('samples both baked volumes', () => {
        expect(cloudShader).toMatch(/u_baseNoise_texture: texture_3d<f32>/);
        expect(cloudShader).toMatch(/u_detailNoise_texture: texture_3d<f32>/);
    });
});

describe('noise volume periods', () => {
    it('match between the renderer constants and how the shader is fed', () => {
        // The shader converts lattice space to UVW with 1/period. If the renderer baked with one
        // period and sampled with another the field would silently change scale — clouds would still
        // render, just at the wrong size, which is the kind of bug that survives review.
        const base = Number(/CLOUD_BASE_NOISE_PERIOD = (\d+)/.exec(renderer)?.[1]);
        const detail = Number(/CLOUD_DETAIL_NOISE_PERIOD = (\d+)/.exec(renderer)?.[1]);
        expect(base).toBeGreaterThan(0);
        expect(detail).toBeGreaterThan(0);
        expect(renderer).toContain('1 / Renderer.CLOUD_BASE_NOISE_PERIOD');
        expect(renderer).toContain('1 / Renderer.CLOUD_DETAIL_NOISE_PERIOD');
    });

    it('uses power-of-two volume sizes', () => {
        // texStorage3D wants clean dimensions, and a period that divides the size keeps the tiling
        // lattice aligned to texel centres.
        for (const key of ['CLOUD_BASE_NOISE_SIZE', 'CLOUD_DETAIL_NOISE_SIZE']) {
            const size = Number(new RegExp(`${key} = (\\d+)`).exec(renderer)?.[1]);
            expect(size).toBeGreaterThan(0);
            expect(Math.log2(size) % 1).toBe(0);
        }
    });
});

describe('temporal resolve depth rejection', () => {
    it('actually samples u_gDepth', () => {
        // This shipped as a dead uniform: declared with a comment promising disocclusion rejection,
        // bound by the renderer, and never read. The result was cloud radiance reprojected onto mesh
        // pixels and held there for up to 16 frames. A declaration alone must not pass again.
        expect(resolveShader).toMatch(/u_gDepth_texture: texture_2d<f32>/);
        const reads = resolveShader.match(/textureSample\(u_gDepth_texture/g) ?? [];
        expect(reads.length).toBeGreaterThan(0);
    });

    it('rejects history where geometry occludes the cloud slab', () => {
        // The load-bearing comparison: the slab-anchor distance against the distance to solid
        // geometry. Without it the reprojection has no idea a mesh moved in front of the clouds.
        expect(resolveShader).toMatch(/reachesSlab\s*=\s*slabT < sceneDist/);
        expect(resolveShader).toMatch(/if \(!reachesSlab\)/);
    });

    it('bounds the neighbourhood clamp by slab reachability, not a depth epsilon', () => {
        // At 1/16 density the 3x3 block neighbourhood spans ~24x24 screen pixels, so an unfiltered
        // min/max happily admits full cloud coverage from sky blocks next to a silhouette and then
        // "clamps" stale cloud on the mesh to itself.
        //
        // The filter must not be a device-depth epsilon either: depth is so compressed toward 1.0
        // that a mesh 20m out and the sky behind it differ by a few thousandths, so any usable
        // epsilon still admits the sky. Compare whether each ray reached the cloud layer instead.
        expect(resolveShader).toMatch(/nbReaches\s*=\s*slabT < geometryDistance/);
        expect(resolveShader).toMatch(/if \(nbReaches != reachesSlab\) \{ continue; \}/);
    });

    it('accumulates on traced pixels instead of replacing', () => {
        // Pure replacement is why the march dither never converged. A traced pixel must mix its new
        // sample over the clamped history.
        expect(resolveShader).toMatch(/TRACE_BLEND/);
        expect(resolveShader).toMatch(/mix\(history, traced, TRACE_BLEND\)/);
    });

    it('reconstructs traced-sample UVs against u_traceResolution, not u_resolution', () => {
        // The renderer sizes the trace buffer with ceil(w/4), so u_resolution is NOT
        // u_traceResolution * 4. Dividing by the wrong one puts every depth fetch a fraction of a
        // block away from the sample it describes, and the depth test then rejects valid neighbours
        // along every edge — the same trap the u_traceResolution uniform comment warns about.
        const fn = /fn traceSampleUV\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(resolveShader);
        expect(fn, 'traceSampleUV not found').not.toBeNull();
        expect(fn![1]).toContain('u_traceResolution * 4.0');
        // Anchored on a preceding character the longer name cannot supply. This read
        // /\bu_resolution\b/ until its two escapes were saved as literal backspace bytes, after which it
        // matched a control character followed by the name — never present, so it passed vacuously.
        expect(fn![1]).not.toMatch(/[^e]u_resolution/);
    });
});

describe('cloud composite upsample', () => {
    const upsampleShader = readFileSync(join(WGSL, 'cloudUpsample.wgsl'), 'utf8');

    it('decides occlusion at full resolution, not from the low-res alpha', () => {
        // One cloud texel covers a 2x2 screen block at scale 0.5 (4x4 at the low tiers) and its
        // occlusion came from a single depth sample at its centre. No filter can recover a silhouette
        // from that, so the composite re-runs the slab test per full-res pixel and hard-zeroes the
        // occluded ones. Without this the cloud halos every mesh and its edge crawls on the cloud grid.
        expect(upsampleShader).toMatch(/fn reachesSlab\(uv: vec2<f32>\) -> bool/);
        expect(upsampleShader).toMatch(/if \(!reachesSlab\(in\.uv\)\) \{ return vec4<f32>\(0\.0\); \}/);
    });

    it('gathers discrete texels and rejects the occluded ones', () => {
        // texelFetch, not texture(): the cloud targets are LINEAR-filtered, so a UV fetch would have
        // already blended neighbouring texels together before any weighting could reject them.
        expect(upsampleShader).toMatch(/textureLoad\(u_clouds_texture/);
        expect(upsampleShader).not.toMatch(/textureSample\(u_clouds_texture/);
        // Renormalising over the surviving texels is what stops a dark notch hugging each silhouette.
        expect(upsampleShader).toMatch(/sum \/ weightSum/);
    });

    it('carries no device-depth epsilon and no shared upsample include', () => {
        // The epsilon approach was removed: device depth is compressed so hard toward 1.0 that
        // separating a mesh from the sky behind it is not expressible as a relative tolerance. See the
        // same argument in cloudTemporalResolve.fs.
        expect(upsampleShader).not.toMatch(/TOLERANCE/);
        // The WGSL tree DOES use #include — for the shared fullscreen vertex chunk — so the check
        // narrows to what it was actually guarding: no shared UPSAMPLE helper sneaking back in.
        expect(upsampleShader).not.toMatch(/#include[^\n]*upsample/i);
        expect(existsSync(join(SRC, 'graphics', 'shaders', 'screen', 'depthAwareUpsample.glsl'))).toBe(false);
    });

    it('is the shader the renderer composites the low-res clouds with', () => {
        // Registration is a row in the renderer's `programs` table now, not an `addShader` call per
        // program — see the note there. The row is still what says this shader is wired up at all.
        expect(renderer).toMatch(/\['cloudUpsample',\s+CloudUpsampleProgram\]/);
        expect(renderer).toContain("this._shaderManager.bind('cloudUpsample')");
        // The slab test needs the layer bounds and the camera, or it silently always passes.
        expect(renderer).toContain("setUniform('u_slabBottom'");
        expect(renderer).toContain("setUniform('u_slabTop'");
    });
});

describe('premultiplied alpha in the temporal resolve', () => {
    it('clamps colour and coverage in unpremultiplied space', () => {
        // GLSL clamp on a vec4 is per-component, so clamping a premultiplied sample can raise rgb
        // toward hi while dropping a toward lo, leaving rgb > a — a colour its own alpha cannot
        // represent, which composites as a bright fringe along every cloud edge.
        expect(resolveShader).toMatch(/fn clampSample\(s: vec4<f32>, b: ClampBounds\)/);
        expect(resolveShader).toMatch(/fn unpremultiply\(s: vec4<f32>\) -> vec3<f32>/);
        expect(resolveShader).toMatch(/return vec4<f32>\(c \* a, a\);/);
        // No raw vec4 clamp against premultiplied bounds may remain.
        expect(resolveShader).not.toMatch(/clamp\([^)]*,\s*lo,\s*hi\)/);
    });
});

describe('bloom mask blend state', () => {
    it('never restores the blend func with the non-separate form', () => {
        // The scene buffer's alpha is the bloom-eligibility mask, preserved by the SEPARATE default
        // blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ZERO, ONE). Three passes used to "restore
        // the pipeline default" with a bare gl.blendFunc, which also overwrites the ALPHA factors —
        // and since all three run in post-processing, the wrong state survived into the next frame and
        // sky fog / transparents / sprites / gizmos then eroded the mask instead of preserving it.
        expect(renderer).not.toMatch(/gl\.blendFunc\(gl\.SRC_ALPHA/);
        expect(renderer).toMatch(/private _restoreDefaultBlend\(\): void \{\s*gl\.blendFuncSeparate\(gl\.SRC_ALPHA, gl\.ONE_MINUS_SRC_ALPHA, gl\.ZERO, gl\.ONE\);/);
    });

    it('does not let a quality tier destroy the authored bloom intensity', () => {
        // Tier `low` disables bloom, which zeroes the live intensity; re-selecting a tier with bloom
        // used to restore a hardcoded 0.6 and silently discard whatever the user had set.
        expect(renderer).toContain('_bloomIntensityUser');
        expect(renderer).not.toMatch(/Math\.max\(this\._bloomIntensity, 0\.6\)/);
    });
});
