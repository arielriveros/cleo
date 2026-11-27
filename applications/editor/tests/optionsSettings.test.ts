import { describe, it, expect, beforeEach } from 'vitest';

// The node test environment has no localStorage; the stores and the tab session read it at call time.
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
};

import {
  DEFAULT_PROJECT_SETTINGS, applyEngineRuntime, applyCollisionLayers, isDefaultProjectSettings, parseProjectSettings, projectSettingsConfig, excludedScenesOf, publishGraphicsOf,
  physicsWorkerOverride, physicsWorkerOverrideSource, storePhysicsWorkerOverride, physicsBackendOverride,
  cleanSaveFolder, resolveSaveFolder, PROJECT_SETTINGS_VERSION,
} from '../src/features/options/projectSettings';
import { DEFAULT_EDITOR_PREFS, editorPrefsStore, getEditorPrefs, parseEditorPrefs } from '../src/features/options/editorPrefs';
import { loadTabState, saveTabState } from '../src/utils/tabState';
import { setActiveProjectId } from '../src/utils/projectScope';

describe('project settings', () => {
  it('parses nothing (or garbage) to the defaults', () => {
    expect(parseProjectSettings(null)).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(parseProjectSettings({ engine: 'x', publish: 3 })).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(isDefaultProjectSettings(parseProjectSettings(undefined))).toBe(true);
  });

  it('clamps out-of-range values and rejects a malformed gravity', () => {
    const s = parseProjectSettings({
      engine: { gravity: [0, 'down', 0], maxSubsteps: 999.4, maxFrameDelta: 0, masterVolume: 3 },
      publish: { width: 10, height: 1e9, title: 'x'.repeat(500), fullscreen: 'yes' },
    });
    expect(s.engine.gravity).toEqual([0, -9.81, 0]);
    expect(s.engine.maxSubsteps).toBe(32);
    expect(s.engine.simulationRange).toBe(0);
    expect(s.engine.maxFrameDelta).toBeCloseTo(1 / 240);
    expect(s.engine.masterVolume).toBe(1);
    expect(s.publish.width).toBe(320);
    expect(s.publish.height).toBe(4320);
    expect(s.publish.title.length).toBe(120);
    expect(s.publish.fullscreen).toBe(false);
  });

  it('writes the game config slices the player reads', () => {
    const s = parseProjectSettings({
      engine: { gravity: [0, 0, 0], maxSubsteps: 4, maxFrameDelta: 0.05, masterVolume: 0.5 },
      publish: { title: 'Hollow Keep', width: 1920, height: 1080, fullscreen: true, resizable: false },
    });
    expect(isDefaultProjectSettings(s)).toBe(false);
    expect(projectSettingsConfig(s)).toEqual({
      physics: {
        gravity: [0, 0, 0], maxSubsteps: 4, simulationRange: 0, maxPoweredRagdolls: 6, worker: 'on', backend: 'jolt',
        layers: ['Default', 'Ragdoll', 'See Through', 'No Camera', ...Array(12).fill('')],
      },
      runtime: { maxFrameDelta: 0.05 },
      audio: { masterVolume: 0.5 },
      saves: { version: 0, namespace: '' },
      window: { title: 'Hollow Keep', width: 1920, height: 1080, fullscreen: true, resizable: false },
    });
  });

  it('keeps the published game\'s graphics API and the scenes it leaves out, out of the game\'s window config', () => {
    // Absent by default (see the next test): the editor's graphics API, every scene.
    expect(publishGraphicsOf(DEFAULT_PROJECT_SETTINGS.publish)).toBe('editor');
    expect(excludedScenesOf(DEFAULT_PROJECT_SETTINGS.publish)).toEqual([]);
    const s = parseProjectSettings({ publish: { graphicsBackend: 'webgpu', excludedScenes: ['menu', 'menu', 'not an id!', 3] } });
    expect(s.publish.graphicsBackend).toBe('webgpu');
    expect(s.publish.excludedScenes).toEqual(['menu']);
    expect(parseProjectSettings({ publish: { graphicsBackend: 'vulkan' } }).publish.graphicsBackend).toBe('editor');
    const window = projectSettingsConfig(s).window;
    expect(window).not.toHaveProperty('graphicsBackend');
    expect(window).not.toHaveProperty('excludedScenes');
  });

  it('leaves the two out of a file saved before them: opening that project writes nothing back', () => {
    // The examples' settings.json predate them; filled in on parse, every example would be rewritten on open.
    const old = { title: 'Old', width: 1280, height: 720, fullscreen: false, resizable: true, onlyUsedShaders: true, webgl2Fallback: true };
    const s = parseProjectSettings({ publish: old });
    expect(s.publish).toEqual(old);
    expect(publishGraphicsOf(s.publish)).toBe('editor');
    expect(excludedScenesOf(s.publish)).toEqual([]);
  });

  it('names the collision layers: 16, the engine four fixed, a project from before them on the defaults', () => {
    const before = parseProjectSettings({ version: 5, engine: {} });
    expect(before.collisionLayers).toEqual(['Default', 'Ragdoll', 'See Through', 'No Camera', ...Array(12).fill('')]);
    const s = parseProjectSettings({ collisionLayers: ['Mine', 'x', 'y', 'z', '  Foot   Detail ', 3, 'a'.repeat(40)] });
    expect(s.collisionLayers).toHaveLength(16);
    expect(s.collisionLayers.slice(0, 7)).toEqual(['Default', 'Ragdoll', 'See Through', 'No Camera', 'Foot Detail', '', 'a'.repeat(32)]);
    expect(projectSettingsConfig(s).physics.layers[4]).toBe('Foot Detail');
    // Kept under `engine` for a while: still read from there.
    expect(parseProjectSettings({ engine: { collisionLayers: ['', '', '', '', 'Enemies'] } }).collisionLayers[4]).toBe('Enemies');
    const engine = { maxFrameDelta: 0, physics: { gravity: [0, 0, 0] as [number, number, number], maxSubsteps: 1, simulationRange: 0, layerNames: [] as readonly string[] } };
    applyCollisionLayers(engine, s.collisionLayers);
    expect(engine.physics.layerNames[4]).toBe('Foot Detail');
  });

  it('reads the saves settings tolerantly, a project from before them as version 0 and no folder', () => {
    expect(parseProjectSettings({ version: 3 }).saves).toEqual({ version: 0, folder: '' });
    expect(parseProjectSettings({ saves: { version: 3.6, folder: '  My/Game: Saves.  ' } }).saves).toEqual({ version: 4, folder: 'MyGame Saves' });
    expect(parseProjectSettings({ saves: { version: -2, folder: 7 } }).saves).toEqual({ version: 0, folder: '' });
    expect(projectSettingsConfig(parseProjectSettings({ saves: { version: 2, folder: 'Keep' } })).saves).toEqual({ version: 2, namespace: 'Keep' });
  });

  it('names the save folder: its own, else the title, else the project', () => {
    const s = parseProjectSettings({ publish: { title: 'Hollow Keep' } });
    expect(resolveSaveFolder(s, 'proj')).toBe('Hollow Keep');
    expect(resolveSaveFolder({ ...s, saves: { version: 0, folder: 'HK Saves' } }, 'proj')).toBe('HK Saves');
    expect(resolveSaveFolder(parseProjectSettings(null), 'My <Project>')).toBe('My Project');
    expect(resolveSaveFolder(parseProjectSettings(null), '')).toBe('Cleo Game');
    expect(cleanSaveFolder('a\\b|c?.')).toBe('abc');
  });

  it('reads the physics thread, defaulting to the worker', () => {
    expect(parseProjectSettings({ engine: { physicsWorker: 'auto' } }).engine.physicsWorker).toBe('auto');
    expect(parseProjectSettings({ engine: { physicsWorker: 'on' } }).engine.physicsWorker).toBe('on');
    expect(parseProjectSettings({ engine: { physicsWorker: 'gpu' } }).engine.physicsWorker).toBe('on');
    expect(parseProjectSettings(null).engine.physicsWorker).toBe('on');
    // Main thread chosen since the worker became the default is kept; an 'off' stored before it (when
    // every project stored the default) moves to the worker.
    expect(parseProjectSettings({ version: 2, engine: { physicsWorker: 'off' } }).engine.physicsWorker).toBe('off');
    expect(parseProjectSettings({ engine: { physicsWorker: 'off' } }).engine.physicsWorker).toBe('on');
    expect(parseProjectSettings({ version: 1, engine: { physicsWorker: 'auto' } }).engine.physicsWorker).toBe('auto');
    expect(parseProjectSettings(parseProjectSettings({ version: 2, engine: { physicsWorker: 'off' } })).engine.physicsWorker).toBe('off');
    expect(projectSettingsConfig(parseProjectSettings({ engine: { physicsWorker: 'auto' } })).physics.worker).toBe('auto');
  });

  it('reads the physics backend, defaulting to Jolt, and ships it in the game config', () => {
    expect(parseProjectSettings(null).engine.physicsBackend).toBe('jolt');
    expect(parseProjectSettings({ engine: { physicsBackend: 'rapier' } }).engine.physicsBackend).toBe('rapier');
    expect(parseProjectSettings({ engine: { physicsBackend: 'jolt' } }).engine.physicsBackend).toBe('jolt');
    expect(parseProjectSettings({ engine: { physicsBackend: 'havok' } }).engine.physicsBackend).toBe('jolt');
    expect(projectSettingsConfig(parseProjectSettings(null)).physics.backend).toBe('jolt');
    expect(projectSettingsConfig(parseProjectSettings({ engine: { physicsBackend: 'rapier' } })).physics.backend).toBe('rapier');
  });

  it('moves a project stored before Jolt was the default off cannon, keeping Rapier and a later choice of cannon', () => {
    // Before version 5 every stored project had cannon written back into it, chosen or not.
    expect(parseProjectSettings({ version: 4, engine: { physicsBackend: 'cannon' } }).engine.physicsBackend).toBe('jolt');
    expect(parseProjectSettings({ version: 2, engine: { physicsBackend: 'cannon' } }).engine.physicsBackend).toBe('jolt');
    expect(parseProjectSettings({ version: 4, engine: { physicsBackend: 'rapier' } }).engine.physicsBackend).toBe('rapier');
    expect(parseProjectSettings({ version: 5, engine: { physicsBackend: 'cannon' } }).engine.physicsBackend).toBe('cannon');
    // Once read it is stored at the current version (5 or later), so a project switched back to cannon stays there.
    const reread = parseProjectSettings(parseProjectSettings({ version: 4, engine: { physicsBackend: 'cannon' } }));
    expect([reread.version, reread.engine.physicsBackend]).toEqual([PROJECT_SETTINGS_VERSION, 'jolt']);
    expect(parseProjectSettings({ ...reread, engine: { ...reread.engine, physicsBackend: 'cannon' } }).engine.physicsBackend).toBe('cannon');
  });

  it('lets the URL ask for a physics backend', () => {
    const g = globalThis as any;
    const location = g.location;
    try {
      g.location = { search: '?physicsBackend=rapier' };
      expect(physicsBackendOverride()).toBe('rapier');
      g.location = { search: '?physicsBackend=havok' };
      expect(physicsBackendOverride()).toBeNull();
      g.location = undefined;
      expect(physicsBackendOverride()).toBeNull();
    } finally {
      g.location = location;
    }
  });

  it('applies the runtime slice to a live engine, physics and mixer', () => {
    const engine = { maxFrameDelta: 0.1, physics: { gravity: [0, -9.81, 0] as [number, number, number], maxSubsteps: 8, simulationRange: 0 } };
    const mixer = { masterVolume: 1 };
    const s = { gravity: [0, -1.62, 0] as [number, number, number], maxSubsteps: 3, simulationRange: 90, maxFrameDelta: 0.2, masterVolume: 0.25 };
    applyEngineRuntime(engine, s, mixer);
    // Reacting bodies unset: the engine's default.
    expect(engine).toEqual({ maxFrameDelta: 0.2, physics: { gravity: [0, -1.62, 0], maxSubsteps: 3, simulationRange: 90, maxPoweredRagdolls: 6 } });
    expect(engine.physics.gravity).not.toBe(s.gravity);   // copied, not aliased
    expect(mixer.masterVolume).toBe(0.25);
    // No physics world (a 2D scene before one exists) is not an error.
    expect(() => applyEngineRuntime({ maxFrameDelta: 0.1, physics: null }, s)).not.toThrow();
  });

  it("keeps this machine's physics thread override (the Performance page's switch), the URL winning", () => {
    const g = globalThis as any;
    const location = g.location;
    try {
      storePhysicsWorkerOverride('on');
      expect(physicsWorkerOverrideSource()).toEqual({ mode: 'on', from: 'storage' });
      expect(physicsWorkerOverride()).toBe('on');

      // Applied over the project's own setting, at Play and on every settings change.
      const physics = { gravity: [0, -9.81, 0] as [number, number, number], maxSubsteps: 8, simulationRange: 0, workerMode: 'off' as const, setWorkerMode(mode: any) { this.workerMode = mode; } };
      applyEngineRuntime({ maxFrameDelta: 0.1, physics }, { ...DEFAULT_PROJECT_SETTINGS.engine, physicsWorker: 'off' });
      expect(physics.workerMode).toBe('on');

      g.location = { search: '?physicsWorker=auto' };
      expect(physicsWorkerOverrideSource()).toEqual({ mode: 'auto', from: 'url' });
      g.location = location;

      mem.set('cleo_physics_worker', 'gpu');
      expect(physicsWorkerOverrideSource()).toBeNull();

      storePhysicsWorkerOverride(null);
      expect(mem.has('cleo_physics_worker')).toBe(false);
      expect(physicsWorkerOverride()).toBeNull();
    } finally {
      g.location = location;
      mem.delete('cleo_physics_worker');
    }
  });
});

