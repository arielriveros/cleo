import { createContext, useContext, useState, useRef, useEffect, useMemo } from "react";
import { EventBusContext } from "./EventBusContext";
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
import { useStableActions } from "../utils/useStableActions";
import { describeChange, logDirtyMark, logDirtyClear, logDirtySkip } from "../utils/dirtyDebug";
import { CleoEngine, Scene, InputManager, Model, Geometry, Material, CustomMaterial, TerrainMaterial, Terrain, Node, ModelNode, CameraNode, AnimatedModel, TextureManager, AudioManager, Logger, Loader, buildBoneMapping, mappingReport, retargetAnimation, describeRetarget, setGameHost, registerTemplates, disposeModelSubtree, foliageRuleKey } from "cleo";
import type { SceneChange, TerrainFoliageRule } from "cleo";
import NullImage from '../images/null.png';
import EventEmitter from "../utils/eventEmitter";
import { createEmptyScene, ensureEditorCamera } from './demoScene/createEmptyScene';
import { createMaterialPreviewScene } from './demoScene/createMaterialPreviewScene';
import { previewSphereGeometry, PREVIEW_TERRAIN_RADIUS, PREVIEW_TERRAIN_SIZE, REFERENCE_LANDSCAPE }
  from './demoScene/previewFraming';
import { buildTerrainPreviewSubject } from './demoScene/previewTerrainSubject';
import { createAnimationEditorScene } from './demoScene/createAnimationEditorScene';
import { createAssetEditScene } from './demoScene/createAssetEditScene';
import { parseByType, regenerateIds, stripDebug } from "../utils/nodeSubtree";
import { cryptoRandomId } from "../utils/ids";
import { Template, buildTemplateFromNode, instantiateTemplate, TEMPLATE_ID_VAR } from "../utils/templates";
import { MaterialAsset, buildMaterialAsset, applyMaterialAsset, getMaterialIdOf, getMaterialIdsOf, getNodeMaterial, unlinkToFallback, unlinkMaterialAt, materialSlotsReferencing, resolveMaterialRefs, serializedVar, MATERIAL_ID_VAR, MATERIAL_IDS_VAR } from "../utils/materials";
import { getScreenMaterialIds, applyScreenMaterials } from "../utils/screenMaterials";
import { TerrainMaterialAsset, buildTerrainMaterialAsset, parseTerrainMaterialAsset, applyTerrainMaterialToLayer, collectTerrainMaterialTextureIds } from "../utils/terrainMaterials";
import { buildFoliageRuleFromModelAsset } from "../utils/foliageRules";
import { ModelAsset, ModelLodDef, MODEL_ID_VAR, buildModelAsset, instantiateModelAsset, separateSubModels, mergeSubModels, groupSubModels, nodeJsonHasSkinnedModel, lodLevelJson, nodeJsonHasModel, modelIdOf, refreshModelClips, assetWithClipAdded, assetWithClipRenamed, assetWithClipRemoved, assetWithClipRootMotion, assetWithBoneNames, assetWithIkRig, flattenModelAsset, skinnedModelJsonOf, assetWithoutEmbeddedClips, modelAssetHasLodBehavior, applyModelTransformDelta, readModelBaseTrs, modelNodeOf, LOD_CULL_MARGIN, DEFAULT_IMPOSTOR_DISTANCE } from "../utils/models";
import { ScriptAsset, ScriptBaseType, SCRIPT_ID_VAR, buildScriptAsset, applyScriptAsset, unlinkScript, getScriptIdOf, defaultScriptClass, seedScriptFields } from "../utils/scripts";
import { pushExternalSource } from "./scriptWorkspace/externalSourceStore";
import { AnimationAsset, buildAnimationAsset, storeSkin, findEquivalentAnimation, withAnimationRef, withoutAnimationRef, extractEmbeddedClips } from "../utils/animationAssets";
import { modelAssetSkin, applyModelAnimations, invalidateAnimationCache, resolveAnimationAsset } from "../utils/animationResolve";
import { AnimationFieldAsset, firstSkinnedModelNode, modelAssetIsSkinned, reembedFields, machineUsesField } from "../utils/animationFields";
import { TilesetAsset, reembedTilesets, detachTileset } from "../utils/tilesets";
import type { ImageAsset } from "../utils/images";
import type { AudioSourceAsset } from "../utils/audioSources";
import type { SoundSampleAsset } from "../utils/soundSamples";
import { toTextureConfig } from "../utils/textureAssets";
import type { TextureAsset } from "../utils/textureAssets";
import { groupImportFiles } from "../utils/importGrouping";
import {
  normalizeRootScale, meshBoundsRadius, combineBounds, awaitSubtreeTexturesReady, captureMaterialSphere,
  renderModelAssetThumbnail,
  setThumbnailDirtySuppressor, bakeModelImpostor, impostorTextureId } from "../utils/modelThumbnails";
import { parseBundleToRoot, type UnresolvedTexture } from "../utils/modelImport";
import { isValidGrouping, compactGroups, type PartInfo } from "../utils/submeshGroups";
import { readModelLibrary, writeModelLibrary } from "../utils/modelStore";
import { generateLodLevel, hasSkinnedPart, subtreeTriangles } from "../utils/lodGenerate";
import { registerFoliageSourceResolver } from "../utils/foliageRules";
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
import { resyncScene } from "../utils/sceneResync";
import { migrateSceneSprites } from "../utils/spriteMigration";
import { captureAnimationState, restoreAnimationState } from "../utils/placedAnimation";
import { buildAssetHashes, hashAsset, AssetLibs, ASSET_HASH_VERSION } from "../utils/assetHash";
import {
  collectReferencedMaterialIds, collectReferencedModelIds, collectReferencedTemplateIds,
  collectReferencedTerrainMaterialIds, collectReferencedTextureIds, collectReferencedScriptIds,
  collectReferencedTilesetIds,
} from "../utils/references";
import { idbGet, idbSet } from "../utils/idb";
import { KEYS, libKey } from "../utils/storageKeys";
import { assetIdOfTab, loadTabState, saveTabState, MainMode } from "../utils/tabState";
import { activeProjectAllowsLegacyImport, touchProject } from "../utils/projects";
import { activeProjectId } from "../utils/projectScope";
import { preloadTextures, persistTextures, adoptLegacyTextures, referencedTextureIds, legacyTexturesOf, deleteTextures } from "../utils/textureStore";
import { preloadAudio, persistAudio } from "../utils/audioStore";
import { startTask, StepStatus } from "./progress/progressStore";
import { reconcileEditorHelpers } from "../utils/editorHelpers";
import { readBackendPreference } from './renderer/backendPreference';
import { deepClone } from '../utils/deepClone';
import { buildProbeIconDataURL, buildLightIconDataURL, buildSoundIconDataURL } from './editorIcons';
import { ImportStage, IMPORT_STAGES, AnimImportStage, ANIM_IMPORT_STAGES } from './importStages';
import { usePersistedLibrary, usePersistedModelLibrary } from './persistLibrary';
import { useAssetThumbnails } from './hooks/useAssetThumbnails';
import { useSaving } from './hooks/useSaving';
import { usePendingDecisions } from './hooks/usePendingDecisions';
import { useTilesetEditor } from './hooks/useTilesetEditor';
import { useTextureEditor } from './hooks/useTextureEditor';
import { useSoundEditor } from './hooks/useSoundEditor';
import { useAnimationFieldEditor } from './hooks/useAnimationFieldEditor';
import {
  EDITOR_CLEAR_COLOR, LEGACY_CLEAR_COLOR, TAB_METERS_EXPOSURE, TAB_RUNS_POST_PROCESSING, SCENE_TAB_ID,
  KIND_LABEL,
} from './engineContextTypes';
import type {
  PendingModelImportView, ModelImportDecision, PendingAnimationImportView, PendingRigPickView,
  AnimationImportDecision, BodyDescription, ShapeDescription, LoadingProgress, EditorMode, GizmoMode,
  SavingState, TabKind, ModelEditSession, EditorTab, TerrainBrushState, TilemapBrushState,
} from './engineContextTypes';

// The types, constant tables and standalone helpers this file used to declare inline now live in sibling
// modules. They are re-exported here verbatim so every consumer keeps importing them from EngineContext.
export {
  EDITOR_CLEAR_COLOR, MODE_RENDERS_VIEWPORT, TAB_METERS_EXPOSURE, TAB_RUNS_POST_PROCESSING,
  SCENE_TAB_ID, KIND_LABEL,
} from './engineContextTypes';
export type {
  PendingModelImportView, ModelImportDecision, RetargetBoneOption, PendingAnimationImportView,
  PendingRigPickView, AnimationImportDecision, BodyDescription, ShapeDescription, LoadingProgress,
  EditorMode, GizmoMode, SavingState, TabKind, ModelEditSession, EditorTab, TerrainTool,
  TerrainBrushMode, TerrainBrushState, TilemapTool, TilemapBrushState,
} from './engineContextTypes';

