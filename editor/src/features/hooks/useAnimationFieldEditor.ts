import EventEmitter from 'events';
import { Logger, Node, Scene, ModelNode, CleoEngine } from 'cleo';
import { cryptoRandomId } from '../../utils/ids';
import { MaterialAsset } from '../../utils/materials';
import { AnimationAsset } from '../../utils/animationAssets';
import { ModelAsset, instantiateModelAsset } from '../../utils/models';
import {
  AnimationFieldAsset, buildAnimationFieldAsset, firstSkinnedModelNode, modelAssetIsSkinned,
  reembedFields, machineUsesField,
} from '../../utils/animationFields';
import { combineBounds } from '../../utils/modelThumbnails';
import { createAssetEditScene } from '../demoScene/createAssetEditScene';
import { createAnimationEditorScene } from '../demoScene/createAnimationEditorScene';
import { SCENE_TAB_ID } from '../engineContextTypes';
import type { EditorTab } from '../engineContextTypes';

type TabRuntime = { scene: Scene; rootId: string };

/**
 * The Animation Field editor slice, lifted out of EngineProvider verbatim.
 *
 * Like the tileset slice it owns no state — the field being authored lives in AnimationFieldProvider —
 * but the three entry points belong together: opening a field builds the throwaway preview scene that
 * creating one immediately opens, and saving one has to push the new blend into every live scene playing
 * a copy of it.
 */
export function useAnimationFieldEditor(deps: {
  instanceRef: React.MutableRefObject<CleoEngine | null>;
  animationFieldsRef: React.MutableRefObject<AnimationFieldAsset[]>;
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
  liveScenes: (exceptTabId?: string) => Scene[];
  markTabDirty: (id: string, reason?: string) => void;
  addAnimationField: (f: AnimationFieldAsset) => void;
  updateAnimationField: (id: string, f: AnimationFieldAsset) => void;
}) {
  const {
    instanceRef, animationFieldsRef, modelsRef, materialsRef, animationsRef, tabRuntimeRef,
    dirtyArmedRef, eventEmitter, tabs, setActiveTab, commitTab, withoutDirty, liveScenes,
    markTabDirty, addAnimationField, updateAnimationField,
  } = deps;

  // ---- Animation Field editor ------------------------------------------------------------------------

  // Open (or focus) an Animation Field's edit tab. Like the model tab it owns a throwaway scene, holding
  // ONE instance of the field's source model asset — the field editor's transport drives that model's
  // animator directly (the scene is paused), so the blend can be previewed live while it is authored.
  const enterAnimationFieldEditor = (fieldId?: string, adoptTabId?: string) => {
    if (!instanceRef.current || !fieldId) return;
    const field = animationFieldsRef.current.find(f => f.id === fieldId);
    if (!field) { Logger.error('Animation field not found', 'Editor'); return; }

    if (!adoptTabId) {
      const existing = tabs.find(t => t.kind === 'animationField' && t.animationFieldId === fieldId);
      if (existing) { setActiveTab(existing.id); return; }
    }

    const model = modelsRef.current.find(m => m.id === field.modelId);
    if (!model) {
      Logger.error(`"${field.name}" blends a model that no longer exists — the field cannot be opened`, 'Editor');
      return;
    }

    // Disarm before constructing the preview scene — see openMeshTab for why this is not optional.
    dirtyArmedRef.current = false;
    const scene = new Scene();
    scene.animationsEnabled = false; // the field transport drives the animator itself, not scene.update
    scene.spawnRulesEnabled = false;
    void createAssetEditScene(scene, withoutDirty);

    const holder = new Node(field.name);
    scene.addNode(holder);
    instantiateModelAsset(model, holder, materialsRef.current, modelsRef.current, animationsRef.current);
    scene.root.updateTransforms();

    const skinned = firstSkinnedModelNode(holder);
    if (!skinned) {
      Logger.error(`"${model.name}" has no skeleton — an animation field needs a skinned model`, 'Editor');
      return;
    }
    // Frame the camera + shadow-catching ground around the model, exactly as the Animation Editor does.
    const bounds = combineBounds(skinned);
    createAnimationEditorScene(scene, bounds.center, bounds.radius);
    scene.start();
    skinned.animator?.showBindPose();

    const tabId = adoptTabId ?? cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: holder.id });
    commitTab({ id: tabId, kind: 'animationField', title: field.name, animationFieldId: fieldId }, adoptTabId);
    eventEmitter.current.emit('TEXTURES_CHANGED');
  };

  /** Create a field for a skinned model asset and open it. Returns the new field's id, or null. */
  const createAnimationFieldForModel = (modelId: string): string | null => {
    const model = modelsRef.current.find(m => m.id === modelId);
    if (!model) { Logger.error('Model not found', 'Editor'); return null; }
    if (!modelAssetIsSkinned(model)) {
      Logger.warn(`"${model.name}" has no skeleton — only skinned models can be blended in an animation field`, 'Editor');
      return null;
    }
    const asset = buildAnimationFieldAsset(`${model.name} Field`, modelId);
    addAnimationField(asset);
    // The library update lands in the next commit, so the open has to read the asset we just built rather
    // than the (still stale) state — hence seeding the ref directly.
    animationFieldsRef.current = [...animationFieldsRef.current, asset];
    enterAnimationFieldEditor(asset.id);
    return asset.id;
  };

  /**
   * Persist an edited field and push it into everything already playing it. The re-embed is what keeps
   * embed-on-Apply honest: a state stores a COPY of the field, so without it an edit would only reach nodes
   * whose machine was applied again afterwards. Every live scene is walked.
   */
  const saveAnimationField = (asset: AnimationFieldAsset) => {
    updateAnimationField(asset.id, asset);
    const fields = animationFieldsRef.current.map(f => f.id === asset.id ? asset : f);
    animationFieldsRef.current = fields;

    let count = 0;
    for (const scene of liveScenes()) {
      for (const n of Array.from(scene.nodes)) {
        if (!(n instanceof ModelNode) || !n.animator) continue;
        const sm = n.animator.getStateMachine();
        if (!machineUsesField(sm, asset.id)) continue;
        n.animator.setStateMachine(reembedFields(sm as any, fields) as any);
        count++;
      }
    }
    if (count) {
      // The edit landed on nodes in those scenes, so their owners have unsaved changes. Only the scene tab
      // can be identified generically here; an asset tab's own save re-serializes its subtree anyway.
      markTabDirty(SCENE_TAB_ID, 'animation-field-reembed');
      eventEmitter.current.emit('SCENE_CHANGED');
    }
    Logger.info(`Animation field "${asset.name}" saved${count ? ` (updated ${count} model${count === 1 ? '' : 's'})` : ''}`, 'Editor');
  };

  return { enterAnimationFieldEditor, createAnimationFieldForModel, saveAnimationField };
}
