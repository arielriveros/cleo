import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one WGSL rule a temporal resolve cannot break.
 *
 * Both resolves are a chain of per-fragment early returns — history invalid, reprojected off screen,
 * disoccluded — so almost every fetch sits in NON-UNIFORM control flow, where WGSL forbids the
 * derivative-taking `textureSample` and rejects the module outright.
 *
 * The reason this is worth a test rather than a comment: it is a hard compile error on the WGSL
 * backend and SILENTLY FINE in the GLSL the build generates for WebGL2. So a violation ships looking
 * perfectly correct, and is discovered only by whoever next opens the WebGPU build — where the module
 * fails to compile, the pipeline is invalid, and every draw recorded against it quietly does nothing.
 *
 * `cloudTemporalResolve.wgsl` states the rule in its own comments and had nothing enforcing it; that
 * is why it is covered here too.
 */

const SHADERS = join(__dirname, '../src/graphics/shaders/wgsl');

function read(name: string): string {
    return readFileSync(join(SHADERS, name), 'utf8').replace(/\r\n/g, '\n');
}

/** Source with comments stripped, so the prose explaining the rule does not trip it. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Every pass in the velocity chain, plus both temporal resolves.
 *
 * The chain is here and not just the resolves because the rule bit it from a different direction: a
 * per-fragment `continue` in `motionBlurTileMax`'s tile loop makes every LATER iteration non-uniform,
 * so the `textureSample` at the top of the body became illegal without a single early return in
 * sight. Naga, which validates at build time, accepts it; Dawn does not — so the build stayed green
 * and the pipeline came out invalid, with `velocity.tile` silently drawing nothing.
 *
 * These are all mip-less screen-sized targets, so level 0 is what implicit LOD resolved to anyway.
 * Requiring the explicit form across the whole family costs nothing and means adding a loop skip or an
 * early return to any of them later cannot reintroduce this.
 */
describe.each([
    ['taaResolve.wgsl'],
    ['cloudTemporalResolve.wgsl'],
    ['motionBlur.wgsl'],
    ['motionBlurTileMax.wgsl'],
    ['motionBlurNeighborMax.wgsl'],
    ['motionBlurVelocity.wgsl'],
])('%s', (name) => {
    const source = code(read(name));

    it('never calls the implicit-LOD textureSample', () => {
        // `textureSampleLevel` matches `textureSample` as a prefix, so the boundary matters.
        const bare = source.match(/\btextureSample\s*\(/g) ?? [];
        expect(bare).toEqual([]);
    });

    it('does sample, so the check above is not vacuous', () => {
        expect((source.match(/\btextureSampleLevel\s*\(/g) ?? []).length).toBeGreaterThan(0);
    });
});

describe('taaResolve.wgsl', () => {
    const source = read('taaResolve.wgsl');

    it('shares the depth linearization rather than redefining it', () => {
        // A second copy is a second place for the near/far convention to drift, and the disocclusion
        // test compares its output against a buffer motion blur linearizes with the other one.
        expect(source).toContain('#include "./chunks/depthLinearize.wgsl"');
        expect(source).not.toMatch(/fn\s+linearizeDepth\s*\(/);
    });

    it('rejects history on LINEARIZED depth, never on device depth', () => {
        // Device depth is so compressed toward 1.0 that a mesh at 20 m and the sky behind it differ by
        // thousandths: any epsilon loose enough to keep genuine same-surface neighbours also admits
        // the sky. The tolerance is relative for the matching reason — the same surface legitimately
        // changes depth under camera motion.
        expect(source).toContain('linearizeDepth(');
        expect(source).toContain('max(0.02 * linCur, 0.1)');
    });

    it('does not read the motion-blur opt-out flag', () => {
        // `.z` says "never blur this", not "this did not move". Reading it here would discard history
        // for those objects and ghost them; the encoder keeps their true velocity and TileMax skips
        // them instead. See chunks/objectVelocity.wgsl.
        expect(source).not.toMatch(/velocity\s*\.\s*z/);
    });
});

describe('motionBlur.wgsl', () => {
    const source = read('motionBlur.wgsl');

    it('shares the same depth linearization', () => {
        expect(source).toContain('#include "./chunks/depthLinearize.wgsl"');
        expect(source).not.toMatch(/fn\s+linearizeDepth\s*\(/);
    });

    it('applies the shutter itself, because the buffer no longer bakes it in', () => {
        // The velocity buffer is raw so TAA can reproject through it. Motion blur's per-pixel and
        // per-tile velocities must then agree about how long the shutter is, which is why both call
        // the same helper with the same uniforms rather than each scaling its own way.
        expect(source).toContain('#include "./chunks/motionBlurShutter.wgsl"');
        expect((source.match(/applyShutter\(/g) ?? []).length).toBe(2);
    });
});

describe('motionBlurTileMax.wgsl', () => {
    const source = read('motionBlurTileMax.wgsl');

    it('skips flagged texels without a per-fragment loop exit', () => {
        // `continue` here is what made the module invalid on Dawn. `select` reaches the same result —
        // a zero vector never beats `maxLen`, which starts at zero — with control flow that reconverges.
        expect(code(source)).not.toMatch(/continue/);
        expect(source).toContain('select(shuttered, vec2<f32>(0.0), raw.z > 0.5)');
    });

    it('applies the shutter before the magnitude compare', () => {
        // Scaling after the compare would pick the same winner, but CLAMPING after it would not: two
        // vectors that clamp to the same length must not be ordered by their pre-clamp magnitudes.
        const scaled = source.indexOf('applyShutter(');
        const compared = source.indexOf('if (l > maxLen)');
        expect(scaled).toBeGreaterThan(-1);
        expect(compared).toBeGreaterThan(scaled);
    });

    it('keeps flagged texels out of the tile', () => {
        // The property the old zeroed `.xy` provided implicitly: a flagged object must not pull a blur
        // onto its neighbours. Now that the encoder keeps its true velocity, the exclusion is explicit.
        expect(source).toContain('raw.z > 0.5');
    });
});
