import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The custom-material prelude is compiled from these files, and every stored custom material's WGSL is
 * hashed together with it (customShaders.ts `customWgslHash`): change one byte and every saved custom
 * material in every project stops binding on WebGPU until its inspector is opened (the Valley's Pond Water
 * vanishes). New shared WGSL goes in a chunk of its own (chunks/shIrradiance.wgsl, chunks/areaLights.wgsl).
 *
 * If a change here is truly needed: update these hashes, open the examples with custom materials in the desktop
 * editor so their compiledWgsl is stamped again, and tell users their own custom materials need their inspector
 * opened once.
 */
const FROZEN: Record<string, string> = {
    'chunks/pbrLighting.wgsl': 'ce051619af387f2b',
    'chunks/clusteredLights.wgsl': 'd7ab3d8bd1ae1012',
    // 2026-11-19: the shadow biases (a normal offset shaped by the light's angle, a world-unit step toward a spot
    // or point light) fixed shadows starting away from their casters. No bundled example stores custom WGSL.
    'chunks/shadows.wgsl': '2cfea08c9e5a1cdf',
    'clusteredLightsChunk.wgsl': '990df0e519e8aec4',
    'shadowsChunk.wgsl': '4ce12d8aa88ab346',
};

describe('the custom-material prelude', () => {
    for (const [file, hash] of Object.entries(FROZEN)) {
        it(`${file} is unchanged`, () => {
            const text = readFileSync(resolve(__dirname, '../src/graphics/shaders/wgsl', file), 'utf8').replace(/\r\n/g, '\n');
            expect(createHash('sha256').update(text).digest('hex').slice(0, 16)).toBe(hash);
        });
    }
});
