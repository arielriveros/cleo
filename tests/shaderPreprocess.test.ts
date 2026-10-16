import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs shared with the bundler config; it has no declarations.
import { preprocess, listVariants, resolveIncludes } from '../tools/shaderIncludes.mjs';
// @ts-expect-error -- same.
import { pruneDeadFunctions } from '../tools/wgslGlsl.mjs';

/**
 * The shader preprocessor exists so a program variant (a shadow filter, a stripped particle module) is
 * the same source with different defines instead of a second copy. Two properties matter beyond "the
 * right lines survive": naga's diagnostics must keep pointing at the right composed line, and anything
 * it does not understand must fail loudly instead of reaching naga as a stray `#`.
 */
describe('shader preprocess', () => {
    const live = (text: string, defines?: Record<string, number>) =>
        (preprocess(text, defines) as string).split('\n').map(l => l.trim()).filter(Boolean);

    it('keeps the taken branch of #if / #elif / #else', () => {
        const src = ['#if MODE == 0', 'a', '#elif MODE == 1', 'b', '#else', 'c', '#endif'].join('\n');
        expect(live(src, { MODE: 0 })).toEqual(['a']);
        expect(live(src, { MODE: 1 })).toEqual(['b']);
        expect(live(src, { MODE: 7 })).toEqual(['c']);
        expect(live(src)).toEqual(['a']); // an undefined name is 0, as in C
    });

    it('handles #ifdef, #ifndef, defined(), #define and #undef in order', () => {
        const src = ['#ifndef X', 'no-x', '#endif', '#define X', '#ifdef X', 'x', '#endif',
                     '#if defined(X) && !defined(Y)', 'x-not-y', '#endif', '#undef X', '#ifdef X', 'gone', '#endif'].join('\n');
        expect(live(src)).toEqual(['no-x', 'x', 'x-not-y']);
    });

    it('nests, and a dead outer block hides an inner one whatever it says', () => {
        const src = ['#if 0', '#if 1', 'inner', '#endif', '#else', 'outer-else', '#endif'].join('\n');
        expect(live(src)).toEqual(['outer-else']);
    });

    it('preserves the line count, so composed line numbers stay valid', () => {
        const src = ['a', '#if 0', 'b', '#endif', 'c'].join('\n');
        const out = preprocess(src) as string;
        expect(out.split('\n')).toHaveLength(5);
        expect(out.split('\n')[4]).toBe('c');
    });

    it('rejects what it cannot honour', () => {
        expect(() => preprocess('#if 1\na')).toThrow(/unterminated/);
        expect(() => preprocess('#endif')).toThrow(/without #if/);
        expect(() => preprocess('#if 1\n#else\n#elif 1\n#endif')).toThrow(/#elif after #else/);
        expect(() => preprocess('#pragma once')).toThrow(/unknown shader directive/);
        expect(() => preprocess('#if 1 +\n#endif')).toThrow(/parse/);
    });

    it('applies variant defines through resolveIncludes, to included chunks too', () => {
        const files: Record<string, string> = { '/c.wgsl': '#if FAST\nfast\n#else\nslow\n#endif' };
        const read = (p: string) => files[p];
        const resolve = (_d: string, r: string) => '/' + r.replace('./', '');
        const out = (defines?: object) => (resolveIncludes('#include "./c.wgsl"', '/', { read, resolve, defines }) as string)
            .split('\n').filter(l => l && !l.startsWith('//'));
        expect(out()).toEqual(['slow']);
        expect(out({ FAST: 1 })).toEqual(['fast']);
    });

    it('reads @variant declarations', () => {
        const src = '// @variant pcf CLEO_SHADOW_FILTER=0\n// @variant poisson.pom CLEO_SHADOW_FILTER=1 CLEO_POM\nfn x() {}';
        expect(listVariants(src)).toEqual([
            { tag: 'pcf', defines: { CLEO_SHADOW_FILTER: 0 } },
            { tag: 'poisson.pom', defines: { CLEO_SHADOW_FILTER: 1, CLEO_POM: 1 } },
        ]);
        expect(() => listVariants('// @variant a X\n// @variant a Y')).toThrow(/duplicate/);
    });
});

describe('pruneDeadFunctions', () => {
    const glsl = [
        '#version 300 es', '', 'struct Light {', '    vec3 color;', '};',
        'float used(float x) {', '    return helper(x);', '}', '',
        'float helper(float x) {', '    return x * 2.0;', '}', '',
        'float dead(float x) {', '    return x;', '}', '',
        'Light Light2(Light l) {', '    return l;', '}', '',
        'void main() {', '    Light l = Light(vec3(used(1.0)));', '    return;', '}', '',
    ].join('\n');

    it('keeps what main reaches, transitively, and drops the rest', () => {
        const out = pruneDeadFunctions(glsl) as string;
        expect(out).toContain('float used(');
        expect(out).toContain('float helper(');
        expect(out).not.toContain('float dead(');
        // A struct constructor call names the struct, not a function: it keeps nothing alive.
        expect(out).not.toContain('Light2(');
        expect(out).toContain('struct Light {');
        expect(out).toContain('void main() {');
    });

    it('leaves text it does not recognise untouched', () => {
        expect(pruneDeadFunctions('void notMain() {\n}\n')).toBe('void notMain() {\n}\n');
    });
});
