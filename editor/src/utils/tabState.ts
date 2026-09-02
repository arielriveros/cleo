// Persistence for the editor's open documents: the tab strip, which tab was active, and the scene tab's
// sub-mode. Must be localStorage, not IndexedDB: DockLayout reads the mode it implies synchronously on
// mount, and an async read would build one mode's panel layout and then rebuild it.
//
// Only the tab METADATA is stored; a tab's live edit session is rebuilt from the asset it names, so a tab
// that names no asset cannot come back.

import type { EditorTab, TabKind } from '../features/EngineContext';
import { LS_KEYS, lsKey } from './lsScope';

// Per-project: this names asset ids that exist in exactly one project.
const tabStateKey = () => lsKey(LS_KEYS.editorTabs);

// 'landscape' and 'tilemap' are the dimension-specific sculpting modes; the selector offers whichever
// matches the scene's 2D/3D setting. A mode missing from MAIN_MODES silently resets to 'scene' on reload.
export type MainMode = 'scene' | 'landscape' | 'tilemap' | 'ui' | 'renderer';
const MAIN_MODES: readonly MainMode[] = ['scene', 'landscape', 'tilemap', 'ui', 'renderer'];

export type TabState = {
  version: 1;
  tabs: EditorTab[];
  activeTabId: string;
  mainMode: MainMode;
};

/**
 * Which field on `EditorTab` names the asset each restorable kind edits.
 * `animation` must stay absent: its builder is asynchronous and captures the source scene and source TAB
 * from whatever is active when called, so restoring it at boot records the wrong write-back target for
 * "Apply to Model".
 */
const ID_FIELD: Partial<Record<TabKind, keyof EditorTab>> = {
  template: 'templateId',
  material: 'materialId',
  terrainMaterial: 'terrainMaterialId',
  model: 'modelId',
  script: 'scriptId',
  animationField: 'animationFieldId',
  tileset: 'tilesetId',
  texture: 'textureId',
  soundSample: 'soundId',
};

/** The asset a tab edits, or null for the scene tab and for unsaved "New Material"-style tabs. */
export function assetIdOfTab(tab: EditorTab): string | null {
  const field = ID_FIELD[tab.kind];
  if (!field) return null;
  const value = tab[field];
  return typeof value === 'string' && value ? value : null;
}

/**
 * Can this tab be rebuilt from storage alone?
 * A never-saved asset tab (`materialId: null`) exists only as live objects in its runtime scene, so it is
 * lost on reload; the beforeunload guard warns about that.
 */
export function isRestorableTab(tab: EditorTab): boolean {
  if (tab.kind === 'scene') return true;
  return !!ID_FIELD[tab.kind] && !!assetIdOfTab(tab);
}

function sanitize(raw: any, sceneTabId: string): TabState | null {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.tabs)) return null;

  const seen = new Set<string>();
  const tabs: EditorTab[] = [];
  let sceneTab: EditorTab | null = null;
  for (const t of raw.tabs) {
    if (!t || typeof t.id !== 'string' || typeof t.kind !== 'string' || typeof t.title !== 'string') continue;
    if (seen.has(t.id)) continue;
    if (t.kind === 'scene') {
      // Exactly one scene tab, always carrying the sentinel id every consumer keys off. Its POSITION is
      // still preserved: the scene tab is reorderable like any other.
      if (sceneTab) continue;
      sceneTab = { id: sceneTabId, kind: 'scene', title: t.title };
      seen.add(sceneTabId);
      tabs.push(sceneTab);
      continue;
    }
    if (!isRestorableTab(t)) continue;
    seen.add(t.id);
    tabs.push(t);
  }
  if (!sceneTab) tabs.unshift({ id: sceneTabId, kind: 'scene', title: 'Scene' });

  const activeTabId = tabs.some(t => t.id === raw.activeTabId) ? raw.activeTabId : sceneTabId;
  const mainMode: MainMode = MAIN_MODES.includes(raw.mainMode) ? raw.mainMode : 'scene';
  return { version: 1, tabs, activeTabId, mainMode };
}

/** The session to boot into. Always returns something usable — a bad blob degrades to a lone scene tab. */
export function loadTabState(sceneTabId: string): TabState {
  const fallback: TabState = {
    version: 1,
    tabs: [{ id: sceneTabId, kind: 'scene', title: 'Scene' }],
    activeTabId: sceneTabId,
    mainMode: 'scene',
  };
  try {
    const raw = localStorage.getItem(tabStateKey());
    if (!raw) return fallback;
    return sanitize(JSON.parse(raw), sceneTabId) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveTabState(tabs: EditorTab[], activeTabId: string, mainMode: MainMode) {
  try {
    const keep = tabs.filter(isRestorableTab);
    // Clamp here: an unsaved tab is dropped above, so the ACTIVE tab is routinely one that is not stored,
    // and writing its id would leave a blob referring to a tab it does not contain.
    const active = keep.some(t => t.id === activeTabId) ? activeTabId : keep[0]?.id ?? activeTabId;
    const state: TabState = { version: 1, tabs: keep, activeTabId: active, mainMode };
    localStorage.setItem(tabStateKey(), JSON.stringify(state));
  } catch { /* quota — a lost session is not worth breaking the editor */ }
}
