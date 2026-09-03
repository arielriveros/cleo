import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * A float literal larger than f32 can hold is a shader-creation error on WebGPU — and, like every trap
 * in `wgslSampleLod.test.ts`, it is one that NAGA DOES NOT SHARE.
 *
 * The two compilers disagree about what "too large" means. Tint converts the literal against the
 * type's limit BEFORE rounding it, so anything above 3.40282347e38 is rejected outright; naga rounds
 * to nearest first, so a decimal spelling of the maximum lands exactly on it and compiles. The result
 * is the worst possible failure shape: WebGL2 renders correctly, every test that checks bindings,
 * layout or translation passes, and the WebGPU build dies with
 *
 *     [Invalid RenderPipeline "taaResolve"] is invalid due to a previous error
 *
 * repeated once per frame, taking the whole command buffer with it. That is precisely how
 * `const F32_MAX: f32 = 3.4028235e38;` — a finiteness threshold written as the f32 maximum, which is
 * the natural way to write one — shipped and blanked the viewport.
 *
 * The lesson generalises past this one constant: a threshold does not need to BE the maximum to test
 * against it, so any such literal should be comfortably inside the range rather than at its edge.
 */

const WGSL_DIR = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');

/** The largest finite f32, as a double. Tint compares a literal against exactly this. */
const F32_MAX = 3.4028234663852886e38;

function wgslFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return wgslFiles(path);
        return entry.name.endsWith('.wgsl') ? [path] : [];
    });
}

/** Source with comments stripped, so the prose above does not fail its own rule. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Every decimal float literal in `source`.
 *
 * Exponent-or-fraction form only: a bare integer is an AbstractInt, which is converted under different
 * rules and cannot plausibly be written large enough to matter here. Hex float literals are skipped —
 * they name a bit pattern, so `0x1.fffffep+127` IS the maximum rather than a value that rounds to it.
 */
function floatLiterals(source: string): string[] {
    const stripped = source.replace(/0[xX][0-9a-fA-F.p+-]+/g, ' ');
    return stripped.match(/(?<![\w.])\d+(?:\.\d*)?[eE][+-]?\d+|(?<![\w.])\d+\.\d+/g) ?? [];
}

describe('every WGSL float literal fits in an f32', () => {
    const files = wgslFiles(WGSL_DIR);

    it('finds the shader tree', () => {
        expect(files.length).toBeGreaterThan(40);
    });

    it.each(files.map(f => [f.slice(WGSL_DIR.length + 1), f]))('%s', (_name, path) => {
        const oversized = floatLiterals(code(readFileSync(path, 'utf-8')))
            .filter(literal => Math.abs(Number(literal)) > F32_MAX);
        expect(oversized, `literals Tint will reject as out of range for f32: ${oversized}`).toEqual([]);
    });
});
