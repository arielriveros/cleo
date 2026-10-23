import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Integer operations that are valid WGSL, translate without complaint, and fail only on WebGL2.
 *
 * Both were found writing the SSIL trace (ssil.wgsl), which keeps a 32-sector bitmask in a u32.
 *
 * 1. naga 29 writes `countOneBits`, `reverseBits`, `extractBits` and `insertBits` as GLSL `bitCount`,
 *    `bitfieldReverse`, `bitfieldExtract` and `bitfieldInsert` whatever the target version
 *    (back/glsl/writer.rs) — and GLSL ES 3.00 has none of them; they arrived in 3.10. The WebGL2
 *    program fails to compile while WebGPU, and every test that only translates, is fine.
 *
 * 2. `0xFFFFFFFFu >> n` came back as all-ones for EVERY n under ANGLE's D3D backend — the generated
 *    `4294967295u >> (32u - count)` is correct GLSL, and the shift still behaved like an arithmetic
 *    one on a signed -1. Nothing errors: each sample of the trace silently became a full hemisphere.
 *    Build such a mask up instead: `(1u << n) - 1u`.
 */

const WGSL_DIR = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');

function wgslFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return wgslFiles(path);
        return entry.name.endsWith('.wgsl') ? [path] : [];
    });
}

/** Source with comments stripped, so prose that names a builtin does not fail the rule. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const ES310_BUILTINS = /\b(countOneBits|reverseBits|extractBits|insertBits)\s*\(/g;
const ALL_ONES_SHIFTED_DOWN = /0x[fF]{8}u?\s*>>/g;

describe('WGSL integer operations WebGL2 can run', () => {
    const files = wgslFiles(WGSL_DIR);

    it('finds the shader tree', () => {
        expect(files.length).toBeGreaterThan(40);
    });

    it.each(files.map(f => [f.slice(WGSL_DIR.length + 1), f]))('%s', (_name, path) => {
        const source = code(readFileSync(path, 'utf-8'));
        expect(source.match(ES310_BUILTINS) ?? [], 'builtins GLSL ES 3.00 does not have').toEqual([]);
        expect(source.match(ALL_ONES_SHIFTED_DOWN) ?? [], 'an all-ones literal shifted right').toEqual([]);
    });
});
