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
import { CleoEngine, Scene, InputManager, Model, Geometry, Material, CustomMaterial, TerrainMaterial, Terrain, Node, ModelNode, CameraNode, AnimatedModel, TextureManager, Logger, Loader, buildBoneMapping, mappingReport, retargetAnimation, describeRetarget, setGameHost, registerTemplates } from "cleo";
import type { AnimationCompatibility, BoneMapping, HullQuality, SceneChange } from "cleo";
import NullImage from '../images/null.png';
import LightIcon from '../icons/light.png';
import EventEmitter from "events";
import { createEmptyScene, ensureEditorCamera } from './demoScene/createEmptyScene';
import { createMaterialPreviewScene } from './demoScene/createMaterialPreviewScene';
import { createAnimationEditorScene } from './demoScene/createAnimationEditorScene';
import { createAssetEditScene } from './demoScene/createAssetEditScene';
import { parseByType, regenerateIds, stripDebug } from "../utils/nodeSubtree";
import { UIElement, UIState, cryptoRandomId } from "../utils/UIModel";
import { UIRuntime, GameActions } from "./uiInspector/uiRuntime";
import { Template, buildTemplateFromNode, instantiateTemplate, TEMPLATE_ID_VAR } from "../utils/templates";
import { MaterialAsset, buildMaterialAsset, applyMaterialAsset, getMaterialIdOf, getNodeMaterial, unlinkToFallback, resolveMaterialRefs } from "../utils/materials";
import { getScreenMaterialIds, applyScreenMaterials } from "../utils/screenMaterials";
import { TerrainMaterialAsset, buildTerrainMaterialAsset, parseTerrainMaterialAsset, applyTerrainMaterialToLayer, collectTerrainMaterialTextureIds } from "../utils/terrainMaterials";
import { buildFoliageRuleFromModelAsset } from "../utils/foliageRules";
import { ModelAsset, ModelLodDef, MODEL_ID_VAR, buildModelAsset, instantiateModelAsset, separateSubModels, nodeJsonHasSkinnedModel, lodLevelJson, nodeJsonHasModel, modelIdOf, refreshModelClips, assetWithClipAdded, assetWithClipRenamed, assetWithClipRemoved, assetWithClipRootMotion, assetWithBoneNames, assetWithIkRig } from "../utils/models";
import { ScriptAsset, ScriptBaseType, SCRIPT_ID_VAR, buildScriptAsset, applyScriptAsset, unlinkScript, getScriptIdOf, defaultScriptClass, seedScriptFields } from "../utils/scripts";
import { AnimationFieldAsset, buildAnimationFieldAsset, firstSkinnedModelNode, modelAssetIsSkinned, reembedFields, machineUsesField } from "../utils/animationFields";
import { TilesetAsset, buildTilesetAsset, guessTileSize, reembedTilesets, detachTileset } from "../utils/tilesets";
import { importAtlasImage } from "./tileset/importAtlas";
import { renderTilesetThumbnail } from "./tileset/tilesetThumbnail";
import { groupImportFiles } from "../utils/importGrouping";
import {
  normalizeRootScale, meshBoundsRadius, combineBounds, awaitSubtreeTexturesReady, captureMaterialSphere,
  renderModelAssetThumbnail, renderMaterialAssetThumbnail, renderTerrainMaterialAssetThumbnail,
  setThumbnailDirtySuppressor,
} from "../utils/modelThumbnails";
import { parseBundleToRoot } from "../utils/modelImport";
import { cancelAllImports, ImportCancelled } from "../workers/importClient";
import { detectMissingTextures } from "../utils/textureRefs";

// A mesh awaiting user review in the import modal (parsed but not yet committed to the library).
export type PendingModelImportView = {
  bundleName: string;
  subMeshCount: number;
  materialCount: number;
  missing: string[];      // referenced texture basenames not present in the upload
  sizeRadius: number;     // combined bounding radius at scale 1 (diameter = 2*radius)
};
// The user's decision from the import modal.
export type ModelImportDecision = {
  extraFiles: File[];     // textures uploaded to fill missing references (aliased to expected names)
  normalize: boolean;
  targetSize: number;     // desired bounding diameter in world units
  /** Split the file's sub-models into one ModelAsset each, instead of a single asset for the whole file. */
  separate: boolean;
};

// ---- Import progress -------------------------------------------------------------------------------
// Every step importModelFiles walks a bundle through, in order. These map onto the shared progress store's
// generic steps (features/progress) — the stage a bundle is in IS what the user is told, so the window
// cannot drift from what the importer is actually doing.
type ImportStage =
  | 'queued'       // not started
  | 'parsing'      // Loader: assimp/GLTF parse of the model files
  | 'review'       // parked on the user in ModelImportModal (indefinite — the bar deliberately stalls)
  | 'reparsing'    // user supplied missing textures; parse again so they wire into the materials
  | 'scaling'      // normalizeRootScale bakes the fit-to-size factor into the vertices
  | 'textures'     // waiting on async image decode before anything can be serialized
  | 'materials'    // registering a MaterialAsset per unique material
  | 'saving'       // buildModelAsset: serialize the subtree(s) into the model library
  | 'done'
  | 'failed'
  | 'skipped';     // cancelled before it ran

/** Each stage's label + how far through a bundle it is. `review` stalls: it is waiting on a human. */
const IMPORT_STAGES: Record<ImportStage, { label: string; progress: number; status: StepStatus }> = {
  queued:    { label: 'Queued',                       progress: 0,    status: 'pending' },
  parsing:   { label: 'Parsing model',                progress: 0.15, status: 'running' },
  review:    { label: 'Waiting for you',              progress: 0.25, status: 'paused'  },
  reparsing: { label: 'Re-parsing with new textures', progress: 0.35, status: 'running' },
  scaling:   { label: 'Normalizing scale',            progress: 0.45, status: 'running' },
  textures:  { label: 'Decoding textures',            progress: 0.6,  status: 'running' },
  materials: { label: 'Registering materials',        progress: 0.8,  status: 'running' },
  saving:    { label: 'Saving to library',            progress: 0.92, status: 'running' },
  done:      { label: 'Imported',                     progress: 1,    status: 'done'    },
  failed:    { label: 'Failed',                       progress: 1,    status: 'failed'  },
  skipped:   { label: 'Skipped',                      progress: 1,    status: 'skipped' },
};
/** A bone the mapping table lists in a target-joint dropdown: its node index and display name. */
export type RetargetBoneOption = { node: number; name: string };
// Animation clips parsed from a file, each with a compatibility report vs the target skeleton, plus the
// bone mapping (retarget) the user can inspect and correct — all awaiting review in the import modal.
export type PendingAnimationImportView = {
  fileName: string;
  /** `animatedNodes` are the source bones THIS clip drives, so the modal can recount matched/missing live
   *  against the (possibly edited) mapping rather than showing the stale open-time report. */
  clips: { name: string; report: AnimationCompatibility; animatedNodes: number[] }[];
  /** The source→target bone mapping the reports were computed from. Edited in the modal. */
  mapping: BoneMapping;
  /** Source bones the clips animate (the mapping's left column), and every target joint (the dropdowns). */
  sourceBones: RetargetBoneOption[];
  targetBones: RetargetBoneOption[];
};
// The user's decision: which clips to add (by index), and the mapping as finally edited. The mapping rides
// back so the accept path retargets against exactly what the user saw and corrected.
export type AnimationImportDecision = { include: boolean[]; mapping: BoneMapping };
import { buildGameData } from "./publish/buildGameData";
import { applyGameData, extractNodeState, ProjectPrefs } from "../utils/projectStorage";
import {
  ProjectMeta, SceneMeta, SceneRefs, loadProjectMeta, saveProjectMeta, loadSceneData, saveSceneData,
  deleteSceneData, migrateLegacyProject, createFreshProjectMeta,
} from "../utils/sceneStorage";
import { resyncScene } from "../utils/sceneResync";
import { captureAnimationState, restoreAnimationState } from "../utils/placedAnimation";
import { buildAssetHashes, AssetLibs, ASSET_HASH_VERSION } from "../utils/assetHash";
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
import { preloadTextures, persistTextures, adoptLegacyTextures, referencedTextureIds, legacyTexturesOf } from "../utils/textureStore";
import { saveToStorage } from "../workers/workerClient";
import { startTask, StepStatus } from "./progress/progressStore";
import { reconcileEditorHelpers } from "../utils/editorHelpers";

// Rasterise the light-probe glyph (an inner ring + a dashed outer ring, matching the inspector's
// ProbeIcon) to a white-on-transparent PNG data URL, for use as the probe's viewport billboard texture.
// A sprite Material.Basic tints this white icon to the probe's cyan.
function buildProbeIconDataURL(): string {
  const size = 64, cx = size / 2, cy = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([4, 6]);
  ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.stroke();
  return canvas.toDataURL('image/png');
}

type BoxShapeDescription = {
  type: 'box';
  offset: number[];
  rotation: number[];

  width: number;
  height: number;
  depth: number;
};

type SphereShapeDescription = {
  type: 'sphere';
  offset: number[];
  rotation: number[];

  radius: number;
};

type CylinderShapeDescription = {
  type: 'cylinder';
  offset: number[];
  rotation: number[];

  radius: number;
  height: number;
  numSegments: number;
};

/**
 * Capsule — the right collider for a character: it rests on an analytic sphere cap, so it rolls over
 * heightfield triangle edges instead of catching on them the way a box does.
 *
 * `height` is the TOTAL tip-to-tip height (as in Unity/Godot), so the straight section is
 * `height - 2 * radius` and a height at or below `2 * radius` is simply a sphere. cannon has no capsule
 * primitive, so `Shape.Capsule` compounds one from a cylinder and two spheres at load.
 */
type CapsuleShapeDescription = {
  type: 'capsule';
  offset: number[];
  rotation: number[];

  radius: number;
  height: number;
  numSegments: number;
};

type PlaneShapeDescription = {
  type: 'plane';
  offset: number[];
  rotation: number[];
};

/**
 * Convex hull fitted to a mesh (see `hullFromPositions`). Vertices/faces are baked at authoring time
 * rather than rebuilt on load, and are centered on the hull's centroid — that displacement is folded
 * into `offset`, so the hull can be nudged around like any other shape.
 */
type ConvexShapeDescription = {
  type: 'convex';
  offset: number[];
  rotation: number[];

  quality: HullQuality;
  vertices: number[][];
  faces: number[][];
  /**
   * Hull algorithm version. 3 = AABB-anchored carve (low = the bounding box, higher levels cut
   * volume off with supporting planes) with an absolute containment audit over every mesh vertex.
   * Older hulls are rebuilt on load by the editor-helper reconciler.
   */
  v?: number;
};

export type BodyDescription = {
  mass: number;
  linearDamping: number;
  angularDamping: number;
  linearConstraints: [number, number, number];
  angularConstraints: [number, number, number];
  /**
   * Surface properties. Optional because scenes saved before they existed have neither — the engine
   * defaults them to 0.3 / 0, which is exactly how those scenes already behaved.
   *
   * Two bodies combine with min(friction) and max(restitution), so the deliberately-set value wins:
   * a character at friction 0 stays frictionless on any ground, and a bouncy ball bounces off a dead wall.
   */
  friction?: number;
  restitution?: number;
  /**
   * The two independent channels a body participates in. Optional for the same reason as the surface
   * properties above: scenes saved before they existed have neither, and absent must mean `true` —
   * i.e. every such body keeps simulating and keeps blocking the camera exactly as it always did.
   *
   * `simulatePhysics: false` leaves the body in the world as a ghost the solver ignores but a camera
   * probe still sees; `cameraCollision: false` is the reverse. Neither implies the other.
   */
  simulatePhysics?: boolean;
  cameraCollision?: boolean;
  /**
   * Meters below the collider's feet that still count as grounded. Optional and defaulting to `0` (off)
   * for the same reason as the fields above: scenes saved before it existed have none, and the engine
   * treats absent as 0 — grounding from solver contacts only, exactly as those scenes behaved. A small
   * value (~0.1–0.2) probes the ground each frame so `isGrounded` stops flickering under a resting body.
   */
  groundProbeDistance?: number;
  /** Time constant for this body's MEASURED motion, in seconds. 0/absent = the engine default (~0.09s). */
  motionSmoothing?: number;
  shapes: ShapeDescription[];
}
export type ShapeDescription = BoxShapeDescription | SphereShapeDescription | CylinderShapeDescription | CapsuleShapeDescription | PlaneShapeDescription | ConvexShapeDescription;

export type LoadingProgress = { loaded: number; total: number; label: string };

// Soft pastel-blue editor viewport background, used across every editor mode. Projects saved with the old
// grey default are migrated to this on load (see initializeEngine).
export const EDITOR_CLEAR_COLOR: [number, number, number, number] = [0.68, 0.80, 0.90, 1.0];
const LEGACY_CLEAR_COLOR = [0.65, 0.65, 0.71];

/**
 * Persist an asset library to IndexedDB whenever it changes.
 *
 * Each library is stored under a single key, so a write rewrites the WHOLE array — and a mesh library
 * carries full vertex data plus embedded base64 textures. Importing several models in a row would
 * therefore re-clone the entire library once per model. Two things fix that:
 *  - the write is debounced, so a burst of adds collapses into one write;
 *  - it goes through the project worker (saveToStorage), so the IndexedDB transaction runs off-thread.
 */
function usePersistedLibrary<T>(key: string, value: T, loaded: React.MutableRefObject<boolean>): void {
  useEffect(() => {
    if (!loaded.current) return; // don't write back before the initial read lands (would clobber it)
    const timer = setTimeout(() => {
      saveToStorage(key, value).catch(e => console.warn(`Failed to persist ${key}:`, e));
    }, 400);
    return () => clearTimeout(timer);
  }, [key, value, loaded]);
}

export type EditorMode = 'scene' | 'landscape' | 'tilemap' | 'template' | 'renderer' | 'material' | 'terrainMaterial' | 'animation' | 'animationField' | 'model' | 'script' | 'tileset';
export type GizmoMode = 'position' | 'rotation' | 'scale';
export type SavingState = 'idle' | 'saving' | 'saved' | 'error';

// Browser-style editor tabs. The scene tab hosts the open scene asset and its scene/landscape/renderer
// sub-mode; template and material tabs each own a live edit session (a throwaway Scene in
// tabRuntimeRef). `editorMode` is derived from the active tab (see EngineProvider).
//
// A 'model' tab is an edit session for an imported model asset: one subtree per LOD level in a throwaway
// scene (the model's parts, transforms and material edited via the normal Scene + Properties panels,
// LOD/cull via the Model inspector), saved back to the library and propagated to placed copies. Parts
// added here adopt the model's material — see adoptModelMaterial (models.ts) for why.
// Opening one also renders the asset's thumbnail (imports don't — that used to stall the main thread).
// A 'script' tab is a dedicated code editor for a Script asset (no 3D scene): the full-panel editor renders
// over the viewport, with a Save Script action. Its working source buffers per-tab until saved.
// An 'animationField' tab is an edit session for an Animation Field asset: the field's source Model asset
// is instantiated into a throwaway scene and driven directly by the field editor's transport, while the
// blend space itself is authored on a 2D plot overlaying the viewport.
// A 'tileset' tab is a pure 2D editor for a Tileset asset — the atlas image with its slicing grid drawn
// over it, plus per-tile metadata. Like a script tab it owns NO 3D scene, so it never gets a tabRuntimeRef
// entry and nothing about it touches the renderer.
export type TabKind = 'scene' | 'template' | 'material' | 'terrainMaterial' | 'animation' | 'animationField' | 'model' | 'script' | 'tileset';

