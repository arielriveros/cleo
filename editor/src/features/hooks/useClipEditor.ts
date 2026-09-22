import EventEmitter from '../../utils/eventEmitter';
import { Logger, Node, Scene, CleoEngine, markEditorOwned } from 'cleo';
import { cryptoRandomId } from '../../utils/ids';
import { MaterialAsset } from '../../utils/materials';
import { AnimationAsset } from '../../utils/animationAssets';
import { ModelAsset, instantiateModelAsset } from '../../utils/models';
import { RigAsset } from '../../utils/rigAssets';
import { firstSkinnedModelNode } from '../../utils/animationFields';
import { combineBounds } from '../../utils/modelThumbnails';
import { invalidateAnimationCache } from '../../utils/animationResolve';
import { createAssetEditScene } from '../demoScene/createAssetEditScene';
import { createAnimationEditorScene } from '../demoScene/createAnimationEditorScene';
import { buildSkeletonProxy } from '../demoScene/skeletonProxy';
import type { EditorTab } from '../engineContextTypes';

type TabRuntime = { scene: Scene; rootId: string; previewModelId?: string; skinnedId?: string };

/**
 * The Clip editor slice: a tab per `.anim` asset.
 *
 * An asset, not a clip. A `.anim` routinely holds several clips, the RIG owns the clip list, and applying
 * one edit across many clips is the whole point of the feature — so the tab addresses the asset and the
 * selected clip is session state (see ClipContext). It previews through a model built on the asset's rig,
 * the same way the rig editor does, because a clip is meaningless without a skeleton to play it on.
 *
 * An asset whose rig has no character still opens: bones only, which is enough to mirror, retime or bake.
 */