describe('editor preferences', () => {
  beforeEach(() => editorPrefsStore.reset());

  it('parses tolerantly', () => {
    expect(parseEditorPrefs(null)).toEqual(DEFAULT_EDITOR_PREFS);
    const p = parseEditorPrefs({ scriptOpenWith: 'emacs', cameraFlySpeed: -2, snapRotateDeg: 400, bogus: 1 });
    expect(p).toEqual(DEFAULT_EDITOR_PREFS);
  });

  it('only accepts a bare program name as the external editor command', () => {
    expect(parseEditorPrefs({ externalEditorCommand: 'cursor' }).externalEditorCommand).toBe('cursor');
    expect(parseEditorPrefs({ externalEditorCommand: 'code-insiders' }).externalEditorCommand).toBe('code-insiders');
    for (const bad of ['code && rm -rf ~', 'code --wait', '../evil', '', 'a;b'])
      expect(parseEditorPrefs({ externalEditorCommand: bad }).externalEditorCommand).toBe('code');
  });

  it('persists a change and notifies subscribers once', () => {
    let calls = 0;
    const off = editorPrefsStore.subscribe(() => calls++);
    editorPrefsStore.set({ scriptOpenWith: 'vscode', snapTranslate: 0.5 });
    editorPrefsStore.set({ scriptOpenWith: 'vscode' });   // no change: no notification
    off();
    expect(calls).toBe(1);
    expect(getEditorPrefs().scriptOpenWith).toBe('vscode');
    expect(JSON.parse(localStorage.getItem('cleo_editor_prefs_v1')!).snapTranslate).toBe(0.5);
  });
});

describe('tab session from before Options', () => {
  it('restores a session saved in Renderer or Input mode into Options', () => {
    setActiveProjectId('test-project');   // the session key is project-scoped
    for (const retired of ['renderer', 'input']) {
      saveTabState([], 'scene-tab', retired as any);
      expect(loadTabState('scene-tab').mainMode).toBe('options');
    }
    saveTabState([], 'scene-tab', 'nonsense' as any);
    expect(loadTabState('scene-tab').mainMode).toBe('scene');
  });
});
