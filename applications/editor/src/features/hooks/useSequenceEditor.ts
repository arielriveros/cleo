import EventEmitter from '@cleo/app-kit/utils/eventEmitter';
import { Logger, Scene, SequenceNode, CleoEngine } from 'cleo';
import { cryptoRandomId } from '../../utils/ids';
import { SequenceAsset, buildSequenceAsset, reembedSequences, toRuntimeSequence } from '../../utils/sequenceAssets';
import { SCENE_TAB_ID } from '../engineContextTypes';
import type { EditorTab } from '../engineContextTypes';

type TabRuntime = { scene: Scene; rootId: string };

/**
 * The sequence asset slice, in the shape of `useParticleSystemEditor`'s asset half: opening a `.sequence` in a
 * Sequencer tab, linking and extracting, and saving (which pushes the timeline into every node that plays a
 * copy of it).
 *
 * A Sequencer tab owns NO session scene: it gets no `tabRuntimeRef` entry, so the editor shows the open scene
 * while it is active — the scene it animates. Its working copy, playhead and preview live in
 * SequenceEditorProvider (features/sequencer/SequenceEditorContext.tsx), one per open tab.
 */
export function useSequenceEditor(deps: {
  instanceRef: React.MutableRefObject<CleoEngine | null>;
  sequencesRef: React.MutableRefObject<SequenceAsset[]>;
  tabRuntimeRef: React.MutableRefObject<Map<string, TabRuntime>>;
  editorSceneRef: React.MutableRefObject<Scene>;
  eventEmitter: React.MutableRefObject<EventEmitter>;
  tabsRef: React.MutableRefObject<EditorTab[]>;
  setTabs: React.Dispatch<React.SetStateAction<EditorTab[]>>;
  setActiveTab: (id: string) => void;
  commitTab: (tab: EditorTab, adoptTabId?: string) => void;
  markTabDirty: (id: string, reason?: string) => void;
  clearTabDirty: (id: string) => void;
  addSequence: (q: SequenceAsset) => void;
  updateSequence: (id: string, q: SequenceAsset) => void;
}) {
  const {
    instanceRef, sequencesRef, tabRuntimeRef, editorSceneRef, eventEmitter,
    tabsRef, setTabs, setActiveTab, commitTab, markTabDirty, clearTabDirty, addSequence, updateSequence,
  } = deps;

  /**
   * Open (or focus) a sequence's Sequencer tab, minting a new asset when called with no id (the
   * "+ Add > Sequence" path). `contextNodeId` is the Sequence node it was opened from: the preview borrows
   * that node's slot bindings.
   */
  const enterSequenceEditor = (id?: string | null, options: { contextNodeId?: string | null; adoptTabId?: string } = {}) => {
    if (!instanceRef.current) return;
    const { contextNodeId = null, adoptTabId } = options;
    let asset = id ? sequencesRef.current.find(q => q.id === id) : undefined;
    if (!id) {
      asset = buildSequenceAsset();
      addSequence(asset);
      // The library update lands in the next commit; seed the ref so the tab opens against the new asset.
      sequencesRef.current = [...sequencesRef.current, asset];
    }
    if (!asset) { Logger.error('Sequence not found', 'Editor'); return; }

    if (!adoptTabId && id) {
      const existing = tabsRef.current.find(t => t.kind === 'sequence' && t.sequenceId === id);
      if (existing) {
        if (contextNodeId && existing.sequenceContextNodeId !== contextNodeId)
          setTabs(prev => prev.map(t => t.id === existing.id ? { ...t, sequenceContextNodeId: contextNodeId } : t));
        setActiveTab(existing.id);
        return;
      }
    }
    const tabId = adoptTabId ?? cryptoRandomId();
    commitTab({ id: tabId, kind: 'sequence', title: asset.name, sequenceId: asset.id, sequenceContextNodeId: contextNodeId }, adoptTabId);
  };

  /** Copy a library sequence onto a node and record the link; null unlinks and leaves the copy playing. */
  const linkSequenceToNode = (node: SequenceNode, id: string | null) => {
    if (!id) { node.sequenceId = null; return; }
    const asset = sequencesRef.current.find(q => q.id === id);
    if (!asset) { Logger.warn('Sequence not found', 'Editor'); return; }
    node.sequence = toRuntimeSequence(asset);
    node.sequenceId = id;
  };

  /**
   * Turn a node's embedded sequence into a library asset and link it. COPIED: the node keeps playing exactly
   * what it was playing. Returns the asset, which `sequences` will not hold until the next commit.
   */
  const extractSequenceFromNode = (node: SequenceNode, name?: string): SequenceAsset => {
    const asset = buildSequenceAsset(name?.trim() || node.sequence.name || node.name, node.sequence);
    addSequence(asset);
    sequencesRef.current = [...sequencesRef.current, asset];
    node.sequenceId = asset.id;
    return asset;
  };

  /**
   * Persist an edited sequence and push it into every node already playing a copy: the open scene's and every
   * tab scene's (a template being edited may hold one). Each scene that changed is marked unsaved — its nodes
   * now hold a timeline its saved blob does not.
   */
  const saveSequence = (asset: SequenceAsset): number => {
    updateSequence(asset.id, asset);
    const assets = sequencesRef.current.map(q => q.id === asset.id ? asset : q);
    sequencesRef.current = assets;

    let count = 0;
    const touched = (tabId: string, scene: Scene) => {
      const n = reembedSequences(scene, assets);
      if (n) { count += n; markTabDirty(tabId, 'sequence-reembed'); }
    };
    touched(SCENE_TAB_ID, editorSceneRef.current);
    for (const [tabId, rt] of tabRuntimeRef.current) touched(tabId, rt.scene);
    if (count) eventEmitter.current.emit('SCENE_CHANGED');

    for (const open of tabsRef.current.filter(t => t.kind === 'sequence' && t.sequenceId === asset.id)) {
      clearTabDirty(open.id);
      if (open.title !== asset.name) setTabs(prev => prev.map(t => t.id === open.id ? { ...t, title: asset.name } : t));
    }
    Logger.info(`Sequence "${asset.name}" saved${count ? ` (updated ${count} node${count === 1 ? '' : 's'})` : ''}`, 'Editor');
    return count;
  };

  return { enterSequenceEditor, linkSequenceToNode, extractSequenceFromNode, saveSequence };
}