export function useClipEditor(deps: {
  instanceRef: React.MutableRefObject<CleoEngine | null>;
  animationsRef: React.MutableRefObject<AnimationAsset[]>;
  rigsRef: React.MutableRefObject<RigAsset[]>;
  modelsRef: React.MutableRefObject<ModelAsset[]>;
  materialsRef: React.MutableRefObject<MaterialAsset[]>;
  tabRuntimeRef: React.MutableRefObject<Map<string, TabRuntime>>;
  dirtyArmedRef: React.MutableRefObject<boolean>;
  eventEmitter: React.MutableRefObject<EventEmitter>;
  tabs: EditorTab[];
  setActiveTab: (id: string) => void;
  commitTab: (tab: EditorTab, adoptTabId?: string) => void;
  setTabs: React.Dispatch<React.SetStateAction<EditorTab[]>>;
  withoutDirty: <T,>(fn: () => T) => T;
  updateAnimation: (id: string, a: AnimationAsset) => void;
  addAnimation: (a: AnimationAsset) => void;
  linkAnimationToRig: (rigId: string, animationId: string) => void;
  applyAnimationLinks: (model: ModelAsset, except?: any, extra?: AnimationAsset) => void;
  modelAnimationIdsOf: (model: ModelAsset) => string[];
  clearTabDirty: (id: string) => void;
  applyActiveTab: (tab: EditorTab) => void;
  activeTabId: string;
}) {
  const {
    instanceRef, animationsRef, rigsRef, modelsRef, materialsRef, tabRuntimeRef,
    dirtyArmedRef, eventEmitter, tabs, setActiveTab, commitTab, setTabs, withoutDirty,
    updateAnimation, addAnimation, linkAnimationToRig, applyAnimationLinks, modelAnimationIdsOf,
    clearTabDirty, applyActiveTab, activeTabId,
  } = deps;

  /**
   * The characters a clip asset can be previewed on: the models built on its source rig.
   *
   * Deliberately NOT every model that plays the clip. Keyframe editing writes in SOURCE-rig space, and the
   * only way a posed bone maps back there losslessly is if the preview rig IS the source rig — otherwise
   * the gizmo would be inverting a retarget that drops scale and non-hips translation. Restricting the
   * preview is what keeps that honest.
   */
  const modelsForClip = (asset: AnimationAsset): ModelAsset[] =>
    asset.rigId ? modelsRef.current.filter(m => m.rigId === asset.rigId) : [];

  /**
   * Build the preview scene for a clip asset, optionally on a chosen character.
   *
   * Returns the runtime entry synchronously — `hydrateTab` judges a restored tab's success by whether
   * `tabRuntimeRef` holds one, so this must never defer.
   */
  const buildPreview = (asset: AnimationAsset, modelId?: string): TabRuntime => {
    // Disarm before constructing the preview scene — see openMeshTab for why this is not optional:
    // SCENE_CHANGED names no scene, so `mark()` can only blame the ACTIVE tab.
    dirtyArmedRef.current = false;
    const scene = new Scene();
    scene.animationsEnabled = false; // the timeline drives the animator directly, not scene.update
    scene.spawnRulesEnabled = false;
    void createAssetEditScene(scene, withoutDirty);

    // Editor-OWNED (see `Node.isEditorOwned`), and so is the character instantiated under it. This tab saves
    // ClipProvider's working copy, never scene content, so no event from this subtree can be an edit — yet
    // the preview's root-motion playback writes its transform every frame, which marked the tab unsaved and
    // fed the undo recorder. The flag rather than a name marker: the holder is named after the asset.
    // Nothing serializes this scene; if something ever does, `Node.serialize` leaves the holder out.
    const holder = markEditorOwned(new Node(asset.name));
    scene.addNode(holder);

    const candidates = modelsForClip(asset);
    const model = (modelId ? candidates.find(m => m.id === modelId) : undefined) ?? candidates[0];
    let skinned: ReturnType<typeof firstSkinnedModelNode> = null;

    if (model) {
      // Bracketed as well: the flag reaches only the character root's own attach. The parser attaches
      // bottom-up, so every nested add fires while its parent is still detached and owned by nothing.
      withoutDirty(() =>
        instantiateModelAsset(model, holder, materialsRef.current, modelsRef.current, animationsRef.current));
      scene.root.updateTransforms();
      skinned = firstSkinnedModelNode(holder);
      if (!skinned) {
        Logger.warn(`"${model.name}" is on this clip's rig but has no skinned mesh — showing the skeleton only`, 'Editor');
      }
    }

    if (skinned) {
      const bounds = combineBounds(skinned);
      createAnimationEditorScene(scene, bounds.center, bounds.radius, { silently: withoutDirty });
    } else {
      // No character: stand a proxy up over the rig's own skin (or the one this asset embedded before
      // rigs existed), so the bone overlay, the joint tree and the transport have a skinned node to read.
      // Framed from its bind pose, since skeletons are often authored in centimetres.
      const rig = asset.rigId ? rigsRef.current.find(r => r.id === asset.rigId) : undefined;
      const proxy = buildSkeletonProxy(rig?.skin ?? asset.sourceSkin);
      if (proxy) {
        withoutDirty(() => holder.addChild(proxy.node));
        scene.root.updateTransforms();
        skinned = proxy.node;
      }
      createAnimationEditorScene(scene, proxy?.center ?? [0, 1, 0], proxy?.radius ?? 1.5, { silently: withoutDirty });
      if (!model) {
        Logger.info(
          proxy
            ? `No character uses "${asset.name}"'s rig yet — showing its skeleton on its own`
            : `"${asset.name}" is not linked to a rig, so there is no skeleton to play it on`, 'Editor');
      }
    }

    scene.start();
    skinned?.animator?.showBindPose();
    // `skinnedId` addresses the ModelNode itself, not the holder: the skeleton tree and the bone overlay
    // need a node carrying a skin, and `rootId` is the holder above it.
    return { scene, rootId: holder.id, previewModelId: model?.id, skinnedId: skinned?.id };
  };

  /** Open (or focus) a clip asset's edit tab. */
  const enterClipEditor = (animationId?: string, adoptTabId?: string) => {
    if (!instanceRef.current || !animationId) return;
    const asset = animationsRef.current.find(a => a.id === animationId);
    if (!asset) { Logger.error('Animation not found', 'Editor'); return; }

    // Focus-existing is an OPEN-time concern only: on hydration it would find the restored placeholder
    // and no-op, leaving the tab with no runtime.
    if (!adoptTabId) {
      const existing = tabs.find(t => t.kind === 'animation' && t.animationId === animationId);
      if (existing) { setActiveTab(existing.id); return; }
    }

    const tabId = adoptTabId ?? cryptoRandomId();
    tabRuntimeRef.current.set(tabId, buildPreview(asset));
    commitTab({ id: tabId, kind: 'animation', title: asset.name, animationId: asset.id }, adoptTabId);
    eventEmitter.current.emit('TEXTURES_CHANGED');
  };

  /**
   * Show a different character on the open clip tab. Rebuilds the preview scene in place, keeping the tab.
   *
   * The outgoing scene is dropped wholesale rather than patched: instantiating a second model into the
   * same holder would leave the first one in the shot.
   */
  const setClipPreviewModel = (tabId: string, modelId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    const asset = tab?.animationId ? animationsRef.current.find(a => a.id === tab.animationId) : undefined;
    if (!asset) return;
    tabRuntimeRef.current.set(tabId, buildPreview(asset, modelId));
    // Point the engine at the NEW scene. The tab id is unchanged, so the activate effect — which is keyed
    // on `activeTabId` — never fires, and the viewport would keep drawing the scene we just discarded
    // while the bone overlay read the new one.
    if (tabId === activeTabId) applyActiveTab(tab!);
    eventEmitter.current.emit('TEXTURES_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
  };

  /** Which character the open clip tab is previewing, if any. */
  const clipPreviewModelId = (tabId: string): string | undefined =>
    tabRuntimeRef.current.get(tabId)?.previewModelId;

  /**
   * Push an edited clip asset into the library and out to every character playing it.
   *
   * The three steps after `updateAnimation` are not optional and are the same ones `editSharedClip`
   * performs: the retarget cache is keyed by asset id and would otherwise keep serving the pre-edit clips
   * for the rest of the session, and the live nodes hold clips that were resolved before the edit.
   * `updated` is handed to `applyAnimationLinks` explicitly because `animationsRef` is a render mirror and
   * still holds the PREVIOUS asset during this call.
   */
  const pushAnimation = (updated: AnimationAsset) => {
    updateAnimation(updated.id, updated);
    invalidateAnimationCache(updated.id);
    for (const model of modelsRef.current) {
      if (modelAnimationIdsOf(model).includes(updated.id)) applyAnimationLinks(model, null, updated);
    }
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
  };

  /** Persist an edited clip asset. The working copy lives in ClipProvider; this is what its `apply` calls. */
  const saveClip = (asset: AnimationAsset) => {
    if (!animationsRef.current.some(a => a.id === asset.id)) { Logger.error('Animation not found', 'Editor'); return; }
    pushAnimation(asset);
    // `saveTabById` judges a save by whether the tab came out clean, so without this every clip save
    // reports failure and the tab stays dirty forever.
    const open = tabs.find(t => t.kind === 'animation' && t.animationId === asset.id);
    if (open) clearTabDirty(open.id);
    Logger.info(`Animation "${asset.name}" saved`, 'Editor');
  };

  /**
   * Save the working copy as a NEW `.anim` asset, and re-point the open tab at it.
   *
   * A separate asset rather than a clip appended to this one: a variant usually wants its own place in the
   * asset tree, and the original must be left exactly as it was — that is the whole reason the artist chose
   * Save As. It keeps the same `rigId` and `sourceSkin`, so it retargets identically, and is linked to the
   * rig so every character on that armature can play it.
   *
   * The tab follows the new asset rather than a second tab opening: the artist is looking at the thing they
   * just saved, and leaving them on the original — now silently reverted — is the surprising outcome.
   */
  const saveClipAs = (asset: AnimationAsset, name: string): string | null => {
    const tab = tabs.find(t => t.kind === 'animation' && t.animationId === asset.id);
    const copy: AnimationAsset = JSON.parse(JSON.stringify({ ...asset, id: cryptoRandomId(), name, thumbnail: undefined }));
    addAnimation(copy);
    if (copy.rigId) linkAnimationToRig(copy.rigId, copy.id);
    if (tab) {
      setTabs(prev => prev.map(t => (t.id === tab.id ? { ...t, animationId: copy.id, title: copy.name } : t)));
      clearTabDirty(tab.id);
    }
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    Logger.info(`Animation saved as "${copy.name}"`, 'Editor');
    return copy.id;
  };

  return { enterClipEditor, setClipPreviewModel, clipPreviewModelId, saveClip, saveClipAs, modelsForClip };
}
