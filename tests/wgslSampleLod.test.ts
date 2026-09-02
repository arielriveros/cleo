import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * `textureSample` in non-uniform control flow is a hard WGSL error — and nothing else here would notice.
 *
 * It needs an implicit derivative, which is only defined while every invocation in the quad is still
 * running together. Inside a loop, or after an early `return`, they are not. WebGPU rejects the whole
 * module; the pipeline built from it then reports nothing more useful than
 *
 *     [Invalid RenderPipeline "x"] is invalid due to a previous error
 *
 * and since one bad pipeline invalidates the command buffer, the entire frame is dropped and the
 * viewport goes BLACK. Meanwhile naga translates the same source to GLSL without complaint, so WebGL2
 * renders it correctly and every other test here — which checks bindings, layout and translation, never
 * validation — passes. `lensFlare.wgsl` shipped exactly that way.
 *
 * The fix is always `textureSampleLevel(..., 0.0)`, which costs nothing in a fullscreen pass: those
 * targets have no mip chain, so the implicit LOD would have resolved to 0 regardless.
 *
 * The catch that makes this worth automating is that the offending function need not look dangerous.
 * `lensFlare`'s helper was three lines with one sample in it; what made it illegal was the loop it was
 * CALLED from, in another function. So this follows calls, not just syntax.
 *
 * Limitation: analysis is per file, with `#include`d chunks not resolved. A chunk that samples and is
 * called from a loop in whichever module included it would not be caught here.
 */

const WGSL_DIR = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');

function wgslFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return wgslFiles(path);
        return entry.name.endsWith('.wgsl') ? [path] : [];
    });
}

/** Source with comments stripped, so a `textureSample` named in prose is not mistaken for code. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The brace-matched block starting at the `{` at or after `from`, as [start, end). */
function block(source: string, from: number): [number, number] | null {
    const open = source.indexOf('{', from);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return [open, i + 1];
    }
    return null;
}

/** Every `fn name(...) { ... }` in the module, as [name, body]. */
function functions(source: string): [string, string][] {
    const found: [string, string][] = [];
    const pattern = /\bfn\s+([A-Za-z0-9_]+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
        const body = block(source, pattern.lastIndex);
        if (body) found.push([match[1], source.slice(body[0], body[1])]);
    }
    return found;
}

/**
 * The spans of a function body where the quad may have diverged: every loop body, and everything after
 * a genuine early exit.
 *
 * "Genuine" matters. `return textureSample(...)` is the whole function and is perfectly uniform — the
 * sample sits INSIDE the returned expression, not after it — so the exit point is taken as the `;`
 * that ends the statement rather than the keyword.
 */
function divergentSpans(body: string): string[] {
    const spans: string[] = [];

    for (const keyword of [/\bfor\s*\(/g, /\bwhile\s*\(/g, /\bloop\s*\{/g]) {
        let match: RegExpExecArray | null;
        while ((match = keyword.exec(body))) {
            const found = block(body, match.index);
            if (found) spans.push(body.slice(found[0], found[1]));
        }
    }

    const exits = /\b(return|break|continue)\b/g;
    let exit: RegExpExecArray | null;
    while ((exit = exits.exec(body))) {
        const semicolon = body.indexOf(';', exit.index);
        // No terminator, or the statement runs to the end of the body: nothing follows it.
        if (semicolon === -1 || semicolon >= body.length - 2) continue;
        spans.push(body.slice(semicolon + 1));
    }

    return spans;
}

/**
 * Files whose branches are on UNIFORM values, where the analysis below cannot tell the difference.
 *
 * WGSL permits an implicit-LOD sample under a branch whose condition is uniform across the quad — naga
 * and WebGPU both run the uniformity analysis that proves it, and this test does not. The only case in
 * the tree is `channelPack`, whose chain of `if (index == n)` picks a sampler from a UNIFORM index
 * because WGSL cannot index samplers dynamically; its own header says as much.
 *
 * An entry here is a claim that every branch guarding a sample in that file is uniform. Do not add one
 * to silence a failure: the failure it would hide is a black viewport, on WebGPU only.
 */
const UNIFORM_BRANCHING = new Set(['channelPack.wgsl']);

const IMPLICIT_SAMPLE = /\btextureSample\s*\(/;
/** Calls to something other than the builtins and constructors, so a helper can be followed into. */
const CALL = /\b([a-z][A-Za-z0-9_]*)\s*\(/g;

describe('implicit-LOD sampling stays in uniform control flow', () => {
    const files = wgslFiles(WGSL_DIR);

    it('finds the shader tree at all', () => {
        // Guards the scanner: a moved directory would make every check below vacuously true.
        expect(files.length).toBeGreaterThan(40);
    });

    it.each(files.map(f => [f.slice(f.indexOf('wgsl') + 5), f] as const))(
        '%s samples safely wherever the quad may diverge', (name, path) => {
            if (UNIFORM_BRANCHING.has(name.split(/[\\/]/).pop() as string)) return;
            const source = code(readFileSync(path, 'utf-8'));
            const bodies = new Map(functions(source));

            // Functions reached from a divergent span, followed to a fixpoint: a helper is only as safe
            // as its most dangerous caller.
            const unsafe = new Set<string>();
            const seed = (text: string) => {
                let call: RegExpExecArray | null;
                CALL.lastIndex = 0;
                while ((call = CALL.exec(text)))
                    if (bodies.has(call[1])) unsafe.add(call[1]);
            };
            for (const body of bodies.values()) for (const span of divergentSpans(body)) seed(span);
            for (let i = 0; i < bodies.size; i++) {
                const before = unsafe.size;
                for (const name of [...unsafe]) seed(bodies.get(name) ?? '');
                if (unsafe.size === before) break;
            }

            const offenders: string[] = [];
            for (const [name, body] of bodies) {
                const spans = unsafe.has(name) ? [body] : divergentSpans(body);
                for (const span of spans) {
                    if (!IMPLICIT_SAMPLE.test(span)) continue;
                    offenders.push(unsafe.has(name)
                        ? `${name}() samples with an implicit LOD and is called from a loop or after an early exit`
                        : `${name}() samples with an implicit LOD inside a loop or after an early exit`);
                    break;
                }
            }

            expect(offenders,
                `${offenders.join('; ')} — use textureSampleLevel(..., 0.0). WebGPU rejects the module `
                + 'and the frame goes black; WebGL2 renders it fine, so nothing else here will tell you.')
                .toEqual([]);
        });
});
