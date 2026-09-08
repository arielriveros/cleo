import EventEmitter from '../../utils/eventEmitter';
import { Logger, Node, Scene, CleoEngine } from 'cleo';
import { cryptoRandomId } from '../../utils/ids';
import { MaterialAsset } from '../../utils/materials';
import { AnimationAsset } from '../../utils/animationAssets';
import { ModelAsset, instantiateModelAsset } from '../../utils/models';
import { RigAsset } from '../../utils/rigAssets';
import { firstSkinnedModelNode } from '../../utils/animationFields';
import { combineBounds } from '../../utils/modelThumbnails';
import { createAssetEditScene } from '../demoScene/createAssetEditScene';
import { createAnimationEditorScene } from '../demoScene/createAnimationEditorScene';
import type { EditorTab } from '../engineContextTypes';

type TabRuntime = { scene: Scene; rootId: string; previewModelId?: string; skinnedId?: string };

/**
 * The Rig editor slice.
 *
 * A rig is a SKELETON and nothing else — it has no mesh of its own — so the tab previews it through a
 * model built on it, picked automatically and switchable from the inspector. That is what makes it
 * possible to watch a clip actually play, which is the point of owning clips at the rig level.
 *
 * A rig with no model must still open: a skeleton is a standalone asset precisely so it can exist before
 * (or after) any character uses it. That case gets an empty scene and the bone overlay.
 */
