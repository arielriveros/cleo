import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FEATURES, FEATURE_PRESETS, FEATURE_GROUPS, enabledFeatures, dependentsOf, featureOfNodeType, presetMatching } from '../src/modules/catalog';
import { programModules } from '../src/graphics/render/programs';

// The catalog of what a project can leave out of its games (src/modules/catalog.ts): every claim it makes
// about the engine -- node types, shader modules, render settings -- has to name something that exists, and
// nothing may belong to two features.

const SHADERS = path.resolve(__dirname, '../src/graphics/shaders');
const NODE_TYPES = readFileSync(path.resolve(__dirname, '../src/core/scene/nodes/nodeType.ts'), 'utf8')
    .match(/export type NodeType =([\s\S]*?);/)![1].match(/'(\w+)'/g)!.map(s => s.slice(1, -1));
const SETTINGS = readFileSync(path.resolve(__dirname, '../src/graphics/render/settingsTypes.ts'), 'utf8');

describe('the feature catalog', () => {
    it('has unique ids, known groups and dependencies that exist', () => {
        const ids = FEATURES.map(f => f.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const f of FEATURES) {
            expect(FEATURE_GROUPS.some(g => g.id === f.group), f.id).toBe(true);
            for (const d of f.dependsOn ?? []) expect(ids, `${f.id} depends on ${d}`).toContain(d);
        }
    });

    it('names node types the engine has, each owned once', () => {
        const owners = new Map<string, string>();
        for (const f of FEATURES) for (const t of f.nodeTypes ?? []) {
            expect(NODE_TYPES, `${f.id}: ${t}`).toContain(t);
            expect(owners.get(t), `${t} is in ${owners.get(t)} and ${f.id}`).toBeUndefined();
            owners.set(t, f.id);
        }
        expect(featureOfNodeType('landscape')?.id).toBe('landscape');
        expect(featureOfNodeType('model')).toBeUndefined();
    });

    it('names shader modules that exist, each owned once, and none a core program draws with', () => {
        const owners = new Map<string, string>();
        for (const f of FEATURES) for (const m of f.shaderModules ?? []) {
            expect(existsSync(path.join(SHADERS, m)), `${f.id}: ${m}`).toBe(true);
            expect(owners.get(m), `${m} is in ${owners.get(m)} and ${f.id}`).toBeUndefined();
            owners.set(m, f.id);
        }
        // The programs every game builds at boot must keep their module.
        const modules = programModules();
        for (const core of ['screen', 'present', 'composer', 'brdf', 'irradiance', 'prefilter', 'skybox', 'deferredLighting', 'shadowMap', 'basic', 'basicGeometry', 'blinn_phongGeometry', 'occlusionBox'])
            expect(owners.get(modules[core]), `${core} (${modules[core]})`).toBeUndefined();
    });

    it('turns off render settings that exist', () => {
        for (const f of FEATURES) for (const key of f.renderSettingsOff ?? [])
            expect(SETTINGS.includes(`${key}:`) || SETTINGS.includes(`${key}?:`), `${f.id}: ${key}`).toBe(true);
    });

    it('takes a feature out with whatever needs it', () => {
        expect(enabledFeatures([]).size).toBe(FEATURES.length);
        const on = enabledFeatures(['particles']);
        expect(on.has('particles')).toBe(false);
        expect(on.has('weather')).toBe(false);
        expect(on.has('landscape')).toBe(true);
        expect(dependentsOf('particles')).toEqual(['weather']);
        // An id the catalog no longer has takes nothing away.
        expect(enabledFeatures(['retiredFeature']).size).toBe(FEATURES.length);
    });

    it('has presets that name known features, and finds the preset a list matches', () => {
        const ids = new Set(FEATURES.map(f => f.id));
        for (const p of FEATURE_PRESETS) for (const d of p.disabled) expect(ids.has(d), `${p.id}: ${d}`).toBe(true);
        expect(presetMatching([])?.id).toBe('everything');
        const twoD = FEATURE_PRESETS.find(p => p.id === '2d')!;
        expect(presetMatching([...twoD.disabled].reverse())?.id).toBe('2d');
        expect(presetMatching(['gi'])).toBeUndefined();
        // The 2D preset keeps what a 2D game is made of.
        for (const kept of ['world2d', 'physics2d', 'input', 'gameUi', 'webgl2']) expect(twoD.disabled).not.toContain(kept);
    });
});
