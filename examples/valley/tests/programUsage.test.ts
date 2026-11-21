import { describe, it, expect } from 'vitest';
import '@engine-tests/helpers/features';
import { createProgramUsage, usageFromSceneJson, usageFromRenderSettings, programsFor, castsShadows } from '@engine/graphics/programUsage';
import { dataReady, readThisExample } from '@tools/exampleKit/testKit';

// A published game builds only the programs `programsFor` lists (src/graphics/programUsage.ts; its other tests are
// tests/programUsage.test.ts): what the Valley's scene needs, and nothing the editor alone uses.

describe.skipIf(!dataReady())('programsFor the Valley', () => {
    it('lists what the Valley scene draws, and nothing the editor alone uses', async () => {
        const { bundle } = await readThisExample();
        const VALLEY = bundle.scenes[bundle.manifest.mainSceneId];
        const use = createProgramUsage();
        usageFromSceneJson(VALLEY.scene, use, castsShadows(VALLEY.scene));
        usageFromRenderSettings({ shadowFilterMode: 0, ssaoEnabled: true, taaEnabled: false, motionBlurEnabled: false,
                                  dofEnabled: false, autoExposureEnabled: false, lensFlareIntensity: 0,
                                  chromaticAberrationStrength: 0, filmGrainIntensity: 0, vignetteStrength: 0.35 }, use);
        const list = programsFor(use);
        // Static PBR geometry, one shadow filter, the deferred resolve; the campfire's smoke a lit sprite, its
        // flames batched unlit sprites.
        for (const name of ['pbrGeometry~flat', 'deferredLighting~pcf',
                            'screen', 'present', 'skyAtmosphere', 'volumetricClouds', 'particleBillboard', 'ssil', 'vignette',
                            'spriteLit', 'sprite', 'ssr', 'localExposureLum', 'volumetricFogInject', 'volumetricFogApply'])
            expect(list, name).toContain(name);
        // Particles as stripped variants.
        expect(list.some(n => /^particleSim~s\d+$/.test(n))).toBe(true);
        // No characters walk the valley any more: nothing skinned.
        for (const name of ['cel', 'cel~pcf', 'grid', 'outline', 'debugView', 'pbr~poisson',
                            'dofCoc', 'taaResolve', 'motionBlur', 'exposureMeter', 'lensFlare', 'pbrSkinned~pcf', 'pbrGeometrySkinned~flat'])
            expect(list, name).not.toContain(name);
        // The impostor shadow program the Valley's pines cast through in the outer cascades; the smoke's
        // lit sprite (no decals since the puddles went); the High tier's screen-space reflections (three)
        // and local exposure (two); the fog volumes' three; the GI Volumes' seven (capture reduce,
        // visibility, radiance, integrate, resolve, ambient cube, rescale); its water's local flow (eight passes).
        expect(list.length).toBeLessThan(93);
    });
});