const EngineContext = createContext<{
  instance: CleoEngine | null;
  editorScene: Scene;
  mainScene: Scene; // the game scene (editorScene may be a template/material preview scene)
  eventEmitter: EventEmitter;
  selectedNode: string | null;
  isGizmoDragging: boolean;
  isPlayMode: boolean;
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
  tabs: EditorTab[];
  activeTabId: string;
  activeTab: EditorTab;
  dirtyTabs: Record<string, boolean>;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
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
  enterTemplateEditor: (templateId?: string) => void;
  editingTemplateName: string | null;
  templateRootId: string | null;
  enterMaterialEditor: (materialId?: string) => void;
  createMaterialForNode: (node: Node, submesh?: number) => void;
  editingMaterialName: string | null;
  setActiveMaterialName: (name: string) => void;
  enterTerrainMaterialEditor: (terrainMaterialId?: string) => void;
  editingTerrainMaterialName: string | null;
  editingTerrainMaterialNode: Node | null;
  refreshTerrainMaterialPreview: () => void;
  /** Delete the runtime foliage layer a rule scattered, across every live scene. See the impl. */
  dropFoliageLayer: (rule: TerrainFoliageRule) => void;
  /** Bake a flat card for a foliage rule's model and point the rule's impostor at it. */
  bakeFoliageImpostor: (rule: TerrainFoliageRule) => Promise<string | null>;
  setActiveTerrainMaterialName: (name: string) => void;
  enterAnimationEditor: (nodeId: string) => void;
  animationTargetId: string | null; // cloned skinned model in the active animation tab's scene
  animationSourceId: string | null; // original node in the main scene (state-machine write-back target)
  animationSourceScene: Scene | null; // scene the source node lives in (for Variable parameter pickers)
  commitAnimationStateMachine: (sm: any) => void;
  terrainBrush: React.MutableRefObject<TerrainBrushState>;
  tilemapBrush: React.MutableRefObject<TilemapBrushState>;
  loadingProgress: LoadingProgress;
  scripts: Map<string, string>;
  bodies: Map<string, BodyDescription>;
  triggers: Map<string, { shapes: ShapeDescription[]; }>;
  startPlay: () => void;
  stopPlay: () => void;
  pausePlay: () => void;
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
/** Open (or focus) a Tileset asset's edit tab. Creates a fresh, atlas-less one when given no id. */
  enterTilesetEditor: (tilesetId?: string) => void;
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
  linkAnimationToModel: (modelId: string, animationId: string) => void;
  unlinkAnimationFromModel: (modelId: string, animationId: string) => void;
  /** Rename a clip inside a shared `.anim` asset, or toggle its root motion. */
  editSharedClip: (animationId: string, clipName: string, patch: { name?: string; rootMotion?: boolean }) => void;
  modelSession: ModelEditSession | null;
  /** Node id of the active LOD level's root in the model tab scene (viewport drop parent), or null. */
  modelEditTargetId: string | null;
  setActiveModelName: (name: string) => void;
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
  importAnimationFiles: (files: File[]) => Promise<void>;
  importSkeletonNames: (files: File[]) => Promise<void>;
  /** Persist the IK rig for the model open in the Animation Editor, to the asset and every instance. */
  commitIkRig: (rig: any | null) => void;
  /** The IK rig currently on the Animation Editor's model, or null. */
  currentIkRig: () => any | null;
  renameAnimationClip: (oldName: string, newName: string) => string;
  removeAnimationClip: (name: string) => void;
  setClipRootMotion: (name: string, on: boolean) => void;
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
    mainScene: new Scene(),
    eventEmitter: new EventEmitter(),
    selectedNode: null,
    isGizmoDragging: false,
    isPlayMode: false,
    isSceneReady: false,
    texturesPreloaded: false,
    audioPreloaded: false,
    editorMode: 'scene',
    setEditorMode: () => {},
    gizmoMode: 'position',
    setGizmoMode: () => {},
    tabs: [{ id: SCENE_TAB_ID, kind: 'scene', title: 'Scene' }],
    activeTabId: SCENE_TAB_ID,
    activeTab: { id: SCENE_TAB_ID, kind: 'scene', title: 'Scene' },
    dirtyTabs: {},
    setActiveTab: () => {},
    closeTab: () => {},
    reorderTabs: () => {},
    saveActiveTab: async () => false,
    saveAll: async () => {},
    registerAnimationApply: () => {},
    registerTilesetApply: () => {},
    registerTextureApply: () => {},
    registerSoundApply: () => {},
    enterTemplateEditor: () => {},
    editingTemplateName: null,
    templateRootId: null,
    enterMaterialEditor: () => {},
    createMaterialForNode: () => {},
    editingMaterialName: null,
    setActiveMaterialName: () => {},
    enterTerrainMaterialEditor: () => {},
    editingTerrainMaterialName: null,
    editingTerrainMaterialNode: null,
    refreshTerrainMaterialPreview: () => {},
    dropFoliageLayer: () => {},
    bakeFoliageImpostor: async () => null,
    setActiveTerrainMaterialName: () => {},
    enterAnimationEditor: () => {},
    animationTargetId: null,
    animationSourceId: null,
    animationSourceScene: null,
    commitAnimationStateMachine: () => {},
    terrainBrush: { current: { mode: 'sculpt', tool: 'raise', radius: 10, strength: 8, falloff: 0.5, paintLayer: 0, foliageErase: false, activeLandscapeId: null } },
    tilemapBrush: { current: { tool: 'brush', activeTilemapId: null, activeLayer: 0, stamp: { w: 1, h: 1, tiles: [0] }, orient: { flipX: false, flipY: false, rot90: false }, variantSetId: null, terrainId: null } },
    loadingProgress: { loaded: 0, total: 6, label: 'Starting…' },
    scripts: new Map(),
    bodies: new Map(),
    triggers: new Map(),
    startPlay: () => {},
    stopPlay: () => {},
    pausePlay: () => {},
    templates: [],
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
    enterSoundEditor: () => {},
    saveSoundSample: () => {},
    previewSoundSettings: () => {},
    updateTextureAsset: () => {},
    tilesets: [],
    addTileset: () => {},
    removeTileset: () => {},
    updateTileset: () => {},
    enterTilesetEditor: () => {},
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
    linkAnimationToModel: () => {},
    unlinkAnimationFromModel: () => {},
    editSharedClip: () => {},
    modelSession: null,
    modelEditTargetId: null,
    setActiveModelName: () => {},
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
    setClipRootMotion: () => {},
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

export function EngineProvider(props: { children: React.ReactNode }) {
  const instanceRef = useRef<CleoEngine | null>(null);
  const editorSceneRef = useRef<Scene>(createEditorScene());
  const eventEmitter = useRef(new EventEmitter());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [isGizmoDragging, setIsGizmoDragging] = useState(false);
  const [isPlayMode, setIsPlayMode] = useState(false);
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
  /** Where Play was pressed from, so Stop can put the user back. Null while play started on the scene tab. */
  const playReturnRef = useRef<{ tabId: string; mainMode: MainMode } | null>(null);
  /** Play is waiting for the forced switch to the scene tab to commit (see startPlay). */
  const pendingPlayRef = useRef(false);
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
  const tabRuntimeRef = useRef<Map<string, { scene: Scene; rootId: string; sourceScene?: Scene; sourceNodeId?: string; sourceTabId?: string; tm?: TerrainMaterial; helperTerrain?: Terrain; editNode?: ModelNode }>>(new Map());
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
  const terrainBrush = useRef<TerrainBrushState>({ mode: 'sculpt', tool: 'raise', radius: 10, strength: 8, falloff: 0.5, paintLayer: 0, foliageErase: false, activeLandscapeId: null });
  const tilemapBrush = useRef<TilemapBrushState>({
    tool: 'brush', activeTilemapId: null, activeLayer: 0,
    stamp: { w: 1, h: 1, tiles: [0] },
    orient: { flipX: false, flipY: false, rot90: false },
    variantSetId: null, terrainId: null,
  });
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress>({ loaded: 0, total: 6, label: 'Starting…' });
  const isGizmoDraggingRef = useRef(false);
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
    setTemplates(prev => prev.filter(x => x.id !== id));
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
        const list = await readModelLibrary();
        // The baseline is the RAW list, before the flatten below: an asset flattenModelAsset actually
        // changed comes back as a NEW object and so gets written, while one it left alone is the same
        // object and is skipped. Seeding with the flattened list instead would lose that migration.
        persistedModelsRef.current = list;
        // One-shot flatten of legacy assets that still carry a holder node. flattenModelAsset returns the
        // same object when there is nothing to do, and node ids are preserved.
        if (list.length) setModels(prev => prev.length ? prev : list.map(flattenModelAsset));
      } catch (e) { Logger.error(`Failed to load the model library: ${e}`, 'Editor'); }
      finally { modelsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedModelLibrary(models, modelsLoadedRef, persistedModelsRef);

  // Reactive edit state for open mesh tabs (tab id -> session). The tab's Scene stays in tabRuntimeRef;
  // this holds what the Mesh inspector renders (LOD level ids/distances, cull distance, active level).
  const [modelSessions, setModelSessions] = useState<Record<string, ModelEditSession>>({});

  const addModel = (m: ModelAsset) => setModels(prev => [...prev, m]);
  const removeModel = (id: string) => {
    // A preview tab for a deleted mesh would render a subtree whose asset no longer exists — close it
    // first. Safe to reference the later-declared tab helpers: this only ever runs from a click.
    const openTab = tabs.find(t => t.kind === 'model' && t.modelId === id);
    if (openTab) removeTabById(openTab.id);
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
  // A model asset names the animations it uses by id (`animationIds`) — see utils/animationAssets.ts.
  const [animations, setAnimations] = useState<AnimationAsset[]>([]);
  /** Bump to re-sweep model assets for embedded clips on next load. See the migration below. */
  const ANIMATION_ASSET_MIGRATION = 2;
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
          const models = await readModelLibrary();
          const r = extractEmbeddedClips(models, list, skinnedModelJsonOf, assetWithoutEmbeddedClips);
          if (r.extracted || r.shared) {
            // No `preAnimationAssets` backup any more. It was a second full copy of a library big enough
            // to be the problem, and the extraction only ever REMOVES clips that were just written to the
            // animation library — so the data still exists, addressed differently.
            await writeModelLibrary(r.models, models);
            persistedModelsRef.current = r.models; // storage now holds these; don't re-write them
            await idbSet(libKey('animations'), r.animations);
            setModels(prev => (prev.length ? r.models.map(flattenModelAsset) : prev));
            Logger.info(`Animation library: extracted ${r.extracted} clip${r.extracted === 1 ? '' : 's'}` +
              (r.shared ? `, ${r.shared} already shared with another model` : ''), 'Editor');
            setAnimations(prev => prev.length ? prev : r.animations);
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
    // Drop the reference from every model that used it. Clips already instantiated on live nodes are left
    // alone — a copy the user can still see and delete.
    for (const m of modelsRef.current) {
      const next = withoutAnimationRef(m, id);
      if (next !== m) updateModel(m.id, next);
    }
  };

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
        if (list && list.length) setTilesets(prev => prev.length ? prev : list);
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
  const saveScriptSource = (id: string, source: string) => {
    const existing = scriptAssetsRef.current.find(a => a.id === id);
    if (!existing) return;
    const next = buildScriptAsset(existing.name, existing.baseType, source, id);
    updateScriptAsset(id, next);
    // Propagation only — the nodes store __scriptId and the source is fanned out at serialize time, so
    // this must not mark the scene dirty (see the note in saveMaterialTab).
    withoutDirty(() => {
      for (const scene of liveScenes()) {
        for (const n of Array.from(scene.nodes)) {
          if (getScriptIdOf(n) !== id) continue;
          scriptsRef.current.set(n.id, source);
          seedScriptFields(n, next, false);
        }
      }
      eventEmitter.current.emit('SCENE_CHANGED');
    });
  };

  // Dedicated Script editor tab: opens a script asset in a full-panel code editor (its own mode + Save
  // Script button). Working source buffers per-tab (scriptTabSourceRef) until Save.
  const scriptTabSourceRef = useRef(new Map<string, string>());
  const enterScriptEditor = (scriptId?: string, adoptTabId?: string) => {
    let id = scriptId;
    // Held across the mint because scriptAssetsRef is mirrored during RENDER: a just-added asset is not in
    // it yet, so looking the new script up below would miss it.
    let created: ScriptAsset | null = null;
    if (!id) {
      // No id: mint a new 'node'-based script and open it.
      created = buildScriptAsset('New Script', 'node', defaultScriptClass('New Script', 'node'));
      addScriptAsset(created);
      id = created.id;
      scriptTabSourceRef.current.set(id, created.source);
    }
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
    const timer = window.setInterval(() => {
      if (templatesLoadedRef.current && materialsLoadedRef.current && terrainMaterialsLoadedRef.current && modelsLoadedRef.current && scriptAssetsLoadedRef.current && animationFieldsLoadedRef.current && animationsLoadedRef.current && scenesLoadedRef.current && imagesLoadedRef.current && texturesLoadedRef.current && audioSourcesLoadedRef.current && soundSamplesLoadedRef.current) {
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
  const initialAssetHashesRef = useRef<{ hashes: Record<string, string> | undefined } | null>(null);
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
  useEffect(() => {
    if (initialResyncDoneRef.current || !assetsLoaded || !isSceneReady) return;
    const stashed = initialAssetHashesRef.current;
    if (!stashed) return; // no blob was parsed (fresh/empty project) — nothing to re-resolve
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
    // Propagation, not the user's work — resyncing must not make a freshly-opened scene look unsaved.
    withoutDirty(() => {
      const changed = resyncScene(editorSceneRef.current, engineMaps(), libs, stashed.hashes);
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
        case 'texture': return texturesRef.current.some(t => t.id === id);
        case 'soundSample': return soundSamplesRef.current.some(x => x.id === id);
        // A field also needs the model it blends — enterAnimationFieldEditor refuses to open without it.
        case 'animationField': {
          const field = fields.find(f => f.id === id);
          return !!field && libs.models.some(m => m.id === field.modelId);
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
  }, [assetsLoaded, isSceneReady]);

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
  // Single mode value, derived from the active tab kind, for `editorMode === ...` consumers.
  const editorMode: EditorMode = activeTab.kind === 'scene' ? mainMode
    : activeTab.kind === 'material' ? 'material'
    : activeTab.kind === 'terrainMaterial' ? 'terrainMaterial'
    : activeTab.kind === 'animation' ? 'animation'
    : activeTab.kind === 'animationField' ? 'animationField'
    : activeTab.kind === 'model' ? 'model'
    : activeTab.kind === 'script' ? 'script'
    : activeTab.kind === 'tileset' ? 'tileset'
    : activeTab.kind === 'texture' ? 'texture'
    : 'template';
  const templateRootId = activeTab.kind === 'template' && activeRuntime ? activeRuntime.rootId : null;
  const editingTemplateName = activeTab.kind === 'template' ? activeTab.title : null;
  const editingMaterialName = activeTab.kind === 'material' ? activeTab.title : null;
  const editingTerrainMaterialName = activeTab.kind === 'terrainMaterial' ? activeTab.title : null;
  // The unrendered edit node (its material is the TerrainMaterial) that the terrain-material inspector edits.
  const editingTerrainMaterialNode = activeTab.kind === 'terrainMaterial' ? (activeRuntime?.editNode ?? null) : null;
  // Animation editor: the cloned skinned model in the tab's scene (target to preview/edit) and the
  // original node in the main scene (where authored state machines are written back).
  const animationTargetId = activeTab.kind === 'animation' && activeRuntime ? activeRuntime.rootId : null;
  const animationSourceId = activeTab.kind === 'animation' ? (activeTab.animationSourceId ?? null) : null;
  // The scene the source node lives in (main or a template tab) — used to enumerate accessible
  // node variables for the state machine's Variable parameters (the clone's scene is isolated).
  const animationSourceScene = activeTab.kind === 'animation' ? (activeRuntime?.sourceScene ?? null) : null;
  // Animation Field editor: the asset being edited and the skinned model previewing it. The tab's runtime
  // root is the holder Node the model asset instantiated under, so the ModelNode carrying the skin is found
  // beneath it rather than being the root itself.
  const editingAnimationFieldId = activeTab.kind === 'animationField' ? (activeTab.animationFieldId ?? null) : null;
  const animationFieldTargetId = activeTab.kind === 'animationField' && activeRuntime
    ? (firstSkinnedModelNode(activeRuntime.scene.getNodeById(activeRuntime.rootId) ?? null)?.id ?? null)
    : null;
  const editingTilesetId = activeTab.kind === 'tileset' ? (activeTab.tilesetId ?? null) : null;
  const editingTextureId = activeTab.kind === 'texture' ? (activeTab.textureId ?? null) : null;
  const editingSoundId = activeTab.kind === 'soundSample' ? (activeTab.soundId ?? null) : null;

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
    tilesets: tilesetsRef.current, animations: animationsRef.current,
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
    tabRuntimeRef.current.set(tabId, { scene, rootId });
    // the activate effect swaps the engine scene + dimension + selection
    commitTab({ id: tabId, kind: 'template', title: name, templateId: templateId ?? null }, adoptTabId);
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
        const parent = inst.parent;
        if (!parent) continue;
        const pos = Array.from(inst.position) as [number, number, number];
        const rot = Array.from(inst.rotation) as [number, number, number];
        const scl = Array.from(inst.scale) as [number, number, number];
        // Per-instance node state the rebuild would otherwise drop — the subtree is reconstructed from the
        // ASSET, which knows nothing about how this particular placement was configured.
        const spawnOnStart = inst.spawnOnStart;
        const wasSelected = inst.id === selectedNode;
        // Animation state, restored only where the TEMPLATE has none of its own (see restoreAnimationState):
        // a template with no machine must not wipe one the instance was configured with directly.
        const animation = captureAnimationState(inst as any);
        // Drop the old subtree's out-of-band data so map entries don't leak.
        for (const id of collectSubtreeIds(inst)) { maps.scripts.delete(id); maps.bodies.delete(id); maps.triggers.delete(id); }
        // Detach synchronously: Node.remove() only marks for removal, and the deferred sweep calls
        // root.removeChild on each marked descendant, which mis-splices and deletes unrelated root
        // children (including the node we're about to re-instantiate). removeChild cleanly drops the subtree.
        parent.removeChild(inst);
        const newId = instantiateTemplate(template, parent, maps, materialsRef.current); // re-tags __templateId
        const newNode = scene.getNodeById(newId);
        if (newNode) {
          newNode.setPosition(pos).setRotation(rot).setScale(scl);
          newNode.spawnOnStart = spawnOnStart;
          restoreAnimationState(newNode as any, animation);
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

  // Public mode switch — only the Main tab's sub-mode (scene/landscape/renderer). Template/material/
  // animation editing are tabs now (opened via enter*Editor), not modes, so they aren't accepted here.
  const setEditorMode = (mode: EditorMode) => {
    if (mode === 'scene' || mode === 'landscape' || mode === 'tilemap' || mode === 'ui' || mode === 'renderer') setMainMode(mode);
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
  const enterAnimationEditor = async (nodeId: string) => {
    const instance = instanceRef.current;
    if (!instance) return;

    // Focus an already-open animation tab for this node instead of duplicating it.
    const existing = tabs.find(t => t.kind === 'animation' && t.animationSourceId === nodeId);
    if (existing) { setActiveTab(existing.id); return; }

    // The source lives in whatever scene is currently active (main scene OR a template tab's scene).
    const sourceScene = activeScene;
    const sourceTabId = activeTabId;
    const source = sourceScene.getNodeById(nodeId);
    if (!(source instanceof ModelNode) || !(source.model instanceof AnimatedModel) || !source.model.hasSkin || !source.animator) {
      Logger.error('Animation Editor requires a skinned model', 'Editor');
      return;
    }

    // Disarm before constructing the clone's scene — see openMaterialTab.
    dirtyArmedRef.current = false;
    // Clone the source node (with its skin, animations, mappings and state machine) into a fresh scene.
    const scene = new Scene();
    scene.animationsEnabled = false; // the AnimationPlayer drives the clone directly, not scene.update
    scene.spawnRulesEnabled = false; // ...and a spawnOnStart=false node still shows while it is being authored
    const json = await source.serialize();
    stripDebug(json);
    regenerateIds(json, new Map()); // distinct ids so the clone never collides with the original

    // Clone under a HOLDER carrying the source's accumulated world scale/rotation, not straight under
    // scene.root: a skinned import cannot bake its fit-to-size factor into vertices, so normalizeRootScale
    // puts that factor entirely on the holder ABOVE the ModelNode.
    const holder = new Node(`${source.name} (holder)`);
    scene.addNode(holder);
    const worldScale = source.parent ? source.parent.worldScale : [1, 1, 1];
    holder.setScale([worldScale[0], worldScale[1], worldScale[2]]);
    parseByType(holder, json);
    const cloneRootId = json.id;
    const clone = scene.getNodeById(cloneRootId) as ModelNode | null;
    if (!clone) { Logger.error('Failed to clone model for the Animation Editor', 'Editor'); return; }

    // Frame the camera + build the shadow-catching ground around the clone's bounds.
    scene.root.updateTransforms();
    const bounds = combineBounds(clone);
    createAnimationEditorScene(scene, bounds.center, bounds.radius);
    scene.start();
    clone.animator?.showBindPose(); // start from the rest pose

    const tabId = cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: cloneRootId, sourceScene, sourceNodeId: nodeId, sourceTabId });
    setTabs(prev => [...prev, { id: tabId, kind: 'animation', title: `${source.name} (Anim)`, animationSourceId: nodeId }]);
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
   * Re-resolve a model asset's SHARED clips (`animationIds`) onto everything showing that model — the
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
  const linkAnimationToModel = (modelId: string, animationId: string) => {
    const asset = modelsRef.current.find(m => m.id === modelId);
    const anim = animationsRef.current.find(a => a.id === animationId);
    if (!asset || !anim) return;
    const linked = withAnimationRef(asset, animationId);
    if (linked === asset) return; // already linked
    updateModel(modelId, linked);
    invalidateAnimationCache(animationId);
    applyAnimationLinks(linked);
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    Logger.info(`Linked "${anim.name}" to "${asset.name}"`, 'Editor');
  };

  /** Drop a `.anim` link. Its clips disappear from every placement — applyModelAnimations removes them. */
  const unlinkAnimationFromModel = (modelId: string, animationId: string) => {
    const asset = modelsRef.current.find(m => m.id === modelId);
    if (!asset) return;
    const unlinked = withoutAnimationRef(asset, animationId);
    if (unlinked === asset) return;
    updateModel(modelId, unlinked);
    invalidateAnimationCache(animationId);
    applyAnimationLinks(unlinked);
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    Logger.info(`Unlinked "${animationsRef.current.find(a => a.id === animationId)?.name ?? animationId}" from "${asset.name}"`, 'Editor');
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
      if (model.animationIds?.includes(animationId)) applyAnimationLinks(model, null, updated);
    }
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
  };

  // Import animation clips from a file (gltf/glb/fbx) into the model being edited in the Animation Editor:
  // parse, build a bone MAPPING onto the model's skeleton, review it in the modal, then RETARGET each
  // accepted clip and add it to the preview clone, the source node, the model asset and every placement.
  const importAnimationFiles = async (files: File[]) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = animationTargetId ? activeScene.getNodeById(animationTargetId) : null;
    const cloneModel = (cloneNode instanceof ModelNode && cloneNode.model instanceof AnimatedModel && cloneNode.model.skin)
      ? cloneNode.model : null;
    const fileName = files.find(f => /\.(gltf|glb|fbx)$/i.test(f.name))?.name ?? files[0]?.name ?? 'animation';

    // Which rig to retarget onto: the Animation Editor's open character when there is one, otherwise the
    // user picks from the skinned models in the library.
    const rigChoices = modelsRef.current.filter(m => modelAssetIsSkinned(m));
    const openRigId = cloneNode ? modelIdOf(cloneNode) : undefined;
    let rigId = openRigId;
    if (!rigId) {
      if (!rigChoices.length) {
        Logger.error('Import a skinned model first — an animation needs a rig to retarget onto', 'Editor');
        return;
      }
      rigId = await new Promise<string | null>(resolve => {
        pendingRigResolverRef.current = resolve;
        setPendingRigPick({ fileName, models: rigChoices.map(m => ({ id: m.id, name: m.name })) });
      }) ?? undefined;
      if (!rigId) { Logger.info('Animation import cancelled', 'Editor'); return; }
    }
    const rigAsset = modelsRef.current.find(m => m.id === rigId);
    const targetSkin = cloneModel?.skin ?? modelAssetSkin(rigAsset);
    if (!rigAsset || !targetSkin) {
      Logger.error('That model has no skeleton to retarget onto', 'Editor');
      return;
    }

    // One task for the whole import, ending in a `finally` so no early return leaves a spinning card.
    // Single-step on purpose: ProgressWindow renders a lone step as header + detail, not a row list.
    const task = startTask({
      title: 'Importing animation',
      steps: [{ name: fileName, status: 'pending' as StepStatus, detail: 'Queued' }],
      cancellable: true,
      // Two things to unblock: a parse running in the worker, and a flow parked on the review modal.
      onCancel: () => {
        cancelAllImports();
        if (pendingAnimResolverRef.current) resolveAnimationImport(null);
      },
    });
    const setStage = (stage: AnimImportStage, detail?: string, error?: string) => {
      const s = ANIM_IMPORT_STAGES[stage];
      task.setStep(0, {
        status: s.status,
        progress: s.progress,
        detail: detail ?? (s.status === 'running' || s.status === 'paused' ? s.label : undefined),
        error,
      });
    };

    try {
    // Parsed in the import worker: for an .fbx this is an uninterruptible assimp WASM call.
    let parsed: { animations: any[]; skin: any };
    setStage('parsing', `Reading ${fileName}`);
    try { parsed = await parseAnimationFiles(files, (_fraction, stage) => setStage('parsing', stage || undefined)); }
    catch (e) {
      if (e instanceof ImportCancelled || task.cancelled) {
        setStage('skipped', 'Cancelled');
        Logger.info('Animation import cancelled', 'Editor'); return;
      }
      setStage('failed', undefined, String(e));
      Logger.error('Failed to parse animation file: ' + e, 'Editor'); return;
    }
    if (!parsed.animations.length) {
      setStage('failed', 'No animation clips in the file');
      Logger.warn('No animation clips found in the file', 'Editor'); return;
    }
    if (!parsed.skin) {
      setStage('failed', 'No skeleton to match against');
      Logger.warn('The imported file has no skeleton to match against', 'Editor'); return;
    }
    const sourceSkin = parsed.skin;

    // ONE mapping for the whole file — every clip in it shares the source skeleton, so matching is done once
    // and each clip's report is derived cheaply from it (and re-derived as the user edits rows in the modal).
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

    setStage('review', `${parsed.animations.length} clip${parsed.animations.length === 1 ? '' : 's'} — awaiting review`);
    const decision = await new Promise<AnimationImportDecision | null>(resolve => {
      pendingAnimResolverRef.current = resolve;
      setPendingAnimationImport({
        fileName,
        clips: parsed.animations.map(clip => ({
          name: clip.name,
          report: mappingReport(clip, sourceSkin, targetSkin, mapping),
          animatedNodes: [...new Set(clip.channels.map((ch: any) => ch.targetNodeIndex))] as number[],
        })),
        mapping, sourceBones, targetBones,
      });
    });
    if (!decision) {
      setStage('skipped', 'Cancelled at review');
      Logger.info('Animation import cancelled', 'Editor'); return;
    }
    const finalMapping = decision.mapping; // the user may have re-pointed bones

    const src = rt?.sourceScene && rt.sourceNodeId ? rt.sourceScene.getNodeById(rt.sourceNodeId) : null;

    // The clips are stored in the file's OWN rig space, exactly as parsed — no retarget is baked in. That
    // is what lets one stored walk serve every character sharing the rig, and it is why the source skin is
    // stored beside them: `buildBoneMapping` needs both sides, at every later use.
    setStage('retargeting', 'Storing clips');
    const kept = parsed.animations.filter((_: any, i: number) => decision.include[i]);
    if (!kept.length) {
      setStage('skipped', 'Nothing selected');
      Logger.info('No animation clips selected', 'Editor'); return;
    }
    const namedClips = kept.map((clip: any) => {
      const i = parsed.animations.indexOf(clip);
      const typed = (decision.names?.[i] ?? '').trim();
      return typed && typed !== clip.name ? { ...clip, name: typed } : clip;
    });

    // A second import of the same file should link the existing asset, not make a byte-identical twin —
    // matched on clip CONTENT, since the same Mixamo download is routinely renamed between imports.
    const existing = findEquivalentAnimation(animationsRef.current, namedClips as any);
    const animAsset = existing ?? buildAnimationAsset(
      namedClips[0]?.name || fileName.replace(/\.[^.]+$/, ''),
      namedClips as any, storeSkin(sourceSkin), fileName,
    );
    if (existing) Logger.info(`"${existing.name}" already holds these clips — linked it instead of storing a copy`, 'Editor');
    else addAnimation(animAsset);

    setStage('saving', 'Linking to the model');
    // The link lives on the MODEL asset, so every placement of that character picks the clips up.
    const linkedModel = withAnimationRef(rigAsset, animAsset.id);
    if (linkedModel !== rigAsset) updateModel(rigAsset.id, linkedModel);
    invalidateAnimationCache(animAsset.id);

    // Show it immediately on whatever is on screen: the Animation Editor's preview clone, the node it was
    // opened from, and every other placement of this character across every live scene.
    const resolved = resolveAnimationAsset(animAsset, targetSkin, rigAsset.id);
    if (cloneModel) for (const clip of resolved) cloneModel.addAnimation({ ...clip });
    if (src instanceof ModelNode && src.model instanceof AnimatedModel)
      for (const clip of resolved) src.model.addAnimation({ ...clip });
    applyAnimationLinks(linkedModel, src, animAsset);

    const added = namedClips.length;
    if (rt?.sourceTabId) markTabDirty(rt.sourceTabId, 'animation-import');
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    Logger.info(`Imported ${added} animation clip${added === 1 ? '' : 's'} from ${fileName} into "${rigAsset.name}"`, 'Editor');
    setStage('done', `Imported ${added} clip${added === 1 ? '' : 's'}`);
    } finally { task.finish(); }
  };

  // Backfill bone names onto a skinned model whose skeleton has none, so imported animations can match by
  // name instead of by node index. The user loads the SAME file the character came from; its bone names are
  // copied onto the model's skin joints by node index, which is identical for the same file.
  const importSkeletonNames = async (files: File[]) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = animationTargetId ? activeScene.getNodeById(animationTargetId) : null;
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
   * Persist the IK rig for the model being edited in the Animation Editor. A rig is joint indices into the
   * SKELETON, so it belongs to the model asset, not to whichever placement is open. Order matters: preview
   * clone first (so the viewport updates this frame), then the source node, the asset, then live instances.
   */
  const commitIkRig = (rig: any | null) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = animationTargetId ? activeScene.getNodeById(animationTargetId) : null;
    const applyTo = (n: Node | null | undefined) => {
      if (n instanceof ModelNode && n.model instanceof AnimatedModel && n.model.skin) {
        n.model.skin.ikRig = rig ?? undefined;
      }
    };
    applyTo(cloneNode);

    const src = rt?.sourceScene && rt.sourceNodeId ? rt.sourceScene.getNodeById(rt.sourceNodeId) : null;
    applyTo(src);

    const link = animationSourceAsset(src);
    if (link) {
      updateModel(link.id, assetWithIkRig(link.asset, rig));
      propagateModelClips(link.id, m => { if (m.skin) m.skin.ikRig = rig ?? undefined; }, src);
    }

    // No asset link means a hand-built skinned node: the edit stays local to it.
    if (rt?.sourceTabId) markTabDirty(rt.sourceTabId, 'animation-ik-rig');
    eventEmitter.current.emit('ANIM_IK_CHANGED');
  };

  /** The IK rig currently on the Animation Editor's model, or null. */
  const currentIkRig = (): any | null => {
    const cloneNode = animationTargetId ? activeScene.getNodeById(animationTargetId) : null;
    if (cloneNode instanceof ModelNode && cloneNode.model instanceof AnimatedModel) {
      return cloneNode.model.skin?.ikRig ?? null;
    }
    return null;
  };

  // Rename an animation clip on the Animation Editor's model (preview clone + source node so it persists).
  // Returns the final applied name (may be de-duped). Callers update state-machine references to it.
  const renameAnimationClip = (oldName: string, newName: string): string => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = animationTargetId ? activeScene.getNodeById(animationTargetId) : null;
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
    const cloneNode = animationTargetId ? activeScene.getNodeById(animationTargetId) : null;
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

  // Toggle root motion on an animation clip (preview clone + source node + asset + placed instances).
  const setClipRootMotion = (name: string, on: boolean) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = animationTargetId ? activeScene.getNodeById(animationTargetId) : null;
    if (cloneNode instanceof ModelNode && cloneNode.model instanceof AnimatedModel) cloneNode.model.setAnimationRootMotion(name, on);
    const src = rt?.sourceScene && rt.sourceNodeId ? rt.sourceScene.getNodeById(rt.sourceNodeId) : null;
    if (src instanceof ModelNode && src.model instanceof AnimatedModel) src.model.setAnimationRootMotion(name, on);

    const link = animationSourceAsset(src);
    if (link) {
      updateModel(link.id, assetWithClipRootMotion(link.asset, name, on));
      propagateModelClips(link.id, m => { m.setAnimationRootMotion(name, on); }, src);
    }

    if (rt?.sourceTabId) markTabDirty(rt.sourceTabId, 'animation-clip-root-motion');
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
      case 'script': enterScriptEditor(assetId, tab.id); break;
      // A tileset tab is a pure 2D editor over the library record — nothing to build, so it is live already.
      case 'tileset': return !!tab.tilesetId && tilesetsRef.current.some(t => t.id === tab.tilesetId);
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

  // Save a template tab back to the library and propagate the change to placed instances.
  const saveTemplateTab = async (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab || tab.kind !== 'template') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    if (!runtime) return;
    const rootNode = runtime.scene.getNodeById(runtime.rootId);
    if (!rootNode) return;
    try {
      const t = await buildTemplateFromNode(rootNode, engineMaps());
      if (tab.templateId) {
        const updated = { ...t, id: tab.templateId };
        updateTemplate(tab.templateId, updated);
        withoutDirty(() => syncTemplateInstances(tab.templateId!, updated, tab.id)); // propagate to placed instances
      } else {
        addTemplate(t); // t carries a fresh id
      }
      // Adopt the saved name/id so later saves update (not re-add) and the tab label stays in sync.
      setTabs(prev => prev.map(x => x.id === tab.id ? { ...x, title: t.name, templateId: tab.templateId ?? t.id } : x));
      clearTabDirty(tab.id);
      Logger.info(`Template "${t.name}" saved`, 'Editor');
    } catch (e) {
      Logger.error('Failed to save template: ' + e, 'Editor');
    }
  };

  // Low-level tab removal (no confirm). Shared by closeTab and removeMaterial (force-closing a deleted
  // material's tab). Main is unclosable.
  const removeTabById = (id: string) => {
    if (id === SCENE_TAB_ID) return;
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const remaining = tabs.filter(t => t.id !== id);
    tabRuntimeRef.current.get(id)?.helperTerrain?.dispose(); // free the preview terrain's splat/body
    tabRuntimeRef.current.delete(id);
    pendingHydrationRef.current.delete(id); // a closed tab never needs its session built
    setModelSessions(prev => { if (!(id in prev)) return prev; const next = { ...prev }; delete next[id]; return next; });
    clearTabDirty(id);
    setTabs(remaining);
    if (id === activeTabId) {
      const fallback = remaining[Math.max(0, idx - 1)] ?? remaining[0];
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
    void createMaterialPreviewScene(scene); // env map + skybox attach once the cubemap images load

    if (asset) {
      for (const t of asset.textures || []) {
        if (t?.id && !TextureManager.Instance.getTexture(t.id)) TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id);
      }
    }
    const material: Material = asset ? Material.parse(asset.material) : Material.PBR({});
    const sphere = new ModelNode('preview', new Model(previewSphereGeometry(), material));
    scene.addNode(sphere);
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
  const applyActiveModelLevel = (scene: Scene, levelIds: string[], active: number) => {
    for (let i = 0; i < levelIds.length; i++) {
      const root = scene.getNodeById(levelIds[i]);
      if (root) root.visible = i === active;
    }
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
    for (const lod of asset.lods ?? []) {
      const levelJson = lodLevelJson(lod, modelsRef.current);
      if (!levelJson) {
        Logger.warn(`LOD level of "${asset.name}" references a model that no longer exists — dropped`, 'Editor');
        continue;
      }
      lodRefs.push(lod);
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
      parseByType(scene.root, clone);
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
        // Drop the old subtree's out-of-band data so map entries don't leak.
        for (const id of collectSubtreeIds(inst)) { maps.scripts.delete(id); maps.bodies.delete(id); maps.triggers.delete(id); }
        // Detach synchronously with removeChild, not remove() — see syncTemplateInstances for why.
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
      const rules = tmAsset.material?.foliageInclude;
      return Array.isArray(rules) && rules.some((r: any) => r?.modelId === modelAsset.id);
    });
    if (affected.length === 0) return;

    // An OPEN terrain-material tab holds its own live TerrainMaterial whose rules still carry the
    // PREVIOUS prototypes. Drop them so the next resolve rebuilds from the saved model; the geometry is
    // derived, so clearing it is safe and is what a re-bake used to accomplish at 60 MB a go.
    for (const [tabId, rt] of tabRuntimeRef.current.entries()) {
      if (tabId === exceptTabId) continue;
      const tm = (rt as any).tm;
      if (!tm?.foliageInclude) continue;
      for (const rule of tm.foliageInclude)
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
      for (const r of tmAsset.material?.foliageInclude ?? []) if ((r as any)?.modelId) scattered.add((r as any).modelId);

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
   * Bake a flat card for a foliage rule's source model, register it, and point the rule at it.
   *
   * The single largest thing that can be done for a heavy foliage prototype. A LOD level reduces
   * triangles linearly; the card replaces them all with four, and past the distance it takes over the
   * difference is not visible. Returns the texture id, or null when the rule has no model behind it.
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

    const id = impostorTextureId(modelId);
    // The stored record has to go BEFORE the re-bake: `persistTextures` skips an id it already has, so
    // a second bake would leave the old card on disk and the new one only in memory until reload.
    await deleteTextures([id]);

    const baked = await bakeModelImpostor(engine, asset);
    if (!baked) return null;
    await persistTextures([baked.id]);

    // Past the whole mesh ladder. The renderer's impostor test SHORT-CIRCUITS the level selection, so a
    // distance inside the ladder would retire every level beyond it rather than extending the view.
    const bands = (rule.lods ?? []).map(l => l.distance).filter(d => d > 0);
    const takeover = rule.billboard?.distance
      ?? (bands.length ? Math.round(Math.max(...bands)) : DEFAULT_IMPOSTOR_DISTANCE);
    rule.billboard = { textureId: baked.id, distance: takeover };
    eventEmitter.current.emit('SCENE_CHANGED');
    return baked.id;
  };

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
          alive(n) && !previewIds.has(n.id) && !n.name.includes('__editor__') && !n.name.includes('__debug__');
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
          lodDefs, session.cullDistance,
        );
      } finally {
        // Put any wrapped nodes back where the user had them. The wrapper existed only to give
        // serialize() a single root; the live scene must look exactly as it did, saved or not.
        // withoutDirty: reparenting emits SCENE_CHANGED, which would re-dirty the tab we just saved.
        if (restore.length) withoutDirty(() => { for (const r of restore) r.parent.addChild(r.node); });
      }
      asset.name = tab.title; // the tab title is the asset name (renames edit the title)

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
      withoutDirty(() => {
        syncModelInstances(tab.modelId!, asset, tab.id);
        syncFoliageRulesForModel(asset, tab.id);
        // Levels are references, so this mesh may be a LOD of others whose placed instances embed a copy of
        // what was just edited. Refresh those too. One hop only: a level renders the referenced mesh's own
        // subtree, never its levels, so this cannot cascade.
        for (const dependent of modelsRef.current) {
          if (dependent.id === tab.modelId) continue;
          if (!dependent.lods?.some(l => l.modelId === tab.modelId)) continue;
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
      parseByType(runtime.scene.root, clone);

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
   * Generate LOD levels for the open model: decimate its geometry per level, point each level at
   * half-resolution copies of its textures, and wire the results in as levels 1..N.
   *
   * Levels this model generated BEFORE are replaced in place (matched on `lodSource`, reusing their asset
   * ids), so pressing generate twice updates one set rather than filling the library with orphans. Levels
   * the user added by hand are left alone.
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

    // Keep hand-added levels, drop the ones a previous generate produced — their asset ids are reused
    // below so the library sees an update rather than a second set.
    const generatedBefore = new Map<number, string>();
    const keptRefs: ModelLodDef[] = [];
    const keptLevelIds: string[] = [session.levelIds[0]];
    const keptDistances: number[] = [0];
    session.lodRefs.forEach((ref, i) => {
      const asset = modelsRef.current.find(m => m.id === ref.modelId);
      if (asset?.lodSource?.modelId === modelId) {
        generatedBefore.set(asset.lodSource.level, asset.id);
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
    // Derived materials this run produced, so the previous run's can be dropped afterwards — model
    // assets are id-reused via `lodSource`, but materialAssetWithTextures mints a fresh id every time,
    // so without this every regenerate left another full set of LOD materials in the library.
    const generatedMaterialIds = new Set<string>();
    const staleMaterialIds = new Set<string>();
    for (const ref of session.lodRefs) {
      const prev = modelsRef.current.find(m => m.id === ref.modelId);
      if (prev?.lodSource?.modelId === modelId) for (const id of prev.materialIds ?? []) staleMaterialIds.add(id);
    }

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
          modelName: tab.title,
          sourceModelId: modelId,
          materials: materialsRef.current,
          downscaleTextures: downscale,
          // One halving per step, because the source material is the PREVIOUS level's — already halved.
          textureHalvings: 1,
          decimate: decimateGeometry,
          existingId: generatedBefore.get(level),
        });

        for (const mat of built.materials) addMaterial(mat);
        materialsRef.current = [...materialsRef.current, ...built.materials];
        for (const mat of built.materials) generatedMaterialIds.add(mat.id);

        if (generatedBefore.has(level)) updateModel(built.asset.id, built.asset);
        else addModel(built.asset);
        // The ref is mirrored during render, so a freshly added asset is invisible to it inside this
        // handler; seed it by hand, exactly as the tileset and animation-field paths do.
        //
        // IN PLACE for an asset that already existed. Appending instead moves it to the end, and
        // writeModelLibrary treats position as state — so one regenerate rewrote every asset after the
        // moved one to IndexedDB, a full structured clone each.
        const at = modelsRef.current.findIndex(m => m.id === built.asset.id);
        modelsRef.current = at >= 0
          ? modelsRef.current.map(m => (m.id === built.asset.id ? built.asset : m))
          : [...modelsRef.current, built.asset];

        // A preview of the level, as a SIBLING of level 0 — the levels are alternatives, and parenting
        // one to another would serialize it into the asset on the next save.
        const clone = deepClone(built.asset.nodeJson);
        regenerateIds(clone, new Map());
        resolveMaterialRefs(clone, materialsRef.current);
        clone.name = built.asset.name;
        parseByType(runtime.scene.root, clone);

        // The subtree just parsed into the tab scene IS the next level's source.
        previousLevelRoot = runtime.scene.getNodeById(clone.id) ?? previousLevelRoot;

        newRefs.push({ modelId: built.asset.id, distance: specs[i].distance });
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
      // Anything the previous run minted that this one did not re-mint is now unreferenced.
      const orphaned = [...staleMaterialIds].filter(id => !generatedMaterialIds.has(id));
      if (orphaned.length) {
        setMaterials(prev => prev.filter(m => !orphaned.includes(m.id)));
        materialsRef.current = materialsRef.current.filter(m => !orphaned.includes(m.id));
      }

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
    setModelSessions(prev => ({ ...prev, [tab.id]: { ...session, cullDistance: Math.max(0, distance) } }));
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
    markTabDirty, addAnimationField, updateAnimationField,
  });

  // ---- Tileset editor --------------------------------------------------------------------------------
  const { enterTilesetEditor, createTilesetFromImage, saveTileset } = useTilesetEditor({
    tilesetsRef, tabsRef, setTabs, eventEmitter,
    addTileset, updateTileset, setActiveTab, commitTab, clearTabDirty,
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
      for (const asset of r.models) addModel(asset);
    };

    // Map an import stage onto the store's generic step. One place, so the labels and the bar can't drift.
    const setStage = (index: number, stage: ImportStage, detail?: string, error?: string) => {
      const s = IMPORT_STAGES[stage];
      task.setStep(index, {
        status: s.status,
        progress: s.progress,
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
            (_fraction, stage) => setStage(i, 'parsing', stage || undefined));
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
        // Propagation edits other scenes and must not mark them dirty: they store the link (__materialId)
        // and resyncScene re-resolves it on open. Dirtying here would keep Save All from ever going clean.
        withoutDirty(() => {
          syncMaterialInstances(tab.materialId!, asset, tab.id); // push edits to placed references
          // Foliage prototypes bake their material inline and hang off no node, so the walk above
          // cannot reach them; this re-derives every scattered rule whose model links this material.
          syncFoliageRulesForMaterial(tab.materialId!, tab.id);
        });
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
    void createMaterialPreviewScene(scene, { subjectRadius: PREVIEW_TERRAIN_RADIUS });
    const tm = asset ? parseTerrainMaterialAsset(asset) : TerrainMaterial.Create('pbr', { baseColor: [0.38, 0.5, 0.28] });
    // A REAL landscape, not a sphere borrowing the composite material. Terrain relief is geometry now —
    // the layer displaces the terrain's own vertices and the march is off for it — so a sphere shows the
    // albedo and nothing else. See `buildTerrainPreviewSubject` for the two less obvious things this
    // also fixes (the pack being resolved once and then swept).
    // Scaled against the landscape the material will actually be painted on, so metres-per-repeat and
    // metres-per-vertex match and the preview resolves the same geometry/march split the ground does.
    const previewNode = buildTerrainPreviewSubject(scene, tm, activeLandscapeTerrain());
    const helperTerrain = previewNode.terrain;
    scene.start();
    // Unrendered node whose material IS the TerrainMaterial — the MaterialEditor/inspector edit target.
    const editNode = new ModelNode('__tmedit', new Model(Geometry.Sphere(8), tm));

    const tabId = adoptTabId ?? cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: previewNode.id, tm, helperTerrain, editNode });
    commitTab(
      { id: tabId, kind: 'terrainMaterial', title: asset?.name ?? 'New Terrain Material', terrainMaterialId: asset?.id ?? null },
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

  // Re-derive the composite preview from the edited TerrainMaterial after any inspector change.
  const refreshTerrainMaterialPreview = () => {
    const runtime = tabRuntimeRef.current.get(activeTabId);
    if (!runtime?.helperTerrain || !runtime.tm) return;
    // The layer's tiling REBASED to the preview patch, never 1. Pinning it to 1 contradicted
    // `buildTerrainPreviewSubject` — which sets the scaled tiling when the tab opens — so the first
    // inspector edit silently rescaled the preview to something no landscape will ever show, and took
    // the derived density down to 1 with it. See previewTerrainSubject.ts for what the scale is for.
    const size = activeLandscapeTerrain()?.size ?? REFERENCE_LANDSCAPE.size;
    runtime.helperTerrain.setLayer(0, runtime.tm, {
        auto: false, tiling: runtime.tm.tiling * PREVIEW_TERRAIN_SIZE / Math.max(size, 1e-6),
    });
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
      && (isPlayModeRef.current ? debugVisibilityRef.current.grid.runtime : debugVisibilityRef.current.grid.editor));
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
    eventEmitter.current.emit('SELECT_NODE', (runtime && tab.kind !== 'animation') ? runtime.rootId : null);
  };

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
      // Ignore mutations to editor-owned nodes — the free-fly viewport camera (an __editor__Camera Node,
      // moved every frame during navigation) and the __editor__/__debug__ helper icons + physics wireframes
      // the reconciler splices in. None are user edits.
      if (e?.node && (e.node.name.includes('__editor__') || e.node.name.includes('__debug__')))
        return logDirtySkip('editor-owned', e);
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
      const matSet = collectReferencedMaterialIds(scene, models);
      const modelSet = collectReferencedModelIds(scene);
      const tplSet = collectReferencedTemplateIds(scene);
      const tmSet = collectReferencedTerrainMaterialIds(scene);
      const scriptSet = collectReferencedScriptIds(scene);
      const tilesetSet = collectReferencedTilesetIds(scene);
      const refs: SceneRefs = {
        materialIds: Array.from(matSet),
        modelIds: Array.from(modelSet),
        templateIds: Array.from(tplSet),
        terrainMaterialIds: Array.from(tmSet),
        tilesetIds: Array.from(tilesetSet),
        textureIds: Array.from(referencedTextureIds(materials, terrainMaterials, templates, models, tilesets)),
      };
      // Per-asset content hashes let a *closed* scene tell, when reopened, which referenced assets
      // changed while it was closed — so unchanged models/templates aren't needlessly re-instantiated.
      const assetHashes = buildAssetHashes(
        { materialIds: matSet, modelIds: modelSet, templateIds: tplSet, terrainMaterialIds: tmSet, scriptIds: scriptSet, tilesetIds: tilesetSet },
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
    registerAnimationApply, registerTilesetApply, registerTextureApply, registerSoundApply, saveTabById, runSave,
    saveActiveTab, saveAll, saveProjectToStorage,
  } = useSaving({
    tabsRef, dirtyTabsRef, activeTabIdRef, setSavingState,
    saveCurrentScene, saveTemplateTab, saveModelTab, saveMaterialTab, saveTerrainMaterialTab, saveScriptTab,
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

    // Load the target before tearing anything down, so a failed read aborts cleanly. A scene whose blob
    // was never written (e.g. a fresh "Main" before its first save) opens empty.
    const data = (await loadSceneData(sceneId)) ?? { ...(await buildEmptySceneData()), savedAt: Date.now() };

    setActiveTabId(SCENE_TAB_ID);
    // Animation tabs cloned their model out of the outgoing scene; their write-back target is about
    // to disappear, so close them (batched — repeated removeTabById calls would each see stale tabs).
    const staleTabs = tabs.filter(t => t.kind === 'animation' && tabRuntimeRef.current.get(t.id)?.sourceScene === editorSceneRef.current);
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

    // Parse the target into the live scene. Suppress dirty marking for the flurry of SCENE_CHANGED
    // this emits; re-armed below once the helper reconciler settles.
    dirtyArmedRef.current = false;
    const scene = editorSceneRef.current;
    scene.environmentMap = null; // parse only sets it when the JSON has one — don't leak the old scene's
    applyGameData(data, { ...engineMaps(), scene, renderer: instanceRef.current?.renderer });
    ensureEditorCamera(scene);
    // Cross-scene propagation: re-resolve the freshly-parsed scene's asset links against the current
    // libraries, so edits/deletes made to assets while this scene was closed take effect on open. Gated
    // by the hashes captured at the scene's last save (data.assetHashes) — unchanged assets are skipped.
    resyncScene(scene, engineMaps(), currentLibs(), data.assetHashes, data.assetHashVersion);
    showBindPoseForSkinnedModels(scene);

    await updateProjectMeta(m => ({ ...m, openSceneId: sceneId }));
    clearTabDirty(SCENE_TAB_ID);
    eventEmitter.current.emit('TEXTURES_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    // Parsing a scene can replace camera settings/onUpdate handlers; re-apply editor camera controls — with
    // the INCOMING scene's rig, not the outgoing one's. This is what makes the view follow the scene.
    setViewDimension(dimensionOfScene(sceneId));
    requestAnimationFrame(() => requestAnimationFrame(() => { dirtyArmedRef.current = true; }));
    Logger.info(`Opened scene "${entry.name}"`, 'Editor');
    return true;
  };

  // Startup: restore the saved project if present, otherwise open a blank scene.
  const setupInitialScene = async () => {
    // Textures first. Payloads live once in the texture store, not embedded in the project blob or in the
    // assets that reference them, so they have to be registered in the TextureManager BEFORE anything is
    // parsed against them — that is what lets every asset restore path stay synchronous.
    try {
      const loaded = await preloadTextures();
      if (loaded) Logger.info(`Loaded ${loaded} texture${loaded === 1 ? '' : 's'}`, 'Editor');
    } catch (e) {
      Logger.error(`Failed to load textures: ${e}`, 'Editor');
    } finally {
      // Settled either way: a failed preload is not going to fill the registry later, and leaving this
      // false forever would keep the asset index's texture GC permanently disarmed.
      setTexturesPreloaded(true);
    }

    // Then audio, for the same reason and with the same guarantee: a SoundNode resolving `sampleId`
    // during a scene parse must find its sample already registered.
    try {
      const loaded = await preloadAudio();
      if (loaded) Logger.info(`Loaded ${loaded} sound${loaded === 1 ? '' : 's'}`, 'Editor');
    } catch (e) {
      Logger.error(`Failed to load audio: ${e}`, 'Editor');
    } finally {
      setAudioPreloaded(true);
    }

    // Multi-scene project: load the meta (migrating a legacy single-scene 'cleo_project' blob once), then
    // parse the last-open scene's blob. A fresh install gets a meta with one empty "Main" scene — the
    // "a project always has ≥1 scene" invariant. The legacy import is gated per PROJECT.
    let meta = await loadProjectMeta();
    if (!meta && activeProjectAllowsLegacyImport()) meta = await migrateLegacyProject();
    if (!meta) {
      meta = createFreshProjectMeta();
      try { await saveProjectMeta(meta); } catch (e) { console.warn('Failed to persist fresh project meta:', e); }
      createEmptyScene(editorSceneRef.current);
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
        applyGameData(data, { ...engineMaps(), scene: editorSceneRef.current, renderer: instanceRef.current?.renderer });
        ensureEditorCamera(editorSceneRef.current);
        // Stash the hashes for the deferred initial resync — the libraries have not been read yet, so it
        // cannot happen here. See the initial-resync effect.
        initialAssetHashesRef.current = { hashes: data.assetHashes };
      } else {
        // No scene has a saved blob yet (fresh meta, or blobs lost) — open the target empty.
        createEmptyScene(editorSceneRef.current);
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
          // and device acquisition is asynchronous.
          await engine.initialize();

          instanceRef.current = engine;
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

          setLoadingProgress({ loaded: 6, total: 6, label: 'Ready' });
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
      // is in force. Skipped in renderer mode, where the Renderer panel owns its own grid switch.
      if (editorMode !== 'renderer')
        instanceRef.current?.renderer.setGridVisible(isPlayMode ? vis.grid.runtime : vis.grid.editor);
      suppressReconcileRef.current = true;
      try {
        if (isPlayMode) {
          // Runtime channel: helpers are rebuilt onto the throwaway play scene (which shares node ids with
          // the editor scene, so the bodies/triggers maps still resolve). Still __debug__-named, so still
          // stripped from any real publish. No withoutDirty — play mode never marks the tab dirty.
          const playScene = instanceRef.current?.scene;
          if (playScene) reconcileEditorHelpers(playScene, bodiesRef.current, triggersRef.current, vis, 'runtime');
        } else if (activeScene) {
          // withoutDirty as well as suppressReconcileRef: the latter only stops the reconciler re-triggering
          // ITSELF, while the helpers it splices in emit SCENE_CHANGED like any other node edit.
          withoutDirty(() => reconcileEditorHelpers(activeScene, bodiesRef.current, triggersRef.current, vis, 'editor'));
        }
      } finally { suppressReconcileRef.current = false; }
    };
    const schedule = (e?: SceneChange) => {
      // Structural/visibility/name changes affect which helper icons + wireframes are needed; the per-setter
      // transform/material/... events do not, so skip them (PHYSICS_CHANGED passes no payload and still runs).
      if (e && e.kind !== 'structure' && e.kind !== 'visibility' && e.kind !== 'name') return;
      if (suppressReconcileRef.current || reconcileScheduledRef.current) return;
      reconcileScheduledRef.current = true;
      reconcileRafRef.current = requestAnimationFrame(runReconcile);
    };
    const emitter = eventEmitter.current;
    emitter.on('SCENE_CHANGED', schedule);
    emitter.on('PHYSICS_CHANGED', schedule);
    emitter.on('DEBUG_VISIBILITY_CHANGED', schedule);
    schedule(); // initial reconcile for the current scene / mode
    return () => {
      // Drop any reconcile this closure queued: entering Play parses a whole scene and those structural
      // events schedule a run while isPlayMode is still false. Clearing the FLAG as well as the handle is
      // load-bearing -- cleanup runs before the next effect body, and schedule() would otherwise bail.
      cancelAnimationFrame(reconcileRafRef.current);
      reconcileScheduledRef.current = false;
      emitter.off('SCENE_CHANGED', schedule);
      emitter.off('PHYSICS_CHANGED', schedule);
      emitter.off('DEBUG_VISIBILITY_CHANGED', schedule);
    };
  }, [activeScene, isPlayMode, editorMode]);

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
        cameraNode.onUpdate = (delta) => {
            const node = cameraNode;
            const mouse = InputManager.instance.mouse;
            const movement = delta;
            if ((mouse.buttons.Left || mouse.buttons.Right) && !isGizmoDraggingRef.current) {
                node.addX(-mouse.velocity[0] * movement);
                node.addY(mouse.velocity[1] * movement);

                InputManager.instance.isKeyPressed('KeyW') && node.addY(movement * 10);
                InputManager.instance.isKeyPressed('KeyS') && node.addY(-movement * 10);
                InputManager.instance.isKeyPressed('KeyA') && node.addX(-movement * 10);
                InputManager.instance.isKeyPressed('KeyD') && node.addX(movement * 10);
            }
            if (!isGizmoDraggingRef.current && Math.abs(mouse.wheel.deltaY) > 0 && InputManager.instance.isMouseOverCanvas()) {
              // Wheel up (deltaY < 0) SHRINKS the ortho extents — shows less world, zooms in — matching
              // the 3D rig's dolly below and every other wheel in the editor.
              const step = mouse.wheel.deltaY * 0.001;
              const factor = Math.max(0.1, 1 + step); // avoid inverting the frustum on a fast scroll
              const cam = cameraNode.camera;
              cam.top *= factor;
              cam.bottom *= factor;
              cam.left *= factor;
              cam.right *= factor;
              // Clamp minimal extent to avoid zero frustum
              const minExtent = 0.1;
              if (Math.abs(cam.top) < minExtent) {
                const sign = cam.top >= 0 ? 1 : -1;
                cam.top = sign * minExtent;
              }
              if (Math.abs(cam.bottom) < minExtent) {
                const sign = cam.bottom >= 0 ? 1 : -1;
                cam.bottom = sign * minExtent;
              }
              if (Math.abs(cam.left) < minExtent) {
                const sign = cam.left >= 0 ? 1 : -1;
                cam.left = sign * minExtent;
              }
              if (Math.abs(cam.right) < minExtent) {
                const sign = cam.right >= 0 ? 1 : -1;
                cam.right = sign * minExtent;
              }
            }
        };

        // Orient the infinite grid onto the front (XY) plane for 2D.
        instanceRef.current.renderer.setGridPlane('xy');
      }
      else {
        cameraNode.camera.type = 'perspective';
        // Unlike 2D there is no default pose to fall back to — a first switch to 3D keeps whatever the
        // scene set up. Only a remembered pose moves the camera.
        if (remembered) cameraNode.setPosition(remembered.position).setRotation(remembered.rotation);
        cameraNode.onUpdate = (delta) => {
          const node = cameraNode;
          const mouse = InputManager.instance.mouse;
          const movement = delta * 2;
          if (mouse.buttons.Left && !isGizmoDraggingRef.current) {
            node.rotateX( mouse.velocity[1] * movement * 5).rotateY(-mouse.velocity[0] * movement * 5);
            InputManager.instance.isKeyPressed('KeyW') && node.addForward(movement);
            InputManager.instance.isKeyPressed('KeyS') && node.addForward(-movement);
            InputManager.instance.isKeyPressed('KeyA') && node.addRight(-movement);
            InputManager.instance.isKeyPressed('KeyD') && node.addRight(movement);
            InputManager.instance.isKeyPressed('KeyE') && node.addY(movement);
            InputManager.instance.isKeyPressed('KeyQ') && node.addY(-movement);
          }
          if (mouse.buttons.Right && !isGizmoDraggingRef.current) {
            node.addRight(-mouse.velocity[0] * movement);
            node.addUp(mouse.velocity[1] * movement);
          }
          if (!isGizmoDraggingRef.current && Math.abs(mouse.wheel.deltaY) > 0 && InputManager.instance.isMouseOverCanvas()) {
            const zoom = -mouse.wheel.deltaY * 0.01; // wheel up -> move forward
            node.addForward(zoom);
          }
        };

        // Orient the infinite grid onto the ground (XZ) plane for 3D.
        instanceRef.current.renderer.setGridPlane('xz');
      }
    });

    eventEmitter.current.on('SET_PLAY_STATE', (state: 'play' | 'pause' | 'stop') => {
      if (!instanceRef.current) return;
      if (state === 'play') {
        instanceRef.current.isPaused = false;
        setIsPlayMode(true);
        InputManager.instance.enableMouseCapture();
        setSelectedNode(null);
        if (instanceRef.current && instanceRef.current.renderer) {
          instanceRef.current.renderer.setSelectedNode(null);
          // The grid follows its Runtime toggle in game mode (off by default).
          instanceRef.current.renderer.setGridVisible(debugVisibilityRef.current.grid.runtime);
          // Never render a debug channel in the running game (in case Play is pressed in Renderer mode).
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
        InputManager.instance.registerKeyPress('Escape', () => InputManager.instance.releaseMouse());
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
        InputManager.instance.disableMouseCapture();
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
    });

    eventEmitter.current.on('GIZMO_DRAG_END', () => {
      setIsGizmoDragging(false);
      isGizmoDraggingRef.current = false;
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
      bodies: bodiesRef.current,
      triggers: triggersRef.current,
      templates: templatesRef.current,
      materials: materialsRef.current,
      useCache: true,
    });
    const newScene = new Scene();
    // Templates are global and shared by every scene in the session, so they are registered here rather
    // than per-parse — a runtime Game.loadScene must not drop what a script can still instantiate.
    registerTemplates(json.templates);
    newScene.parse(json, true);
    return newScene;
  };

  // Build a runnable play Scene for any scene id. The play-session entry (the scene open when Play was
  // pressed) uses the live editor scene so unsaved edits play; every other scene is loaded from its blob,
  // re-resolved against the current libraries, then parsed with its scripts compiled.
  const buildPlaySceneById = async (id: string): Promise<Scene> => {
    if (id === playEntrySceneIdRef.current) return buildPlayScene();
    const data = await loadSceneData(id);
    if (!data) return new Scene();
    const clone = deepClone({ scene: data.scene, ui: data.ui });
    // A scene never opened in this session still carries its UI as the legacy blob — same reason the
    // publish path migrates here: without it, loading that scene at runtime gives it no HUD, silently.
    migrateLegacyUI(clone.scene, clone.ui);
    const maps = { scripts: new Map<string, string>(), bodies: new Map<string, any>(), triggers: new Map<string, any>() };
    extractNodeState(clone.scene, maps);
    const tmp = new Scene();
    tmp.parse({ scene: clone.scene, textures: [] }, true);
    resyncScene(tmp, maps, currentLibs(), data.assetHashes, data.assetHashVersion);
    const gd = await buildGameData({ scene: tmp, scripts: maps.scripts, bodies: maps.bodies, triggers: maps.triggers, scriptAssets: scriptAssetsRef.current, templates: templatesRef.current, materials: materialsRef.current, useCache: true });
    // `tmp` existed only to be resynced and serialized; `gd` is plain JSON, so its GPU meshes and bus
    // subscription can go now.
    tmp.dispose();
    const scene = new Scene();
    registerTemplates(gd.templates);
    scene.parse(gd, true); // gd injects scripts into nodes → compiled here
    return scene;
  };

  // Runtime scene switch (Game.loadScene from a script). Swaps the engine's scene, resetting UI/physics/
  // input for the new scene — the editor-play counterpart of the player's loadScene.
  const playLoadScene = async (nameOrId: string): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance || !startedRef.current) return;
    const meta = projectMetaRef.current;
    const target = meta?.scenes.find(s => s.id === nameOrId) ?? meta?.scenes.find(s => s.name === nameOrId);
    if (!target) { Logger.warn(`loadScene: no scene "${nameOrId}"`, 'Editor'); return; }
    const scene = await buildPlaySceneById(target.id);
    instance.input.clear();
    instance.physics.clear();
    instance.setScene(scene);
    // After the swap: the outgoing scene is off the engine and its bodies are out of the world.
    releasePlayScene();
    playSceneRef.current = scene;
    currentPlaySceneIdRef.current = target.id;
    instance.isPaused = false;
    setTimeout(() => { instance.scene.start(); }, 50);
    // The new play scene starts with no runtime debug helpers; rebuild them for it (isPlayMode is
    // already true, so the reconcile effect won't re-fire on its own).
    eventEmitter.current.emit('DEBUG_VISIBILITY_CHANGED');
  };

  const installGameHost = () => setGameHost({
    loadScene: (nameOrId: string) => { void playLoadScene(nameOrId); },
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

  const startPlay = async () => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.input.preventDefault();
    if (startedRef.current) { eventEmitter.current.emit('SET_PLAY_STATE', 'play'); return; }

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
      return;
    }

    reembedSceneFields(editorSceneRef.current);
    playEntrySceneIdRef.current = openSceneIdRef.current;
    currentPlaySceneIdRef.current = openSceneIdRef.current;
    const newScene = await buildPlayScene();
    instance.setScene(newScene);
    playSceneRef.current = newScene;
    instance.isPaused = false;
    installGameHost();
    // Rebuild runtime debug helpers AFTER scene.start() — the reconcile the isPlayMode flip triggers runs
    // before start(), which resets the scene and drops those just-added nodes. Emitting here mirrors the
    // live-toggle path, so Runtime toggles are honoured from the first frame of Play.
    setTimeout(() => { instance.scene.start(); eventEmitter.current.emit('DEBUG_VISIBILITY_CHANGED'); }, 100);
    eventEmitter.current.emit('SET_PLAY_STATE', 'play');
    startedRef.current = true;
  };
  const stopPlay = () => {
    startedRef.current = false;
    const instance = instanceRef.current;
    setGameHost(null);
    if (!instance) return;
    instance.setScene(editorSceneRef.current);
    instance.input.clear();
    instance.physics.clear();
    releasePlayScene();
    showBindPoseForSkinnedModels(editorSceneRef.current); // back to the default pose in the editor
    eventEmitter.current.emit('SET_PLAY_STATE', 'stop');
  };
  const pausePlay = () => eventEmitter.current.emit('SET_PLAY_STATE', 'pause');
  const resetPlay = async () => {
    const instance = instanceRef.current;
    if (!instance) return;
    // Clear input/physics so key bindings and bodies from the previous run don't stack.
    instance.input.clear();
    instance.physics.clear();
    // Reset returns to the play-session entry scene (where Play was pressed), not the last-loaded one.
    currentPlaySceneIdRef.current = playEntrySceneIdRef.current;
    const newScene = await buildPlayScene();
    instance.setScene(newScene);
    releasePlayScene();
    playSceneRef.current = newScene;
    instance.isPaused = false;
    // Reconcile runtime debug helpers after start() (see startPlay) — reset stays in play mode, so the
    // isPlayMode effect won't re-fire on its own.
    setTimeout(() => { instance.scene.start(); eventEmitter.current.emit('DEBUG_VISIBILITY_CHANGED'); }, 50);
    startedRef.current = true;
    eventEmitter.current.emit('SET_PLAY_STATE', 'play');
  };

  // Second half of the two-phase Play switch above: the tab and mode are now committed, so the engine's
  // scene is settled and startPlay can install the play scene without racing anything.
  useEffect(() => {
    if (!pendingPlayRef.current) return;
    if (activeTabId !== SCENE_TAB_ID || mainMode !== 'scene') return;
    pendingPlayRef.current = false;
    void startPlay();
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

  // Warn before closing/reloading the page while a save is in flight OR any tab has unsaved edits — dirty
  // state is only ever cleared by an explicit Save, so a reload would otherwise silently drop the work.
  const hasUnsavedWork = savingState === 'saving' || Object.keys(dirtyTabs).length > 0;
  useEffect(() => {
    if (!hasUnsavedWork) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedWork]);

  // Split-out slice contexts (Selection / Playback / AssetLibrary / Document). The state still lives here;
  // each exposes a narrow, memoized value so a consumer of one slice needn't re-render on every unrelated
  // EngineContext change. Actions go through useStableActions, so only real state changes bust each memo.
  const selectionValue = useMemo<SelectionContextValue>(() => ({
    selectedNode, isGizmoDragging, gizmoMode, setGizmoMode,
  }), [selectedNode, isGizmoDragging, gizmoMode]);

  const playActions = useStableActions({ startPlay, stopPlay, pausePlay });
  const playbackValue = useMemo<PlaybackContextValue>(() => ({
    isPlayMode, ...playActions,
  }), [isPlayMode, playActions]);

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
    addTileset, removeTileset, updateTileset,
    addImage, removeImage, updateImage,
    addTextureAsset, removeTextureAsset, updateTextureAsset,
    addAudioSource, removeAudioSource, updateAudioSource,
    addSoundSample, removeSoundSample, updateSoundSample,
  });
  const assetLibraryValue = useMemo<AssetLibraryContextValue>(() => ({
    templates, materials, terrainMaterials, models, scriptAssets, animationFields, animations, tilesets,
    images, textures, audioSources, soundSamples, assetsLoaded, ...libraryActions,
  }), [templates, materials, terrainMaterials, models, scriptAssets, animationFields, animations, tilesets,
       images, textures, audioSources, soundSamples, assetsLoaded, libraryActions]);

  const documentActions = useStableActions({
    setActiveTab, closeTab, reorderTabs, saveActiveTab, saveAll, markTabDirty, clearTabDirty, withoutDirty,
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
    enterTemplateEditor,
    enterMaterialEditor, createMaterialForNode, setActiveMaterialName,
    enterTerrainMaterialEditor, refreshTerrainMaterialPreview, setActiveTerrainMaterialName,
    enterAnimationEditor, commitAnimationStateMachine, registerAnimationApply, registerTilesetApply,
    importAnimationFiles, importSkeletonNames, commitIkRig, currentIkRig, renameAnimationClip, removeAnimationClip, resolveAnimationImport, resolveRigPick,
    enterModelEditor, adoptModelAsset, resolveModelAssetId, linkAnimationToModel, unlinkAnimationFromModel, editSharedClip,
    setActiveModelName, addModelLodFromAsset, generateModelLods, removeModelLod,
    setModelLodDistance, setModelCullDistance, setActiveModelLevel, importModelFiles, resolveModelImport,
    enterScriptEditor, setScriptTabSource, getScriptTabSource, saveScriptSource,
    adoptExternalScriptSource, renameScriptAsset,
    scriptAssetOf, createScriptForNode, attachScriptToNode, detachScriptFromNode,
    enterAnimationFieldEditor, createAnimationFieldForModel, saveAnimationField,
    enterSoundEditor, saveSoundSample, previewSoundSettings, registerSoundApply,
  });
  const editorSessionsValue = useMemo<EditorSessionsContextValue>(() => ({
    editingTemplateName, templateRootId,
    editingMaterialName,
    editingTerrainMaterialName, editingTerrainMaterialNode,
    animationTargetId, animationSourceId, animationSourceScene, pendingAnimationImport, pendingRigPick,
    editingAnimationFieldId, animationFieldTargetId,
    editingSoundId,
    modelSession: activeTab.kind === 'model' ? (modelSessions[activeTab.id] ?? null) : null,
    modelEditTargetId: activeTab.kind === 'model' && modelSessions[activeTab.id]
      ? modelSessions[activeTab.id].levelIds[modelSessions[activeTab.id].activeLevel] ?? null
      : null,
    pendingModelImport,
    ...sessionActions,
  }), [
    editingTemplateName, templateRootId, editingMaterialName,
    editingTerrainMaterialName, editingTerrainMaterialNode,
    animationTargetId, animationSourceId, animationSourceScene, pendingAnimationImport, pendingRigPick,
    editingAnimationFieldId, animationFieldTargetId, editingSoundId,
    activeTab, modelSessions, pendingModelImport, sessionActions,
  ]);

  return (
  <EngineContext.Provider value={{
      instance: instanceRef.current,
      editorScene: activeScene,
      mainScene: editorSceneRef.current,
      eventEmitter: eventEmitter.current,
      selectedNode,
      isGizmoDragging,
      isPlayMode,
      isSceneReady,
      texturesPreloaded,
      audioPreloaded,
      editorMode,
      setEditorMode,
      gizmoMode,
      setGizmoMode,
      tabs,
      activeTabId,
      activeTab,
      dirtyTabs,
      setActiveTab,
      closeTab,
      reorderTabs,
      saveActiveTab,
      saveAll,
      registerAnimationApply,
      registerTilesetApply,
      enterTemplateEditor,
      editingTemplateName,
      templateRootId,
      enterMaterialEditor,
      createMaterialForNode,
      editingMaterialName,
      setActiveMaterialName,
      enterTerrainMaterialEditor,
      editingTerrainMaterialName,
      editingTerrainMaterialNode,
      refreshTerrainMaterialPreview,
      dropFoliageLayer,
      bakeFoliageImpostor,
      setActiveTerrainMaterialName,
      enterAnimationEditor,
      animationTargetId,
      animationSourceId,
      animationSourceScene,
      commitAnimationStateMachine,
      terrainBrush,
      tilemapBrush,
      isDirtySuppressed,
      loadingProgress,
      scripts: scriptsRef.current,
      bodies: bodiesRef.current,
      triggers: triggersRef.current,
      startPlay,
      stopPlay,
      pausePlay,
      templates,
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
      saveSoundSample,
      previewSoundSettings,
      tilesets,
      addTileset,
      removeTileset,
      updateTileset,
      enterTilesetEditor,
      createTilesetFromImage,
      editingTilesetId,
      editingTextureId,
      enterTextureEditor,
      saveTexture,
      previewTextureSettings,
      registerTextureApply,
      registerSoundApply,
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
      linkAnimationToModel,
      unlinkAnimationFromModel,
      editSharedClip,
      modelSession: activeTab.kind === 'model' ? (modelSessions[activeTab.id] ?? null) : null,
      modelEditTargetId: activeTab.kind === 'model' && modelSessions[activeTab.id]
        ? modelSessions[activeTab.id].levelIds[modelSessions[activeTab.id].activeLevel] ?? null
        : null,
      setActiveModelName,
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
      setClipRootMotion,
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
  </EngineContext.Provider>
  );
}