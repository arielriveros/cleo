import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { EXPERIMENTAL_NOTE, FEATURES, FEATURE_PRESETS, enabledFeatures, experimentalFeatureOfNodeType, experimentalNoteOf, featureById, isExperimentalFeature } from 'cleo';
import { parseProjectSettings, DEFAULT_PROJECT_SETTINGS, LEGACY_ADDONS, PROJECT_SETTINGS_VERSION } from '../src/features/options/projectSettings';
import { FEATURE_ADD_ITEMS, FEATURE_NEW_ASSETS, FEATURE_MODES, experimentalFeatureOfAddItem, featureOfAddItem, projectFeatures } from '../src/features/projectFeatures/featureUi';
import { ADD_ITEMS } from '../src/features/sceneInspector/addCatalog';
import { toggleFeature, presetChoice } from '../src/features/projectFeatures/FeaturePicker';
import { detectedDisabled } from '../src/features/projectFeatures/detect';
import { featureSizesFrom, engineEstimate } from '../src/features/projectFeatures/featureSizes';
import { BUILT_IN_ADDONS } from '../src/features/addons/registry';
import type { PlayerBuild } from '../src/features/publish/playerManifest';

// Project ▸ Features and Project ▸ Addons in the editor: the settings they write, where each feature shows in
// the editor, the checklist's rules, and the built-in addons.

const DOCS = path.resolve(__dirname, '../../../docs');

describe('project settings v3 and v4: features and addons', () => {
  it('reads an older project as every feature on and the MCP server and Claude Code addons on', () => {
    const old = parseProjectSettings({ version: 2, engine: {}, publish: {} });
    expect(old.features.disabled).toEqual([]);
    expect(old.addons.enabled).toEqual([...LEGACY_ADDONS]);
    expect(LEGACY_ADDONS).toEqual(['mcp-server', 'claude-code']);
    // Read at the current version (5: Jolt the default physics backend, optionsSettings.test.ts).
    expect(old.version).toBe(PROJECT_SETTINGS_VERSION);
  });

  it('gives a v3 project with Claude Code on the MCP server addon its link was part of', () => {
    expect(parseProjectSettings({ version: 3, addons: { enabled: ['claude-code'] } }).addons.enabled).toEqual(['mcp-server', 'claude-code']);
    expect(parseProjectSettings({ version: 3, addons: { enabled: [] } }).addons.enabled).toEqual([]);
    // From version 4 the list is the user's own: Claude Code without the MCP server stays so (and does not run).
    expect(parseProjectSettings({ version: 4, addons: { enabled: ['claude-code'] } }).addons.enabled).toEqual(['claude-code']);
    expect(parseProjectSettings({ version: 4, addons: { enabled: ['mcp-server'] } }).addons.enabled).toEqual(['mcp-server']);
  });

  it('keeps a v3 choice, tolerantly', () => {
    const s = parseProjectSettings({ version: 3, features: { disabled: ['gi', 'gi', 3, 'bad id!', 'landscape'] }, addons: { enabled: [], settings: { x: { a: 1 } } } });
    expect(s.features.disabled).toEqual(['gi', 'landscape']);
    expect(s.addons.enabled).toEqual([]);
    expect(s.addons.settings).toEqual({ x: { a: 1 } });
    expect(parseProjectSettings(null)).toEqual(DEFAULT_PROJECT_SETTINGS);
  });
});

describe('where a feature shows in the editor', () => {
  it('names Add menu items that exist, each owned once', () => {
    const ids = new Set(ADD_ITEMS.map(i => i.id));
    const seen = new Set<string>();
    for (const [feature, items] of Object.entries(FEATURE_ADD_ITEMS)) {
      expect(FEATURES.some(f => f.id === feature), feature).toBe(true);
      for (const id of items) {
        expect(ids.has(id), `${feature}: ${id}`).toBe(true);
        expect(seen.has(id), id).toBe(false);
        seen.add(id);
      }
    }
    for (const table of [FEATURE_NEW_ASSETS, FEATURE_MODES])
      for (const feature of Object.keys(table)) expect(FEATURES.some(f => f.id === feature), feature).toBe(true);
    expect(featureOfAddItem('landscape')).toBe('landscape');
    expect(featureOfAddItem('cube')).toBeUndefined();
  });

  it('hides what a disabled list leaves out, and marks its nodes as not shipped', () => {
    const f = projectFeatures(['particles']);
    expect(f.isOn('particles')).toBe(false);
    expect(f.isOn('weather')).toBe(false);
    expect(f.isOn(undefined)).toBe(true);
    expect(f.offFeatureOfNodeType('particleSystem')?.id).toBe('particles');
    expect(f.offFeatureOfNodeType('model')).toBeUndefined();
  });
});

