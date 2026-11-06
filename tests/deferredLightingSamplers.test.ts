import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { findResources } from '../tools/wgslLayout.mjs';

/**
 * The sampled-texture budget a single shader stage has on the WebGL2 path.
 *
 * GLSL ES 3.00 guarantees 16 texture units to a fragment shader (`MAX_TEXTURE_IMAGE_UNITS`), and ANGLE on
 * D3D11 — every Windows browser — reports exactly that. A program over the limit compiles and then
 * fails to LINK, and a failed link here is a black frame with a console line, not an exception.
 *
 * The deferred lighting pass sits at the limit: the G-buffer and SSIL and SSR in group 0, two probe
 * slots with the BRDF LUT and the environment in group 2, the three shadow atlases and the light grid in
 * group 3. Anything it needs next has to make room first — merging two textures, or dropping one.
 */

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const MAX_TEXTURE_UNITS = 16;

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

function textureCount(source: string): number {
    return new Set(findResources(source).filter(r => r.kind === 'texture').map(r => r.name)).size;
}

describe('the WebGL2 texture-unit budget', () => {
    it.each(modules())('$name declares no more textures than a fragment stage can bind', ({ name, source }) => {
        expect(textureCount(source), name).toBeLessThanOrEqual(MAX_TEXTURE_UNITS);
    });

    it('counts the deferred lighting pass the way the header describes it', () => {
        // A drop below 16 is fine — update this number and the header. A rise cannot happen: the sweep
        // above fails first.
        const source = modules().find(m => m.name === 'deferredLighting.wgsl')!.source;
        expect(textureCount(source)).toBe(16);
    });
});
