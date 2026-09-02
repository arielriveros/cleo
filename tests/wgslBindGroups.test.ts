import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { findResources } from '../tools/wgslLayout.mjs';
import { declaredGroupsOf, MAX_BIND_GROUPS } from '../src/graphics/rhi/webgpu/wgslBindings';

/**
 * A static sweep over every WGSL module the engine ships, for the one mistake WebGPU refuses to name.
 *
 * `maxBindGroups` is 4 and cannot be raised — the spec's default is Dawn's ceiling too. A shader that
 * declares `@group(4)` still COMPILES; the pipeline is what fails, and every message after that says
 * only "invalid due to a previous error", against the pass and the submitted command buffer rather
 * than the shader. That is how a fifth role group reached main: nothing on the WebGL2 path minds, and
 * the WebGPU console never names the file.
 */

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');

/** Every module, includes resolved, exactly as the loader composes them. */
function modules(): { name: string; source: string }[] {
    return readdirSync(WGSL)
        .filter(entry => entry.endsWith('.wgsl'))
        .map(entry => {
            const file = join(WGSL, entry);
            const source = resolveIncludes(readFileSync(file, 'utf-8'), dirname(file), {
                read: (p: string) => readFileSync(p, 'utf-8'),
                resolve: (dir: string, rel: string) => join(dir, rel),
            });
            return { name: entry, source };
        });
}

describe('every shader fits in the bind groups WebGPU has', () => {
    it.each(modules())('$name declares no group past the limit', ({ name, source }) => {
        const groups = findResources(source).map(r => r.group);
        expect(Math.max(-1, ...groups), name).toBeLessThan(MAX_BIND_GROUPS);
    });

    it.each(modules())('$name declares one resource per (group, binding)', ({ name, source }) => {
        // Group 3 is shared by two chunks that cannot see each other — chunks/shadows.wgsl owns 0-5 and
        // chunks/clusteredLights.wgsl takes 6 — so the collision this guards against is one edit away.
        const seen = new Map<string, string>();
        for (const resource of findResources(source)) {
            const slot = `${resource.group}.${resource.binding}`;
            expect(seen.get(slot) ?? resource.name, `${name} ${slot}`).toBe(resource.name);
            seen.set(slot, resource.name);
        }
    });

    it('reads the groups the same way the runtime does', () => {
        // `declaredGroupsOf` is what asks the pipeline for a layout per index, and it works on the raw
        // source rather than on the reflection — the two must agree, comments and all.
        for (const { name, source } of modules())
            expect(Math.max(-1, ...declaredGroupsOf(source)), name).toBeLessThan(MAX_BIND_GROUPS);
    });
});