describe('experimental features', () => {
  it('flags only water, as a label: it stays on by default and keeps its Add item', () => {
    expect(FEATURES.filter(f => f.experimental).map(f => f.id)).toEqual(['water']);
    expect(enabledFeatures([]).has('water')).toBe(true);
    expect(experimentalFeatureOfAddItem('waterVolume')?.id).toBe('water');
    expect(experimentalFeatureOfAddItem('cube')).toBeUndefined();
    expect(experimentalFeatureOfAddItem('particleSystem')).toBeUndefined();
    expect(experimentalFeatureOfNodeType('waterVolume')?.id).toBe('water');
    expect(experimentalFeatureOfNodeType('particleSystem')).toBeUndefined();
    expect(isExperimentalFeature('water')).toBe(true);
    expect(experimentalNoteOf(featureById('water')!)).toMatch(/bake may need baking again/);
    // A feature that says nothing of its own gets the generic note.
    expect(experimentalNoteOf({ id: 'x', label: 'X', description: '', group: 'world', experimental: true })).toBe(EXPERIMENTAL_NOTE);
  });

  it('says so in every doc a user reads it in', () => {
    const read = (p: string) => readFileSync(path.join(DOCS, p), 'utf8');
    for (const f of FEATURES.filter(f => f.experimental)) {
      const line = read('editor/project-features.md').split('\n').find(l => l.includes(`**${f.label}**`));
      expect(line, f.label).toMatch(/Experimental/);
    }
    expect(read('editor/water.md')).toContain('> **Experimental.**');
    const ref = read('reference/node-types.md').split('\n').find(l => l.startsWith('### WaterVolumeNode'));
    expect(ref).toContain('*(experimental)*');
  });
});

describe('the feature checklist', () => {
  it('turns a feature on with what it needs, and WebGL 2 through its own flag', () => {
    const off = { disabled: ['particles', 'weather'], webgl2: true };
    expect(toggleFeature(off, 'weather', true).disabled).toEqual([]);
    expect(toggleFeature({ disabled: [], webgl2: true }, 'gi', false).disabled).toEqual(['gi']);
    expect(toggleFeature({ disabled: [], webgl2: true }, 'webgl2', false)).toEqual({ disabled: [], webgl2: false });
    expect(presetChoice(FEATURE_PRESETS.find(p => p.id === '2d')!).webgl2).toBe(true);
  });

  it('detects from usage only what the scan can see', () => {
    const usage = new Map([['landscape', [{ where: 'Main ▸ Ground', what: 'Landscape node' }]], ['weather', [{ where: 'Main ▸ Rain', what: 'Weather node' }]]]);
    const disabled = detectedDisabled(usage, ['input', 'landscape']);
    expect(disabled).not.toContain('landscape');
    expect(disabled).toContain('gi');
    // Input cannot be seen: it keeps its state. Particles stays on for the weather that needs it.
    expect(disabled).toContain('input');
    expect(disabled).not.toContain('particles');
  });

  it('weighs each feature from the player build', () => {
    const build: PlayerBuild = {
      contract: 0, builtAt: '', entry: 'game.js', worker: 'w.js', core: ['game.js'], coreBytes: 1000,
      features: { 'physics-rapier': { files: ['r.js'], bytes: 400, deps: [] } },
      shaders: { file: 'shaders.json', bytes: 0, modules: {
        'wgsl/ssr.wgsl': { bytes: 300, glslBytes: 100 },
        'wgsl/screen.wgsl': { bytes: 50, glslBytes: 20 },
      } },
    };
    const sizes = featureSizesFrom(build)!;
    expect(sizes.byFeature.ssr).toEqual({ all: 300, webgpuOnly: 200 });
    expect(sizes.core).toEqual({ all: 1050, webgpuOnly: 1030 });
    expect(sizes.byFeature.webgl2.all).toBe(120);
    expect(engineEstimate(sizes, new Set(['ssr']), true, 'rapier')).toBe(1050 + 400 + 300);
    expect(engineEstimate(sizes, new Set(), false, 'cannon')).toBe(1030);
  });
});

describe('the built-in addons', () => {
  it('each have a docs page and load a module that activates', async () => {
    for (const a of BUILT_IN_ADDONS) {
      expect(existsSync(path.join(DOCS, `${a.docPage}.md`)), a.docPage).toBe(true);
      expect(a.id).toMatch(/^[\w.-]+$/);
    }
    expect(BUILT_IN_ADDONS.map(a => a.id)).toEqual(expect.arrayContaining([...LEGACY_ADDONS]));
    // Every requirement names a built-in addon.
    for (const a of BUILT_IN_ADDONS) for (const r of a.requires ?? []) expect(BUILT_IN_ADDONS.some(b => b.id === r), `${a.id} requires ${r}`).toBe(true);
    expect(BUILT_IN_ADDONS.find(a => a.id === 'claude-code')?.requires).toEqual(['mcp-server']);
  });
});