/**
 * The scene tab's id — a fixed sentinel, unlike the library tabs' random ids.
 *
 * It is deliberately NOT the open scene's id: only one scene is ever open (openScene parses the target
 * blob into the one live Scene), so the tab is a stable slot that different scene assets pass through.
 * Keying it by scene id would leak a dirtyTabs entry per scene switch and buy nothing. What the tab
 * SHOWS — its title — follows the open scene's name; see the tabs/openSceneId sync in EngineProvider.
 */
export const SCENE_TAB_ID = 'main';

/** What each tab kind edits, for save progress detail and the Save button's tooltip. */
export const KIND_LABEL: Record<TabKind, string> = {
  scene: 'Scene',
  template: 'Template',
  material: 'Material',
  terrainMaterial: 'Terrain material',
  animation: 'Animation',
  animationField: 'Animation field',
  model: 'Model',
  script: 'Script',
  tileset: 'Tileset',
};

// Reactive per-mesh-tab edit state (the tab's Scene itself lives in tabRuntimeRef). levelIds[i] is the
// node id of LOD level i's root inside the tab scene; distances[i] is the camera distance where level i
// takes over (distances[0] is always 0).
export type ModelEditSession = {
  /** Root node id per level in the edit scene. Index 0 is the mesh itself; 1..n are previews of the
   *  referenced LOD assets, shown so the user can compare them but not authored here. */
  levelIds: string[];
  /** The LOD definition behind each extra level, aligned to `levelIds[i + 1]`. Normally a `modelId`
   *  reference; a legacy embedded level is carried through unchanged so saving cannot drop it. */
  lodRefs: ModelLodDef[];
  distances: number[];
  cullDistance: number;
  activeLevel: number;
  /** Any level contains a skinned model — LOD/cull authoring is disabled (static-only v1). */
  skinned: boolean;
};
export interface EditorTab {
  id: string;
  kind: TabKind;
  title: string;
  templateId?: string | null; // template tabs: source template id, null = unsaved new template
  materialId?: string | null; // material tabs: source material asset id, null = unsaved new material
  terrainMaterialId?: string | null; // terrain-material tabs: source terrain-material asset id
  animationSourceId?: string | null; // animation tabs: id of the original skinned node in the main scene
  modelId?: string | null; // mesh tabs: the previewed mesh asset id
  scriptId?: string | null; // script tabs: the edited script asset id
  animationFieldId?: string | null; // animation-field tabs: the edited field asset id
  tilesetId?: string | null; // tileset tabs: the edited tileset asset id
}
export type TerrainTool = 'raise' | 'lower' | 'smooth' | 'flatten';
// No 'move': a landscape is positioned with the ordinary transform gizmo in scene mode, like any other
// node. Landscape mode is brushes only.
export type TerrainBrushMode = 'sculpt' | 'paint' | 'foliage';
export type TerrainBrushState = {
  mode: TerrainBrushMode;
  tool: TerrainTool;
  radius: number;
  strength: number;
  falloff: number;
  /** Active splat layer (0..3) for the paint tool. */
  paintLayer: number;
  /** When true the foliage tool erases instead of scatters. */
  foliageErase: boolean;
  /** Id of the landscape node currently being edited (set by the inspector). */
  activeLandscapeId: string | null;
};

export type TilemapTool =
  | 'brush' | 'eraser' | 'rect' | 'bucket' | 'stamp' | 'eyedropper' | 'randomize' | 'autotile';

/**
 * The tilemap painting state, shared between the floating tool card, the palette panel and the viewport
 * brush. A ref rather than state for the same reason TerrainBrushState is one: the brush reads it from
 * pointer handlers that register once, and re-registering them on every slider tick would drop strokes.
 */
export type TilemapBrushState = {
  tool: TilemapTool;
  /** Id of the tilemap node being painted (set by the inspector; falls back to the first in the scene). */
  activeTilemapId: string | null;
  activeLayer: number;
  /** The palette selection as a rectangle — a single tile for the brush, a block for the stamp. */
  stamp: { w: number; h: number; tiles: number[] };
  /** Orientation applied to every tile this brush places. */
  orient: { flipX: boolean; flipY: boolean; rot90: boolean };
  /** Variant set the randomize tool draws from, and terrain set the auto-tile tool resolves against. */
  variantSetId: number | null;
  terrainId: number | null;
};

