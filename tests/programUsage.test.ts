import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import './helpers/features';
import { PROGRAM_CLASS, createProgramUsage, usageFromSceneJson, usageFromRenderSettings, programsFor, castsShadows } from '../src/graphics/programUsage';
import { physicalFor, variantLogicalNames, EXTRA_LOGICAL_NAMES } from '../src/graphics/programVariants';
import { ShaderManager } from '../src/graphics/systems/shaderManager';
import { PARTICLE_PROGRAMS } from '../src/graphics/particles/particleRenderer';
import type { ShaderProgram } from '../src/graphics/rhi/shaderProgram';
import { rendererSource } from './helpers/rendererSource';


/**
 * A published game builds only the programs `programsFor` lists. Two ways that goes wrong quietly:
 * a program added to the renderer later that nobody classified (it would never ship, and every game
 * would build it mid-play with a warning), and a list that names a program the renderer cannot build.
 */

const RENDERER = rendererSource().replace(/\r\n/g, '\n');

function tableNames(): string[] {
    // render/programs.ts: a module-level function, so its body ends at a column-0 brace.
    const start = RENDERER.indexOf('export function programTable()');
    expect(start).toBeGreaterThan(-1);
    const body = RENDERER.slice(start, RENDERER.indexOf('\n}\n', start));
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

// What the Valley's and the Dungeon's scenes need: examples/valley/tests and examples/dungeon/tests (programUsage).
describe('programsFor', () => {
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
            // A name the resolver cannot build is not re-resolved on every lookup (a per-frame cost)...
            expect(manager.bindIfRegistered('nothing')).toBe(false);
            expect(resolver.mock.calls.filter(c => c[0] === 'nothing')).toHaveLength(1);
            // ...until the registry changes.
            manager.addShader('somethingElse', program);
            expect(manager.bindIfRegistered('nothing')).toBe(false);
            expect(resolver.mock.calls.filter(c => c[0] === 'nothing')).toHaveLength(2);
            manager.removeShader('somethingElse');
        } finally {
            manager.setResolver(null);
            manager.removeShader('lazyThing');
        }
    });
});
