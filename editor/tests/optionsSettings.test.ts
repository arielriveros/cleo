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
  DEFAULT_PROJECT_SETTINGS, applyEngineRuntime, isDefaultProjectSettings, parseProjectSettings, projectSettingsConfig,
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
      physics: { gravity: [0, 0, 0], maxSubsteps: 4, simulationRange: 0 },
      runtime: { maxFrameDelta: 0.05 },
      audio: { masterVolume: 0.5 },
      window: { title: 'Hollow Keep', width: 1920, height: 1080, fullscreen: true, resizable: false },
    });
  });

  it('applies the runtime slice to a live engine, physics and mixer', () => {
    const engine = { maxFrameDelta: 0.1, physics: { gravity: [0, -9.81, 0] as [number, number, number], maxSubsteps: 8, simulationRange: 0 } };
    const mixer = { masterVolume: 1 };
    const s = { gravity: [0, -1.62, 0] as [number, number, number], maxSubsteps: 3, simulationRange: 90, maxFrameDelta: 0.2, masterVolume: 0.25 };
    applyEngineRuntime(engine, s, mixer);
    expect(engine).toEqual({ maxFrameDelta: 0.2, physics: { gravity: [0, -1.62, 0], maxSubsteps: 3, simulationRange: 90 } });
    expect(engine.physics.gravity).not.toBe(s.gravity);   // copied, not aliased
    expect(mixer.masterVolume).toBe(0.25);
    // No physics world (a 2D scene before one exists) is not an error.
    expect(() => applyEngineRuntime({ maxFrameDelta: 0.1, physics: null }, s)).not.toThrow();
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
