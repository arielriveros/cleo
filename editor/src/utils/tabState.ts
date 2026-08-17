// Persistence for the editor's open documents: the tab strip, which tab was active, and the scene tab's
// sub-mode. Kept in localStorage rather than IndexedDB because DockLayout has to read the mode it implies
// synchronously on mount — an async read would build one mode's panel layout and then rebuild it.
//
// Only the tab METADATA is stored. A tab's live edit session (its throwaway Scene, its LOD levels, its
// script buffer) is rebuilt from the asset it names, which is why a tab that names no asset cannot come back.

import type { EditorTab, TabKind } from '../features/EngineContext';
import { LS_KEYS, lsKey } from './lsScope';

// Per-project: this names asset ids that exist in exactly one project, so a shared session would restore
// tabs pointing at assets another project has never heard of.
const tabStateKey = () => lsKey(LS_KEYS.editorTabs);

export type MainMode = 'scene' | 'landscape' | 'renderer';
const MAIN_MODES: readonly MainMode[] = ['scene', 'landscape', 'renderer'];

export type TabState = {
  version: 1;
  tabs: EditorTab[];
  activeTabId: string;
  mainMode: MainMode;
};

/**
 * Which field on `EditorTab` names the asset each restorable kind edits.
 *
 * `animation` is deliberately absent, and it is the one exclusion that is about behaviour rather than data.
 * Its builder is the only asynchronous one, and it captures the source scene and source TAB from whatever is
 * active when it is called — restoring it at boot would therefore both flash and record the wrong write-back
 * target for "Apply to Model". An animation tab is a session on a node, not a document.
 */
const ID_FIELD: Partial<Record<TabKind, keyof EditorTab>> = {
  template: 'templateId',
  material: 'materialId',
  terrainMaterial: 'terrainMaterialId',
  model: 'modelId',
  script: 'scriptId',
  animationField: 'animationFieldId',
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
 *
 * A brand-new, never-saved asset tab (`materialId: null`) exists only as the live objects in its runtime
 * scene, so there is nothing to rebuild it from. Dropping it on reload is a real loss — the beforeunload
 * guard is what warns about it.
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
      // Exactly one scene tab, and it always carries the sentinel id — every consumer keys off it. Its
      // POSITION is preserved though: the scene tab is reorderable like any other.
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
    // Clamp here rather than leaning on loadTabState to do it. An unsaved "New Material" tab is dropped
    // above, so it is entirely normal for the ACTIVE tab to be one that isn't stored — writing its id anyway
    // would leave a blob that refers to a tab it doesn't contain.
    const active = keep.some(t => t.id === activeTabId) ? activeTabId : keep[0]?.id ?? activeTabId;
    const state: TabState = { version: 1, tabs: keep, activeTabId: active, mainMode };
    localStorage.setItem(tabStateKey(), JSON.stringify(state));
  } catch { /* quota — a lost session is not worth breaking the editor */ }
}
