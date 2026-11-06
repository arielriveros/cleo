import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `Scene.environmentMap` is six 8-bit images of sRGB-encoded colour, and the engine has no sRGB texture
 * format to decode them on read — so every shader that reflects it has to decode it itself. The forward
 * path always did; the deferred fallback did not, and reflected the encoded values as light, about twice
 * too bright in the midtones. Both now apply the engine's own decode (`toLinear`, a 2.2 power).
 */

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const read = (file: string) => readFileSync(join(WGSL, file), 'utf-8');

describe('the scene environment map is decoded wherever it is reflected', () => {
    it('in the deferred fallback', () => {
        const src = read('deferredLighting.wgsl');
        const branch = src.slice(src.indexOf('u_envMapMode == 1'), src.indexOf('if (u_lighting.u_probeCount > 0)'));
        expect(branch).toMatch(/let env = pow\(textureSampleLevel\(u_envMap_texture[\s\S]*?vec3<f32>\(2\.2\)\)/);
    });

    it('in the forward materials, unless the cube is a linear probe capture', () => {
        const src = read('chunks/pbrForward.wgsl');
        expect(src).toContain('var env = toLinear(envC);');
        expect(src).toContain('if (u_lighting.u_envMapLinear != 0) { env = envC; }');
    });

    it('with the same curve', () => {
        expect(read('chunks/tonemap.wgsl')).toContain('fn toLinear(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }');
    });
});
