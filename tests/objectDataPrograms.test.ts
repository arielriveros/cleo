import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { translateWgsl } from '../tools/wgslTranslate.mjs';

/**
 * Every program that reads the per-object table (chunks/objectData.wgsl) must take its record through
 * `@builtin(instance_index)` — that is the only way the engine's `firstInstance` reaches it — and must
 * no longer declare the per-draw members the table replaced, or a draw would read a stale uniform. On
 * WebGL2 the index arrives through naga's `naga_vs_first_instance`, so the translated vertex stage must
 * declare it.
 */
const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const compose = (file: string) => resolveIncludes(readFileSync(join(WGSL, file), 'utf-8'), dirname(join(WGSL, file)), {
    read: (p: string) => readFileSync(p, 'utf-8'),
    resolve: (d: string, rel: string) => resolve(d, rel),
});

/** The programs converted so far, by the vertex chunk they include. */
const PROGRAMS = ['pbr.wgsl', 'cel.wgsl', 'blinnPhong.wgsl', 'geometryPBR.wgsl', 'geometryBlinnPhong.wgsl',
                  'geometryTerrain.wgsl', 'terrainForward.wgsl', 'basic.wgsl', 'geometryBasic.wgsl',
                  'shadowMap.wgsl', 'shadowMapCutout.wgsl', 'shadowMapBasicCutout.wgsl',
                  'pbrSkinned.wgsl', 'celSkinned.wgsl', 'blinnPhongSkinned.wgsl', 'geometryPBRSkinned.wgsl',
                  'geometryBlinnPhongSkinned.wgsl', 'basicSkinned.wgsl', 'geometryBasicSkinned.wgsl',
                  'shadowMapSkinned.wgsl', 'shadowMapSkinnedCutout.wgsl', 'shadowMapBasicSkinnedCutout.wgsl'];

describe('programs reading the per-object table', () => {
    it.each(PROGRAMS)('%s takes its record through instance_index and has no per-draw transform', (file) => {
        const src = compose(file);
        expect(src).toContain('var u_objectData_texture: texture_2d<f32>');
        expect(src).toMatch(/@builtin\(instance_index\) objectIndex: u32/);
        const block = /struct (?:ModelTransform|BasicTransform|ShadowMapUniforms|SkinnedTransform|BasicSkinnedTransform|ShadowMapSkinnedUniforms) \{([^}]*)\}/.exec(src)![1];
        expect(block).not.toMatch(/\bu_model\b|\bu_dissolve\b|\bu_camHolePivot\b|\bu_uvScale\b|\bu_boneMatrices\b/);
    });

    let pbr: { vertex: string };
    beforeAll(async () => { pbr = await translateWgsl(compose('geometryPBR.wgsl'), 'geometryPBR.wgsl') as never; }, 60_000);

    it('translates for WebGL2 with the first-instance uniform', () => {
        expect(pbr.vertex).toContain('uniform uint naga_vs_first_instance;');
        expect(pbr.vertex).toContain('texelFetch(u_objectData');
    });
});
