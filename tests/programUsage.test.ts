import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PROGRAM_CLASS, createProgramUsage, usageFromSceneJson, usageFromRenderSettings, programsFor, castsShadows } from '../src/graphics/programUsage';
import { physicalFor, variantLogicalNames, EXTRA_LOGICAL_NAMES } from '../src/graphics/programVariants';
import { ShaderManager } from '../src/graphics/systems/shaderManager';
import { PARTICLE_PROGRAMS } from '../src/graphics/particles/particleRenderer';
import type { ShaderProgram } from '../src/graphics/rhi/shaderProgram';

/**
 * A published game builds only the programs `programsFor` lists. Two ways that goes wrong quietly:
 * a program added to the renderer later that nobody classified (it would never ship, and every game
 * would build it mid-play with a warning), and a list that names a program the renderer cannot build.
 */

const RENDERER = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8').replace(/\r\n/g, '\n');

function tableNames(): string[] {
    const start = RENDERER.indexOf('private _programTable()');
    const body = RENDERER.slice(start, RENDERER.indexOf('\n    }\n', start));
    return [...body.matchAll(/\['(\w+)',/g)].map(m => m[1]);
}

describe('program classification', () => {
    it('classifies every program-table entry', () => {
        const names = [...tableNames(), ...Object.values(PARTICLE_PROGRAMS).map(p => p[0])];
        expect(names.length).toBeGreaterThan(70);
        expect(names.filter(n => !(n in PROGRAM_CLASS))).toEqual([]);
    });

    it('gives every variant rule a table entry to build from', () => {
        const table = new Set(tableNames());
        for (const logical of variantLogicalNames()) {
            const base = physicalFor(logical, 0).split('~')[0];
            expect(table.has(base), logical).toBe(true);
        }
        for (const base of Object.values(EXTRA_LOGICAL_NAMES)) expect(table.has(base), base).toBe(true);
    });
});

describe('programsFor', () => {
    const SOULS = JSON.parse(readFileSync(join(__dirname, '..', 'editor', 'public', 'examples', 'souls-demo',
        'scenes', 'a08f6be5626f2c412295157c8c4b2def.json'), 'utf-8'));

    it('lists what the Hollow Keep scene draws, and nothing the editor alone uses', () => {
        const use = createProgramUsage();
        usageFromSceneJson(SOULS.scene, use, castsShadows(SOULS.scene));
        usageFromRenderSettings({ shadowFilterMode: 0, ssaoEnabled: true, taaEnabled: false, motionBlurEnabled: false,
                                  dofEnabled: false, autoExposureEnabled: false, lensFlareIntensity: 0,
                                  chromaticAberrationStrength: 0, filmGrainIntensity: 0, vignetteStrength: 0.35 }, use);
        const list = programsFor(use);
        // Skinned PBR characters, static PBR geometry, one shadow filter, the deferred resolve.
        for (const name of ['pbrSkinned~pcf', 'pbrGeometrySkinned~flat', 'pbrGeometry~flat', 'deferredLighting~pcf',
                            'screen', 'present', 'skyAtmosphere', 'particleBillboard', 'ssao', 'vignette'])
            expect(list, name).toContain(name);
        // Particles as stripped variants.
        expect(list.some(n => /^particleSim~s\d+$/.test(n))).toBe(true);
        for (const name of ['cel', 'cel~pcf', 'grid', 'outline', 'debugView', 'pbr~poisson', 'volumetricClouds',
                            'decalSurface', 'dofCoc', 'taaResolve', 'motionBlur', 'exposureMeter', 'lensFlare'])
            expect(list, name).not.toContain(name);
        expect(list.length).toBeLessThan(60);
    });

    it('builds the parallax variant only for a material that marches', () => {
        const model = (material: object) => ({ type: 'model', model: { material } });
        const flat = createProgramUsage();
        usageFromSceneJson(model({ type: 'pbr', textures: { displacementMap: 'h' }, uvProjection: 'triplanar' }), flat);
        expect(programsFor(flat)).toContain('pbr~pcf');
        expect(programsFor(flat)).not.toContain('pbr~pcf.pom');
        const pom = createProgramUsage();
        usageFromSceneJson(model({ type: 'pbr', textures: { displacementMap: 'h' } }), pom);
        expect(programsFor(pom)).toContain('pbr~pcf.pom');
        expect(programsFor(pom)).toContain('pbrGeometry~pom');
    });

    it('follows the quality tier where settings are silent', () => {
        const use = createProgramUsage();
        usageFromRenderSettings({ quality: 'ultra' }, use);
        expect(programsFor(use)).toContain('deferredLighting~poisson');
        expect(programsFor(use)).toContain('taaResolve');
    });
});

describe('ShaderManager resolver', () => {
    it('builds a miss once, and leaves find() a pure lookup', () => {
        const manager = ShaderManager.Instance;
        const program = { use: () => {} } as unknown as ShaderProgram;
        const resolver = vi.fn((name: string) => name === 'lazyThing' ? program : undefined);
        manager.setResolver(resolver);
        try {
            expect(manager.find('lazyThing')).toBeUndefined();
            expect(manager.getShader('lazyThing')).toBe(program);
            expect(manager.getShader('lazyThing')).toBe(program);
            expect(resolver).toHaveBeenCalledTimes(1);
            expect(() => manager.getShader('nothing')).toThrow(/not found/);
        } finally {
            manager.setResolver(null);
            manager.removeShader('lazyThing');
        }
    });
});
