import { createContext, useContext, useState, useRef, useEffect, useMemo } from "react";
import { EventBusContext } from "./EventBusContext";
import { EngineHostProvider, type EngineHost } from "@cleo/app-kit/engine/EngineHost";
import { stepViewCamera2D, stepViewCamera3D, type ViewCameraPrefs } from "@cleo/app-kit/engine/viewCamera";
import { SelectionContext, type SelectionContextValue } from "./SelectionContext";
import { PlaybackContext, type PlaybackContextValue } from "./PlaybackContext";
import {
  DebugVisibilityContext, type DebugVisibilityContextValue,
  type DebugVisibility, type DebugCategory, type DebugChannel,
  loadDebugVisibility, saveDebugVisibility,
} from "./DebugVisibilityContext";
import { AssetLibraryContext, type AssetLibraryContextValue } from "./AssetLibraryContext";
import { DocumentContext, type DocumentContextValue } from "./DocumentContext";
import { ProjectContext, type ProjectContextValue } from "./ProjectContext";
import { EditorSessionsContext, type EditorSessionsContextValue } from "./EditorSessionsContext";
import { useStableActions } from "@cleo/app-kit/utils/useStableActions";
import { describeChange, logDirtyMark, logDirtyClear, logDirtySkip } from "../utils/dirtyDebug";
import { isEditorOwnedChange } from "../utils/editorOwned";
import { resetScriptModules, addScriptModuleSources, nextFrame } from "cleo";
import { CleoEngine, Scene, InputSystem, DEFAULT_INPUT_MAP, parseInputMap, cloneInputMap, Model, Geometry, Material, CustomMaterial, TerrainMaterial, Terrain, allTerrainFoliageRules, Node, ModelNode, CameraNode, AnimatedModel, TextureManager, AudioManager, Logger, Loader, buildBoneMapping, mappingReport, retargetAnimation, describeRetarget, setGameHost, registerTemplates, disposeModelSubtree, foliageRuleKey, assetGraph, assetKey, markEditorOwned, isEditorOwnedName, LandscapeNode } from "cleo";
import type { SceneChange, TerrainFoliageRule, InputMap, LoadProgressListener, RenderSettings } from "cleo";
import NullImage from '../images/null.png';
import EventEmitter from "@cleo/app-kit/utils/eventEmitter";
import { createEmptyScene, ensureEditorCamera } from './demoScene/createEmptyScene';
import { createMaterialPreviewScene } from './demoScene/createMaterialPreviewScene';
import { previewSphereGeometry, PREVIEW_TERRAIN_RADIUS, PREVIEW_TERRAIN_SIZE, REFERENCE_LANDSCAPE }
  from './demoScene/previewFraming';
import { buildTerrainPreviewSubject } from './demoScene/previewTerrainSubject';
import {
  loadPreviewShape, savePreviewShape, applyMaterialPreviewShape, applyTerrainPreviewShape,
  updateTerrainPreviewMapping, terrainPreviewSphere, elevationLegend,
  type PreviewShape, type TerrainPreview,
} from './demoScene/previewShapes';
import { createAnimationEditorScene } from './demoScene/createAnimationEditorScene';
import { createAssetEditScene } from './demoScene/createAssetEditScene';
import { parseByType, regenerateIds, stripDebug } from "../utils/nodeSubtree";
import { cryptoRandomId } from "../utils/ids";
import { Template, buildTemplateFromNode, instantiateTemplate, TEMPLATE_ID_VAR, templateInstanceRootOf } from "../utils/templates";
import { cascadeFrom, cloneJson, createVariant, flattenVariant, materializeVariant, rebaseVariant, revertInDiff, saveVariant, variantFromContent, type TemplateDiff } from "../utils/templateVariants";
import { clearOverride, writeOverrides, pathOf, nodeAtPath, OVERRIDES_VAR } from "../utils/templateOverrides";
import { MaterialAsset, buildMaterialAsset, applyMaterialAsset, getMaterialIdOf, getMaterialIdsOf, getNodeMaterial, unlinkToFallback, unlinkMaterialAt, materialSlotsReferencing, resolveMaterialRefs, serializedVar, MATERIAL_ID_VAR, MATERIAL_IDS_VAR } from "../utils/materials";
import { getScreenMaterialIds, applyScreenMaterials } from "../utils/screenMaterials";
import { TerrainMaterialAsset, buildTerrainMaterialAsset, parseTerrainMaterialAsset, applyTerrainMaterialToLayer, collectTerrainMaterialTextureIds, syncSlotMaterialInTerrain, withSyncedSlotMaterial } from "../utils/terrainMaterials";
import { buildFoliageRuleFromModelAsset } from "../utils/foliageRules";
import { ModelAsset, ModelLodDef, MODEL_ID_VAR, buildModelAsset, instantiateModelAsset, separateSubModels, mergeSubModels, groupSubModels, recenterIfOffOrigin, rescaleLodDistances, nodeJsonHasSkinnedModel, lodLevelJson, nodeJsonHasModel, modelIdOf, refreshModelClips, assetWithClipAdded, assetWithClipRenamed, assetWithClipRemoved, assetWithClipRootMotion, assetWithBoneNames, assetWithIkRig, assetWithSockets, assetWithRagdollProfile, flattenModelAsset, skinnedModelJsonOf, skinnedModelJsonsOf, assetWithoutEmbeddedClips, modelAssetHasLodBehavior, modelInstanceShape, applyModelTransformDelta, readModelBaseTrs, modelNodeOf, LOD_CULL_MARGIN, DEFAULT_IMPOSTOR_DISTANCE, buildPartAsset, submeshNodeJson, uniqueModelName, lodLevelMaterialLinks, withLevelLinks, type ModelPart } from "../utils/models";
import { downscaleTextures, levelTextureIds, maskTextureIds } from "../utils/lodTextures";
import { detachForeignChildren, reattachForeignChildren } from "../utils/foreignChildren";
import { ScriptAsset, ScriptBaseType, SCRIPT_ID_VAR, buildScriptAsset, applyScriptAsset, unlinkScript, getScriptIdOf, defaultScriptClass, defaultScriptModule, seedScriptFields, scriptKindOfAsset } from "../utils/scripts";
import { buildScriptGraphCtx, deriveBaseType, resolveScriptVariables, dependentsOf } from "../utils/scriptGraph";
import { pushExternalSource } from "./scriptWorkspace/externalSourceStore";
import { AnimationAsset, buildAnimationAsset, storeSkin, findEquivalentAnimation, withAnimationRef, withoutAnimationRef, extractEmbeddedClips } from "../utils/animationAssets";
import type { StoredSkin } from "../utils/animationAssets";
import { modelAssetSkin, applyModelAnimations, modelAnimationIds, invalidateAnimationCache, resolveAnimationAsset, registerRigResolver, registerPoseAssetResolver } from "../utils/animationResolve";
import { AnimationFieldAsset, firstSkinnedModelNode, modelAssetIsSkinned, reembedFields, machineUsesField } from "../utils/animationFields";
import { TilesetAsset, reembedTilesets, detachTileset, normalizeTilesetAsset } from "../utils/tilesets";
import { AiBrainAsset, AiBrainKind, buildAiBrainAsset, reembedBrains, detachBrain } from "../utils/aiBrains";
import { ParticleSystemAsset, buildParticleSystemAsset, reembedParticleSystems, detachParticleSystem } from "../utils/particleSystems";
import type { AnimControllerAsset } from "../utils/animationControllers";
import { instantiateController, reembedMachine, pickControllerForRig, machineIsEmpty, buildControllerAsset } from "../utils/animationControllers";
import { buildFromTemplate, templateById, type TemplateId } from "../utils/animatorTemplates";
import { guessFootPlacement } from "../utils/footPlacementAuto";
import type { BoneMaskAsset } from "../utils/boneMasks";
import type { PoseAsset } from "../utils/poseAssets";
import type { ControllerNode, ParticleSystemNode } from "cleo";
import type { ImageAsset } from "../utils/images";
import type { AudioSourceAsset } from "../utils/audioSources";
import type { SoundSampleAsset } from "../utils/soundSamples";
import { toTextureConfig } from "../utils/textureAssets";
import type { TextureAsset } from "../utils/textureAssets";
import { groupImportFiles } from "../utils/importGrouping";
import {
  normalizeRootScale, meshBoundsRadius, combineBounds, awaitSubtreeTexturesReady, captureMaterialSphere,
  renderModelAssetThumbnail,
  setThumbnailDirtySuppressor, bakeModelImpostor, impostorTextureId, IMPOSTOR_SIZE } from "../utils/modelThumbnails";
import { parseBundleToRoot, type UnresolvedTexture } from "../utils/modelImport";
import { isValidGrouping, compactGroups, type PartInfo } from "../utils/submeshGroups";
import { readModelLibrary, writeModelLibrary } from "../utils/modelStore";
import { generateLodLevel, hasSkinnedPart, subtreeTriangles } from "../utils/lodGenerate";
import { registerFoliageSourceResolver, foliageRuleModels } from "../utils/foliageRules";
import { bakeOctahedralFromModels, octahedralNormalTextureId, OCTAHEDRAL_ATLAS_SIZE } from "../utils/octahedralImpostorBake";
import { findEquivalentRig, buildRigAsset, runtimeSockets, overridesFromMapping, withOverrides, type RigAsset } from "../utils/rigAssets";
import { extractRigs, moveClipsToRigs } from "../utils/rigMigration";
import { decimateGeometry } from "../workers/workerClient";
import { cancelAllImports, ImportCancelled, parseAnimationFiles } from "../workers/importClient";
import { detectMissingTextures } from "../utils/textureRefs";
import { buildGameData } from "./publish/buildGameData";
import { applyGameData, extractNodeState, ProjectPrefs } from "../utils/projectStorage";
import { migrateLegacyUI } from "../utils/uiMigration";
import {
  ProjectMeta, SceneMeta, SceneRefs, SceneAssetData, loadProjectMeta, saveProjectMeta, loadSceneData, saveSceneData,
  deleteSceneData, migrateLegacyProject, createFreshProjectMeta,
} from "../utils/sceneStorage";
import { resyncScene, reinstantiate } from "../utils/sceneResync";
import { migrateSceneSprites } from "../utils/spriteMigration";
import { captureAnimationState, restoreAnimationState } from "../utils/placedAnimation";
import { buildAssetHashes, hashAsset, AssetLibs, ASSET_HASH_VERSION } from "../utils/assetHash";
import {
  collectReferencedMaterialIds, collectReferencedModelIds, collectReferencedTemplateIds,
  collectReferencedTerrainMaterialIds, collectReferencedTextureIds, collectReferencedScriptIds,
  collectReferencedTilesetIds,
  collectReferencedAiBrainIds,
  collectReferencedAnimationFieldIds, collectReferencedSoundIds, collectReferencedAudioIds,
  collectReferencedAnimationIds, buildSceneRefs,
} from "../utils/references";
import { idbGet, idbSet } from "@cleo/app-kit/utils/idb";
import { EDITOR_CAMERA_MAP } from "@cleo/app-kit/engine/viewCameraMap";
import { KEYS, libKey, inputMapKey, projectSettingsKey } from "../utils/storageKeys";
import { ProjectSettings, DEFAULT_PROJECT_SETTINGS, parseProjectSettings, applyEngineRuntime } from "./options/projectSettings";
import { getEditorPrefs, editorPrefsStore } from "./options/editorPrefs";
import { setGizmoSnapSteps } from "@cleo/app-kit/gizmo/gizmoDrag";
import { openScriptExternally } from "./options/scriptOpener";
import { isDesktop } from "./publish/publishClient";
import { assetIdOfTab, loadTabState, saveTabState, MAIN_MODES, MainMode } from "../utils/tabState";
import { activeProjectAllowsLegacyImport, touchProject } from "../utils/projects";
import { activeProjectId } from "../utils/projectScope";
import { preloadTextures, persistTextures, adoptLegacyTextures, referencedTextureIds, legacyTexturesOf, deleteTextures } from "../utils/textureStore";
import { preloadAudio, persistAudio } from "../utils/audioStore";
import { startTask, StepStatus } from "@cleo/app-kit/feedback/progressStore";
import { invalidateNavSoup, reconcileEditorHelpers } from "../utils/editorHelpers";
import { readBackendPreference } from '@cleo/app-kit/renderer/backendPreference';
import { deepClone } from '@cleo/app-kit/utils/deepClone';
import { buildProbeIconDataURL, buildLightIconDataURL, buildSoundIconDataURL, buildDecalIconDataURL, buildParticleIconDataURL, buildForceFieldIconDataURL } from './editorIcons';
import { ImportStage, IMPORT_STAGES, AnimImportStage, ANIM_IMPORT_STAGES } from './importStages';
import { usePersistedLibrary, usePersistedModelLibrary } from './persistLibrary';
import { useAssetThumbnails } from './hooks/useAssetThumbnails';
import { useSaving } from './hooks/useSaving';
import { usePendingDecisions } from './hooks/usePendingDecisions';
import { useTilesetEditor } from './hooks/useTilesetEditor';
import { useAiBrainEditor } from './hooks/useAiBrainEditor';
import { useParticleSystemEditor } from './hooks/useParticleSystemEditor';
import { useTextureEditor } from './hooks/useTextureEditor';
import { useSoundEditor } from './hooks/useSoundEditor';
import { useAnimationFieldEditor } from './hooks/useAnimationFieldEditor';
import { useRigEditor } from './hooks/useRigEditor';
import { useClipEditor } from './hooks/useClipEditor';
import { getShellBridge } from '@cleo/app-kit/platform/desktopShell';
import { confirmDiscard, setUnsavedWork, unloadGuardSuppressed } from './unloadGuard';
import {
  EDITOR_CLEAR_COLOR, LEGACY_CLEAR_COLOR, TAB_METERS_EXPOSURE, TAB_RUNS_POST_PROCESSING, SCENE_TAB_ID,
  KIND_LABEL, TAB_EDITOR_MODE, MODE_SHOWS_SCENE_HELPERS,
} from './engineContextTypes';
import type {
  PendingModelImportView, ModelImportDecision, PendingAnimationImportView, PendingRigPickView,
  AnimationImportDecision, BodyDescription, ShapeDescription, EditorMode, GizmoMode, GizmoSpace,
  SavingState, TabKind, ModelEditSession, EditorTab, TerrainBrushState, TilemapBrushState,
} from './engineContextTypes';
import { currentOrNoop } from './loading/bootLoad';
import { beginLoad, currentLoad, subscribeLoad, yieldToPaint, type LoadHandle } from '@cleo/app-kit/feedback/loadingStore';

// The types, constant tables and standalone helpers this file used to declare inline now live in sibling
// modules. They are re-exported here verbatim so every consumer keeps importing them from EngineContext.
export {
  EDITOR_CLEAR_COLOR, MODE_RENDERS_VIEWPORT, MODE_SHOWS_SCENE_HELPERS, TAB_METERS_EXPOSURE, TAB_RUNS_POST_PROCESSING,
  SCENE_TAB_ID, KIND_LABEL,
} from './engineContextTypes';
export type {
  PendingModelImportView, ModelImportDecision, RetargetBoneOption, PendingAnimationImportView,
  PendingRigPickView, AnimationImportDecision, BodyDescription, ShapeDescription,
  EditorMode, GizmoMode, GizmoSpace, SavingState, TabKind, ModelEditSession, EditorTab,
  TerrainBrushState, TilemapTool, TilemapBrushState,
} from './engineContextTypes';

const EngineContext = createContext<{
  instance: CleoEngine | null;
  editorScene: Scene;
  /**
   * The scene the tree, Inspector and viewport picking show. `editorScene` everywhere except Simulate, where
   * it is the running play scene: edits to it are live and die on Stop.
   */
  inspectedScene: Scene;
  mainScene: Scene; // the game scene (editorScene may be a template/material preview scene)
  eventEmitter: EventEmitter;
  selectedNode: string | null;
  isGizmoDragging: boolean;
  isPlayMode: boolean;
  /** A Simulate session is running (isPlayMode is true as well). Mirrors PlaybackContext's flag. */
  isSimulating: boolean;
  isSceneReady: boolean;
  /**
   * True once `preloadTextures()` has settled, so the TextureManager's contents are authoritative. Before
   * that, a texture that looks absent may only be late: do not GC texture entries from the asset index.
   */
  texturesPreloaded: boolean;
  /**
   * True once `preloadAudio()` has settled, so the AudioManager's contents are authoritative. The audio
   * twin of `texturesPreloaded`, and it gates the sound reconciler and the asset index's sound GC for
   * exactly the same reason: before it, a sample that looks absent may only be late.
   */
  audioPreloaded: boolean;
  editorMode: EditorMode;
  setEditorMode: (mode: EditorMode) => void;
  gizmoMode: GizmoMode;
  setGizmoMode: (mode: GizmoMode) => void;
  gizmoSpace: GizmoSpace;
  setGizmoSpace: (space: GizmoSpace) => void;
  tabs: EditorTab[];
  activeTabId: string;
  activeTab: EditorTab;
  dirtyTabs: Record<string, boolean>;
  setActiveTab: (id: string) => void;
  /** Rebuild a tab from the saved assets, discarding its working copy. See the stale-dependency banner. */
  reloadTab: (tabId: string) => void;
  closeTab: (id: string) => void;
  /** Close several tabs as one document (a Character Animation workspace): one unsaved prompt for all. */
  closeTabs: (ids: string[], title: string) => Promise<void>;
  /** Save exactly these tabs. Resolves to whether they all came out clean. */
  saveTabs: (ids: string[], label: string) => Promise<boolean>;
  reorderTabs: (fromId: string, toId: string) => void;
  /** Save whatever the active tab edits (the scene, or the asset). Resolves to whether it came out clean. */
  saveActiveTab: () => Promise<boolean>;
  /** Save every tab with unsaved edits, in dependency order, reporting one progress step each. */
  saveAll: () => Promise<void>;
  /** StateMachineProvider publishes the live animation session's Apply here (see saveTabById). */
  registerAnimationApply: (reg: { tabId: string; apply: () => void } | null) => void;
  registerTilesetApply: (reg: { tabId: string; apply: () => void } | null) => void;
  registerTextureApply: (reg: { tabId: string; apply: () => void } | null) => void;
  /** SoundProvider hands its save back here, so Ctrl+S and Save All can reach a sound tab by id. */
  registerSoundApply: (reg: { tabId: string; apply: () => void } | null) => void;
  registerAiBrainApply: (reg: { tabId: string; apply: () => void } | null) => void;
  registerRigApply: (reg: { tabId: string; apply: () => void } | null) => void;
  /** ParticleEditorProvider hands its save back here, so Ctrl+S and Save All can reach a particle tab by id. */
  registerParticleSystemApply: (reg: { tabId: string; apply: () => void } | null) => void;
  /** Open (or focus) a rig's edit tab. */
  enterRigEditor: (rigId?: string, adoptTabId?: string) => void;
  /** Open an animation controller asset for editing. */
  openAnimController: (id: string) => void;
  createAnimatorForRig: (rigId: string, name?: string) => string | null;
  animateCharacter: (nodeId: string, templateId: TemplateId, assigned: Record<string, string | undefined>) =>
    { controllerId: string; actions: { slot: string; clip: string }[]; footPlacement: boolean } | null;
  /** Show a different character on the open rig tab. */
  setRigPreviewModel: (tabId: string, modelId: string) => void;
  /** Which character the open rig tab is previewing. */
  rigPreviewModelId: (tabId: string) => string | undefined;
  saveRig: (rig: RigAsset) => void;
  /** The models built on a rig — the candidates its preview can show. */
  modelsOnRig: (rigId: string) => ModelAsset[];
  editingRigId: string | null;
  registerClipApply: (reg: { tabId: string; apply: () => void } | null) => void;
  /** Open (or focus) a `.anim` asset's clip editor tab. */
  enterClipEditor: (animationId?: string, adoptTabId?: string) => void;
  /** Show a different character on the open clip tab. */
  setClipPreviewModel: (tabId: string, modelId: string) => void;
  /** Which character the open clip tab is previewing. */
  clipPreviewModelId: (tabId: string) => string | undefined;
  saveClip: (asset: AnimationAsset) => void;
  /** Save the working copy as a NEW `.anim` asset and re-point the tab at it. Returns the new id. */
  saveClipAs: (asset: AnimationAsset, name: string) => string | null;
  /** The characters a clip asset can preview on: the models built on its SOURCE rig. */
  modelsForClip: (asset: AnimationAsset) => ModelAsset[];
  editingAnimationId: string | null;
  enterTemplateEditor: (templateId?: string) => void;
  /** A new variant of a template (inherits until edited), opened in its own tab. */
  createTemplateVariant: (baseId: string) => void;
  /** In the open variant tab: drop its changes to the node at `path` (all nodes when omitted). */
  revertVariantChanges: (path?: string) => Promise<void>;
  /** Make a placed copy into a new variant of its template, and relink the copy to it. */
  createVariantFromInstance: (node: Node) => Promise<void>;
  /** Base the open variant tab's template on another template, keeping its content. */
  rebaseTemplateVariant: (newBaseId: string) => Promise<void>;
  editingTemplateName: string | null;
  /** The open template tab's base, when that template is a VARIANT: what its nodes inherit from. */
  editingTemplateVariant: { id: string; baseName: string; base: Template; diff: TemplateDiff } | null;
  templateRootId: string | null;
  enterMaterialEditor: (materialId?: string) => void;
  createMaterialForNode: (node: Node, submesh?: number) => void;
  editingMaterialName: string | null;
  setActiveMaterialName: (name: string) => void;
  enterTerrainMaterialEditor: (terrainMaterialId?: string) => void;
  editingTerrainMaterialName: string | null;
  editingTerrainMaterialNode: Node | null;
  refreshTerrainMaterialPreview: () => void;
  /** Put the active material / landscape-material preview on a sphere, a plane or (landscape only) a hill. */
  setPreviewShape: (shape: PreviewShape) => void;
  /** What the active landscape-material preview's height stands for, or null. */
  previewElevationLegend: () => string | null;
  /** Delete the runtime foliage layer a rule scattered, across every live scene. See the impl. */
  dropFoliageLayer: (rule: TerrainFoliageRule) => void;
  /** Bake a flat card for a foliage rule's model and point the rule's impostor at it. */
  bakeFoliageImpostor: (rule: TerrainFoliageRule) => Promise<string | null>;
  setActiveTerrainMaterialName: (name: string) => void;
  enterStateMachineEditor: (nodeId: string) => void;
  stateMachineTargetId: string | null; // cloned skinned model in the active animation tab's scene
  skeletonTargetId: string | null;  // the skinned node whose skeleton is on screen (animation OR rig)
  stateMachineSourceId: string | null; // original node in the main scene (state-machine write-back target)
  stateMachineSourceScene: Scene | null; // scene the source node lives in (for Variable parameter pickers)
  commitAnimationStateMachine: (sm: any) => void;
  terrainBrush: React.MutableRefObject<TerrainBrushState>;
  tilemapBrush: React.MutableRefObject<TilemapBrushState>;
  scripts: Map<string, string>;
  bodies: Map<string, BodyDescription>;
  triggers: Map<string, { shapes: ShapeDescription[]; }>;
  startPlay: () => void;
  /** Play without possession: physics, AI and scripts run, viewed through the editor camera. */
  startSimulate: () => void;
  stopPlay: () => void;
  pausePlay: () => void;
  /**
   * The project's input action map. Project-wide rather than per-scene: two scenes disagreeing about
   * what `Jump` is bound to would be inexplicable to a player. Persisted under its own storage key and
   * pushed into the running InputSystem on every edit, so Play reflects a rebind with no rebuild.
   */
  inputMap: InputMap;
  setInputMap: React.Dispatch<React.SetStateAction<InputMap>>;
  /** Engine runtime + publish-window options (Options ▸ Engine / Project). Applied live; published in `config`. */
  projectSettings: ProjectSettings;
  setProjectSettings: React.Dispatch<React.SetStateAction<ProjectSettings>>;
  templates: Template[];
  addTemplate: (t: Template) => void;
  removeTemplate: (id: string) => void;
  updateTemplate: (id: string, t: Template) => void;
  materials: MaterialAsset[];
  addMaterial: (m: MaterialAsset) => void;
  removeMaterial: (id: string) => void;
  updateMaterial: (id: string, m: MaterialAsset) => void;
  terrainMaterials: TerrainMaterialAsset[];
  addTerrainMaterial: (m: TerrainMaterialAsset) => void;
  removeTerrainMaterial: (id: string) => void;
  updateTerrainMaterial: (id: string, m: TerrainMaterialAsset) => void;
  // Script assets (shared, class-based scripts referenced by nodes via __scriptId)
  scriptAssets: ScriptAsset[];
  addScriptAsset: (s: ScriptAsset) => void;
  removeScriptAsset: (id: string) => void;
  updateScriptAsset: (id: string, s: ScriptAsset) => void;
  /** The script asset a node currently references, if any. */
  scriptAssetOf: (node: Node | null) => ScriptAsset | undefined;
  /** Create a new script asset for a node (base type from the node) and attach it. Returns the new asset, or null. */
  createScriptForNode: (node: Node, name?: string) => ScriptAsset | null;
  /** Attach an existing script asset to a node (base-type checked). Returns false if incompatible. */
  attachScriptToNode: (node: Node, scriptId: string) => boolean;
  /** Detach a node's script asset and drop its script-owned fields. */
  detachScriptFromNode: (node: Node) => void;
  /** Persist an edited script asset's source and propagate the change to every linked node. */
  saveScriptSource: (id: string, source: string) => void;
  /** Called by the VFS provider whenever the asset index changes: asset id -> VFS path, for script modules. */
  syncScriptPaths: (paths: ReadonlyMap<string, string>) => void;
  /** The VFS path of every script asset (see syncScriptPaths). Read-only. */
  scriptPaths: ReadonlyMap<string, string>;
  /** Mint a new script MODULE (shared code other scripts import) and open it. */
  createScriptModule: () => void;
  /**
   * Drop a placed template instance's override and rebuild the instance from its template, so the value
   * goes back to the template's. `field` names one script field ('name' for the root's name); omitted,
   * every override of `node` goes; `node` being the instance root with `all` drops the instance's every one.
   */
  revertTemplateOverride: (node: Node, field?: string, all?: boolean) => void;
  /**
   * Take a source edited outside the editor (the script workspace folder) as the new truth for a script:
   * saves it, refreshes any open Script tab's buffer and clears that tab's dirty flag. Returns whether the
   * tab was holding UNSAVED edits that this replaced.
   */
  adoptExternalScriptSource: (id: string, source: string) => { replacedUnsaved: boolean };
  /** Rename a script asset, keeping its source and base type (used when a workspace file is renamed). */
  renameScriptAsset: (id: string, name: string) => void;
  // Animation Field assets (blend spaces)
  animationFields: AnimationFieldAsset[];
  addAnimationField: (f: AnimationFieldAsset) => void;
  removeAnimationField: (id: string) => void;
  updateAnimationField: (id: string, f: AnimationFieldAsset) => void;
  animations: AnimationAsset[];
  addAnimation: (a: AnimationAsset) => void;
  removeAnimation: (id: string) => void;
  updateAnimation: (id: string, a: AnimationAsset) => void;
  /** Rig assets: shared skeletons. See utils/rigAssets.ts. */
  rigs: RigAsset[];
  addRig: (r: RigAsset) => void;
  removeRig: (id: string) => void;
  updateRig: (id: string, r: RigAsset) => void;
  /** Open (or focus) an Animation Field asset's edit tab. */
  enterAnimationFieldEditor: (fieldId?: string) => void;
  /** Create a field for a skinned model asset and open it. Returns the new field's id, or null. */
  createAnimationFieldForModel: (modelId: string) => string | null;
  /** The field asset the active animation-field tab edits, or null. */
  editingAnimationFieldId: string | null;
  /** The skinned ModelNode previewing that field in the tab's scene, or null. */
  animationFieldTargetId: string | null;
  /** Save a field asset and re-embed it into every state machine that plays it. */
  saveAnimationField: (asset: AnimationFieldAsset) => void;
  // Raw image assets: the bytes a texture reads. Renameable; referenced only by TextureAsset.source.
  images: ImageAsset[];
  addImage: (i: ImageAsset) => void;
  removeImage: (id: string) => void;
  updateImage: (id: string, i: ImageAsset) => void;
  /**
   * Texture assets: a byte source plus every sampling decision. `id` IS the TextureManager id, so a
   * texture is renamed through `name` and never by its id, which is baked into every serialized material.
   */
  textures: TextureAsset[];
  addTextureAsset: (t: TextureAsset) => void;
  removeTextureAsset: (id: string) => void;
  /** Writes the record AND retunes the live GPU texture, so the viewport follows the inspector. */
  updateTextureAsset: (id: string, t: TextureAsset) => void;
  /** Audio source assets: metadata over bytes in the `audio` store. The audio twin of `images`. */
  audioSources: AudioSourceAsset[];
  addAudioSource: (a: AudioSourceAsset) => void;
  removeAudioSource: (id: string) => void;
  updateAudioSource: (id: string, a: AudioSourceAsset) => void;
  /**
   * Sound sample assets: a byte source plus every playback decision. `id` IS the AudioManager id, so a
   * sample is renamed through `name` and never by its id, which every serialized SoundNode references.
   */
  soundSamples: SoundSampleAsset[];
  addSoundSample: (s: SoundSampleAsset) => void;
  removeSoundSample: (id: string) => void;
  /** Writes the record AND retunes the live Sound, so a playing preview follows the inspector. */
  updateSoundSample: (id: string, s: SoundSampleAsset) => void;
  /** The sample asset the active sound tab edits, or null. */
  editingSoundId: string | null;
  /** The AI brain the active tab edits, or null when the active tab is not one. */
  editingAiBrainId: string | null;
  /** Open (or focus) a Sound Sample asset's edit tab. */
  enterSoundEditor: (sampleId?: string) => void;
  /** Write an edited sample back to the library and retune the live Sound. */
  saveSoundSample: (asset: SoundSampleAsset) => void;
  /** Retune the LIVE sound without touching the library — used while a control is being dragged. */
  previewSoundSettings: (asset: SoundSampleAsset) => void;
  // Tileset assets (sliced atlases painted by tilemap layers)
  tilesets: TilesetAsset[];
  addTileset: (t: TilesetAsset) => void;
  removeTileset: (id: string) => void;
  updateTileset: (id: string, t: TilesetAsset) => void;
  // AI Brain assets (a behaviour machine or a goal graph, plus the fuzzy model it reads)
  aiBrains: AiBrainAsset[];
  addAiBrain: (b: AiBrainAsset) => void;
  removeAiBrain: (id: string) => void;
  updateAiBrain: (id: string, b: AiBrainAsset) => void;
  // Particle system assets (`.vfx`: emitters and their module stacks, embedded into ParticleSystemNodes)
  particleSystems: ParticleSystemAsset[];
  addParticleSystem: (p: ParticleSystemAsset) => void;
  /** Drops the library entry, unlinks every node in every live scene (they keep their copy) and closes its tab. */
  removeParticleSystem: (id: string) => void;
  updateParticleSystem: (id: string, p: ParticleSystemAsset) => void;
  /** The particle system the active tab edits, or null when the active tab is not one. */
  editingParticleSystemId: string | null;
  /** Open (or focus) a particle system's tab, minting a new asset when called with no id. */
  enterParticleSystemEditor: (id?: string | null, adoptTabId?: string) => void;
  /** Persist an edited particle system and push it into every node in every live scene that links it. */
  saveParticleSystem: (asset: ParticleSystemAsset) => void;
  /** Copy a library effect onto a node and record the link, or pass null to unlink keeping the copy. */
  linkParticleSystemToNode: (node: ParticleSystemNode, id: string | null) => void;
  /** Copy a node's embedded effect into a new library asset and link it. */
  extractParticleSystemFromNode: (node: ParticleSystemNode, name?: string) => ParticleSystemAsset;
  // Animation controller assets (a shared state machine: parameters, layers, slots)
  animControllers: AnimControllerAsset[];
  addAnimController: (c: AnimControllerAsset) => void;
  removeAnimController: (id: string) => void;
  updateAnimController: (id: string, c: AnimControllerAsset) => void;
  // Bone mask assets (per-bone layer weights, authored against a rig)
  boneMasks: BoneMaskAsset[];
  addBoneMask: (m: BoneMaskAsset) => void;
  removeBoneMask: (id: string) => void;
  updateBoneMask: (id: string, m: BoneMaskAsset) => void;
  // Pose assets (named stored poses, authored against a rig)
  poseAssets: PoseAsset[];
  addPoseAsset: (p: PoseAsset) => void;
  removePoseAsset: (id: string) => void;
  updatePoseAsset: (id: string, p: PoseAsset) => void;
/** Open (or focus) a Tileset asset's edit tab. Creates a fresh, atlas-less one when given no id. */
  enterTilesetEditor: (tilesetId?: string) => void;
  /** Open an AI brain's tab, minting one of `kind` when called with no id. */
  enterAiBrainEditor: (brainId?: string, kind?: AiBrainKind, adoptTabId?: string) => void;
  /** Copy a controller's inline brain into a new library asset and link it. */
  extractBrainFromController: (controller: ControllerNode, name?: string) => AiBrainAsset;
  /** Copy a library brain onto a controller, or pass null to unlink without changing behaviour. */
  linkBrainToController: (controller: ControllerNode, brainId: string | null) => void;
  saveAiBrain: (asset: AiBrainAsset) => void;
  /** Import an image file as an atlas, build a tileset sliced around it, and open it. */
  createTilesetFromImage: (file: File) => Promise<TilesetAsset | null>;
  /** The tileset asset the active tileset tab edits, or null. */
  editingTilesetId: string | null;
  /** The texture asset the active texture tab edits, or null. */
  editingTextureId: string | null;
  /** Open (or focus) a Texture asset's edit tab. */
  enterTextureEditor: (textureId?: string) => void;
  /** Write an edited texture back to the library and retune the live GPU texture. */
  saveTexture: (asset: TextureAsset) => void;
  /** Retune the LIVE texture without touching the library — used while a control is being dragged. */
  previewTextureSettings: (asset: TextureAsset) => void;
  /** Save a tileset asset and push it into every tilemap that embedded a copy. */
  saveTileset: (asset: TilesetAsset) => void;
  /** Open a script asset in its dedicated Script editor tab (creates a new 'node' script when no id is given). */
  enterScriptEditor: (scriptId?: string) => void;
  /** Save the active Script tab's buffered source to its asset and clear the tab's dirty flag. */
  /** Buffer a Script tab's working source and mark the tab dirty (called by the tab editor on each edit). */
  setScriptTabSource: (tabId: string, scriptId: string, source: string) => void;
  /** The buffered working source for a script tab, or undefined. */
  getScriptTabSource: (scriptId: string) => string | undefined;
  models: ModelAsset[];
  addModel: (m: ModelAsset) => void;
  removeModel: (id: string) => void;
  updateModel: (id: string, m: ModelAsset) => void;
  /** Open (or focus) a model asset's edit tab, rendering its thumbnail on the way in. */
  enterModelEditor: (modelId?: string) => void;
  /** The model asset a node belongs to, adding one to the library from its subtree if it has none. */
  adoptModelAsset: (node: Node | null | undefined) => Promise<string | null>;
  /** The model asset a node belongs to — its back-link, or the asset the current tab is editing. */
  resolveModelAssetId: (node: Node | null | undefined) => string | undefined;
  /** Link an existing `.anim` asset to a model asset; its clips appear on every placement immediately. */
  /** The rig a model uses, minting one from its skeleton if it has none. */
  ensureRigForModel: (modelId: string) => string | null;
  /** Link a shared `.anim` to a RIG — every model on that rig plays it. */
  linkAnimationToRig: (rigId: string, animationId: string) => void;
  unlinkAnimationFromRig: (rigId: string, animationId: string) => void;
  /** Point a model at a different rig, re-resolving every clip it plays. `undefined` unlinks. */
  setModelRig: (modelId: string, rigId: string | undefined) => void;
  /** Give the rig's controller to a just-placed character that has no state machine. See adoptRigController. */
  adoptRigController: (modelId: string, onlyRoot?: Node | null) => number;
  /** Rename a clip inside a shared `.anim` asset, or toggle its root motion. */
  editSharedClip: (animationId: string, clipName: string, patch: { name?: string; rootMotion?: boolean }) => void;
  modelSession: ModelEditSession | null;
  /** Node id of the active LOD level's root in the model tab scene (viewport drop parent), or null. */
  modelEditTargetId: string | null;
  setActiveModelName: (name: string) => void;
  /**
   * Save one part of the open model (a mesh node, or one material sub-mesh of a merged one) as a new model
   * asset. `'extract'` also removes it from the open model; Save then writes the source as usual. Returns
   * the new asset's id, or null.
   */
  saveModelPart: (part: ModelPart, mode: 'copy' | 'extract') => Promise<string | null>;
  /** Add an existing mesh asset as the next LOD level (levels are references, not copies). */
  addModelLodFromAsset: (modelId: string) => void;
  /** Decimate the open model into LOD levels; see generateModelLods. */
  generateModelLods: (specs: { ratio: number; distance: number }[], downscaleTextures: boolean) => Promise<void>;
  removeModelLod: (level: number) => void;
  setModelLodDistance: (level: number, distance: number) => void;
  setModelCullDistance: (distance: number) => void;
  setActiveModelLevel: (level: number) => void;
  importModelFiles: (files: File[]) => Promise<void>;
  // True once every IndexedDB-backed asset library has finished its initial read.
  assetsLoaded: boolean;
  pendingModelImport: PendingModelImportView | null;
  resolveModelImport: (decision: ModelImportDecision | null) => void;
  // Animation import, into the Animation Editor's model.
  importAnimationFiles: (files: File[], opts?: { modelId?: string }) => Promise<void>;
  importSkeletonNames: (files: File[]) => Promise<void>;
  /** Persist the IK rig for the model open in the Animation Editor, to the asset and every instance. */
  commitIkRig: (rig: any | null) => void;
  /** The IK rig currently on the Animation Editor's model, or null. */
  currentIkRig: () => any | null;
  renameAnimationClip: (oldName: string, newName: string) => string;
  removeAnimationClip: (name: string) => void;
  pendingAnimationImport: PendingAnimationImportView | null;
  pendingRigPick: PendingRigPickView | null;
  resolveRigPick: (modelId: string | null) => void;
  resolveAnimationImport: (decision: AnimationImportDecision | null) => void;
  savingState: SavingState;
  replaceProjectMeta: (meta: ProjectMeta) => Promise<void>;
  sceneList: SceneMeta[];
  mainSceneId: string;
  openSceneId: string;
  /** The open scene asset has unsaved edits — dirtyTabs[SCENE_TAB_ID] under a name that reads at call sites. */
  mainDirty: boolean;
  /** Open a scene asset in the Main tab (prompts Save/Discard/Cancel when the current scene is dirty). */
  openScene: (sceneId: string) => Promise<boolean>;
  createScene: (name?: string) => Promise<string>;
  renameScene: (sceneId: string, name: string) => void;
  /** Returns null on success, or a human-readable reason the scene cannot be deleted. */
  deleteScene: (sceneId: string) => Promise<string | null>;
  duplicateScene: (sceneId: string) => Promise<string | null>;
  setMainScene: (sceneId: string) => void;
  /**
   * What the open scene IS: 2D is authored with tilemaps, 3D with landscapes. Persisted on SceneMeta and
   * edited only from the scene settings panel; decides which of the two a published build keeps.
   * NOT the camera — see viewDimension for the rig you are looking through.
   */
  sceneDimension: '2D' | '3D';
  setSceneDimension: (sceneId: string, dimension: '2D' | '3D') => Promise<void>;
  /** Set while a dimension switch is waiting on the user to confirm losing the other dimension's work. */
  pendingDimensionConfirm: { to: '2D' | '3D'; losing: 'tilemap' | 'landscape'; count: number } | null;
  resolveDimensionConfirm: (proceed: boolean) => void;
  /**
   * Which camera rig the viewport is looking through — orthographic pan/zoom or free-fly. Editor-session
   * state, NOT the scene's authored dimension: follows the scene on open and on an authored change, and
   * is never persisted.
   */
  viewDimension: '2D' | '3D';
  setViewDimension: (dimension: '2D' | '3D') => void;
  // Unsaved-changes confirm dialog (promise parked by openScene/closeTab, resolved by UnsavedSceneModal)
  pendingSceneConfirm: { sceneName: string; action: 'switch' | 'close' } | null;
  resolveSceneConfirm: (decision: 'save' | 'discard' | 'cancel') => void;
  /** Mark a tab as having unsaved edits, for edits the SCENE_CHANGED listener cannot see (e.g. animation
   *  state-machine edits). `reason` labels the cause in the Dirty debug channel (see utils/dirtyDebug). */
  markTabDirty: (tabId: string, reason?: string) => void;
  clearTabDirty: (tabId: string) => void;
  /** Run `fn` without its scene edits marking any tab dirty — for editor chrome (gizmos, helper icons)
   *  whose nodes live in the scene and emit SCENE_CHANGED like any other, but are not the user's work. */
  withoutDirty: <T>(fn: () => T) => T;
  /** True while inside withoutDirty. The undo recorder reads it: nothing suppressed here is a user edit. */
  isDirtySuppressed: () => boolean;
  }>({
    instance: null,
    editorScene: new Scene(),
    inspectedScene: new Scene(),
    mainScene: new Scene(),
    eventEmitter: new EventEmitter(),
    selectedNode: null,
    isGizmoDragging: false,
    isPlayMode: false,
    isSimulating: false,
    isSceneReady: false,
    texturesPreloaded: false,
    audioPreloaded: false,
    editorMode: 'scene',
    setEditorMode: () => {},
    gizmoMode: 'position',
    setGizmoMode: () => {},
    gizmoSpace: 'world',
    setGizmoSpace: () => {},
    tabs: [{ id: SCENE_TAB_ID, kind: 'scene', title: 'Scene' }],
    activeTabId: SCENE_TAB_ID,
    activeTab: { id: SCENE_TAB_ID, kind: 'scene', title: 'Scene' },
    dirtyTabs: {},
    setActiveTab: () => {},
    reloadTab: () => {},
    closeTab: () => {},
    closeTabs: async () => {},
    saveTabs: async () => false,
    reorderTabs: () => {},
    saveActiveTab: async () => false,
    saveAll: async () => {},
    registerAnimationApply: () => {},
    registerTilesetApply: () => {},
    registerTextureApply: () => {},
    registerSoundApply: () => {},
    registerAiBrainApply: () => {},
    registerRigApply: () => {},
    registerParticleSystemApply: () => {},
    enterRigEditor: () => {},
    openAnimController: () => {},
    createAnimatorForRig: () => null,
    animateCharacter: () => null,
    setRigPreviewModel: () => {},
    rigPreviewModelId: () => undefined,
    saveRig: () => {},
    modelsOnRig: () => [],
    editingRigId: null,
    registerClipApply: () => {},
    enterClipEditor: () => {},
    setClipPreviewModel: () => {},
    clipPreviewModelId: () => undefined,
    saveClip: () => {},
    saveClipAs: () => null,
    modelsForClip: () => [],
    editingAnimationId: null,
    enterTemplateEditor: () => {},
    createTemplateVariant: () => {},
    revertVariantChanges: async () => {},
    createVariantFromInstance: async () => {},
    rebaseTemplateVariant: async () => {},
    editingTemplateName: null,
    editingTemplateVariant: null,
    templateRootId: null,
    enterMaterialEditor: () => {},
    createMaterialForNode: () => {},
    editingMaterialName: null,
    setActiveMaterialName: () => {},
    enterTerrainMaterialEditor: () => {},
    editingTerrainMaterialName: null,
    editingTerrainMaterialNode: null,
    refreshTerrainMaterialPreview: () => {},
    setPreviewShape: () => {},
    previewElevationLegend: () => null,
    dropFoliageLayer: () => {},
    bakeFoliageImpostor: async () => null,
    setActiveTerrainMaterialName: () => {},
    enterStateMachineEditor: () => {},
    stateMachineTargetId: null,
    skeletonTargetId: null,
    stateMachineSourceId: null,
    stateMachineSourceScene: null,
    commitAnimationStateMachine: () => {},
    terrainBrush: { current: { activeLandscapeId: null } },
    tilemapBrush: { current: { tool: 'brush', activeTilemapId: null, activeLayer: 0, stamp: { w: 1, h: 1, tiles: [0] }, orient: { flipX: false, flipY: false, rot90: false }, variantSetId: null, terrainId: null } },
    scripts: new Map(),
    bodies: new Map(),
    triggers: new Map(),
    startPlay: () => {},
    startSimulate: () => {},
    stopPlay: () => {},
    pausePlay: () => {},
    templates: [],
    inputMap: DEFAULT_INPUT_MAP,
    setInputMap: () => {},
    projectSettings: DEFAULT_PROJECT_SETTINGS,
    setProjectSettings: () => {},
    addTemplate: () => {},
    removeTemplate: () => {},
    updateTemplate: () => {},
    materials: [],
    addMaterial: () => {},
    removeMaterial: () => {},
    updateMaterial: () => {},
    terrainMaterials: [],
    addTerrainMaterial: () => {},
    removeTerrainMaterial: () => {},
    updateTerrainMaterial: () => {},
    scriptAssets: [],
    addScriptAsset: () => {},
    removeScriptAsset: () => {},
    updateScriptAsset: () => {},
    scriptAssetOf: () => undefined,
    createScriptForNode: () => null,
    attachScriptToNode: () => false,
    detachScriptFromNode: () => {},
    saveScriptSource: () => {},
    syncScriptPaths: () => {},
    scriptPaths: new Map(),
    createScriptModule: () => {},
    revertTemplateOverride: () => {},
    adoptExternalScriptSource: () => ({ replacedUnsaved: false }),
    renameScriptAsset: () => {},
    animationFields: [],
    addAnimationField: () => {},
    removeAnimationField: () => {},
    updateAnimationField: () => {},
    animations: [],
    addAnimation: () => {},
    removeAnimation: () => {},
    updateAnimation: () => {},
    rigs: [],
    addRig: () => {},
    removeRig: () => {},
    updateRig: () => {},
    enterAnimationFieldEditor: () => {},
    createAnimationFieldForModel: () => null,
    editingAnimationFieldId: null,
    animationFieldTargetId: null,
    saveAnimationField: () => {},
    images: [],
    addImage: () => {},
    removeImage: () => {},
    updateImage: () => {},
    textures: [],
    addTextureAsset: () => {},
    removeTextureAsset: () => {},
    audioSources: [],
    addAudioSource: () => {},
    removeAudioSource: () => {},
    updateAudioSource: () => {},
    soundSamples: [],
    addSoundSample: () => {},
    removeSoundSample: () => {},
    updateSoundSample: () => {},
    editingSoundId: null,
    editingAiBrainId: null,
    enterSoundEditor: () => {},
    saveSoundSample: () => {},
    previewSoundSettings: () => {},
    updateTextureAsset: () => {},
    tilesets: [],
    addTileset: () => {},
    removeTileset: () => {},
    aiBrains: [],
    addAiBrain: () => {},
    removeAiBrain: () => {},
    updateAiBrain: () => {},
    particleSystems: [],
    addParticleSystem: () => {},
    removeParticleSystem: () => {},
    updateParticleSystem: () => {},
    editingParticleSystemId: null,
    enterParticleSystemEditor: () => {},
    saveParticleSystem: () => {},
    linkParticleSystemToNode: () => {},
    extractParticleSystemFromNode: () => buildParticleSystemAsset(),
    animControllers: [],
    addAnimController: () => {},
    removeAnimController: () => {},
    updateAnimController: () => {},
    boneMasks: [],
    addBoneMask: () => {},
    removeBoneMask: () => {},
    updateBoneMask: () => {},
    poseAssets: [],
    addPoseAsset: () => {},
    removePoseAsset: () => {},
    updatePoseAsset: () => {},
    updateTileset: () => {},
    enterTilesetEditor: () => {},
    enterAiBrainEditor: () => {},
    extractBrainFromController: () => buildAiBrainAsset('', 'behavior'),
    linkBrainToController: () => {},
    saveAiBrain: () => {},
    createTilesetFromImage: async () => null,
    editingTilesetId: null,
    editingTextureId: null,
    enterTextureEditor: () => {},
    saveTexture: () => {},
    previewTextureSettings: () => {},
    saveTileset: () => {},
    enterScriptEditor: () => {},
    setScriptTabSource: () => {},
    getScriptTabSource: () => undefined,
    models: [],
    addModel: () => {},
    removeModel: () => {},
    updateModel: () => {},
    enterModelEditor: () => {},
    adoptModelAsset: async () => null,
    resolveModelAssetId: () => undefined,
    ensureRigForModel: () => null,
    linkAnimationToRig: () => {},
    unlinkAnimationFromRig: () => {},
    setModelRig: () => {},
    adoptRigController: () => 0,
    editSharedClip: () => {},
    modelSession: null,
    modelEditTargetId: null,
    setActiveModelName: () => {},
    saveModelPart: async () => null,
    addModelLodFromAsset: () => {},
    generateModelLods: async () => {},
    removeModelLod: () => {},
    setModelLodDistance: () => {},
    setModelCullDistance: () => {},
    setActiveModelLevel: () => {},
    importModelFiles: async () => {},
    assetsLoaded: false,
    pendingModelImport: null,
    resolveModelImport: () => {},
    importAnimationFiles: async () => {},
    importSkeletonNames: async () => {},
    commitIkRig: () => {},
    currentIkRig: () => null,
    renameAnimationClip: (o) => o,
    removeAnimationClip: () => {},
    pendingAnimationImport: null,
    pendingRigPick: null,
    resolveRigPick: () => {},
    resolveAnimationImport: () => {},
    savingState: 'idle',
    replaceProjectMeta: async () => {},
    sceneList: [],
    mainSceneId: '',
    openSceneId: '',
    mainDirty: false,
    openScene: async () => false,
    createScene: async () => '',
    renameScene: () => {},
    deleteScene: async () => null,
    duplicateScene: async () => null,
    setMainScene: () => {},
    sceneDimension: '3D',
    setSceneDimension: async () => {},
    viewDimension: '3D',
    setViewDimension: () => {},
    pendingDimensionConfirm: null,
    resolveDimensionConfirm: () => {},
    pendingSceneConfirm: null,
    resolveSceneConfirm: () => {},
    markTabDirty: () => {},
    clearTabDirty: () => {},
    withoutDirty: (fn) => fn(),
    isDirtySuppressed: () => false,
  });
  
export const useCleoEngine = () => {
    return useContext(EngineContext);
};

/**
 * The live editing scene. `spawnRulesEnabled` must be off from construction, never assigned later:
 * Scene.parse applies spawnOnStart and setupInitialScene() parses into this object during boot.
 */
function createEditorScene(): Scene {
  const scene = new Scene();
  scene.spawnRulesEnabled = false;
  return scene;
}

/** The editor's camera preferences, as the shared view camera reads them. Read per frame, so a change applies at once. */
function viewCameraPrefs(): ViewCameraPrefs {
  const prefs = getEditorPrefs();
  return { flySpeed: prefs.cameraFlySpeed, lookSensitivity: prefs.cameraLookSensitivity };
}

export function EngineProvider(props: { children: React.ReactNode }) {
  const instanceRef = useRef<CleoEngine | null>(null);
  /**
   * The startup load app.tsx began (features/loading). Every boot step reports into it — the library
   * reads below, the engine, the scene, the resync — and it closes the splash once they have all
   * settled. Captured once: a later load (opening a scene) must not receive the boot's reports.
   */
  const bootLoadRef = useRef<LoadHandle>(currentOrNoop());
  const editorSceneRef = useRef<Scene>(createEditorScene());
  const eventEmitter = useRef(new EventEmitter());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  // Read by the helper reconciler, which runs off an rAF rather than a render and so cannot close
  // over the state. Only the navmesh bake-volume overlays care.
  const selectedNodeRef = useRef<string | null>(null);
  selectedNodeRef.current = selectedNode;
  const [isGizmoDragging, setIsGizmoDragging] = useState(false);
  const [isPlayMode, setIsPlayMode] = useState(false);
  // Simulate is a play session nobody possesses: the same throwaway play scene, seen through the editor's
  // free-fly camera with the Gameplay map off. `isPlayMode` stays true for it, so every edit lock holds.
  // The ref is written synchronously when a session starts; the SET_PLAY_STATE handler reads it.
  const [isSimulating, setIsSimulating] = useState(false);
  const isSimulatingRef = useRef(false);
  // The play scene a Simulate session is running, published so the tree and Inspector can show the live
  // simulation. Null outside Simulate — Play hides those panels, and the authoring scene is never it.
  const [simulatedScene, setSimulatedScene] = useState<Scene | null>(null);
  const [isSceneReady, setIsSceneReady] = useState(false);
  const [texturesPreloaded, setTexturesPreloaded] = useState(false);
  const [audioPreloaded, setAudioPreloaded] = useState(false);
  /**
   * The open-documents session from the last visit. Must be read ONCE and synchronously before the first
   * render: `editorMode` is derived during render, and DockLayout's controller reads it on its first effect.
   */
  const [restoredSession] = useState(() => loadTabState(SCENE_TAB_ID));
  // The Main tab's sub-mode (scene/landscape/renderer). `editorMode` exposed to consumers is derived
  // from the active tab — 'template' when a template tab is active, else this.
  const [mainMode, setMainMode] = useState<MainMode>(restoredSession.mainMode);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('position');
  // Defaults to world, which is what the move gizmo already did before the toggle existed. Not persisted,
  // for the same reason gizmoMode is not: a half-restored toolbar is worse than one that always starts fresh.
  const [gizmoSpace, setGizmoSpace] = useState<GizmoSpace>('world');
  /** Where Play was pressed from, so Stop can put the user back. Null while play started on the scene tab. */
  const playReturnRef = useRef<{ tabId: string; mainMode: MainMode } | null>(null);
  /** Play is waiting for the forced switch to the scene tab to commit (see startPlay). */
  const pendingPlayRef = useRef(false);
  /** Which session the pending switch starts: Play, or Simulate. */
  const pendingSimulateRef = useRef(false);
  // Mirrored during RENDER, like tabsRef: startPlay reads it from an async/event path where the render-scoped
  // value would be a commit behind.
  const mainModeRef = useRef(mainMode);
  mainModeRef.current = mainMode;
  // Editor tabs: the Main tab (real game scene) plus any open library tabs. Each tab's live scene + root
  // live in tabRuntimeRef, not React state. Restored tabs arrive as METADATA only — their runtime sessions
  // are built lazily (see hydrateTab), and the boot effect prunes any whose asset has since been deleted.
  const [tabs, setTabs] = useState<EditorTab[]>(restoredSession.tabs);
  const [activeTabId, setActiveTabId] = useState<string>(restoredSession.activeTabId);
  /** Restored tab ids with no runtime yet. Emptied as each is hydrated on first activation. */
  const pendingHydrationRef = useRef(new Set<string>(
    restoredSession.tabs.filter(t => t.kind !== 'scene').map(t => t.id),
  ));
  /** Boot restore has finished (pruned + active tab hydrated) — until then the session must not be re-saved. */
  const tabsRestoreDoneRef = useRef(false);
  const bootTabsDoneRef = useRef(false);

  /**
   * Put a freshly built tab into the strip — the tail every `enter*Editor` ends with. With `adoptTabId` the
   * tab replaces a restored placeholder in place (same id, same position) and activation is left to the
   * caller: hydration runs before the active tab is committed.
   */
  const commitTab = (tab: EditorTab, adoptTabId?: string) => {
    if (adoptTabId) {
      setTabs(prev => prev.map(t => (t.id === adoptTabId ? { ...tab, id: adoptTabId } : t)));
      return;
    }
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tab.id);
  };
  // The one unsaved-changes store, keyed by tab id — 'main' is the open scene asset, the rest are library
  // tabs. The ref is written in the same tick as the state so async flows (openScene, saveAll) never read a
  // stale value; go through markTabDirty/clearTabDirty rather than setDirtyTabs so the two stay in step.
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({});
  const dirtyTabsRef = useRef<Record<string, boolean>>({});
  /** Name a tab for the Dirty debug channel. Reads tabsRef rather than the `tabs` closure so async flows
   *  never log a stale title. */
  const labelForTab = (id: string) => {
    const tab = tabsRef.current.find(t => t.id === id);
    return tab ? `${id} (${tab.kind} "${tab.title}")` : id;
  };
  const markTabDirty = (id: string, reason = 'direct') => {
    if (dirtyTabsRef.current[id]) return; // only the clean -> dirty transition, so the log stays one line
    dirtyTabsRef.current = { ...dirtyTabsRef.current, [id]: true };
    setDirtyTabs(dirtyTabsRef.current);
    logDirtyMark(labelForTab(id), reason);
  };
  const clearTabDirty = (id: string) => {
    if (!dirtyTabsRef.current[id]) return;
    const next = { ...dirtyTabsRef.current };
    delete next[id];
    dirtyTabsRef.current = next;
    setDirtyTabs(next);
    logDirtyClear(labelForTab(id));
  };
  // Per-tab runtime scene + root. Animation tabs also record where the SOURCE node lives (its scene may
  // be the main scene OR a template tab's scene) so authored state machines are written back correctly.
  const tabRuntimeRef = useRef<Map<string, { scene: Scene; rootId: string; sourceScene?: Scene; sourceNodeId?: string; sourceTabId?: string; tm?: TerrainMaterial; helperTerrain?: Terrain; baseAtOpen?: Template; editNode?: ModelNode; previewSphere?: ModelNode; previewModelId?: string; skinnedId?: string }>>(new Map());
  const activeTabIdRef = useRef<string>(SCENE_TAB_ID);
  const activeTabKindRef = useRef<TabKind>('scene');
  const dirtyArmedRef = useRef(false); // suppress false-dirty from the helper reconciler right after open
  // Propagation (the sync*Instances family) edits live scenes and so emits SCENE_CHANGED, which mark()
  // would blame on the ACTIVE tab. Hold this while propagating.
  const dirtySuppressRef = useRef(false);
  /** Run `fn` (synchronous — the sync*Instances family all are) without its edits marking any tab dirty. */
  const withoutDirty = <T,>(fn: () => T): T => {
    const prev = dirtySuppressRef.current;
    dirtySuppressRef.current = true;
    try { return fn(); } finally { dirtySuppressRef.current = prev; }
  };
  const isDirtySuppressed = () => dirtySuppressRef.current;
  // Thumbnail rendering builds throwaway scenes whose node inserts emit SCENE_CHANGED; nothing that module
  // does is ever a user edit.
  setThumbnailDirtySuppressor(withoutDirty);
  const [savingState, setSavingState] = useState<SavingState>('idle');
  // The rig the viewport is currently looking through. A ref as well as state because applyActiveTab
  // reads it off-render. The scene's AUTHORED dimension is a different thing — see setSceneDimension.
  const [viewDimension, setViewDimensionState] = useState<'2D' | '3D'>('3D');
  const viewDimensionRef = useRef<'2D' | '3D'>('3D');
  // Which rig is currently INSTALLED on the camera. Distinct from viewDimensionRef, which tracks the
  // scene tab's remembered view and is deliberately left alone while an asset tab renders in 3D.
  const previousViewRef = useRef<'2D' | '3D'>('3D');
  /**
   * Where the editor camera was the last time each rig was on screen, so flipping the view is reversible:
   * CHANGE_DIMENSION parks the camera at a fixed 2D pose and restores nothing on the 3D side.
   */
  const viewPoseRef = useRef<Partial<Record<'2D' | '3D', {
    position: [number, number, number];
    rotation: [number, number, number];
    ortho?: { top: number; bottom: number; left: number; right: number };
  }>>>({});
  const pendingPrefsRef = useRef<ProjectPrefs | null>(null);

  // Multi-scene project state. projectMetaRef is the authoritative copy (scene list + main/open ids);
  // the useState mirrors exist so the Assets explorer and MenuBar re-render when it changes. The Main
  // tab always shows the scene identified by openSceneId — its blob lives at 'cleo_scene:<id>'.
  const projectMetaRef = useRef<ProjectMeta | null>(null);
  const [sceneList, setSceneList] = useState<SceneMeta[]>([]);
  const [mainSceneId, setMainSceneIdState] = useState<string>('');
  const [openSceneId, setOpenSceneIdState] = useState<string>('');
  const openSceneIdRef = useRef<string>('');
  const scenesLoadedRef = useRef(false);
  const isPlayModeRef = useRef(false);
  useEffect(() => {
    isPlayModeRef.current = isPlayMode;
    // Property-level change events fire only while editing a ready scene: never during Play (transient
    // edits must not mark the scene unsaved) and never before load. Structural changes always emit.
    CleoEngine.authoringMode = isSceneReady && !isPlayMode;
  }, [isPlayMode, isSceneReady]);
  const terrainBrush = useRef<TerrainBrushState>({ activeLandscapeId: null });
  const tilemapBrush = useRef<TilemapBrushState>({
    tool: 'brush', activeTilemapId: null, activeLayer: 0,
    stamp: { w: 1, h: 1, tiles: [0] },
    orient: { flipX: false, flipY: false, rot90: false },
    variantSetId: null, terrainId: null,
  });
  const isGizmoDraggingRef = useRef(false);
  /** Cancels the Play-mode Escape subscription. Null while not playing. */
  const escapeSubRef = useRef<(() => void) | null>(null);
  const scriptsRef = useRef(new Map<string, string>());
  const bodiesRef = useRef(new Map<string, BodyDescription>());
  const triggersRef = useRef(new Map<string, { shapes: ShapeDescription[] }>());
  const startedRef = useRef(false);

  // Debug-overlay visibility (collider wireframes, light icons, …), per Editor/Runtime channel. The
  // reconcilers read the ref, not render state; toggling emits DEBUG_VISIBILITY_CHANGED so they re-run.
  const [debugVisibility, setDebugVisibility] = useState<DebugVisibility>(() => loadDebugVisibility());
  const debugVisibilityRef = useRef(debugVisibility);
  useEffect(() => { debugVisibilityRef.current = debugVisibility; }, [debugVisibility]);
  const setDebugCategory = (key: DebugCategory, channel: DebugChannel, value: boolean) => {
    setDebugVisibility(prev => {
      const next = { ...prev, [key]: { ...prev[key], [channel]: value } };
      debugVisibilityRef.current = next; // update before the emit below so the reconcile reads the new value
      saveDebugVisibility(next);
      return next;
    });
    eventEmitter.current.emit('DEBUG_VISIBILITY_CHANGED');
  };

  // Reusable node templates, persisted to IndexedDB (they embed base64 textures and would blow the
  // ~5MB localStorage quota). Loaded asynchronously on mount.
  const [templates, setTemplates] = useState<Template[]>([]);
  const templatesLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        let list = await idbGet<Template[]>(libKey('templates'));
        if (!list) {
          const raw = localStorage.getItem(KEYS.templates);
          if (raw) {
            list = JSON.parse(raw) as Template[];
            try { await idbSet(libKey('templates'), list); localStorage.removeItem(KEYS.templates); } catch { /* keep legacy copy if migration write fails */ }
          }
        }
        // Don't clobber templates the user may have added before the async load resolved.
        if (list && list.length) setTemplates(prev => prev.length ? prev : list!);
      } catch (e) { console.warn('Failed to load templates:', e); }
      finally { templatesLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('templates'), templates, templatesLoadedRef);

  // ----- The input action map ------------------------------------------------------------------
  //
  // Project-wide, not per-scene: two scenes disagreeing about what `Jump` is bound to would be a bug
  // nobody could explain. Stored under its own key rather than as a LibName — every LibName is read as
  // an ARRAY by the bundle importer, and an object under one corrupts an import (see storageKeys).
  const [inputMap, setInputMap] = useState<InputMap>(() => cloneInputMap(DEFAULT_INPUT_MAP));
  const inputMapLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const stored = await idbGet<InputMap>(inputMapKey());
        if (stored) setInputMap(parseInputMap(stored));
      } catch (e) { console.warn('Failed to load the input map:', e); }
      finally { inputMapLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(inputMapKey(), inputMap, inputMapLoadedRef);

  // ----- Project settings (engine runtime, publish window) ---------------------------------------
  // Same lifecycle as the input map: project-wide, its own key, persisted on change.
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>(() => parseProjectSettings(null));
  const projectSettingsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const stored = await idbGet<ProjectSettings>(projectSettingsKey());
        if (stored) setProjectSettings(parseProjectSettings(stored));
      } catch (e) { console.warn('Failed to load the project settings:', e); }
      finally { projectSettingsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(projectSettingsKey(), projectSettings, projectSettingsLoadedRef);
  const projectSettingsRef = useRef(projectSettings);
  projectSettingsRef.current = projectSettings;
  // Gizmo snap steps follow Options ▸ Editor ▸ Viewport.
  useEffect(() => {
    const sync = () => { const p = getEditorPrefs(); setGizmoSnapSteps({ translate: p.snapTranslate, rotateDeg: p.snapRotateDeg, scale: p.snapScale }); };
    sync();
    return editorPrefsStore.subscribe(sync);
  }, []);

  // Live: a change in Options ▸ Engine takes effect on the next frame, in the editor and in Play alike.
  useEffect(() => {
    const engine = instanceRef.current;
    if (engine) applyEngineRuntime(engine as any, projectSettings.engine, AudioManager.Instance.mixer);
  }, [projectSettings.engine]);

  // Push edits straight into the running system, so Play picks up a rebind with no rebuild — and
  // install the editor's own camera map as an OVERLAY, which is never serialized into a build.
  useEffect(() => {
    const input = InputSystem.instance;
    input.setMap(inputMap);
    input.setOverlayMaps([EDITOR_CAMERA_MAP]);
    // `setMap` resets every map to its AUTHORED enable state, so the edit/play split has to be applied
    // again here. Without it, rebinding a key while the game is running would hand the keyboard back to
    // the editor's camera mid-play. Simulate is the exception: nobody is possessed, so the editor camera
    // keeps the keyboard there exactly as the SET_PLAY_STATE handler set it up.
    if (isPlayModeRef.current && !isSimulatingRef.current) {
      input.disableMap('EditorCamera');
      input.enableMap('Gameplay');
      input.enableMap('UI');
    } else if (isPlayModeRef.current) {
      input.enableMap('EditorCamera');
      input.disableMap('Gameplay');
      input.enableMap('UI');
    } else {
      input.enableMap('EditorCamera');
      // Nothing reads the game maps while authoring, and leaving Gameplay live would mean WASD driving
      // both the viewport camera and a character that is not running.
      input.disableMap('Gameplay');
    }
  }, [inputMap]);

  const addTemplate = (t: Template) => setTemplates(prev => [...prev, t]);
  const removeTemplate = (id: string) => {
    // Unlink any placed instances so they become normal, fully-editable nodes. Removing the marker
    // re-renders the provider, so the node inspector's read-only gate re-evaluates to editable.
    const scene = editorSceneRef.current;
    let changed = false;
    for (const n of Array.from(scene.nodes)) {
      if (n.getVariable(TEMPLATE_ID_VAR) === id) { n.removeVariable(TEMPLATE_ID_VAR); changed = true; }
    }
    if (changed) eventEmitter.current.emit('SCENE_CHANGED');
    // Variants based on it keep their content: it is already materialized, so cutting the link changes
    // nothing they contain or that their placed copies show.
    setTemplates(prev => prev.filter(x => x.id !== id).map(x => x.variant?.baseTemplateId === id ? flattenVariant(x) : x));
  };
  const updateTemplate = (id: string, t: Template) => setTemplates(prev => prev.map(x => x.id === id ? t : x));

  // Reusable material assets (global library, like templates): persisted to IndexedDB because they embed
  // base64 textures + a thumbnail. A node references one via the MATERIAL_ID_VAR node variable.
  const [materials, setMaterials] = useState<MaterialAsset[]>([]);
  const materialsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<MaterialAsset[]>(libKey('materials'));
        if (list && list.length) setMaterials(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load materials:', e); }
      finally { materialsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('materials'), materials, materialsLoadedRef);

  const addMaterial = (m: MaterialAsset) => setMaterials(prev => [...prev, m]);
  const updateMaterial = (id: string, m: MaterialAsset) => setMaterials(prev => prev.map(x => x.id === id ? m : x));

  // Reusable terrain-material assets: a Basic/Blinn/PBR surface plus terrain blend + foliage rules,
  // persisted to IndexedDB. Terrain paint layers reference one via the layer's materialId.
  const [terrainMaterials, setTerrainMaterials] = useState<TerrainMaterialAsset[]>([]);
  const terrainMaterialsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<TerrainMaterialAsset[]>(libKey('terrainMaterials'));
        if (list && list.length) setTerrainMaterials(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load terrain materials:', e); }
      finally { terrainMaterialsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('terrainMaterials'), terrainMaterials, terrainMaterialsLoadedRef);

  const addTerrainMaterial = (m: TerrainMaterialAsset) => setTerrainMaterials(prev => [...prev, m]);
  const updateTerrainMaterial = (id: string, m: TerrainMaterialAsset) => setTerrainMaterials(prev => prev.map(x => x.id === id ? m : x));

  // Reusable mesh assets (imported models): persisted to IndexedDB (they embed base64 textures + a
  // thumbnail). Drag a mesh into the viewport to instantiate a copy.
  const [models, setModels] = useState<ModelAsset[]>([]);
  const modelsLoadedRef = useRef(false);
  /** What IndexedDB already holds, so a save writes only the assets that changed. Seeded by the load. */
  const persistedModelsRef = useRef<ModelAsset[]>([]);
  useEffect(() => {
    (async () => {
      try {
        // One record per asset; readModelLibrary migrates a project still on the single `cleo_models`
        // array and reports the library's size. See utils/modelStore for why it is sharded.
        const step = bootLoadRef.current.step('models').start();
        const list = await readModelLibrary(undefined, (done, total) => step.progress(done, total));
        if (!list.length) step.skip('none');
        // The baseline is the RAW list, before the flatten below: an asset flattenModelAsset actually
        // changed comes back as a NEW object and so gets written, while one it left alone is the same
        // object and is skipped. Seeding with the flattened list instead would lose that migration.
        persistedModelsRef.current = list;
        // One-shot flatten of legacy assets that still carry a holder node. flattenModelAsset returns the
        // same object when there is nothing to do, and node ids are preserved.
        if (list.length) setModels(prev => prev.length ? prev : list.map(flattenModelAsset));
      } catch (e) {
        Logger.error(`Failed to load the model library: ${e}`, 'Editor');
        bootLoadRef.current.step('models').fail(String(e));
      }
      finally {
        modelsLoadedRef.current = true;
        bootLoadRef.current.step('models').done();
      }
    })();
  }, []);
  usePersistedModelLibrary(models, modelsLoadedRef, persistedModelsRef);

  // Reactive edit state for open mesh tabs (tab id -> session). The tab's Scene stays in tabRuntimeRef;
  // this holds what the Mesh inspector renders (LOD level ids/distances, cull distance, active level).
  const [modelSessions, setModelSessions] = useState<Record<string, ModelEditSession>>({});

  const addModel = (m: ModelAsset) => setModels(prev => [...prev, m]);
  /**
   * Delete the library assets the OLD LOD scheme minted for `sourceId` — level models carrying
   * `lodSource.modelId === sourceId` (except `keep`), plus the "… LOD n" materials made for them that no
   * surviving model still lists. Generated levels are embedded now; these are what is left of the ones
   * that were not, cleared by the source's next save and by its deletion.
   *
   * The `__lod` texture twins are deliberately NOT evicted: copies of the model already placed in scenes
   * embed their levels, and those still draw from them. They are hidden from the explorer either way.
   */
  const purgeLegacyLodAssets = (sourceId: string, keep: ReadonlySet<string> = new Set()) => {
    const legacy = modelsRef.current.filter(m => m.lodSource?.modelId === sourceId && !keep.has(m.id));
    if (!legacy.length) return;
    const gone = new Set(legacy.map(m => m.id));
    const remaining = modelsRef.current.filter(m => !gone.has(m.id) && m.id !== sourceId);
    const stillUsed = new Set(remaining.flatMap(m => m.materialIds ?? []));
    const deadMaterials = new Set(legacy.flatMap(m => m.materialIds ?? []).filter(id => !stillUsed.has(id)));
    for (const t of tabs) if (t.kind === 'model' && t.modelId && gone.has(t.modelId)) removeTabById(t.id);
    setModels(prev => prev.filter(x => !gone.has(x.id)));
    modelsRef.current = modelsRef.current.filter(x => !gone.has(x.id));
    if (deadMaterials.size) {
      setMaterials(prev => prev.filter(m => !deadMaterials.has(m.id)));
      materialsRef.current = materialsRef.current.filter(m => !deadMaterials.has(m.id));
    }
    Logger.info(`Removed ${legacy.length} old LOD level asset${legacy.length === 1 ? '' : 's'} of a model.`, 'Editor');
  };

  const removeModel = (id: string) => {
    // A preview tab for a deleted mesh would render a subtree whose asset no longer exists — close it
    // first. Safe to reference the later-declared tab helpers: this only ever runs from a click.
    const openTab = tabs.find(t => t.kind === 'model' && t.modelId === id);
    if (openTab) removeTabById(openTab.id);
    // Its generated levels are embedded and go with it; levels the old scheme kept as assets go too.
    // (The explorer asked first — see deleteConsequence.)
    purgeLegacyLodAssets(id);
    setModels(prev => prev.filter(x => x.id !== id));
  };
  const updateModel = (id: string, m: ModelAsset) => setModels(prev => prev.map(x => x.id === id ? m : x));

  // Reusable, class-based script assets (global library like materials): a node references one via the
  // SCRIPT_ID_VAR node variable. Persisted to IndexedDB. Editing the asset propagates to every linked node.
  const [scriptAssets, setScriptAssets] = useState<ScriptAsset[]>([]);
  const scriptAssetsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<ScriptAsset[]>(libKey('scripts'));
        if (list && list.length) setScriptAssets(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load scripts:', e); }
      finally { scriptAssetsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('scripts'), scriptAssets, scriptAssetsLoadedRef);

  // Mirror for async flows (play/save serialize scripts off-render): buildGameData reads the current list.
  const scriptAssetsRef = useRef<ScriptAsset[]>([]);
  // Mirrored during RENDER, not in an effect — see the library-mirror block below for why.
  scriptAssetsRef.current = scriptAssets;

  // Where each script lives in the asset explorer (asset id -> VFS path). Scripts import each other BY
  // THAT PATH ('@/Shared/Math'), and the VFS provider is nested INSIDE this one, so it pushes the index
  // down here rather than this reading it. A ref plus a version: the play build reads the ref, and the
  // version re-renders the few views that label scripts by their role.
  const scriptPathsRef = useRef<Map<string, string>>(new Map());
  const [scriptPaths, setScriptPathsState] = useState<ReadonlyMap<string, string>>(new Map());
  const syncScriptPaths = (paths: ReadonlyMap<string, string>) => {
    const prev = scriptPathsRef.current;
    if (prev.size === paths.size && [...paths].every(([id, path]) => prev.get(id) === path)) return;
    scriptPathsRef.current = new Map(paths);
    setScriptPathsState(scriptPathsRef.current);
  };

  const addScriptAsset = (s: ScriptAsset) => setScriptAssets(prev => [...prev, s]);
  const updateScriptAsset = (id: string, s: ScriptAsset) => setScriptAssets(prev => prev.map(x => x.id === id ? s : x));
  const removeScriptAsset = (id: string) => {
    // Unlink every node that referenced it (drops __scriptId, its script-owned native fields, and the
    // per-node source cache) so those nodes become plain, script-less nodes instead of dangling links.
    const scene = editorSceneRef.current;
    const gone = scriptAssets.find(x => x.id === id);
    let changed = false;
    for (const n of Array.from(scene.nodes)) {
      if (getScriptIdOf(n) === id) { unlinkScript(n, gone, scriptsRef.current); changed = true; }
    }
    if (changed) eventEmitter.current.emit('SCENE_CHANGED');
    setScriptAssets(prev => prev.filter(x => x.id !== id));
  };

  // Animation assets: shared clips, stored in their SOURCE rig's space and retargeted per model at use.
  // A model's SKELETON (`.rig`) names the animations it plays by id (`animationIds`) — see utils/rigAssets.ts.
  const [animations, setAnimations] = useState<AnimationAsset[]>([]);
  /**
   * Bump to re-sweep model assets on next load. See the migration below.
   *   v2 — lift clips embedded in a model's subtree into shared `.anim` assets.
   *   v3 — lift each model's SKELETON into a shared `.rig`, and point every `.anim` at the rig it was
   *        authored against (utils/rigMigration.ts).
   *   v4 — move clip OWNERSHIP from the model to its rig, and re-point every animation field the same way,
   *        so one link serves every character built on an armature.
   */
  const ANIMATION_ASSET_MIGRATION = 4;
  const animationsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = (await idbGet<AnimationAsset[]>(libKey('animations'))) ?? [];
        // Lift clips embedded in model assets into shared ones, stamped in kv, and only after both
        // libraries have been read. Clip NAMES are preserved: state machines and field samples reference
        // clips by name. The model library as it was before each pass is kept under a backup key.
        //
        // Versioned rather than a plain one-shot: v1 only cleaned what was in the library when it ran,
        // and the importer kept embedding clips afterwards. The loader hands every skinned sub-mesh of a
        // file the SAME clip list, so a model imported with "Separate sub-models" wrote a full copy of the
        // whole clip set into each of its N assets — assets that then grew past the maximum string length
        // (see utils/deepClone). v2 sweeps those up; the importer no longer creates them.
        const done = (await idbGet<number>(libKey('animations') + ':migrated')) ?? 0;
        if (done < ANIMATION_ASSET_MIGRATION) {
          // Through the store, not the raw key: by this point the library may already be sharded.
          // ONE read, one combined pass, one write. The rig sweep must not be a second effect: two
          // passes each doing readModelLibrary -> mutate -> writeModelLibrary would lose one of the two
          // writes and double-seed persistedModelsRef.
          const models = await readModelLibrary();
          const storedRigs = (await idbGet<RigAsset[]>(libKey('rigs'))) ?? [];
          const r = extractEmbeddedClips(models, list, skinnedModelJsonOf, assetWithoutEmbeddedClips);
          // v3. Runs over the OUTPUT of v2, so a project migrating both versions in one boot sees the
          // clips already lifted. `extractRigs` returns unchanged models by identity, so a library that
          // gains nothing here is not rewritten.
          const g = extractRigs(r.models, r.animations, storedRigs, skinnedModelJsonsOf);
          // v4, over v3's output: clips and blend spaces move up to the rig now that every model has one.
          const storedFields = (await idbGet<AnimationFieldAsset[]>(libKey('animationFields'))) ?? [];
          const clipNames = new Map(g.animations.map(a => [a.id, a.clips.map(c => c.name)]));
          const v4 = moveClipsToRigs(g.models, g.rigs, storedFields, id => clipNames.get(id) ?? []);
          const modelsChanged = r.extracted || r.shared || g.linkedModels || v4.moved;

          if (modelsChanged || g.created || g.linkedAnimations) {
            // No `preAnimationAssets` backup any more. It was a second full copy of a library big enough
            // to be the problem, and the extraction only ever REMOVES clips that were just written to the
            // animation library — so the data still exists, addressed differently.
            if (modelsChanged) {
              await writeModelLibrary(v4.models, models);
              persistedModelsRef.current = v4.models; // storage now holds these; don't re-write them
              setModels(prev => (prev.length ? v4.models.map(flattenModelAsset) : prev));
            }
            await idbSet(libKey('animations'), g.animations);
            if (v4.rigs.length) await idbSet(libKey('rigs'), v4.rigs);
            if (v4.repointed) await idbSet(libKey('animationFields'), v4.fields);
            if (r.extracted || r.shared) {
              Logger.info(`Animation library: extracted ${r.extracted} clip${r.extracted === 1 ? '' : 's'}` +
                (r.shared ? `, ${r.shared} already shared with another model` : ''), 'Editor');
            }
            if (g.created || g.linkedModels || g.linkedAnimations) {
              Logger.info(`Rig library: ${g.created} skeleton${g.created === 1 ? '' : 's'} extracted, ` +
                `linked to ${g.linkedModels} model${g.linkedModels === 1 ? '' : 's'} and ` +
                `${g.linkedAnimations} animation${g.linkedAnimations === 1 ? '' : 's'}`, 'Editor');
            }
            if (v4.moved || v4.repointed) {
              Logger.info(
                `Rig library: ${v4.moved} clip link${v4.moved === 1 ? '' : 's'} moved onto rigs` +
                (v4.repointed ? `, ${v4.repointed} blend space${v4.repointed === 1 ? '' : 's'} re-pointed` : ''),
                'Editor');
            }
            // Reported, never renamed: a de-duped "walk (2)" would break every state machine naming it,
            // with nothing but a play-time warning to show for it.
            for (const c of v4.clashes) {
              Logger.warn(
                `Rig "${c.rig}": two animations both provide a clip named "${c.clip}". Kept the first and ` +
                'skipped the second — link it to a different rig, or rename its clip.', 'Editor');
            }
            // UNCONDITIONAL, and that is load-bearing. These libraries have their own plain load effects
            // racing this one, and a `prev.length ? prev : …` guard here loses that race the moment the
            // pre-migration list is non-empty: the stale list would stay in state and `usePersistedLibrary`
            // would write it straight back over what was just persisted above — while the MODELS have
            // already been written with their links stripped and the version stamped. Net effect: every
            // shared clip link lost on the next reload.
            //
            // Safe in the other order too: those effects use the `prev.length ? prev : list` guard, so a
            // late read finds state already populated and no-ops.
            setAnimations(g.animations);
            setRigs(v4.rigs);
            if (v4.repointed) setAnimationFields(v4.fields);
          } else if (list.length) setAnimations(prev => prev.length ? prev : list);
          await idbSet(libKey('animations') + ':migrated', ANIMATION_ASSET_MIGRATION);
        } else if (list.length) setAnimations(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load animations:', e); }
      finally { animationsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('animations'), animations, animationsLoadedRef);

  // Mirror for the import/save paths, which run off-render — see the library-mirror block below.
  const animationsRef = useRef<AnimationAsset[]>([]);
  animationsRef.current = animations;

  const addAnimation = (a: AnimationAsset) => setAnimations(prev => [...prev, a]);
  const updateAnimation = (id: string, a: AnimationAsset) =>
    setAnimations(prev => prev.map(x => x.id === id ? a : x));
  const removeAnimation = (id: string) => {
    setAnimations(prev => prev.filter(x => x.id !== id));
    // Close its editor tab. Without this the tab stays open over a library record that no longer exists,
    // and its session keeps a working copy that Save would happily re-add — resurrecting the asset the
    // user just deleted. Mirrors `removeRig`.
    const open = tabsRef.current.find(t => t.kind === 'animation' && t.animationId === id);
    if (open) removeTabById(open.id);
    // Drop the reference from every skeleton that used it. Clips already instantiated on live nodes are
    // left alone — a copy the user can still see.
    for (const r of rigsRef.current) {
      const next = withoutAnimationRef(r, id);
      if (next !== r) updateRig(r.id, next);
    }
  };

  // Rig assets: a character's SKELETON, named and shared (utils/rigAssets.ts). A model points at one via
  // `rigId`, and so does an `.anim`, naming the skeleton its clips were authored against. Before this, both
  // dug the skeleton out of a model's serialized subtree by taking the first sub-mesh that had one — which
  // silently missed, and took the IK rig and bone names down with it.
  const [rigs, setRigs] = useState<RigAsset[]>([]);
  const rigsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<RigAsset[]>(libKey('rigs'));
        if (list && list.length) setRigs(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load rigs:', e); }
      finally { rigsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('rigs'), rigs, rigsLoadedRef);

  const rigsRef = useRef<RigAsset[]>([]);
  rigsRef.current = rigs;

  const addRig = (r: RigAsset) => setRigs(prev => [...prev, r]);
  const updateRig = (id: string, r: RigAsset) => {
    setRigs(prev => prev.map(x => x.id === id ? r : x));
    // The retarget cache is keyed by (animation, model) and reads the rig's skeleton, so a rig edit — a
    // bone-name backfill, an IK change — invalidates every mapping built from it. Without this the old
    // index-matched mapping survives and the character animates subtly wrongly, with nothing logged.
    // From the REF, not the `rigs` render value: two updates in one handler (an import linking several
    // files) would otherwise each start from the pre-handler list and the second would drop the first.
    rigsRef.current = rigsRef.current.map(x => x.id === id ? r : x);
    invalidateAnimationCache();
    syncRigSockets(r);
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
  };
  const removeRig = (id: string) => {
    // Close its tab first: a rig tab holds a preview scene keyed on an asset that is about to vanish.
    const open = tabsRef.current.find(t => t.kind === 'rig' && t.rigId === id);
    if (open) removeTabById(open.id);
    setRigs(prev => prev.filter(x => x.id !== id));
    // Unlink, never leave dangling: an animation whose rigId names nothing and which has no `sourceSkin`
    // would retarget against nothing and silently play in the wrong space.
    for (const m of modelsRef.current) {
      if (m.nativeRigId === id) updateModel(m.id, { ...m, nativeRigId: undefined });
      else if (m.rigId === id) {
        // Playing a deleted foreign skeleton: back to its own; on its own skeleton: unlinked.
        updateModel(m.id, { ...m, rigId: m.nativeRigId, nativeRigId: undefined });
      }
    }
    for (const r of rigsRef.current) if (r.retargetTargets?.includes(id)) {
      updateRig(r.id, { ...r, retargetTargets: r.retargetTargets.filter(t => t !== id) });
    }
    for (const a of animationsRef.current) if (a.rigId === id) updateAnimation(a.id, { ...a, rigId: undefined });
    invalidateAnimationCache();
  };

  /**
   * The rig for a skeleton, reusing an equivalent one or minting it. The import-time twin of what
   * `extractRigs` does for a whole library — so a character and the clips imported for it land on ONE rig
   * rather than two copies of the same skeleton that then have to be retargeted between.
   *
   * Writes through the ref as well as state: an import links the returned rig immediately, and `rigs` is a
   * render mirror that would still be the pre-add array (the same trap `adoptModelAsset` hit).
   */
  const ensureRig = (skin: StoredSkin | null | undefined, name: string): RigAsset | null => {
    if (!skin) return null;
    const found = findEquivalentRig(rigsRef.current, skin);
    if (found) return found;
    const rig = buildRigAsset(name || 'Rig', skin);
    rigsRef.current = [...rigsRef.current, rig];
    addRig(rig);
    return rig;
  };

  /** A readable rig name from an imported file: "mannequin.fbx" -> "mannequin". */
  const animationTargetName = (fileName: string) => fileName.replace(/\.[^.]+$/, '') || 'Rig';

  // Animation Field assets (blend spaces). A field blends clips from ONE model asset by 1D/2D parameters;
  // the animation state machine consumes it as a state. Persisted to IndexedDB like every other library.
  const [animationFields, setAnimationFields] = useState<AnimationFieldAsset[]>([]);
  const animationFieldsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<AnimationFieldAsset[]>(libKey('animationFields'));
        if (list && list.length) setAnimationFields(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load animation fields:', e); }
      finally { animationFieldsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('animationFields'), animationFields, animationFieldsLoadedRef);

  // Mirror for the save/propagate paths, which run off-render — see the library-mirror block below.
  const animationFieldsRef = useRef<AnimationFieldAsset[]>([]);
  animationFieldsRef.current = animationFields;

  const addAnimationField = (f: AnimationFieldAsset) => setAnimationFields(prev => [...prev, f]);
  const updateAnimationField = (id: string, f: AnimationFieldAsset) =>
    setAnimationFields(prev => prev.map(x => x.id === id ? f : x));
  const removeAnimationField = (id: string) => {
    setAnimationFields(prev => prev.filter(x => x.id !== id));
    // Clear the embedded copy from every state that played it, across every live scene; the state degrades
    // to "no clip" (bind pose).
    let changed = false;
    for (const scene of liveScenes()) {
      for (const n of Array.from(scene.nodes)) {
        if (!(n instanceof ModelNode) || !n.animator) continue;
        const sm = n.animator.getStateMachine();
        if (!machineUsesField(sm, id)) continue;
        n.animator.setStateMachine(reembedFields(sm as any, []) as any);
        changed = true;
      }
    }
    if (changed) eventEmitter.current.emit('SCENE_CHANGED');
    // Close its editor tab: the asset it edits is gone, so saving it would resurrect a deleted field.
    const open = tabsRef.current.find(t => t.kind === 'animationField' && t.animationFieldId === id);
    if (open) removeTabById(open.id);
  };

  // Tileset assets (sliced atlases). A tileset is what a tilemap layer paints from; a TilemapNode embeds a
  // full copy of every one it references, so this library is the authoring source of truth and the embedded
  // copies are refreshed from it on save (see reembedTilesets).
  const [tilesets, setTilesets] = useState<TilesetAsset[]>([]);
  const tilesetsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<TilesetAsset[]>(libKey('tilesets'));
        if (list && list.length) setTilesets(prev => prev.length ? prev : list.map(normalizeTilesetAsset));
      } catch (e) { console.warn('Failed to load tilesets:', e); }
      finally { tilesetsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('tilesets'), tilesets, tilesetsLoadedRef);

  const tilesetsRef = useRef<TilesetAsset[]>([]);
  tilesetsRef.current = tilesets;

  const addTileset = (t: TilesetAsset) => setTilesets(prev => [...prev, t]);
  const updateTileset = (id: string, t: TilesetAsset) => {
    setTilesets(prev => prev.map(x => x.id === id ? t : x));
    // Push the edit into every tilemap that embedded an older copy, across every live scene — otherwise a
    // change to a tile's solidity or animation would only take effect on maps painted after it.
    const next = tilesetsRef.current.map(x => x.id === id ? t : x);
    let changed = false;
    for (const scene of liveScenes()) if (reembedTilesets(scene, next)) changed = true;
    if (changed) eventEmitter.current.emit('SCENE_CHANGED');
  };
  const removeTileset = (id: string) => {
    setTilesets(prev => prev.filter(x => x.id !== id));
    // Unlink every layer painted from it. The cells stay, but the layer draws nothing until a tileset is
    // assigned again.
    let changed = false;
    for (const scene of liveScenes()) if (detachTileset(scene, id)) changed = true;
    if (changed) eventEmitter.current.emit('SCENE_CHANGED');
    const open = tabsRef.current.find(t => t.kind === 'tileset' && t.tilesetId === id);
    if (open) removeTabById(open.id);
  };

  // AI BRAINS. Same arrangement as tilesets, and for the same reason: a ControllerNode keeps a full copy
  // of the machine/goals/fuzzy it runs, so this library is the authoring source of truth and the embedded
  // copies are refreshed from it on save (see reembedBrains).
  const [aiBrains, setAiBrains] = useState<AiBrainAsset[]>([]);
  const aiBrainsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<AiBrainAsset[]>(libKey('aiBrains'));
        if (list && list.length) setAiBrains(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load AI brains:', e); }
      finally { aiBrainsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('aiBrains'), aiBrains, aiBrainsLoadedRef);

  const aiBrainsRef = useRef<AiBrainAsset[]>([]);
  aiBrainsRef.current = aiBrains;

  const addAiBrain = (b: AiBrainAsset) => setAiBrains(prev => [...prev, b]);
  const updateAiBrain = (id: string, b: AiBrainAsset) => {
    setAiBrains(prev => prev.map(x => x.id === id ? b : x));
    // Push the edit into every controller holding an older copy, across every live scene — otherwise an
    // edited brain would only reach agents linked after the edit.
    const next = aiBrainsRef.current.map(x => x.id === id ? b : x);
    let changed = false;
    for (const scene of liveScenes()) if (reembedBrains(scene, next)) changed = true;
    if (changed) eventEmitter.current.emit('SCENE_CHANGED');
  };
  const removeAiBrain = (id: string) => {
    setAiBrains(prev => prev.filter(x => x.id !== id));
    // Drop the LINK only. Every controller keeps the brain it copied and goes on behaving identically —
    // deleting a library entry should not lobotomise the agents that used it.
    let changed = false;
    for (const scene of liveScenes()) if (detachBrain(scene, id)) changed = true;
    if (changed) eventEmitter.current.emit('SCENE_CHANGED');
    const open = tabsRef.current.find(t => t.kind === 'aiBrain' && t.aiBrainId === id);
    if (open) removeTabById(open.id);
  };

  // PARTICLE SYSTEMS. The brain arrangement again: a ParticleSystemNode keeps a full copy of the effect it
  // plays, so this library is the authoring source of truth and the embedded copies are refreshed from it
  // on SAVE (see saveParticleSystem / reembedParticleSystems) — not on every update, because `setSystem`
  // restarts the effect and the particle editor writes its working copy far more often than it saves.
  const [particleSystems, setParticleSystems] = useState<ParticleSystemAsset[]>([]);
  const particleSystemsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<ParticleSystemAsset[]>(libKey('particleSystems'));
        if (list && list.length) setParticleSystems(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load particle systems:', e); }
      finally { particleSystemsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('particleSystems'), particleSystems, particleSystemsLoadedRef);

  const particleSystemsRef = useRef<ParticleSystemAsset[]>([]);
  particleSystemsRef.current = particleSystems;

  const addParticleSystem = (p: ParticleSystemAsset) => setParticleSystems(prev => [...prev, p]);
  const updateParticleSystem = (id: string, p: ParticleSystemAsset) =>
    setParticleSystems(prev => prev.map(x => x.id === id ? p : x));
  const removeParticleSystem = (id: string) => {
    setParticleSystems(prev => prev.filter(x => x.id !== id));
    // Drop the LINK only. Every node keeps the effect it copied and goes on playing it — deleting a
    // library entry should not blank the fires and sparks that used it.
    let changed = false;
    for (const scene of liveScenes()) if (detachParticleSystem(scene, id)) changed = true;
    if (changed) eventEmitter.current.emit('SCENE_CHANGED');
    const open = tabsRef.current.find(t => t.kind === 'particleSystem' && t.particleSystemId === id);
    if (open) removeTabById(open.id);
  };

  // Animation controllers, bone masks and pose assets: plain JSON records, persisted like the brains. A
  // ModelNode embeds a resolved copy of what it uses (controllerId / maskId / poseRef record the source),
  // so deleting a library entry leaves every character playing what it already copied.
  const [animControllers, setAnimControllers] = useState<AnimControllerAsset[]>([]);
  const animControllersLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<AnimControllerAsset[]>(libKey('animControllers'));
        if (list && list.length) setAnimControllers(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load animation controllers:', e); }
      finally { animControllersLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('animControllers'), animControllers, animControllersLoadedRef);

  const animControllersRef = useRef<AnimControllerAsset[]>([]);
  animControllersRef.current = animControllers;

  const addAnimController = (c: AnimControllerAsset) => setAnimControllers(prev => [...prev, c]);
  const updateAnimController = (id: string, c: AnimControllerAsset) => setAnimControllers(prev => prev.map(x => x.id === id ? c : x));
  const removeAnimController = (id: string) => setAnimControllers(prev => prev.filter(x => x.id !== id));

  const [boneMasks, setBoneMasks] = useState<BoneMaskAsset[]>([]);
  const boneMasksLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<BoneMaskAsset[]>(libKey('boneMasks'));
        if (list && list.length) setBoneMasks(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load bone masks:', e); }
      finally { boneMasksLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('boneMasks'), boneMasks, boneMasksLoadedRef);

  const boneMasksRef = useRef<BoneMaskAsset[]>([]);
  boneMasksRef.current = boneMasks;

  const addBoneMask = (m: BoneMaskAsset) => setBoneMasks(prev => [...prev, m]);
  const updateBoneMask = (id: string, m: BoneMaskAsset) => setBoneMasks(prev => prev.map(x => x.id === id ? m : x));
  const removeBoneMask = (id: string) => setBoneMasks(prev => prev.filter(x => x.id !== id));

  const [poseAssets, setPoseAssets] = useState<PoseAsset[]>([]);
  const poseAssetsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<PoseAsset[]>(libKey('poseAssets'));
        if (list && list.length) setPoseAssets(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load pose assets:', e); }
      finally { poseAssetsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('poseAssets'), poseAssets, poseAssetsLoadedRef);

  const poseAssetsRef = useRef<PoseAsset[]>([]);
  poseAssetsRef.current = poseAssets;

  const addPoseAsset = (p: PoseAsset) => setPoseAssets(prev => [...prev, p]);
  const updatePoseAsset = (id: string, p: PoseAsset) => setPoseAssets(prev => prev.map(x => x.id === id ? p : x));
  const removePoseAsset = (id: string) => setPoseAssets(prev => prev.filter(x => x.id !== id));

  /** The libraries a state machine's links (fields, masks, poses) resolve against, as of now. */
  const machineLibs = () => ({
    animationFields: animationFieldsRef.current, boneMasks: boneMasksRef.current, poses: poseAssetsRef.current,
  });

  /**
   * Re-embed every live machine that links a controller, mask or pose, after one of those libraries
   * changed. Nodes hold RESOLVED copies (that is what plays and what ships), so an edit to the asset only
   * reaches them through here — the controller twin of `reembedFields`. Stored scenes are reached by
   * `resyncScene` when they are next opened.
   *
   * Waits for all three libraries to load: a mask that has not loaded yet would read as DELETED, and a
   * deleted mask switches its layer off.
   */
  const reembedLiveMachines = () => {
    if (!animControllersLoadedRef.current || !boneMasksLoadedRef.current || !poseAssetsLoadedRef.current) return;
    const libs = { ...machineLibs(), controllers: animControllersRef.current };
    for (const scene of liveScenes()) {
      for (const n of Array.from(scene.nodes)) {
        if (!(n instanceof ModelNode) || !n.animator) continue;
        const next = reembedMachine(n.animator.getStateMachine(), libs);
        // Derived from the asset, not an edit of this node: nothing to mark unsaved.
        if (next) withoutDirty(() => n.animator!.setStateMachine(next));
      }
    }
  };
  useEffect(() => { reembedLiveMachines(); }, [animControllers, boneMasks, poseAssets]);

  // Clips resolve `poseOffset` edits against pose assets too, so a pose edit must re-resolve every model
  // on the rig it belongs to — exactly what a rig edit does.
  const lastPoseAssetsRef = useRef<PoseAsset[]>([]);
  useEffect(() => {
    const before = lastPoseAssetsRef.current;
    lastPoseAssetsRef.current = poseAssets;
    if (!poseAssetsLoadedRef.current || before === poseAssets) return;
    const rigIds = new Set<string>();
    for (const p of [...before, ...poseAssets]) {
      const prev = before.find(x => x.id === p.id);
      const now = poseAssets.find(x => x.id === p.id);
      if (JSON.stringify(prev?.poses ?? null) !== JSON.stringify(now?.poses ?? null) && p.rigId) rigIds.add(p.rigId);
    }
    if (!rigIds.size) return;
    invalidateAnimationCache();
    for (const rigId of rigIds) applyRigLinks(rigId);
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
  }, [poseAssets]);

  /**
   * Open a controller asset in the state-machine editor, previewed on a character built on its rig.
   *
   * Unlike `enterStateMachineEditor` there is no source node: Apply writes the CONTROLLER, and every
   * character using it picks the change up through `reembedLiveMachines`.
   */
  const openAnimController = (id: string, adoptTabId?: string) => {
    const asset = animControllersRef.current.find(c => c.id === id);
    if (!asset) { Logger.error('Controller not found', 'Editor'); return; }
    // Focus-existing is an OPEN-time concern: on hydration it would find the restored placeholder itself.
    if (!adoptTabId) {
      const existing = tabs.find(t => t.kind === 'stateMachine' && t.controllerId === id && !t.stateMachineSourceId);
      if (existing) { setActiveTab(existing.id); return; }
    }

    const model = modelsRef.current.find(m => !!asset.rigId && m.rigId === asset.rigId)
      ?? (!asset.rigId ? modelsRef.current.find(m => modelAssetIsSkinned(m)) : undefined);
    if (!model) {
      Logger.warn(`"${asset.name}" needs a character to preview on — link a model to ${asset.rigId ? 'its rig' : 'a rig'} first.`, 'Editor');
      return;
    }

    const wasArmed = dirtyArmedRef.current;
    dirtyArmedRef.current = false;
    const scene = new Scene();
    scene.animationsEnabled = false;
    scene.spawnRulesEnabled = false;
    // Editor-owned for the same reason the node path's holder is: this tab saves the controller, never
    // the preview.
    const holder = markEditorOwned(new Node(`${asset.name} (preview)`));
    scene.addNode(holder);
    withoutDirty(() => instantiateModelAsset(model, holder, materialsRef.current, modelsRef.current, animationsRef.current));
    scene.root.updateTransforms();
    const skinned = firstSkinnedModelNode(holder);
    if (!skinned?.animator) {
      Logger.error(`"${model.name}" has no skinned mesh to preview the controller on`, 'Editor');
      dirtyArmedRef.current = wasArmed;
      return;
    }
    const bounds = combineBounds(skinned);
    createAnimationEditorScene(scene, bounds.center, bounds.radius, { silently: withoutDirty });
    scene.start();
    withoutDirty(() => skinned.animator!.setStateMachine(instantiateController(asset, machineLibs())));
    skinned.animator.showBindPose();

    const tabId = adoptTabId ?? cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: skinned.id });
    commitTab({ id: tabId, kind: 'stateMachine', title: asset.name, controllerId: id, workspaceRigId: asset.rigId ?? model.rigId ?? null }, adoptTabId);
  };

  /** A new, empty Animator for a skeleton, opened straight away. Returns its id. */
  const createAnimatorForRig = (rigId: string, name?: string): string | null => {
    const rig = rigsRef.current.find(r => r.id === rigId);
    if (!rig) { Logger.error('Skeleton not found', 'Editor'); return null; }
    const asset = buildControllerAsset(name ?? `${rig.name} Animator`, null, rigId);
    // Mirrored eagerly: openAnimController reads the ref, which is a render mirror.
    animControllersRef.current = [...animControllersRef.current, asset];
    addAnimController(asset);
    openAnimController(asset.id);
    return asset.id;
  };

  /**
   * The "Animate this character" wizard's commit: build an Animator from a template, give it to the
   * character, switch on foot placement for its skeleton if it has none, and open the workspace on it.
   *
   * The Animator is a shared asset on the SKELETON (so a second character on it can reuse it), and the
   * locomotion blend space, when there is one, is added to the library beside it.
   */
  const animateCharacter = (
    nodeId: string, templateId: TemplateId, assigned: Record<string, string | undefined>,
  ): { controllerId: string; actions: { slot: string; clip: string }[]; footPlacement: boolean } | null => {
    const node = activeScene.getNodeById(nodeId);
    const skinned = node instanceof ModelNode && node.animator ? node : firstSkinnedModelNode(node ?? null);
    if (!skinned?.animator || !(skinned.model instanceof AnimatedModel) || !skinned.model.skin) {
      Logger.error('Pick a character with a skeleton to animate', 'Editor'); return null;
    }
    const modelId = modelIdOf(skinned);
    const rigId = modelId ? ensureRigForModel(modelId) : null;
    const rig = rigId ? rigsRef.current.find(r => r.id === rigId) : undefined;
    if (!rig) { Logger.error('This character is not a model from the library, so it has no skeleton to animate', 'Editor'); return null; }

    const template = templateById(templateId);
    const result = buildFromTemplate(template, assigned, rig.id, { name: rig.name });
    // Mirrored eagerly, like every create-then-use path here: the machine is resolved against the refs.
    if (result.field) {
      animationFieldsRef.current = [...animationFieldsRef.current, result.field];
      addAnimationField(result.field);
    }
    const controller = buildControllerAsset(`${rig.name} Animator`, result.machine, rig.id);
    animControllersRef.current = [...animControllersRef.current, controller];
    addAnimController(controller);

    skinned.animator.setStateMachine(instantiateController(controller, machineLibs()));
    markTabDirty(activeTabId, 'animate-character');
    eventEmitter.current.emit('ANIM_SM_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');

    let footPlacement = false;
    if (template.footPlacement && !rig.ikRig) {
      const guess = guessFootPlacement(skinned.model.skin);
      if (guess.rig) { updateRig(rig.id, { ...rig, ikRig: guess.rig }); footPlacement = true; }
    }

    Logger.info(`"${skinned.name}" now animates with "${controller.name}" (${template.name})`, 'Editor');
    openAnimController(controller.id);
    return { controllerId: controller.id, actions: result.actions, footPlacement };
  };

  // The two halves of the image/texture split. An ImageAsset is metadata over the bytes that already live
  // in the `textures` IndexedDB store; a TextureAsset is a byte source plus every sampling decision, and
  // its id IS the TextureManager id every serialized material already references.
  //
  // Neither is minted here. `reconcileTextureAssets` (VfsProvider) derives both from what is actually
  // registered in the TextureManager, which is what makes the split a continuous reconciler rather than a
  // one-shot migration — the same path covers the first boot after the upgrade, a model import, a scene
  // parse and a bundle import.
  const [images, setImages] = useState<ImageAsset[]>([]);
  const imagesLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<ImageAsset[]>(libKey('images'));
        if (list && list.length) setImages(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load images:', e); }
      finally { imagesLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('images'), images, imagesLoadedRef);

  const imagesRef = useRef<ImageAsset[]>([]);
  imagesRef.current = images;

  const addImage = (i: ImageAsset) => setImages(prev => [...prev, i]);
  const updateImage = (id: string, i: ImageAsset) => setImages(prev => prev.map(x => x.id === id ? i : x));
  const removeImage = (id: string) => setImages(prev => prev.filter(x => x.id !== id));

  const [textures, setTextures] = useState<TextureAsset[]>([]);
  const texturesLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<TextureAsset[]>(libKey('textures'));
        if (list && list.length) setTextures(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load textures:', e); }
      finally { texturesLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('textures'), textures, texturesLoadedRef);

  const texturesRef = useRef<TextureAsset[]>([]);
  texturesRef.current = textures;

  const addTextureAsset = (t: TextureAsset) => setTextures(prev => [...prev, t]);
  const updateTextureAsset = (id: string, t: TextureAsset) => {
    setTextures(prev => prev.map(x => x.id === id ? t : x));
    // Sampling is a property of the LIVE texture, so an edit has to reach the GPU as well as the record —
    // otherwise the viewport keeps showing the old wrap mode until the next reload.
    TextureManager.Instance.getTexture(id)?.applySettings(toTextureConfig(t.settings));
    eventEmitter.current.emit('TEXTURES_CHANGED');
  };
  const removeTextureAsset = (id: string) => setTextures(prev => prev.filter(x => x.id !== id));

  // The two halves of the audio-source/sound-sample split, the exact twin of the pair above. An
  // AudioSourceAsset is metadata over bytes in the `audio` IndexedDB store; a SoundSampleAsset is a byte
  // source plus every playback decision, and its id IS the AudioManager id every serialized SoundNode
  // references. Neither is minted here — `reconcileSoundAssets` (VfsProvider) derives both from what is
  // registered in the AudioManager.
  const [audioSources, setAudioSources] = useState<AudioSourceAsset[]>([]);
  const audioSourcesLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<AudioSourceAsset[]>(libKey('audioSources'));
        if (list && list.length) setAudioSources(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load audio sources:', e); }
      finally { audioSourcesLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('audioSources'), audioSources, audioSourcesLoadedRef);

  const audioSourcesRef = useRef<AudioSourceAsset[]>([]);
  audioSourcesRef.current = audioSources;

  const addAudioSource = (a: AudioSourceAsset) => setAudioSources(prev => [...prev, a]);
  const updateAudioSource = (id: string, a: AudioSourceAsset) => setAudioSources(prev => prev.map(x => x.id === id ? a : x));
  const removeAudioSource = (id: string) => setAudioSources(prev => prev.filter(x => x.id !== id));

  const [soundSamples, setSoundSamples] = useState<SoundSampleAsset[]>([]);
  const soundSamplesLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<SoundSampleAsset[]>(libKey('soundSamples'));
        if (list && list.length) setSoundSamples(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load sound samples:', e); }
      finally { soundSamplesLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('soundSamples'), soundSamples, soundSamplesLoadedRef);

  const soundSamplesRef = useRef<SoundSampleAsset[]>([]);
  soundSamplesRef.current = soundSamples;

  const addSoundSample = (s: SoundSampleAsset) => setSoundSamples(prev => [...prev, s]);
  const updateSoundSample = (id: string, sample: SoundSampleAsset) => {
    setSoundSamples(prev => prev.map(x => x.id === id ? sample : x));
    // Playback settings belong to the LIVE Sound, so an edit has to reach howler as well as the record —
    // otherwise a sound keeps its old volume, loop points and effect rack until the next reload. The twin
    // of the applySettings call in updateTextureAsset.
    AudioManager.Instance.applySettings(id, sample.settings);
    eventEmitter.current.emit('SOUNDS_CHANGED');
  };
  const removeSoundSample = (id: string) => setSoundSamples(prev => prev.filter(x => x.id !== id));

  const scriptAssetOf = (node: Node | null): ScriptAsset | undefined => {
    const id = getScriptIdOf(node ?? undefined);
    return id ? scriptAssets.find(a => a.id === id) : undefined;
  };

  const createScriptForNode = (node: Node, name?: string): ScriptAsset | null => {
    const baseType = node.nodeType as ScriptBaseType;
    const assetName = name?.trim() || `${node.name} Script`;
    const asset = buildScriptAsset(assetName, baseType, defaultScriptClass(assetName, baseType));
    addScriptAsset(asset);
    if (!applyScriptAsset(node, asset, scriptsRef.current)) return null;
    eventEmitter.current.emit('SCENE_CHANGED');
    return asset;
  };

  const attachScriptToNode = (node: Node, scriptId: string): boolean => {
    const asset = scriptAssets.find(a => a.id === scriptId);
    if (!asset) return false;
    if (!applyScriptAsset(node, asset, scriptsRef.current)) {
      if (scriptKindOfAsset(asset) === 'module')
        Logger.warn(`"${asset.name}" is a script module — shared code other scripts import. Only a class script can attach to a node.`, 'Editor');
      else
        Logger.warn(`Script "${asset.name}" extends ${asset.baseType}; it cannot attach to a ${node.nodeType} node`, 'Editor');
      return false;
    }
    eventEmitter.current.emit('SCENE_CHANGED');
    return true;
  };

  const detachScriptFromNode = (node: Node) => {
    unlinkScript(node, scriptAssetOf(node), scriptsRef.current);
    eventEmitter.current.emit('SCENE_CHANGED');
  };

  // Persist an edited script's source and propagate to every linked node: re-cache the source, and add
  // any new fields / prune removed ones while keeping each node's authored values.
  //
  // Scripts can import each other, so a save re-derives more than its own asset: a class that extends
  // this one (`Hollow extends EnemyBase`) inherits its fields, and may only now resolve to a specific
  // engine base type. Every dependent is rebuilt and its nodes re-seeded in the same pass.
  const saveScriptSource = (id: string, source: string) => {
    const existing = scriptAssetsRef.current.find(a => a.id === id);
    if (!existing) return;
    // Re-derive against a library that already holds the NEW source.
    let library = scriptAssetsRef.current.map(a => a.id === id ? { ...a, source } : a);
    const rebuild = (asset: ScriptAsset, src: string): ScriptAsset => {
      const ctx = buildScriptGraphCtx(scriptPathsRef.current, library);
      const path = ctx.pathOf(asset.id);
      // Only ever UPGRADE from 'node' (attaches anywhere): an explicit base type the user chose stays.
      const derived = deriveBaseType(src, path, ctx);
      const baseType = asset.baseType === 'node' && derived !== 'node' ? derived : asset.baseType;
      const next = buildScriptAsset(asset.name, baseType, src, asset.id, resolveScriptVariables(src, path, ctx));
      library = library.map(a => a.id === asset.id ? next : a);
      return next;
    };
    const next = rebuild(existing, source);
    const dependents = dependentsOf(id, library, buildScriptGraphCtx(scriptPathsRef.current, library))
      .map(dep => rebuild(dep, dep.source));
    const changed = new Map([next, ...dependents].map(a => [a.id, a]));
    setScriptAssets(prev => prev.map(x => changed.get(x.id) ?? x));
    // Propagation only — the nodes store __scriptId and the source is fanned out at serialize time, so
    // this must not mark the scene dirty (see the note in saveMaterialTab).
    withoutDirty(() => {
      for (const scene of liveScenes()) {
        for (const n of Array.from(scene.nodes)) {
          const asset = changed.get(getScriptIdOf(n) ?? '');
          if (!asset) continue;
          scriptsRef.current.set(n.id, asset.source);
          seedScriptFields(n, asset, false);
        }
      }
      eventEmitter.current.emit('SCENE_CHANGED');
    });
  };

  // Dedicated Script editor tab: opens a script asset in a full-panel code editor (its own mode + Save
  // Script button). Working source buffers per-tab (scriptTabSourceRef) until Save.
  const scriptTabSourceRef = useRef(new Map<string, string>());
  const enterScriptEditor = (scriptId?: string, adoptTabId?: string, mint?: ScriptAsset) => {
    // Options ▸ Editor ▸ Scripts: "Open scripts with VSCode" (desktop only). A restored tab (adoptTabId)
    // always stays in the editor; anything the external editor cannot open falls back to the built-in one.
    if (!adoptTabId && getEditorPrefs().scriptOpenWith === 'vscode' && isDesktop()) {
      const created = scriptId ? null : (mint ?? buildScriptAsset('New Script', 'node', defaultScriptClass('New Script', 'node')));
      if (created) addScriptAsset(created);
      const id = scriptId ?? created!.id;
      // A just-minted script reaches the workspace mirror on the next render; give that a moment.
      void (async () => {
        if (created) await new Promise(resolve => setTimeout(resolve, 120));
        if (!(await openScriptExternally(id))) openScriptTab(id, undefined, created);
      })();
      return;
    }
    openScriptTab(scriptId, adoptTabId, mint);
  };

  /** The built-in script editor tab (see enterScriptEditor). `mintNew` adds `mint` to the library first. */
  const openScriptTab = (scriptId?: string, adoptTabId?: string, mint?: ScriptAsset | null, mintNew = true) => {
    let id = scriptId;
    // Held across the mint because scriptAssetsRef is mirrored during RENDER: a just-added asset is not in
    // it yet, so looking the new script up below would miss it.
    let created: ScriptAsset | null = null;
    if (!id) {
      // No id: mint a new 'node'-based script (or the module handed in) and open it.
      created = mint ?? buildScriptAsset('New Script', 'node', defaultScriptClass('New Script', 'node'));
      if (mintNew) addScriptAsset(created);
      id = created.id;
      scriptTabSourceRef.current.set(id, created.source);
    } else if (mint) created = mint;
    // Focus an already-open tab for this script instead of duplicating it. Skipped when adopting: the
    // restored placeholder IS a tab for this script, so this would find it, focus it and build nothing.
    if (!adoptTabId) {
      const existing = tabs.find(t => t.kind === 'script' && t.scriptId === id);
      if (existing) { setActiveTab(existing.id); return; }
    }
    const asset = created ?? scriptAssetsRef.current.find(a => a.id === id);
    const tabId = adoptTabId ?? cryptoRandomId();
    scriptTabSourceRef.current.set(id, asset?.source ?? scriptTabSourceRef.current.get(id) ?? '');
    commitTab({ id: tabId, kind: 'script', title: asset?.name ?? 'Script', scriptId: id }, adoptTabId);
  };

  /** A new script MODULE — shared code other scripts import, never attached to a node — opened at once. */
  const createScriptModule = () => {
    enterScriptEditor(undefined, undefined, buildScriptAsset('New Module', 'node', defaultScriptModule('New Module')));
  };

  // Save a script tab: commit its buffered source to the asset (persists + propagates to linked nodes) and
  // clear the tab's dirty flag. Takes a tab id so Save All can reach a tab that is not on screen.
  const saveScriptTab = (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab || tab.kind !== 'script' || !tab.scriptId) return;
    const source = scriptTabSourceRef.current.get(tab.scriptId);
    if (source !== undefined) saveScriptSource(tab.scriptId, source);
    clearTabDirty(tab.id);
  };
  // Called by the script tab's editor on every edit: buffer the source and mark the tab dirty.
  const setScriptTabSource = (tabId: string, scriptId: string, source: string) => {
    scriptTabSourceRef.current.set(scriptId, source);
    markTabDirty(tabId, 'script-source');
  };
  const getScriptTabSource = (scriptId: string): string | undefined => scriptTabSourceRef.current.get(scriptId);

  /** Rename a script asset in place. Its source and base type are untouched, so nothing needs re-seeding. */
  const renameScriptAsset = (id: string, name: string) => {
    const existing = scriptAssetsRef.current.find(a => a.id === id);
    const trimmed = name.trim();
    if (!existing || !trimmed || existing.name === trimmed) return;
    updateScriptAsset(id, { ...existing, name: trimmed });
  };

  /**
   * Adopt a source edited in the script workspace folder (VSCode) as the new truth. Must also reconcile the
   * Script TAB — replace its buffer, un-dirty it, and refresh the open Monaco model through the
   * external-source store — or the next in-editor save clobbers the external edit.
   */
  const adoptExternalScriptSource = (id: string, source: string): { replacedUnsaved: boolean } => {
    const tab = tabsRef.current.find(t => t.kind === 'script' && t.scriptId === id);
    const buffered = scriptTabSourceRef.current.get(id);
    const replacedUnsaved = !!tab && !!dirtyTabsRef.current[tab.id] && buffered !== undefined && buffered !== source;

    scriptTabSourceRef.current.set(id, source);
    if (tab) clearTabDirty(tab.id);
    pushExternalSource(id, source);
    saveScriptSource(id, source);
    return { replacedUnsaved };
  };


  // True once all IndexedDB-backed libraries (and the project's scene list) have finished their initial
  // read. The asset explorer's path index must not prune entries before this — the arrays start empty,
  // and a pruning pass against an empty library would drop every folder assignment the user has made.
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  useEffect(() => {
    if (assetsLoaded) return;
    const flags = [templatesLoadedRef, materialsLoadedRef, terrainMaterialsLoadedRef, modelsLoadedRef, scriptAssetsLoadedRef,
      animationFieldsLoadedRef, animationsLoadedRef, rigsLoadedRef, scenesLoadedRef, imagesLoadedRef, texturesLoadedRef,
      audioSourcesLoadedRef, soundSamplesLoadedRef, aiBrainsLoadedRef, particleSystemsLoadedRef, animControllersLoadedRef,
      boneMasksLoadedRef, poseAssetsLoadedRef];
    const step = bootLoadRef.current.step('libraries').start();
    const timer = window.setInterval(() => {
      const ready = flags.filter(f => f.current).length;
      step.progress(ready, flags.length);
      if (ready === flags.length) {
        step.done();
        setAssetsLoaded(true);
        window.clearInterval(timer);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [assetsLoaded]);

  /**
   * Re-resolve the STARTUP scene's asset links, the moment `assetsLoaded` says the libraries are real.
   * setupInitialScene parses the scene blob before the libraries finish their async IndexedDB reads, and
   * resyncing against empty ones would unlink every material; the blob's hashes are stashed at parse time.
   */
  const initialAssetHashesRef = useRef<{ hashes: Record<string, string> | undefined; version?: number } | null>(null);
  const initialResyncDoneRef = useRef(false);

  /**
   * One-shot upgrade of legacy sprites in every live scene: an inline tileset (synthesized by
   * `Sprite.parse` from a raw texture id) becomes a real tileset asset. Runs after the startup resync.
   * Sprites it cannot migrate are left inline and still draw, so a partial pass is safe to repeat.
   */
  const spriteMigrationDoneRef = useRef(false);
  const migrateSprites = async (): Promise<void> => {
    if (spriteMigrationDoneRef.current) return;
    spriteMigrationDoneRef.current = true;
    const fresh: TilesetAsset[] = [];
    for (const scene of liveScenes()) {
      const result = await migrateSceneSprites(scene, [...tilesetsRef.current, ...fresh]);
      fresh.push(...result.created);
    }
    if (!fresh.length) return;
    tilesetsRef.current = [...tilesetsRef.current, ...fresh];
    setTilesets(prev => [...prev, ...fresh]);
    Logger.info(`Migrated ${fresh.length} sprite sheet${fresh.length === 1 ? '' : 's'} to tileset assets`, 'Editor');
    eventEmitter.current.emit('SCENE_CHANGED');
  };
  /**
   * One-shot upgrade of controllers that carry a brain authored inline, from before AI Brain assets
   * existed: the machine (or goal graph) plus its fuzzy model becomes a library asset, and the
   * controller is linked to it.
   *
   * COPIED, never moved. The controller keeps the brain it was already running, so behaviour is
   * identical either side of this — it simply starts saying where that brain came from, which is what
   * makes it reusable and editable in its own tab.
   *
   * Self-limiting by construction: once `brainId` is set the condition is false, so this cannot run
   * twice on the same controller and needs no migration flag of its own. It DOES leave the scene dirty,
   * which the toast says out loud — a scene that reports unsaved changes the moment it opens is
   * otherwise alarming.
   */
  const brainMigrationDoneRef = useRef(false);
  const migrateInlineBrains = (): void => {
    if (brainMigrationDoneRef.current) return;
    brainMigrationDoneRef.current = true;

    const fresh: AiBrainAsset[] = [];
    for (const scene of liveScenes()) {
      for (const controller of scene.controllers) {
        if (controller.brainId) continue;
        // Nothing authored means nothing to extract: a controller that never had a brain must not
        // acquire an empty asset it will never use.
        const authored = controller.behavior.states.length > 0
          || controller.goals.goals.length > 0
          || controller.fuzzy.variables.length > 0;
        if (!authored) continue;

        const asset = buildAiBrainAsset(`${controller.name} brain`,
          controller.brain === 'goal' ? 'goals' : 'behavior');
        asset.machine = controller.behavior;
        asset.graph = controller.goals;
        asset.fuzzy = controller.fuzzy;
        controller.brainId = asset.id;
        fresh.push(asset);
      }
    }
    if (!fresh.length) return;

    aiBrainsRef.current = [...aiBrainsRef.current, ...fresh];
    setAiBrains(prev => [...prev, ...fresh]);
    Logger.info(
      `Moved ${fresh.length} inline AI brain${fresh.length === 1 ? '' : 's'} into the asset library. ` +
      `Behaviour is unchanged; save the scene to keep the links.`, 'Editor');
    eventEmitter.current.emit('SCENE_CHANGED');
  };

  useEffect(() => {
    if (initialResyncDoneRef.current || !assetsLoaded || !isSceneReady) return;
    const stashed = initialAssetHashesRef.current;
    if (!stashed) {
      // No blob was parsed (fresh/empty project): nothing to re-resolve.
      bootLoadRef.current.step('resync').skip('nothing to link');
      return;
    }
    // Never resync against libraries that are entirely empty: resyncScene reads "asset not in library" as
    // "asset was deleted" and unlinks, stripping every template link, class script and material.
    // Leave initialResyncDoneRef false so a later commit, once the libraries are there, still gets a pass.
    const libs = currentLibs();
    const empty = !libs.materials.length && !libs.models.length && !libs.templates.length
      && !libs.terrainMaterials.length && !libs.scripts.length;
    if (empty) {
      // Deferred, not cancelled: the libraries are effect deps, so the commit that delivers them retries.
      Logger.warn('Startup asset resync deferred: libraries not populated yet, will retry.', 'Editor');
      return;
    }
    initialResyncDoneRef.current = true;
    const resyncStep = bootLoadRef.current.step('resync').start();
    // Propagation, not the user's work — resyncing must not make a freshly-opened scene look unsaved.
    withoutDirty(() => {
      const changed = resyncScene(editorSceneRef.current, engineMaps(), libs, stashed.hashes, stashed.version);
      resyncStep.done(changed ? 'updated' : 'up to date');
      if (changed) {
        showBindPoseForSkinnedModels(editorSceneRef.current);
        eventEmitter.current.emit('TEXTURES_CHANGED');
        eventEmitter.current.emit('SCENE_CHANGED');
        eventEmitter.current.emit('SELECT_NODE', null); // a reinstantiated subtree invalidates the selection
      }
    });
    // Promotes inline-tileset sprites to real library assets so they can be edited. Async (it waits on
    // atlas decodes) and deliberately not awaited: an upgrade, not a precondition for showing the scene.
    void migrateSprites();
    migrateInlineBrains();
    // The libraries are deps so the skip-when-empty branch above retries; initialResyncDoneRef keeps it to
    // one real pass.
  }, [assetsLoaded, isSceneReady, materials, models, templates, terrainMaterials, scriptAssets]);

  /**
   * Finish restoring last session's tabs: drop the ones whose asset is gone, then build the active one.
   * MUST stay declared after the resync effect above — effects run in declaration order, and a tab clones
   * its subtree out of the libraries the open scene has to have been re-resolved against first.
   */
  useEffect(() => {
    if (bootTabsDoneRef.current) return;
    if (!assetsLoaded || !isSceneReady || !instanceRef.current) return;
    bootTabsDoneRef.current = true;
    // The resync above defers while the libraries read as empty, and for a project whose libraries
    // really ARE empty it never runs. The splash must not wait on it: that case links nothing.
    if (!initialResyncDoneRef.current && initialAssetHashesRef.current) bootLoadRef.current.step('resync').skip('no library assets');
    const tabsStep = bootLoadRef.current.step('tabs').start();

    const libs = currentLibs();
    const fields = animationFieldsRef.current;
    const stillExists = (tab: EditorTab): boolean => {
      const id = assetIdOfTab(tab);
      switch (tab.kind) {
        case 'scene': return true;
        case 'template': return libs.templates.some(t => t.id === id);
        case 'material': return libs.materials.some(m => m.id === id);
        case 'terrainMaterial': return libs.terrainMaterials.some(m => m.id === id);
        case 'model': return libs.models.some(m => m.id === id);
        case 'script': return libs.scripts.some(s => s.id === id);
        case 'tileset': return libs.tilesets.some(t => t.id === id);
        case 'aiBrain': return libs.aiBrains.some(b => b.id === id);
        case 'particleSystem': return particleSystemsRef.current.some(p => p.id === id);
        case 'texture': return texturesRef.current.some(t => t.id === id);
        case 'soundSample': return soundSamplesRef.current.some(x => x.id === id);
        case 'rig': return rigsRef.current.some(r => r.id === id);
        case 'animation': return animationsRef.current.some(a => a.id === id);
        // Only a controller tab is ever restored for this kind (see `isRestorableTab`).
        case 'stateMachine': return !!id && animControllersRef.current.some(c => c.id === id);
        // A field also needs the model it blends — enterAnimationFieldEditor refuses to open without it.
        case 'animationField': {
          const field = fields.find(f => f.id === id);
          // Restorable while SOME model uses the field's rig — that is what its preview needs. The
          // `field.rigId` guard matters: without it an unmigrated field (no rigId) matches the first
          // rig-less model, because `undefined === undefined`.
          return !!field?.rigId && libs.models.some(m => m.rigId === field.rigId);
        }
        default: return false;
      }
    };

    const kept = tabsRef.current.filter(stillExists);
    const dropped = tabsRef.current.length - kept.length;
    if (dropped) Logger.info(`Closed ${dropped} restored tab${dropped === 1 ? '' : 's'} whose asset no longer exists`, 'Editor');
    if (dropped) setTabs(kept);
    tabsRef.current = kept;
    pendingHydrationRef.current = new Set(kept.filter(t => t.kind !== 'scene').map(t => t.id));

    // Only the visible tab pays for a session at boot; the rest hydrate when they are first clicked.
    let active = kept.find(t => t.id === activeTabIdRef.current) ?? kept[0];
    if (!hydrateTab(active)) {
      Logger.error(`"${active.title}" could not be reopened — the asset it edits is gone`, 'Editor');
      removeTabById(active.id);
      active = kept.find(t => t.id === SCENE_TAB_ID) ?? kept[0];
    }
    if (active.id !== activeTabIdRef.current) setActiveTabId(active.id);
    applyActiveTab(active);
    tabsRestoreDoneRef.current = true;
    tabsStep.done(`${kept.length} tab${kept.length === 1 ? '' : 's'}`);
  }, [assetsLoaded, isSceneReady]);

  /**
   * Close the startup splash once every boot step has settled (done, failed or skipped) — not at
   * `isSceneReady`, which comes before the libraries, the resync and the tab restore. A watchdog
   * closes it regardless after a minute, naming what never finished, so the editor cannot be stuck.
   */
  useEffect(() => {
    const boot = bootLoadRef.current;
    const settled = () => {
      const load = currentLoad();
      if (!load || load.id !== boot.id) return false;
      return load.steps.every(s => s.status === 'done' || s.status === 'failed' || s.status === 'skipped');
    };
    const check = () => { if (settled()) boot.finish(); };
    const unsubscribe = subscribeLoad(check);
    check();
    const watchdog = window.setTimeout(() => {
      const load = currentLoad();
      if (!load || load.id !== boot.id) return;
      const stuck = load.steps.filter(s => s.status === 'pending' || s.status === 'running').map(s => s.label);
      if (stuck.length) Logger.warn(`Startup splash closed after 60 s; still loading: ${stuck.join(', ')}`, 'Editor');
      boot.finish();
    }, 60_000);
    return () => { unsubscribe(); window.clearTimeout(watchdog); };
  }, []);

  // Remember the open documents for the next visit. Debounced because a tab rename or a drag-reorder fires
  // several commits, and gated on the boot restore so the pre-prune list is never written back over the
  // pruned one.
  useEffect(() => {
    if (!tabsRestoreDoneRef.current) return;
    const timer = setTimeout(() => saveTabState(tabs, activeTabId, mainMode), 200);
    return () => clearTimeout(timer);
  }, [tabs, activeTabId, mainMode]);

  // Keep the texture store in step with the libraries. Assets record only texture IDS; the payloads live
  // once in the store, and this idempotent self-healing reconcile is what puts them there. It also adopts
  // legacy assets' inline base64 payloads into the store; nothing is stripped from those assets here.
  const [textureEpoch, setTextureEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setTextureEpoch(n => n + 1);
    const emitter = eventEmitter.current;
    emitter.on('TEXTURES_CHANGED', bump);
    return () => { emitter.off('TEXTURES_CHANGED', bump); };
  }, []);

  useEffect(() => {
    if (!assetsLoaded) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const legacy = legacyTexturesOf(materials, terrainMaterials, templates, models);
          if (legacy.length) await adoptLegacyTextures(legacy);

          // No id list: persist every live texture with source bytes. A texture can belong to the scene
          // without belonging to any library, and the project blob no longer embeds them.
          const written = await persistTextures();
          if (written) Logger.info(`Stored ${written} texture${written === 1 ? '' : 's'}`, 'Editor');
        } catch (e) {
          Logger.error(`Failed to store textures: ${e}`, 'Editor');
        }
      })();
    }, 500); // debounced: an import registers textures and adds assets in a burst
    return () => window.clearTimeout(timer);
  }, [assetsLoaded, textureEpoch, materials, terrainMaterials, templates, models]);

  // The audio twin of the block above: an epoch bumped by SOUNDS_CHANGED, and a debounced pass that
  // writes every live sample's bytes into the audio store. Debounced for the same reason — an import
  // registers samples and adds records in a burst.
  const [soundEpoch, setSoundEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setSoundEpoch(n => n + 1);
    const emitter = eventEmitter.current;
    emitter.on('SOUNDS_CHANGED', bump);
    return () => { emitter.off('SOUNDS_CHANGED', bump); };
  }, []);

  useEffect(() => {
    if (!assetsLoaded) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          // No id list, same reasoning as textures: a sample can be referenced by the scene without
          // belonging to any library, and the project blob does not embed audio.
          const written = await persistAudio();
          if (written) Logger.info(`Stored ${written} sound${written === 1 ? '' : 's'}`, 'Editor');
        } catch (e) {
          Logger.error(`Failed to store audio: ${e}`, 'Editor');
        }
      })();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [assetsLoaded, soundEpoch, soundSamples]);

  // The five park-then-resolve modals (mesh import review, rig pick, animation import review, unsaved-
  // changes confirm, dimension-switch confirm). See hooks/usePendingDecisions.
  const {
    pendingModelImport, setPendingModelImport, pendingResolverRef, resolveModelImport,
    pendingRigPick, setPendingRigPick, pendingRigResolverRef, resolveRigPick,
    pendingAnimationImport, setPendingAnimationImport, pendingAnimResolverRef, resolveAnimationImport,
    pendingSceneConfirm, confirmUnsavedScene, resolveSceneConfirm,
    pendingDimensionConfirm, confirmDimensionSwitch, resolveDimensionConfirm,
  } = usePendingDecisions();

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
  const activeRuntime = activeTab.kind !== 'scene' ? tabRuntimeRef.current.get(activeTab.id) : undefined;
  // The scene the inspectors/gizmo/AddNew currently edit: the game scene (Main tab) or a template/material/animation scene.
  const activeScene = activeRuntime ? activeRuntime.scene : editorSceneRef.current;
  // What the tree, the Inspector and viewport picking show: the running simulation while Simulating, the
  // edited scene otherwise. Deliberately NOT `editorScene`: publish, the asset graph, undo and the gizmo
  // must keep addressing the authored scene, which is the one that gets saved.
  const inspectedScene = simulatedScene ?? activeScene;
  // Single mode value, derived from the active tab kind, for `editorMode === ...` consumers. The map is
  // exhaustive over TabKind, so a new kind cannot fall through to some other mode's panels.
  const editorMode: EditorMode = activeTab.kind === 'scene' ? mainMode : TAB_EDITOR_MODE[activeTab.kind];
  const templateRootId = activeTab.kind === 'template' && activeRuntime ? activeRuntime.rootId : null;
  const editingTemplateName = activeTab.kind === 'template' ? activeTab.title : null;
  // Inherited vs overridden is judged against the base the tab DIFFS against — its snapshot from opening.
  const editingTemplateVariant = useMemo(() => {
    if (activeTab.kind !== 'template' || !activeTab.templateId) return null;
    const t = templates.find(x => x.id === activeTab.templateId);
    if (!t?.variant) return null;
    const base = activeRuntime?.baseAtOpen ?? templates.find(x => x.id === t.variant!.baseTemplateId);
    return base ? { id: t.id, baseName: base.name, base, diff: t.variant.diff } : null;
  }, [activeTab, templates, activeRuntime]);
  const editingMaterialName = activeTab.kind === 'material' ? activeTab.title : null;
  const editingTerrainMaterialName = activeTab.kind === 'terrainMaterial' ? activeTab.title : null;
  // The unrendered edit node (its material is the TerrainMaterial) that the terrain-material inspector edits.
  const editingTerrainMaterialNode = activeTab.kind === 'terrainMaterial' ? (activeRuntime?.editNode ?? null) : null;
  // Animation editor: the cloned skinned model in the tab's scene (target to preview/edit) and the
  // original node in the main scene (where authored state machines are written back).
  const stateMachineTargetId = activeTab.kind === 'stateMachine' && activeRuntime ? activeRuntime.rootId : null;
  /**
   * The skinned node whose SKELETON is on screen — the animation editor's clone, or the rig editor's
   * preview character. Separate from `stateMachineTargetId`, which additionally means "the model whose
   * clips and state machine are being edited" and drives write paths a rig tab must not trigger.
   */
  const skeletonTargetId = activeTab.kind === 'stateMachine' ? stateMachineTargetId
    : activeTab.kind === 'animation' ? (activeRuntime?.skinnedId ?? null)
    : activeTab.kind === 'rig' ? (activeRuntime?.skinnedId ?? null) : null;
  const stateMachineSourceId = activeTab.kind === 'stateMachine' ? (activeTab.stateMachineSourceId ?? null) : null;
  // The scene the source node lives in (main or a template tab) — used to enumerate accessible
  // node variables for the state machine's Variable parameters (the clone's scene is isolated).
  const stateMachineSourceScene = activeTab.kind === 'stateMachine' ? (activeRuntime?.sourceScene ?? null) : null;
  // Animation Field editor: the asset being edited and the skinned model previewing it. The tab's runtime
  // root is the holder Node the model asset instantiated under, so the ModelNode carrying the skin is found
  // beneath it rather than being the root itself.
  const editingAnimationFieldId = activeTab.kind === 'animationField' ? (activeTab.animationFieldId ?? null) : null;
  const animationFieldTargetId = activeTab.kind === 'animationField' && activeRuntime
    ? (firstSkinnedModelNode(activeRuntime.scene.getNodeById(activeRuntime.rootId) ?? null)?.id ?? null)
    : null;
  const editingRigId = activeTab.kind === 'rig' ? (activeTab.rigId ?? null) : null;
  const editingAnimationId = activeTab.kind === 'animation' ? (activeTab.animationId ?? null) : null;
  const editingTilesetId = activeTab.kind === 'tileset' ? (activeTab.tilesetId ?? null) : null;
  const editingTextureId = activeTab.kind === 'texture' ? (activeTab.textureId ?? null) : null;
  const editingSoundId = activeTab.kind === 'soundSample' ? (activeTab.soundId ?? null) : null;
  const editingAiBrainId = activeTab.kind === 'aiBrain' ? (activeTab.aiBrainId ?? null) : null;
  const editingParticleSystemId = activeTab.kind === 'particleSystem' ? (activeTab.particleSystemId ?? null) : null;

  // Non-reactive mirrors of the tab list, the mesh sessions and the asset libraries. The save + propagation
  // paths read these rather than the render-scoped state: Save All walks tabs sequentially with an await
  // per asset, where a value captured at the top of the loop is stale by the second iteration.
  const tabsRef = useRef<EditorTab[]>(tabs);
  const modelSessionsRef = useRef<Record<string, ModelEditSession>>(modelSessions);
  const materialsRef = useRef<MaterialAsset[]>(materials);
  const terrainMaterialsRef = useRef<TerrainMaterialAsset[]>(terrainMaterials);
  const modelsRef = useRef<ModelAsset[]>(models);
  const templatesRef = useRef<Template[]>(templates);
  // Mirrored during RENDER, never in a useEffect: effects run in DECLARATION order, these are declared far
  // below the boot resync effect, and resyncing against mirrors still holding [] unlinks every asset in the
  // scene. Plain "latest value" mirrors, so assigning during render is idempotent.
  tabsRef.current = tabs;
  modelSessionsRef.current = modelSessions;
  materialsRef.current = materials;
  terrainMaterialsRef.current = terrainMaterials;
  modelsRef.current = models;
  templatesRef.current = templates;

  // Lets utils/foliageRules rebuild a rule's prototype geometry from the model library without the
  // library being threaded through parseTerrainMaterialAsset / applyTerrainMaterialToLayer and their
  // seven call sites. Reads the REFS, so it always sees the current libraries rather than the render
  // this closure was created on.
  registerFoliageSourceResolver((modelId: string) => {
    const model = modelsRef.current.find(m => m.id === modelId);
    return model ? { model, library: modelsRef.current, materials: materialsRef.current } : null;
  });

  // Same shape and the same reason as the foliage resolver above: `animationResolve` needs to turn a
  // `rigId` into a skeleton, and threading the rig library through resolveAnimationAsset ->
  // resolveModelAnimations -> applyModelAnimations -> refreshModelClips would touch every call site of each.
  registerRigResolver((rigId: string) => rigsRef.current.find(r => r.id === rigId) ?? null);
  registerPoseAssetResolver(() => poseAssetsRef.current);

  const engineMaps = () => ({ scripts: scriptsRef.current, bodies: bodiesRef.current, triggers: triggersRef.current });

  /**
   * Every Scene alive in the editor: the open scene, plus each asset tab's throwaway edit scene. Scenes that
   * are NOT live are handled pull-side by resyncScene when they are opened. `exceptTabId` skips the tab
   * doing the saving — essential for the re-instantiating kinds, whose own root carries the propagated id.
   */
  const liveScenes = (exceptTabId?: string): Scene[] => [
    editorSceneRef.current,
    ...Array.from(tabRuntimeRef.current.entries())
      .filter(([id]) => id !== exceptTabId)
      .map(([, rt]) => rt.scene),
  ];
  // Snapshot of the four hashable asset libraries, as the resync/hash utilities consume them.
  const currentLibs = (): AssetLibs => ({
    materials: materialsRef.current, models: modelsRef.current, templates: templatesRef.current,
    terrainMaterials: terrainMaterialsRef.current, scripts: scriptAssetsRef.current,
    tilesets: tilesetsRef.current, aiBrains: aiBrainsRef.current, animations: animationsRef.current,
    particleSystems: particleSystemsRef.current,
    rigs: rigsRef.current,
    animControllers: animControllersRef.current, boneMasks: boneMasksRef.current, poseAssets: poseAssetsRef.current,
    animationFields: animationFieldsRef.current,
  });

  // Open (or focus) a template editor tab. Each template tab owns its own throwaway edit scene.
  const enterTemplateEditor = (templateId?: string, adoptTabId?: string) => {
    const instance = instanceRef.current;
    if (!instance) return;

    // Focus an already-open tab for this template instead of duplicating it. Skipped when adopting: that
    // would find the restored placeholder and no-op the hydration.
    if (templateId && !adoptTabId) {
      const existing = tabs.find(t => t.kind === 'template' && t.templateId === templateId);
      if (existing) { setActiveTab(existing.id); return; }
    }

    // Disarm before constructing — see openMaterialTab. Must come after the focus-only early return above:
    // that path builds no scene and would not re-run the activate effect that re-arms.
    const wasArmed = dirtyArmedRef.current;
    dirtyArmedRef.current = false;
    const scene = new Scene();
    scene.animationsEnabled = false; // editing scene: skinned models hold bind pose (no playback)
    scene.spawnRulesEnabled = false; // ...and a spawnOnStart=false node still shows while it is being authored
    // Shared with mesh tabs: editor camera, an __editor__ viewing light (hidden from the tree — it lights
    // the template, it is not part of it) and the cubemap background + reflections. Every node it adds
    // sits at the scene root, outside the template subtree, so Save Template never serializes any of it.
    void createAssetEditScene(scene, withoutDirty);

    let rootId: string;
    let name: string;
    if (templateId) {
      // The ref, not the render-scoped array: hydration runs from a boot effect whose closure predates the
      // library arriving, and resolving against [] there would read as "template deleted".
      const t = templatesRef.current.find(x => x.id === templateId);
      if (!t) {
        Logger.error(`Template not found (id ${templateId})`, 'Editor');
        dirtyArmedRef.current = wasArmed; // no tab opens, so nothing else would re-arm the one still showing
        return;
      }
      rootId = instantiateTemplate(t, scene.root, engineMaps(), materialsRef.current);
      // instantiateTemplate re-resolves __materialId but never __modelId, so refresh the clips from the
      // asset. Patched in place, not re-instantiated: a rebuild regenerates node ids, and instantiateTemplate
      // has just re-keyed template.scripts/bodies/triggers onto the ids it created.
      const templateRoot = scene.getNodeById(rootId);
      if (templateRoot) {
        withoutDirty(() => {
          const refreshed = refreshModelClips(templateRoot, modelsRef.current, animationsRef.current);
          if (refreshed) Logger.info(`Refreshed animation clips on ${refreshed} model${refreshed === 1 ? '' : 's'} in "${t.name}"`, 'Editor');
        });
      }
      name = t.name;
    } else {
      const node = new Node('New Template');
      scene.addNode(node);
      rootId = node.id;
      name = 'New Template';
    }
    scene.start();

    const tabId = adoptTabId ?? cryptoRandomId();
    // A variant tab remembers its base as it was on opening: saving diffs against THAT, so a base edit made
    // while the tab was open is not mistaken for this variant's own change. See saveVariant.
    const opened = templateId ? templatesRef.current.find(x => x.id === templateId) : undefined;
    const base = opened?.variant ? templatesRef.current.find(x => x.id === opened.variant!.baseTemplateId) : undefined;
    tabRuntimeRef.current.set(tabId, { scene, rootId, baseAtOpen: base ? cloneJson(base) : undefined });
    // the activate effect swaps the engine scene + dimension + selection
    commitTab({ id: tabId, kind: 'template', title: name, templateId: templateId ?? null }, adoptTabId);
  };

  /** A new variant of a template — inherits everything until edited — opened in its own tab. */
  const createTemplateVariant = (baseId: string) => {
    const base = templatesRef.current.find(t => t.id === baseId);
    if (!base) return;
    const taken = new Set(templatesRef.current.map(t => t.name));
    let name = `${base.name} Variant`;
    for (let i = 2; taken.has(name); i++) name = `${base.name} Variant ${i}`;
    const variant = createVariant(base, name, cryptoRandomId());
    setTemplates(prev => [...prev, variant]);
    templatesRef.current = [...templatesRef.current, variant];
    Logger.info(`Created "${name}", a variant of "${base.name}"`, 'Editor');
    enterTemplateEditor(variant.id);
  };

  const collectSubtreeIds = (node: Node, out: string[] = []): string[] => {
    out.push(node.id);
    node.children.forEach((c: Node) => collectSubtreeIds(c, out));
    return out;
  };

  // Rebuild every placed instance of a template after it was edited, preserving each instance's own
  // transform. Runs across every live scene except the editing tab's own — see liveScenes.
  const syncTemplateInstances = (templateId: string, template: Template, exceptTabId?: string) => {
    const maps = engineMaps();
    let count = 0;
    let reselectId: string | null = null;
    for (const scene of liveScenes(exceptTabId)) {
      const instances = Array.from(scene.nodes).filter(n => n.getVariable(TEMPLATE_ID_VAR) === templateId);
      for (const inst of instances) {
        const wasSelected = inst.id === selectedNode;
        // The shared rebuild: transform, spawn flag, variables, animation state and the placement's
        // overrides (its own name and script values) all survive, exactly as on a resync.
        const rebuilt = reinstantiate(scene, inst, maps,
          parent => instantiateTemplate(template, parent, maps, materialsRef.current)); // re-tags __templateId
        if (!rebuilt) continue;
        if (wasSelected) reselectId = rebuilt.id;
        count++;
      }
    }
    if (count) {
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
      if (reselectId) eventEmitter.current.emit('SELECT_NODE', reselectId);
    }
  };

  const revertTemplateOverride = (node: Node, field?: string, all?: boolean) => {
    const root = templateInstanceRootOf(node);
    const scene = root?.scene;
    const templateId = root?.getVariable(TEMPLATE_ID_VAR);
    const template = templateId ? templatesRef.current.find(t => t.id === templateId) : undefined;
    if (!root || !scene || !template) return;
    if (all) writeOverrides(root, {});
    else clearOverride(node, field);
    const wasSelected = selectedNode;
    // A rebuild is the one way back to the template's value: the instance does not keep it anywhere.
    const maps = engineMaps();
    const rebuilt = reinstantiate(scene, root, maps, parent => instantiateTemplate(template, parent, maps, materialsRef.current));
    if (!rebuilt) return;
    eventEmitter.current.emit('SCENE_CHANGED');
    // Ids are regenerated by the rebuild; keep the same node selected by its path.
    if (wasSelected && (wasSelected === root.id || collectSubtreeIds(root).includes(wasSelected))) {
      const path = pathOf(root, node);
      const again = path !== null ? nodeAtPath(rebuilt, path) : null;
      eventEmitter.current.emit('SELECT_NODE', (again ?? rebuilt).id);
    }
  };

  // Public mode switch — only the Main tab's sub-mode (scene/landscape/tilemap/ui/renderer/input).
  // Template/material/animation editing are tabs now (opened via enter*Editor), not modes, so they aren't
  // accepted here. The guard IS the MainMode narrowing, so a mode missing from it is silently unreachable.
  const setEditorMode = (mode: EditorMode) => {
    if (MAIN_MODES.includes(mode as MainMode)) setMainMode(mode as MainMode);
  };

  // Force skinned models to their bind (T) pose, so the editor shows the default pose: animators don't tick
  // while the scene is paused, and a model posed by a previous Play run would otherwise stay frozen.
  const showBindPoseForSkinnedModels = (scene: Scene) => {
    for (const node of scene.nodes) {
      if (node instanceof ModelNode && node.model instanceof AnimatedModel && node.animator) {
        node.animator.showBindPose();
      }
    }
  };

  // Open (or focus) the Animation Editor for a specific skinned ModelNode. Like the template/material
  // editors it opens a tab with its own throwaway scene: a CLONE of the source model (framed camera +
  // shadow light + ground). Authored state machines are written back to the original node on Apply.
  const enterStateMachineEditor = async (nodeId: string) => {
    const instance = instanceRef.current;
    if (!instance) return;

    // Focus an already-open animation tab for this node instead of duplicating it.
    const existing = tabs.find(t => t.kind === 'stateMachine' && t.stateMachineSourceId === nodeId);
    if (existing) { setActiveTab(existing.id); return; }

    // The source lives in whatever scene is currently active (main scene OR a template tab's scene).
    const sourceScene = activeScene;
    const sourceTabId = activeTabId;
    const source = sourceScene.getNodeById(nodeId);
    if (!(source instanceof ModelNode) || !(source.model instanceof AnimatedModel) || !source.model.hasSkin || !source.animator) {
      Logger.error('Animation Editor requires a skinned model', 'Editor');
      return;
    }

    // Clone the source node (with its skin, animations, mappings and state machine) into a fresh scene.
    const scene = new Scene();
    scene.animationsEnabled = false; // the AnimationPlayer drives the clone directly, not scene.update
    scene.spawnRulesEnabled = false; // ...and a spawnOnStart=false node still shows while it is being authored
    const json = await source.serialize();
    stripDebug(json);
    regenerateIds(json, new Map()); // distinct ids so the clone never collides with the original

    // Disarm before constructing the clone's scene — see openMaterialTab. After the await, not before it:
    // the source tab is still on screen while the serialize runs, and its edits must still count.
    const wasArmed = dirtyArmedRef.current;
    dirtyArmedRef.current = false;

    // Clone under a HOLDER carrying the source's accumulated world scale/rotation, not straight under
    // scene.root: a skinned import cannot bake its fit-to-size factor into vertices, so normalizeRootScale
    // puts that factor entirely on the holder ABOVE the ModelNode.
    // Editor-owned: this tab saves the state machine's working copy, never the preview, so nothing the clone
    // does is a user edit — and root-motion playback moves it every frame.
    const holder = markEditorOwned(new Node(`${source.name} (holder)`));
    scene.addNode(holder);
    const worldScale = source.parent ? source.parent.worldScale : [1, 1, 1];
    holder.setScale([worldScale[0], worldScale[1], worldScale[2]]);
    // Bracketed as well: the holder's flag covers only the holder's own attach. The parse attaches every
    // node before its parent, so the clone's bones and meshes emit while still detached, under their
    // users' own names.
    withoutDirty(() => parseByType(holder, json));
    const cloneRootId = json.id;
    const clone = scene.getNodeById(cloneRootId) as ModelNode | null;
    if (!clone) {
      Logger.error('Failed to clone model for the Animation Editor', 'Editor');
      dirtyArmedRef.current = wasArmed; // no tab opens, so nothing else would re-arm the one still showing
      return;
    }
    // `serialize` drops every clip its skeleton provides (they carry an `assetId`), so the clone arrives
    // with none: every clip picker would be empty and every state would read "(no clip)". Re-resolve them
    // from the library, exactly as a template or model tab does.
    withoutDirty(() => refreshModelClips(holder, modelsRef.current, animationsRef.current));

    // Frame the camera + build the shadow-catching ground around the clone's bounds.
    scene.root.updateTransforms();
    const bounds = combineBounds(clone);
    createAnimationEditorScene(scene, bounds.center, bounds.radius, { silently: withoutDirty });
    scene.start();
    clone.animator?.showBindPose(); // start from the rest pose

    const tabId = cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: cloneRootId, sourceScene, sourceNodeId: nodeId, sourceTabId });
    const sourceModelId = modelIdOf(source);
    const workspaceRigId = modelsRef.current.find(m => m.id === sourceModelId)?.rigId ?? null;
    setTabs(prev => [...prev, { id: tabId, kind: 'stateMachine', title: source.name, stateMachineSourceId: nodeId, workspaceRigId }]);
    setActiveTabId(tabId); // the activate effect swaps the engine scene + camera
  };

  // Persist an authored state machine from the animation tab's clone back to the ORIGINAL node in its
  // own scene (main or a template tab). For template sources, mark the template tab dirty so the user
  // saves it (Save Template serializes the node's stateMachine and propagates it to instances).
  const commitAnimationStateMachine = (sm: any) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    if (!rt?.sourceScene || !rt.sourceNodeId) return;
    const src = rt.sourceScene.getNodeById(rt.sourceNodeId);
    if (src instanceof ModelNode && src.animator) {
      src.animator.setStateMachine(sm);
      src.animator.showBindPose(); // its scene is paused; keep the source at its rest pose
    }
    // The edit landed on the source node, so its owner has unsaved changes — the scene tab when the model
    // lives in the open scene, the template tab when it came from a template.
    if (rt.sourceTabId) markTabDirty(rt.sourceTabId, 'anim-state-machine');
  };

  // ---- Clips and skeleton belong to the MODEL ASSET --------------------------------------------------
  //
  // The node the Animation Editor was opened from is a COPY carrying a `__modelId` back-link, and that link
  // decides where a clip edit lands. So every clip/skeleton action ends the same way: patch the ASSET, then
  // patch every live instance.

  /**
   * Apply a clip/skeleton change to every live instance of a model asset, in place — NOT syncModelInstances,
   * which re-instantiates and churns node ids. `except` skips a node the caller has already updated; the
   * active tab's scene is skipped wholesale, or the clip lands on its preview clone twice as "name (2)".
   */
  const propagateModelClips = (modelId: string, apply: (m: AnimatedModel) => void, except?: Node | null) => {
    let count = 0;
    for (const scene of liveScenes(activeTabId)) {
      for (const node of Array.from(scene.nodes)) {
        if (node === except) continue;
        if (!(node instanceof ModelNode) || !(node.model instanceof AnimatedModel)) continue;
        if (modelIdOf(node) !== modelId) continue;
        apply(node.model);
        count++;
      }
    }
    return count;
  };

  /**
   * The model asset an Animation Editor session is editing through, or null when the source node is not a
   * placed instance of one. Null means "keep the edit local to that node".
   */
  const animationSourceAsset = (src: Node | null | undefined): { id: string; asset: ModelAsset } | null => {
    const id = modelIdOf(src);
    if (!id) return null;
    const asset = modelsRef.current.find(m => m.id === id);
    return asset ? { id, asset } : null;
  };

  /**
   * Re-resolve a model asset's SHARED clips (its skeleton's `animationIds`) onto everything showing that model — the
   * `.anim` counterpart of propagateModelClips, and idempotent. `except` skips a node the caller has already
   * updated; `extra` passes an animation asset not yet in `animationsRef` (a brand-new import).
   */
  const applyAnimationLinks = (modelAsset: ModelAsset, except?: Node | null, extra?: AnimationAsset) => {
    const library = extra ? [...animationsRef.current.filter(a => a.id !== extra.id), extra] : animationsRef.current;
    let count = 0;
    for (const scene of liveScenes()) {
      for (const node of Array.from(scene.nodes)) {
        if (node === except) continue;
        if (modelIdOf(node) !== modelAsset.id) continue;
        count += applyModelAnimations(node, modelAsset, library);
      }
    }
    // Asset-edit tabs (the model preview, the Animation Editor's clone) are shown FROM the asset and carry
    // no back-link of their own. Safe unconditionally: applyModelAnimations is idempotent.
    const rt = tabRuntimeRef.current.get(activeTabIdRef.current);
    const shown = rt?.rootId ? rt.scene.getNodeById(rt.rootId) : null;
    if (shown && shown !== except && resolveModelAssetId(null) === modelAsset.id)
      count += applyModelAnimations(shown, modelAsset, library);
    return count;
  };

  /** Link an existing `.anim` asset to a model, so every placement of that model plays its clips. */
  /**
   * Re-resolve every model built on `rigId`, after its clip list changed.
   *
   * The rig owns the clips, so ONE link fans out to every character on that armature — which is the whole
   * point of the rig owning them, and also why this cannot just patch the model that happened to be open.
   */
  const applyRigLinks = (rigId: string) => {
    for (const model of modelsRef.current) {
      if (model.rigId === rigId) applyAnimationLinks(model);
    }
  };

  /**
   * The rig a model uses, minting one from its skeleton if it has none.
   *
   * The bridge for every "link a clip to this character" path: those start from a MODEL (a selected node,
   * an open model tab) while clips now hang off a RIG. A model imported before rigs existed, or adopted
   * from a raw node, has no `rigId` until something asks for one.
   */
  const ensureRigForModel = (modelId: string): string | null => {
    const model = modelsRef.current.find(m => m.id === modelId);
    if (!model) return null;
    if (model.rigId && rigsRef.current.some(r => r.id === model.rigId)) return model.rigId;

    const skin = storeSkin(skinnedModelJsonsOf(model.nodeJson)[0]?.skin);
    const rig = ensureRig(skin, model.name);
    if (!rig) { Logger.warn(`"${model.name}" has no skeleton, so it cannot have a rig`, 'Editor'); return null; }
    const linked = { ...model, rigId: rig.id };
    // Mirror eagerly: callers await this and immediately link a clip to the returned id, and `modelsRef`
    // is a render mirror (the trap `adoptModelAsset` hit).
    modelsRef.current = modelsRef.current.map(m => (m.id === modelId ? linked : m));
    updateModel(modelId, linked);
    // Gaining a rig changes which clips this model resolves, for the same reasons setModelRig documents.
    invalidateAnimationCache();
    applyAnimationLinks(linked);
    return rig.id;
  };

  /**
   * Point a model at a different rig (or at none), and make every consequence of that actually happen.
   *
   * A bare `updateModel` is not enough, and the two ways it falls short are both silent:
   *
   *  - **The retarget cache does not key on the rig.** `resolveAnimationAsset` keys on
   *    `${animationId}:${modelAssetId}`; `targetRigId` is passed but only used to look up the rig's manual
   *    bone corrections. So a swap on the same model returns clips built with the OLD rig's `retargets`
   *    and ignores the new rig's, until something unrelated clears the cache. Cleared wholesale here —
   *    a rig swap is a rare, deliberate act, and a partial clear cannot express "every asset, this model".
   *  - **Nothing re-applies the clips.** The clip set belongs to the rig, so a swap changes which clips
   *    every placement should be playing; without this they keep the previous rig's until something
   *    re-instantiates them.
   *
   * `modelsRef` is mirrored eagerly because it is a render mirror and `applyAnimationLinks` reads it —
   * the same trap `ensureRigForModel` documents.
   */
  /**
   * Hand the rig's animation controller to every character showing `modelId` that has NO state machine
   * (or `onlyRoot`, just that one). A character's machine is embedded in its model node, so replacing the
   * node — delete the model, drag another in, link the same rig — left it with none: no idle, no
   * locomotion, a bind pose wherever it went, while one-shot actions still played. Returns how many
   * characters got one.
   */
  const adoptRigController = (modelId: string, onlyRoot?: Node | null): number => {
    const model = modelsRef.current.find(m => m.id === modelId);
    if (!model?.rigId) return 0;
    const usage = new Map<string, number>();
    const bare: ModelNode[] = [];
    for (const scene of liveScenes()) {
      for (const node of Array.from(scene.nodes)) {
        const sm = (node as any).animator?.getStateMachine?.();
        if (sm?.controllerId) usage.set(sm.controllerId, (usage.get(sm.controllerId) ?? 0) + 1);
        if (modelIdOf(node) !== modelId || (onlyRoot && node !== onlyRoot)) continue;
        const skinned = firstSkinnedModelNode(node);
        if (skinned?.animator && machineIsEmpty(skinned.animator.getStateMachine()) && !bare.includes(skinned)) bare.push(skinned);
      }
    }
    if (!bare.length) return 0;
    const controller = pickControllerForRig(model.rigId, animControllersRef.current, usage);
    if (!controller) {
      Logger.warn(`"${model.name}" has no animation controller, so it will hold its bind pose. Assign one in its Animation section.`, 'Editor');
      return 0;
    }
    for (const skinned of bare) skinned.animator!.setStateMachine(instantiateController(controller, machineLibs()));
    Logger.info(`"${model.name}" had no animation controller; it now uses "${controller.name}", the controller for its rig.`, 'Editor');
    return bare.length;
  };

  const setModelRig = (modelId: string, rigId: string | undefined) => {
    const model = modelsRef.current.find(m => m.id === modelId);
    if (!model || model.rigId === rigId) return;

    // Which rig is this model's OWN skeleton: kept in `nativeRigId` while it plays another, so its bone
    // corrections, sockets and IK (all named for its own bones) are still found. The current rig is the
    // native one when the model has no `nativeRigId` yet and the rig is its skeleton's shape.
    const native = model.nativeRigId
      ?? (model.rigId && rigsRef.current.find(r => r.id === model.rigId)?.id === findEquivalentRig(rigsRef.current, storeSkin(skinnedModelJsonsOf(model.nodeJson)[0]?.skin))?.id
        ? model.rigId : undefined);
    const nativeRigId = rigId && native && rigId !== native ? native : undefined;
    const updated: ModelAsset = { ...model, rigId: rigId ?? native, nativeRigId };
    if (!rigId) { updated.rigId = undefined; updated.nativeRigId = undefined; }
    modelsRef.current = modelsRef.current.map(m => (m.id === modelId ? updated : m));
    updateModel(modelId, updated);
    invalidateAnimationCache();
    applyAnimationLinks(updated);
    // Sockets, ragdoll and IK name THIS skeleton's bones: always from the model's own rig, never from a
    // foreign one whose joint indices and names mean nothing on it.
    const rig = rigsRef.current.find(r => r.id === (updated.nativeRigId ?? updated.rigId));
    syncRigSockets(rig ?? { id: '', sockets: [] } as any, [modelId]);
    adoptRigController(modelId);
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
  };

  /**
   * Embed a rig's sockets into every model built on it, and push them onto everything showing those
   * models. The rig is where sockets are AUTHORED; the model's skin is what the runtime reads, and what
   * carries them into templates, bundles and the published game. Stored-scene copies are reached later by
   * `resyncScene`, the same way the IK rig is. `onlyModels` limits it to a model whose link just changed.
   */
  const syncRigSockets = (rig: RigAsset, onlyModels?: string[]) => {
    const sockets = runtimeSockets(rig.sockets);
    const targets = onlyModels
      ? modelsRef.current.filter(m => onlyModels.includes(m.id))
      : modelsRef.current.filter(m => (m.nativeRigId ?? m.rigId) === rig.id);
    // The ragdoll profile rides along the same way: authored on the rig, read from the skin.
    const ragdoll = rig.ragdoll?.parts?.length ? rig.ragdoll : null;
    // So does foot placement, once the rig carries it (`null` = deliberately off). A rig that has never had
    // it set leaves each model's own copy alone.
    const hasIk = rig.ikRig !== undefined;
    const ikRig = rig.ikRig ?? null;
    for (const model of targets) {
      let updated = assetWithRagdollProfile(assetWithSockets(model, sockets), ragdoll);
      if (hasIk) updated = assetWithIkRig(updated, ikRig);
      if (updated !== model) {
        modelsRef.current = modelsRef.current.map(m => (m.id === model.id ? updated : m));
        updateModel(model.id, updated);
      }
      // Fresh arrays per skin: the runtime caches socket resolution on the array's identity.
      propagateModelClips(model.id, m => {
        if (!m.skin) return;
        m.skin.sockets = sockets.length ? sockets.map(s => ({ ...s })) : undefined;
        m.skin.ragdollProfile = ragdoll ? JSON.parse(JSON.stringify(ragdoll)) : undefined;
        if (hasIk) m.skin.ikRig = ikRig ? JSON.parse(JSON.stringify(ikRig)) : undefined;
      });
    }
  };

  /** Link a shared `.anim` to a RIG. Every model on that rig gains its clips. */
  const linkAnimationToRig = (rigId: string, animationId: string) => {
    const rig = rigsRef.current.find(r => r.id === rigId);
    const anim = animationsRef.current.find(a => a.id === animationId);
    // Logged, not silent: the model equivalent used to return here whenever the model had just been
    // adopted, and a drag that did nothing at all left no way to tell why.
    if (!rig) { Logger.warn(`Cannot link an animation: rig ${rigId} is not in the library`, 'Editor'); return; }
    if (!anim) { Logger.warn(`Cannot link animation ${animationId}: it is not in the library`, 'Editor'); return; }
    const linked = withAnimationRef(rig, animationId);
    if (linked === rig) return; // already linked
    updateRig(rigId, linked);
    invalidateAnimationCache(animationId);
    applyRigLinks(rigId);
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    Logger.info(`Linked "${anim.name}" to rig "${rig.name}"`, 'Editor');
  };

  /** Drop a `.anim` link. Its clips disappear from every placement — applyModelAnimations removes them. */
  const unlinkAnimationFromRig = (rigId: string, animationId: string) => {
    const rig = rigsRef.current.find(r => r.id === rigId);
    if (!rig) return;
    const unlinked = withoutAnimationRef(rig, animationId);
    if (unlinked === rig) return;
    updateRig(rigId, unlinked);
    invalidateAnimationCache(animationId);
    applyRigLinks(rigId);
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    Logger.info(`Unlinked "${animationsRef.current.find(a => a.id === animationId)?.name ?? animationId}" from rig "${rig.name}"`, 'Editor');
  };

  /**
   * Edit one clip inside a shared `.anim` asset (its name or its root-motion flag). Must write the LIBRARY
   * asset: clips resolved from an asset carry `assetId` and AnimatedModel.serialize drops those, so the
   * embedded-clip helpers patch a list the clip does not live in.
   */
  const editSharedClip = (animationId: string, clipName: string, patch: { name?: string; rootMotion?: boolean }) => {
    const anim = animationsRef.current.find(a => a.id === animationId);
    if (!anim) return;
    const clips = anim.clips.map(c => (c.name === clipName ? { ...c, ...patch } : c));
    if (clips.every((c, i) => c === anim.clips[i])) return;
    const updated: AnimationAsset = { ...anim, clips };
    updateAnimation(animationId, updated);
    invalidateAnimationCache(animationId);
    // `updated` is handed through explicitly: updateAnimation is a state write, so animationsRef still
    // holds the PREVIOUS clips during this call and re-resolving from it would put the old name back.
    for (const model of modelsRef.current) {
      // The rig owns the link now, so ask the model's rig rather than the model.
      if (modelAnimationIds(model).includes(animationId)) applyAnimationLinks(model, null, updated);
    }
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
  };

  // Import animation clips into the model being edited in the Animation Editor: parse, build a bone
  // MAPPING onto the model's skeleton, review it in the modal, then store the accepted clips as a shared
  // asset and show them on the preview clone, the source node, the model asset and every placement.
  //
  // ONE IMPORT PER FILE, via the same splitter the model importer uses. This is not a nicety: assimp's
  // `ConvertFileList` treats the first file as the scene and every file after it as a sidecar to resolve
  // references against, so handing it four independent .fbx converts the FIRST and silently discards the
  // other three. Selecting a character's idle, walk, dying and running therefore used to import one clip,
  // with no warning that three files had been dropped. `groupImportFiles` gives one bundle per model file,
  // each still carrying the .bin/textures that belong to it — and each with its own name, which is what
  // the review modal renames a placeholder clip after (see clipNaming.ts).
  const importAnimationFiles = async (files: File[], opts?: { modelId?: string }) => {
    const bundles = groupImportFiles(files);
    if (bundles.length === 0) {
      Logger.warn('No animation files (.gltf/.glb/.fbx) found in the selection', 'Editor');
      return;
    }

    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = stateMachineTargetId ? activeScene.getNodeById(stateMachineTargetId) : null;
    const cloneModel = (cloneNode instanceof ModelNode && cloneNode.model instanceof AnimatedModel && cloneNode.model.skin)
      ? cloneNode.model : null;

    // Which rig to retarget onto: the Animation Editor's open character when there is one, otherwise the
    // user picks from the skinned models in the library. Asked ONCE for the whole selection — every file
    // in one action is going onto the same character, and four identical dialogs would be a tax.
    // NOTE the naming: these are MODEL asset ids. `rigId` now means a `.rig` asset (utils/rigAssets.ts),
    // and the two must never be confused — which is why these locals say `targetModel`.
    const skinnedModels = modelsRef.current.filter(m => modelAssetIsSkinned(m));
    const openTargetModelId = cloneNode ? modelIdOf(cloneNode) : undefined;
    // A caller that already knows the character (the Animate wizard) skips the picker.
    let targetModelId = openTargetModelId ?? opts?.modelId;
    if (!targetModelId) {
      if (!skinnedModels.length) {
        Logger.error('Import a skinned model first — an animation needs a rig to retarget onto', 'Editor');
        return;
      }
      targetModelId = await new Promise<string | null>(resolve => {
        pendingRigResolverRef.current = resolve;
        setPendingRigPick({
          fileName: bundles.length === 1 ? bundles[0].name : `${bundles.length} animation files`,
          models: skinnedModels.map(m => ({ id: m.id, name: m.name })),
        });
      }) ?? undefined;
      if (!targetModelId) { Logger.info('Animation import cancelled', 'Editor'); return; }
    }
    const targetModel = modelsRef.current.find(m => m.id === targetModelId);
    const targetSkin = cloneModel?.skin ?? modelAssetSkin(targetModel);
    if (!targetModel || !targetSkin) {
      Logger.error('That model has no skeleton to retarget onto', 'Editor');
      return;
    }

    // One step per file, so a four-file import reports four outcomes rather than one.
    const task = startTask({
      title: bundles.length === 1 ? 'Importing animation' : `Importing ${bundles.length} animations`,
      steps: bundles.map(b => ({ name: b.name, status: 'pending' as StepStatus, detail: 'Queued' })),
      cancellable: true,
      // Two things to unblock: a parse running in the worker, and a flow parked on the review modal.
      onCancel: () => {
        cancelAllImports();
        if (pendingAnimResolverRef.current) resolveAnimationImport(null);
      },
    });
    const setStage = (index: number, stage: AnimImportStage, detail?: string, error?: string) => {
      const s = ANIM_IMPORT_STAGES[stage];
      task.setStep(index, {
        status: s.status,
        progress: s.progress,
        detail: detail ?? (s.status === 'running' || s.status === 'paused' ? s.label : undefined),
        error,
      });
    };

    // The SKELETON owns clip links: every character on it plays them. Minted here for a model that has
    // none yet, so an import never has to fall back to a per-model link.
    const targetRigId = ensureRigForModel(targetModel.id);
    if (!targetRigId) { task.finish(); return; }

    try {
      let imported = 0;

      for (let i = 0; i < bundles.length; i++) {
        const bundle = bundles[i];
        const fileName = bundle.files.find(f => /\.(gltf|glb|fbx)$/i.test(f.name))?.name ?? bundle.files[0]?.name ?? bundle.name;

        // Checked between files: a parse is one long JS task and cannot be interrupted mid-flight, so
        // "Cancel" honestly means "stop after the current file".
        if (task.cancelled) { setStage(i, 'skipped', 'Cancelled before it started'); continue; }

        // Parsed in the import worker: for an .fbx this is an uninterruptible assimp WASM call.
        let parsed: { animations: any[]; skin: any };
        setStage(i, 'parsing', `Reading ${fileName}`);
        try { parsed = await parseAnimationFiles(bundle.files, (_fraction, stage) => setStage(i, 'parsing', stage || undefined)); }
        catch (e) {
          if (e instanceof ImportCancelled || task.cancelled) {
            setStage(i, 'skipped', 'Cancelled');
            Logger.info('Animation import cancelled', 'Editor'); continue;
          }
          setStage(i, 'failed', undefined, String(e));
          Logger.error(`Failed to parse ${fileName}: ${e}`, 'Editor'); continue;
        }
        if (!parsed.animations.length) {
          setStage(i, 'failed', 'No animation clips in the file');
          Logger.warn(`No animation clips found in ${fileName}`, 'Editor'); continue;
        }
        if (!parsed.skin) {
          setStage(i, 'failed', 'No skeleton to match against');
          Logger.warn(`${fileName} has no skeleton to match against`, 'Editor'); continue;
        }
        const sourceSkin = parsed.skin;

        // ONE mapping for the whole file — every clip in it shares the source skeleton, so matching is done
        // once and each clip's report is derived cheaply from it (and re-derived as the user edits rows in
        // the modal).
        const mapping = buildBoneMapping(parsed.animations, sourceSkin, targetSkin);

        // Diagnostic (scope 'Retarget'): one structured snapshot per import. Includes each key bone's bind
        // rotation from both the inverse bind matrix and the node transforms — their disagreement is the
        // tell-tale for an animated glTF whose node transforms are its frame-0 pose, not its bind pose.
        try { Logger.print('debug', [describeRetarget(parsed.animations, sourceSkin, targetSkin, mapping)], 'Retarget'); }
        catch (e) { Logger.warn('Retarget diagnostics failed: ' + e, 'Retarget'); }

        // Bone lists for the mapping table: the source bones the clips actually animate (mapping order), and
        // every target joint for the dropdowns.
        const nameOf = (skin: any, node: number): string => skin.nodeNames?.get(node) ?? `node ${node}`;
        const sourceBones = mapping.entries.map(e => ({ node: e.sourceNode, name: e.sourceName ?? `node ${e.sourceNode}` }));
        const targetBones = targetSkin.joints.map((j: any) => ({ node: j.nodeIndex, name: nameOf(targetSkin, j.nodeIndex) }));

        setStage(i, 'review', `${parsed.animations.length} clip${parsed.animations.length === 1 ? '' : 's'} — awaiting review`);
        const decision = await new Promise<AnimationImportDecision | null>(resolve => {
          pendingAnimResolverRef.current = resolve;
          setPendingAnimationImport({
            fileName,
            clips: parsed.animations.map(clip => ({
              name: clip.name,
              report: mappingReport(clip, sourceSkin, targetSkin, mapping),
              animatedNodes: [...new Set(clip.channels.map((ch: any) => ch.targetNodeIndex))] as number[],
            })),
            mapping, sourceBones, targetBones, sourceSkin, targetSkin, targetName: targetModel.name,
          });
        });
        if (!decision) {
          setStage(i, 'skipped', 'Cancelled at review');
          Logger.info(`Import of ${fileName} cancelled`, 'Editor'); continue;
        }
        // `decision.mapping` carries the user's re-points. Clips are stored in source-rig space and
        // `resolveAnimationAsset` rebuilds the automatic mapping on every retarget, so the re-points are
        // saved below as overrides on the TARGET skeleton, keyed by the source skeleton, and replayed.

        // The clips are stored in the file's OWN rig space, exactly as parsed — no retarget is baked in. That
        // is what lets one stored walk serve every character sharing the rig, and it is why the source skin is
        // stored beside them: `buildBoneMapping` needs both sides, at every later use.
        setStage(i, 'retargeting', 'Storing clips');
        const kept = parsed.animations.filter((_: any, n: number) => decision.include[n]);
        if (!kept.length) {
          setStage(i, 'skipped', 'Nothing selected');
          Logger.info(`No animation clips selected from ${fileName}`, 'Editor'); continue;
        }
        // The modal seeds each box with `clipNameFromFile`, so a placeholder name arrives here already
        // replaced by the file's; this only applies whatever the user left in the box.
        const namedClips = kept.map((clip: any) => {
          const n = parsed.animations.indexOf(clip);
          const typed = (decision.names?.[n] ?? '').trim();
          return typed && typed !== clip.name ? { ...clip, name: typed } : clip;
        });

        // A second import of the same file should link the existing asset, not make a byte-identical twin —
        // matched on clip CONTENT, since the same Mixamo download is routinely renamed between imports.
        const existing = findEquivalentAnimation(animationsRef.current, namedClips as any);
        // Give the source skeleton an identity at IMPORT, not only in the migration. The v1->v2 lesson is
        // written into the comment above: a one-shot pass while the importer keeps producing the old shape
        // just means another migration a release later.
        // Only when a NEW asset is actually stored: re-importing a file whose clips are already in the
        // library must not leave a freshly-minted rig behind that nothing references.
        const animAsset = existing ?? {
          ...buildAnimationAsset(
            namedClips[0]?.name || fileName.replace(/\.[^.]+$/, ''),
            namedClips as any, storeSkin(sourceSkin), fileName,
          ),
          rigId: ensureRig(storeSkin(sourceSkin), animationTargetName(fileName))?.id,
        };
        if (existing) Logger.info(`"${existing.name}" already holds these clips — linked it instead of storing a copy`, 'Editor');
        else {
          // Mirrored eagerly: linkAnimationToRig looks the asset up in the ref, which is a render mirror.
          animationsRef.current = [...animationsRef.current, animAsset];
          addAnimation(animAsset);
        }

        setStage(i, 'saving', 'Linking to the skeleton');
        // Save the reviewed re-points before linking, so the first resolve already honours them.
        if (animAsset.rigId) {
          const overrides = overridesFromMapping(mapping, decision.mapping, targetSkin.nodeNames);
          // Onto the model's OWN skeleton's rig — the bones they name are its bones, also while it plays
          // another skeleton's clips (see ModelAsset.nativeRigId).
          const correctionRigId = targetModel.nativeRigId ?? targetRigId;
          const targetRig = rigsRef.current.find(r => r.id === correctionRigId);
          if (overrides.length && targetRig) updateRig(correctionRigId, withOverrides(targetRig, animAsset.rigId, overrides));
        }
        // The link lives on the SKELETON, so every character built on it picks the clips up — this re-resolves
        // every placement, the node the editor was opened from included.
        linkAnimationToRig(targetRigId, animAsset.id);
        invalidateAnimationCache(animAsset.id);

        // The Animation Editor's preview clone carries no model link of its own; give it the clips directly
        // unless the re-resolve above already reached it.
        if (cloneModel && !cloneModel.animations.some(a => a.assetId === animAsset.id)) {
          for (const clip of resolveAnimationAsset(animAsset, targetSkin, targetModel.id, targetModel.nativeRigId ?? targetRigId)) cloneModel.addAnimation({ ...clip });
        }

        const added = namedClips.length;
        imported += added;
        Logger.info(`Imported ${added} animation clip${added === 1 ? '' : 's'} from ${fileName} into "${targetModel.name}"`, 'Editor');
        setStage(i, 'done', `Imported ${added} clip${added === 1 ? '' : 's'}`);
      }

      if (imported > 0) {
        if (rt?.sourceTabId) markTabDirty(rt.sourceTabId, 'animation-import');
        eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
      }
    } finally { task.finish(); }
  };

  // Backfill bone names onto a skinned model whose skeleton has none, so imported animations can match by
  // name instead of by node index. The user loads the SAME file the character came from; its bone names are
  // copied onto the model's skin joints by node index, which is identical for the same file.
  const importSkeletonNames = async (files: File[]) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = stateMachineTargetId ? activeScene.getNodeById(stateMachineTargetId) : null;
    if (!(cloneNode instanceof ModelNode) || !(cloneNode.model instanceof AnimatedModel) || !cloneNode.model.skin) {
      Logger.error('Open the Animation Editor for a skinned model first', 'Editor');
      return;
    }
    let parsed: { animations: any[]; skin: any };
    try { parsed = await parseAnimationFiles(files); }
    catch (e) {
      if (e instanceof ImportCancelled) { Logger.info('Skeleton import cancelled', 'Editor'); return; }
      Logger.error('Failed to parse file: ' + e, 'Editor'); return;
    }
    const srcNames: Map<number, string> | undefined = parsed.skin?.nodeNames;
    if (!srcNames || srcNames.size === 0) { Logger.warn('No bone names found in that file', 'Editor'); return; }

    const applyTo = (skin: any): number => {
      if (!skin) return 0;
      const names: Map<number, string> = skin.nodeNames ?? new Map<number, string>();
      let matched = 0;
      for (const j of skin.joints) {
        const n = srcNames.get(j.nodeIndex);
        if (n) { names.set(j.nodeIndex, n); matched++; }
      }
      skin.nodeNames = names;
      return matched;
    };

    const matched = applyTo(cloneNode.model.skin);
    const src = rt?.sourceScene && rt.sourceNodeId ? rt.sourceScene.getNodeById(rt.sourceNodeId) : null;
    if (src instanceof ModelNode && src.model instanceof AnimatedModel) applyTo(src.model.skin);

    if (matched === 0) {
      Logger.warn('No matching bones — load the SAME file this character was imported from (same format/export)', 'Editor');
      return;
    }

    // Bone names are skeleton data, so they belong to the asset — otherwise the backfill would have to be
    // repeated for every placement.
    const link = animationSourceAsset(src);
    if (link) {
      updateModel(link.id, assetWithBoneNames(link.asset, srcNames));
      propagateModelClips(link.id, m => { if (m.skin) applyTo(m.skin); }, src);
    }

    if (rt?.sourceTabId) markTabDirty(rt.sourceTabId, 'animation-skeleton');
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    Logger.info(`Added bone names to ${matched} joints — animation import now matches by name. Save the project to keep them.`, 'Editor');
  };

  /**
   * Persist foot placement for the skeleton being edited. Its fields are joint indices into the SKELETON,
   * so it is stored on the `.rig` and embedded from there into every model on it (`syncRigSockets`), like
   * sockets and the ragdoll. Order matters: preview clone first (so the viewport updates this frame), then
   * the source node, then the rig, which fans out to the assets and live instances.
   */
  const commitIkRig = (rig: any | null) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    // `skeletonTargetId`, not `stateMachineTargetId`: the IK panel sits under the bone tree, which the RIG
    // tab shows too. Keyed on the animation target it wrote nowhere at all from a rig tab.
    const cloneNode = skeletonTargetId ? activeScene.getNodeById(skeletonTargetId) : null;
    const applyTo = (n: Node | null | undefined) => {
      if (n instanceof ModelNode && n.model instanceof AnimatedModel && n.model.skin) {
        n.model.skin.ikRig = rig ?? undefined;
      }
    };
    applyTo(cloneNode);

    const src = rt?.sourceScene && rt.sourceNodeId ? rt.sourceScene.getNodeById(rt.sourceNodeId) : null;
    applyTo(src);

    const link = animationSourceAsset(src);
    // A Skeleton tab names its rig directly; a character's tab reaches it through the model asset.
    const rigTab = tabsRef.current.find(t => t.id === activeTabId && t.kind === 'rig');
    // The model's OWN skeleton's rig: IK names joints of this skeleton, also while it plays another's clips.
    const rigId = (rigTab as { rigId?: string } | undefined)?.rigId
      ?? link?.asset.nativeRigId ?? link?.asset.rigId ?? (link ? ensureRigForModel(link.id) : null);
    const owner = rigId ? rigsRef.current.find(r => r.id === rigId) : undefined;
    if (owner) updateRig(owner.id, { ...owner, ikRig: rig ?? null });
    else if (link) {
      updateModel(link.id, assetWithIkRig(link.asset, rig));
      propagateModelClips(link.id, m => { if (m.skin) m.skin.ikRig = rig ?? undefined; }, src);
    }

    // No asset link means a hand-built skinned node: the edit stays local to it.
    if (rt?.sourceTabId) markTabDirty(rt.sourceTabId, 'animation-ik-rig');
    eventEmitter.current.emit('ANIM_IK_CHANGED');
  };

  /** The IK rig currently on the Animation Editor's model, or null. */
  const currentIkRig = (): any | null => {
    const cloneNode = skeletonTargetId ? activeScene.getNodeById(skeletonTargetId) : null;
    if (cloneNode instanceof ModelNode && cloneNode.model instanceof AnimatedModel) {
      return cloneNode.model.skin?.ikRig ?? null;
    }
    return null;
  };

  // Rename an animation clip on the Animation Editor's model (preview clone + source node so it persists).
  // Returns the final applied name (may be de-duped). Callers update state-machine references to it.
  const renameAnimationClip = (oldName: string, newName: string): string => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = stateMachineTargetId ? activeScene.getNodeById(stateMachineTargetId) : null;
    if (!(cloneNode instanceof ModelNode) || !(cloneNode.model instanceof AnimatedModel)) return oldName;
    const finalName = cloneNode.model.renameAnimation(oldName, newName) ?? oldName;
    const src = rt?.sourceScene && rt.sourceNodeId ? rt.sourceScene.getNodeById(rt.sourceNodeId) : null;
    if (src instanceof ModelNode && src.model instanceof AnimatedModel) src.model.renameAnimation(oldName, finalName);

    // Propagate the name the CLONE settled on, not what the user typed: renameAnimation de-dupes against the
    // clips already there, and re-running that per instance could land on a different suffix each time.
    const link = animationSourceAsset(src);
    if (link) {
      updateModel(link.id, assetWithClipRenamed(link.asset, oldName, finalName));
      propagateModelClips(link.id, m => { m.renameAnimation(oldName, finalName); }, src);
    }

    if (rt?.sourceTabId) markTabDirty(rt.sourceTabId, 'animation-rename-clip');
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    return finalName;
  };

  // Delete an animation clip from the model (preview clone + source node).
  const removeAnimationClip = (name: string) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = stateMachineTargetId ? activeScene.getNodeById(stateMachineTargetId) : null;
    if (cloneNode instanceof ModelNode && cloneNode.model instanceof AnimatedModel) cloneNode.model.removeAnimation(name);
    const src = rt?.sourceScene && rt.sourceNodeId ? rt.sourceScene.getNodeById(rt.sourceNodeId) : null;
    if (src instanceof ModelNode && src.model instanceof AnimatedModel) src.model.removeAnimation(name);

    const link = animationSourceAsset(src);
    if (link) {
      updateModel(link.id, assetWithClipRemoved(link.asset, name));
      propagateModelClips(link.id, m => { m.removeAnimation(name); }, src);
    }

    if (rt?.sourceTabId) markTabDirty(rt.sourceTabId, 'animation-remove-clip');
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
  };


  /**
   * Rebuild a restored tab's edit session, if it hasn't been built yet. Returns false when it can't be.
   * Every builder reached from here is SYNCHRONOUS and has written `tabRuntimeRef` by the time it returns,
   * which is what lets `setActiveTab` hydrate before committing the active tab.
   */
  const hydrateTab = (tab: EditorTab): boolean => {
    if (!pendingHydrationRef.current.has(tab.id)) return true;
    pendingHydrationRef.current.delete(tab.id);
    const assetId = assetIdOfTab(tab) ?? undefined;
    switch (tab.kind) {
      case 'template': enterTemplateEditor(assetId, tab.id); break;
      case 'material': enterMaterialEditor(assetId, tab.id); break;
      case 'terrainMaterial': enterTerrainMaterialEditor(assetId, tab.id); break;
      case 'model': enterModelEditor(assetId, tab.id); break;
      case 'animationField': enterAnimationFieldEditor(assetId, tab.id); break;
      case 'rig': enterRigEditor(assetId, tab.id); break;
      case 'animation': enterClipEditor(assetId, tab.id); break;
      case 'stateMachine': if (assetId) openAnimController(assetId, tab.id); break;
      case 'script': enterScriptEditor(assetId, tab.id); break;
      case 'particleSystem': if (assetId) enterParticleSystemEditor(assetId, tab.id); break;
      // A tileset tab is a pure 2D editor over the library record — nothing to build, so it is live already.
      case 'tileset': return !!tab.tilesetId && tilesetsRef.current.some(t => t.id === tab.tilesetId);
      case 'aiBrain': return !!tab.aiBrainId && aiBrainsRef.current.some(b => b.id === tab.aiBrainId);
      // Same for a texture tab: a 2D viewer over the record, with no scene behind it.
      case 'texture': return !!tab.textureId && texturesRef.current.some(t => t.id === tab.textureId);
      // And for a sound tab: a waveform and a settings panel over the record.
      case 'soundSample': return !!tab.soundId && soundSamplesRef.current.some(x => x.id === tab.soundId);
      default: return true;
    }
    // A script tab is a pure code editor and never gets a runtime entry, so it can only be judged by whether
    // its source buffer was seeded. Everything else must have produced a scene.
    return tab.kind === 'script'
      ? !!tab.scriptId && scriptTabSourceRef.current.has(tab.scriptId)
      : tabRuntimeRef.current.has(tab.id);
  };

  /**
   * Switch tabs, building the target's edit session first if it was restored from a previous session.
   * Hydrating BEFORE `setActiveTabId` is load-bearing: `activeScene` falls back to the open scene whenever
   * the active tab has no runtime. Never commit `activeTabId` to a tab without a runtime.
   */
  const setActiveTab = (id: string) => {
    const tab = tabsRef.current.find(t => t.id === id);
    if (tab && !hydrateTab(tab)) {
      Logger.error(`"${tab.title}" could not be reopened — the asset it edits is gone`, 'Editor');
      removeTabById(id);
      return;
    }
    setActiveTabId(id);
  };

  /**
   * Rebuild a tab from the SAVED assets, discarding whatever working copy it holds.
   *
   * The escape hatch behind the stale-dependency banner. The session contexts deliberately refuse to
   * re-seed on every library change — guarded on asset id, so a save cannot clobber an edit in progress —
   * which is right, but left no way to say "yes, take the new version". This is that way, and it is
   * user-initiated, which is the whole difference.
   *
   * The scene tab resyncs in place; every other stale-able kind (model, template, terrain material,
   * animation field) rebuilds through its own `enter*Editor`, which adopts this tab id rather than opening
   * a second one. Re-arming `pendingHydrationRef` is what re-opens that door: `hydrateTab` is a one-shot
   * per tab by design.
   */
  const reloadTab = (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return;

    if (tab.kind === 'scene') {
      // No saved hashes passed on purpose: `changedSince` then reads every asset as changed, which is
      // exactly what an explicit Reload means. The hash gate exists to keep an AUTOMATIC pass cheap.
      withoutDirty(() => {
        const changed = resyncScene(editorSceneRef.current, engineMaps(), currentLibs(), undefined);
        if (changed) {
          eventEmitter.current.emit('TEXTURES_CHANGED');
          eventEmitter.current.emit('SCENE_CHANGED');
          // A re-instantiated subtree invalidates the selection: the node it named no longer exists.
          eventEmitter.current.emit('SELECT_NODE', null);
        }
      });
      Logger.info('Scene reloaded from the current assets', 'Editor');
      return;
    }

    // Drop the outgoing session BEFORE rebuilding, for two reasons:
    //  - a preview terrain owns a splat texture and a cannon body nothing else frees, so replacing the
    //    runtime entry in place would leak one set per reload (mirrors removeTabById);
    //  - `hydrateTab` reports success by whether a runtime entry EXISTS, and the stale one would satisfy
    //    that even when the rebuild bailed because the asset had been deleted.
    tabRuntimeRef.current.get(tab.id)?.helperTerrain?.dispose();
    tabRuntimeRef.current.delete(tab.id);
    setModelSessions(prev => { if (!(tab.id in prev)) return prev; const next = { ...prev }; delete next[tab.id]; return next; });

    pendingHydrationRef.current.add(tab.id);
    if (!hydrateTab(tab)) {
      Logger.error(`"${tab.title}" could not be reloaded — the asset it edits is gone`, 'Editor');
      removeTabById(tab.id);
      return;
    }
    clearTabDirty(tab.id);
    eventEmitter.current.emit('HISTORY_RESET', tab.id); // a new document behind the same tab id
    // The tab id is unchanged, so the activate effect — which is keyed on `activeTabId` — never fires.
    // Without this the engine keeps rendering the scene we just discarded while the inspector edits the
    // new one, and `dirtyArmedRef`, which every `enter*Editor` clears on its way through, is never
    // re-armed: no edit anywhere would mark a tab dirty again for the rest of the session.
    if (tab.id === activeTabIdRef.current) applyActiveTab(tab);
    Logger.info(`"${tab.title}" reloaded from the current assets`, 'Editor');
  };

  /**
   * Put an edited template into the library and let everything that depends on it follow: every variant
   * descending from it is re-materialized (base before variant), and the placed copies of it and of those
   * are rebuilt. `editingTabId` is the tab the edit came from, whose own scene is already current. A tab
   * open on a cascaded VARIANT is left alone — it may hold unsaved edits; it reads as stale and offers a
   * reload. Returns the variants that followed.
   */
  const commitTemplate = (updated: Template, editingTabId?: string): Template[] => {
    const next = templatesRef.current.map(x => x.id === updated.id ? updated : x);
    const cascaded = cascadeFrom(next, updated.id, msg => Logger.warn(msg, 'Editor'));
    const byId = new Map<string, Template>([[updated.id, updated], ...cascaded.map(c => [c.id, c] as const)]);
    setTemplates(prev => prev.map(x => byId.get(x.id) ?? x));
    templatesRef.current = next.map(x => byId.get(x.id) ?? x);
    const tabEditing = (id: string) => tabsRef.current.find(t => t.kind === 'template' && t.templateId === id)?.id;
    withoutDirty(() => {
      syncTemplateInstances(updated.id, updated, editingTabId ?? tabEditing(updated.id));
      for (const c of cascaded) syncTemplateInstances(c.id, c, tabEditing(c.id));
    });
    return cascaded;
  };

  /**
   * In the open VARIANT tab: drop the variant's own changes to the node at `path` (or, with no path, to
   * every node — its name stays), so they inherit from the base again. Unsaved edits are saved first, so
   * the revert starts from what the tab shows; the tab is then reloaded from the result.
   */
  const revertVariantChanges = async (path?: string) => {
    const tab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    if (!tab || tab.kind !== 'template' || !tab.templateId) return;
    if (dirtyTabsRef.current[tab.id]) await saveTemplateTab(tab.id);
    const v = templatesRef.current.find(x => x.id === tab.templateId);
    const base = v?.variant ? templatesRef.current.find(x => x.id === v.variant!.baseTemplateId) : undefined;
    if (!v?.variant || !base) return;
    const diff = revertInDiff(v.variant.diff, path);
    const updated: Template = { ...v, ...materializeVariant(base, v.id, diff), variant: { baseTemplateId: base.id, diff } };
    commitTemplate(updated, tab.id);
    reloadTab(tab.id);
    const what = path === undefined ? v.name : (path || v.name);
    Logger.info(`Reverted "${what}" to "${base.name}"`, 'Editor');
  };

  /**
   * Base the open VARIANT tab's template on another template. Its content stays exactly as it is; from
   * now on it follows the new base. A base that is the variant itself or descends from it is refused.
   */
  const rebaseTemplateVariant = async (newBaseId: string) => {
    const tab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    if (!tab || tab.kind !== 'template' || !tab.templateId) return;
    if (dirtyTabsRef.current[tab.id]) await saveTemplateTab(tab.id);
    const library = templatesRef.current;
    const v = library.find(x => x.id === tab.templateId);
    const base = library.find(x => x.id === newBaseId);
    if (!v || !base) return;
    const rebased = rebaseVariant(library, v, base);
    if (!rebased) { Logger.warn(`"${v.name}" cannot be based on "${base.name}": it is, or comes from, "${v.name}" itself`, 'Editor'); return; }
    commitTemplate(rebased, tab.id);
    reloadTab(tab.id);   // the reloaded tab snapshots the NEW base as the one it diffs against
    Logger.info(`"${v.name}" is now a variant of "${base.name}"`, 'Editor');
  };

  /**
   * Turn a placed copy into a new VARIANT of its template: what the copy changed (its overrides) becomes
   * the variant's own, and the copy is relinked to the variant — so a look tuned on one placement can be
   * reused as an asset, while the template itself is untouched.
   */
  const createVariantFromInstance = async (node: Node) => {
    const root = templateInstanceRootOf(node);
    const base = root ? templatesRef.current.find(t => t.id === root.getVariable(TEMPLATE_ID_VAR)) : undefined;
    if (!root || !base) return;
    const content = await buildTemplateFromNode(root, engineMaps(), scriptAssetsRef.current);
    // Where the copy stands is the placement's, not the asset's; the override record is the copy's.
    delete content.nodeJson.variables?.[OVERRIDES_VAR];
    for (const key of ['position', 'rotation', 'scale'] as const) {
      if (base.nodeJson[key] !== undefined) content.nodeJson[key] = cloneJson(base.nodeJson[key]);
      else delete content.nodeJson[key];
    }
    const taken = new Set(templatesRef.current.map(t => t.name));
    let name = root.name !== base.name && !taken.has(root.name) ? root.name : `${base.name} Variant`;
    for (let i = 2; taken.has(name); i++) name = `${base.name} Variant ${i}`;
    const variant = variantFromContent(base, content, cryptoRandomId(), name);
    setTemplates(prev => [...prev, variant]);
    templatesRef.current = [...templatesRef.current, variant];
    // Relink the copy: its changes now live in the variant, so it keeps none of its own.
    writeOverrides(root, {});
    root.setVariable(TEMPLATE_ID_VAR, variant.id, 'string');
    withoutDirty(() => syncTemplateInstances(variant.id, variant));
    eventEmitter.current.emit('SCENE_CHANGED');
    Logger.info(`Created "${name}", a variant of "${base.name}", from the placed copy`, 'Editor');
  };

  // Save a template tab back to the library and propagate the change to placed instances.
  const saveTemplateTab = async (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab || tab.kind !== 'template') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    if (!runtime) return;
    const rootNode = runtime.scene.getNodeById(runtime.rootId);
    if (!rootNode) return;
    try {
      const t = await buildTemplateFromNode(rootNode, engineMaps(), scriptAssetsRef.current);
      let cascaded: Template[] = [];
      if (tab.templateId) {
        const library = templatesRef.current;
        const existing = library.find(x => x.id === tab.templateId);
        const currentBase = existing?.variant ? library.find(x => x.id === existing.variant!.baseTemplateId) : undefined;
        // A variant saves as its DIFF against the base (laid over the base as it is now); a plain template
        // saves its tree as before.
        const updated: Template = existing?.variant && currentBase
          ? saveVariant(existing, { ...t, id: tab.templateId }, runtime.baseAtOpen ?? currentBase, currentBase)
          : { ...t, id: tab.templateId, ...(existing?.variant ? { variant: existing.variant } : {}) };
        cascaded = commitTemplate(updated, tab.id);
        // The tab now diffs against the base as saved; a later base edit is again "made meanwhile".
        if (updated.variant && currentBase) runtime.baseAtOpen = cloneJson(currentBase);
      } else {
        addTemplate(t); // t carries a fresh id
      }
      // Adopt the saved name/id so later saves update (not re-add) and the tab label stays in sync.
      setTabs(prev => prev.map(x => x.id === tab.id ? { ...x, title: t.name, templateId: tab.templateId ?? t.id } : x));
      clearTabDirty(tab.id);
      const followers = cascaded.length ? ` (${cascaded.length} variant${cascaded.length === 1 ? '' : 's'} updated)` : '';
      Logger.info(`Template "${t.name}" saved${followers}`, 'Editor');
    } catch (e) {
      Logger.error('Failed to save template: ' + e, 'Editor');
    }
  };

  // Low-level tab removal (no confirm). Shared by closeTab and removeMaterial (force-closing a deleted
  // material's tab). Main is unclosable.
  const removeTabById = (id: string) => removeTabsByIds([id]);

  /**
   * Remove several tabs in ONE state write. Calling `removeTabById` repeatedly in one handler would not
   * work: each call derives the remaining list from the same render's `tabs`, so the last write would put
   * the earlier-removed tabs back — without their runtimes.
   */
  const removeTabsByIds = (ids: string[]) => {
    const drop = new Set(ids.filter(id => id !== SCENE_TAB_ID && tabs.some(t => t.id === id)));
    if (!drop.size) return;
    const firstIdx = tabs.findIndex(t => drop.has(t.id));
    const remaining = tabs.filter(t => !drop.has(t.id));
    for (const id of drop) {
      tabRuntimeRef.current.get(id)?.helperTerrain?.dispose(); // free the preview terrain's splat/body
      tabRuntimeRef.current.delete(id);
      pendingHydrationRef.current.delete(id); // a closed tab never needs its session built
      clearTabDirty(id);
    }
    setModelSessions(prev => {
      if (![...drop].some(id => id in prev)) return prev;
      const next = { ...prev }; for (const id of drop) delete next[id]; return next;
    });
    setTabs(remaining);
    if (drop.has(activeTabId)) {
      const fallback = remaining[Math.max(0, firstIdx - 1)] ?? remaining[0];
      setActiveTab(fallback ? fallback.id : SCENE_TAB_ID);
    }
  };

  const closeTab = async (id: string) => {
    if (id === SCENE_TAB_ID) return;
    const tab = tabsRef.current.find(t => t.id === id);
    if (!tab) return;
    if (dirtyTabsRef.current[id]) {
      const decision = await confirmUnsavedScene(tab.title, 'close');
      if (decision === 'cancel') return;
      // A failed save must not close the tab — that would discard the very edits the user asked to keep.
      if (decision === 'save' && !(await runSave([id], `Saving ${tab.title}`))) return;
    }
    removeTabById(id);
  };

  const closeTabs = async (ids: string[], title: string) => {
    const open = ids.filter(id => id !== SCENE_TAB_ID && tabsRef.current.some(t => t.id === id));
    if (!open.length) return;
    const dirty = open.filter(id => dirtyTabsRef.current[id]);
    if (dirty.length) {
      const decision = await confirmUnsavedScene(title, 'close');
      if (decision === 'cancel') return;
      if (decision === 'save' && !(await runSave(dirty, `Saving ${title}`))) return;
    }
    removeTabsByIds(open);
  };

  const saveTabs = (ids: string[], label: string) => runSave(ids, label);

  // Reorder: move `fromId` to `toId`'s position (Main included — it is movable).
  const reorderTabs = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setTabs(prev => {
      const from = prev.findIndex(t => t.id === fromId);
      const to = prev.findIndex(t => t.id === toId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  // Re-apply a saved/edited material to every node that references it, in every live scene, at any depth
  // (scene.nodes is the flattened tree). The link is kept — only the material is swapped.
  const syncMaterialInstances = (materialId: string, asset: MaterialAsset, exceptTabId?: string) => {
    let changed = false;
    for (const scene of liveScenes(exceptTabId)) {
      for (const n of Array.from(scene.nodes)) {
        // Every submesh that references it, not just the one `__materialId` mirrors: matching on the scalar
        // misses a material linked to a second submesh entirely.
        for (const slot of materialSlotsReferencing(n, materialId)) { applyMaterialAsset(n, asset, slot); changed = true; }
        // Cameras referencing it in their ordered screen-space pass list: rebuild the list, substituting
        // the freshly saved asset for its id (other slots resolve from the current library).
        if (n.nodeType !== 'camera') continue;
        const cam = n as CameraNode;
        const ids = getScreenMaterialIds(cam);
        if (!ids.includes(materialId)) continue;
        const assets = ids
          .map(id => (id === materialId ? asset : materialsRef.current.find(m => m.id === id)))
          .filter((a): a is MaterialAsset => !!a);
        applyScreenMaterials(cam, assets);
        changed = true;
      }
    }
    if (changed) {
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
    }
  };

  // Delete a material asset: fall every referencing node back to a Basic + Null-texture material, drop
  // the link, and force-close any open editor tab for it.
  const removeMaterial = (id: string) => {
    const scene = editorSceneRef.current;
    let changed = false;
    for (const n of Array.from(scene.nodes)) {
      for (const slot of materialSlotsReferencing(n, id)) { unlinkMaterialAt(n, slot); changed = true; }
      if (n.nodeType === 'camera') {
        const cam = n as CameraNode;
        const ids = getScreenMaterialIds(cam);
        if (ids.includes(id)) {
          const assets = ids.filter(x => x !== id)
            .map(x => materials.find(m => m.id === x))
            .filter((a): a is MaterialAsset => !!a);
          applyScreenMaterials(cam, assets);
          changed = true;
        }
      }
    }
    if (changed) { eventEmitter.current.emit('TEXTURES_CHANGED'); eventEmitter.current.emit('SCENE_CHANGED'); }
    const openTab = tabs.find(t => t.kind === 'material' && t.materialId === id);
    if (openTab) removeTabById(openTab.id);
    setMaterials(prev => prev.filter(x => x.id !== id));
  };

  // Build a material editor tab: a throwaway preview scene whose sphere carries the material to edit
  // (from `asset`, else a fresh PBR material for a brand-new one). Taking the asset object directly (not
  // an id) lets callers open a just-created asset without waiting for the `materials` state to commit.
  const openMaterialTab = (asset: MaterialAsset | null, adoptTabId?: string) => {
    // Disarm dirty-tracking before building the preview scene: SCENE_CHANGED names no scene, so mark()
    // can only blame the ACTIVE tab. The tab-activate effect re-arms once the new tab is showing.
    dirtyArmedRef.current = false;
    const scene = new Scene();
    // The env map + skybox attach once the cubemap images load — usually after this tab has activated, where
    // an unsilenced insert is recorded as an undo step.
    void createMaterialPreviewScene(scene, { silently: withoutDirty });

    if (asset) {
      for (const t of asset.textures || []) {
        if (t?.id && !TextureManager.Instance.getTexture(t.id)) TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id);
      }
    }
    const material: Material = asset ? Material.parse(asset.material) : Material.PBR({});
    const sphere = new ModelNode('preview', new Model(previewSphereGeometry(), material));
    scene.addNode(sphere);
    // On the shape last chosen for material previews. The node is the same either way — the tab saves
    // and selects by its id — only its geometry and the framing change.
    applyMaterialPreviewShape(scene, sphere, loadPreviewShape('material'));
    // Screen-mode custom materials are camera post passes, not mesh surfaces: run the SAME instance on the
    // preview camera so it previews live. The sphere still carries it for the inspector; the renderer skips
    // drawing models with a screen material.
    if (material instanceof CustomMaterial && material.renderMode === 'screen' && scene.activeCamera)
      scene.activeCamera.screenMaterials = [material];
    scene.start();

    const tabId = adoptTabId ?? cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: sphere.id });
    // the activate effect swaps the engine scene + selects the sphere
    commitTab({ id: tabId, kind: 'material', title: asset?.name ?? 'New Material', materialId: asset?.id ?? null }, adoptTabId);
  };

  // Open (or focus) the editor for a library material, or a brand-new one when called with no id.
  const enterMaterialEditor = (materialId?: string, adoptTabId?: string) => {
    if (!instanceRef.current) return;
    if (materialId) {
      // Opening is what produces the preview. Not on hydration: the thumbnail already exists, and
      // re-rendering one per restored tab costs a GL frame each at boot.
      if (!adoptTabId) {
        captureAssetThumbnail('material', materialId);
        const existing = tabs.find(t => t.kind === 'material' && t.materialId === materialId);
        if (existing) { setActiveTab(existing.id); return; }
      }
      const asset = materialsRef.current.find(m => m.id === materialId);
      if (!asset) { Logger.error('Material not found', 'Editor'); return; }
      openMaterialTab(asset, adoptTabId);
    } else {
      openMaterialTab(null);
    }
  };

  // Create a material asset from a node's current material, link the node to it, and open its editor.
  const createMaterialForNode = (node: Node, submesh = 0) => {
    if (!instanceRef.current) return;
    // A merged model has one material per submesh; seed the new asset from the one being replaced.
    const material = (node as any).model?.materials?.[submesh] ?? getNodeMaterial(node);
    if (!material) return;
    const suffix = submesh > 0 ? ` Material ${submesh + 1}` : ' Material';
    const asset = buildMaterialAsset(material, `${node.name}${suffix}`, '');
    addMaterial(asset);
    applyMaterialAsset(node, asset, submesh); // stamp __materialId(s) so the node now references the asset
    eventEmitter.current.emit('TEXTURES_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    openMaterialTab(asset); // seed directly: `asset` isn't in the `materials` state this render yet
  };

  // ---- Thumbnails on open --------------------------------------------------------------------------
  const { captureAssetThumbnail } = useAssetThumbnails({
    instanceRef, materials, setMaterials, terrainMaterials, setTerrainMaterials, models, setModels,
  });

  // ---- Mesh edit tab ---------------------------------------------------------------------------------

  // Show exactly one LOD level's subtree in a mesh tab. Plain `visible` writes are fine here: this is a
  // user-facing edit-session toggle, not the renderer's per-frame LOD switch.
  // Which level is SHOWN is view state, not an edit of the model. Every caller that really changes the
  // session (add, generate, remove a level) marks the tab dirty itself.
  const applyActiveModelLevel = (scene: Scene, levelIds: string[], active: number) => withoutDirty(() => {
    for (let i = 0; i < levelIds.length; i++) {
      const root = scene.getNodeById(levelIds[i]);
      if (root) root.visible = i === active;
    }
  });

  /**
   * Levels 1..N of a model tab are read-only PREVIEWS of other model assets: a save serializes level 0 only.
   * So they are editor-owned. Showing, moving or dropping one is never an edit of this model, and never an
   * undo step. An undo that detached one would also desync the level session. Parsed under the bracket
   * because the flag can only be set once the parse has produced the root, after its attach has emitted.
   */
  const parseLodPreview = (scene: Scene, clone: any): void => {
    withoutDirty(() => parseByType(scene.root, clone));
    const root = scene.getNodeById(clone.id);
    if (root) markEditorOwned(root);
  };

  // Build an edit session for a mesh asset: a throwaway scene holding one subtree per LOD level,
  // instantiated directly (NOT via the LodGroup wrapper — the renderer must not auto-swap levels while the
  // user edits). Opening the tab also triggers the asset's thumbnail render.
  const openMeshTab = (asset: ModelAsset, adoptTabId?: string) => {
    // Disarm dirty-tracking before building the preview scene: SCENE_CHANGED names no scene, so mark()
    // can only blame the ACTIVE tab. The tab-activate effect re-arms once the new tab is showing.
    dirtyArmedRef.current = false;
    const scene = new Scene();
    scene.animationsEnabled = false; // skinned models hold their bind pose while editing
    scene.spawnRulesEnabled = false; // ...and a spawnOnStart=false node still shows while it is being authored
    // Same asset-edit environment as template tabs — see createAssetEditScene. The viewing light is
    // __editor__ named, so it neither appears in the mesh's tree nor gets saved into the asset.
    void createAssetEditScene(scene, withoutDirty);

    // No wrapper node: the asset's own root IS the tab root, so `runtime.rootId` addresses real content.

    // Restore legacy embedded textures.
    for (const t of asset.textures || []) {
      if (t?.id && !TextureManager.Instance.getTexture(t.id))
        TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id);
    }

    // Level 0 is the mesh being edited. Extra levels are resolved from the library on every open, so a
    // level always shows the current state of its source mesh; a reference whose asset has been deleted is
    // dropped with a warning.
    const lodRefs: ModelLodDef[] = [];
    const lodJsons: any[] = [];
    for (const [i, lod] of (asset.lods ?? []).entries()) {
      const raw = lodLevelJson(lod, modelsRef.current);
      // A level generated before levels kept their material links gets them back here (see withLevelLinks).
      const levelJson = raw && lod.generated ? withLevelLinks(raw, asset.nodeJson, i + 1) : raw;
      if (!levelJson) {
        Logger.warn(`LOD level of "${asset.name}" references a model that no longer exists — dropped`, 'Editor');
        continue;
      }
      // Carry the relinked copy, so the next save stores the links rather than re-deriving them forever.
      lodRefs.push(levelJson !== raw ? { ...lod, nodeJson: levelJson } : lod);
      lodJsons.push(levelJson);
    }

    const levelJsons = [asset.nodeJson, ...lodJsons];
    const levelIds: string[] = [];
    for (const json of levelJsons) {
      const clone = deepClone(json);
      regenerateIds(clone, new Map());
      // Re-resolve the material links against the LIBRARY, exactly as instantiateModelAsset does for a
      // placement: the embedded material is a fallback for a deleted asset, never the source of truth, and
      // saving the model would otherwise write the stale copy back over it.
      resolveMaterialRefs(clone, materialsRef.current);
      if (levelIds.length === 0) parseByType(scene.root, clone); // level 0: the model being edited
      else parseLodPreview(scene, clone);
      levelIds.push(clone.id);
    }
    scene.start();

    const tabId = adoptTabId ?? cryptoRandomId();
    // Level 0 IS the tab root — the LOD previews are its siblings under the scene root, not its children.
    tabRuntimeRef.current.set(tabId, { scene, rootId: levelIds[0] });
    setModelSessions(prev => ({
      ...prev,
      [tabId]: {
        levelIds,
        lodRefs,
        distances: [0, ...lodRefs.map(l => l.distance)],
        cullDistance: asset.cullDistance ?? 0,
        activeLevel: 0,
        skinned: levelJsons.some(nodeJsonHasSkinnedModel),
      },
    }));
    applyActiveModelLevel(scene, levelIds, 0);
    commitTab({ id: tabId, kind: 'model', title: asset.name, modelId: asset.id }, adoptTabId);
    eventEmitter.current.emit('TEXTURES_CHANGED');
  };

  // Rebuild every placed instance of a mesh asset after it was saved, preserving each instance's own
  // transform (the template propagation pattern — a mesh instance is a whole copied subtree, so it is
  // re-instantiated rather than patched in place). Runs across every live scene (see liveScenes).
  /**
   * Content hash of each model asset as it was last instantiated, so a save that changed only metadata
   * (a name, a LOD distance) does not rebuild every placed copy. Rebuilding is expensive in a way that
   * scales badly: a LOD-bearing asset deep-clones EVERY level per instance.
   */
  const instantiatedHashRef = useRef(new Map<string, string>());

  const syncModelInstances = (modelId: string, asset: ModelAsset, exceptTabId?: string) => {
    // Structural content only — `hashAsset` already omits the thumbnail and the other non-structural
    // fields, so a re-render or a rename cannot trip this.
    const hash = hashAsset(asset);
    if (instantiatedHashRef.current.get(modelId) === hash) return;
    instantiatedHashRef.current.set(modelId, hash);

    const maps = engineMaps();
    let count = 0;
    let reselectId: string | null = null;
    for (const scene of liveScenes(exceptTabId)) {
      const instances = Array.from(scene.nodes).filter(n => n.getVariable(MODEL_ID_VAR) === modelId);
      for (const inst of instances) {
        const parent = inst.parent;
        if (!parent) continue;
        const pos = Array.from(inst.position) as [number, number, number];
        const rot = Array.from(inst.rotation) as [number, number, number];
        const scl = Array.from(inst.scale) as [number, number, number];
        // Per-instance node state the rebuild would otherwise drop — the subtree is reconstructed from the
        // ASSET, which knows nothing about how this particular placement was configured.
        const spawnOnStart = inst.spawnOnStart;
        // The animation state machine is authored onto the PLACED node and never stored in the asset, so a
        // rebuild would replace a configured character with a bare one. Same reasoning as spawnOnStart above.
        const animation = captureAnimationState(inst);
        // What the asset's own root transform said when this copy was built. Restoring `pos/rot/scl` below
        // is right for where the user put the copy and wrong for a change the MODEL made to its root
        // transform — the two share one slot — so the difference is re-applied on top afterwards.
        const baseTrs = readModelBaseTrs(inst);
        const wasSelected = inst.id === selectedNode;
        // What the user added inside this copy (a sprite on the tip, a light) is not the asset's: carried
        // over to the rebuilt copy rather than thrown away with it. See foreignChildren.ts.
        const foreign = detachForeignChildren(inst, modelInstanceShape(asset, modelsRef.current));
        // The copy's own collider: a model asset carries no physics, so a body on the placed root is
        // per-placement state, keyed by the id the cleanup below drops (see reinstantiate in sceneResync.ts).
        const rootBody = maps.bodies.get(inst.id);
        const rootTrigger = maps.triggers.get(inst.id);
        // Drop the old subtree's out-of-band data so map entries don't leak.
        for (const id of collectSubtreeIds(inst)) { maps.scripts.delete(id); maps.bodies.delete(id); maps.triggers.delete(id); }
        // Detach synchronously with removeChild, not remove(): remove() only marks, and its deferred sweep
        // mis-splices unrelated root children (see reinstantiate in sceneResync.ts).
        parent.removeChild(inst);
        // …and free its GPU buffers. removeChild only detaches, and a LOD-bearing asset instantiates as
        // one subtree PER LEVEL, so without this a save orphaned four mesh sets per placed copy — the
        // leak that actually exhausted the tab.
        disposeModelSubtree(inst);
        const newId = instantiateModelAsset(asset, parent, materialsRef.current, modelsRef.current, animationsRef.current);
        const newNode = scene.getNodeById(newId);
        if (newNode) {
          newNode.setPosition(pos).setRotation(rot).setScale(scl);
          newNode.spawnOnStart = spawnOnStart;
          restoreAnimationState(newNode, animation);
          if (rootBody) maps.bodies.set(newId, rootBody);
          if (rootTrigger) maps.triggers.set(newId, rootTrigger);
          reattachForeignChildren(newNode, foreign);
          // A LOD-wrapped asset keeps its root transform on the wrapper's child 0, so the edit already
          // arrives through the child and applying it here as well would double it.
          if (!modelAssetHasLodBehavior(asset)) applyModelTransformDelta(newNode, baseTrs, asset.nodeJson);
        }
        if (wasSelected) reselectId = newId;
        count++;
      }
    }
    if (count) {
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
      if (reselectId) eventEmitter.current.emit('SELECT_NODE', reselectId);
    }
  };

  /**
   * After a model asset is saved, refresh the live foliage prototypes of every terrain material whose
   * rules reference it — WITHOUT re-scattering instances.
   *
   * It no longer rewrites the terrain-material ASSETS. A rule's baked meshes stopped being persisted
   * (see TerrainMaterial.serialize) and are rebuilt from the model library on load, so there is nothing
   * in the asset left to bring up to date — the model save already updated the one copy that exists.
   * That removed three things from this path per affected material: a full re-bake, an
   * `updateTerrainMaterial` that rewrote the library, and a `deepClone` of the baked meshes into every
   * open terrain-material tab. Between them they were what exhausted the editor on save.
   *
   * Reads the REFS, not the state: every caller reaches here from an async save that has already
   * awaited, so the captured `terrainMaterials`/`models` closures can be a render behind.
   */
  const syncFoliageRulesForModel = (modelAsset: ModelAsset, exceptTabId?: string) => {
    const affected = terrainMaterialsRef.current.filter(tmAsset => {
      return allTerrainFoliageRules(tmAsset.material).some((r: any) => r?.modelId === modelAsset.id);
    });
    if (affected.length === 0) return;

    // An OPEN terrain-material tab holds its own live TerrainMaterial whose rules still carry the
    // PREVIOUS prototypes. Drop them so the next resolve rebuilds from the saved model; the geometry is
    // derived, so clearing it is safe and is what a re-bake used to accomplish at 60 MB a go.
    for (const [tabId, rt] of tabRuntimeRef.current.entries()) {
      if (tabId === exceptTabId) continue;
      const tm = (rt as any).tm;
      if (!tm?.foliageInclude) continue;
      for (const rule of allTerrainFoliageRules(tm))
        if (rule?.modelId === modelAsset.id) { delete rule.models; delete rule.model; delete rule.lods }
    }

    const updated = affected;

    // Every live scene, not just the open one — matching syncModelInstances and
    // syncTerrainMaterialInstances. Scenes that are not live are handled pull-side by resyncScene.
    // skipAutoGenerate: this is an edit sync, so a bare terrain must not sprout foliage from it.
    for (const scene of liveScenes(exceptTabId)) {
      for (const landscape of Array.from(scene.landscapes) as any[]) {
        const terrain = landscape.terrain;
        if (!terrain) continue;
        for (const asset of updated) {
          terrain.layers.forEach((layer: any, i: number) => {
            if (layer.materialId === asset.id) applyTerrainMaterialToLayer(terrain, i, asset, { skipAutoGenerate: true });
          });
        }
      }
    }
    eventEmitter.current.emit('SCENE_CHANGED');
  };

  /**
   * The third place a saved Material asset has to reach: the SLOTS of landscape materials.
   *
   * A landscape material's extra surfaces (rock on the steep parts, snow up high) each embed a copy of an
   * ordinary Material asset, linked by `surfaceMaterialId`. Neither `syncMaterialInstances` (which walks
   * scene nodes) nor `syncFoliageRulesForMaterial` (which walks models) can see one, so without this an
   * edit to "Rock" left every landscape using it drawing the old rock until the project was reloaded.
   * Both copies are refreshed: the live stacks, and the stored `.tmat` assets they were applied from.
   */
  const syncTerrainMaterialSlots = (materialId: string, asset: MaterialAsset, exceptTabId?: string) => {
    let changed = false;
    for (const scene of liveScenes(exceptTabId)) {
      for (const landscape of Array.from(scene.landscapes) as any[]) {
        if (landscape.terrain && syncSlotMaterialInTerrain(landscape.terrain, materialId, asset.material)) changed = true;
      }
    }
    for (const tmAsset of terrainMaterialsRef.current) {
      const updated = withSyncedSlotMaterial(tmAsset, materialId, asset.material);
      if (updated) { updateTerrainMaterial(tmAsset.id, updated); changed = true; }
    }
    if (changed) {
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
    }
  };

  // The other half of "the model changed": a foliage prototype bakes its material INLINE, so editing a
  // shared Material asset never reached scattered foliage at all — syncMaterialInstances only walks
  // scene nodes, and a prototype is reachable from none. Re-derive through the model path for every
  // model asset that links this material, which is also what picks up the newly-resolved material.
  const syncFoliageRulesForMaterial = (materialId: string, exceptTabId?: string) => {
    const linksMaterial = (json: any): boolean => {
      if (!json || typeof json !== 'object') return false;
      if (serializedVar(json, MATERIAL_ID_VAR) === materialId) return true;
      const list = serializedVar(json, MATERIAL_IDS_VAR);
      if (list) {
        try { if ((JSON.parse(list) as any[]).includes(materialId)) return true; } catch { /* corrupt link */ }
      }
      return (json.children ?? []).some(linksMaterial);
    };

    // Only models a rule actually references — re-baking a model nothing scatters is wasted work.
    const scattered = new Set<string>();
    for (const tmAsset of terrainMaterialsRef.current)
      for (const r of allTerrainFoliageRules(tmAsset.material)) if ((r as any)?.modelId) scattered.add((r as any).modelId);

    for (const modelAsset of modelsRef.current) {
      if (!scattered.has(modelAsset.id)) continue;
      if (!linksMaterial(modelAsset.nodeJson)) continue;
      syncFoliageRulesForModel(modelAsset, exceptTabId);
    }
  };

  /**
   * Delete the runtime foliage layer a rule scattered, in every live scene.
   *
   * Deleting a rule used to leave its layer behind: a layer is filed under `foliageRuleKey` — the
   * rule's own id — and `pruneFoliage` deliberately refuses to collect one that still holds
   * instances, because that guard is what keeps hand-painted placement through a rename. So the layer
   * stayed in `terrain.foliage`, kept drawing its old prototypes, and was unreachable from
   * `refreshFoliagePrototypes`. Replacing a foliage prop meant remove-then-add, which is exactly that
   * path: the scene rendered the old prop and the new one at once, at full detail.
   *
   * The painted instances go with it. They were placed by a rule that no longer exists; Generate
   * Foliage re-scatters from whatever rules remain.
   */
  const dropFoliageLayer = (rule: TerrainFoliageRule) => {
    const key = foliageRuleKey(rule);
    let removed = false;
    for (const scene of liveScenes()) {
      for (const landscape of Array.from(scene.landscapes) as any[])
        if (landscape.terrain?.removeFoliageLayer(key)) removed = true;
    }
    if (removed) eventEmitter.current.emit('SCENE_CHANGED');
  };

  /**
   * Bake an impostor for a foliage rule's source model, register it, and point the rule at it.
   *
   * The single largest thing that can be done for a heavy foliage prototype. A LOD level reduces
   * triangles linearly; the impostor replaces them all with one quad, and past the distance it takes
   * over the difference is not visible. Returns the texture id, or null when the rule has no model behind it.
   *
   * OCTAHEDRAL by default (`impostorKind`): 8 x 8 unlit views with their normals, lit by the scene and
   * right from every side and from above, so it holds up much closer than the flat card, which stays
   * available for small plants where one view is plenty.
   *
   * The takeover distance defaults to the model's LAST LOD band, so the mesh ladder plays out in full
   * and the card picks up where it ends. It is authored on the rule like every other impostor field, so
   * a hand-set distance is left alone.
   */
  const bakeFoliageImpostor = async (rule: TerrainFoliageRule): Promise<string | null> => {
    const engine = instanceRef.current;
    const modelId = (rule as any).modelId as string | undefined;
    if (!engine || !modelId) return null;
    const asset = modelsRef.current.find(m => m.id === modelId);
    if (!asset) return null;

    const id = impostorTextureId(modelId), normalId = octahedralNormalTextureId(modelId);
    // The stored record has to go BEFORE the re-bake: `persistTextures` skips an id it already has, so
    // a second bake would leave the old card on disk and the new one only in memory until reload.
    await deleteTextures([id, normalId]);

    if ((rule.impostorKind ?? 'octahedral') === 'octahedral') {
      // From the LAST mesh level, the one the impostor takes over from: baked from the full model it
      // comes out denser than the sparse level beside it, and the hand-over shows as a pop.
      const models = foliageRuleModels(rule);
      const lastLevel = rule.lods?.length ? rule.lods[rule.lods.length - 1].models : null;
      const baked = await bakeOctahedralFromModels(lastLevel?.length ? lastLevel : models, rule.impostorSize ?? OCTAHEDRAL_ATLAS_SIZE);
      if (!baked) return null;
      const tm = TextureManager.Instance;
      tm.removeTexture(id); tm.removeTexture(normalId);
      tm.addTextureFromBase64(baked.albedo, { mipMap: true }, id);
      tm.addTextureFromBase64(baked.normal, { mipMap: true }, normalId);
      await persistTextures([id, normalId]);
      Logger.info(`Baked an octahedral impostor for "${asset.name}": ${Math.round(baked.coverage * 100)}% of its views covered.`, 'Editor');
      rule.billboard = { textureId: id, distance: impostorTakeover(rule), octahedral: baked.info, textures: { normal: normalId } };
      eventEmitter.current.emit('SCENE_CHANGED');
      return id;
    }

    const baked = await bakeModelImpostor(engine, asset, materialsRef.current, rule.impostorSize ?? IMPOSTOR_SIZE);
    if (!baked) return null;
    await persistTextures([baked.id]);
    rule.billboard = { textureId: baked.id, distance: impostorTakeover(rule) };
    eventEmitter.current.emit('SCENE_CHANGED');
    return baked.id;
  };

  /**
   * Where a rule's impostor takes over: the distance already authored on it, or past the whole mesh
   * ladder. The impostor replaces every level that starts at or beyond it, so a takeover AT the last band
   * (what this used to pick) retired the last, cheapest level unseen. Twice the last band continues the
   * ladder's own doubling (generated bands are 1x/2x/4x a step).
   */
  function impostorTakeover(rule: TerrainFoliageRule): number {
    const bands = (rule.lods ?? []).map(l => l.distance).filter(d => d > 0);
    return rule.billboard?.distance
      ?? (bands.length ? Math.round(Math.max(...bands) * 2) : DEFAULT_IMPOSTOR_DISTANCE);
  }

  // Save a mesh tab back to the library and propagate to placed instances.
  const saveModelTab = async (tabId: string) => {
    const engine = instanceRef.current;
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!engine || !tab || tab.kind !== 'model' || !tab.modelId) return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = modelSessionsRef.current[tab.id];
    if (!runtime || !session) return;
    try {
      // Only level 0 is authored here, so only it has to resolve to a live node; extra levels are saved as
      // `{ modelId, distance }` references. The recorded id is a hint, not a contract — restructuring the
      // mesh retires it, so fall back to reading the mesh out of its holder.
      // A node the user deleted can still be in the tree: Node.remove() only marks it and the sweep runs on
      // a later Scene.update, so treat marked nodes as gone everywhere this resolves a root.
      const alive = (n: Node | null | undefined): n is Node => !!n && !n.markForRemoval;

      let baseRoot: Node | null = null;
      const recorded = runtime.scene.getNodeById(session.levelIds[0]);
      if (alive(recorded)) baseRoot = recorded;
      // Set when the content had to be wrapped: the nodes moved under a scratch root for serialization,
      // and where each came from so the live tree can be put back exactly as the user left it.
      let restore: { node: Node; parent: Node }[] = [];

      if (!baseRoot) {
        const previewIds = new Set(session.levelIds.slice(1));
        const isContent = (n: Node) =>
          alive(n) && !previewIds.has(n.id) && !isEditorOwnedName(n.name);
        // Everything the user left at the scene root, minus the read-only LOD previews and the editor's
        // own camera/light. This is the only place content can be.
        const candidates = runtime.scene.root.children.filter(isContent);

        if (candidates.length === 0) {
          Logger.error(`Model "${tab.title}" has no content to save — its root node was deleted.`, 'Editor');
          return;
        }
        if (candidates.length === 1) {
          baseRoot = candidates[0];
          // Re-pin the session so later saves (and the level radio buttons) track the new root.
          const levelIds = [baseRoot.id, ...session.levelIds.slice(1)];
          setModelSessions(prev => ({ ...prev, [tab.id]: { ...session, levelIds } }));
          modelSessionsRef.current = { ...modelSessionsRef.current, [tab.id]: { ...session, levelIds } };
        } else {
          // Several content roots — the normal result of merging models into one mesh. A mesh asset
          // serializes from ONE subtree, so they are reparented into a scratch root (serialize() reads the
          // live tree). The finally below always puts them back.
          const scratch = new Node(tab.title);
          for (const c of candidates) {
            const parent = c.parent;
            if (!parent) continue;
            restore.push({ node: c, parent });
            scratch.addChild(c);
          }
          baseRoot = scratch;
          Logger.info(`Model "${tab.title}": ${candidates.length} root nodes wrapped under a single root.`, 'Editor');
        }
      }

      // Distances live on the session (the inspector edits them); the reference itself is carried through
      // untouched, which is what preserves a legacy embedded level that has no mesh to point at.
      const lodDefs: ModelLodDef[] = session.lodRefs.map((ref, i) => ({
        ...ref,
        distance: session.distances[i + 1] ?? ref.distance ?? 0,
      }));

      // materialIds is the informational list of library materials this mesh's own subtree references.
      // Referenced LOD levels are not included — their materials belong to their own asset.
      const materialIdSet = new Set<string>();
      // Every submesh's link, not just slot 0 — a merged model's second material would otherwise read as
      // unused by the explorer and the publisher.
      const collectMats = (n: Node) => { for (const id of getMaterialIdsOf(n)) if (id) materialIdSet.add(id); n.children.forEach(collectMats); };
      collectMats(baseRoot);

      const prev = modelsRef.current.find(m => m.id === tab.modelId);
      let asset: ModelAsset;
      try {
        asset = await buildModelAsset(
          baseRoot, [...materialIdSet], prev?.thumbnail ?? '', tab.modelId,
          // `prev` carries what a live subtree cannot express — above all `rigId`, the skeleton that owns
          // the clips `AnimatedModel.serialize` filters out.
          lodDefs, session.cullDistance, prev,
        );
      } finally {
        // Put any wrapped nodes back where the user had them. The wrapper existed only to give
        // serialize() a single root; the live scene must look exactly as it did, saved or not.
        // withoutDirty: reparenting emits SCENE_CHANGED, which would re-dirty the tab we just saved.
        if (restore.length) withoutDirty(() => { for (const r of restore) r.parent.addChild(r.node); });
      }
      asset.name = tab.title; // the tab title is the asset name (renames edit the title)
      // A generated level's root ALWAYS sits where the model's root does: the levels were built from it,
      // and moving the model after generating must move them too. (A hand-picked level is another asset,
      // placed by its own root, and is left alone.)
      if (asset.lods?.length) {
        const { position, rotation, scale } = asset.nodeJson ?? {};
        asset.lods = asset.lods.map(l => (l.generated && l.nodeJson)
          ? { ...l, nodeJson: { ...l.nodeJson, position, rotation, scale } }
          : l);
      }

      // Refuse to persist a mesh with nothing in it: an empty asset renders as nothing and overwrites what
      // was saved before, so a save that produced one has read the wrong subtree. Returning leaves the
      // stored asset untouched and the tab dirty.
      if (!nodeJsonHasModel(asset.nodeJson)) {
        Logger.error(
          `Model "${tab.title}" has no geometry in it — refusing to save, the stored model is unchanged. ` +
          'Check the Scene panel still shows the model you expect.', 'Editor');
        return;
      }

      updateModel(tab.modelId, asset);
      // Old-scheme level assets this save no longer points at (a regenerate replaced them).
      purgeLegacyLodAssets(tab.modelId, new Set((asset.lods ?? []).map(l => l.modelId).filter((x): x is string => !!x)));
      withoutDirty(() => {
        syncModelInstances(tab.modelId!, asset, tab.id);
        syncFoliageRulesForModel(asset, tab.id);
        // Levels are references, so this mesh may be a LOD of others whose placed instances embed a copy of
        // what was just edited. Refresh those too.
        //
        // Asked of the REFERENCE GRAPH rather than by re-scanning `lods[]` here: this used to be the one
        // place in the project that hand-wrote a dependency hop, and it only ever knew about the one edge
        // its author was thinking of. Depth 1 is deliberate and unchanged — a level renders the referenced
        // mesh's own subtree, never its levels, so this must not cascade.
        for (const key of assetGraph.dependents(assetKey('model', tab.modelId!), 1)) {
          const dependencyRef = assetGraph.refOf(key);
          if (dependencyRef?.kind !== 'model' || dependencyRef.id === tab.modelId) continue;
          const dependent = modelsRef.current.find(m => m.id === dependencyRef.id);
          if (!dependent) continue;
          syncModelInstances(dependent.id, dependent, tab.id);
          syncFoliageRulesForModel(dependent, tab.id);
        }
      });
      clearTabDirty(tab.id);

      // Refresh the thumbnail from the SAVED asset, never the live tab subtree (renderModelThumbnail
      // reparents the node it is given). Async: the card updates whenever the render lands.
      renderModelAssetThumbnail(engine, asset)
        .then(thumbnail => { if (thumbnail) setModels(p => p.map(x => x.id === asset.id ? { ...x, thumbnail } : x)); })
        .catch(() => {});
      Logger.info(`Model "${asset.name}" saved`, 'Editor');
    } catch (e) {
      Logger.error('Failed to save model: ' + e, 'Editor');
    }
  };

  // Save one part of the open model as its own model asset — and, for 'extract', take it out of this one.
  const saveModelPart = async (part: ModelPart, mode: 'copy' | 'extract'): Promise<string | null> => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'model') return null;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = modelSessions[tab.id];
    const source = modelsRef.current.find(m => m.id === tab.modelId);
    if (!runtime || !session || !source) return null;
    const scene = runtime.scene;
    const node = scene.getNodeById(part.nodeId);
    // Only the model's OWN parts: levels 1+ are previews of other assets.
    const levelRoot = scene.getNodeById(session.levelIds[0]);
    const inLevel = (n: Node | null | undefined): boolean => { for (let a = n; a; a = a.parent) if (a === levelRoot) return true; return false; };
    if (!node || !levelRoot || !inLevel(node)) { Logger.warn('That part is not in this model', 'Editor'); return null; }

    const subName = part.submesh !== undefined
      ? (materialsRef.current.find(m => m.id === getMaterialIdsOf(node)[part.submesh!])?.name ?? `Sub-mesh ${part.submesh + 1}`)
      : node.name || 'Part';
    const name = uniqueModelName(`${tab.title || source.name} – ${subName}`, modelsRef.current.map(m => m.name));
    let asset: ModelAsset;
    try {
      asset = await buildPartAsset(source, node, levelRoot.parent, part.submesh, name);
    } catch (e) {
      Logger.error(`Could not save the part: ${e}`, 'Editor');
      return null;
    }
    addModel(asset);
    // Eager mirror, as adoptModelAsset does: the ref only catches up on the next render.
    modelsRef.current = [...modelsRef.current, asset];
    captureAssetThumbnail('model', asset.id);

    if (mode === 'extract') {
      const parent = node.parent;
      if (part.submesh === undefined) {
        parent?.removeChild(node);
        disposeModelSubtree(node);
      } else if (parent) {
        // Rebuilt from JSON, in place: keeps the node's id, transform, variables and children.
        const json = await submeshNodeJson(node as ModelNode, part.submesh, 'without');
        const index = parent.children.indexOf(node);
        parent.removeChild(node);
        disposeModelSubtree(node);
        parseByType(parent, json);
        const rebuilt = parent.children[parent.children.length - 1];
        if (rebuilt && index >= 0 && index < parent.children.length - 1) parent.addChild(rebuilt, index);
      }
      markTabDirty(tab.id, 'model-extract-part');
      eventEmitter.current.emit('SCENE_CHANGED');
      eventEmitter.current.emit('TEXTURES_CHANGED');
      Logger.info(`Extracted "${subName}" into the new model "${asset.name}" — save this model to keep the change`, 'Editor');
    } else {
      Logger.info(`Saved "${subName}" as the new model "${asset.name}"`, 'Editor');
    }
    return asset.id;
  };

  // Rename the active mesh tab (the title becomes the asset name on save).
  const setActiveModelName = (name: string) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'model') return;
    setTabs(prev => prev.map(x => x.id === tab.id ? { ...x, title: name } : x));
    markTabDirty(tab.id, 'model-rename');
  };

  /**
   * Add an existing mesh asset as the next LOD level of the active mesh tab. The level stores only a
   * reference; its geometry lives in the mesh it points at. A preview is spliced into the edit scene for
   * comparison but is never serialized back — it is rebuilt from the library each time the tab opens.
   */
  const addModelLodFromAsset = (modelId: string) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'model') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = modelSessions[tab.id];
    if (!runtime || !session) return;
    if (session.skinned) { Logger.warn('LOD levels are not supported on skinned models yet', 'Editor'); return; }
    if (modelId === tab.modelId) { Logger.warn('A model cannot be its own LOD level', 'Editor'); return; }
    if (session.lodRefs.some(l => l.modelId === modelId)) { Logger.warn('That model is already a LOD level', 'Editor'); return; }

    const source = modelsRef.current.find(m => m.id === modelId);
    if (!source) { Logger.error('Model asset not found', 'Editor'); return; }
    if (nodeJsonHasSkinnedModel(source.nodeJson)) {
      Logger.warn('Skinned models cannot be LOD levels (static models only)', 'Editor');
      return;
    }

    try {
      // Splice in a preview of the referenced mesh, as a SIBLING of level 0 under the scene root — the
      // levels are alternatives, and applyActiveModelLevel shows exactly one at a time. Parenting it to
      // level 0 would nest one model inside another and serialize it into the asset on the next save.
      const clone = deepClone(source.nodeJson);
      regenerateIds(clone, new Map());
      resolveMaterialRefs(clone, materialsRef.current);
      clone.name = source.name;
      parseLodPreview(runtime.scene, clone);

      // Match LOD0's size so the levels line up with the near model.
      const preview = runtime.scene.getNodeById(clone.id);
      const lod0 = runtime.scene.getNodeById(session.levelIds[0]);
      if (preview && lod0) {
        const targetDiameter = 2 * meshBoundsRadius(lod0);
        if (targetDiameter > 0) normalizeRootScale(preview, targetDiameter);
      }

      const lastDistance = session.distances[session.distances.length - 1] ?? 0;
      const distance = lastDistance + 30;
      const levelIds = [...session.levelIds, clone.id];
      const next: ModelEditSession = {
        ...session,
        levelIds,
        lodRefs: [...session.lodRefs, { modelId, distance }],
        distances: [...session.distances, distance],
        activeLevel: levelIds.length - 1, // show what was just added
      };
      setModelSessions(prev => ({ ...prev, [tab.id]: next }));
      applyActiveModelLevel(runtime.scene, levelIds, next.activeLevel);
      markTabDirty(tab.id, 'model-lod-add');
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
    } catch (e) {
      Logger.error('Failed to add LOD level: ' + e, 'Editor');
    }
  };

  /**
   * Generate LOD levels for the open model: decimate its geometry per level, give each level an inline
   * material on smaller textures, and wire the results in as EMBEDDED levels 1..N (see lodGenerate.ts).
   *
   * Every level a previous generate produced is replaced — embedded ones, and the library assets the old
   * scheme minted (`lodSource`), which the next save deletes. Levels the user added by hand stay.
   */
  const generateModelLods = async (specs: { ratio: number; distance: number }[], downscale: boolean) => {
    const tab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    if (!tab || tab.kind !== 'model' || !tab.modelId) return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = modelSessionsRef.current[tab.id];
    if (!runtime || !session || !specs.length) return;
    if (session.skinned) { Logger.warn('LOD generation supports static meshes only', 'Editor'); return; }

    const lod0 = runtime.scene.getNodeById(session.levelIds[0]);
    if (!lod0) { Logger.error('Model has no level 0 to reduce', 'Editor'); return; }
    if (hasSkinnedPart(lod0)) { Logger.warn('LOD generation supports static meshes only', 'Editor'); return; }

    const modelId = tab.modelId;
    const task = startTask({
      title: `Generating LODs for ${tab.title}`,
      steps: specs.map((sp, i) => ({ name: `LOD${i + 1}`, status: 'pending' as StepStatus, detail: `${Math.round(sp.ratio * 100)}% of triangles` })),
    });

    // Keep hand-added levels; drop every generated one. A legacy generated level is a library asset with
    // `lodSource` pointing here — dropped from the session now, deleted by the save that persists this.
    const keptRefs: ModelLodDef[] = [];
    const keptLevelIds: string[] = [session.levelIds[0]];
    const keptDistances: number[] = [0];
    session.lodRefs.forEach((ref, i) => {
      const legacy = ref.modelId ? modelsRef.current.find(m => m.id === ref.modelId)?.lodSource?.modelId === modelId : false;
      if (ref.generated || legacy) {
        const stale = runtime.scene.getNodeById(session.levelIds[i + 1]);
        if (stale?.parent) stale.parent.removeChild(stale);
        // Regenerating replaces the preview subtree; without this each press orphans its meshes.
        disposeModelSubtree(stale);
        return;
      }
      keptRefs.push(ref);
      keptLevelIds.push(session.levelIds[i + 1]);
      keptDistances.push(session.distances[i + 1] ?? ref.distance ?? 0);
    });

    let previousLevelRoot: Node | null = null;
    const baseTriangles = subtreeTriangles(lod0);

    const newRefs: ModelLodDef[] = [];
    const newLevelIds: string[] = [];
    const newDistances: number[] = [];
    let totalBytesSaved = 0;

    try {
      for (let i = 0; i < specs.length; i++) {
        const level = i + 1;
        task.setStep(i, { status: 'running', detail: 'Decimating' });
        // CASCADE: level N is decimated from level N-1's subtree, not from LOD0 every time. Same final
        // ratios (the spec ratio is re-expressed against the previous level below), roughly half the
        // total decimation work, and each step is a gentler reduction than one big jump from full detail.
        const from = previousLevelRoot ?? lod0;
        const previousRatio = i === 0 ? 1 : specs[i - 1].ratio;
        const stepRatio = Math.min(0.99, specs[i].ratio / previousRatio);
        const built = await generateLodLevel(from, level, { ...specs[i], ratio: stepRatio }, {
          downscaleTextures: downscale,
          decimate: decimateGeometry,
        });

        // A preview of the level, as a SIBLING of level 0 — the levels are alternatives, and parenting
        // one to another would serialize it into the asset on the next save. The level's materials are
        // inline (no __materialId), so there is nothing to resolve against the library.
        const clone = deepClone(built.nodeJson);
        regenerateIds(clone, new Map());
        // Exactly what a placement will draw: the level's version of the current library material.
        resolveMaterialRefs(clone, materialsRef.current);
        clone.name = `${tab.title} LOD${level}`;
        parseLodPreview(runtime.scene, clone);

        // The subtree just parsed into the tab scene IS the next level's source.
        previousLevelRoot = runtime.scene.getNodeById(clone.id) ?? previousLevelRoot;

        newRefs.push({ generated: true, nodeJson: built.nodeJson, distance: specs[i].distance });
        newLevelIds.push(clone.id);
        newDistances.push(specs[i].distance);
        totalBytesSaved += built.bytesSaved;
        task.setStep(i, {
          status: 'done',
          // Against LOD0, not against the level this one was cascaded from — the percentage the user
          // asked for is the absolute one.
          detail: `${built.triangles.toLocaleString()} tris (${Math.round((built.triangles / Math.max(1, baseTriangles)) * 100)}%)`,
        });
      }

      const levelIds = [...keptLevelIds, ...newLevelIds];
      const distances = [...keptDistances, ...newDistances];
      // Seed a cull distance past the last band, when the asset has none.
      //
      // Generation never set one, and an unset cull falls back to the renderer's GLOBAL foliage
      // distance of 65 m — so a ladder ending at 64 m kept its cheapest level alive for a single
      // metre, and the 10%-triangle level the user just waited for was never drawn at all. PAST the
      // last band rather than at it, so the coarsest level gets a band of its own; and only when
      // unset, so a hand-authored value is never overwritten.
      const lastBand = distances.length ? Math.max(...distances) : 0;
      const cullDistance = session.cullDistance > 0
        ? session.cullDistance
        : Math.round(lastBand * LOD_CULL_MARGIN);
      const next: ModelEditSession = {
        ...session,
        levelIds,
        lodRefs: [...keptRefs, ...newRefs],
        distances,
        cullDistance,
        activeLevel: 0, // back to the authored mesh; the levels are there to inspect deliberately
      };
      setModelSessions(prev => ({ ...prev, [tab.id]: next }));
      modelSessionsRef.current = { ...modelSessionsRef.current, [tab.id]: next };
      applyActiveModelLevel(runtime.scene, levelIds, 0);
      markTabDirty(tab.id, 'model-lod-add');
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
      Logger.info(
        `Generated ${specs.length} LOD level${specs.length === 1 ? '' : 's'} for "${tab.title}"` +
        (totalBytesSaved > 0 ? ` — ${(totalBytesSaved / (1024 * 1024)).toFixed(1)} MB less texture data` : ''),
        'Editor');
    } catch (e) {
      Logger.error('LOD generation failed: ' + e, 'Editor');
      for (let i = 0; i < specs.length; i++) task.setStep(i, { status: 'failed', error: String(e) });
    } finally {
      task.finish();
    }
  };

  // Remove an extra LOD level (level 0 is the asset itself and cannot be removed).
  const removeModelLod = (level: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'model' || level < 1) return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = modelSessions[tab.id];
    if (!runtime || !session || level >= session.levelIds.length) return;

    const root = runtime.scene.getNodeById(session.levelIds[level]);
    if (root?.parent) root.parent.removeChild(root);
    disposeModelSubtree(root);

    const levelIds = session.levelIds.filter((_, i) => i !== level);
    const distances = session.distances.filter((_, i) => i !== level);
    // lodRefs is offset by one (it has no entry for level 0), so drop index level-1.
    const lodRefs = session.lodRefs.filter((_, i) => i !== level - 1);
    const activeLevel = Math.min(session.activeLevel >= level ? session.activeLevel - 1 : session.activeLevel, levelIds.length - 1);
    setModelSessions(prev => ({ ...prev, [tab.id]: { ...session, levelIds, lodRefs, distances, activeLevel: Math.max(0, activeLevel) } }));
    applyActiveModelLevel(runtime.scene, levelIds, Math.max(0, activeLevel));
    markTabDirty(tab.id, 'model-lod-remove');
  };

  const setModelLodDistance = (level: number, distance: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'model' || level < 1) return;
    const session = modelSessions[tab.id];
    if (!session || level >= session.distances.length) return;
    const distances = session.distances.map((d, i) => i === level ? Math.max(0, distance) : d);
    setModelSessions(prev => ({ ...prev, [tab.id]: { ...session, distances } }));
    markTabDirty(tab.id, 'model-lod-distance');
  };

  const setModelCullDistance = (distance: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'model') return;
    const session = modelSessions[tab.id];
    if (!session) return;
    const cullDistance = Math.max(0, distance);
    // Levels are placed as a share of the cull (the inspector's slider), so they move with it.
    const distances = rescaleLodDistances(session.distances, session.cullDistance, cullDistance);
    setModelSessions(prev => ({ ...prev, [tab.id]: { ...session, cullDistance, distances } }));
    markTabDirty(tab.id, 'model-cull-distance');
  };

  const setActiveModelLevel = (level: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'model') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = modelSessions[tab.id];
    if (!runtime || !session || level < 0 || level >= session.levelIds.length) return;
    setModelSessions(prev => ({ ...prev, [tab.id]: { ...session, activeLevel: level } }));
    // The ref is normally refreshed on the next render, but SELECT_NODE is coerced to the ACTIVE level's
    // root (model tabs pin their selection), so it has to be current before the emit below or the
    // selection snaps straight back to the level we just left.
    modelSessionsRef.current = { ...modelSessionsRef.current, [tab.id]: { ...session, activeLevel: level } };
    applyActiveModelLevel(runtime.scene, session.levelIds, level);
    eventEmitter.current.emit('SELECT_NODE', session.levelIds[level]);
  };

  /**
   * The model asset a node belongs to — its own back-link, or the asset the current tab is editing. The tab
   * fallback is required: a model tab parses `asset.nodeJson`, which has the back-link stripped, so without
   * it adopting would file a duplicate copy of the model already being edited.
   */
  const resolveModelAssetId = (node: Node | null | undefined): string | undefined => {
    const own = modelIdOf(node);
    if (own) return own;
    const tabOf = (id: string | undefined) => (id ? tabsRef.current.find(t => t.id === id) : undefined);
    const active = tabOf(activeTabIdRef.current);
    if (active?.kind === 'model') return active.modelId ?? undefined;
    // An animation/field tab records which tab it was opened from; a model tab there is the same case.
    const source = tabOf(tabRuntimeRef.current.get(activeTabIdRef.current)?.sourceTabId);
    return source?.kind === 'model' ? (source.modelId ?? undefined) : undefined;
  };

  /**
   * The model asset a node belongs to, creating one from its subtree when it has none. Called only from
   * actions that actually need an asset (link an animation, create a field, open the model editor) — never
   * from rendering, so selecting a node cannot spawn library entries.
   */
  const adoptModelAsset = async (node: Node | null | undefined): Promise<string | null> => {
    if (!node) return null;
    const existing = resolveModelAssetId(node);
    if (existing) return existing;

    // The node AS GIVEN, not the ModelNode found under it: a skinned import cannot bake its fit-to-size
    // factor into vertices, so that factor lives on the holder ABOVE the skinned node (normalizeRootScale).
    // A subtree with no geometry would produce an asset that renders as nothing — refuse instead.
    if (!modelNodeOf(node)) return null;

    const materialIds = new Set<string>();
    const collect = (n: Node) => { for (const id of getMaterialIdsOf(n)) if (id) materialIds.add(id); n.children.forEach(collect); };
    collect(node);

    const asset = flattenModelAsset(await buildModelAsset(node, [...materialIds], ''));
    asset.name = node.name || 'Model';
    // Drop where this copy happens to sit — that is the placement, not the model. Rotation and scale are
    // kept: those are the model's authored orientation and size (same rule as separateSubModels).
    if (asset.nodeJson) asset.nodeJson.position = [0, 0, 0];
    addModel(asset);
    // `modelsRef` is a RENDER mirror, so it still holds the pre-adoption array until the next commit.
    // Callers await this function and immediately look the new model up — `AnimationAssetPicker` does
    // exactly that — and would find nothing, making the drop a silent no-op. Mirroring eagerly is the
    // idiom already used for `persistedModelsRef`; the next render reassigns from state either way.
    modelsRef.current = [...modelsRef.current, asset];
    node.setVariable(MODEL_ID_VAR, asset.id, 'string');
    eventEmitter.current.emit('SCENE_CHANGED');
    Logger.info(`Added "${asset.name}" to the model library`, 'Editor');
    return asset.id;
  };

  // Open (or focus) the edit tab for a library mesh, rendering its thumbnail on the way in.
  const enterModelEditor = (modelId?: string, adoptTabId?: string) => {
    if (!instanceRef.current || !modelId) return;
    const asset = modelsRef.current.find(m => m.id === modelId);
    if (!asset) { Logger.error('Model not found', 'Editor'); return; }

    // Thumbnail + focus-existing are open-time concerns only — see enterMaterialEditor.
    if (!adoptTabId) {
      captureAssetThumbnail('model', modelId);
      const existing = tabs.find(t => t.kind === 'model' && t.modelId === modelId);
      if (existing) { setActiveTab(existing.id); return; }
    }
    openMeshTab(asset, adoptTabId);
  };

  // ---- Animation Field editor ------------------------------------------------------------------------
  const { enterAnimationFieldEditor, createAnimationFieldForModel, saveAnimationField } = useAnimationFieldEditor({
    instanceRef, animationFieldsRef, modelsRef, materialsRef, animationsRef, tabRuntimeRef,
    dirtyArmedRef, eventEmitter, tabs, setActiveTab, commitTab, withoutDirty, liveScenes,
    markTabDirty, addAnimationField, updateAnimationField, ensureRigForModel,
  });

  /** Late binding for `applyActiveTab`, which is declared below the sessions that need it. */
  const applyActiveTabRef = useRef<((tab: EditorTab) => void) | null>(null);

  // ---- Rig editor ------------------------------------------------------------------------------------
  const { enterRigEditor, setRigPreviewModel, rigPreviewModelId, saveRig, modelsOnRig } = useRigEditor({
    instanceRef, rigsRef, modelsRef, materialsRef, animationsRef, tabRuntimeRef,
    dirtyArmedRef, eventEmitter, tabs, setActiveTab, commitTab, withoutDirty, updateRig,
    clearTabDirty, activeTabId,
    // Through a ref: `applyActiveTab` is declared far below this call, and a rig only ever reaches it
    // from a click, never during render.
    applyActiveTab: (tab) => applyActiveTabRef.current?.(tab),
  });

  // ---- Clip editor -----------------------------------------------------------------------------------
  const {
    enterClipEditor, setClipPreviewModel, clipPreviewModelId, saveClip, saveClipAs, modelsForClip,
  } = useClipEditor({
    instanceRef, animationsRef, rigsRef, modelsRef, materialsRef, tabRuntimeRef,
    dirtyArmedRef, eventEmitter, tabs, setActiveTab, commitTab, setTabs, withoutDirty,
    updateAnimation, addAnimation, linkAnimationToRig, applyAnimationLinks,
    modelAnimationIdsOf: modelAnimationIds,
    clearTabDirty, activeTabId,
    // Through a ref, for the same reason the rig editor does it.
    applyActiveTab: (tab) => applyActiveTabRef.current?.(tab),
  });

  // ---- Tileset editor --------------------------------------------------------------------------------
  const { enterTilesetEditor, createTilesetFromImage, saveTileset } = useTilesetEditor({
    tilesetsRef, tabsRef, setTabs, eventEmitter,
    addTileset, updateTileset, setActiveTab, commitTab, clearTabDirty,
  });

  // ---- AI Brain editor -------------------------------------------------------------------------------
  const {
    enterAiBrainEditor, extractBrainFromController, linkBrainToController, saveAiBrain,
  } = useAiBrainEditor({
    aiBrainsRef, tabsRef, setTabs,
    addAiBrain, updateAiBrain, setActiveTab, commitTab, clearTabDirty,
  });

  // ---- Particle system editor ------------------------------------------------------------------------
  const {
    enterParticleSystemEditor, linkParticleSystemToNode, extractParticleSystemFromNode, saveParticleSystem,
  } = useParticleSystemEditor({
    instanceRef, particleSystemsRef, tabRuntimeRef, editorSceneRef, dirtyArmedRef, eventEmitter,
    tabsRef, setTabs, setActiveTab, commitTab, withoutDirty, markTabDirty, clearTabDirty,
    addParticleSystem, updateParticleSystem,
  });

  // ---- Texture editor --------------------------------------------------------------------------------
  const { enterSoundEditor, saveSoundSample, previewSoundSettings } = useSoundEditor({
    soundSamplesRef, tabsRef, setTabs, updateSoundSample, setActiveTab, commitTab, clearTabDirty,
  });

  const { enterTextureEditor, saveTexture, previewTextureSettings } = useTextureEditor({
    texturesRef, tabsRef, setTabs, updateTextureAsset, setActiveTab, commitTab, clearTabDirty,
  });

  // Import one or more model files (and folders) into the mesh library: one bundle per model file, each
  // parsed, reviewed in the import modal (missing textures + scale normalization), then normalized, its
  // materials registered as MaterialAssets linked via __materialId, and stored. Placement is drag-only.
  const importModelFiles = async (files: File[]) => {
    const engine = instanceRef.current;
    if (!engine) { Logger.error('Engine not ready for import', 'Editor'); return; }
    const bundles = groupImportFiles(files);
    if (bundles.length === 0) { Logger.warn('No model files (.gltf/.glb/.obj/.fbx) found in the selection', 'Editor'); return; }

    const task = startTask({
      title: 'Importing models',
      steps: bundles.map(b => ({ name: b.name, status: 'pending' as StepStatus, detail: 'Queued' })),
      cancellable: true,
      // Settling the review modal lets a loop parked on it reach the cancel check below. cancelAllImports
      // also terminates the worker — the only way to stop an assimp parse, which is one WASM call.
      onCancel: () => {
        cancelAllImports();
        if (pendingResolverRef.current) resolveModelImport(null);
      },
    });

    // Clips are lifted into shared `.anim` assets as each bundle commits, instead of being left embedded
    // in the subtree. The loader hands the SAME animation list to EVERY skinned sub-mesh of a file, so
    // "Separate sub-models" would otherwise write a full copy of the whole clip set into each of N assets
    // — which is how a character import produced assets too large to even deep-copy. extractEmbeddedClips
    // matches on clip CONTENT, so the N pieces of one character all link to the same clip assets.
    //
    // The library is threaded through a local: setAnimations does not land between two bundles of one
    // import, so reading the ref again would drop the previous bundle's extractions.
    let animLib = animationsRef.current;
    const commitModels = (assets: ModelAsset[]) => {
      const r = extractEmbeddedClips(assets, animLib, skinnedModelJsonOf, assetWithoutEmbeddedClips);
      if (r.extracted || r.shared) {
        animLib = r.animations;
        setAnimations(r.animations);
        Logger.info(`Stored ${r.extracted} clip${r.extracted === 1 ? '' : 's'} as animation assets` +
          (r.shared ? `, ${r.shared} shared with a model already in the library` : ''), 'Import');
      }
      // Give each character's skeleton an identity at import, so a model and the clips imported for it
      // land on ONE rig. Without this the migration would have to sweep up after every import — which is
      // exactly the v1->v2 mistake the comment above records.
      for (const asset of r.models) {
        const skin = skinnedModelJsonsOf(asset.nodeJson)[0]?.skin;
        const rig = ensureRig(storeSkin(skin), asset.name);
        // The lifted clips come back as links on the MODEL (`extractEmbeddedClips` is shared with the load
        // migration, which moves them later). The skeleton is the only clip owner now, so they go there at
        // once: left on the model they would be read by nothing and the character would import clip-less.
        const { animationIds: lifted = [], ...model } = asset as ModelAsset & { animationIds?: string[] };
        if (rig && lifted.length) {
          let owner = rigsRef.current.find(x => x.id === rig.id) ?? rig;
          for (const id of lifted) owner = withAnimationRef(owner, id);
          updateRig(rig.id, owner);
          // They were authored on this very skeleton, which is what their rig must say.
          animLib = animLib.map(a => (lifted.includes(a.id) && !a.rigId ? { ...a, rigId: rig.id } : a));
          animationsRef.current = animLib;
          setAnimations(animLib);
        }
        addModel(rig ? { ...model, rigId: rig.id } : model);
      }
    };

    // Map an import stage onto the store's generic step. One place, so the labels and the bar can't drift.
    // `within` (0..1) is how far through the stage the worker says it is: the parse is most of an
    // import's time, and a bar parked at 15% for it read as a hang. It moves between the previous
    // stage's mark and this one's.
    const setStage = (index: number, stage: ImportStage, detail?: string, error?: string, within?: number) => {
      const s = IMPORT_STAGES[stage];
      const progress = within === undefined || stage !== 'parsing'
        ? s.progress
        : 0.02 + Math.max(0, Math.min(1, within)) * (IMPORT_STAGES.review.progress - 0.03);
      task.setStep(index, {
        status: s.status,
        progress,
        detail: detail ?? (s.status === 'running' || s.status === 'paused' ? s.label : undefined),
        error,
      });
    };

    for (let i = 0; i < bundles.length; i++) {
      const bundle = bundles[i];

      // Cancellation is checked between bundles: a parse is one long JS task and cannot be interrupted
      // mid-flight, so "Cancel" honestly means "stop after the current model" — the window says as much.
      if (task.cancelled) {
        setStage(i, 'skipped', 'Cancelled before it started');
        continue;
      }

      try {
        // Parse for review (registers textures; broken slots for any files missing from the upload).
        setStage(i, 'parsing', `Reading ${bundle.files.length} file${bundle.files.length === 1 ? '' : 's'}`);
        let parsedResult: Awaited<ReturnType<typeof parseBundleToRoot>>;
        try {
          parsedResult = await parseBundleToRoot(bundle.files, bundle.name,
            (fraction, stage) => setStage(i, 'parsing', stage || undefined, undefined, fraction));
        }
        catch (e) {
          // A cancel terminates the worker, which rejects whatever it was parsing — report that as
          // cancelled rather than as a failure, since it is exactly what the user asked for.
          if (e instanceof ImportCancelled || task.cancelled) {
            setStage(i, 'skipped', 'Cancelled');
            continue;
          }
          Logger.warn(`${e}`, 'Editor');
          setStage(i, 'failed', undefined, `${e}`);
          continue;
        }
        let { root, children } = parsedResult;

        // Two sources, because neither is complete on its own: detectMissingTextures reads the source files
        // and can name an image that never reached the loader, but only for text formats; the loader's own
        // report covers every format, including FBX, whose references are binary.
        const byName = (list: UnresolvedTexture[]) => {
          const seen = new Map<string, UnresolvedTexture>();
          for (const t of list) if (!seen.has(t.name)) seen.set(t.name, t);
          return [...seen.values()];
        };
        const missing = byName([
          ...(await detectMissingTextures(bundle.files)).map(name => ({ name, from: 'referenced by the model file' })),
          ...parsedResult.textures.missingFiles,
        ]);
        const unloadable = byName(parsedResult.textures.unloadable);
        if (unloadable.length)
          Logger.warn(`"${bundle.name}": ${unloadable.length} texture reference(s) could not be loaded — ${unloadable.map(t => t.name).join(', ')}`, 'Editor');
        const sizeRadius = meshBoundsRadius(root);
        // Distinct materials, and which one each sub-mesh uses. The same serialized-material key dedupes
        // both, so `materialIndex` matches the MaterialAsset each part ends up linked to further down —
        // that is what makes "one group per material" a grouping the merge can never reject.
        const matKeys: string[] = [];
        const parts: PartInfo[] = children.map((c, n) => {
          const m = (c.model as any).material;
          const name = c.name || `${bundle.name}_${n + 1}`;
          if (!m) return { name, materialIndex: -1 };  // no material registers no asset; -1 is its own bucket
          const key = JSON.stringify(m.serialize());
          let materialIndex = matKeys.indexOf(key);
          if (materialIndex < 0) { materialIndex = matKeys.length; matKeys.push(key); }
          return { name, materialIndex };
        });

        // Park the parsed mesh and await the user's decision from ModelImportModal.
        setStage(i, 'review', missing.length
          ? `${missing.length} texture${missing.length === 1 ? '' : 's'} missing — awaiting review`
          : 'Awaiting review');
        const decision = await new Promise<ModelImportDecision | null>(resolve => {
          pendingResolverRef.current = resolve;
          setPendingModelImport({
            bundleName: bundle.name,
            subMeshCount: children.length,
            materialCount: matKeys.length,
            missing,
            unloadable,
            sizeRadius,
            parts,
          });
        });
        if (!decision) {
          Logger.info(`Import of "${bundle.name}" cancelled`, 'Editor');
          setStage(i, 'skipped', 'Cancelled at review');
          continue;
        }

        // The user uploaded previously-missing textures → re-parse so they wire into the materials.
        if (decision.extraFiles.length) {
          setStage(i, 'reparsing', `Linking ${decision.extraFiles.length} texture${decision.extraFiles.length === 1 ? '' : 's'}`);
          ({ root, children } = await parseBundleToRoot([...bundle.files, ...decision.extraFiles], bundle.name));
        }
        if (decision.normalize) {
          setStage(i, 'scaling', `Fitting to ${decision.targetSize} units`);
          normalizeRootScale(root, decision.targetSize);
        }

        // Textures decode asynchronously; wait for them before serializing any asset, otherwise
        // serializeTextureData drops not-yet-loaded textures and the material imports untextured.
        setStage(i, 'textures', 'Waiting for textures to decode');
        await awaitSubtreeTexturesReady(root);

        // Register a MaterialAsset per unique material (deduped within the bundle) and link each node.
        // Thumbnails are deliberately NOT rendered here — each capture is a full GL frame. Assets are stored
        // with an empty thumbnail; the real preview is rendered on first open (see captureAssetThumbnail).
        const materialIds: string[] = [];
        const assetByKey = new Map<string, MaterialAsset>();
        // Which material asset each sub-mesh ended up on — a separated asset must list only the materials
        // ITS own mesh uses, not every material in the file.
        const materialIdOfChild = new Map<ModelNode, string>();
        const materialAssetOfChild = new Map<ModelNode, MaterialAsset>();
        for (const child of children) {
          const mat = (child.model as any).material as Material;
          if (!mat) continue;
          const key = JSON.stringify(mat.serialize());
          let asset = assetByKey.get(key);
          if (!asset) {
            asset = buildMaterialAsset(mat, `${bundle.name} ${mat.type}`, '');
            assetByKey.set(key, asset);
            addMaterial(asset);
            materialIds.push(asset.id);
            setStage(i, 'materials', `Registering material ${materialIds.length} of ${matKeys.length}`);
          }
          applyMaterialAsset(child, asset); // stamps __materialId + rebuilds the node's material
          materialIdOfChild.set(child, asset.id);
          materialAssetOfChild.set(child, asset);
        }

        // Both toggles on = the user partitioned the parts in the modal: one asset per group, each group
        // merged. The grouping is re-validated because supplying missing textures re-parses the bundle
        // above — a grouping made against the old sub-mesh list must fall through, never be applied.
        const groups = decision.groups?.length ? compactGroups(decision.groups) : null;
        const grouped = groups && children.length > 1 && isValidGrouping(groups, children.length);
        if (groups && !grouped)
          Logger.warn(`Ignored the sub-mesh grouping for "${bundle.name}": it no longer matches the file's ${children.length} part(s)`, 'Import');

        if (grouped) {
          // Grouping happens AFTER the material assets exist, for the same reason the plain merge does:
          // each submesh has to carry its own __materialId into the merged node.
          setStage(i, 'saving', `Building ${groups.length} model${groups.length === 1 ? '' : 's'} from ${children.length} sub-meshes`);
          const assets = await groupSubModels(root, children, bundle.name, groups, materialIdOfChild, materialAssetOfChild);
          commitModels(assets);
          eventEmitter.current.emit('TEXTURES_CHANGED');

          const summary = `${assets.length} grouped model${assets.length === 1 ? '' : 's'}`;
          setStage(i, 'done', summary);
          Logger.info(`Imported "${bundle.name}" as ${summary} from ${children.length} sub-meshes`, 'Editor');
          continue;
        }

        const separate = decision.separate && children.length > 1;
        // Merge AFTER the material assets exist, so each submesh carries its own __materialId into the
        // merged node. Mutually exclusive with `separate`, which is the opposite operation.
        if (decision.merge && !separate && children.length > 1) {
          setStage(i, 'saving', `Merging ${children.length} sub-meshes`);
          const mergedChildren = mergeSubModels(root, children, materialAssetOfChild);
          if (mergedChildren) children = mergedChildren;
        }

        setStage(i, 'saving', separate
          ? `Creating ${children.length} separate assets`
          : 'Serializing to the model library');

        if (separate) {
          const assets = await separateSubModels(root, children, bundle.name, materialIdOfChild);
          commitModels(assets);
          eventEmitter.current.emit('TEXTURES_CHANGED');

          const summary = `${assets.length} separate model${assets.length === 1 ? '' : 's'}`;
          setStage(i, 'done', summary);
          Logger.info(`Imported "${bundle.name}" as ${summary}`, 'Editor');
        } else {
          // A file that places the model far from the origin (a scene placement baked into its root
          // matrix) would otherwise open as an empty model tab and drop out of sight when placed.
          if (recenterIfOffOrigin(root, children))
            Logger.info(`Re-centred "${bundle.name}": the file placed it away from the origin`, 'Import');
          // Collapse the import's holder into its single ModelNode, so a one-part model is ONE row in the
          // Scene panel instead of two identically-named ones. A multi-part model keeps its holder.
          const modelAsset = flattenModelAsset(await buildModelAsset(root, materialIds, ''));
          commitModels([modelAsset]);
          eventEmitter.current.emit('TEXTURES_CHANGED');

          const summary = `${children.length} sub-mesh${children.length === 1 ? '' : 'es'}, ${materialIds.length} material${materialIds.length === 1 ? '' : 's'}`;
          setStage(i, 'done', summary);
          Logger.info(`Imported model "${bundle.name}" (${summary})`, 'Editor');
        }
      } catch (err) {
        Logger.error(`Failed to import "${bundle.name}": ${err}`, 'Editor');
        setStage(i, 'failed', undefined, `${err}`);
        // Make sure a stuck modal is cleared if we errored mid-review.
        if (pendingResolverRef.current) { pendingResolverRef.current = null; setPendingModelImport(null); }
      }
    }

    task.finish();
  };

  // Save a material tab to the library (capturing a sphere thumbnail) and propagate to references.
  // captureMaterialSphere renders the tab's own scene offscreen, so this reaches a tab that is not on
  // screen. Async only because the thumbnail readback is; its camera and grid restores precede that.
  /**
   * Bring every generated LOD level derived from an edited Material up to date.
   *
   * A level resolves its material from the library when it is built (`resolveMaterialRefs`, through its
   * `__lodMaterialId` link), drawing each texture's twin at the level's size when one exists. An edit can
   * introduce a texture no twin was ever made for, so the twins are made first; then every placed copy and
   * foliage rule of the affected models is rebuilt, since nothing patches a level in place.
   */
  const refreshLodLevelsForMaterial = async (materialId: string, asset: MaterialAsset, exceptTabId?: string) => {
    const affected = modelsRef.current.filter(m => lodLevelMaterialLinks(m).has(materialId));
    if (!affected.length) return;
    const levels = new Set<number>();
    for (const m of affected) for (const l of lodLevelMaterialLinks(m).get(materialId) ?? []) levels.add(l);
    for (const level of levels) {
      try { await downscaleTextures(levelTextureIds(asset.material, level), level, new Set(maskTextureIds(asset.material))); }
      catch (e) { Logger.warn(`Could not make smaller textures for LOD${level}: ${e}`, 'Editor'); }
    }
    withoutDirty(() => {
      for (const m of affected) {
        // The model asset did not change, so its hash did not either; forget it or the rebuild is skipped.
        instantiatedHashRef.current.delete(m.id);
        syncModelInstances(m.id, m, exceptTabId);
        syncFoliageRulesForModel(m, exceptTabId);
      }
    });
    eventEmitter.current.emit('TEXTURES_CHANGED');
  };

  const saveMaterialTab = async (tabId: string) => {
    const instance = instanceRef.current;
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!instance || !tab || tab.kind !== 'material') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    if (!runtime) return;
    const sphere = runtime.scene.getNodeById(runtime.rootId) as ModelNode | null;
    if (!sphere || !sphere.model) return;
    try {
      const thumbnail = await captureMaterialSphere(instance, runtime.scene);
      if (tab.materialId) {
        const asset = buildMaterialAsset(sphere.model.material, tab.title, thumbnail, tab.materialId);
        updateMaterial(tab.materialId, asset);
        // Eager mirror: the ref only catches up on the next render, and every propagation below resolves
        // against it — foliage rules and LOD levels were rebuilt from the material as it was BEFORE this
        // save, so the edit never reached them.
        materialsRef.current = materialsRef.current.map(m => (m.id === tab.materialId ? asset : m));
        // Propagation edits other scenes and must not mark them dirty: they store the link (__materialId)
        // and resyncScene re-resolves it on open. Dirtying here would keep Save All from ever going clean.
        withoutDirty(() => {
          syncMaterialInstances(tab.materialId!, asset, tab.id); // push edits to placed references
          // Foliage prototypes bake their material inline and hang off no node, so the walk above
          // cannot reach them; this re-derives every scattered rule whose model links this material.
          syncFoliageRulesForMaterial(tab.materialId!, tab.id);
          // …and the landscape-material slots that embed a copy of it.
          syncTerrainMaterialSlots(tab.materialId!, asset, tab.id);
        });
        // …and the generated LOD levels derived from it — after their texture twins exist.
        void refreshLodLevelsForMaterial(tab.materialId, asset, tab.id);
      } else {
        const asset = buildMaterialAsset(sphere.model.material, tab.title, thumbnail);
        addMaterial(asset); // asset carries a fresh id
        setTabs(prev => prev.map(x => x.id === tab.id ? { ...x, materialId: asset.id } : x));
      }
      clearTabDirty(tab.id);
      Logger.info(`Material "${tab.title}" saved`, 'Editor');
    } catch (e) {
      Logger.error('Failed to save material: ' + e, 'Editor');
    }
  };

  // Rename the active material tab (bound to the name field in the material-mode inspector).
  const setActiveMaterialName = (name: string) => {
    setTabs(prev => prev.map(t => (t.id === activeTabId && t.kind === 'material') ? { ...t, title: name } : t));
    markTabDirty(activeTabId, 'material-rename');
  };

  // --- Terrain materials (mirror the material asset flow above, but assigned to terrain paint layers) ---

  // Re-apply a saved/edited terrain material to every terrain paint layer that references it (by
  // materialId), across every live scene except the editing tab's own preview terrain.
  const syncTerrainMaterialInstances = (id: string, asset: TerrainMaterialAsset, exceptTabId?: string) => {
    let changed = false;
    for (const scene of liveScenes(exceptTabId)) {
      for (const ln of Array.from(scene.landscapes) as any[]) {
        const terrain = ln.terrain;
        const layers = terrain?.layers ?? [];
        for (let i = 0; i < layers.length; i++) {
          // Density lives on the rule and is authored HERE, so this is the one propagation path that
          // may re-scatter — and only for a layer whose density actually moved.
          if (layers[i]?.materialId === id) {
            applyTerrainMaterialToLayer(terrain, i, asset, { rescatterOnDensityChange: true });
            changed = true;
          }
        }
      }
    }
    if (changed) { eventEmitter.current.emit('TEXTURES_CHANGED'); eventEmitter.current.emit('SCENE_CHANGED'); }
  };

  // Delete a terrain-material asset: clear any terrain layer referencing it and force-close its editor tab.
  const removeTerrainMaterial = (id: string) => {
    const scene = editorSceneRef.current;
    let changed = false;
    for (const ln of Array.from(scene.landscapes) as any[]) {
      const terrain = ln.terrain;
      const layers = terrain.layers;
      for (let i = 0; i < layers.length; i++) {
        if (layers[i]?.materialId === id) { terrain.clearLayer(i); changed = true; }
      }
    }
    if (changed) { eventEmitter.current.emit('TEXTURES_CHANGED'); eventEmitter.current.emit('SCENE_CHANGED'); }
    const openTab = tabs.find(t => t.kind === 'terrainMaterial' && t.terrainMaterialId === id);
    if (openTab) removeTabById(openTab.id);
    setTerrainMaterials(prev => prev.filter(x => x.id !== id));
  };

  // Build a terrain-material editor tab: a preview sphere carrying the TerrainMaterial to edit (its base
  // surface previews as a normal Basic/Blinn/PBR sphere; blend + foliage are edited in the inspector).
  const openTerrainMaterialTab = (asset: TerrainMaterialAsset | null, adoptTabId?: string) => {
    // Disarm dirty-tracking before building the preview scene: SCENE_CHANGED names no scene, so mark()
    // can only blame the ACTIVE tab. The tab-activate effect re-arms once the new tab is showing.
    dirtyArmedRef.current = false;
    const scene = new Scene();
    // Framed for a terrain PATCH, not the unit sphere the ordinary material editor previews.
    void createMaterialPreviewScene(scene, { subjectRadius: PREVIEW_TERRAIN_RADIUS, silently: withoutDirty });
    const tm = asset ? parseTerrainMaterialAsset(asset) : TerrainMaterial.Create('pbr', { baseColor: [0.38, 0.5, 0.28] });
    // A REAL landscape, not a sphere borrowing the composite material. Terrain relief is geometry now —
    // the layer displaces the terrain's own vertices and the march is off for it — so a sphere shows the
    // albedo and nothing else. See `buildTerrainPreviewSubject` for the two less obvious things this
    // also fixes (the pack being resolved once and then swept).
    // Scaled against the landscape the material will actually be painted on, so metres-per-repeat and
    // metres-per-vertex match and the preview resolves the same geometry/march split the ground does.
    const previewNode = buildTerrainPreviewSubject(scene, tm, activeLandscapeTerrain());
    const helperTerrain = previewNode.terrain;
    // The sphere shape draws with the patch's own composite material, so the patch stays in the scene
    // (hidden) whichever shape is showing: its layer stack is what the renderer syncs.
    const previewSphere = terrainPreviewSphere(helperTerrain);
    scene.addNode(previewSphere);
    scene.start();
    applyTerrainPreviewShape(scene, {
      landscape: previewNode, sphere: previewSphere, material: tm,
      referenceSize: activeLandscapeTerrain()?.size ?? REFERENCE_LANDSCAPE.size,
    }, loadPreviewShape('terrainMaterial'));
    // Unrendered node whose material IS the TerrainMaterial — the MaterialEditor/inspector edit target.
    const editNode = new ModelNode('__tmedit', new Model(Geometry.Sphere(8), tm));

    const tabId = adoptTabId ?? cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: previewNode.id, tm, helperTerrain, editNode, previewSphere });
    commitTab(
      { id: tabId, kind: 'terrainMaterial', title: asset?.name ?? 'New Landscape Material', terrainMaterialId: asset?.id ?? null },
      adoptTabId,
    );
  };

  /**
   * The terrain a material preview should be scaled against: the scene's own landscape.
   *
   * A terrain material's tiling is a COUNT across the whole terrain and its relief depth is world
   * metres, so neither number means anything without a size to read it against. The first landscape is
   * the right answer in every practical case — a scene with two differently-sized terrains cannot have
   * one honest preview anyway, and picking one beats picking the patch's own 8 m.
   */
  const activeLandscapeTerrain = (): Terrain | null => {
    for (const l of editorSceneRef.current.landscapes) return l.terrain;
    return null;
  };

  /** The active tab's landscape-material preview, or null when it is not one. */
  const terrainPreviewOf = (tabId: string): TerrainPreview | null => {
    const runtime = tabRuntimeRef.current.get(tabId);
    if (!runtime?.helperTerrain || !runtime.tm || !runtime.previewSphere) return null;
    const landscape = runtime.scene.getNodeById(runtime.rootId);
    if (!(landscape instanceof LandscapeNode)) return null;
    return {
      landscape, sphere: runtime.previewSphere, material: runtime.tm,
      referenceSize: activeLandscapeTerrain()?.size ?? REFERENCE_LANDSCAPE.size,
    };
  };

  // Re-derive the composite preview from the edited TerrainMaterial after any inspector change. The
  // material IS the preview's base (not a copy), so only the stack's flattening and the preview's
  // tiling scale and elevation mapping need refreshing — a rule edit can move the span the preview shows.
  const refreshTerrainMaterialPreview = () => {
    const preview = terrainPreviewOf(activeTabId);
    if (preview) updateTerrainPreviewMapping(preview, loadPreviewShape('terrainMaterial'));
  };

  // The preview-shape switch. View state, so none of it is an edit: the swap runs inside withoutDirty.
  const setPreviewShape = (shape: PreviewShape) => {
    const runtime = tabRuntimeRef.current.get(activeTabId);
    if (!runtime) return;
    if (activeTab.kind === 'material') {
      savePreviewShape('material', shape);
      const subject = runtime.scene.getNodeById(runtime.rootId);
      if (subject instanceof ModelNode) withoutDirty(() => applyMaterialPreviewShape(runtime.scene, subject, shape));
    } else if (activeTab.kind === 'terrainMaterial') {
      savePreviewShape('terrainMaterial', shape);
      const preview = terrainPreviewOf(activeTabId);
      if (preview) withoutDirty(() => applyTerrainPreviewShape(runtime.scene, preview, shape));
    }
  };

  const previewElevationLegend = (): string | null => {
    const preview = terrainPreviewOf(activeTabId);
    return preview ? elevationLegend(preview, loadPreviewShape('terrainMaterial')) : null;
  };

  const enterTerrainMaterialEditor = (terrainMaterialId?: string, adoptTabId?: string) => {
    if (!instanceRef.current) return;
    if (terrainMaterialId) {
      if (!adoptTabId) {
        captureAssetThumbnail('terrainMaterial', terrainMaterialId); // opening is what produces the preview
        const existing = tabs.find(t => t.kind === 'terrainMaterial' && t.terrainMaterialId === terrainMaterialId);
        if (existing) { setActiveTab(existing.id); return; }
      }
      const asset = terrainMaterialsRef.current.find(m => m.id === terrainMaterialId);
      if (!asset) { Logger.error('Terrain material not found', 'Editor'); return; }
      openTerrainMaterialTab(asset, adoptTabId);
    } else {
      openTerrainMaterialTab(null);
    }
  };

  // Save a terrain-material tab to the library (capturing a sphere thumbnail) + propagate to layers.
  const saveTerrainMaterialTab = async (tabId: string) => {
    const instance = instanceRef.current;
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!instance || !tab || tab.kind !== 'terrainMaterial') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    if (!runtime) return;
    const material = runtime.tm; // the edited TerrainMaterial (the preview node carries the composite)
    if (!material) return;
    try {
      const thumbnail = await captureMaterialSphere(instance, runtime.scene);
      if (tab.terrainMaterialId) {
        const asset = buildTerrainMaterialAsset(material, tab.title, thumbnail, tab.terrainMaterialId);
        updateTerrainMaterial(tab.terrainMaterialId, asset);
        withoutDirty(() => syncTerrainMaterialInstances(tab.terrainMaterialId!, asset, tab.id));
      } else {
        const asset = buildTerrainMaterialAsset(material, tab.title, thumbnail);
        addTerrainMaterial(asset);
        setTabs(prev => prev.map(x => x.id === tab.id ? { ...x, terrainMaterialId: asset.id } : x));
      }
      clearTabDirty(tab.id);
      Logger.info(`Terrain material "${tab.title}" saved`, 'Editor');
    } catch (e) {
      Logger.error('Failed to save terrain material: ' + e, 'Editor');
    }
  };

  const setActiveTerrainMaterialName = (name: string) => {
    setTabs(prev => prev.map(t => (t.id === activeTabId && t.kind === 'terrainMaterial') ? { ...t, title: name } : t));
    markTabDirty(activeTabId, 'terrain-material-rename');
  };

  // Keep non-reactive mirrors of the active tab (read by the once-registered SCENE_CHANGED/dimension listeners).
  useEffect(() => { activeTabIdRef.current = activeTabId; activeTabKindRef.current = activeTab.kind; }, [activeTabId, activeTab.kind]);

  // Arm dirty-tracking for the scene tab on a cold start: the tab-activate effect below bails while
  // instanceRef is null, and the scene tab never "switches". Wait for the same settle window the switch
  // path uses, so the editor-helper reconciler's opening SCENE_CHANGED burst doesn't read as an edit.
  useEffect(() => {
    if (!isSceneReady) return;
    requestAnimationFrame(() => requestAnimationFrame(() => { dirtyArmedRef.current = true; }));
  }, [isSceneReady]);

  /**
   * Put the engine behind a tab: swap in its scene, set the grid/dimension and reset the selection.
   * Separate from the effect below, which cannot cover boot: it bails while `instanceRef` is null and its
   * only dep is `activeTabId`, which does not change during boot. The boot effect calls this directly.
   */
  const applyActiveTab = (tab: EditorTab) => {
    const instance = instanceRef.current;
    if (!instance) return;
    // Disarm FIRST: everything below touches the scene (setScene, the helper reconcile it triggers, the
    // emits at the end), and any of it reaching mark() would land on the tab we are switching to. Re-armed
    // two frames later, once the editor-helper reconciler's opening pass has settled.
    dirtyArmedRef.current = false;
    activeTabKindRef.current = tab.kind;
    const runtime = tab.kind !== 'scene' ? tabRuntimeRef.current.get(tab.id) : undefined;
    instance.setScene(runtime ? runtime.scene : editorSceneRef.current);
    // Hide the editor ground grid in (terrain-)material tabs so the preview sphere + its thumbnail stay clean.
    // Elsewhere defer to the debug-visibility channel in force rather than forcing it on -- this also runs on
    // the two-phase "Play from an asset tab" path, which would otherwise show the grid over the play session.
    instance.renderer.setGridVisible(
      tab.kind !== 'material' && tab.kind !== 'terrainMaterial'
      && (isPlayModeRef.current && !isSimulatingRef.current ? debugVisibilityRef.current.grid.runtime : debugVisibilityRef.current.grid.editor));
    // Auto-exposure meters the scene tab only; every other tab is a preview under a fixed studio rig.
    // The project's `autoExposureEnabled` setting is untouched — this is a separate suppression, so a
    // tab switch neither fights the saved value nor marks the scene dirty.
    instance.renderer.setExposureMeteringAllowed(TAB_METERS_EXPOSURE[tab.kind]);
    // ...and the project's post chain with it: a preview tab shows the asset, not the scene's look.
    instance.renderer.setPostProcessingAllowed(TAB_RUNS_POST_PROCESSING[tab.kind]);
    requestAnimationFrame(() => requestAnimationFrame(() => { dirtyArmedRef.current = true; }));
    // Template scenes are authored in 3D; the Main tab restores its own remembered dimension. (Terrain-)
    // material tabs are skipped: their preview camera uses a self-contained orbit rig
    // (createMaterialPreviewScene) that the free-fly CHANGE_DIMENSION handler must not overwrite.
    if (tab.kind !== 'material' && tab.kind !== 'terrainMaterial')
      setViewDimension(tab.kind === 'scene' ? viewDimensionRef.current : '3D');
    eventEmitter.current.emit('TEXTURES_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    // Animation tabs select via the skeleton tree (SELECT_JOINT), not the mesh, so start with none.
    eventEmitter.current.emit('SELECT_NODE', (runtime && tab.kind !== 'stateMachine' && tab.kind !== 'animation') ? runtime.rootId : null);
  };
  applyActiveTabRef.current = applyActiveTab;


  // Switch the engine to the active tab's scene whenever the active tab changes.
  useEffect(() => {
    // Play owns the engine's scene while it runs: startPlay installs a built play scene, and letting a tab
    // switch reinstall an editor scene on top of it would wipe the running game.
    if (isPlayModeRef.current) return;
    applyActiveTab(tabsRef.current.find(t => t.id === activeTabId) ?? tabsRef.current[0]);
  }, [activeTabId]);

  // The scene tab is titled with the scene asset it is showing, not a fixed label. Follows both a scene
  // switch (openSceneId) and a rename (sceneList).
  useEffect(() => {
    const name = sceneList.find(s => s.id === openSceneId)?.name;
    if (!name) return;
    setTabs(prev => prev.map(t => (t.id === SCENE_TAB_ID && t.title !== name ? { ...t, title: name } : t)));
  }, [sceneList, openSceneId]);

  // Mark the active tab dirty on scene edits (after the open-settle window). Every tab kind goes through
  // the same dirtyTabs entry, the scene tab included. Play mode never marks dirty (it runs a separate play
  // scene), and neither does propagation (see dirtySuppressRef).
  useEffect(() => {
    const mark = (e?: SceneChange) => {
      // Guards are split one per line so the Dirty channel can name which one rejected a mark (verbose
      // mode). Behaviour is unchanged when the channel is off — logDirtySkip is then a no-op.
      if (!dirtyArmedRef.current) return logDirtySkip('not-armed', e);
      if (isPlayModeRef.current) return logDirtySkip('play-mode', e);
      if (dirtySuppressRef.current) return logDirtySkip('suppressed', e);
      // Ignore mutations to editor-owned nodes (Node.isEditorOwned): the free-fly camera, gizmo handles, helper
      // icons and wireframes, brush cursors, preview props. None is a user edit. The engine stamps the answer
      // on the payload at emit time, which is the only correct source for a removal and for a plain child of
      // an owned group. Their property events never get this far, because the engine does not emit them.
      if (isEditorOwnedChange(e)) return logDirtySkip('editor-owned', e);
      // An engine event names the scene its node was in, and only a change to the scene on screen can be
      // an edit of the active tab. `null` is a subtree still being built. A parse attaches every node
      // before its parent, so a preview character, a thumbnail or a foliage prototype emits a burst of
      // unowned adds whose flag only its topmost holder carries. Any OTHER scene is another document: the
      // play scene, a background tab, a throwaway thumbnail scene. An event the editor emits itself carries
      // no `scene` at all, so this never touches the payload-less "something changed" that most panels send.
      if (e?.scene !== undefined && e.scene !== instanceRef.current?.scene) return logDirtySkip('other-scene', e);
      markTabDirty(activeTabIdRef.current, describeChange(e));
    };
    const emitter = eventEmitter.current;
    emitter.on('SCENE_CHANGED', mark);
    return () => { emitter.off('SCENE_CHANGED', mark); };
  }, []);

  // Update the project meta (authoritative ref + reactive mirrors) and persist it.
  const updateProjectMeta = async (mutate: (m: ProjectMeta) => ProjectMeta): Promise<void> => {
    const current = projectMetaRef.current;
    if (!current) return;
    const next = mutate(current);
    projectMetaRef.current = next;
    setSceneList(next.scenes);
    setMainSceneIdState(next.mainSceneId);
    setOpenSceneIdState(next.openSceneId);
    openSceneIdRef.current = next.openSceneId;
    try { await saveProjectMeta(next); } catch (e) { console.warn('Failed to persist project meta:', e); }
  };

  const replaceProjectMeta = async (meta: ProjectMeta): Promise<void> => {
    const scenes = meta.scenes.length ? meta.scenes : [{ id: meta.mainSceneId, name: 'Main', updatedAt: Date.now() }];
    const next: ProjectMeta = {
      ...meta,
      scenes,
      mainSceneId: scenes.some(s => s.id === meta.mainSceneId) ? meta.mainSceneId : scenes[0].id,
      openSceneId: scenes.some(s => s.id === meta.openSceneId) ? meta.openSceneId : scenes[0].id,
    };
    projectMetaRef.current = next;
    setSceneList(next.scenes);
    setMainSceneIdState(next.mainSceneId);
    setOpenSceneIdState(next.openSceneId);
    openSceneIdRef.current = next.openSceneId;
    try { await saveProjectMeta(next); } catch (e) { console.warn('Failed to persist imported project meta:', e); }
  };

  /** Serialize the current (open) scene and write its blob + updated meta. The core of "Save". */
  const saveCurrentScene = async (): Promise<boolean> => {
    const sceneId = openSceneIdRef.current;
    if (!sceneId) return false;
    try {
      const gameData = await buildGameData({
        scene: editorSceneRef.current,
        scripts: scriptsRef.current,
        scriptAssets: scriptAssetsRef.current,
        bodies: bodiesRef.current,
        triggers: triggersRef.current,
        settings: instanceRef.current?.renderer.getRenderSettings(),
        // Texture payloads live in the texture store; scene blobs never embed them.
        useCache: true,
      });
      const now = Date.now();
      const scene = editorSceneRef.current;
      // TWO material sets, and they must not be merged.
      //
      // `matSetWide` folds in every library model's materials, placed or not. That is what the SAVE-TIME
      // HASHES want: a closed scene must be able to tell that a material changed while it was closed, and
      // it reaches that material only through a model it places.
      //
      // `refs` is the scene's OWN reference list — only what its nodes literally name. Using the wide set
      // there is what made every scene edge directly to almost every asset in the project.
      const matSetWide = collectReferencedMaterialIds(scene, models);
      const modelSet = collectReferencedModelIds(scene);
      const tplSet = collectReferencedTemplateIds(scene);
      const tmSet = collectReferencedTerrainMaterialIds(scene);
      const scriptSet = collectReferencedScriptIds(scene);
      const tilesetSet = collectReferencedTilesetIds(scene);
      const refs: SceneRefs = buildSceneRefs(
        scene, instanceRef.current?.renderer.getRenderSettings(), soundSamples, models, rigs,
      );
      // Per-asset content hashes let a *closed* scene tell, when reopened, which referenced assets
      // changed while it was closed — so unchanged models/templates aren't needlessly re-instantiated.
      const assetHashes = buildAssetHashes(
        { materialIds: matSetWide, modelIds: modelSet, templateIds: tplSet, terrainMaterialIds: tmSet, scriptIds: scriptSet, tilesetIds: tilesetSet },
        currentLibs(),
      );
      await saveSceneData(sceneId, { ...gameData, assetHashes, assetHashVersion: ASSET_HASH_VERSION, savedAt: now });
      // The AUTHORED dimension, never the view: saving while merely LOOKING at a 3D scene through the
      // orthographic camera must not rewrite it as 2D and make a publish discard its landscape.
      const authored = dimensionOfScene(sceneId);
      await updateProjectMeta(m => ({
        ...m,
        // prefs.dimension is legacy and project-wide; the rig belongs to the scene. Still written so a
        // build that reads it lands on something sensible.
        prefs: { dimension: authored, selectedNode },
        scenes: m.scenes.map(s => s.id === sceneId
          ? { ...s, updatedAt: now, refs, dimension: authored }
          : s),
      }));
      clearTabDirty(SCENE_TAB_ID);
      // Keep the project browser's card honest: its "last opened" ordering and cover image come from the
      // registry, which nothing else in the editor writes. Best-effort — a failure here must not fail a save.
      void touchProject(
        activeProjectId(),
        projectMetaRef.current?.scenes.find(s => s.id === projectMetaRef.current?.mainSceneId)?.thumbnail,
      ).catch(() => { /* ignore */ });
      return true;
    } catch (e: any) {
      Logger.error(`Failed to save scene: ${e?.message || e}`, 'Editor');
      return false;
    }
  };

  // ---- Saving: one action per tab, plus Save All ------------------------------------------------
  const {
    registerAnimationApply, registerTilesetApply, registerTextureApply, registerSoundApply,
    registerAiBrainApply, registerParticleSystemApply, registerRigApply, registerClipApply, saveTabById, runSave,
    saveActiveTab, saveAll, saveProjectToStorage,
  } = useSaving({
    tabsRef, dirtyTabsRef, activeTabIdRef, setSavingState,
    saveCurrentScene, saveTemplateTab, saveModelTab, saveMaterialTab, saveTerrainMaterialTab, saveScriptTab,
    setActiveTab,
  });

  // ---- Scene assets (multi-scene project) ------------------------------------------------------

  /** A name not already used by another scene, suffixing " (2)", " (3)", … */
  const uniqueSceneName = (base: string, scenes: SceneMeta[]): string => {
    const taken = new Set(scenes.map(s => s.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} (${n})`)) n++;
    return `${base} (${n})`;
  };

  /** Serialized blob for a brand-new empty scene (default light; the editor camera is stripped). */
  const buildEmptySceneData = async () => {
    const tmp = new Scene();
    createEmptyScene(tmp);
    return buildGameData({
      scene: tmp,
      scripts: new Map(),
      bodies: new Map(),
      triggers: new Map(),
      useCache: true,
    });
  };

  /** Create a new empty scene asset. Does not open it. Returns the new scene id. */
  const createScene = async (name?: string): Promise<string> => {
    const meta = projectMetaRef.current;
    if (!meta) throw new Error('Project not loaded yet');
    const id = cryptoRandomId();
    const sceneName = uniqueSceneName(name?.trim() || 'New Scene', meta.scenes);
    const data = await buildEmptySceneData();
    await saveSceneData(id, { ...data, savedAt: Date.now() });
    await updateProjectMeta(m => ({ ...m, scenes: [...m.scenes, { id, name: sceneName, updatedAt: Date.now() }] }));
    Logger.info(`Scene "${sceneName}" created`, 'Editor');
    return id;
  };

  const renameScene = (sceneId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void updateProjectMeta(m => ({
      ...m,
      scenes: m.scenes.map(s => s.id === sceneId ? { ...s, name: trimmed } : s),
    }));
  };

  const setMainScene = (sceneId: string) => {
    const meta = projectMetaRef.current;
    if (!meta || !meta.scenes.some(s => s.id === sceneId)) return;
    void updateProjectMeta(m => ({ ...m, mainSceneId: sceneId }));
  };

  /**
   * Swap the camera rig the viewport looks through — the single writer of the view, called both by the
   * viewport toggle and by everything that should make the view FOLLOW the scene. Never persisted:
   * reloading always lands on the scene's own dimension.
   */
  const setViewDimension = (dimension: '2D' | '3D') => {
    setViewDimensionState(dimension);
    eventEmitter.current.emit('CHANGE_DIMENSION', dimension);
  };

  const dimensionOfScene = (sceneId: string): '2D' | '3D' => {
    const meta = projectMetaRef.current;
    const scene = meta?.scenes.find(s => s.id === sceneId);
    return scene?.dimension ?? meta?.prefs?.dimension ?? '3D';
  };

  const setSceneDimension = async (sceneId: string, dimension: '2D' | '3D'): Promise<void> => {
    if (dimensionOfScene(sceneId) === dimension) return;

    // Warn when the scene still holds authoring the target dimension has no use for. Only checkable for the
    // OPEN scene — a closed one's tree is a blob on disk.
    if (sceneId === openSceneIdRef.current) {
      const scene = editorSceneRef.current;
      const losing = dimension === '3D' ? 'tilemap' : 'landscape';
      const count = losing === 'tilemap' ? scene.tilemaps.size : scene.landscapes.size;
      if (count > 0 && !(await confirmDimensionSwitch(dimension, losing, count))) return;
    }

    void updateProjectMeta(m => ({
      ...m,
      scenes: m.scenes.map(s => s.id === sceneId ? { ...s, dimension } : s),
    }));
    // Changing what the scene IS also changes what you look through, but only for the scene on screen.
    if (sceneId === openSceneIdRef.current) setViewDimension(dimension);
    markTabDirty(SCENE_TAB_ID, 'scene-dimension');
  };

  /** Delete a scene asset. Returns null on success, or the reason it is not allowed. */
  const deleteScene = async (sceneId: string): Promise<string | null> => {
    const meta = projectMetaRef.current;
    if (!meta) return 'Project not loaded yet';
    const entry = meta.scenes.find(s => s.id === sceneId);
    if (!entry) return null; // already gone
    if (sceneId === meta.mainSceneId) return 'This is the main scene. Set another scene as main first.';
    if (sceneId === openSceneIdRef.current) return 'This scene is currently open. Open another scene first.';
    await updateProjectMeta(m => ({ ...m, scenes: m.scenes.filter(s => s.id !== sceneId) }));
    try { await deleteSceneData(sceneId); } catch { /* the meta entry is gone; a stale blob is harmless */ }
    return null;
  };

  /** Duplicate a scene asset (fresh node ids so scripts publish per-node without collisions). */
  const duplicateScene = async (sceneId: string): Promise<string | null> => {
    const meta = projectMetaRef.current;
    if (!meta) return null;
    const entry = meta.scenes.find(s => s.id === sceneId);
    if (!entry) return null;
    // Duplicating the open scene with unsaved edits should copy what the user sees — save first.
    let data = sceneId === openSceneIdRef.current
      ? (await saveCurrentScene(), await loadSceneData(sceneId))
      : await loadSceneData(sceneId);
    if (!data) data = { ...(await buildEmptySceneData()), savedAt: Date.now() };
    const clone = deepClone(data) as SceneAssetData;
    regenerateIds(clone.scene, new Map());
    const id = cryptoRandomId();
    const name = uniqueSceneName(entry.name, meta.scenes);
    await saveSceneData(id, { ...clone, savedAt: Date.now() });
    await updateProjectMeta(m => ({ ...m, scenes: [...m.scenes, { id, name, updatedAt: Date.now() }] }));
    return id;
  };

  /**
   * Open a scene asset in the Main tab. Only one scene is ever open: the current scene's editor state
   * (scripts/bodies/triggers/UI/selection) is torn down and the target's blob is parsed into the same
   * live Scene object.
   */
  const openingSceneRef = useRef(false);
  const openScene = async (sceneId: string): Promise<boolean> => {
    const meta = projectMetaRef.current;
    if (!meta) return false;
    const entry = meta.scenes.find(s => s.id === sceneId);
    if (!entry) return false;
    if (sceneId === openSceneIdRef.current) { setActiveTabId(SCENE_TAB_ID); return true; }

    // Leave play mode first — play snapshots the open scene, and swapping it mid-run would leave the
    // engine driving a scene the editor no longer shows.
    if (startedRef.current) stopPlay();

    if (dirtyTabsRef.current[SCENE_TAB_ID]) {
      const current = meta.scenes.find(s => s.id === openSceneIdRef.current);
      const decision = await confirmUnsavedScene(current?.name ?? 'current scene');
      if (decision === 'cancel') return false;
      if (decision === 'save' && !(await saveProjectToStorage())) return false;
    }

    // One open at a time: the steps below yield to let the loading screen paint, and a second click on
    // another scene in that gap would interleave two parses into one live scene.
    if (openingSceneRef.current) return false;
    openingSceneRef.current = true;
    // Over the viewport only, and only if it takes long enough to be seen at all.
    const load = beginLoad(`Opening "${entry.name}"`, [
      { id: 'read', label: 'Reading scene', weight: 1 },
      { id: 'teardown', label: 'Closing the current scene', weight: 1 },
      { id: 'parse', label: 'Building nodes', weight: 4 },
      { id: 'resync', label: 'Linking assets', weight: 3 },
      { id: 'finish', label: 'Finishing', weight: 1 },
    ], 'overlay', { showAfterMs: 150 });
    try {
      // Load the target before tearing anything down, so a failed read aborts cleanly. A scene whose blob
      // was never written (e.g. a fresh "Main" before its first save) opens empty.
      load.step('read').start();
      const data = (await loadSceneData(sceneId)) ?? { ...(await buildEmptySceneData()), savedAt: Date.now() };
      load.step('read').done();
      load.step('teardown').start();

      setActiveTabId(SCENE_TAB_ID);
      // Animation tabs cloned their model out of the outgoing scene; their write-back target is about
      // to disappear, so close them (batched — repeated removeTabById calls would each see stale tabs).
      const staleTabs = tabs.filter(t => t.kind === 'stateMachine' && tabRuntimeRef.current.get(t.id)?.sourceScene === editorSceneRef.current);
      if (staleTabs.length) {
        for (const t of staleTabs) {
          tabRuntimeRef.current.get(t.id)?.helperTerrain?.dispose();
          tabRuntimeRef.current.delete(t.id);
        }
        const staleIds = new Set(staleTabs.map(t => t.id));
        setTabs(prev => prev.filter(t => !staleIds.has(t.id)));
        for (const id of staleIds) clearTabDirty(id);
      }

      // Tear down per-scene editor state.
      scriptsRef.current.clear();
      bodiesRef.current.clear();
      triggersRef.current.clear();
      setSelectedNode(null);
      eventEmitter.current.emit('SELECT_NODE', null);
      load.step('teardown').done();

      // Parse the target into the live scene. Suppress dirty marking for the flurry of SCENE_CHANGED
      // this emits; re-armed below once the helper reconciler settles. The parse and the resync are
      // synchronous, so each is preceded by a yield that lets the loading screen show it.
      dirtyArmedRef.current = false;
      const scene = editorSceneRef.current;
      load.step('parse').start();
      await yieldToPaint();
      scene.environmentMap = null; // parse only sets it when the JSON has one — don't leak the old scene's
      applyGameData(data, { ...engineMaps(), scene, renderer: instanceRef.current?.renderer });
      ensureEditorCamera(scene);
      load.step('parse').done(`${scene.nodes.size.toLocaleString()} nodes`);
      load.step('resync').start();
      await yieldToPaint();
      // Cross-scene propagation: re-resolve the freshly-parsed scene's asset links against the current
      // libraries, so edits/deletes made to assets while this scene was closed take effect on open. Gated
      // by the hashes captured at the scene's last save (data.assetHashes) — unchanged assets are skipped.
      // withoutDirty, as the boot resync and reloadTab do: re-instantiating a changed asset is not the user's
      // edit, and unbracketed it became a 'Delete X' + 'Add X' pair on the undo stack of the scene just opened.
      const relinked = withoutDirty(() => resyncScene(scene, engineMaps(), currentLibs(), data.assetHashes, data.assetHashVersion));
      load.step('resync').done(relinked ? 'updated' : 'up to date');
      load.step('finish').start();
      showBindPoseForSkinnedModels(scene);
      // Same tab id, different document: every undo step and baseline refers to the tree just replaced.
      eventEmitter.current.emit('HISTORY_RESET', SCENE_TAB_ID);

      await updateProjectMeta(m => ({ ...m, openSceneId: sceneId }));
      clearTabDirty(SCENE_TAB_ID);
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
      // Parsing a scene can replace camera settings/onUpdate handlers; re-apply editor camera controls — with
      // the INCOMING scene's rig, not the outgoing one's. This is what makes the view follow the scene.
      setViewDimension(dimensionOfScene(sceneId));
      requestAnimationFrame(() => requestAnimationFrame(() => { dirtyArmedRef.current = true; }));
      load.step('finish').done();
      Logger.info(`Opened scene "${entry.name}"`, 'Editor');
      return true;
    } finally {
      openingSceneRef.current = false;
      load.finish();
    }
  };

  // Startup: restore the saved project if present, otherwise open a blank scene.
  const setupInitialScene = async () => {
    // Textures first. Payloads live once in the texture store, not embedded in the project blob or in the
    // assets that reference them, so they have to be registered in the TextureManager BEFORE anything is
    // parsed against them — that is what lets every asset restore path stay synchronous.
    const boot = bootLoadRef.current;
    try {
      const step = boot.step('textures').start();
      const loaded = await preloadTextures((done, total) => step.progress(done, total));
      if (loaded) Logger.info(`Loaded ${loaded} texture${loaded === 1 ? '' : 's'}`, 'Editor');
      if (loaded) step.done(); else step.skip('none');
    } catch (e) {
      Logger.error(`Failed to load textures: ${e}`, 'Editor');
      boot.step('textures').fail(String(e));
    } finally {
      // Settled either way: a failed preload is not going to fill the registry later, and leaving this
      // false forever would keep the asset index's texture GC permanently disarmed.
      setTexturesPreloaded(true);
    }

    // Then audio, for the same reason and with the same guarantee: a SoundNode resolving `sampleId`
    // during a scene parse must find its sample already registered.
    try {
      const step = boot.step('audio').start();
      const loaded = await preloadAudio((done, total) => step.progress(done, total));
      if (loaded) Logger.info(`Loaded ${loaded} sound${loaded === 1 ? '' : 's'}`, 'Editor');
      if (loaded) step.done(); else step.skip('none');
    } catch (e) {
      Logger.error(`Failed to load audio: ${e}`, 'Editor');
      boot.step('audio').fail(String(e));
    } finally {
      setAudioPreloaded(true);
    }

    // Multi-scene project: load the meta (migrating a legacy single-scene 'cleo_project' blob once), then
    // parse the last-open scene's blob. A fresh install gets a meta with one empty "Main" scene — the
    // "a project always has ≥1 scene" invariant. The legacy import is gated per PROJECT.
    const sceneStep = boot.step('scene').start();
    let meta = await loadProjectMeta();
    if (!meta && activeProjectAllowsLegacyImport()) meta = await migrateLegacyProject();
    if (!meta) {
      meta = createFreshProjectMeta();
      try { await saveProjectMeta(meta); } catch (e) { console.warn('Failed to persist fresh project meta:', e); }
      // Bracketed: the default light is part of the starting document, not an undo step.
      withoutDirty(() => createEmptyScene(editorSceneRef.current));
      pendingPrefsRef.current = null;
    } else {
      // Prefer the last-open scene; fall back to main, then to any scene that still has a blob.
      let targetId = meta.openSceneId;
      let data = await loadSceneData(targetId);
      if (!data && targetId !== meta.mainSceneId) {
        targetId = meta.mainSceneId;
        data = await loadSceneData(targetId);
      }
      if (!data) {
        for (const s of meta.scenes) {
          if (s.id === targetId) continue;
          const candidate = await loadSceneData(s.id);
          if (candidate) { targetId = s.id; data = candidate; break; }
        }
      }
      if (data) {
        // The parse is synchronous: let the splash show this step before it starts.
        sceneStep.start(meta.scenes.find(s => s.id === targetId)?.name ?? '');
        await yieldToPaint();
        applyGameData(data, { ...engineMaps(), scene: editorSceneRef.current, renderer: instanceRef.current?.renderer });
        ensureEditorCamera(editorSceneRef.current);
        // Stash the hashes for the deferred initial resync — the libraries have not been read yet, so it
        // cannot happen here. See the initial-resync effect.
        // The hash VERSION too: without it the hashes read as an older format, nothing compares, and the
        // boot resync silently skips every library edit made since the scene was saved.
        initialAssetHashesRef.current = { hashes: data.assetHashes, version: data.assetHashVersion };
      } else {
        // No scene has a saved blob yet (fresh meta, or blobs lost) — open the target empty.
        withoutDirty(() => createEmptyScene(editorSceneRef.current));
      }
      if (targetId !== meta.openSceneId) meta = { ...meta, openSceneId: targetId };
      try { await saveProjectMeta(meta); } catch { /* meta re-persists on next save */ }
      pendingPrefsRef.current = meta.prefs ?? null;
    }
    projectMetaRef.current = meta;
    setSceneList(meta.scenes);
    setMainSceneIdState(meta.mainSceneId);
    setOpenSceneIdState(meta.openSceneId);
    openSceneIdRef.current = meta.openSceneId;
    scenesLoadedRef.current = true;
    sceneStep.done(meta.scenes.find(s => s.id === meta!.openSceneId)?.name ?? '');
  };

  useEffect(() => {
      const initializeEngine = async () => {
        try {
          const engine = new CleoEngine({
              graphics: {
                  clearColor: EDITOR_CLEAR_COLOR,
                  // A request, resolved against what this build and browser can provide — the renderer
                  // reports the outcome through `backendFallbackReason`, which Renderer Settings shows.
                  // Read here because a context's API cannot change once resources exist on it.
                  backend: readBackendPreference(),
              },
          });

          // Before setupInitialScene() and the texture registrations below: both build GPU resources,
          // and device acquisition is asynchronous. Reported step by step: shader compilation is the
          // longest part of a cold start, and with a listener it yields so the splash can show it.
          const boot = bootLoadRef.current;
          try {
            await engine.initialize({
              onProgress: (phase, done, total) => {
                if (phase === 'device') { if (done < total) boot.step('device').start(); else boot.step('device').done(engine.renderer.backend ?? ''); }
                else if (phase === 'shaders') { if (done < total) boot.step('shaders').progress(done, total); else boot.step('shaders').done(); }
              },
            });
          } catch (e) {
            boot.step('device').fail(String((e as Error)?.message ?? e));
            throw e;
          }

          instanceRef.current = engine;
          applyEngineRuntime(engine as any, projectSettingsRef.current.engine, AudioManager.Instance.mixer);
          instanceRef.current.isPaused = false;

          // Logs bypass this bridge: the console panel's store subscribes to CleoEngine.eventEmitter
          // directly (features/logger/logStore.ts), so it also catches everything logged before mount.
          CleoEngine.eventEmitter.on('SCENE_CHANGED', (e) => { eventEmitter.current.emit('SCENE_CHANGED', e) });
          
          await setupInitialScene();

          // Migrate the old grey default to the pastel-blue editor background, leaving an intentionally
          // customised clear color alone.
          const cc = engine.renderer.clearColor;
          if (cc && Math.abs(cc[0] - LEGACY_CLEAR_COLOR[0]) < 0.01 && Math.abs(cc[1] - LEGACY_CLEAR_COLOR[1]) < 0.01 && Math.abs(cc[2] - LEGACY_CLEAR_COLOR[2]) < 0.01)
            engine.renderer.clearColor = [...EDITOR_CLEAR_COLOR];

          TextureManager.Instance.addTextureFromBase64(NullImage, {}, 'Null');
          TextureManager.Instance.addTextureFromBase64(buildLightIconDataURL(), {
            mipMap: false
          }, '__editor__light_icon');
          // Light-probe viewport billboard icon, rasterised to a PNG so it can be a sprite texture.
          TextureManager.Instance.addTextureFromBase64(buildProbeIconDataURL(), {
            mipMap: false
          }, '__editor__probe_icon');
          // Sound-emitter viewport billboard icon, same arrangement as the two above.
          TextureManager.Instance.addTextureFromBase64(buildSoundIconDataURL(), {
            mipMap: false
          }, '__editor__sound_icon');
          // Decal viewport billboard icon (editorHelpers' ensureDecalIcon).
          TextureManager.Instance.addTextureFromBase64(buildDecalIconDataURL(), {
            mipMap: false
          }, '__editor__decal_icon');
          // Particle system and force field billboards (editorHelpers' ensureEffectIcon).
          TextureManager.Instance.addTextureFromBase64(buildParticleIconDataURL(), {
            mipMap: false
          }, '__editor__particle_icon');
          TextureManager.Instance.addTextureFromBase64(buildForceFieldIconDataURL(), {
            mipMap: false
          }, '__editor__forcefield_icon');
          eventEmitter.current.emit('TEXTURES_CHANGED');

          engine.setScene(editorSceneRef.current);
          // The editor scene runs unpaused (for camera nav), so disable animator playback and pin
          // skinned models to their bind/T pose — animations only play in Play mode + the Anim Editor.
          editorSceneRef.current.animationsEnabled = false;
          // ...and for the same reason, no sound: the editor scene is started AND unpaused, so without
          // this every emitter in the level would fire the moment the project opened.
          editorSceneRef.current.soundsEnabled = false;
          // spawnRulesEnabled is already off — see createEditorScene, which has to set it before the parse
          // that setupInitialScene() above has already done.
          editorSceneRef.current.start();
          showBindPoseForSkinnedModels(editorSceneRef.current);

          // Restore selection/dimension from saved prefs (falls back to the scene root / 3D).
          const prefs = pendingPrefsRef.current;
          setSelectedNode(prefs?.selectedNode ?? editorSceneRef.current.root.id);

          engine.run();

          // Enable the editor infinite-grid overlay (ground/XZ plane by default), unless it is toggled off.
          engine.renderer.setGridVisible(debugVisibilityRef.current.grid.editor);
          engine.renderer.setGridPlane('xz');

          eventEmitter.current.emit('TEXTURES_CHANGED');
          eventEmitter.current.emit('SCENE_CHANGED');
          // Drive the initial camera dimension now that the scene is live (the open scene's own rig,
          // falling back to the legacy project-wide pref, else 3D).
          setViewDimension(dimensionOfScene(openSceneIdRef.current));

          // The first frame: two rAFs after run(), so one has actually been drawn.
          boot.step('frame').start();
          requestAnimationFrame(() => requestAnimationFrame(() => boot.step('frame').done()));
        } catch (e) {
          // Everything still waiting will not come now; settle it so the splash closes on the error.
          const load = currentLoad();
          if (load && load.id === bootLoadRef.current.id)
            for (const s of load.steps) if (s.status === 'pending' || s.status === 'running') bootLoadRef.current.step(s.id).skip('not reached');
          throw e;
        } finally {
          // Always dismiss the splash, even if an asset failed to load,
          // so the editor never gets stuck behind the loading screen.
          setIsSceneReady(true);
        }
      };

      initializeEngine();
  }, []);

  // Keep editor helper nodes (light/camera/probe icons + physics debug wireframes) derived from the scene's
  // contents. Helpers are __editor__/__debug__ prefixed so they never leak into play/save/publish.
  // Reconciling is coalesced to one rAF, and a suppress flag ignores the SCENE_CHANGED its own edits emit.
  const reconcileScheduledRef = useRef(false);
  const suppressReconcileRef = useRef(false);
  // The pending rAF handle, so the effect's cleanup can drop a reconcile queued by the OUTGOING closure —
  // a scene parse otherwise queues a run that lands a frame into Play with the editor channel's values.
  const reconcileRafRef = useRef(0);
  useEffect(() => {
    const runReconcile = () => {
      reconcileScheduledRef.current = false;
      // (Terrain-)material preview scenes want no editor helper icons (light sprites/gizmos) cluttering the sphere.
      if (editorMode === 'material' || editorMode === 'terrainMaterial') return;
      const vis = debugVisibilityRef.current;
      // The reference grid is editor CHROME -- global renderer state, not a scene node -- so its visibility
      // survives a scene swap and the last writer wins. Assert it on EVERY reconcile from whichever channel
      // is in force. Skipped in options mode, where Engine > Renderer owns its own grid switch.
      if (editorMode !== 'options')
        instanceRef.current?.renderer.setGridVisible(isPlayMode && !isSimulating ? vis.grid.runtime : vis.grid.editor);
      // Particle preview is a property of the authored scene; the particle editor's own stage always
      // previews (that is its whole job), and play mode always simulates regardless of the flag.
      const liveScene = instanceRef.current?.scene;
      if (liveScene && !isPlayMode && editorMode !== 'particleSystem') liveScene.particlePreview = vis.particles.editor;
      // A STAGING scene — the animation editors' preview stage — is lit and framed by the editor, not
      // authored, so it gets no helper icons at all: an exhaustive table, so a new mode has to decide
      // (see MODE_SHOWS_SCENE_HELPERS). Play is always the game's own scene.
      if (!isPlayMode && !MODE_SHOWS_SCENE_HELPERS[editorMode]) return;
      suppressReconcileRef.current = true;
      try {
        if (isPlayMode) {
          // Runtime channel: helpers are rebuilt onto the throwaway play scene (which shares node ids with
          // the editor scene, so the bodies/triggers maps still resolve). Still __debug__-named, so still
          // stripped from any real publish. No withoutDirty — play mode never marks the tab dirty.
          // Simulate is watched through the editor's eyes, so it wears the Editor channel's overlays.
          const playScene = instanceRef.current?.scene;
          if (playScene) reconcileEditorHelpers(playScene, bodiesRef.current, triggersRef.current, vis,
            isSimulating ? 'editor' : 'runtime', selectedNodeRef.current);
        } else if (activeScene) {
          // withoutDirty as well as suppressReconcileRef: the latter only stops the reconciler re-triggering
          // ITSELF, while the helpers it splices in emit SCENE_CHANGED like any other node edit.
          withoutDirty(() => reconcileEditorHelpers(activeScene, bodiesRef.current, triggersRef.current, vis, 'editor', selectedNodeRef.current));
        }
      } finally { suppressReconcileRef.current = false; }
    };
    // Queue a reconcile without touching the cached nav soup. For everything that changes which
    // helpers are NEEDED but not what the level's walkable geometry IS.
    const scheduleOnly = () => {
      if (suppressReconcileRef.current || reconcileScheduledRef.current) return;
      reconcileScheduledRef.current = true;
      reconcileRafRef.current = requestAnimationFrame(runReconcile);
    };
    // ...and one that also drops the soup, for the three things that genuinely move geometry: a
    // collider edit, a structural change, and the end of a transform drag. A payload-less
    // SCENE_CHANGED (what an inspector slider emits) deliberately does not, or dragging "max slope"
    // would re-walk the whole level once a frame to rebuild the identical soup.
    const scheduleFresh = () => { invalidateNavSoup(activeScene); scheduleOnly(); };

    const schedule = (e?: SceneChange) => {
      // Structural/visibility/name changes affect which helper icons + wireframes are needed; the per-setter
      // transform/material/... events do not, so skip them (PHYSICS_CHANGED passes no payload and still runs).
      if (e && e.kind !== 'structure' && e.kind !== 'visibility' && e.kind !== 'name') return;
      // Nor does a change to an editor-owned node: helpers are derived FROM content, so a helper, cursor or
      // gizmo handle coming or going changes nothing a reconcile reads. The walkable soup excludes helpers
      // too, so dropping it for one only forces the next reconcile to re-walk the whole level.
      if (isEditorOwnedChange(e)) return;
      if (e?.kind === 'structure') invalidateNavSoup(activeScene);
      scheduleOnly();
    };
    const emitter = eventEmitter.current;
    emitter.on('SCENE_CHANGED', schedule);
    emitter.on('PHYSICS_CHANGED', scheduleFresh);
    emitter.on('DEBUG_VISIBILITY_CHANGED', schedule);
    // The navmesh bake volume and its preview are drawn for the SELECTED node only, and a drag moves
    // geometry without emitting anything the filter above lets through.
    emitter.on('SELECT_NODE', scheduleOnly);
    emitter.on('GIZMO_DRAG_END', scheduleFresh);
    schedule(); // initial reconcile for the current scene / mode
    return () => {
      // Drop any reconcile this closure queued: entering Play parses a whole scene and those structural
      // events schedule a run while isPlayMode is still false. Clearing the FLAG as well as the handle is
      // load-bearing -- cleanup runs before the next effect body, and schedule() would otherwise bail.
      cancelAnimationFrame(reconcileRafRef.current);
      reconcileScheduledRef.current = false;
      emitter.off('SCENE_CHANGED', schedule);
      emitter.off('PHYSICS_CHANGED', scheduleFresh);
      emitter.off('DEBUG_VISIBILITY_CHANGED', schedule);
      emitter.off('SELECT_NODE', scheduleOnly);
      emitter.off('GIZMO_DRAG_END', scheduleFresh);
    };
  }, [activeScene, isPlayMode, isSimulating, editorMode]);

  useEffect(() => {
    eventEmitter.current.on('CHANGE_DIMENSION', (dimension: '2D' | '3D') => {
      if (!instanceRef.current) return;
      // Only the Main tab's view is remembered; asset tabs render transiently in 3D and must not
      // overwrite the rig the scene tab goes back to.
      if (activeTabKindRef.current === 'scene') viewDimensionRef.current = dimension;

      if (!instanceRef.current.scene) {
        setTimeout(() => {
          eventEmitter.current.emit('CHANGE_DIMENSION', dimension);
        }, 100);
        return;
      }

      // `const`, not `let`: it is never reassigned, and const is what lets the null-guard below narrow
      // it inside the onUpdate closures too (a captured `let` could be reassigned, so TS re-widens it).
      const cameraNode = instanceRef.current.scene.activeCamera;
      // Scene.activeCamera is undefined when no camera is active — nothing to reconfigure.
      if (!cameraNode) return;

      // Remember where the OUTGOING rig was parked before touching anything, so the trip back lands where
      // you left; taken unconditionally so the boot emit records the starting 3D pose too. Scene tab only:
      // applyActiveTab installs the incoming tab's scene BEFORE it asks for a rig.
      let remembered: typeof viewPoseRef.current['2D'] | undefined;
      if (activeTabKindRef.current === 'scene') {
        const cam = cameraNode.camera;
        viewPoseRef.current[previousViewRef.current] = {
          position: [cameraNode.position[0], cameraNode.position[1], cameraNode.position[2]],
          rotation: [cameraNode.rotation[0], cameraNode.rotation[1], cameraNode.rotation[2]],
          ortho: cam.type === 'orthographic'
            ? { top: cam.top, bottom: cam.bottom, left: cam.left, right: cam.right }
            : undefined,
        };
        previousViewRef.current = dimension;
        remembered = viewPoseRef.current[dimension];
      }

      if (dimension === '2D') {
        cameraNode.camera.type = 'orthographic';
        // A remembered 2D pose brings its pan AND its zoom back; a first visit gets the default framing.
        const o = remembered?.ortho;
        cameraNode.camera.top = o?.top ?? 4;
        cameraNode.camera.bottom = o?.bottom ?? -4;
        cameraNode.camera.left = o?.left ?? -4;
        cameraNode.camera.right = o?.right ?? 4;
        if (remembered) cameraNode.setPosition(remembered.position).setRotation(remembered.rotation);
        else cameraNode.setZ(10).setRotation([0, 180, 0]);
        // Navigation is the app-kit's shared view camera; the EditorCamera map it reads is turned OFF
        // during a gizmo drag and during Play, so a held key cancels rather than freezing mid-motion.
        cameraNode.onUpdate = (delta) => stepViewCamera2D(cameraNode, delta, viewCameraPrefs());

        // Orient the infinite grid onto the front (XY) plane for 2D.
        instanceRef.current.renderer.setGridPlane('xy');
      }
      else {
        cameraNode.camera.type = 'perspective';
        // Unlike 2D there is no default pose to fall back to — a first switch to 3D keeps whatever the
        // scene set up. Only a remembered pose moves the camera.
        if (remembered) cameraNode.setPosition(remembered.position).setRotation(remembered.rotation);
        cameraNode.onUpdate = (delta) => stepViewCamera3D(cameraNode, delta, viewCameraPrefs());

        // Orient the infinite grid onto the ground (XZ) plane for 3D.
        instanceRef.current.renderer.setGridPlane('xz');
      }
    });

    eventEmitter.current.on('SET_PLAY_STATE', (state: 'play' | 'simulate' | 'pause' | 'stop') => {
      if (!instanceRef.current) return;
      if (state === 'play' || state === 'simulate') {
        const simulate = state === 'simulate';
        instanceRef.current.isPaused = false;
        // The refs the dirty bridge and the engine read, NOW rather than in the effect after the next
        // render: the play scene starts on a timer, and when that render had not committed yet its
        // scripts' first writes (a banner hiding itself in onStart) marked the EDITOR's scene unsaved.
        isPlayModeRef.current = true;
        CleoEngine.authoringMode = false;
        setIsPlayMode(true);
        setIsSimulating(simulate);
        if (simulate) {
          // Nobody is possessed: the editor camera keeps the keyboard and mouse, the game's controls
          // stay down (so the player character just stands there), and a click never grabs the pointer.
          InputSystem.instance.pointerLockOnClick = false;
          InputSystem.instance.enableMap('EditorCamera');
          InputSystem.instance.disableMap('Gameplay');
        } else {
          InputSystem.instance.pointerLockOnClick = true;
          // The editor's camera stands down while the game has the keyboard; the game's maps come up.
          InputSystem.instance.disableMap('EditorCamera');
          InputSystem.instance.enableMap('Gameplay');
        }
        InputSystem.instance.enableMap('UI');
        setSelectedNode(null);
        if (instanceRef.current && instanceRef.current.renderer) {
          instanceRef.current.renderer.setSelectedNode(null);
          // The grid follows its Runtime toggle in game mode (off by default); Simulate is the editor's view.
          instanceRef.current.renderer.setGridVisible(simulate
            ? debugVisibilityRef.current.grid.editor : debugVisibilityRef.current.grid.runtime);
          // Never render a debug channel in the running game (in case Play is pressed in Options mode).
          instanceRef.current.renderer.debugView = 'final';
          // The running game IS the scene, whichever tab Play was pressed from — so it meters, and
          // it wears the project's post-processing, even when Play was pressed from a preview tab.
          instanceRef.current.renderer.setExposureMeteringAllowed(true);
          instanceRef.current.renderer.setPostProcessingAllowed(true);
        }
        // The running game is the only place sounds play. `scene` is the play scene, not the editor's,
        // so this never un-silences the authoring one.
        const playScene = instanceRef.current.scene;
        if (playScene) playScene.soundsEnabled = true;
        AudioManager.Instance.resume();
        // This used to be `registerKeyPress('Escape', ...)`, which was a silent no-op: Escape was not
        // in the old 51-key whitelist, so the callback was never registered and never fired.
        escapeSubRef.current?.();
        escapeSubRef.current = simulate ? null : InputSystem.instance.onAction('UI/Cancel', (state) => {
          if (state.started) InputSystem.instance.releasePointerLock();
        });
      }
      else if (state === 'pause') {
        instanceRef.current.isPaused = true;
        setIsPlayMode(true);
        // Muted rather than stopped: resuming must pick the music back up where it was, not restart it.
        AudioManager.Instance.suspend();
        setSelectedNode(null);
        if (instanceRef.current && instanceRef.current.renderer) {
          instanceRef.current.renderer.setSelectedNode(null);
        }
      }
      else if (state === 'stop') {
        instanceRef.current.isPaused = false; // Unpause for editor scene
        setIsPlayMode(false);
        setIsSimulating(false);
        // Every voice, not just this scene's: a script may have started one on a sample the scene no
        // longer references, and leaving the editor with audio still playing is never right.
        AudioManager.Instance.stopAll();
        AudioManager.Instance.resume();
        // Restore the editor grid when returning to the editor scene, honouring its Editor toggle.
        if (instanceRef.current.renderer) {
          instanceRef.current.renderer.setGridVisible(debugVisibilityRef.current.grid.editor);
          // ...and hand metering and post-processing back to whichever tab we are returning to,
          // which may be a preview.
          instanceRef.current.renderer.setExposureMeteringAllowed(TAB_METERS_EXPOSURE[activeTabKindRef.current]);
          instanceRef.current.renderer.setPostProcessingAllowed(
            TAB_RUNS_POST_PROCESSING[activeTabKindRef.current]);
        }
        InputSystem.instance.pointerLockOnClick = false;
        InputSystem.instance.releasePointerLock();
        escapeSubRef.current?.();
        escapeSubRef.current = null;
        // Drop anything the game left held before the editor camera takes the keyboard back.
        InputSystem.instance.resetState();
        InputSystem.instance.enableMap('EditorCamera');
        InputSystem.instance.disableMap('Gameplay');
      }
    });

    eventEmitter.current.on('SELECT_NODE', (node: string | null) => {
      // A model tab edits ONE thing and has no tree to browse, so the selection is pinned to the active LOD
      // level's root: the Transform panel always edits the model's transform, never a sub-mesh's.
      if (activeTabKindRef.current === 'model') {
        const session = modelSessionsRef.current[activeTabIdRef.current];
        const pinned = session ? session.levelIds[session.activeLevel] : undefined;
        if (pinned) node = pinned;
      }
      setSelectedNode(node);
      // Written here as well as during render. The helper reconciler reads this ref from an rAF that
      // this same event schedules, and the render that would otherwise update it has to land first.
      // React 18 does flush before the frame, but "usually first" is not a thing to depend on when
      // the failure mode is a selection overlay that intermittently does not appear.
      selectedNodeRef.current = node;

      // Use stencil-based outlining instead of creating outline nodes. In a material tab the preview
      // sphere is the (logical) selection so the inspector targets it, but it must not show the outline.
      if (instanceRef.current && instanceRef.current.renderer) {
        const outlineTarget = (activeTabKindRef.current === 'material' || activeTabKindRef.current === 'terrainMaterial') ? null : node;
        instanceRef.current.renderer.setSelectedNode(outlineTarget);
      }
    });

    eventEmitter.current.on('GIZMO_DRAG_START', () => {
      setIsGizmoDragging(true);
      isGizmoDraggingRef.current = true;
      InputSystem.instance.disableMap('EditorCamera');
    });

    eventEmitter.current.on('GIZMO_DRAG_END', () => {
      setIsGizmoDragging(false);
      isGizmoDraggingRef.current = false;
      InputSystem.instance.enableMap('EditorCamera');
    });

    isGizmoDraggingRef.current = false;
    setIsGizmoDragging(false);

    // Default values (the initial CHANGE_DIMENSION is emitted from initializeEngine once the scene is live).
    eventEmitter.current.emit('SET_PLAY_STATE', 'stop');
    eventEmitter.current.emit('SELECT_SCRIPT', null);

    return () => {
      eventEmitter.current.removeAllListeners();
    }
  }, [eventEmitter]);

  // --- Play lifecycle (builds the play scene) ---------------------------
  // The scene the play session started on (what Reset returns to) and the one currently running, plus
  // the running scene's UI elements — a runtime Game.loadScene switch updates the latter two.
  const playEntrySceneIdRef = useRef<string>('');
  const currentPlaySceneIdRef = useRef<string>('');
  // The play Scene currently installed on the engine, so it can be released when it is replaced. Without
  // it a discarded play scene leaks its GPU meshes, its terrain heightfield body, its foliage collider
  // pool and its permanent SCENE_CHANGED subscription — one full set per Play.
  const playSceneRef = useRef<Scene | null>(null);
  // The open scene's render settings as Play found them. Render settings belong to a scene: a runtime
  // Game.loadScene switch applies the target's, coming back to the entry scene applies these, and Stop
  // puts them back — a script that changed the exposure, or a scene switch, must not leave its look on
  // the scene being edited (whose next save reads the live renderer).
  const playRenderRef = useRef<RenderSettings | null>(null);

  /**
   * Release a play scene being thrown away. Guarded twice on purpose: only the scene this ref is holding
   * is ever released, and never the editor's own scene, which is long-lived and shared with every panel.
   */
  const releasePlayScene = () => {
    const scene = playSceneRef.current;
    playSceneRef.current = null;
    if (!scene || scene === editorSceneRef.current) return;
    try { scene.dispose(); } catch (e) { Logger.error(`Failed to release the play scene: ${e}`, 'Editor'); }
  };

  const buildPlayScene = async (): Promise<Scene> => {
    // useCache: true — textures already live in TextureManager for in-editor play, so skip re-embedding.
    const json = await buildGameData({
      scene: editorSceneRef.current,
      scripts: scriptsRef.current,
      scriptAssets: scriptAssetsRef.current,
      // Script modules: stamps each node's script path and ships every module the scripts import.
      scriptPaths: scriptPathsRef.current,
      bodies: bodiesRef.current,
      triggers: triggersRef.current,
      templates: templatesRef.current,
      materials: materialsRef.current,
      // Play mode has no top-level animation table for a player to resolve, so the shared clips are
      // baked straight into the JSON — into the templates too, or a spawned enemy T-poses.
      models: modelsRef.current,
      animations: animationsRef.current,
      useCache: true,
    });
    const newScene = new Scene();
    // Templates are global and shared by every scene in the session, so they are registered here rather
    // than per-parse — a runtime Game.loadScene must not drop what a script can still instantiate.
    registerTemplates(json.templates);
    // Before parse: a node's script imports its modules while it is being attached.
    addScriptModuleSources(json.modules);
    newScene.parse(json, true);
    return newScene;
  };

  // Build a runnable play Scene for any scene id. The play-session entry (the scene open when Play was
  // pressed) uses the live editor scene so unsaved edits play; every other scene is loaded from its blob,
  // re-resolved against the current libraries, then parsed with its scripts compiled. Comes with the
  // scene's render settings: the entry scene's as Play found them, any other's as saved.
  const buildPlaySceneById = async (id: string, onProgress?: LoadProgressListener):
      Promise<{ scene: Scene, render: Partial<RenderSettings> | null }> => {
    // Each stage yields a frame so a loading screen's bar paints before the next one blocks.
    const stage = async (fraction: number, name: string) => { onProgress?.(fraction, name); await nextFrame(); };
    if (id === playEntrySceneIdRef.current) {
      await stage(0.2, 'Building the scene');
      return { scene: await buildPlayScene(), render: playRenderRef.current };
    }
    await stage(0.1, 'Reading the scene');
    const data = await loadSceneData(id);
    if (!data) return { scene: new Scene(), render: null };
    await stage(0.3, 'Resolving assets');
    const clone = deepClone({ scene: data.scene, ui: data.ui });
    // A scene never opened in this session still carries its UI as the legacy blob — same reason the
    // publish path migrates here: without it, loading that scene at runtime gives it no HUD, silently.
    migrateLegacyUI(clone.scene, clone.ui);
    const maps = { scripts: new Map<string, string>(), bodies: new Map<string, any>(), triggers: new Map<string, any>() };
    extractNodeState(clone.scene, maps);
    const tmp = new Scene();
    tmp.parse({ scene: clone.scene, textures: [] }, true);
    resyncScene(tmp, maps, currentLibs(), data.assetHashes, data.assetHashVersion);
    await stage(0.5, 'Preparing scripts and models');
    const gd = await buildGameData({ scene: tmp, scripts: maps.scripts, bodies: maps.bodies, triggers: maps.triggers, scriptAssets: scriptAssetsRef.current, scriptPaths: scriptPathsRef.current, templates: templatesRef.current, materials: materialsRef.current, models: modelsRef.current, animations: animationsRef.current, useCache: true });
    // `tmp` existed only to be resynced and serialized; `gd` is plain JSON, so its GPU meshes and bus
    // subscription can go now.
    tmp.dispose();
    await stage(0.7, 'Building the scene');
    const scene = new Scene();
    registerTemplates(gd.templates);
    addScriptModuleSources(gd.modules); // adds what is new; an already-evaluated module keeps its state
    scene.parse(gd, true); // gd injects scripts into nodes → compiled here
    return { scene, render: data.config?.render ?? null };
  };

  // Runtime scene switch (Game.loadScene from a script). Swaps the engine's scene, resetting UI/physics/
  // input for the new scene — the editor-play counterpart of the player's loadScene.
  const playLoadScene = async (nameOrId: string, onProgress?: LoadProgressListener): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance || !startedRef.current) return;
    const meta = projectMetaRef.current;
    const target = meta?.scenes.find(s => s.id === nameOrId) ?? meta?.scenes.find(s => s.name === nameOrId);
    if (!target) { Logger.warn(`loadScene: no scene "${nameOrId}"`, 'Editor'); return; }
    const { scene, render } = await buildPlaySceneById(target.id, onProgress);
    onProgress?.(0.9, 'Starting');
    // A simulation keeps watching through the editor camera across a runtime scene switch.
    if (isSimulatingRef.current) carryEditorCamera(instance.scene, scene);
    // Held keys, gestures and edges only — NOT the map. Un-binding the game between scenes would
    // leave the next one dead.
    instance.input.resetState();
    instance.physics.clear();
    // The scene's own look, as opening it in the editor would give it. Before it starts, so its scripts
    // can still change it.
    instance.renderer.applyRenderSettings(render);
    instance.setScene(scene);
    // After the swap: the outgoing scene is off the engine and its bodies are out of the world.
    releasePlayScene();
    playSceneRef.current = scene;
    if (isSimulatingRef.current) setSimulatedScene(scene);
    currentPlaySceneIdRef.current = target.id;
    instance.isPaused = false;
    // The new play scene starts with no runtime debug helpers; rebuild them for it (isPlayMode is
    // already true, so the reconcile effect won't re-fire on its own).
    eventEmitter.current.emit('DEBUG_VISIBILITY_CHANGED');
    // Resolved once it has STARTED, which is what Game.loadScene promises its caller.
    await new Promise<void>(resolve => setTimeout(() => { instance.scene.start(); resolve(); }, 50));
  };

  const installGameHost = () => setGameHost({
    loadScene: (nameOrId: string, options?: { onProgress?: LoadProgressListener }) =>
      playLoadScene(nameOrId, options?.onProgress),
    currentSceneName: () => projectMetaRef.current?.scenes.find(s => s.id === currentPlaySceneIdRef.current)?.name ?? '',
    sceneNames: () => (projectMetaRef.current?.scenes ?? []).map(s => s.name),
  });

  /**
   * Refresh every animation state's embedded Animation Field from the library. A state stores a COPY of the
   * field, written when the machine was applied, and that copy can fall behind the asset. Done at play start
   * so every route is covered in one place. withoutDirty: refreshing from the library is not a user edit.
   */
  const reembedSceneFields = (scene: Scene) => {
    let count = 0;
    withoutDirty(() => {
      for (const node of Array.from(scene.nodes)) {
        if (!(node instanceof ModelNode) || !node.animator) continue;
        const sm = node.animator.getStateMachine();
        if (!sm) continue;
        const next = reembedFields(sm as any, animationFieldsRef.current) as any;
        if (next !== sm) { node.animator.setStateMachine(next); count++; }
      }
    });
    return count;
  };

  /**
   * Simulate views the play scene through the editor's OWN camera node, carried across rather than copied:
   * its free-fly onUpdate closure goes with it, so navigation keeps working, and Stop hands back the very
   * view the user flew to. Pinned on arrival, or the play scene's first game camera would win the scan.
   * withoutDirty: it is editor-owned, but leaving the editor scene must not even look like an edit.
   */
  const carryEditorCamera = (from: Scene | null | undefined, to: Scene) => {
    const cam = from?.getNodesByName('__editor__Camera').find((n): n is CameraNode => n instanceof CameraNode);
    if (!from || !cam) return;
    withoutDirty(() => {
      from.removeNode(cam);
      to.addNode(cam);
    });
    to.setActiveCamera(cam);
  };
  /** Bring the editor camera home from whatever play scene Simulate left it in, and re-pin it. */
  const recallEditorCamera = (from: Scene | null | undefined) => {
    const editor = editorSceneRef.current;
    if (!editor) return;
    if (from && from !== editor) carryEditorCamera(from, editor);
    withoutDirty(() => ensureEditorCamera(editor));
  };

  const startPlay = () => startSession(false);
  const startSimulate = () => startSession(true);
  const startSession = async (simulate: boolean) => {
    const instance = instanceRef.current;
    if (!instance) return;
    // The two sessions are exclusive: switching between Play and Simulate goes through Stop.
    if (startedRef.current && isSimulatingRef.current !== simulate) return;
    instance.input.preventDefault = !simulate;
    if (startedRef.current) { eventEmitter.current.emit('SET_PLAY_STATE', simulate ? 'simulate' : 'play'); return; }

    // Play always runs the game scene, from wherever the user happens to be; Stop brings them back.
    // It cannot be done in one pass: both this and the tab-activate effect call instance.setScene, and
    // passive effects are scheduled, not flushed — commit the switch first, then re-enter from an effect.
    if (activeTabIdRef.current !== SCENE_TAB_ID || mainModeRef.current !== 'scene') {
      playReturnRef.current = { tabId: activeTabIdRef.current, mainMode: mainModeRef.current };
      const leaving = tabsRef.current.find(t => t.id === activeTabIdRef.current);
      // Play reads the open scene and the asset LIBRARIES, never a tab's edit session, so unsaved work in
      // the tab being left is genuinely not in the build. Say so rather than silently saving it.
      if (leaving && leaving.kind !== 'scene' && dirtyTabsRef.current[leaving.id])
        Logger.info(`Playing the scene — unsaved changes in "${leaving.title}" are not included`, 'Editor');
      setMainMode('scene');
      setActiveTab(SCENE_TAB_ID);
      pendingPlayRef.current = true;
      pendingSimulateRef.current = simulate;
      return;
    }

    reembedSceneFields(editorSceneRef.current);
    playEntrySceneIdRef.current = openSceneIdRef.current;
    currentPlaySceneIdRef.current = openSceneIdRef.current;
    playRenderRef.current = instance.renderer.getRenderSettings();
    // A fresh session evaluates every script module afresh: edits made since the last Play apply, and no
    // module state leaks from one session into the next.
    resetScriptModules();
    const newScene = await buildPlayScene();
    isSimulatingRef.current = simulate;
    if (simulate) carryEditorCamera(editorSceneRef.current, newScene);
    instance.setScene(newScene);
    playSceneRef.current = newScene;
    setSimulatedScene(simulate ? newScene : null);
    instance.isPaused = false;
    installGameHost();
    // Rebuild runtime debug helpers AFTER scene.start() — the reconcile the isPlayMode flip triggers runs
    // before start(), which resets the scene and drops those just-added nodes. Emitting here mirrors the
    // live-toggle path, so Runtime toggles are honoured from the first frame of Play.
    setTimeout(() => { instance.scene.start(); eventEmitter.current.emit('DEBUG_VISIBILITY_CHANGED'); }, 100);
    eventEmitter.current.emit('SET_PLAY_STATE', simulate ? 'simulate' : 'play');
    startedRef.current = true;
  };
  const stopPlay = () => {
    startedRef.current = false;
    const instance = instanceRef.current;
    setGameHost(null);
    if (!instance) return;
    // Before the play scene is released: disposing it would take the editor camera down with it.
    if (isSimulatingRef.current) recallEditorCamera(playSceneRef.current);
    isSimulatingRef.current = false;
    setSimulatedScene(null);
    instance.renderer.applyRenderSettings(playRenderRef.current);
    playRenderRef.current = null;
    instance.setScene(editorSceneRef.current);
    // Held keys, gestures and edges only — NOT the map. Un-binding the game between scenes would
    // leave the next one dead.
    instance.input.resetState();
    instance.physics.clear();
    releasePlayScene();
    resetScriptModules();
    showBindPoseForSkinnedModels(editorSceneRef.current); // back to the default pose in the editor
    eventEmitter.current.emit('SET_PLAY_STATE', 'stop');
  };
  const pausePlay = () => eventEmitter.current.emit('SET_PLAY_STATE', 'pause');
  const resetPlay = async () => {
    const instance = instanceRef.current;
    if (!instance) return;
    // Clear input/physics so key bindings and bodies from the previous run don't stack.
    // Held keys, gestures and edges only — NOT the map. Un-binding the game between scenes would
    // leave the next one dead.
    instance.input.resetState();
    instance.physics.clear();
    // Reset returns to the play-session entry scene (where Play was pressed), not the last-loaded one.
    currentPlaySceneIdRef.current = playEntrySceneIdRef.current;
    resetScriptModules();
    const newScene = await buildPlayScene();
    if (isSimulatingRef.current) carryEditorCamera(instance.scene, newScene);
    instance.renderer.applyRenderSettings(playRenderRef.current);
    instance.setScene(newScene);
    releasePlayScene();
    playSceneRef.current = newScene;
    if (isSimulatingRef.current) setSimulatedScene(newScene);
    instance.isPaused = false;
    // Reconcile runtime debug helpers after start() (see startPlay) — reset stays in play mode, so the
    // isPlayMode effect won't re-fire on its own.
    setTimeout(() => { instance.scene.start(); eventEmitter.current.emit('DEBUG_VISIBILITY_CHANGED'); }, 50);
    startedRef.current = true;
    eventEmitter.current.emit('SET_PLAY_STATE', isSimulatingRef.current ? 'simulate' : 'play');
  };

  // Second half of the two-phase Play switch above: the tab and mode are now committed, so the engine's
  // scene is settled and startPlay can install the play scene without racing anything.
  useEffect(() => {
    if (!pendingPlayRef.current) return;
    if (activeTabId !== SCENE_TAB_ID || mainMode !== 'scene') return;
    pendingPlayRef.current = false;
    void startSession(pendingSimulateRef.current);
  }, [activeTabId, mainMode]);

  // Return to wherever Play was pressed from. Deliberately an effect on isPlayMode rather than a call inside
  // stopPlay: stopPlay only emits, and the state it is waiting on lands with the SET_PLAY_STATE handler.
  // Reset stays in play, so it must NOT consume this.
  useEffect(() => {
    if (isPlayMode) return;
    const back = playReturnRef.current;
    if (!back) return;
    playReturnRef.current = null;
    setMainMode(back.mainMode);
    // setActiveTab, not setActiveTabId — the tab may still be an unhydrated placeholder from a restore.
    if (back.tabId !== SCENE_TAB_ID && tabsRef.current.some(t => t.id === back.tabId)) setActiveTab(back.tabId);
  }, [isPlayMode]);

  // Block a close or a reload while a save is in flight OR any tab has unsaved edits — dirty state is
  // only ever cleared by an explicit Save, so a reload would otherwise silently drop the work.
  //
  // `beforeunload` can only BLOCK; who asks about it is the host's business, and neither host asks well.
  // A browser tab puts up Chrome's "Leave site?" box, which the editor cannot theme or word; the Electron
  // shell puts up nothing at all and the window just refuses to close. So the shell hands the attempt
  // back here (features/desktopShell.ts), and the reloads the EDITOR itself starts ask first through
  // features/unloadGuard.ts. What is left for `beforeunload` is the browser's tab close and its reload
  // button — the two the page genuinely cannot own.
  const hasUnsavedWork = savingState === 'saving' || Object.keys(dirtyTabs).length > 0;
  useEffect(() => {
    if (!hasUnsavedWork) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Stand down for a reload the editor asked for: it has already put the same question in a dialog
      // of its own, and letting this fire too would stack the native box on top of the answer.
      if (unloadGuardSuppressed()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedWork]);

  // Publish what is unsaved for the code that can discard the page but is not a component: the project
  // switch and the bundle import, both plain async functions in utils/.
  useEffect(() => {
    setUnsavedWork(Object.keys(dirtyTabs).map(id => tabsRef.current.find(t => t.id === id)?.title ?? id));
  }, [dirtyTabs]);

  // The desktop shell's blocked close/reload, answered in the editor's own dialog. Registered once: the
  // shell only asks when `beforeunload` has already blocked something, so there is always work to lose.
  useEffect(() => {
    const shell = getShellBridge();
    if (!shell) return;
    return shell.onConfirmUnload(async (action) => {
      try {
        shell.respondToUnload(await confirmDiscard(action === 'close' ? 'Closing' : 'Reloading'));
      } catch {
        // Never leave the shell on its watchdog: an unanswered request holds the window for five
        // seconds and then does the thing anyway, which is the one outcome nobody asked for.
        shell.respondToUnload(false);
      }
    });
  }, []);

  // Split-out slice contexts (Selection / Playback / AssetLibrary / Document). The state still lives here;
  // each exposes a narrow, memoized value so a consumer of one slice needn't re-render on every unrelated
  // EngineContext change. Actions go through useStableActions, so only real state changes bust each memo.
  const selectionValue = useMemo<SelectionContextValue>(() => ({
    selectedNode, isGizmoDragging, gizmoMode, setGizmoMode, gizmoSpace, setGizmoSpace,
  }), [selectedNode, isGizmoDragging, gizmoMode, gizmoSpace]);

  const playActions = useStableActions({ startPlay, startSimulate, stopPlay, pausePlay });
  const playbackValue = useMemo<PlaybackContextValue>(() => ({
    isPlayMode, isSimulating, ...playActions,
  }), [isPlayMode, isSimulating, playActions]);

  const debugVisibilityValue = useMemo<DebugVisibilityContextValue>(() => ({
    visibility: debugVisibility, setCategory: setDebugCategory,
  }), [debugVisibility]);

  const libraryActions = useStableActions({
    addTemplate, removeTemplate, updateTemplate,
    addMaterial, removeMaterial, updateMaterial,
    addTerrainMaterial, removeTerrainMaterial, updateTerrainMaterial,
    addModel, removeModel, updateModel,
    addScriptAsset, removeScriptAsset, updateScriptAsset,
    addAnimationField, removeAnimationField, updateAnimationField,
    addAnimation, removeAnimation, updateAnimation,
    addRig, removeRig, updateRig,
    addTileset, removeTileset, updateTileset,
    addAiBrain, removeAiBrain, updateAiBrain,
    addParticleSystem, removeParticleSystem, updateParticleSystem,
    addAnimController, removeAnimController, updateAnimController,
    addBoneMask, removeBoneMask, updateBoneMask,
    addPoseAsset, removePoseAsset, updatePoseAsset,
    addImage, removeImage, updateImage,
    addTextureAsset, removeTextureAsset, updateTextureAsset,
    addAudioSource, removeAudioSource, updateAudioSource,
    addSoundSample, removeSoundSample, updateSoundSample,
  });
  const assetLibraryValue = useMemo<AssetLibraryContextValue>(() => ({
    templates, materials, terrainMaterials, models, scriptAssets, animationFields, animations, rigs, tilesets, aiBrains,
    particleSystems, animControllers, boneMasks, poseAssets,
    images, textures, audioSources, soundSamples, assetsLoaded, ...libraryActions,
  }), [templates, materials, terrainMaterials, models, scriptAssets, animationFields, animations, rigs, tilesets, aiBrains,
       particleSystems, animControllers, boneMasks, poseAssets,
       images, textures, audioSources, soundSamples, assetsLoaded, libraryActions]);

  const documentActions = useStableActions({
    setActiveTab, closeTab, closeTabs, saveTabs, reorderTabs, saveActiveTab, saveAll, markTabDirty, clearTabDirty, withoutDirty,
  });
  const documentValue = useMemo<DocumentContextValue>(() => ({
    tabs, activeTabId, activeTab, dirtyTabs, savingState,
    mainDirty: !!dirtyTabs[SCENE_TAB_ID],
    ...documentActions,
  }), [tabs, activeTabId, activeTab, dirtyTabs, savingState, documentActions]);

  const projectActions = useStableActions({
    openScene, createScene, renameScene, deleteScene, duplicateScene, setMainScene,
    setSceneDimension, resolveSceneConfirm, resolveDimensionConfirm, replaceProjectMeta,
  });
  const currentDimension = sceneList.find(s => s.id === openSceneId)?.dimension
    ?? projectMetaRef.current?.prefs?.dimension ?? '3D';

  // Landscape and Tilemap share one slot in the mode selector, filled by whichever the open scene's
  // dimension uses — so after a switch the current mode can name a tool with no button and no scene to act
  // on. Snap back to plain scene editing.
  useEffect(() => {
    const stale = currentDimension === '2D' ? 'landscape' : 'tilemap';
    if (mainModeRef.current === stale) setMainMode('scene');
  }, [currentDimension, openSceneId]);

  const projectValue = useMemo<ProjectContextValue>(() => ({
    sceneList, mainSceneId, openSceneId, pendingSceneConfirm, pendingDimensionConfirm,
    sceneDimension: currentDimension,
    ...projectActions,
  }), [sceneList, mainSceneId, openSceneId, pendingSceneConfirm, pendingDimensionConfirm, currentDimension, projectActions]);

  const sessionActions = useStableActions({
    enterTemplateEditor, createTemplateVariant, revertVariantChanges, createVariantFromInstance, rebaseTemplateVariant,
    enterMaterialEditor, createMaterialForNode, setActiveMaterialName,
    enterTerrainMaterialEditor, refreshTerrainMaterialPreview, setActiveTerrainMaterialName,
    setPreviewShape, previewElevationLegend,
    enterStateMachineEditor, commitAnimationStateMachine, registerAnimationApply, registerTilesetApply,
    importAnimationFiles, importSkeletonNames, commitIkRig, currentIkRig, renameAnimationClip, removeAnimationClip, resolveAnimationImport, resolveRigPick,
    enterModelEditor, adoptModelAsset, resolveModelAssetId, linkAnimationToRig, unlinkAnimationFromRig, ensureRigForModel, editSharedClip, setModelRig,
    setActiveModelName, saveModelPart, addModelLodFromAsset, generateModelLods, removeModelLod,
    setModelLodDistance, setModelCullDistance, setActiveModelLevel, importModelFiles, resolveModelImport,
    enterScriptEditor, setScriptTabSource, getScriptTabSource, saveScriptSource, syncScriptPaths, createScriptModule,
    revertTemplateOverride,
    adoptExternalScriptSource, renameScriptAsset,
    scriptAssetOf, createScriptForNode, attachScriptToNode, detachScriptFromNode,
    enterAnimationFieldEditor, createAnimationFieldForModel, saveAnimationField,
    enterSoundEditor, saveSoundSample, previewSoundSettings, registerSoundApply,
    enterAiBrainEditor, saveAiBrain, extractBrainFromController, linkBrainToController, registerAiBrainApply,
    enterParticleSystemEditor, saveParticleSystem, linkParticleSystemToNode, extractParticleSystemFromNode,
    registerParticleSystemApply,
    enterRigEditor, setRigPreviewModel, rigPreviewModelId, saveRig, modelsOnRig, registerRigApply,
    openAnimController, createAnimatorForRig, animateCharacter,
    enterClipEditor, setClipPreviewModel, clipPreviewModelId, saveClip, saveClipAs, modelsForClip,
    registerClipApply,
  });
  const editorSessionsValue = useMemo<EditorSessionsContextValue>(() => ({
    editingTemplateName, editingTemplateVariant, templateRootId,
    editingMaterialName,
    editingTerrainMaterialName, editingTerrainMaterialNode,
    stateMachineTargetId, stateMachineSourceId, stateMachineSourceScene, pendingAnimationImport, pendingRigPick,
    editingAnimationFieldId, animationFieldTargetId,
    editingSoundId,
    editingAiBrainId,
    editingParticleSystemId,
    editingRigId,
    editingAnimationId,
    modelSession: activeTab.kind === 'model' ? (modelSessions[activeTab.id] ?? null) : null,
    modelEditTargetId: activeTab.kind === 'model' && modelSessions[activeTab.id]
      ? modelSessions[activeTab.id].levelIds[modelSessions[activeTab.id].activeLevel] ?? null
      : null,
    pendingModelImport,
    scriptPaths,
    ...sessionActions,
  }), [scriptPaths, 
    editingTemplateName, editingTemplateVariant, templateRootId, editingMaterialName,
    editingTerrainMaterialName, editingTerrainMaterialNode,
    stateMachineTargetId, stateMachineSourceId, stateMachineSourceScene, pendingAnimationImport, pendingRigPick,
    editingAnimationFieldId, animationFieldTargetId, editingSoundId, editingAiBrainId, editingParticleSystemId, editingRigId,
    editingAnimationId,
    activeTab, modelSessions, pendingModelImport, sessionActions,
  ]);

  // What the app-kit's shared chrome (renderer and performance panels) reads instead of this context.
  const engineHostValue = useMemo<EngineHost>(
    () => ({ instance: instanceRef.current, isPlayMode, eventEmitter: eventEmitter.current }),
    // instanceRef.current is set once, during boot; it is a dependency so the host picks it up then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instanceRef.current, isPlayMode],
  );

  return (
  <EngineContext.Provider value={{
      instance: instanceRef.current,
      editorScene: activeScene,
      inspectedScene,
      skeletonTargetId,
      mainScene: editorSceneRef.current,
      eventEmitter: eventEmitter.current,
      selectedNode,
      isGizmoDragging,
      isPlayMode,
      isSimulating,
      isSceneReady,
      texturesPreloaded,
      audioPreloaded,
      editorMode,
      setEditorMode,
      gizmoMode,
      setGizmoMode,
      gizmoSpace,
      setGizmoSpace,
      tabs,
      activeTabId,
      activeTab,
      dirtyTabs,
      setActiveTab,
      reloadTab,
      closeTab,
      closeTabs,
      saveTabs,
      reorderTabs,
      saveActiveTab,
      saveAll,
      registerAnimationApply,
      registerTilesetApply,
      enterTemplateEditor,
      createTemplateVariant,
      revertVariantChanges,
      createVariantFromInstance,
      rebaseTemplateVariant,
      editingTemplateName,
      editingTemplateVariant,
      templateRootId,
      enterMaterialEditor,
      createMaterialForNode,
      editingMaterialName,
      setActiveMaterialName,
      enterTerrainMaterialEditor,
      editingTerrainMaterialName,
      editingTerrainMaterialNode,
      refreshTerrainMaterialPreview,
      setPreviewShape,
      previewElevationLegend,
      dropFoliageLayer,
      bakeFoliageImpostor,
      setActiveTerrainMaterialName,
      enterStateMachineEditor,
      stateMachineTargetId,
      stateMachineSourceId,
      stateMachineSourceScene,
      commitAnimationStateMachine,
      terrainBrush,
      tilemapBrush,
      isDirtySuppressed,
      scripts: scriptsRef.current,
      bodies: bodiesRef.current,
      triggers: triggersRef.current,
      startPlay,
      startSimulate,
      stopPlay,
      pausePlay,
      templates,
      // The project's input action map, and the setter the Input panel edits it through. Everything
      // downstream (persistence, the running InputSystem, publish) hangs off this one piece of state.
      inputMap,
      setInputMap,
      projectSettings,
      setProjectSettings,
      addTemplate,
      removeTemplate,
      updateTemplate,
      materials,
      addMaterial,
      removeMaterial,
      updateMaterial,
      terrainMaterials,
      addTerrainMaterial,
      removeTerrainMaterial,
      updateTerrainMaterial,
      scriptAssets,
      addScriptAsset,
      removeScriptAsset,
      updateScriptAsset,
      scriptAssetOf,
      createScriptForNode,
      attachScriptToNode,
      detachScriptFromNode,
      saveScriptSource,
      syncScriptPaths,
      scriptPaths,
      createScriptModule,
      revertTemplateOverride,
      adoptExternalScriptSource,
      renameScriptAsset,
      animationFields,
      addAnimationField,
      removeAnimationField,
      updateAnimationField,
      animations,
      addAnimation,
      removeAnimation,
      updateAnimation,
      rigs,
      addRig,
      removeRig,
      updateRig,
      enterAnimationFieldEditor,
      createAnimationFieldForModel,
      editingAnimationFieldId,
      animationFieldTargetId,
      saveAnimationField,
      images,
      addImage,
      removeImage,
      updateImage,
      textures,
      addTextureAsset,
      removeTextureAsset,
      updateTextureAsset,
      audioSources,
      addAudioSource,
      removeAudioSource,
      updateAudioSource,
      soundSamples,
      addSoundSample,
      removeSoundSample,
      updateSoundSample,
      editingSoundId,
      enterSoundEditor,
      editingAiBrainId,
      saveSoundSample,
      previewSoundSettings,
      tilesets,
      aiBrains,
      addAiBrain,
      removeAiBrain,
      updateAiBrain,
      particleSystems,
      addParticleSystem,
      removeParticleSystem,
      updateParticleSystem,
      editingParticleSystemId,
      enterParticleSystemEditor,
      saveParticleSystem,
      linkParticleSystemToNode,
      extractParticleSystemFromNode,
      registerParticleSystemApply,
      animControllers,
      addAnimController,
      removeAnimController,
      updateAnimController,
      boneMasks,
      addBoneMask,
      removeBoneMask,
      updateBoneMask,
      poseAssets,
      addPoseAsset,
      removePoseAsset,
      updatePoseAsset,
      addTileset,
      removeTileset,
      updateTileset,
      enterTilesetEditor,
      enterAiBrainEditor,
      extractBrainFromController,
      linkBrainToController,
      saveAiBrain,
      createTilesetFromImage,
      editingTilesetId,
      editingTextureId,
      enterTextureEditor,
      saveTexture,
      previewTextureSettings,
      registerTextureApply,
      registerSoundApply,
      registerAiBrainApply,
      registerRigApply,
      enterRigEditor,
      openAnimController, createAnimatorForRig, animateCharacter,
      setRigPreviewModel,
      rigPreviewModelId,
      saveRig,
      modelsOnRig,
      editingRigId,
      registerClipApply,
      enterClipEditor,
      setClipPreviewModel,
      clipPreviewModelId,
      saveClip,
      saveClipAs,
      modelsForClip,
      editingAnimationId,
      saveTileset,
      enterScriptEditor,
      setScriptTabSource,
      getScriptTabSource,
      models,
      addModel,
      removeModel,
      updateModel,
      enterModelEditor,
      adoptModelAsset,
      resolveModelAssetId,
      linkAnimationToRig,
      ensureRigForModel,
      unlinkAnimationFromRig,
      editSharedClip,
      setModelRig,
      adoptRigController,
      modelSession: activeTab.kind === 'model' ? (modelSessions[activeTab.id] ?? null) : null,
      modelEditTargetId: activeTab.kind === 'model' && modelSessions[activeTab.id]
        ? modelSessions[activeTab.id].levelIds[modelSessions[activeTab.id].activeLevel] ?? null
        : null,
      setActiveModelName,
      saveModelPart,
      addModelLodFromAsset,
      generateModelLods,
      removeModelLod,
      setModelLodDistance,
      setModelCullDistance,
      setActiveModelLevel,
      importModelFiles,
      assetsLoaded,
      pendingModelImport,
      resolveModelImport,
      importAnimationFiles,
      importSkeletonNames,
      commitIkRig,
      currentIkRig,
      renameAnimationClip,
      removeAnimationClip,
      pendingAnimationImport,
      resolveAnimationImport,
      pendingRigPick,
      resolveRigPick,
      replaceProjectMeta,
      savingState,
      sceneList,
      mainSceneId,
      openSceneId,
      mainDirty: !!dirtyTabs[SCENE_TAB_ID],
      openScene,
      createScene,
      renameScene,
      deleteScene,
      duplicateScene,
      setMainScene,
      // Reads sceneList so the control re-renders on change; dimensionOfScene reads the meta ref.
      sceneDimension: sceneList.find(s => s.id === openSceneId)?.dimension ?? projectMetaRef.current?.prefs?.dimension ?? '3D',
      setSceneDimension,
      viewDimension,
      setViewDimension,
      pendingSceneConfirm,
      resolveSceneConfirm,
      pendingDimensionConfirm,
      resolveDimensionConfirm,
      markTabDirty,
      clearTabDirty,
      withoutDirty,
    }}>
    {/* The bus first: its value is the emitter ref, which never changes, so bus-only consumers never
        re-render from context at all. */}
    <EngineHostProvider value={engineHostValue}>
    <EventBusContext.Provider value={eventEmitter.current}>
      <SelectionContext.Provider value={selectionValue}>
        <PlaybackContext.Provider value={playbackValue}>
         <DebugVisibilityContext.Provider value={debugVisibilityValue}>
          <AssetLibraryContext.Provider value={assetLibraryValue}>
            <DocumentContext.Provider value={documentValue}>
              <ProjectContext.Provider value={projectValue}>
                <EditorSessionsContext.Provider value={editorSessionsValue}>
                  {props.children}
                </EditorSessionsContext.Provider>
              </ProjectContext.Provider>
            </DocumentContext.Provider>
          </AssetLibraryContext.Provider>
         </DebugVisibilityContext.Provider>
        </PlaybackContext.Provider>
      </SelectionContext.Provider>
    </EventBusContext.Provider>
    </EngineHostProvider>
  </EngineContext.Provider>
  );
}