export function useRigEditor(deps: {
  instanceRef: React.MutableRefObject<CleoEngine | null>;
  rigsRef: React.MutableRefObject<RigAsset[]>;
  modelsRef: React.MutableRefObject<ModelAsset[]>;
  materialsRef: React.MutableRefObject<MaterialAsset[]>;
  animationsRef: React.MutableRefObject<AnimationAsset[]>;
  tabRuntimeRef: React.MutableRefObject<Map<string, TabRuntime>>;
  dirtyArmedRef: React.MutableRefObject<boolean>;
  eventEmitter: React.MutableRefObject<EventEmitter>;
  tabs: EditorTab[];
  setActiveTab: (id: string) => void;
  commitTab: (tab: EditorTab, adoptTabId?: string) => void;
  withoutDirty: <T,>(fn: () => T) => T;
  updateRig: (id: string, rig: RigAsset) => void;
  clearTabDirty: (id: string) => void;
  applyActiveTab: (tab: EditorTab) => void;
  activeTabId: string;
}) {
  const {
    instanceRef, rigsRef, modelsRef, materialsRef, animationsRef, tabRuntimeRef,
    dirtyArmedRef, eventEmitter, tabs, setActiveTab, commitTab, withoutDirty, updateRig,
    clearTabDirty, applyActiveTab, activeTabId,
  } = deps;

  /** The models built on a rig — the candidates its preview can show. */
  const modelsOnRig = (rigId: string): ModelAsset[] => modelsRef.current.filter(m => m.rigId === rigId);

  /**
   * Build the preview scene for a rig, optionally on a chosen model.
   *
   * Returns the runtime entry synchronously — `hydrateTab` judges a restored tab's success by whether
   * `tabRuntimeRef` holds one, so this must never defer.
   */
  const buildPreview = (rig: RigAsset, modelId?: string): TabRuntime => {
    // Disarm before constructing the preview scene — see openMeshTab for why this is not optional:
    // SCENE_CHANGED names no scene, so `mark()` can only blame the ACTIVE tab.
    dirtyArmedRef.current = false;
    const scene = new Scene();
    scene.animationsEnabled = false; // the transport drives the animator directly, not scene.update
    scene.spawnRulesEnabled = false;
    void createAssetEditScene(scene, withoutDirty);

    const holder = new Node(rig.name);
    scene.addNode(holder);

    const candidates = modelsOnRig(rig.id);
    const model = (modelId ? candidates.find(m => m.id === modelId) : undefined) ?? candidates[0];
    let skinned: ReturnType<typeof firstSkinnedModelNode> = null;

    if (model) {
      instantiateModelAsset(model, holder, materialsRef.current, modelsRef.current, animationsRef.current);
      scene.root.updateTransforms();
      skinned = firstSkinnedModelNode(holder);
      if (!skinned) {
        Logger.warn(`"${model.name}" uses this rig but has no skinned mesh — showing the skeleton only`, 'Editor');
      }
    }

    if (skinned) {
      const bounds = combineBounds(skinned);
      createAnimationEditorScene(scene, bounds.center, bounds.radius);
    } else {
      // No character to frame. A unit-ish box keeps the camera somewhere sensible so the bone overlay,
      // which draws in world space, lands on screen.
      createAnimationEditorScene(scene, [0, 1, 0], 1.5);
      if (!model) {
        Logger.info(`No model uses "${rig.name}" yet — showing its skeleton on its own`, 'Editor');
      }
    }

    scene.start();
    skinned?.animator?.showBindPose();
    // `skinnedId` addresses the ModelNode itself, not the holder: the skeleton tree and the bone
    // overlay need a node carrying a skin, and `rootId` is the holder above it.
    return { scene, rootId: holder.id, previewModelId: model?.id, skinnedId: skinned?.id };
  };

  /** Open (or focus) a rig's edit tab. */
  const enterRigEditor = (rigId?: string, adoptTabId?: string) => {
    if (!instanceRef.current || !rigId) return;
    const rig = rigsRef.current.find(r => r.id === rigId);
    if (!rig) { Logger.error('Rig not found', 'Editor'); return; }

    // Focus-existing is an OPEN-time concern only: on hydration it would find the restored placeholder
    // and no-op, leaving the tab with no runtime.
    if (!adoptTabId) {
      const existing = tabs.find(t => t.kind === 'rig' && t.rigId === rigId);
      if (existing) { setActiveTab(existing.id); return; }
    }

    const tabId = adoptTabId ?? cryptoRandomId();
    tabRuntimeRef.current.set(tabId, buildPreview(rig));
    commitTab({ id: tabId, kind: 'rig', title: rig.name, rigId: rig.id }, adoptTabId);
    eventEmitter.current.emit('TEXTURES_CHANGED');
  };

  /**
   * Show a different character on the open rig tab. Rebuilds the preview scene in place, keeping the tab.
   *
   * The outgoing scene is dropped wholesale rather than patched: instantiating a second model into the
   * same holder would leave the first one in the shot.
   */
  const setRigPreviewModel = (tabId: string, modelId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    const rig = tab?.rigId ? rigsRef.current.find(r => r.id === tab.rigId) : undefined;
    if (!rig) return;
    tabRuntimeRef.current.set(tabId, buildPreview(rig, modelId));
    // Point the engine at the NEW scene. The tab id is unchanged, so the activate effect — which is keyed
    // on `activeTabId` — never fires, and the viewport would keep drawing the scene we just discarded
    // while the bone overlay read the new one.
    if (tabId === activeTabId) applyActiveTab(tab!);
    eventEmitter.current.emit('TEXTURES_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
  };

  /** Which character the open rig tab is previewing, if any. */
  const rigPreviewModelId = (tabId: string): string | undefined =>
    tabRuntimeRef.current.get(tabId)?.previewModelId;

  /** Persist an edited rig. The working copy lives in RigProvider; this is what its `apply` calls. */
  const saveRig = (rig: RigAsset) => {
    const current = rigsRef.current.find(r => r.id === rig.id);
    if (!current) { Logger.error('Rig not found', 'Editor'); return; }
    updateRig(rig.id, rig);
    // `saveTabById` judges a save by whether the tab came out clean, so without this every rig save
    // reports failure and the tab stays dirty forever.
    const open = tabs.find(t => t.kind === 'rig' && t.rigId === rig.id);
    if (open) clearTabDirty(open.id);
    Logger.info(`Rig "${rig.name}" saved`, 'Editor');
  };

  return { enterRigEditor, setRigPreviewModel, rigPreviewModelId, saveRig, modelsOnRig };
}