// Create a context to hold the engine and scene
const EngineContext = createContext<{
  instance: CleoEngine | null;
  editorScene: Scene;
  mainScene: Scene; // the game scene (editorScene may be a template/material preview scene)
  eventEmitter: EventEmitter;
  selectedNode: string | null;
  isGizmoDragging: boolean;
  isPlayMode: boolean;
  isSceneReady: boolean;
  editorMode: EditorMode;
  setEditorMode: (mode: EditorMode) => void;
  // Transform gizmo mode (move/rotate/scale)
  gizmoMode: GizmoMode;
  setGizmoMode: (mode: GizmoMode) => void;
  // Editor tabs (Main + template tabs)
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
  // Template editor
  enterTemplateEditor: (templateId?: string) => void;
  editingTemplateName: string | null;
  templateRootId: string | null;
  // Material editor
  enterMaterialEditor: (materialId?: string) => void;
  createMaterialForNode: (node: Node) => void;
  editingMaterialName: string | null;
  setActiveMaterialName: (name: string) => void;
  // Terrain-material editor
  enterTerrainMaterialEditor: (terrainMaterialId?: string) => void;
  editingTerrainMaterialName: string | null;
  editingTerrainMaterialNode: Node | null;
  refreshTerrainMaterialPreview: () => void;
  setActiveTerrainMaterialName: (name: string) => void;
  // Animation editor
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
  // UI overlay state (outside 3D scene)
  ui: UIState;
  setUI: (next: UIState) => void;
  addUIElement: (el: UIElement, parentId?: string) => void;
  updateUIElement: (el: UIElement) => void;
  removeUIElement: (id: string) => void;
  // Play lifecycle
  startPlay: () => void;
  stopPlay: () => void;
  pausePlay: () => void;
  // Node templates
  templates: Template[];
  addTemplate: (t: Template) => void;
  removeTemplate: (id: string) => void;
  updateTemplate: (id: string, t: Template) => void;
  // Material assets
  materials: MaterialAsset[];
  addMaterial: (m: MaterialAsset) => void;
  removeMaterial: (id: string) => void;
  updateMaterial: (id: string, m: MaterialAsset) => void;
  // Terrain-material assets
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
  // Animation Field assets (blend spaces)
  animationFields: AnimationFieldAsset[];
  addAnimationField: (f: AnimationFieldAsset) => void;
  removeAnimationField: (id: string) => void;
  updateAnimationField: (id: string, f: AnimationFieldAsset) => void;
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
  // Tileset assets (sliced atlases painted by tilemap layers)
  tilesets: TilesetAsset[];
  addTileset: (t: TilesetAsset) => void;
  removeTileset: (id: string) => void;
  updateTileset: (id: string, t: TilesetAsset) => void;
/** Open (or focus) a Tileset asset's edit tab. Creates a fresh, atlas-less one when given no id. */
  enterTilesetEditor: (tilesetId?: string) => void;
  /** Import an image file as an atlas, build a tileset sliced around it, and open it. */
  createTilesetFromImage: (file: File) => Promise<string | null>;
  /** The tileset asset the active tileset tab edits, or null. */
  editingTilesetId: string | null;
  /** Save a tileset asset and push it into every tilemap that embedded a copy. */
  saveTileset: (asset: TilesetAsset) => void;
  /** Open a script asset in its dedicated Script editor tab (creates a new 'node' script when no id is given). */
  enterScriptEditor: (scriptId?: string) => void;
  /** Save the active Script tab's buffered source to its asset and clear the tab's dirty flag. */
  /** Buffer a Script tab's working source and mark the tab dirty (called by the tab editor on each edit). */
  setScriptTabSource: (tabId: string, scriptId: string, source: string) => void;
  /** The buffered working source for a script tab, or undefined. */
  getScriptTabSource: (scriptId: string) => string | undefined;
  // Mesh assets (imported models)
  models: ModelAsset[];
  addModel: (m: ModelAsset) => void;
  removeModel: (id: string) => void;
  updateModel: (id: string, m: ModelAsset) => void;
  /** Open (or focus) a model asset's edit tab, rendering its thumbnail on the way in. */
  enterModelEditor: (modelId?: string) => void;
  // Mesh editor (active mesh tab): LOD/cull authoring + save-and-propagate
  modelSession: ModelEditSession | null;
  /** Node id of the active LOD level's root in the model tab scene (viewport drop parent), or null. */
  modelEditTargetId: string | null;
  setActiveModelName: (name: string) => void;
  /** Add an existing mesh asset as the next LOD level (levels are references, not copies). */
  addModelLodFromAsset: (modelId: string) => void;
  removeModelLod: (level: number) => void;
  setModelLodDistance: (level: number, distance: number) => void;
  setModelCullDistance: (distance: number) => void;
  setActiveModelLevel: (level: number) => void;
  importModelFiles: (files: File[]) => Promise<void>;
  // True once every IndexedDB-backed asset library has finished its initial read.
  assetsLoaded: boolean;
  // Mesh import review modal
  pendingModelImport: PendingModelImportView | null;
  resolveModelImport: (decision: ModelImportDecision | null) => void;
  // Live model-import progress (null when there is no run and nothing left to report)
  // Animation import (into the Animation Editor's model)
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
  resolveAnimationImport: (decision: AnimationImportDecision | null) => void;
  // Project persistence
  savingState: SavingState;
  replaceProjectMeta: (meta: ProjectMeta) => Promise<void>;
  // Multi-scene project
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
   * What the open scene IS: a 2D scene is authored with tilemaps, a 3D one with landscapes. Persisted on
   * SceneMeta, edited only from the scene settings panel. It decides which sculpt mode the top bar offers
   * and which of the two a published build keeps.
   *
   * NOT the camera — see viewDimension for the rig you are looking through.
   */
  sceneDimension: '2D' | '3D';
  setSceneDimension: (sceneId: string, dimension: '2D' | '3D') => Promise<void>;
  /** Set while a dimension switch is waiting on the user to confirm losing the other dimension's work. */
  pendingDimensionConfirm: { to: '2D' | '3D'; losing: 'tilemap' | 'landscape'; count: number } | null;
  resolveDimensionConfirm: (proceed: boolean) => void;
  /**
   * Which camera rig the viewport is looking through — orthographic pan/zoom or free-fly.
   *
   * Editor-session state, deliberately NOT the scene's authored dimension: looking at a 3D scene through
   * an orthographic camera is a useful thing to do and must not rewrite what the scene is. Follows the
   * scene on open and on an authored change; never persisted.
   */
  viewDimension: '2D' | '3D';
  setViewDimension: (dimension: '2D' | '3D') => void;
  // Unsaved-changes confirm dialog (promise parked by openScene/closeTab, resolved by UnsavedSceneModal)
  pendingSceneConfirm: { sceneName: string; action: 'switch' | 'close' } | null;
  resolveSceneConfirm: (decision: 'save' | 'discard' | 'cancel') => void;
  /** Mark a tab as having unsaved edits. For edits the SCENE_CHANGED listener cannot see (e.g. animation
   *  state-machine edits, which live in StateMachineContext's own React state). */
  /** `reason` labels the cause in the Dirty debug channel (see utils/dirtyDebug). */
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
    ui: { version: 1, elements: [] },
    setUI: () => {},
    addUIElement: () => {},
    updateUIElement: () => {},
    removeUIElement: () => {},
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
    animationFields: [],
    addAnimationField: () => {},
    removeAnimationField: () => {},
    updateAnimationField: () => {},
    enterAnimationFieldEditor: () => {},
    createAnimationFieldForModel: () => null,
    editingAnimationFieldId: null,
    animationFieldTargetId: null,
    saveAnimationField: () => {},
    tilesets: [],
    addTileset: () => {},
    removeTileset: () => {},
    updateTileset: () => {},
    enterTilesetEditor: () => {},
    createTilesetFromImage: async () => null,
    editingTilesetId: null,
    saveTileset: () => {},
    enterScriptEditor: () => {},
    setScriptTabSource: () => {},
    getScriptTabSource: () => undefined,
    models: [],
    addModel: () => {},
    removeModel: () => {},
    updateModel: () => {},
    enterModelEditor: () => {},
    modelSession: null,
    modelEditTargetId: null,
    setActiveModelName: () => {},
    addModelLodFromAsset: () => {},
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
  
  // Create a custom hook to access the engine and scene from anywhere
export const useCleoEngine = () => {
    return useContext(EngineContext);
};

/**
 * The live editing scene. `spawnRulesEnabled` is off from the moment it exists, not set later: Scene.parse
 * applies spawnOnStart, and setupInitialScene() parses into this object during boot — a flag assigned after
 * that would arrive too late and hide every dormant node in the editor viewport.
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
  /**
   * The open-documents session from the last visit, read ONCE, synchronously, before the first render.
   *
   * It has to be synchronous. `editorMode` is derived during render from the active tab, and DockLayout's
   * controller reads it on its very first effect — so restoring in an effect instead would build the scene
   * mode's panel layout, show it, and then rebuild the real one a frame later.
   */
  const [restoredSession] = useState(() => loadTabState(SCENE_TAB_ID));
  // The Main tab's sub-mode (scene/landscape/renderer). `editorMode` exposed to consumers is derived
  // from the active tab — 'template' when a template tab is active, else this.
  const [mainMode, setMainMode] = useState<MainMode>(restoredSession.mainMode);
  // Active transform-gizmo mode (move/rotate/scale), driven by the viewport toggle.
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('position');
  /** Where Play was pressed from, so Stop can put the user back. Null while play started on the scene tab. */
  const playReturnRef = useRef<{ tabId: string; mainMode: MainMode } | null>(null);
  /** Play is waiting for the forced switch to the scene tab to commit (see startPlay). */
  const pendingPlayRef = useRef(false);
  // Mirrored during RENDER, like tabsRef: startPlay reads it from an async/event path where the render-scoped
  // value would be a commit behind.
  const mainModeRef = useRef(mainMode);
  mainModeRef.current = mainMode;
  // Editor tabs: the Main tab (real game scene) plus any open template tabs. Each template tab's live
  // scene + root live in tabRuntimeRef (not React state — Scene objects shouldn't be serialized).
  //
  // Restored tabs arrive as METADATA only: their runtime sessions are built lazily (see hydrateTab), and the
  // boot effect prunes any whose asset has since been deleted.
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
   * Put a freshly built tab into the strip — the tail every `enter*Editor` ends with.
   *
   * With `adoptTabId` the builder was called to HYDRATE a restored placeholder rather than to open something
   * new, so the tab is replaced in place (keeping its id and its position in the strip) and activation is
   * left to the caller: hydration runs *before* the active tab is committed, and activating here would
   * commit it early, in the wrong order.
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
   *  never log a stale title; the ref is declared further down but is only ever read at call time. */
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
  // would blame on the ACTIVE tab — including the tab that just saved. Hold this while propagating.
  const dirtySuppressRef = useRef(false);
  /** Run `fn` (synchronous — the sync*Instances family all are) without its edits marking any tab dirty. */
  const withoutDirty = <T,>(fn: () => T): T => {
    const prev = dirtySuppressRef.current;
    dirtySuppressRef.current = true;
    try { return fn(); } finally { dirtySuppressRef.current = prev; }
  };
  const isDirtySuppressed = () => dirtySuppressRef.current;
  // Thumbnail rendering builds throwaway scenes whose node inserts emit SCENE_CHANGED, which would
  // otherwise mark the active tab unsaved — including right after a save cleared it. Installed once here
  // rather than threaded through every render call, because nothing that module does is ever a user edit.
  setThumbnailDirtySuppressor(withoutDirty);
  const [savingState, setSavingState] = useState<SavingState>('idle');
  // The rig the viewport is currently looking through. A ref as well as state because applyActiveTab
   // reads it off-render to restore the Main tab's view when returning from an asset tab (those always
   // render in 3D). The scene's AUTHORED dimension is a different thing entirely — see setSceneDimension.
  const [viewDimension, setViewDimensionState] = useState<'2D' | '3D'>('3D');
  const viewDimensionRef = useRef<'2D' | '3D'>('3D');
  // Which rig is currently INSTALLED on the camera. Distinct from viewDimensionRef, which tracks the
  // scene tab's remembered view and is deliberately left alone while an asset tab renders in 3D.
  const previousViewRef = useRef<'2D' | '3D'>('3D');
  /**
   * Where the editor camera was the last time each rig was on screen, so flipping the view is reversible.
   *
   * The 2D branch of the CHANGE_DIMENSION handler parks the camera at a fixed pose and the 3D branch
   * restores nothing, so without this a 3D -> 2D -> 3D round trip left the camera stranded at the 2D pose
   * with a perspective projection. Tolerable when the toggle was an authoring setting you flipped once;
   * not when it is a view control you flip constantly.
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
    // Gate the engine's property-level change events: emit only while editing a ready scene — never during
    // Play (its transient edits must not mark the scene unsaved) and never before the scene has loaded (so
    // the initial parse's setter storm costs nothing). Structural changes ignore this and always emit.
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
  const [uiState, setUiState] = useState<UIState>({ version: 1, elements: [] });
  const uiStateRef = useRef(uiState);
  const startedRef = useRef(false);
  useEffect(() => { uiStateRef.current = uiState; }, [uiState]);

  // Debug-overlay visibility (collider wireframes, light icons, …), per Editor/Runtime channel. The
  // reconcilers read the ref (they run in rAF/event callbacks, not render), and toggling emits
  // DEBUG_VISIBILITY_CHANGED so they re-run. Persisted so a chosen debugging setup survives reloads.
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
  // ~5MB localStorage quota). Loaded asynchronously on mount, migrating any legacy localStorage copy once.
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
    // Unlink any placed instances so they become normal, fully-editable nodes (instead of staying
    // locked forever with no template to edit). Removing the marker re-renders the provider, so the
    // node inspector's read-only gate re-evaluates to editable.
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

  // Reusable terrain-material assets (global library like materials): a Basic/Blinn/PBR surface plus
  // terrain blend + foliage rules. Persisted to IndexedDB (base64 textures + thumbnail). Terrain paint
  // layers reference one via the layer's materialId.
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
  // thumbnail). Mirrors the materials library above. Drag a mesh into the viewport to instantiate a copy.
  const [models, setModels] = useState<ModelAsset[]>([]);
  const modelsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<ModelAsset[]>(libKey('models'));
        if (list && list.length) setModels(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load models:', e); }
      finally { modelsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary(libKey('models'), models, modelsLoadedRef);

  // Reactive edit state for open mesh tabs (tab id -> session). The tab's Scene stays in tabRuntimeRef;
  // this holds what the Mesh inspector renders (LOD level ids/distances, cull distance, active level).
  const [modelSessions, setModelSessions] = useState<Record<string, ModelEditSession>>({});

  const addModel = (m: ModelAsset) => setModels(prev => [...prev, m]);
  const removeModel = (id: string) => {
    // A preview tab for a deleted mesh would render a subtree whose asset no longer exists — close it
    // first (mirrors removeMaterial). Safe to reference the later-declared tab helpers: this only ever
    // runs from a click, long after the component body has evaluated.
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
    // Clear the embedded copy from every state that played it, across every live scene. Without this the
    // node keeps posing a field the project no longer contains — a pose with nothing in the editor to
    // explain it. Clearing degrades the state to "no clip" (bind pose), which reads as broken and is
    // therefore fixable.
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
    // Unlink every layer painted from it. The cells stay — they are the user's work — but the layer draws
    // nothing until a tileset is assigned again, which reads as broken and is therefore fixable.
    let changed = false;
    for (const scene of liveScenes()) if (detachTileset(scene, id)) changed = true;
    if (changed) eventEmitter.current.emit('SCENE_CHANGED');
    const open = tabsRef.current.find(t => t.kind === 'tileset' && t.tilesetId === id);
    if (open) removeTabById(open.id);
  };

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

  // Dedicated Script editor tab: opens a script asset in a full-panel code editor (its own mode + Save Script
  // button), mirroring the mesh/material tabs. Working source buffers per-tab (scriptTabSourceRef) until Save.
  const scriptTabSourceRef = useRef(new Map<string, string>());
  const enterScriptEditor = (scriptId?: string, adoptTabId?: string) => {
    let id = scriptId;
    // Held across the mint, because scriptAssetsRef is mirrored during RENDER: a just-added asset is not in
    // it yet, so looking the new script up below would miss it and title the tab "Script" — which then
    // silently corrected itself to the real name the next time the tab was restored.
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
  // clear the tab's dirty flag. Takes a tab id rather than reading the active tab so Save All can reach a
  // tab that is not on screen; mirrors saveMaterialTab/saveModelTab.
  const saveScriptTab = (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab || tab.kind !== 'script' || !tab.scriptId) return;
    const source = scriptTabSourceRef.current.get(tab.scriptId);
    if (source !== undefined) saveScriptSource(tab.scriptId, source);
    // Adopt the (possibly renamed-in-source) class name into the tab title? Keep the asset name.
    clearTabDirty(tab.id);
  };
  // Called by the script tab's editor on every edit: buffer the source and mark the tab dirty.
  const setScriptTabSource = (tabId: string, scriptId: string, source: string) => {
    scriptTabSourceRef.current.set(scriptId, source);
    markTabDirty(tabId, 'script-source');
  };
  const getScriptTabSource = (scriptId: string): string | undefined => scriptTabSourceRef.current.get(scriptId);

  // True once all IndexedDB-backed libraries (and the project's scene list) have finished their initial
  // read. The asset explorer's path index must not prune entries before this — the arrays start empty,
  // and a pruning pass against an empty library would drop every folder assignment the user has made.
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  useEffect(() => {
    if (assetsLoaded) return;
    const timer = window.setInterval(() => {
      if (templatesLoadedRef.current && materialsLoadedRef.current && terrainMaterialsLoadedRef.current && modelsLoadedRef.current && scriptAssetsLoadedRef.current && animationFieldsLoadedRef.current && scenesLoadedRef.current) {
        setAssetsLoaded(true);
        window.clearInterval(timer);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [assetsLoaded]);

  /**
   * Re-resolve the STARTUP scene's asset links, once the libraries are actually there.
   *
   * openScene resyncs inline, but the boot path cannot: setupInitialScene parses the scene blob before the
   * five libraries have finished their own async IndexedDB reads, and resyncing against empty libraries
   * would unlink every material in the scene to the Basic+Null fallback. So the blob's saved hashes are
   * stashed at parse time and the pass runs here, the moment `assetsLoaded` says the libraries are real.
   *
   * Without this, an asset edited and saved WITHOUT also saving the scene renders correctly for the rest of
   * the session and then comes back stale on reload: the scene blob embeds the material it had at the
   * scene's last save, and __materialId is only a back-link until something re-resolves it.
   */
  const initialAssetHashesRef = useRef<{ hashes: Record<string, string> | undefined } | null>(null);
  const initialResyncDoneRef = useRef(false);
  useEffect(() => {
    if (initialResyncDoneRef.current || !assetsLoaded || !isSceneReady) return;
    const stashed = initialAssetHashesRef.current;
    if (!stashed) return; // no blob was parsed (fresh/empty project) — nothing to re-resolve
    // Refuse to resync against libraries that are entirely empty.
    //
    // resyncScene reads "asset not in library" as "asset was deleted" and unlinks the node — so running it
    // with empty libraries does not just fail to refresh the scene, it strips every template link, class
    // script and material from it. There is no legitimate case where a scene needs resyncing against
    // nothing: with no assets there are no links to re-resolve, so skipping is always the safe branch.
    //
    // Leave initialResyncDoneRef false so a later commit, once the libraries are actually there, still
    // gets its pass.
    const libs = currentLibs();
    const empty = !libs.materials.length && !libs.models.length && !libs.templates.length
      && !libs.terrainMaterials.length && !libs.scripts.length;
    if (empty) {
      // Deferred, not cancelled: the libraries are effect deps, so the commit that delivers them runs
      // this again.
      Logger.warn('Startup asset resync deferred: libraries not populated yet, will retry.', 'Editor');
      return;
    }
    initialResyncDoneRef.current = true;
    console.info('[DIAG] startup resync running for real:', {
      materials: libs.materials.length, models: libs.models.length, templates: libs.templates.length,
      terrainMaterials: libs.terrainMaterials.length, scripts: libs.scripts.length,
    });
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
    // The libraries are deps so the skip-when-empty branch above is recoverable: if this fires before they
    // arrive, the commit that delivers them runs it again. initialResyncDoneRef keeps it to one real pass.
  }, [assetsLoaded, isSceneReady, materials, models, templates, terrainMaterials, scriptAssets]);

  /**
   * Finish restoring last session's tabs: drop the ones whose asset is gone, then build the active one.
   *
   * DECLARED AFTER THE RESYNC EFFECT ABOVE ON PURPOSE. Effects run in declaration order within a commit, and
   * a template/model tab clones its subtree out of the libraries — so the open scene has to have been
   * re-resolved against those same libraries first, or the two disagree about what an asset currently is.
   *
   * Gated on `assetsLoaded` because every builder resolves its asset from a library, and on `isSceneReady`
   * because they all bail while `instanceRef` is null and because the preview scenes they build use the
   * renderer. Textures need no gate: preloadTextures runs at the top of setupInitialScene.
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

  // Keep the texture store in step with the libraries.
  //
  // Assets record only texture IDS; the payloads live once in the texture store. This effect is what puts
  // them there — and it is deliberately a self-healing reconcile rather than a write inside each asset
  // builder: the builders are synchronous, an IndexedDB write is not, and a missed write would mean an
  // asset whose textures vanish on reload. Idempotent, so re-running it costs one key scan.
  //
  // It also RESCUES legacy assets: their base64 payloads are adopted into the store (and registered) so
  // they survive, before anything relies on the store alone. Nothing is stripped from them here — the old
  // inline copy stays until the new path has proven itself.
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

  // Mesh import review modal: importModelFiles parks each parsed mesh here and awaits the user's decision
  // (resolved by ModelImportModal via resolveModelImport). The resolver lives in a ref so the promise in
  // importModelFiles can be settled from the modal without re-rendering churn.
  const [pendingModelImport, setPendingModelImport] = useState<PendingModelImportView | null>(null);
  const pendingResolverRef = useRef<((d: ModelImportDecision | null) => void) | null>(null);
  const resolveModelImport = (decision: ModelImportDecision | null) => {
    const r = pendingResolverRef.current;
    pendingResolverRef.current = null;
    setPendingModelImport(null);
    if (r) r(decision);
  };

  // Animation import review modal — same "park then resolve a promise" pattern as the mesh import.
  const [pendingAnimationImport, setPendingAnimationImport] = useState<PendingAnimationImportView | null>(null);
  const pendingAnimResolverRef = useRef<((d: AnimationImportDecision | null) => void) | null>(null);
  const resolveAnimationImport = (decision: AnimationImportDecision | null) => {
    const r = pendingAnimResolverRef.current;
    pendingAnimResolverRef.current = null;
    setPendingAnimationImport(null);
    if (r) r(decision);
  };

  // Unsaved-changes confirm dialog — same "park then resolve a promise" pattern as the import modals.
  // Two callers park here: openScene (switching away from a scene with unsaved edits) and closeTab
  // (closing a dirty asset tab). `action` only changes the wording; both resolve the same three ways.
  const [pendingSceneConfirm, setPendingSceneConfirm] = useState<{ sceneName: string; action: 'switch' | 'close' } | null>(null);
  const sceneConfirmResolverRef = useRef<((d: 'save' | 'discard' | 'cancel') => void) | null>(null);
  const confirmUnsavedScene = (sceneName: string, action: 'switch' | 'close' = 'switch'): Promise<'save' | 'discard' | 'cancel'> =>
    new Promise(resolve => {
      sceneConfirmResolverRef.current = resolve;
      setPendingSceneConfirm({ sceneName, action });
    });
  const resolveSceneConfirm = (decision: 'save' | 'discard' | 'cancel') => {
    const r = sceneConfirmResolverRef.current;
    sceneConfirmResolverRef.current = null;
    setPendingSceneConfirm(null);
    if (r) r(decision);
  };

  // Same park-then-resolve pattern, for switching a scene between 2D and 3D while it holds authoring that
  // only the OTHER dimension uses. The data is kept either way — the switch is reversible — but a published
  // build discards it, so the user is told before the switch rather than after the export.
  const [pendingDimensionConfirm, setPendingDimensionConfirm] =
    useState<{ to: '2D' | '3D'; losing: 'tilemap' | 'landscape'; count: number } | null>(null);
  const dimensionConfirmResolverRef = useRef<((proceed: boolean) => void) | null>(null);
  const confirmDimensionSwitch = (to: '2D' | '3D', losing: 'tilemap' | 'landscape', count: number): Promise<boolean> =>
    new Promise(resolve => {
      dimensionConfirmResolverRef.current = resolve;
      setPendingDimensionConfirm({ to, losing, count });
    });
  const resolveDimensionConfirm = (proceed: boolean) => {
    const r = dimensionConfirmResolverRef.current;
    dimensionConfirmResolverRef.current = null;
    setPendingDimensionConfirm(null);
    if (r) r(proceed);
  };

  // Derive the active tab and everything that used to hang off `editorMode === 'template'`.
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
  const activeRuntime = activeTab.kind !== 'scene' ? tabRuntimeRef.current.get(activeTab.id) : undefined;
  // The scene the inspectors/gizmo/AddNew currently edit: the game scene (Main tab) or a template/material/animation scene.
  const activeScene = activeRuntime ? activeRuntime.scene : editorSceneRef.current;
  // Legacy single mode value, now derived from the active tab kind. Keeps every existing
  // `editorMode === ...` consumer working unchanged.
  const editorMode: EditorMode = activeTab.kind === 'scene' ? mainMode
    : activeTab.kind === 'material' ? 'material'
    : activeTab.kind === 'terrainMaterial' ? 'terrainMaterial'
    : activeTab.kind === 'animation' ? 'animation'
    : activeTab.kind === 'animationField' ? 'animationField'
    : activeTab.kind === 'model' ? 'model'
    : activeTab.kind === 'script' ? 'script'
    : activeTab.kind === 'tileset' ? 'tileset'
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

  // Non-reactive mirrors of the tab list, the mesh sessions and the asset libraries (the scripts library
  // already has scriptAssetsRef). The save + propagation paths read these rather than the render-scoped
  // state: Save All walks tabs sequentially with an await per asset, where a value captured at the top of
  // the loop is stale by the second iteration.
  const tabsRef = useRef<EditorTab[]>(tabs);
  const modelSessionsRef = useRef<Record<string, ModelEditSession>>(modelSessions);
  const materialsRef = useRef<MaterialAsset[]>(materials);
  const terrainMaterialsRef = useRef<TerrainMaterialAsset[]>(terrainMaterials);
  const modelsRef = useRef<ModelAsset[]>(models);
  const templatesRef = useRef<Template[]>(templates);
  // Mirrored during RENDER, not in a useEffect.
  //
  // These are plain "latest value" mirrors, so assigning them here is idempotent and safe. Doing it in an
  // effect is not: effects run in DECLARATION order within a commit, and these are declared far below the
  // boot resync effect. Any commit that both delivered a library and flipped `assetsLoaded` therefore ran
  // the resync FIRST, against mirrors still holding []. resyncScene treats "asset not in library" as
  // "asset deleted" and unlinks — dropping every __templateId, unlinking every class script and resetting
  // every material to the Basic+Null fallback, i.e. wiping the scene it was meant to refresh.
  //
  // That window was previously hidden by slow IndexedDB reads landing in their own commits; it is a real
  // race either way, and assigning during render closes it for every currentLibs() consumer at once.
  tabsRef.current = tabs;
  modelSessionsRef.current = modelSessions;
  materialsRef.current = materials;
  terrainMaterialsRef.current = terrainMaterials;
  modelsRef.current = models;
  templatesRef.current = templates;

  const engineMaps = () => ({ scripts: scriptsRef.current, bodies: bodiesRef.current, triggers: triggersRef.current });

  /**
   * Every Scene alive in the editor: the open scene, plus each asset tab's throwaway edit scene.
   *
   * Propagation on save has to reach all of them, not just the open scene — a template tab showing a
   * material must update the moment that material is saved, exactly as the scene does. Scenes that are
   * NOT live (other scene assets, on disk) are handled pull-side by resyncScene when they are opened.
   *
   * `exceptTabId` skips the tab doing the saving, and is essential for the re-instantiating kinds: a
   * template tab's root carries __templateId (instantiateTemplate stamps it), so propagating a template
   * save into its own tab would rebuild the very subtree being edited — invalidating runtime.rootId and
   * leaving the session pointing at a detached node.
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
    tilesets: tilesetsRef.current,
  });

  // Open (or focus) a template editor tab. Each template tab owns its own throwaway edit scene.
  const enterTemplateEditor = (templateId?: string, adoptTabId?: string) => {
    const instance = instanceRef.current;
    if (!instance) return;

    // Focus an already-open tab for this template instead of duplicating it. Skipped when adopting — see
    // enterScriptEditor for why that would silently no-op the hydration.
    if (templateId && !adoptTabId) {
      const existing = tabs.find(t => t.kind === 'template' && t.templateId === templateId);
      if (existing) { setActiveTab(existing.id); return; }
    }

    // Disarm before constructing — see openMaterialTab. Deliberately after the focus-only early return
    // above: that path does not build a scene, and if the tab were already active it would not re-run the
    // activate effect that re-arms.
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
        // ---- TEMPORARY DIAGNOSTIC ----
        console.warn('[DIAG] Template not found', {
          wanted: templateId,
          stateIds: templates.map(x => x.id),
          refIds: templatesRef.current.map(x => x.id),
          stateCount: templates.length,
          refCount: templatesRef.current.length,
        });
        // ------------------------------
        Logger.error(`Template not found (id ${templateId})`, 'Editor');
        return;
      }
      rootId = instantiateTemplate(t, scene.root, engineMaps(), materialsRef.current);
      // instantiateTemplate re-resolves __materialId against the library but has never touched __modelId, so
      // a template opened here would show whatever clips were frozen into it when it was saved — a clip
      // imported against the model since then would simply be missing. Refresh them from the asset.
      //
      // Patched in place rather than re-instantiated (which is what resyncScene does for scenes): a rebuild
      // regenerates node ids, and instantiateTemplate has just re-keyed template.scripts/bodies/triggers onto
      // the ids it created. withoutDirty because a refresh from the library is not the user's edit.
      const templateRoot = scene.getNodeById(rootId);
      if (templateRoot) {
        withoutDirty(() => {
          const refreshed = refreshModelClips(templateRoot, modelsRef.current);
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
        // Animation state, restored only where the TEMPLATE has none of its own (see restoreAnimationState).
        // The asymmetry matters here specifically: this runs on "Save Template", so a machine edited inside the
        // template must reach its instances — but a template that carries no machine must not wipe one the
        // instance was configured with directly.
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
    if (mode === 'scene' || mode === 'landscape' || mode === 'tilemap' || mode === 'renderer') setMainMode(mode);
  };

  // Force skinned models to their bind (T) pose. Used to keep the editor showing the default pose
  // (animators don't tick while the scene is paused, but a model posed by a previous Play run would
  // otherwise stay frozen). Also fixes the mesh/shadow both reading the bind pose consistently.
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
    parseByType(scene.root, json);
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
  // The node the Animation Editor was opened from is a COPY — of a template's stored subtree, or of the
  // asset placed in a scene — but it carries a `__modelId` back-link. That link is what decides where a clip
  // edit lands. Writing only to the copy means importing an animation while editing a template reaches that
  // template and nothing else: not the asset, not the character's other placements, not the next template.
  //
  // So every clip/skeleton action ends the same way: patch the ASSET, then patch every live instance.

  /**
   * Apply a clip/skeleton change to every live instance of a model asset, in place.
   *
   * Deliberately NOT syncModelInstances. That re-instantiates the whole subtree, which would churn node ids,
   * invalidate the animation tab's own sourceNodeId mid-session, and drop per-placement scripts and bodies.
   * AnimatedModel's addAnimation/removeAnimation/renameAnimation and the skin's nodeNames Map are all
   * mutable in place and need no GPU rebuild, so nothing has to be rebuilt at all.
   *
   * `except` skips a node the caller has already updated (the Animation Editor's source node). The active
   * tab's scene is skipped wholesale, because that is the Animation Editor's own preview clone — also
   * already updated by the caller, and applying the change twice would land the clip on it as "name (2)".
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
   * placed instance of one (a hand-built skinned node, or one imported straight into a scene). A null result
   * means "keep the edit local to that node", which is the pre-existing behaviour.
   */
  const animationSourceAsset = (src: Node | null | undefined): { id: string; asset: ModelAsset } | null => {
    const id = modelIdOf(src);
    if (!id) return null;
    const asset = modelsRef.current.find(m => m.id === id);
    return asset ? { id, asset } : null;
  };

  // Import animation clips from a file (gltf/glb/fbx) into the model being edited in the Animation
  // Editor. Parses the file, builds a bone MAPPING from the file's skeleton onto the model's, shows the
  // review modal (where the user can correct the mapping), then RETARGETS each accepted clip through the
  // final mapping and adds it to the preview clone, the source node, the model asset and every placement.
  const importAnimationFiles = async (files: File[]) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = animationTargetId ? activeScene.getNodeById(animationTargetId) : null;
    if (!(cloneNode instanceof ModelNode) || !(cloneNode.model instanceof AnimatedModel) || !cloneNode.model.skin) {
      Logger.error('Open the Animation Editor for a skinned model before importing animations', 'Editor');
      return;
    }
    const cloneModel = cloneNode.model; // narrowed to AnimatedModel
    const targetSkin = cloneModel.skin!;

    let parsed: { animations: any[]; skin: any };
    try { parsed = await Loader.loadAnimationsFromFile(files); }
    catch (e) { Logger.error('Failed to parse animation file: ' + e, 'Editor'); return; }
    if (!parsed.animations.length) { Logger.warn('No animation clips found in the file', 'Editor'); return; }
    if (!parsed.skin) { Logger.warn('The imported file has no skeleton to match against', 'Editor'); return; }
    const sourceSkin = parsed.skin;

    // ONE mapping for the whole file — every clip in it shares the source skeleton, so matching is done once
    // and each clip's report is derived cheaply from it (and re-derived as the user edits rows in the modal).
    const mapping = buildBoneMapping(parsed.animations, sourceSkin, targetSkin);
    const fileName = files.find(f => /\.(gltf|glb|fbx)$/i.test(f.name))?.name ?? files[0]?.name ?? 'animation';

    // Diagnostic (scope 'Retarget'): one structured snapshot per import, so a broken retarget can be
    // diagnosed from the console without the user's asset files. Includes each key bone's bind rotation
    // computed both from the inverse bind matrix and from the node transforms — their disagreement is the
    // tell-tale for an animated glTF whose node transforms are its frame-0 pose, not its bind pose.
    try { Logger.print('debug', [describeRetarget(parsed.animations, sourceSkin, targetSkin, mapping)], 'Retarget'); }
    catch (e) { Logger.warn('Retarget diagnostics failed: ' + e, 'Retarget'); }

    // Bone lists for the mapping table: the source bones the clips actually animate (mapping order), and
    // every target joint for the dropdowns.
    const nameOf = (skin: any, node: number): string => skin.nodeNames?.get(node) ?? `node ${node}`;
    const sourceBones = mapping.entries.map(e => ({ node: e.sourceNode, name: e.sourceName ?? `node ${e.sourceNode}` }));
    const targetBones = targetSkin.joints.map((j: any) => ({ node: j.nodeIndex, name: nameOf(targetSkin, j.nodeIndex) }));

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
    if (!decision) { Logger.info('Animation import cancelled', 'Editor'); return; }
    const finalMapping = decision.mapping; // the user may have re-pointed bones

    const src = rt?.sourceScene && rt.sourceNodeId ? rt.sourceScene.getNodeById(rt.sourceNodeId) : null;
    const link = animationSourceAsset(src);
    let asset = link?.asset;
    let added = 0;
    parsed.animations.forEach((clip, i) => {
      if (!decision.include[i]) return;
      // Retarget against the FINAL mapping, here on accept — this is the one expensive pass, deferred out of
      // the modal's per-edit re-renders (which only recompute the cheap reports).
      const remapped = retargetAnimation(clip, sourceSkin, targetSkin, finalMapping);
      // Everything downstream stores the clip the CLONE settled on, not `remapped`. addAnimation de-dupes
      // against the clips already present, so letting each target de-dupe independently could give the same
      // import a different suffix in the asset than on the node — one clip under two names.
      const stored = cloneModel.addAnimation(remapped);                          // preview clone
      if (src instanceof ModelNode && src.model instanceof AnimatedModel) src.model.addAnimation(stored); // persist
      // The asset, and through it every other placement of this character. Chained rather than written per
      // clip so a multi-clip import lands as ONE library update instead of one per clip.
      if (asset) asset = assetWithClipAdded(asset, stored);
      if (link) propagateModelClips(link.id, m => { m.addAnimation(stored); }, src);
      added++;
    });
    if (added > 0) {
      if (link && asset) updateModel(link.id, asset);
      if (rt?.sourceTabId) markTabDirty(rt.sourceTabId, 'animation-import');
      eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
      Logger.info(`Imported ${added} animation clip${added === 1 ? '' : 's'} from ${fileName}`, 'Editor');
    }
  };

  // Backfill bone names onto a skinned model that was imported before bone-name capture existed (so its
  // skeleton has no names, and imported animations can only match by node index → wrong bones). The user
  // loads the SAME file the character came from; we copy its bone names onto the model's skin joints by
  // node index (identical for the same file). After this, animation import matches by name.
  const importSkeletonNames = async (files: File[]) => {
    const rt = tabRuntimeRef.current.get(activeTabId);
    const cloneNode = animationTargetId ? activeScene.getNodeById(animationTargetId) : null;
    if (!(cloneNode instanceof ModelNode) || !(cloneNode.model instanceof AnimatedModel) || !cloneNode.model.skin) {
      Logger.error('Open the Animation Editor for a skinned model first', 'Editor');
      return;
    }
    let parsed: { animations: any[]; skin: any };
    try { parsed = await Loader.loadAnimationsFromFile(files); }
    catch (e) { Logger.error('Failed to parse file: ' + e, 'Editor'); return; }
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

    // Bone names are skeleton data, so they belong to the asset: without this the backfill would have to be
    // repeated for every placement, and only the one you happened to open would ever match by name.
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
   * Persist the IK rig for the model being edited in the Animation Editor.
   *
   * Takes the same route bone names do, and for the same reason: a rig is joint indices into the SKELETON, so
   * it belongs to the model asset rather than to whichever placement happened to be open. Writing only to the
   * open node would mean re-assigning both legs for every copy of the character in the project.
   *
   * Order matters — the preview clone first (so the viewport updates this frame), then the source node, then
   * the asset, then every other live instance. `Skin` is mutable and needs no GPU rebuild, exactly as
   * `nodeNames` does, so nothing is re-instantiated.
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

    // No asset link means a hand-built skinned node: the edit stays local to it, which is the pre-existing
    // behaviour for every other skeleton edit.
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
   *
   * Every builder reached from here is SYNCHRONOUS and has written `tabRuntimeRef` by the time it returns,
   * which is what lets `setActiveTab` hydrate before committing the active tab — see the rule there.
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
   *
   * Hydrating BEFORE `setActiveTabId` is load-bearing, not a nicety. `activeScene` falls back to the open
   * scene whenever the active tab has no runtime — so a tab committed early would show the real scene tree
   * under an asset tab's title, let AddNew and the gizmo edit the real scene, and blame the asset tab for
   * the resulting dirty mark. Never commit `activeTabId` to a tab without a runtime.
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

  // Close a template tab (Main is unclosable). Discards unsaved edits after a confirm — saving is the
  // explicit "Save Template" action, so closing does not auto-save.
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
        if (getMaterialIdOf(n) === materialId) { applyMaterialAsset(n, asset); changed = true; }
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
      if (getMaterialIdOf(n) === id) { unlinkToFallback(n); changed = true; }
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
    // Disarm dirty-tracking before building the preview scene. SCENE_CHANGED is global and names no
    // scene, so mark() can only blame the ACTIVE tab — and every node this construction splices into the
    // new throwaway scene would otherwise land on the scene tab as if the user had edited it. The
    // tab-activate effect re-arms once the new tab is showing.
    dirtyArmedRef.current = false;
    const scene = new Scene();
    void createMaterialPreviewScene(scene); // env map + skybox attach once the cubemap images load

    if (asset) {
      for (const t of asset.textures || []) {
        if (t?.id && !TextureManager.Instance.getTexture(t.id)) TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id);
      }
    }
    const material: Material = asset ? Material.parse(asset.material) : Material.PBR({});
    const sphere = new ModelNode('preview', new Model(Geometry.Sphere(48), material));
    scene.addNode(sphere);
    // Screen-mode custom materials are camera post passes, not mesh surfaces: run the SAME instance on
    // the preview camera so it previews live (the sphere still carries it for the inspector; the
    // renderer skips drawing models with a screen material). CustomMaterialEditor keeps the camera
    // list in step when the mode is switched inside the tab.
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
      // Opening is what produces the preview now that import no longer renders one. Not on hydration: the
      // thumbnail already exists, and re-rendering one per restored tab costs a GL frame each at boot.
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
  const createMaterialForNode = (node: Node) => {
    if (!instanceRef.current) return;
    const material = getNodeMaterial(node);
    if (!material) return;
    const asset = buildMaterialAsset(material, `${node.name} Material`, '');
    addMaterial(asset);
    applyMaterialAsset(node, asset); // stamp __materialId so the node now references the asset
    eventEmitter.current.emit('TEXTURES_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    openMaterialTab(asset); // seed directly: `asset` isn't in the `materials` state this render yet
  };

  // ---- Thumbnails on open --------------------------------------------------------------------------
  //
  // Importing no longer renders previews: every capture is a full GL frame, and doing one per material
  // plus one per mesh froze the editor mid-import. Instead an asset is stored with an empty thumbnail
  // (the explorer shows the kind's icon) and its preview is rendered the first time it is opened.
  //
  // Renders from the asset's *saved* data, not from a live tab scene — renderModelThumbnail reparents the
  // node it is given, which would rip the subtree out of the preview tab we just built.
  const thumbnailPendingRef = useRef(new Set<string>());

  const captureAssetThumbnail = (kind: 'material' | 'terrainMaterial' | 'model', id: string) => {
    const engine = instanceRef.current;
    if (!engine) return;
    // One capture per asset in flight; a re-open while one is running must not queue a second GL render.
    if (thumbnailPendingRef.current.has(id)) return;
    thumbnailPendingRef.current.add(id);

    // Deliberately not awaited: the tab opens immediately and the card updates whenever the render lands.
    // The write patches only `thumbnail` through the functional setter, so an edit made while the render
    // was in flight is not clobbered by a stale snapshot.
    (async () => {
      try {
        if (kind === 'material') {
          const asset = materials.find(m => m.id === id);
          if (!asset) return;
          const thumbnail = await renderMaterialAssetThumbnail(engine, asset);
          if (thumbnail) setMaterials(prev => prev.map(x => x.id === id ? { ...x, thumbnail } : x));
        } else if (kind === 'terrainMaterial') {
          const asset = terrainMaterials.find(m => m.id === id);
          if (!asset) return;
          const thumbnail = await renderTerrainMaterialAssetThumbnail(engine, asset);
          if (thumbnail) setTerrainMaterials(prev => prev.map(x => x.id === id ? { ...x, thumbnail } : x));
        } else {
          const asset = models.find(m => m.id === id);
          if (!asset) return;
          const thumbnail = await renderModelAssetThumbnail(engine, asset);
          if (thumbnail) setModels(prev => prev.map(x => x.id === id ? { ...x, thumbnail } : x));
        }
      } catch (e) {
        Logger.warn(`Could not render the thumbnail for this asset: ${e}`, 'Editor');
      } finally {
        thumbnailPendingRef.current.delete(id);
      }
    })();
  };

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
  // instantiated directly (NOT via the LodGroup wrapper — the renderer must not auto-swap levels while
  // the user edits). Materials/transforms/sub-models are edited through the normal Scene + Properties
  // panels; LOD levels, distances and the cull threshold through the Mesh inspector. Opening the tab
  // also triggers the asset's thumbnail render.
  const openMeshTab = (asset: ModelAsset, adoptTabId?: string) => {
    // Disarm dirty-tracking before building the preview scene. SCENE_CHANGED is global and names no
    // scene, so mark() can only blame the ACTIVE tab — and every node this construction splices into the
    // new throwaway scene would otherwise land on the scene tab as if the user had edited it. The
    // tab-activate effect re-arms once the new tab is showing.
    dirtyArmedRef.current = false;
    const scene = new Scene();
    scene.animationsEnabled = false; // skinned models hold their bind pose while editing
    scene.spawnRulesEnabled = false; // ...and a spawnOnStart=false node still shows while it is being authored
    // Same asset-edit environment as template tabs — see createAssetEditScene. The viewing light is
    // __editor__ named, so it neither appears in the mesh's tree nor gets saved into the asset.
    void createAssetEditScene(scene, withoutDirty);

    const holder = new Node(asset.name);
    scene.addNode(holder);

    // Restore legacy embedded textures (instantiateModelAsset used to do this).
    for (const t of asset.textures || []) {
      if (t?.id && !TextureManager.Instance.getTexture(t.id))
        TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id);
    }

    // Level 0 is the mesh being edited. Extra levels are resolved from the library every time the tab
    // opens — that is the point of referencing: the level always shows the current state of its source
    // mesh. A reference whose asset has been deleted is dropped with a warning rather than opening a tab
    // that cannot be saved.
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
      const clone = JSON.parse(JSON.stringify(json));
      regenerateIds(clone, new Map());
      parseByType(holder, clone);
      levelIds.push(clone.id);
    }
    scene.start();

    const tabId = adoptTabId ?? cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: holder.id });
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
  const syncModelInstances = (modelId: string, asset: ModelAsset, exceptTabId?: string) => {
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
        const wasSelected = inst.id === selectedNode;
        // Drop the old subtree's out-of-band data so map entries don't leak.
        for (const id of collectSubtreeIds(inst)) { maps.scripts.delete(id); maps.bodies.delete(id); maps.triggers.delete(id); }
        // Detach synchronously with removeChild, not remove() — see syncTemplateInstances for why.
        parent.removeChild(inst);
        const newId = instantiateModelAsset(asset, parent, materialsRef.current, modelsRef.current);
        const newNode = scene.getNodeById(newId);
        if (newNode) {
          newNode.setPosition(pos).setRotation(rot).setScale(scl);
          newNode.spawnOnStart = spawnOnStart;
          restoreAnimationState(newNode, animation);
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

  // After a mesh asset is saved, refresh every terrain-material foliage rule that references it
  // (rule.modelId): rebuild the embedded flattened LOD payload in the library asset, then swap
  // prototypes on live terrain layers using those materials — WITHOUT re-scattering instances.
  const syncFoliageRulesForModel = (modelAsset: ModelAsset) => {
    const updated: TerrainMaterialAsset[] = [];
    for (const tmAsset of terrainMaterials) {
      const rules = tmAsset.material?.foliageInclude;
      if (!Array.isArray(rules) || !rules.some((r: any) => r?.modelId === modelAsset.id)) continue;
      try {
        const nextRules = rules.map((r: any) => r?.modelId === modelAsset.id ? buildFoliageRuleFromModelAsset(modelAsset, r, modelsRef.current) : r);
        const material = { ...tmAsset.material, foliageInclude: nextRules };
        const patched: TerrainMaterialAsset = { ...tmAsset, material, textureIds: [...collectTerrainMaterialTextureIds(material)] };
        updateTerrainMaterial(tmAsset.id, patched);
        updated.push(patched);
      } catch (e) {
        Logger.warn(`Foliage rule for model "${modelAsset.name}" in terrain material "${tmAsset.name}" was not updated: ${e}`, 'Editor');
      }
    }
    if (updated.length === 0) return;

    // Re-apply each updated material to the game-scene terrain layers that link it. skipAutoGenerate:
    // this is an edit sync, so scattered foliage keeps its instances and only the prototypes change.
    for (const landscape of editorSceneRef.current.landscapes) {
      const terrain = landscape.terrain;
      for (const asset of updated) {
        terrain.layers.forEach((layer, i) => {
          if (layer.materialId === asset.id) applyTerrainMaterialToLayer(terrain, i, asset, { skipAutoGenerate: true });
        });
      }
    }
    eventEmitter.current.emit('SCENE_CHANGED');
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
      // Only level 0 is authored here, so only it has to resolve to a live node. Extra levels are
      // references — they are saved as `{ modelId, distance }` and their geometry belongs to the mesh they
      // point at, which is why they no longer need to be found in this scene and serialized back out.
      //
      // The recorded id is a hint, not a contract. Restructuring the mesh — parenting it under a new root
      // node and deleting the old one — is ordinary authoring, and it retires the node this session was
      // opened with. Rather than refusing to save, fall back to reading the mesh out of its holder: the
      // holder is the container this tab created, so whatever sits under it (minus the read-only LOD
      // previews) IS the mesh.
      // A node the user deleted can still be in the tree: Node.remove() only marks it, and the sweep runs
      // on a later Scene.update. Serializing one writes content the user already removed — and, when the
      // deleted node is an emptied parent, writes it INSTEAD of what they moved out. Treat marked nodes
      // as gone everywhere this resolves a root. (The Delete button now removes synchronously, so this is
      // the net for any other deferred path — including a node left marked after being moved out of a
      // deleted subtree, since markForRemoval is never cleared.)
      const alive = (n: Node | null | undefined): n is Node => !!n && !n.markForRemoval;

      const holder = runtime.scene.getNodeById(runtime.rootId);
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
        // Inside the holder first (the usual case), then at the scene root — a new root node added while
        // the scene row was selected lands there rather than inside the holder.
        let candidates = (holder?.children ?? []).filter(isContent);
        if (candidates.length === 0)
          candidates = runtime.scene.root.children.filter(n => n.id !== runtime.rootId && isContent(n));

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
          // Several content roots — the normal result of merging models into one mesh: drop a second mesh
          // in, move both model nodes up to the root, delete the two original roots. A mesh asset
          // serializes from ONE subtree, so they are wrapped in a single root named after the asset.
          //
          // Done by reparenting into a scratch node rather than assembling JSON by hand, because
          // serialize() reads the live tree. The finally below always puts the nodes back, so a failure
          // part-way cannot leave the user's scene dismantled.
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
      const collectMats = (n: Node) => { const id = getMaterialIdOf(n); if (id) materialIdSet.add(id); n.children.forEach(collectMats); };
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

      // Refuse to persist a mesh with nothing in it. An empty asset renders as nothing and overwrites
      // whatever was saved before, so a save that produced one has read the wrong subtree — exactly how
      // a moved model was silently replaced by the emptied parent it came out of. Returning here leaves
      // the stored asset untouched and the tab dirty, so the work is still on screen to recover.
      if (!nodeJsonHasModel(asset.nodeJson)) {
        Logger.error(
          `Model "${tab.title}" has no geometry in it — refusing to save, the stored model is unchanged. ` +
          'Check the Scene panel still shows the model you expect.', 'Editor');
        return;
      }

      updateModel(tab.modelId, asset);
      withoutDirty(() => {
        syncModelInstances(tab.modelId!, asset, tab.id);
        syncFoliageRulesForModel(asset);
        // Levels are references, so this mesh may be a LOD of others — their placed instances embed a
        // copy of what was just edited and would otherwise keep rendering the previous geometry until
        // something else happened to re-instantiate them. Refresh those too. Only one hop is needed: a
        // level renders the referenced mesh's own subtree, never its levels, so this cannot cascade.
        for (const dependent of modelsRef.current) {
          if (dependent.id === tab.modelId) continue;
          if (!dependent.lods?.some(l => l.modelId === tab.modelId)) continue;
          syncModelInstances(dependent.id, dependent, tab.id);
          syncFoliageRulesForModel(dependent);
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
   * Add an existing mesh asset as the next LOD level of the active mesh tab.
   *
   * The level stores only a reference; its geometry keeps living in the mesh it points at, so editing
   * that low-poly asset later updates every mesh using it as a level. A preview of it is spliced into the
   * edit scene so the user can compare levels, but that preview is never serialized back — it is rebuilt
   * from the library each time the tab opens.
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
      const holder = runtime.scene.getNodeById(runtime.rootId);
      if (!holder) return;

      // Splice in a preview of the referenced mesh. Ids are regenerated so it cannot collide with the
      // level it was cloned from — the same asset may legitimately be open in its own tab.
      const clone = JSON.parse(JSON.stringify(source.nodeJson));
      regenerateIds(clone, new Map());
      resolveMaterialRefs(clone, materialsRef.current);
      clone.name = source.name;
      parseByType(holder, clone);

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

  // Remove an extra LOD level (level 0 is the asset itself and cannot be removed).
  const removeModelLod = (level: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'model' || level < 1) return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = modelSessions[tab.id];
    if (!runtime || !session || level >= session.levelIds.length) return;

    const root = runtime.scene.getNodeById(session.levelIds[level]);
    if (root?.parent) root.parent.removeChild(root);

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
    applyActiveModelLevel(runtime.scene, session.levelIds, level);
    eventEmitter.current.emit('SELECT_NODE', session.levelIds[level]);
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
    instantiateModelAsset(model, holder, materialsRef.current, modelsRef.current);
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
   * Persist an edited field and push it into everything already playing it.
   *
   * The re-embed is what keeps embed-on-Apply honest: a state stores a COPY of the field, so without this
   * an edit would only reach nodes whose machine was applied again afterwards. Every live scene is walked
   * (the open scene plus each asset tab's edit scene), matching how template/model saves propagate.
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

  // ---- Tileset editor --------------------------------------------------------------------------------

  // Unlike every other asset tab this one owns NO scene: a tileset is an image with a grid drawn over it,
  // so the editor is a canvas and the tab needs no tabRuntimeRef entry, no throwaway Scene and no renderer
  // involvement at all. Same shape as the script tab.
  const enterTilesetEditor = (tilesetId?: string, adoptTabId?: string) => {
    let asset = tilesetId ? tilesetsRef.current.find(t => t.id === tilesetId) : undefined;

    if (!tilesetId) {
      // A brand-new tileset starts with no atlas: the image is assigned from the editor's own slot, which
      // is where its pixel dimensions come from. Building one around a texture up front would need a
      // picker before the editor has even opened.
      asset = buildTilesetAsset('Tileset', '', 0, 0);
      addTileset(asset);
      // The library update lands in the next commit, so seed the ref directly — otherwise the tab opens
      // against state that does not yet contain the asset it was just given.
      tilesetsRef.current = [...tilesetsRef.current, asset];
    }
    if (!asset) { Logger.error('Tileset not found', 'Editor'); return; }

    if (!adoptTabId && tilesetId) {
      const existing = tabsRef.current.find(t => t.kind === 'tileset' && t.tilesetId === tilesetId);
      if (existing) { setActiveTab(existing.id); return; }
    }
    const tabId = adoptTabId ?? cryptoRandomId();
    commitTab({ id: tabId, kind: 'tileset', title: asset.name, tilesetId: asset.id }, adoptTabId);
  };

  /**
   * Import an image and build a tileset around it in one step — the "+ Add > Tileset" path.
   *
   * The tile size is guessed from the image, which is right often enough to save retyping it and visibly
   * wrong when it isn't (the grid draws over the atlas). Returns null when the file could not be decoded,
   * in which case importAtlasImage has already logged why.
   */
  const createTilesetFromImage = async (file: File): Promise<string | null> => {
    const imported = await importAtlasImage(file, (event) => eventEmitter.current.emit(event as any));
    if (!imported) return null;
    const tile = guessTileSize(imported.width, imported.height);
    // A texture's id is its filename; trim the extension for a readable asset name.
    const name = imported.textureId.replace(/\.[^./\\]+$/, '') || imported.textureId;
    const asset = buildTilesetAsset(name, imported.textureId, imported.width, imported.height, {
      tileWidth: tile, tileHeight: tile,
    });
    // The image is already decoded on this path (importAtlasImage registers it through addTextureFromData),
    // so the card preview can be rendered now rather than waiting for the first save.
    asset.thumbnail = renderTilesetThumbnail(asset) ?? undefined;
    addTileset(asset);
    // The library update lands in the next commit, so seed the ref directly — enterTilesetEditor reads it.
    tilesetsRef.current = [...tilesetsRef.current, asset];
    enterTilesetEditor(asset.id);
    return asset.id;
  };

  /** Persist an edited tileset and push it into every tilemap already drawing from a copy of it. */
  const saveTileset = (input: TilesetAsset) => {
    // The card preview is a plain canvas downscale of the atlas, so it is cheap enough to refresh on every
    // save rather than needing the explicit regenerate path the 3D-rendered thumbnails use.
    const asset = { ...input, thumbnail: renderTilesetThumbnail(input) ?? input.thumbnail };
    updateTileset(asset.id, asset);
    tilesetsRef.current = tilesetsRef.current.map(t => t.id === asset.id ? asset : t);
    const open = tabsRef.current.find(t => t.kind === 'tileset' && t.tilesetId === asset.id);
    if (open) {
      clearTabDirty(open.id);
      if (open.title !== asset.name) setTabs(prev => prev.map(t => t.id === open.id ? { ...t, title: asset.name } : t));
    }
    Logger.info(`Tileset "${asset.name}" saved`, 'Editor');
  };

  // Import one or more model files (and folders) into the mesh library. Groups the selection into one
  // bundle per model file; for each: parses, then opens the review modal (missing textures + scale
  // normalization) and awaits the user. On accept, applies any uploaded textures (re-parse), normalizes
  // scale, registers each material as a reusable MaterialAsset linked via __materialId, and stores the
  // model asset. Models land in the library only — drag a card to place it.
  //
  // Every stage transition is published to the shared progress store, so what the window says is what the
  // code is actually doing.
  const importModelFiles = async (files: File[]) => {
    const engine = instanceRef.current;
    if (!engine) { Logger.error('Engine not ready for import', 'Editor'); return; }
    const bundles = groupImportFiles(files);
    if (bundles.length === 0) { Logger.warn('No model files (.gltf/.glb/.obj/.fbx) found in the selection', 'Editor'); return; }

    const task = startTask({
      title: 'Importing models',
      steps: bundles.map(b => ({ name: b.name, status: 'pending' as StepStatus, detail: 'Queued' })),
      cancellable: true,
      // Settling the review modal lets a loop parked on it reach the cancel check below.
      // cancelAllImports additionally terminates the worker, which is the only way to stop a parse
      // that is already running — assimp's conversion is one uninterruptible WASM call, so before the
      // worker existed Cancel could only take effect between models.
      onCancel: () => {
        cancelAllImports();
        if (pendingResolverRef.current) resolveModelImport(null);
      },
    });

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
        let parsedResult: { root: Node; children: ModelNode[] };
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

        const missing = await detectMissingTextures(bundle.files);
        const sizeRadius = meshBoundsRadius(root);
        const matKeys = new Set<string>();
        for (const c of children) { const m = (c.model as any).material; if (m) matKeys.add(JSON.stringify(m.serialize())); }

        // Park the parsed mesh and await the user's decision from ModelImportModal.
        setStage(i, 'review', missing.length
          ? `${missing.length} texture${missing.length === 1 ? '' : 's'} missing — awaiting review`
          : 'Awaiting review');
        const decision = await new Promise<ModelImportDecision | null>(resolve => {
          pendingResolverRef.current = resolve;
          setPendingModelImport({
            bundleName: bundle.name,
            subMeshCount: children.length,
            materialCount: matKeys.size,
            missing,
            sizeRadius,
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
        //
        // Thumbnails are deliberately NOT rendered here. Each capture builds a throwaway Scene and drives
        // renderer.screenshot — a full GL frame — so importing a model with N materials used to cost N+1
        // synchronous scene renders on the main thread and tanked the framerate. Assets are stored with an
        // empty thumbnail; thumbnailOf() falls back to the kind's icon, and the real preview is rendered
        // the first time the asset is opened (see captureAssetThumbnail).
        const materialIds: string[] = [];
        const assetByKey = new Map<string, MaterialAsset>();
        // Which material asset each sub-mesh ended up on — a separated asset must list only the materials
        // ITS own mesh uses, not every material in the file.
        const materialIdOfChild = new Map<ModelNode, string>();
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
            setStage(i, 'materials', `Registering material ${materialIds.length} of ${matKeys.size}`);
          }
          applyMaterialAsset(child, asset); // stamps __materialId + rebuilds the node's material
          materialIdOfChild.set(child, asset.id);
        }

        const separate = decision.separate && children.length > 1;
        setStage(i, 'saving', separate
          ? `Creating ${children.length} separate assets`
          : 'Serializing to the model library');

        if (separate) {
          const assets = await separateSubModels(root, children, bundle.name, materialIdOfChild);
          for (const asset of assets) addModel(asset);
          eventEmitter.current.emit('TEXTURES_CHANGED');

          const summary = `${assets.length} separate model${assets.length === 1 ? '' : 's'}`;
          setStage(i, 'done', summary);
          Logger.info(`Imported "${bundle.name}" as ${summary}`, 'Editor');
        } else {
          const modelAsset = await buildModelAsset(root, materialIds, '');
          addModel(modelAsset);
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
  // captureMaterialSphere renders the tab's own scene offscreen, so this works for a tab that is not on
  // screen — which is what lets Save All reach every dirty material.
  const saveMaterialTab = (tabId: string) => {
    const instance = instanceRef.current;
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!instance || !tab || tab.kind !== 'material') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    if (!runtime) return;
    const sphere = runtime.scene.getNodeById(runtime.rootId) as ModelNode | null;
    if (!sphere || !sphere.model) return;
    try {
      const thumbnail = captureMaterialSphere(instance, runtime.scene);
      if (tab.materialId) {
        const asset = buildMaterialAsset(sphere.model.material, tab.title, thumbnail, tab.materialId);
        updateMaterial(tab.materialId, asset);
        // Propagation edits other scenes, so it must not mark them dirty: the link (__materialId) is what
        // they store, and resyncScene re-resolves it on open. Dirtying here would mean saving any material
        // left every open scene claiming unsaved edits — and Save All could never reach all-clean.
        withoutDirty(() => syncMaterialInstances(tab.materialId!, asset, tab.id)); // push edits to placed references
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
          if (layers[i]?.materialId === id) { applyTerrainMaterialToLayer(terrain, i, asset); changed = true; }
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
    // Disarm dirty-tracking before building the preview scene. SCENE_CHANGED is global and names no
    // scene, so mark() can only blame the ACTIVE tab — and every node this construction splices into the
    // new throwaway scene would otherwise land on the scene tab as if the user had edited it. The
    // tab-activate effect re-arms once the new tab is showing.
    dirtyArmedRef.current = false;
    const scene = new Scene();
    void createMaterialPreviewScene(scene); // env map + skybox attach once the cubemap images load
    const tm = asset ? parseTerrainMaterialAsset(asset) : TerrainMaterial.Create('pbr', { baseColor: [0.38, 0.5, 0.28] });
    // A tiny helper terrain owns a composite Material.Terrain (+ a fully-layer-0 splat); layer 0 = the edited
    // material, so the preview renders through the terrain shader (displacement/parallax/height-blend visible).
    const helperTerrain = new Terrain({ size: 2, resolution: 2 });
    // auto off so the preview always shows the surface; tiling pinned to 1 so the sphere previews the
    // surface itself, not the terrain-space texture repeat (the tm's own tiling is untouched).
    helperTerrain.setLayer(0, tm, { auto: false, tiling: 1 });
    const previewNode = new ModelNode('preview', new Model(Geometry.Sphere(48), helperTerrain.material));
    scene.addNode(previewNode);
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

  // Re-derive the composite preview from the edited TerrainMaterial after any inspector change.
  const refreshTerrainMaterialPreview = () => {
    const runtime = tabRuntimeRef.current.get(activeTabId);
    if (runtime?.helperTerrain && runtime.tm) runtime.helperTerrain.setLayer(0, runtime.tm, { auto: false, tiling: 1 });
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
  const saveTerrainMaterialTab = (tabId: string) => {
    const instance = instanceRef.current;
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!instance || !tab || tab.kind !== 'terrainMaterial') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    if (!runtime) return;
    const material = runtime.tm; // the edited TerrainMaterial (the preview node carries the composite)
    if (!material) return;
    try {
      const thumbnail = captureMaterialSphere(instance, runtime.scene);
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

  // Arm dirty-tracking for the scene tab on a cold start.
  //
  // The tab-activate effect below arms on every switch, but it bails while instanceRef is still null — and
  // on startup that is always the case, because the engine initializes in its own async effect. The scene
  // tab is active from the first render and never "switches", so nothing would ever arm it and the first
  // session would silently register no edits at all. Wait for the same settle window the switch path uses,
  // so the editor-helper reconciler's opening SCENE_CHANGED burst doesn't read as an edit.
  useEffect(() => {
    if (!isSceneReady) return;
    requestAnimationFrame(() => requestAnimationFrame(() => { dirtyArmedRef.current = true; }));
  }, [isSceneReady]);

  /**
   * Put the engine behind a tab: swap in its scene, set the grid/dimension and reset the selection.
   *
   * Extracted from the effect below because that effect cannot cover the boot case. It bails while
   * `instanceRef` is null — always true on the first commit, since the engine initializes in its own async
   * effect — and its only dep is `activeTabId`, which does not change during boot. A session restored with
   * an asset tab active would therefore never get `instance.setScene(runtime.scene)`. The boot effect calls
   * this directly instead. (The dirty-arming effect above documents the same bail-out.)
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
    instance.renderer.setGridVisible(tab.kind !== 'material' && tab.kind !== 'terrainMaterial');
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

  // The scene tab is titled with the scene asset it is showing, not a fixed label — it is the open scene's
  // document, and the tab is where the user reads which scene that is. Follows both a scene switch
  // (openSceneId) and a rename (sceneList).
  useEffect(() => {
    const name = sceneList.find(s => s.id === openSceneId)?.name;
    if (!name) return;
    setTabs(prev => prev.map(t => (t.id === SCENE_TAB_ID && t.title !== name ? { ...t, title: name } : t)));
  }, [sceneList, openSceneId]);

  // Mark the active tab dirty on scene edits (after the open-settle window). Every tab kind goes through
  // the same dirtyTabs entry — the scene tab included, where it means the open scene asset has unsaved
  // edits. Play mode never marks dirty (it runs a separate play scene, so its edits must not make the
  // editor scene look unsaved), and neither does propagation (see dirtySuppressRef).
  useEffect(() => {
    const mark = (e?: SceneChange) => {
      // Guards are split one per line so the Dirty channel can name which one rejected a mark (verbose
      // mode). Behaviour is unchanged when the channel is off — logDirtySkip is then a no-op.
      if (!dirtyArmedRef.current) return logDirtySkip('not-armed', e);
      if (isPlayModeRef.current) return logDirtySkip('play-mode', e);
      if (dirtySuppressRef.current) return logDirtySkip('suppressed', e);
      // Ignore mutations to editor-owned nodes — the free-fly viewport camera (an __editor__Camera Node,
      // moved every frame during navigation) and the __editor__/__debug__ helper icons + physics wireframes
      // the reconciler splices in. None are user edits, and without this the engine's new per-setter transform
      // events would mark a clean scene unsaved the instant the user orbits the camera.
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
        ui: uiStateRef.current,
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
      // The AUTHORED dimension, never the view. These used to be the same value, so persisting the rig
      // mirror here was harmless — the moment the viewport toggle became view-only it would have meant
      // that merely LOOKING at a 3D scene through the orthographic camera and hitting save rewrote the
      // scene as 2D, and a publish would then discard its landscape.
      const authored = dimensionOfScene(sceneId);
      await updateProjectMeta(m => ({
        ...m,
        // prefs.dimension is legacy (it was project-wide); the rig now belongs to the scene. Kept written
        // so rolling back to a build that reads it still lands on something sensible.
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

  // The live animation session's Apply, registered by StateMachineProvider — and by AnimationFieldProvider
  // for a field tab, which has the same shape of problem. Neither tab can be saved from here: an animation
  // tab has no asset of its own (saving it means applying the machine onto the source model), and both keep
  // their working copy as React state inside their own provider. Only the active tab ever has a session, so
  // one slot is enough.
  const animationApplyRef = useRef<{ tabId: string; apply: () => void } | null>(null);
  const registerAnimationApply = (reg: { tabId: string; apply: () => void } | null) => { animationApplyRef.current = reg; };

  /**
   * Save one tab, whichever kind it is. Returns whether the tab came out clean — each save path clears the
   * tab's dirty flag on success and logs + returns early on failure, so the flag is the honest signal.
   */
  const saveTabById = async (tabId: string): Promise<boolean> => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return false;
    switch (tab.kind) {
      case 'scene': return await saveCurrentScene();
      case 'template': await saveTemplateTab(tabId); break;
      case 'model': await saveModelTab(tabId); break;
      case 'material': saveMaterialTab(tabId); break;
      case 'terrainMaterial': saveTerrainMaterialTab(tabId); break;
      case 'script': saveScriptTab(tabId); break;
      case 'animation':
      case 'animationField': {
        const reg = animationApplyRef.current;
        if (!reg || reg.tabId !== tabId) return false;
        // Animation: writes the machine onto the source model, dirtying ITS tab.
        // Animation field: writes the field asset to the library and re-embeds it where it is played.
        reg.apply();
        break;
      }
    }
    return !dirtyTabsRef.current[tabId];
  };

  const savingRef = useRef(false);

  /**
   * The one save runner: drives `tabIds` sequentially, one progress step each, and owns `savingState` (the
   * Save button's label/icon). Every save entry point goes through here — a single asset, Save All, and the
   * scene save that openScene runs — so they cannot drift or nest tasks inside one another.
   *
   * Each step races a 15s timeout as a defensive backstop, so a wedged serialize can never leave the UI
   * stuck on "Saving…".
   */
  const runSave = async (tabIds: string[], title: string): Promise<boolean> => {
    if (savingRef.current || !tabIds.length) return false;
    const named = tabIds.map(id => ({ id, tab: tabsRef.current.find(t => t.id === id) }));
    savingRef.current = true;
    setSavingState('saving');
    const task = startTask({
      title,
      steps: named.map(n => ({ name: n.tab?.title ?? 'Asset', status: 'pending' as const })),
      cancellable: tabIds.length > 1,
    });
    let failed = 0;
    try {
      for (let i = 0; i < named.length; i++) {
        if (task.cancelled) {
          for (let j = i; j < named.length; j++) task.setStep(j, { status: 'skipped' });
          failed++;
          break;
        }
        task.setStep(i, { status: 'running', detail: named[i].tab ? KIND_LABEL[named[i].tab!.kind] : undefined });
        try {
          const ok = await Promise.race<boolean>([
            saveTabById(named[i].id),
            new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error('Save timed out')), 15000)),
          ]);
          task.setStep(i, ok ? { status: 'done', detail: 'Saved' } : { status: 'failed', error: 'Save failed' });
          if (!ok) failed++;
        } catch (e: any) {
          Logger.error(`Failed to save "${named[i].tab?.title}": ${e?.message || e}`, 'Editor');
          task.setStep(i, { status: 'failed', error: String(e?.message || e) });
          failed++;
        }
      }
      setSavingState(failed ? 'error' : 'saved');
      return failed === 0;
    } finally {
      task.finish();
      savingRef.current = false;
      setTimeout(() => setSavingState('idle'), 2000);
    }
  };

  const saveActiveTab = async (): Promise<boolean> => {
    const tab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    if (!tab) return false;
    return runSave([tab.id], `Saving ${tab.title}`);
  };

  /**
   * Save every tab with unsaved edits.
   *
   * Order is load-bearing. Animation applies run first — applying is what makes the source model's tab
   * dirty, so it has to happen before we decide what to save. Then the leaf assets, then the models and
   * templates that embed them, and the scene last: saveCurrentScene captures a content hash per referenced
   * asset, and hashing a material we are about to rewrite would store a stale hash and cause a pointless
   * resync on next open.
   */
  const saveAll = async (): Promise<void> => {
    if (savingRef.current) return;

    const live = animationApplyRef.current;
    if (live && dirtyTabsRef.current[live.tabId]) live.apply();

    const ORDER: Record<TabKind, number> = {
      material: 0, terrainMaterial: 0, script: 0, animation: 0, animationField: 0, tileset: 0,
      model: 1, template: 2, scene: 3,
    };
    // Snapshot: propagation is suppressed and so cannot extend this set, but taking it up front also makes
    // the loop finite by construction rather than by argument.
    const targets = tabsRef.current
      .filter(t => dirtyTabsRef.current[t.id])
      .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    if (!targets.length) return;
    await runSave(targets.map(t => t.id), `Saving ${targets.length} asset${targets.length === 1 ? '' : 's'}`);
  };

  const saveProjectToStorage = (): Promise<boolean> => runSave([SCENE_TAB_ID], 'Saving scene');

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
      ui: { version: 1, elements: [] },
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
   * A scene's camera rig, migrating on read: scenes authored before this was per-scene have no `dimension`,
   * so they fall back to the old project-wide preference, then to 3D. The resolved value is persisted onto
   * the scene by the next save (see saveCurrentScene).
   */
  /**
   * Swap the camera rig the viewport looks through.
   *
   * The single writer of the view: the viewport's own toggle calls it directly, and everything that should
   * make the view FOLLOW the scene (opening one, changing its authored type, booting) calls it too. It is
   * never persisted — reloading always lands on the scene's own dimension.
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

    // Warn when the scene still holds authoring the target dimension has no use for. Only checkable for
    // the OPEN scene — a closed one's tree is a blob on disk — which is also the only one the user can be
    // looking at while flipping the switch.
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
    // Changing what the scene IS also changes what you are looking through — but only for the scene on
    // screen, and only as a consequence. The view can be flipped back on its own afterwards without
    // touching this setting again.
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
    const clone = JSON.parse(JSON.stringify(data));
    regenerateIds(clone.scene, new Map());
    const id = cryptoRandomId();
    const name = uniqueSceneName(entry.name, meta.scenes);
    await saveSceneData(id, { ...clone, savedAt: Date.now() });
    await updateProjectMeta(m => ({ ...m, scenes: [...m.scenes, { id, name, updatedAt: Date.now() }] }));
    return id;
  };

  /**
   * Open a scene asset in the Main tab. Only one scene is ever open: the current scene's editor
   * state (scripts/bodies/triggers/UI/selection) is torn down and the target's blob is parsed into
   * the same live Scene object (exactly the Import path, which is proven on a started scene).
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
    applyGameData(data, { ...engineMaps(), scene, setUI: setUiState, renderer: instanceRef.current?.renderer });
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
    // the INCOMING scene's rig, not the outgoing one's, now that each scene carries its own. This is also
    // what makes the view follow the scene: a 3D scene always opens looking 3D, whatever you were last
    // looking through.
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
    }

    // Multi-scene project: load the meta (migrating a legacy single-scene 'cleo_project' blob once),
    // then parse the last-open scene's blob. A fresh install gets a meta with one empty "Main" scene
    // whose blob is written on first save — the "a project always has ≥1 scene" invariant.
    //
    // The legacy import is gated on the project: this function now runs once per PROJECT, so without the
    // gate every project the user creates would adopt the same legacy scene as its "Main".
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
        applyGameData(data, { ...engineMaps(), scene: editorSceneRef.current, setUI: setUiState, renderer: instanceRef.current?.renderer });
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
              },
          });

          instanceRef.current = engine;
          instanceRef.current.isPaused = false;

          // Logs bypass this bridge: the console panel's store subscribes to CleoEngine.eventEmitter
          // directly (features/logger/logStore.ts), so it also catches everything logged before mount.
          CleoEngine.eventEmitter.on('SCENE_CHANGED', (e) => { eventEmitter.current.emit('SCENE_CHANGED', e) });
          
          await setupInitialScene();

          // Migrate projects saved with the old grey default to the pastel-blue editor background (leaves
          // any intentionally-customised clear color alone). applyGameData may have restored a saved one.
          const cc = engine.renderer.clearColor;
          if (cc && Math.abs(cc[0] - LEGACY_CLEAR_COLOR[0]) < 0.01 && Math.abs(cc[1] - LEGACY_CLEAR_COLOR[1]) < 0.01 && Math.abs(cc[2] - LEGACY_CLEAR_COLOR[2]) < 0.01)
            engine.renderer.clearColor = [...EDITOR_CLEAR_COLOR];

          TextureManager.Instance.addTextureFromBase64(NullImage, {}, 'Null');
          TextureManager.Instance.addTextureFromBase64(LightIcon, {
            mipMap: false
          }, '__editor__light_icon');
          // Light-probe viewport billboard icon — the concentric-circles probe glyph (matching the
          // inspector's ProbeIcon), rasterised to a PNG so it can be a sprite texture like the light icon.
          TextureManager.Instance.addTextureFromBase64(buildProbeIconDataURL(), {
            mipMap: false
          }, '__editor__probe_icon');
          eventEmitter.current.emit('TEXTURES_CHANGED');

          // Setting the editor scene and camera
          engine.setScene(editorSceneRef.current);
          // The editor scene runs unpaused (for camera nav), so disable animator playback and pin
          // skinned models to their bind/T pose — animations only play in Play mode + the Anim Editor.
          editorSceneRef.current.animationsEnabled = false;
          // spawnRulesEnabled is already off — see createEditorScene, which has to set it before the parse
          // that setupInitialScene() above has already done.
          editorSceneRef.current.start();
          showBindPoseForSkinnedModels(editorSceneRef.current);

          // Restore selection/dimension from saved prefs (falls back to the scene root / 3D).
          const prefs = pendingPrefsRef.current;
          setSelectedNode(prefs?.selectedNode ?? editorSceneRef.current.root.id);

          engine.run();

          // Enable the editor infinite-grid overlay (ground/XZ plane by default).
          engine.renderer.setGridVisible(true);
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

  // Keep editor helper nodes (light/camera/probe icons + physics debug wireframes) derived from the
  // scene's contents. Helpers are __editor__/__debug__ prefixed so they never leak into play/save/
  // publish; we only maintain them on the active editor scene while editing. Reconciling is coalesced
  // to one rAF, and a suppress flag ignores the SCENE_CHANGED the reconciler's own edits emit.
  const reconcileScheduledRef = useRef(false);
  const suppressReconcileRef = useRef(false);
  useEffect(() => {
    const runReconcile = () => {
      reconcileScheduledRef.current = false;
      // (Terrain-)material preview scenes want no editor helper icons (light sprites/gizmos) cluttering the sphere.
      if (editorMode === 'material' || editorMode === 'terrainMaterial') return;
      const vis = debugVisibilityRef.current;
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
          // ITSELF, while the light icons and gizmo helpers it splices in emit SCENE_CHANGED like any other
          // node edit and would otherwise read as unsaved work. They are editor bookkeeping, never the user's
          // change, so they must not dirty the tab at any time — not merely inside an opening settle window.
          withoutDirty(() => reconcileEditorHelpers(activeScene, bodiesRef.current, triggersRef.current, vis, 'editor'));
          // The reference grid is editor chrome (not a scene node), driven straight off its Editor toggle.
          // Skipped in renderer mode, where the Renderer panel owns its own grid switch.
          if (editorMode !== 'renderer') instanceRef.current?.renderer.setGridVisible(vis.grid.editor);
        }
      } finally { suppressReconcileRef.current = false; }
    };
    const schedule = (e?: SceneChange) => {
      // Structural/visibility/name changes affect which helper icons + wireframes are needed; the per-setter
      // transform/material/... events do not, so skip them (PHYSICS_CHANGED passes no payload and still runs).
      if (e && e.kind !== 'structure' && e.kind !== 'visibility' && e.kind !== 'name') return;
      if (suppressReconcileRef.current || reconcileScheduledRef.current) return;
      reconcileScheduledRef.current = true;
      requestAnimationFrame(runReconcile);
    };
    const emitter = eventEmitter.current;
    emitter.on('SCENE_CHANGED', schedule);
    emitter.on('PHYSICS_CHANGED', schedule);
    emitter.on('DEBUG_VISIBILITY_CHANGED', schedule);
    schedule(); // initial reconcile for the current scene / mode
    return () => {
      emitter.off('SCENE_CHANGED', schedule);
      emitter.off('PHYSICS_CHANGED', schedule);
      emitter.off('DEBUG_VISIBILITY_CHANGED', schedule);
    };
  }, [activeScene, isPlayMode, editorMode]);

  // Event handling
  useEffect(() => {
    eventEmitter.current.on('CHANGE_DIMENSION', (dimension: '2D' | '3D') => {
      if (!instanceRef.current) return;
      // Only the Main tab's view is remembered; asset tabs render transiently in 3D and must not
      // overwrite the rig the scene tab goes back to.
      if (activeTabKindRef.current === 'scene') viewDimensionRef.current = dimension;

      // Wait for scene to be ready
      if (!instanceRef.current.scene) {
        console.log('Scene not ready yet, retrying...');
        setTimeout(() => {
          eventEmitter.current.emit('CHANGE_DIMENSION', dimension);
        }, 100);
        return;
      }

      // change camera to 2D
      // `const`, not `let`: it is never reassigned, and const is what lets the null-guard below narrow
      // it inside the onUpdate closures too (a captured `let` could be reassigned, so TS re-widens it).
      const cameraNode = instanceRef.current.scene.activeCamera;
      // Scene.activeCamera is undefined when no camera is active — nothing to reconfigure.
      if (!cameraNode) return;

      // Remember where the OUTGOING rig was parked before touching anything, so the trip back lands where
      // you left. Taken first (rather than only on a real switch) so the boot emit records the starting 3D
      // pose too — otherwise the very first return from 2D would have nothing to restore.
      //
      // Scene tab only, and that guard is load-bearing: applyActiveTab installs the incoming tab's scene
      // BEFORE it asks for a rig, so without it switching to an asset tab would snapshot that tab's own
      // preview camera under the scene tab's key and then push the scene's pose onto it. Asset tabs are
      // transient 3D previews that own their framing; leave their cameras alone.
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
            // Pan with left OR right button when not dragging gizmo
            if ((mouse.buttons.Left || mouse.buttons.Right) && !isGizmoDraggingRef.current) {
                node.addX(-mouse.velocity[0] * movement);
                node.addY(mouse.velocity[1] * movement);

                InputManager.instance.isKeyPressed('KeyW') && node.addY(movement * 10);
                InputManager.instance.isKeyPressed('KeyS') && node.addY(-movement * 10);
                InputManager.instance.isKeyPressed('KeyA') && node.addX(-movement * 10);
                InputManager.instance.isKeyPressed('KeyD') && node.addX(movement * 10);
            }
            // Zoom with mouse wheel by scaling ortho extents
            if (!isGizmoDraggingRef.current && Math.abs(mouse.wheel.deltaY) > 0 && InputManager.instance.isMouseOverCanvas()) {
              // Wheel up (deltaY < 0) SHRINKS the ortho extents, i.e. shows less world, i.e. zooms in —
              // matching the 3D rig's dolly below and every other wheel in the editor. The sign used to be
              // negated here, which for an orthographic camera meant wheel-up grew the frustum and zoomed
              // OUT, the opposite of both the 3D rig and this line's own comment.
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
          // Rotate and move with left button when not dragging gizmo
          if (mouse.buttons.Left && !isGizmoDraggingRef.current) {
            node.rotateX( mouse.velocity[1] * movement * 5).rotateY(-mouse.velocity[0] * movement * 5);
            InputManager.instance.isKeyPressed('KeyW') && node.addForward(movement);
            InputManager.instance.isKeyPressed('KeyS') && node.addForward(-movement);
            InputManager.instance.isKeyPressed('KeyA') && node.addRight(-movement);
            InputManager.instance.isKeyPressed('KeyD') && node.addRight(movement);
            InputManager.instance.isKeyPressed('KeyE') && node.addY(movement);
            InputManager.instance.isKeyPressed('KeyQ') && node.addY(-movement);
          }
          // Pan with right button (translate along the view's right/up axes)
          if (mouse.buttons.Right && !isGizmoDraggingRef.current) {
            node.addRight(-mouse.velocity[0] * movement);
            node.addUp(mouse.velocity[1] * movement);
          }
          // Zoom with mouse wheel by dollying the camera forward/backward
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
        // Enable mouse capture during play so left-click locks pointer
        InputManager.instance.enableMouseCapture();
        // Clear selection and outline rendering when entering play mode
        setSelectedNode(null);
        if (instanceRef.current && instanceRef.current.renderer) {
          instanceRef.current.renderer.setSelectedNode(null);
          // Hide the editor grid while in game mode
          instanceRef.current.renderer.setGridVisible(false);
          // Never render a debug channel in the running game (in case Play is pressed in Renderer mode).
          instanceRef.current.renderer.debugView = 'final';
        }
        // Pressing Escape should release pointer lock
        InputManager.instance.registerKeyPress('Escape', () => InputManager.instance.releaseMouse());
      }
      else if (state === 'pause') {
        instanceRef.current.isPaused = true;
        setIsPlayMode(true);
        // Keep selection cleared during pause mode
        setSelectedNode(null);
        if (instanceRef.current && instanceRef.current.renderer) {
          instanceRef.current.renderer.setSelectedNode(null);
        }
      }
      else if (state === 'stop') {
        instanceRef.current.isPaused = false; // Unpause for editor scene
        setIsPlayMode(false);
        // Restore the editor grid when returning to the editor scene, honouring its Editor toggle.
        if (instanceRef.current.renderer) {
          instanceRef.current.renderer.setGridVisible(debugVisibilityRef.current.grid.editor);
        }
        // Disable mouse capture and release pointer
        InputManager.instance.disableMouseCapture();
      }
    });

    eventEmitter.current.on('SELECT_NODE', (node: string | null) => {
      console.log('SELECT_NODE event received:', node);
      setSelectedNode(node);

      // Use stencil-based outlining instead of creating outline nodes. In a material tab the preview
      // sphere is the (logical) selection so the inspector targets it, but it must not show the outline.
      if (instanceRef.current && instanceRef.current.renderer) {
        const outlineTarget = (activeTabKindRef.current === 'material' || activeTabKindRef.current === 'terrainMaterial') ? null : node;
        instanceRef.current.renderer.setSelectedNode(outlineTarget);
        console.log('Selection updated in renderer:', outlineTarget);
      }
    });

    eventEmitter.current.on('GIZMO_DRAG_START', (data: { axis: string, nodeId: string }) => {
      console.log('GIZMO_DRAG_START event received:', data);
      setIsGizmoDragging(true);
      isGizmoDraggingRef.current = true;
    });

    eventEmitter.current.on('GIZMO_DRAG_END', (data: { axis: string | null, nodeId: string | null }) => {
      console.log('GIZMO_DRAG_END event received:', data);
      setIsGizmoDragging(false);
      isGizmoDraggingRef.current = false;
    });

    // Reset gizmo dragging state
    isGizmoDraggingRef.current = false;
    setIsGizmoDragging(false);

    // Default values (the initial CHANGE_DIMENSION is emitted from initializeEngine once the scene is live).
    eventEmitter.current.emit('SET_PLAY_STATE', 'stop');
    eventEmitter.current.emit('SELECT_SCRIPT', null);

    return () => {
      eventEmitter.current.removeAllListeners();
    }
  }, [eventEmitter]);

  // UI element tree helpers
  const addUIElement = (el: UIElement, parentId?: string) => {
    setUiState(prev => {
      const withId: UIElement = { ...(el as any), id: (el as any).id ?? cryptoRandomId() };
      const clone = (arr: UIElement[]): UIElement[] => arr.map(e => ({ ...(e as any), children: (e as any).children ? clone((e as any).children) : undefined }) as any);
      let elements = clone(prev.elements);
      if (!parentId) {
        elements.push(withId);
      } else {
        const attach = (arr: UIElement[]): boolean => {
          for (let i = 0; i < arr.length; i++) {
            const item = arr[i] as any;
            if (item.id === parentId && item.type === 'container') {
              item.children = [...(item.children || []), withId];
              return true;
            }
            if (item.children && attach(item.children)) return true;
          }
          return false;
        };
        if (!attach(elements)) elements.push(withId);
      }
      eventEmitter.current.emit('UI_CHANGED');
      return { ...prev, elements };
    });
  };

  const updateUIElement = (el: UIElement) => {
    setUiState(prev => {
      const replace = (arr: UIElement[]): UIElement[] => arr.map(item => {
        if (item.id === el.id) return { ...item, ...el } as UIElement;
        const anyItem = item as any;
        if (anyItem.children) return { ...anyItem, children: replace(anyItem.children) } as UIElement;
        return item;
      });
      const elements = replace(prev.elements);
      eventEmitter.current.emit('UI_CHANGED');
      return { ...prev, elements };
    });
  };

  const removeUIElement = (id: string) => {
    setUiState(prev => {
      const prune = (arr: UIElement[]): UIElement[] => arr
        .filter(item => item.id !== id)
        .map(item => {
          const anyItem = item as any;
          if (anyItem.children) return { ...anyItem, children: prune(anyItem.children) } as UIElement;
          return item;
        });
      const elements = prune(prev.elements);
      eventEmitter.current.emit('UI_CHANGED');
      return { ...prev, elements };
    });
  };

  // --- Play lifecycle (builds the play scene, drives the UI runtime) ---------------------------
  // The scene the play session started on (what Reset returns to) and the one currently running, plus
  // the running scene's UI elements — a runtime Game.loadScene switch updates the latter two.
  const playEntrySceneIdRef = useRef<string>('');
  const currentPlaySceneIdRef = useRef<string>('');
  const playSceneUiRef = useRef<any[]>([]);

  const buildPlayScene = async (): Promise<Scene> => {
    // useCache: true — textures already live in TextureManager for in-editor play, so skip re-embedding.
    const json = await buildGameData({
      scene: editorSceneRef.current,
      scripts: scriptsRef.current,
      scriptAssets: scriptAssetsRef.current,
      bodies: bodiesRef.current,
      triggers: triggersRef.current,
      ui: uiStateRef.current,
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
  const buildPlaySceneById = async (id: string): Promise<{ scene: Scene; ui: any[] }> => {
    if (id === playEntrySceneIdRef.current) return { scene: await buildPlayScene(), ui: uiStateRef.current.elements };
    const data = await loadSceneData(id);
    if (!data) return { scene: new Scene(), ui: [] };
    const clone = JSON.parse(JSON.stringify({ scene: data.scene, ui: data.ui }));
    const maps = { scripts: new Map<string, string>(), bodies: new Map<string, any>(), triggers: new Map<string, any>() };
    extractNodeState(clone.scene, maps);
    const tmp = new Scene();
    tmp.parse({ scene: clone.scene, textures: [] }, true);
    resyncScene(tmp, maps, currentLibs(), data.assetHashes, data.assetHashVersion);
    const gd = await buildGameData({ scene: tmp, scripts: maps.scripts, bodies: maps.bodies, triggers: maps.triggers, ui: clone.ui ?? { version: 1, elements: [] }, scriptAssets: scriptAssetsRef.current, templates: templatesRef.current, materials: materialsRef.current, useCache: true });
    const scene = new Scene();
    registerTemplates(gd.templates);
    scene.parse(gd, true); // gd injects scripts into nodes → compiled here
    return { scene, ui: gd.ui?.elements ?? [] };
  };

  const startUIRuntime = () => {
    UIRuntime.start(playSceneUiRef.current, {
      emit: (n) => eventEmitter.current.emit(n),
      getScene: () => instanceRef.current?.scene,
      game,
    });
  };

  // Runtime scene switch (Game.loadScene from a script). Swaps the engine's scene, resetting UI/physics/
  // input for the new scene — the editor-play counterpart of the player's loadScene.
  const playLoadScene = async (nameOrId: string): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance || !startedRef.current) return;
    const meta = projectMetaRef.current;
    const target = meta?.scenes.find(s => s.id === nameOrId) ?? meta?.scenes.find(s => s.name === nameOrId);
    if (!target) { Logger.warn(`loadScene: no scene "${nameOrId}"`, 'Editor'); return; }
    const { scene, ui } = await buildPlaySceneById(target.id);
    UIRuntime.stop();
    instance.input.clear();
    instance.physics.clear();
    instance.setScene(scene);
    currentPlaySceneIdRef.current = target.id;
    playSceneUiRef.current = ui;
    instance.isPaused = false;
    setTimeout(() => { instance.scene.start(); startUIRuntime(); }, 50);
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
   * Refresh every animation state's embedded Animation Field from the library.
   *
   * A state stores a COPY of the field, written when the machine was applied — that is what lets a field
   * ride through scene saves and publishing with no extra plumbing. The cost is that the copy can fall
   * behind the asset: edit a field after applying the machine, or open a scene/template saved before the
   * last field edit, and the node still plays the old blend. The field editor previews the LIVE field, so
   * the symptom is a blend that looks right while authoring and wrong in Play.
   *
   * Doing this at play start covers every route in one place — the open scene, template instances, whatever
   * — instead of chasing each one. withoutDirty because refreshing from the library is not the user's edit.
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

    // Play always runs the game scene, from wherever the user happens to be. Asset editors are documents
    // open beside the game, not places you leave to test it — so pressing Play from a material tab takes
    // you to the scene, and Stop brings you back to the material.
    //
    // It cannot be done in one pass. Both this and the tab-activate effect call instance.setScene, and
    // passive effects are scheduled rather than flushed at a microtask boundary — so the activate effect's
    // editor scene could legally land AFTER the play scene built below the await, wiping the running game.
    // Committing the switch first and re-entering from an effect makes the order explicit.
    if (activeTabIdRef.current !== SCENE_TAB_ID || mainModeRef.current !== 'scene') {
      playReturnRef.current = { tabId: activeTabIdRef.current, mainMode: mainModeRef.current };
      const leaving = tabsRef.current.find(t => t.id === activeTabIdRef.current);
      // Play reads the open scene and the asset LIBRARIES, never a tab's edit session — so unsaved work in
      // the tab being left is genuinely not in the build. Say so instead of silently saving it: saving here
      // would rebuild every placed instance of a template, or rewrite every material in every live scene.
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
    playSceneUiRef.current = uiStateRef.current.elements;
    const newScene = await buildPlayScene();
    instance.setScene(newScene);
    instance.isPaused = false;
    installGameHost();
    // Rebuild runtime debug helpers AFTER scene.start() — the reconcile the isPlayMode flip triggers runs
    // before start(), which resets the scene and drops those just-added nodes. Emitting here mirrors the
    // live-toggle path, so Runtime toggles are honoured from the first frame of Play.
    setTimeout(() => { instance.scene.start(); startUIRuntime(); eventEmitter.current.emit('DEBUG_VISIBILITY_CHANGED'); }, 100);
    eventEmitter.current.emit('SET_PLAY_STATE', 'play');
    startedRef.current = true;
  };
  const stopPlay = () => {
    startedRef.current = false;
    const instance = instanceRef.current;
    UIRuntime.stop();
    setGameHost(null);
    if (!instance) return;
    instance.setScene(editorSceneRef.current);
    instance.input.clear();
    instance.physics.clear();
    showBindPoseForSkinnedModels(editorSceneRef.current); // back to the default pose in the editor
    eventEmitter.current.emit('SET_PLAY_STATE', 'stop');
  };
  const pausePlay = () => eventEmitter.current.emit('SET_PLAY_STATE', 'pause');
  const resetPlay = async () => {
    const instance = instanceRef.current;
    if (!instance) return;
    UIRuntime.stop();
    // Clear input/physics so key bindings and bodies from the previous run don't stack.
    instance.input.clear();
    instance.physics.clear();
    // Reset returns to the play-session entry scene (where Play was pressed), not the last-loaded one.
    currentPlaySceneIdRef.current = playEntrySceneIdRef.current;
    const newScene = await buildPlayScene();
    playSceneUiRef.current = uiStateRef.current.elements;
    instance.setScene(newScene);
    instance.isPaused = false;
    // Reconcile runtime debug helpers after start() (see startPlay) — reset stays in play mode, so the
    // isPlayMode effect won't re-fire on its own.
    setTimeout(() => { instance.scene.start(); startUIRuntime(); eventEmitter.current.emit('DEBUG_VISIBILITY_CHANGED'); }, 50);
    startedRef.current = true;
    eventEmitter.current.emit('SET_PLAY_STATE', 'play');
  };
  const game: GameActions = { reset: () => { resetPlay(); }, exit: () => { stopPlay(); }, pause: () => { pausePlay(); } };

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
    addTileset, removeTileset, updateTileset,
  });
  const assetLibraryValue = useMemo<AssetLibraryContextValue>(() => ({
    templates, materials, terrainMaterials, models, scriptAssets, animationFields, tilesets, assetsLoaded, ...libraryActions,
  }), [templates, materials, terrainMaterials, models, scriptAssets, animationFields, tilesets, assetsLoaded, libraryActions]);

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
  // dimension uses — so after a switch (or after opening a scene of the other kind) the current mode can
  // name a tool with no button and no scene to act on. Snap back to plain scene editing rather than
  // leaving the user in a mode whose panels are hidden and whose brush can never hit anything.
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
    enterAnimationEditor, commitAnimationStateMachine, registerAnimationApply,
    importAnimationFiles, importSkeletonNames, commitIkRig, currentIkRig, renameAnimationClip, removeAnimationClip, resolveAnimationImport,
    enterModelEditor, setActiveModelName, addModelLodFromAsset, removeModelLod,
    setModelLodDistance, setModelCullDistance, setActiveModelLevel, importModelFiles, resolveModelImport,
    enterScriptEditor, setScriptTabSource, getScriptTabSource, saveScriptSource,
    scriptAssetOf, createScriptForNode, attachScriptToNode, detachScriptFromNode,
    enterAnimationFieldEditor, createAnimationFieldForModel, saveAnimationField,
  });
  const editorSessionsValue = useMemo<EditorSessionsContextValue>(() => ({
    editingTemplateName, templateRootId,
    editingMaterialName,
    editingTerrainMaterialName, editingTerrainMaterialNode,
    animationTargetId, animationSourceId, animationSourceScene, pendingAnimationImport,
    editingAnimationFieldId, animationFieldTargetId,
    modelSession: activeTab.kind === 'model' ? (modelSessions[activeTab.id] ?? null) : null,
    modelEditTargetId: activeTab.kind === 'model' && modelSessions[activeTab.id]
      ? modelSessions[activeTab.id].levelIds[modelSessions[activeTab.id].activeLevel] ?? null
      : null,
    pendingModelImport,
    ...sessionActions,
  }), [
    editingTemplateName, templateRootId, editingMaterialName,
    editingTerrainMaterialName, editingTerrainMaterialNode,
    animationTargetId, animationSourceId, animationSourceScene, pendingAnimationImport,
    editingAnimationFieldId, animationFieldTargetId,
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
      ui: uiState,
      setUI: setUiState,
      addUIElement,
      updateUIElement,
      removeUIElement,
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
      animationFields,
      addAnimationField,
      removeAnimationField,
      updateAnimationField,
      enterAnimationFieldEditor,
      createAnimationFieldForModel,
      editingAnimationFieldId,
      animationFieldTargetId,
      saveAnimationField,
      tilesets,
      addTileset,
      removeTileset,
      updateTileset,
      enterTilesetEditor,
      createTilesetFromImage,
      editingTilesetId,
      saveTileset,
      enterScriptEditor,
      setScriptTabSource,
      getScriptTabSource,
      models,
      addModel,
      removeModel,
      updateModel,
      enterModelEditor,
      modelSession: activeTab.kind === 'model' ? (modelSessions[activeTab.id] ?? null) : null,
      modelEditTargetId: activeTab.kind === 'model' && modelSessions[activeTab.id]
        ? modelSessions[activeTab.id].levelIds[modelSessions[activeTab.id].activeLevel] ?? null
        : null,
      setActiveModelName,
      addModelLodFromAsset,
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