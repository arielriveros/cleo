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
 * If a change here is truly needed: update these hashes, regenerate the Valley (tools/valley/build.mjs
 * restamps its compiledWgsl), and tell users their own custom materials need their inspector opened once.
 */
const FROZEN: Record<string, string> = {
    'chunks/pbrLighting.wgsl': 'ce051619af387f2b',
    'chunks/clusteredLights.wgsl': 'd7ab3d8bd1ae1012',
    'chunks/shadows.wgsl': '164d51c6903a0578',
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
