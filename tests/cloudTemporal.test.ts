import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The cloud temporal/noise work is GL-bound and so mostly out of scope for this DOM-free suite (see
// the policy note in vitest.config.ts). What IS testable is the part that silently produces a wrong
// image rather than an error: the Bayer table's coverage, and the fact that two independently
// written pieces of code (the renderer's constants and the shader's constants) have to agree.

const SRC = join(__dirname, '..', 'src');
const renderer = readFileSync(join(SRC, 'graphics', 'renderer.ts'), 'utf8');
const resolveShader = readFileSync(join(SRC, 'graphics', 'shaders', 'environment', 'cloudTemporalResolve.fs'), 'utf8');
const cloudShader = readFileSync(join(SRC, 'graphics', 'shaders', 'environment', 'volumetricClouds.fs'), 'utf8');

/**
 * Pull an integer list out of a source file given the identifier that introduces it.
 *
 * Handles both the TS form (`X = [ ... ]`) and GLSL's constructor form (`X[16] = int[16]( ... )`) by
 * starting at the `=` and skipping any `int[N]` type prefix — otherwise the array-size brackets in
 * the GLSL declaration parse as the list itself.
 */
function parseIntList(source: string, marker: string): number[] {
    const at = source.indexOf(marker);
    expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
    const body = source.slice(source.indexOf('=', at) + 1).replace(/^\s*int\s*\[\s*\d+\s*\]/, '');
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

    it('keeps hash13 for the per-frame ray-start dither only', () => {
        // That one must stay procedural: it wants fresh randomness every frame, which is exactly
        // what a cached field cannot provide.
        expect(cloudShader).toMatch(/float hash13\(/);
        const uses = cloudShader.match(/hash13\(/g) ?? [];
        expect(uses.length).toBe(2); // the definition and the single dither call site
    });

    it('samples both baked volumes', () => {
        expect(cloudShader).toMatch(/uniform sampler3D u_baseNoise/);
        expect(cloudShader).toMatch(/uniform sampler3D u_detailNoise/);
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
