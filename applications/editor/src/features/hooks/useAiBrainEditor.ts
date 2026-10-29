import { Logger } from 'cleo';
import type { ControllerNode } from 'cleo';
import { AiBrainAsset, AiBrainKind, buildAiBrainAsset, toRuntimeBrain } from '../../utils/aiBrains';
import { cryptoRandomId } from '../../utils/ids';
import type { EditorTab } from '../engineContextTypes';

/**
 * The AI-brain-tab slice, in the shape of `useTilesetEditor`.
 *
 * Like a tileset, a brain tab owns NO scene: it is a graph on a canvas, so there is no `tabRuntimeRef`
 * entry, no throwaway `Scene` and no renderer involvement. What this owns is the relationship between
 * "open a brain", "make one out of a controller's inline brain" and "save one".
 */
export function useAiBrainEditor(deps: {
  aiBrainsRef: React.MutableRefObject<AiBrainAsset[]>;
  tabsRef: React.MutableRefObject<EditorTab[]>;
  setTabs: React.Dispatch<React.SetStateAction<EditorTab[]>>;
  addAiBrain: (b: AiBrainAsset) => void;
  updateAiBrain: (id: string, b: AiBrainAsset) => void;
  setActiveTab: (id: string) => void;
  commitTab: (tab: EditorTab, adoptTabId?: string) => void;
  clearTabDirty: (id: string) => void;
}) {
  const {
    aiBrainsRef, tabsRef, setTabs,
    addAiBrain, updateAiBrain, setActiveTab, commitTab, clearTabDirty,
  } = deps;

  /**
   * Open a brain's tab, minting one when called with no id (the "+ Add > AI Brain" path).
   *
   * `kind` only matters for a new asset — an existing one already knows what it is, and its kind is
   * what decides which canvas the tab draws.
   */
  const enterAiBrainEditor = (brainId?: string, kind: AiBrainKind = 'behavior', adoptTabId?: string) => {
    let asset = brainId ? aiBrainsRef.current.find(b => b.id === brainId) : undefined;

    if (!brainId) {
      asset = buildAiBrainAsset(kind === 'goals' ? 'Goal Brain' : 'Behaviour Brain', kind);
      addAiBrain(asset);
      // The library update lands in the next commit, so seed the ref directly — otherwise the tab opens
      // against state that does not yet contain the asset it was just given.
      aiBrainsRef.current = [...aiBrainsRef.current, asset];
    }
    if (!asset) { Logger.error('AI brain not found', 'Editor'); return; }

    if (!adoptTabId && brainId) {
      const existing = tabsRef.current.find(t => t.kind === 'aiBrain' && t.aiBrainId === brainId);
      if (existing) { setActiveTab(existing.id); return; }
    }
    const tabId = adoptTabId ?? cryptoRandomId();
    commitTab({ id: tabId, kind: 'aiBrain', title: asset.name, aiBrainId: asset.id }, adoptTabId);
  };

  /**
   * Turn a controller's inline brain into a library asset and link it.
   *
   * The "Extract to asset" button, and the same call the load-time migration makes. The controller's
   * data is COPIED rather than moved: it keeps running exactly what it was running, and simply starts
   * saying where that came from.
   *
   * Returns the new asset, not just its id — a caller wanting to reference it immediately cannot find
   * it in `aiBrains` yet, since that state update lands a commit later.
   */
  const extractBrainFromController = (controller: ControllerNode, name?: string): AiBrainAsset => {
    const kind: AiBrainKind = controller.brain === 'goal' ? 'goals' : 'behavior';
    const asset = buildAiBrainAsset(name?.trim() || `${controller.name} brain`, kind);
    asset.machine = controller.behavior;
    asset.graph = controller.goals;
    asset.fuzzy = controller.fuzzy;

    addAiBrain(asset);
    aiBrainsRef.current = [...aiBrainsRef.current, asset];
    controller.brainId = asset.id;
    return asset;
  };

  /** Copy a library brain onto a controller and record the link. */
  const linkBrainToController = (controller: ControllerNode, brainId: string | null) => {
    controller.brainId = brainId;
    const asset = brainId ? aiBrainsRef.current.find(b => b.id === brainId) : undefined;
    if (!asset) return;
    const next = toRuntimeBrain(asset);
    controller.behavior = next.behavior;
    controller.goals = next.goals;
    controller.fuzzy = next.fuzzy;
    controller.brain = next.brain;
  };

  /** Persist an edited brain and push it into every controller already holding a copy of it. */
  const saveAiBrain = (asset: AiBrainAsset) => {
    // `updateAiBrain` does the re-embed across every live scene, so nothing extra is needed here.
    updateAiBrain(asset.id, asset);
    aiBrainsRef.current = aiBrainsRef.current.map(b => b.id === asset.id ? asset : b);
    const open = tabsRef.current.find(t => t.kind === 'aiBrain' && t.aiBrainId === asset.id);
    if (open) {
      clearTabDirty(open.id);
      if (open.title !== asset.name) setTabs(prev => prev.map(t => t.id === open.id ? { ...t, title: asset.name } : t));
    }
    Logger.info(`AI brain "${asset.name}" saved`, 'Editor');
  };

  return { enterAiBrainEditor, extractBrainFromController, linkBrainToController, saveAiBrain };
}
