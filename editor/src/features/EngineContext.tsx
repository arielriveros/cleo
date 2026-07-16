import { createContext, useContext, useState, useRef, useEffect } from "react";
import { CleoEngine, Scene, InputManager, Model, Geometry, Material, CustomMaterial, TerrainMaterial, Terrain, Node, ModelNode, CameraNode, AnimatedModel, TextureManager, Logger, Loader, remapAnimationToSkin, setGameHost } from "cleo";
import type { AnimationCompatibility, HullQuality } from "cleo";
import NullImage from '../images/null.png';
import LightIcon from '../icons/light.png';
import EventEmitter from "events";
import { createEmptyScene, ensureEditorCamera } from './demoScene/createEmptyScene';
import { createMaterialPreviewScene } from './demoScene/createMaterialPreviewScene';
import { createAnimationEditorScene } from './demoScene/createAnimationEditorScene';
import { applyPreviewEnvironment } from './demoScene/previewEnvironment';
import { parseByType, regenerateIds, stripDebug } from "../utils/nodeSubtree";
import { UIElement, UIState, cryptoRandomId } from "../utils/UIModel";
import { UIRuntime, GameActions } from "./uiInspector/uiRuntime";
import { Template, buildTemplateFromNode, instantiateTemplate, TEMPLATE_ID_VAR } from "../utils/templates";
import { MaterialAsset, buildMaterialAsset, applyMaterialAsset, getMaterialIdOf, getNodeMaterial, unlinkToFallback } from "../utils/materials";
import { getScreenMaterialIds, applyScreenMaterials } from "../utils/screenMaterials";
import { TerrainMaterialAsset, buildTerrainMaterialAsset, parseTerrainMaterialAsset, applyTerrainMaterialToLayer, collectTerrainMaterialTextureIds } from "../utils/terrainMaterials";
import { buildFoliageRuleFromMeshAsset } from "../utils/foliageRules";
import { MeshAsset, MeshLodDef, MESH_ID_VAR, buildMeshAsset, instantiateMeshAsset, separateSubMeshes, nodeJsonHasSkinnedModel } from "../utils/meshes";
import { ScriptAsset, ScriptBaseType, SCRIPT_ID_VAR, buildScriptAsset, applyScriptAsset, unlinkScript, getScriptIdOf, defaultScriptClass, seedScriptFields } from "../utils/scripts";
import { groupImportFiles } from "../utils/importGrouping";
import {
  normalizeRootScale, meshBoundsRadius, combineBounds, awaitSubtreeTexturesReady, captureMaterialSphere,
  renderMeshAssetThumbnail, renderMaterialAssetThumbnail, renderTerrainMaterialAssetThumbnail,
} from "../utils/meshThumbnails";
import { parseBundleToRoot } from "../utils/meshImport";
import { detectMissingTextures } from "../utils/textureRefs";

// A mesh awaiting user review in the import modal (parsed but not yet committed to the library).
export type PendingMeshImportView = {
  bundleName: string;
  subMeshCount: number;
  materialCount: number;
  missing: string[];      // referenced texture basenames not present in the upload
  sizeRadius: number;     // combined bounding radius at scale 1 (diameter = 2*radius)
};
// The user's decision from the import modal.
export type MeshImportDecision = {
  extraFiles: File[];     // textures uploaded to fill missing references (aliased to expected names)
  normalize: boolean;
  targetSize: number;     // desired bounding diameter in world units
  /** Split the file's sub-meshes into one MeshAsset each, instead of a single asset for the whole file. */
  separate: boolean;
};

// ---- Import progress -------------------------------------------------------------------------------
// Every step importMeshFiles walks a bundle through, in order. These map onto the shared progress store's
// generic steps (features/progress) — the stage a bundle is in IS what the user is told, so the window
// cannot drift from what the importer is actually doing.
type ImportStage =
  | 'queued'       // not started
  | 'parsing'      // Loader: assimp/GLTF parse of the model files
  | 'review'       // parked on the user in MeshImportModal (indefinite — the bar deliberately stalls)
  | 'reparsing'    // user supplied missing textures; parse again so they wire into the materials
  | 'scaling'      // normalizeRootScale bakes the fit-to-size factor into the vertices
  | 'textures'     // waiting on async image decode before anything can be serialized
  | 'materials'    // registering a MaterialAsset per unique material
  | 'saving'       // buildMeshAsset: serialize the subtree(s) into the mesh library
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
// Animation clips parsed from a file, each with a compatibility report vs the target skeleton,
// awaiting user review in the animation-import modal.
export type PendingAnimationImportView = {
  fileName: string;
  clips: { name: string; report: AnimationCompatibility }[];
};
// The user's decision from the animation-import modal: which clips to add (by index).
export type AnimationImportDecision = { include: boolean[] };
import { buildGameData } from "./publish/buildGameData";
import { applyGameData, extractNodeState, ProjectPrefs } from "../utils/projectStorage";
import {
  ProjectMeta, SceneMeta, SceneRefs, loadProjectMeta, saveProjectMeta, loadSceneData, saveSceneData,
  deleteSceneData, migrateLegacyProject, createFreshProjectMeta,
} from "../utils/sceneStorage";
import { resyncScene } from "../utils/sceneResync";
import { buildAssetHashes, AssetLibs } from "../utils/assetHash";
import {
  collectReferencedMaterialIds, collectReferencedMeshIds, collectReferencedTemplateIds,
  collectReferencedTerrainMaterialIds, collectReferencedTextureIds, collectReferencedScriptIds,
} from "../utils/references";
import { idbGet, idbSet } from "../utils/idb";
import { preloadTextures, persistTextures, adoptLegacyTextures, referencedTextureIds, legacyTexturesOf } from "../utils/textureStore";
import { saveToStorage } from "../workers/workerClient";
import { startTask, StepStatus } from "./progress/progressStore";
import { reconcileEditorHelpers } from "../utils/editorHelpers";

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

export type EditorMode = 'scene' | 'landscape' | 'template' | 'renderer' | 'material' | 'terrainMaterial' | 'animation' | 'mesh' | 'script';
export type GizmoMode = 'position' | 'rotation' | 'scale';
export type SavingState = 'idle' | 'saving' | 'saved' | 'error';

// Browser-style editor tabs. The 'main' tab hosts the real game scene and its scene/landscape/
// renderer sub-mode; template and material tabs each own a live edit session (a throwaway Scene in
// tabRuntimeRef). `editorMode` is derived from the active tab (see EngineProvider).
//
// A 'mesh' tab is an edit session for an imported mesh asset: one subtree per LOD level in a throwaway
// scene (materials/transforms/sub-meshes edited via the normal Scene + Properties panels, LOD/cull via
// the Mesh inspector), saved back to the library with Save Mesh and propagated to placed copies.
// Opening one also renders the asset's thumbnail (imports don't — that used to stall the main thread).
// A 'script' tab is a dedicated code editor for a Script asset (no 3D scene): the full-panel editor renders
// over the viewport, with a Save Script action. Its working source buffers per-tab until saved.
export type TabKind = 'main' | 'template' | 'material' | 'terrainMaterial' | 'animation' | 'mesh' | 'script';

// Reactive per-mesh-tab edit state (the tab's Scene itself lives in tabRuntimeRef). levelIds[i] is the
// node id of LOD level i's root inside the tab scene; distances[i] is the camera distance where level i
// takes over (distances[0] is always 0).
export type MeshEditSession = {
  levelIds: string[];
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
  meshId?: string | null; // mesh tabs: the previewed mesh asset id
  scriptId?: string | null; // script tabs: the edited script asset id
}
export type TerrainTool = 'raise' | 'lower' | 'smooth' | 'flatten';
export type TerrainBrushMode = 'sculpt' | 'paint' | 'foliage' | 'move';
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
  saveActiveTemplate: () => void;
  saveActiveMaterial: () => void;
  saveActiveTerrainMaterial: () => void;
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
  /** Open a script asset in its dedicated Script editor tab (creates a new 'node' script when no id is given). */
  enterScriptEditor: (scriptId?: string) => void;
  /** Save the active Script tab's buffered source to its asset and clear the tab's dirty flag. */
  saveActiveScript: () => void;
  /** Buffer a Script tab's working source and mark the tab dirty (called by the tab editor on each edit). */
  setScriptTabSource: (tabId: string, scriptId: string, source: string) => void;
  /** The buffered working source for a script tab, or undefined. */
  getScriptTabSource: (scriptId: string) => string | undefined;
  // Mesh assets (imported models)
  meshes: MeshAsset[];
  addMesh: (m: MeshAsset) => void;
  removeMesh: (id: string) => void;
  updateMesh: (id: string, m: MeshAsset) => void;
  /** Open (or focus) a mesh asset's edit tab, rendering its thumbnail on the way in. */
  enterMeshEditor: (meshId?: string) => void;
  // Mesh editor (active mesh tab): LOD/cull authoring + save-and-propagate
  saveActiveMesh: () => void;
  meshSession: MeshEditSession | null;
  /** Node id of the active LOD level's root in the mesh tab scene (viewport drop parent), or null. */
  meshEditTargetId: string | null;
  setActiveMeshName: (name: string) => void;
  addMeshLodFromFiles: (files: File[]) => Promise<void>;
  removeMeshLod: (level: number) => void;
  setMeshLodDistance: (level: number, distance: number) => void;
  setMeshCullDistance: (distance: number) => void;
  setActiveMeshLevel: (level: number) => void;
  importMeshFiles: (files: File[]) => Promise<void>;
  // True once every IndexedDB-backed asset library has finished its initial read.
  assetsLoaded: boolean;
  // Mesh import review modal
  pendingMeshImport: PendingMeshImportView | null;
  resolveMeshImport: (decision: MeshImportDecision | null) => void;
  // Live model-import progress (null when there is no run and nothing left to report)
  // Animation import (into the Animation Editor's model)
  importAnimationFiles: (files: File[]) => Promise<void>;
  importSkeletonNames: (files: File[]) => Promise<void>;
  renameAnimationClip: (oldName: string, newName: string) => string;
  removeAnimationClip: (name: string) => void;
  pendingAnimationImport: PendingAnimationImportView | null;
  resolveAnimationImport: (decision: AnimationImportDecision | null) => void;
  // Project persistence
  saveProject: () => void;
  savingState: SavingState;
  replaceProjectMeta: (meta: ProjectMeta) => Promise<void>;
  // Multi-scene project
  sceneList: SceneMeta[];
  mainSceneId: string;
  openSceneId: string;
  mainDirty: boolean;
  /** Open a scene asset in the Main tab (prompts Save/Discard/Cancel when the current scene is dirty). */
  openScene: (sceneId: string) => Promise<boolean>;
  createScene: (name?: string) => Promise<string>;
  renameScene: (sceneId: string, name: string) => void;
  /** Returns null on success, or a human-readable reason the scene cannot be deleted. */
  deleteScene: (sceneId: string) => Promise<string | null>;
  duplicateScene: (sceneId: string) => Promise<string | null>;
  setMainScene: (sceneId: string) => void;
  // Unsaved-scene confirm dialog (promise parked by openScene, resolved by UnsavedSceneModal)
  pendingSceneConfirm: { sceneName: string } | null;
  resolveSceneConfirm: (decision: 'save' | 'discard' | 'cancel') => void;
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
    tabs: [{ id: 'main', kind: 'main', title: 'Main' }],
    activeTabId: 'main',
    activeTab: { id: 'main', kind: 'main', title: 'Main' },
    dirtyTabs: {},
    setActiveTab: () => {},
    closeTab: () => {},
    reorderTabs: () => {},
    saveActiveTemplate: () => {},
    saveActiveMaterial: () => {},
    saveActiveTerrainMaterial: () => {},
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
    enterScriptEditor: () => {},
    saveActiveScript: () => {},
    setScriptTabSource: () => {},
    getScriptTabSource: () => undefined,
    meshes: [],
    addMesh: () => {},
    removeMesh: () => {},
    updateMesh: () => {},
    enterMeshEditor: () => {},
    saveActiveMesh: () => {},
    meshSession: null,
    meshEditTargetId: null,
    setActiveMeshName: () => {},
    addMeshLodFromFiles: async () => {},
    removeMeshLod: () => {},
    setMeshLodDistance: () => {},
    setMeshCullDistance: () => {},
    setActiveMeshLevel: () => {},
    importMeshFiles: async () => {},
    assetsLoaded: false,
    pendingMeshImport: null,
    resolveMeshImport: () => {},
    importAnimationFiles: async () => {},
    importSkeletonNames: async () => {},
    renameAnimationClip: (o) => o,
    removeAnimationClip: () => {},
    pendingAnimationImport: null,
    resolveAnimationImport: () => {},
    saveProject: () => {},
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
    pendingSceneConfirm: null,
    resolveSceneConfirm: () => {},
  });
  
  // Create a custom hook to access the engine and scene from anywhere
export const useCleoEngine = () => {
    return useContext(EngineContext);
};

export function EngineProvider(props: { children: React.ReactNode }) {
  const instanceRef = useRef<CleoEngine | null>(null);
  const editorSceneRef = useRef<Scene>(new Scene());
  const eventEmitter = useRef(new EventEmitter());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [isGizmoDragging, setIsGizmoDragging] = useState(false);
  const [isPlayMode, setIsPlayMode] = useState(false);
  const [isSceneReady, setIsSceneReady] = useState(false);
  // The Main tab's sub-mode (scene/landscape/renderer). `editorMode` exposed to consumers is derived
  // from the active tab — 'template' when a template tab is active, else this.
  const [mainMode, setMainMode] = useState<'scene' | 'landscape' | 'renderer'>('scene');
  // Active transform-gizmo mode (move/rotate/scale), driven by the viewport toggle.
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('position');
  // Editor tabs: the Main tab (real game scene) plus any open template tabs. Each template tab's live
  // scene + root live in tabRuntimeRef (not React state — Scene objects shouldn't be serialized).
  const [tabs, setTabs] = useState<EditorTab[]>([{ id: 'main', kind: 'main', title: 'Main' }]);
  const [activeTabId, setActiveTabId] = useState<string>('main');
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({}); // tab id -> has unsaved edits
  // Per-tab runtime scene + root. Animation tabs also record where the SOURCE node lives (its scene may
  // be the main scene OR a template tab's scene) so authored state machines are written back correctly.
  const tabRuntimeRef = useRef<Map<string, { scene: Scene; rootId: string; sourceScene?: Scene; sourceNodeId?: string; sourceTabId?: string; tm?: TerrainMaterial; helperTerrain?: Terrain; editNode?: ModelNode }>>(new Map());
  const activeTabIdRef = useRef<string>('main');
  const activeTabKindRef = useRef<TabKind>('main');
  const dirtyArmedRef = useRef(false); // suppress false-dirty from the helper reconciler right after open
  const [savingState, setSavingState] = useState<SavingState>('idle');
  const dimensionRef = useRef<'2D' | '3D'>('3D'); // the Main tab's dimension (template tabs are always 3D)
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
  // Unsaved-changes tracking for the Main (game) scene — the per-tab dirtyTabs mechanism only covers
  // library tabs. Ref mirror lets async flows (openScene) read the current value without a re-render.
  const [mainDirty, setMainDirty] = useState(false);
  const mainDirtyRef = useRef(false);
  useEffect(() => { mainDirtyRef.current = mainDirty; }, [mainDirty]);
  const isPlayModeRef = useRef(false);
  useEffect(() => { isPlayModeRef.current = isPlayMode; }, [isPlayMode]);
  const terrainBrush = useRef<TerrainBrushState>({ mode: 'sculpt', tool: 'raise', radius: 10, strength: 8, falloff: 0.5, paintLayer: 0, foliageErase: false, activeLandscapeId: null });
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress>({ loaded: 0, total: 6, label: 'Starting…' });
  const isGizmoDraggingRef = useRef(false);
  const scriptsRef = useRef(new Map<string, string>());
  const bodiesRef = useRef(new Map<string, BodyDescription>());
  const triggersRef = useRef(new Map<string, { shapes: ShapeDescription[] }>());
  const [uiState, setUiState] = useState<UIState>({ version: 1, elements: [] });
  const uiStateRef = useRef(uiState);
  const startedRef = useRef(false);
  useEffect(() => { uiStateRef.current = uiState; }, [uiState]);

  // Reusable node templates, persisted to IndexedDB (they embed base64 textures and would blow the
  // ~5MB localStorage quota). Loaded asynchronously on mount, migrating any legacy localStorage copy once.
  const [templates, setTemplates] = useState<Template[]>([]);
  const templatesLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        let list = await idbGet<Template[]>('cleo_templates');
        if (!list) {
          const raw = localStorage.getItem('cleo_templates');
          if (raw) {
            list = JSON.parse(raw) as Template[];
            try { await idbSet('cleo_templates', list); localStorage.removeItem('cleo_templates'); } catch { /* keep legacy copy if migration write fails */ }
          }
        }
        // Don't clobber templates the user may have added before the async load resolved.
        if (list && list.length) setTemplates(prev => prev.length ? prev : list!);
      } catch (e) { console.warn('Failed to load templates:', e); }
      finally { templatesLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary('cleo_templates', templates, templatesLoadedRef);

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
        const list = await idbGet<MaterialAsset[]>('cleo_materials');
        if (list && list.length) setMaterials(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load materials:', e); }
      finally { materialsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary('cleo_materials', materials, materialsLoadedRef);

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
        const list = await idbGet<TerrainMaterialAsset[]>('cleo_terrain_materials');
        if (list && list.length) setTerrainMaterials(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load terrain materials:', e); }
      finally { terrainMaterialsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary('cleo_terrain_materials', terrainMaterials, terrainMaterialsLoadedRef);

  const addTerrainMaterial = (m: TerrainMaterialAsset) => setTerrainMaterials(prev => [...prev, m]);
  const updateTerrainMaterial = (id: string, m: TerrainMaterialAsset) => setTerrainMaterials(prev => prev.map(x => x.id === id ? m : x));

  // Reusable mesh assets (imported models): persisted to IndexedDB (they embed base64 textures + a
  // thumbnail). Mirrors the materials library above. Drag a mesh into the viewport to instantiate a copy.
  const [meshes, setMeshes] = useState<MeshAsset[]>([]);
  const meshesLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<MeshAsset[]>('cleo_meshes');
        if (list && list.length) setMeshes(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load meshes:', e); }
      finally { meshesLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary('cleo_meshes', meshes, meshesLoadedRef);

  // Reactive edit state for open mesh tabs (tab id -> session). The tab's Scene stays in tabRuntimeRef;
  // this holds what the Mesh inspector renders (LOD level ids/distances, cull distance, active level).
  const [meshSessions, setMeshSessions] = useState<Record<string, MeshEditSession>>({});

  const addMesh = (m: MeshAsset) => setMeshes(prev => [...prev, m]);
  const removeMesh = (id: string) => {
    // A preview tab for a deleted mesh would render a subtree whose asset no longer exists — close it
    // first (mirrors removeMaterial). Safe to reference the later-declared tab helpers: this only ever
    // runs from a click, long after the component body has evaluated.
    const openTab = tabs.find(t => t.kind === 'mesh' && t.meshId === id);
    if (openTab) removeTabById(openTab.id);
    setMeshes(prev => prev.filter(x => x.id !== id));
  };
  const updateMesh = (id: string, m: MeshAsset) => setMeshes(prev => prev.map(x => x.id === id ? m : x));

  // Reusable, class-based script assets (global library like materials): a node references one via the
  // SCRIPT_ID_VAR node variable. Persisted to IndexedDB. Editing the asset propagates to every linked node.
  const [scriptAssets, setScriptAssets] = useState<ScriptAsset[]>([]);
  const scriptAssetsLoadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const list = await idbGet<ScriptAsset[]>('cleo_scripts');
        if (list && list.length) setScriptAssets(prev => prev.length ? prev : list);
      } catch (e) { console.warn('Failed to load scripts:', e); }
      finally { scriptAssetsLoadedRef.current = true; }
    })();
  }, []);
  usePersistedLibrary('cleo_scripts', scriptAssets, scriptAssetsLoadedRef);

  // Mirror for async flows (play/save serialize scripts off-render): buildGameData reads the current list.
  const scriptAssetsRef = useRef<ScriptAsset[]>([]);
  useEffect(() => { scriptAssetsRef.current = scriptAssets; }, [scriptAssets]);

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
    const existing = scriptAssets.find(a => a.id === id);
    if (!existing) return;
    const next = buildScriptAsset(existing.name, existing.baseType, source, id);
    updateScriptAsset(id, next);
    const scene = editorSceneRef.current;
    for (const n of Array.from(scene.nodes)) {
      if (getScriptIdOf(n) !== id) continue;
      scriptsRef.current.set(n.id, source);
      seedScriptFields(n, next, false);
    }
    eventEmitter.current.emit('SCENE_CHANGED');
  };

  // Dedicated Script editor tab: opens a script asset in a full-panel code editor (its own mode + Save Script
  // button), mirroring the mesh/material tabs. Working source buffers per-tab (scriptTabSourceRef) until Save.
  const scriptTabSourceRef = useRef(new Map<string, string>());
  const enterScriptEditor = (scriptId?: string) => {
    let id = scriptId;
    if (!id) {
      // No id: mint a new 'node'-based script and open it.
      const asset = buildScriptAsset('New Script', 'node', defaultScriptClass('New Script', 'node'));
      addScriptAsset(asset);
      id = asset.id;
      scriptTabSourceRef.current.set(id, asset.source);
    }
    // Focus an already-open tab for this script instead of duplicating it.
    const existing = tabs.find(t => t.kind === 'script' && t.scriptId === id);
    if (existing) { setActiveTabId(existing.id); return; }
    const asset = scriptAssetsRef.current.find(a => a.id === id);
    const tabId = cryptoRandomId();
    scriptTabSourceRef.current.set(id, asset?.source ?? scriptTabSourceRef.current.get(id) ?? '');
    setTabs(prev => [...prev, { id: tabId, kind: 'script', title: asset?.name ?? 'Script', scriptId: id }]);
    setActiveTabId(tabId);
  };

  // Save the active script tab: commit its buffered source to the asset (persists + propagates to linked
  // nodes) and clear the tab's dirty flag. Mirrors saveActiveMaterial/saveActiveMesh.
  const saveActiveScript = () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'script' || !tab.scriptId) return;
    const source = scriptTabSourceRef.current.get(tab.scriptId);
    if (source !== undefined) saveScriptSource(tab.scriptId, source);
    // Adopt the (possibly renamed-in-source) class name into the tab title? Keep the asset name.
    setDirtyTabs(prev => ({ ...prev, [tab.id]: false }));
  };
  // Called by the script tab's editor on every edit: buffer the source and mark the tab dirty.
  const setScriptTabSource = (tabId: string, scriptId: string, source: string) => {
    scriptTabSourceRef.current.set(scriptId, source);
    setDirtyTabs(prev => (prev[tabId] ? prev : { ...prev, [tabId]: true }));
  };
  const getScriptTabSource = (scriptId: string): string | undefined => scriptTabSourceRef.current.get(scriptId);

  // True once all IndexedDB-backed libraries (and the project's scene list) have finished their initial
  // read. The asset explorer's path index must not prune entries before this — the arrays start empty,
  // and a pruning pass against an empty library would drop every folder assignment the user has made.
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  useEffect(() => {
    if (assetsLoaded) return;
    const timer = window.setInterval(() => {
      if (templatesLoadedRef.current && materialsLoadedRef.current && terrainMaterialsLoadedRef.current && meshesLoadedRef.current && scriptAssetsLoadedRef.current && scenesLoadedRef.current) {
        setAssetsLoaded(true);
        window.clearInterval(timer);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [assetsLoaded]);

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
          const legacy = legacyTexturesOf(materials, terrainMaterials, templates, meshes);
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
  }, [assetsLoaded, textureEpoch, materials, terrainMaterials, templates, meshes]);

  // Mesh import review modal: importMeshFiles parks each parsed mesh here and awaits the user's decision
  // (resolved by MeshImportModal via resolveMeshImport). The resolver lives in a ref so the promise in
  // importMeshFiles can be settled from the modal without re-rendering churn.
  const [pendingMeshImport, setPendingMeshImport] = useState<PendingMeshImportView | null>(null);
  const pendingResolverRef = useRef<((d: MeshImportDecision | null) => void) | null>(null);
  const resolveMeshImport = (decision: MeshImportDecision | null) => {
    const r = pendingResolverRef.current;
    pendingResolverRef.current = null;
    setPendingMeshImport(null);
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

  // Unsaved-scene confirm dialog — same "park then resolve a promise" pattern as the import modals.
  // openScene parks here when the current scene has unsaved edits; UnsavedSceneModal resolves.
  const [pendingSceneConfirm, setPendingSceneConfirm] = useState<{ sceneName: string } | null>(null);
  const sceneConfirmResolverRef = useRef<((d: 'save' | 'discard' | 'cancel') => void) | null>(null);
  const confirmUnsavedScene = (sceneName: string): Promise<'save' | 'discard' | 'cancel'> =>
    new Promise(resolve => {
      sceneConfirmResolverRef.current = resolve;
      setPendingSceneConfirm({ sceneName });
    });
  const resolveSceneConfirm = (decision: 'save' | 'discard' | 'cancel') => {
    const r = sceneConfirmResolverRef.current;
    sceneConfirmResolverRef.current = null;
    setPendingSceneConfirm(null);
    if (r) r(decision);
  };

  // Derive the active tab and everything that used to hang off `editorMode === 'template'`.
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
  const activeRuntime = activeTab.kind !== 'main' ? tabRuntimeRef.current.get(activeTab.id) : undefined;
  // The scene the inspectors/gizmo/AddNew currently edit: the game scene (Main tab) or a template/material/animation scene.
  const activeScene = activeRuntime ? activeRuntime.scene : editorSceneRef.current;
  // Legacy single mode value, now derived from the active tab kind. Keeps every existing
  // `editorMode === ...` consumer working unchanged.
  const editorMode: EditorMode = activeTab.kind === 'main' ? mainMode
    : activeTab.kind === 'material' ? 'material'
    : activeTab.kind === 'terrainMaterial' ? 'terrainMaterial'
    : activeTab.kind === 'animation' ? 'animation'
    : activeTab.kind === 'mesh' ? 'mesh'
    : activeTab.kind === 'script' ? 'script'
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

  const engineMaps = () => ({ scripts: scriptsRef.current, bodies: bodiesRef.current, triggers: triggersRef.current });
  // Snapshot of the four hashable asset libraries, as the resync/hash utilities consume them.
  const currentLibs = (): AssetLibs => ({ materials, meshes, templates, terrainMaterials, scripts: scriptAssets });

  // Open (or focus) a template editor tab. Each template tab owns its own throwaway edit scene.
  const enterTemplateEditor = (templateId?: string) => {
    const instance = instanceRef.current;
    if (!instance) return;

    // Focus an already-open tab for this template instead of duplicating it.
    if (templateId) {
      const existing = tabs.find(t => t.kind === 'template' && t.templateId === templateId);
      if (existing) { setActiveTabId(existing.id); return; }
    }

    const scene = new Scene();
    scene.animationsEnabled = false; // editing scene: skinned meshes hold bind pose (no playback)
    createEmptyScene(scene); // editor camera + a light so the template content is lit
    // Same cubemap background + reflections as the other editor tabs. The '__editor__' skybox node sits
    // at the scene root, outside the template subtree, so Save Template never serializes it.
    void applyPreviewEnvironment(scene);

    let rootId: string;
    let name: string;
    if (templateId) {
      const t = templates.find(x => x.id === templateId);
      if (!t) { Logger.error('Template not found', 'Editor'); return; }
      rootId = instantiateTemplate(t, scene.root, engineMaps());
      name = t.name;
    } else {
      const node = new Node('New Template');
      scene.addNode(node);
      rootId = node.id;
      name = 'New Template';
    }
    scene.start();

    const tabId = cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId });
    setTabs(prev => [...prev, { id: tabId, kind: 'template', title: name, templateId: templateId ?? null }]);
    setActiveTabId(tabId); // the activate effect swaps the engine scene + dimension + selection
  };

  const collectSubtreeIds = (node: Node, out: string[] = []): string[] => {
    out.push(node.id);
    node.children.forEach((c: Node) => collectSubtreeIds(c, out));
    return out;
  };

  // Rebuild every placed instance of a template after it was edited, preserving each instance's own
  // transform. Runs on the game scene (editorSceneRef.current), never the template scene.
  const syncTemplateInstances = (templateId: string, template: Template) => {
    const scene = editorSceneRef.current;
    const maps = engineMaps();
    const instances = Array.from(scene.nodes).filter(n => n.getVariable(TEMPLATE_ID_VAR) === templateId);
    let reselectId: string | null = null;
    for (const inst of instances) {
      const parent = inst.parent;
      if (!parent) continue;
      const pos = Array.from(inst.position) as [number, number, number];
      const rot = Array.from(inst.rotation) as [number, number, number];
      const scl = Array.from(inst.scale) as [number, number, number];
      const wasSelected = inst.id === selectedNode;
      // Drop the old subtree's out-of-band data so map entries don't leak.
      for (const id of collectSubtreeIds(inst)) { maps.scripts.delete(id); maps.bodies.delete(id); maps.triggers.delete(id); }
      // Detach synchronously: Node.remove() only marks for removal, and the deferred sweep calls
      // root.removeChild on each marked descendant, which mis-splices and deletes unrelated root
      // children (including the node we're about to re-instantiate). removeChild cleanly drops the subtree.
      parent.removeChild(inst);
      const newId = instantiateTemplate(template, parent, maps); // re-tags __templateId
      const newNode = scene.getNodeById(newId);
      if (newNode) newNode.setPosition(pos).setRotation(rot).setScale(scl);
      if (wasSelected) reselectId = newId;
    }
    if (instances.length) {
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
      if (reselectId) eventEmitter.current.emit('SELECT_NODE', reselectId);
    }
  };

  // Public mode switch — only the Main tab's sub-mode (scene/landscape/renderer). Template/material/
  // animation editing are tabs now (opened via enter*Editor), not modes, so they aren't accepted here.
  const setEditorMode = (mode: EditorMode) => {
    if (mode === 'scene' || mode === 'landscape' || mode === 'renderer') setMainMode(mode);
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
    if (existing) { setActiveTabId(existing.id); return; }

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
    if (rt.sourceTabId && rt.sourceTabId !== 'main') setDirtyTabs(prev => ({ ...prev, [rt.sourceTabId!]: true }));
  };

  // Import animation clips from a file (gltf/glb/fbx) into the model being edited in the Animation
  // Editor. Parses the file, remaps each clip onto the target skeleton by bone name + computes a
  // compatibility report, shows the review modal, then adds the accepted clips to BOTH the preview
  // clone (so the transport/state-machine see them) and the source node (so they persist on save).
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

    const results = parsed.animations.map(clip => remapAnimationToSkin(clip, parsed.skin, targetSkin));
    const fileName = files.find(f => /\.(gltf|glb|fbx)$/i.test(f.name))?.name ?? files[0]?.name ?? 'animation';

    const decision = await new Promise<AnimationImportDecision | null>(resolve => {
      pendingAnimResolverRef.current = resolve;
      setPendingAnimationImport({ fileName, clips: results.map(r => ({ name: r.report.clipName, report: r.report })) });
    });
    if (!decision) { Logger.info('Animation import cancelled', 'Editor'); return; }

    const src = rt?.sourceScene && rt.sourceNodeId ? rt.sourceScene.getNodeById(rt.sourceNodeId) : null;
    let added = 0;
    results.forEach((r, i) => {
      if (!decision.include[i]) return;
      cloneModel.addAnimation(r.remapped);                                        // preview clone
      if (src instanceof ModelNode && src.model instanceof AnimatedModel) src.model.addAnimation(r.remapped); // persist
      added++;
    });
    if (added > 0) {
      if (rt?.sourceTabId && rt.sourceTabId !== 'main') setDirtyTabs(prev => ({ ...prev, [rt.sourceTabId!]: true }));
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
    if (rt?.sourceTabId && rt.sourceTabId !== 'main') setDirtyTabs(prev => ({ ...prev, [rt.sourceTabId!]: true }));
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
    Logger.info(`Added bone names to ${matched} joints — animation import now matches by name. Save the project to keep them.`, 'Editor');
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
    if (rt?.sourceTabId && rt.sourceTabId !== 'main') setDirtyTabs(prev => ({ ...prev, [rt.sourceTabId!]: true }));
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
    if (rt?.sourceTabId && rt.sourceTabId !== 'main') setDirtyTabs(prev => ({ ...prev, [rt.sourceTabId!]: true }));
    eventEmitter.current.emit('ANIM_CLIPS_CHANGED');
  };

  const setActiveTab = (id: string) => setActiveTabId(id);

  // Save the active template tab back to the library and propagate the change to placed instances.
  const saveActiveTemplate = async () => {
    const tab = tabs.find(t => t.id === activeTabId);
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
        syncTemplateInstances(tab.templateId, updated); // propagate to placed instances
      } else {
        addTemplate(t); // t carries a fresh id
      }
      // Adopt the saved name/id so later saves update (not re-add) and the tab label stays in sync.
      setTabs(prev => prev.map(x => x.id === tab.id ? { ...x, title: t.name, templateId: tab.templateId ?? t.id } : x));
      setDirtyTabs(prev => ({ ...prev, [tab.id]: false }));
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
    if (id === 'main') return;
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const remaining = tabs.filter(t => t.id !== id);
    tabRuntimeRef.current.get(id)?.helperTerrain?.dispose(); // free the preview terrain's splat/body
    tabRuntimeRef.current.delete(id);
    setMeshSessions(prev => { if (!(id in prev)) return prev; const next = { ...prev }; delete next[id]; return next; });
    setDirtyTabs(prev => { const next = { ...prev }; delete next[id]; return next; });
    setTabs(remaining);
    if (id === activeTabId) {
      const fallback = remaining[Math.max(0, idx - 1)] ?? remaining[0];
      setActiveTabId(fallback ? fallback.id : 'main');
    }
  };

  const closeTab = (id: string) => {
    if (id === 'main') return;
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    if (dirtyTabs[id] && !window.confirm(`Discard unsaved changes to "${tab.title}"?`)) return;
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

  // Re-apply a saved/edited material to every node in the game scene that references it (keeps the link).
  const syncMaterialInstances = (materialId: string, asset: MaterialAsset) => {
    const scene = editorSceneRef.current;
    const instances = Array.from(scene.nodes).filter(n => getMaterialIdOf(n) === materialId);
    for (const inst of instances) applyMaterialAsset(inst, asset);
    // Cameras referencing it in their ordered screen-space pass list: rebuild the list, substituting
    // the freshly saved asset for its id (other slots resolve from the current library).
    let cameraChanged = false;
    for (const n of Array.from(scene.nodes)) {
      if (n.nodeType !== 'camera') continue;
      const cam = n as CameraNode;
      const ids = getScreenMaterialIds(cam);
      if (!ids.includes(materialId)) continue;
      const assets = ids
        .map(id => (id === materialId ? asset : materials.find(m => m.id === id)))
        .filter((a): a is MaterialAsset => !!a);
      applyScreenMaterials(cam, assets);
      cameraChanged = true;
    }
    if (instances.length || cameraChanged) {
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
  const openMaterialTab = (asset: MaterialAsset | null) => {
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
    // renderer skips drawing meshes with a screen material). CustomMaterialEditor keeps the camera
    // list in step when the mode is switched inside the tab.
    if (material instanceof CustomMaterial && material.renderMode === 'screen' && scene.activeCamera)
      scene.activeCamera.screenMaterials = [material];
    scene.start();

    const tabId = cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: sphere.id });
    setTabs(prev => [...prev, { id: tabId, kind: 'material', title: asset?.name ?? 'New Material', materialId: asset?.id ?? null }]);
    setActiveTabId(tabId); // the activate effect swaps the engine scene + selects the sphere
  };

  // Open (or focus) the editor for a library material, or a brand-new one when called with no id.
  const enterMaterialEditor = (materialId?: string) => {
    if (!instanceRef.current) return;
    if (materialId) {
      // Opening is what produces the preview now that import no longer renders one.
      captureAssetThumbnail('material', materialId);
      const existing = tabs.find(t => t.kind === 'material' && t.materialId === materialId);
      if (existing) { setActiveTabId(existing.id); return; }
      const asset = materials.find(m => m.id === materialId);
      if (!asset) { Logger.error('Material not found', 'Editor'); return; }
      openMaterialTab(asset);
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
  // Renders from the asset's *saved* data, not from a live tab scene — renderMeshThumbnail reparents the
  // node it is given, which would rip the subtree out of the preview tab we just built.
  const thumbnailPendingRef = useRef(new Set<string>());

  const captureAssetThumbnail = (kind: 'material' | 'terrainMaterial' | 'mesh', id: string) => {
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
          const asset = meshes.find(m => m.id === id);
          if (!asset) return;
          const thumbnail = await renderMeshAssetThumbnail(engine, asset);
          if (thumbnail) setMeshes(prev => prev.map(x => x.id === id ? { ...x, thumbnail } : x));
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
  const applyActiveMeshLevel = (scene: Scene, levelIds: string[], active: number) => {
    for (let i = 0; i < levelIds.length; i++) {
      const root = scene.getNodeById(levelIds[i]);
      if (root) root.visible = i === active;
    }
  };

  // Build an edit session for a mesh asset: a throwaway scene holding one subtree per LOD level,
  // instantiated directly (NOT via the LodGroup wrapper — the renderer must not auto-swap levels while
  // the user edits). Materials/transforms/sub-meshes are edited through the normal Scene + Properties
  // panels; LOD levels, distances and the cull threshold through the Mesh inspector. Opening the tab
  // also triggers the asset's thumbnail render.
  const openMeshTab = (asset: MeshAsset) => {
    const scene = new Scene();
    scene.animationsEnabled = false; // skinned meshes hold their bind pose while editing
    createEmptyScene(scene);
    void applyPreviewEnvironment(scene);

    const holder = new Node(asset.name);
    scene.addNode(holder);

    // Restore legacy embedded textures (instantiateMeshAsset used to do this).
    for (const t of asset.textures || []) {
      if (t?.id && !TextureManager.Instance.getTexture(t.id))
        TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id);
    }

    const levelJsons = [asset.nodeJson, ...(asset.lods ?? []).map(l => l.nodeJson)];
    const levelIds: string[] = [];
    for (const json of levelJsons) {
      const clone = JSON.parse(JSON.stringify(json));
      regenerateIds(clone, new Map());
      parseByType(holder, clone);
      levelIds.push(clone.id);
    }
    scene.start();

    const tabId = cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: holder.id });
    setMeshSessions(prev => ({
      ...prev,
      [tabId]: {
        levelIds,
        distances: [0, ...(asset.lods ?? []).map(l => l.distance)],
        cullDistance: asset.cullDistance ?? 0,
        activeLevel: 0,
        skinned: levelJsons.some(nodeJsonHasSkinnedModel),
      },
    }));
    applyActiveMeshLevel(scene, levelIds, 0);
    setTabs(prev => [...prev, { id: tabId, kind: 'mesh', title: asset.name, meshId: asset.id }]);
    setActiveTabId(tabId);
    eventEmitter.current.emit('TEXTURES_CHANGED');
  };

  // Rebuild every placed instance of a mesh asset after it was saved, preserving each instance's own
  // transform (the template propagation pattern — a mesh instance is a whole copied subtree, so it is
  // re-instantiated rather than patched in place). Runs on the game scene only.
  const syncMeshInstances = (meshId: string, asset: MeshAsset) => {
    const scene = editorSceneRef.current;
    const maps = engineMaps();
    const instances = Array.from(scene.nodes).filter(n => n.getVariable(MESH_ID_VAR) === meshId);
    let reselectId: string | null = null;
    for (const inst of instances) {
      const parent = inst.parent;
      if (!parent) continue;
      const pos = Array.from(inst.position) as [number, number, number];
      const rot = Array.from(inst.rotation) as [number, number, number];
      const scl = Array.from(inst.scale) as [number, number, number];
      const wasSelected = inst.id === selectedNode;
      // Drop the old subtree's out-of-band data so map entries don't leak.
      for (const id of collectSubtreeIds(inst)) { maps.scripts.delete(id); maps.bodies.delete(id); maps.triggers.delete(id); }
      // Detach synchronously with removeChild, not remove() — see syncTemplateInstances for why.
      parent.removeChild(inst);
      const newId = instantiateMeshAsset(asset, parent);
      const newNode = scene.getNodeById(newId);
      if (newNode) newNode.setPosition(pos).setRotation(rot).setScale(scl);
      if (wasSelected) reselectId = newId;
    }
    if (instances.length) {
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
      if (reselectId) eventEmitter.current.emit('SELECT_NODE', reselectId);
    }
  };

  // After a mesh asset is saved, refresh every terrain-material foliage rule that references it
  // (rule.meshId): rebuild the embedded flattened LOD payload in the library asset, then swap
  // prototypes on live terrain layers using those materials — WITHOUT re-scattering instances.
  const syncFoliageRulesForMesh = (meshAsset: MeshAsset) => {
    const updated: TerrainMaterialAsset[] = [];
    for (const tmAsset of terrainMaterials) {
      const rules = tmAsset.material?.foliageInclude;
      if (!Array.isArray(rules) || !rules.some((r: any) => r?.meshId === meshAsset.id)) continue;
      try {
        const nextRules = rules.map((r: any) => r?.meshId === meshAsset.id ? buildFoliageRuleFromMeshAsset(meshAsset, r) : r);
        const material = { ...tmAsset.material, foliageInclude: nextRules };
        const patched: TerrainMaterialAsset = { ...tmAsset, material, textureIds: [...collectTerrainMaterialTextureIds(material)] };
        updateTerrainMaterial(tmAsset.id, patched);
        updated.push(patched);
      } catch (e) {
        Logger.warn(`Foliage rule for mesh "${meshAsset.name}" in terrain material "${tmAsset.name}" was not updated: ${e}`, 'Editor');
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

  // Save the active mesh tab back to the library and propagate to placed instances.
  const saveActiveMesh = async () => {
    const engine = instanceRef.current;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!engine || !tab || tab.kind !== 'mesh' || !tab.meshId) return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = meshSessions[tab.id];
    if (!runtime || !session) return;
    try {
      const levelRoots = session.levelIds.map(id => runtime.scene.getNodeById(id));
      if (levelRoots.some(r => !r)) { Logger.error('Mesh edit session lost a LOD level node', 'Editor'); return; }

      // Extra levels serialize into the asset's `lods`; buildMeshAsset strips debug helpers and the
      // instance back-link from every level.
      const lodDefs: MeshLodDef[] = [];
      for (let i = 1; i < levelRoots.length; i++)
        lodDefs.push({ nodeJson: await levelRoots[i]!.serialize(), distance: session.distances[i] ?? 0 });

      // materialIds is the informational list of library materials the subtrees reference.
      const materialIdSet = new Set<string>();
      const collectMats = (n: Node) => { const id = getMaterialIdOf(n); if (id) materialIdSet.add(id); n.children.forEach(collectMats); };
      for (const root of levelRoots) collectMats(root!);

      const prev = meshes.find(m => m.id === tab.meshId);
      const asset = await buildMeshAsset(
        levelRoots[0]!, [...materialIdSet], prev?.thumbnail ?? '', tab.meshId,
        lodDefs, session.cullDistance,
      );
      asset.name = tab.title; // the tab title is the asset name (renames edit the title)

      updateMesh(tab.meshId, asset);
      syncMeshInstances(tab.meshId, asset);
      syncFoliageRulesForMesh(asset);
      setDirtyTabs(prev => ({ ...prev, [tab.id]: false }));

      // Refresh the thumbnail from the SAVED asset, never the live tab subtree (renderMeshThumbnail
      // reparents the node it is given). Async: the card updates whenever the render lands.
      renderMeshAssetThumbnail(engine, asset)
        .then(thumbnail => { if (thumbnail) setMeshes(p => p.map(x => x.id === asset.id ? { ...x, thumbnail } : x)); })
        .catch(() => {});
      Logger.info(`Mesh "${asset.name}" saved`, 'Editor');
    } catch (e) {
      Logger.error('Failed to save mesh: ' + e, 'Editor');
    }
  };

  // Rename the active mesh tab (the title becomes the asset name on save).
  const setActiveMeshName = (name: string) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'mesh') return;
    setTabs(prev => prev.map(x => x.id === tab.id ? { ...x, title: name } : x));
    setDirtyTabs(prev => ({ ...prev, [tab.id]: true }));
  };

  // Import a model file as a new LOD level of the active mesh tab. The level is scaled so its bounds
  // match LOD0's, and its materials are registered as library assets exactly like a normal import.
  const addMeshLodFromFiles = async (files: File[]) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'mesh') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = meshSessions[tab.id];
    if (!runtime || !session) return;
    if (session.skinned) { Logger.warn('LOD levels are not supported on skinned meshes yet', 'Editor'); return; }

    const bundles = groupImportFiles(files);
    if (!bundles.length) { Logger.warn('No model files (.gltf/.glb/.obj/.fbx) found in the selection', 'Editor'); return; }
    try {
      const { root, children } = await parseBundleToRoot(bundles[0].files, bundles[0].name);
      if (children.some(c => c.model instanceof AnimatedModel)) {
        Logger.warn('Skinned models cannot be LOD levels (static meshes only)', 'Editor');
        return;
      }
      await awaitSubtreeTexturesReady(root);

      // Register a MaterialAsset per unique material and link each sub-mesh (same as importMeshFiles).
      const assetByKey = new Map<string, MaterialAsset>();
      for (const child of children) {
        const mat = (child.model as any).material as Material;
        if (!mat) continue;
        const key = JSON.stringify(mat.serialize());
        let matAsset = assetByKey.get(key);
        if (!matAsset) {
          matAsset = buildMaterialAsset(mat, `${bundles[0].name} ${mat.type}`, '');
          assetByKey.set(key, matAsset);
          addMaterial(matAsset);
        }
        applyMaterialAsset(child, matAsset);
      }

      // Match LOD0's size so far levels line up with the near model.
      const lod0 = runtime.scene.getNodeById(session.levelIds[0]);
      if (lod0) {
        const targetDiameter = 2 * meshBoundsRadius(lod0);
        if (targetDiameter > 0) normalizeRootScale(root, targetDiameter);
      }

      const holder = runtime.scene.getNodeById(runtime.rootId);
      if (!holder) return;
      root.name = `${tab.title}_LOD${session.levelIds.length}`;
      holder.addChild(root);

      const lastDistance = session.distances[session.distances.length - 1] ?? 0;
      const levelIds = [...session.levelIds, root.id];
      const next: MeshEditSession = {
        ...session,
        levelIds,
        distances: [...session.distances, lastDistance + 30],
        activeLevel: levelIds.length - 1, // show what was just imported
      };
      setMeshSessions(prev => ({ ...prev, [tab.id]: next }));
      applyActiveMeshLevel(runtime.scene, levelIds, next.activeLevel);
      setDirtyTabs(prev => ({ ...prev, [tab.id]: true }));
      eventEmitter.current.emit('TEXTURES_CHANGED');
      eventEmitter.current.emit('SCENE_CHANGED');
    } catch (e) {
      Logger.error('Failed to add LOD level: ' + e, 'Editor');
    }
  };

  // Remove an extra LOD level (level 0 is the asset itself and cannot be removed).
  const removeMeshLod = (level: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'mesh' || level < 1) return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = meshSessions[tab.id];
    if (!runtime || !session || level >= session.levelIds.length) return;

    const root = runtime.scene.getNodeById(session.levelIds[level]);
    if (root?.parent) root.parent.removeChild(root);

    const levelIds = session.levelIds.filter((_, i) => i !== level);
    const distances = session.distances.filter((_, i) => i !== level);
    const activeLevel = Math.min(session.activeLevel >= level ? session.activeLevel - 1 : session.activeLevel, levelIds.length - 1);
    setMeshSessions(prev => ({ ...prev, [tab.id]: { ...session, levelIds, distances, activeLevel: Math.max(0, activeLevel) } }));
    applyActiveMeshLevel(runtime.scene, levelIds, Math.max(0, activeLevel));
    setDirtyTabs(prev => ({ ...prev, [tab.id]: true }));
  };

  const setMeshLodDistance = (level: number, distance: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'mesh' || level < 1) return;
    const session = meshSessions[tab.id];
    if (!session || level >= session.distances.length) return;
    const distances = session.distances.map((d, i) => i === level ? Math.max(0, distance) : d);
    setMeshSessions(prev => ({ ...prev, [tab.id]: { ...session, distances } }));
    setDirtyTabs(prev => ({ ...prev, [tab.id]: true }));
  };

  const setMeshCullDistance = (distance: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'mesh') return;
    const session = meshSessions[tab.id];
    if (!session) return;
    setMeshSessions(prev => ({ ...prev, [tab.id]: { ...session, cullDistance: Math.max(0, distance) } }));
    setDirtyTabs(prev => ({ ...prev, [tab.id]: true }));
  };

  const setActiveMeshLevel = (level: number) => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'mesh') return;
    const runtime = tabRuntimeRef.current.get(tab.id);
    const session = meshSessions[tab.id];
    if (!runtime || !session || level < 0 || level >= session.levelIds.length) return;
    setMeshSessions(prev => ({ ...prev, [tab.id]: { ...session, activeLevel: level } }));
    applyActiveMeshLevel(runtime.scene, session.levelIds, level);
    eventEmitter.current.emit('SELECT_NODE', session.levelIds[level]);
  };

  // Open (or focus) the edit tab for a library mesh, rendering its thumbnail on the way in.
  const enterMeshEditor = (meshId?: string) => {
    if (!instanceRef.current || !meshId) return;
    const asset = meshes.find(m => m.id === meshId);
    if (!asset) { Logger.error('Mesh not found', 'Editor'); return; }

    captureAssetThumbnail('mesh', meshId);

    const existing = tabs.find(t => t.kind === 'mesh' && t.meshId === meshId);
    if (existing) { setActiveTabId(existing.id); return; }
    openMeshTab(asset);
  };

  // Import one or more model files (and folders) into the mesh library. Groups the selection into one
  // bundle per model file; for each: parses, then opens the review modal (missing textures + scale
  // normalization) and awaits the user. On accept, applies any uploaded textures (re-parse), normalizes
  // scale, registers each material as a reusable MaterialAsset linked via __materialId, and stores the
  // mesh asset. Meshes land in the library only — drag a card to place it.
  //
  // Every stage transition is published to the shared progress store, so what the window says is what the
  // code is actually doing.
  const importMeshFiles = async (files: File[]) => {
    const engine = instanceRef.current;
    if (!engine) { Logger.error('Engine not ready for import', 'Editor'); return; }
    const bundles = groupImportFiles(files);
    if (bundles.length === 0) { Logger.warn('No model files (.gltf/.glb/.obj/.fbx) found in the selection', 'Editor'); return; }

    const task = startTask({
      title: 'Importing models',
      steps: bundles.map(b => ({ name: b.name, status: 'pending' as StepStatus, detail: 'Queued' })),
      cancellable: true,
      // Settling the review modal lets a loop parked on it reach the cancel check below.
      onCancel: () => { if (pendingResolverRef.current) resolveMeshImport(null); },
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
        try { parsedResult = await parseBundleToRoot(bundle.files, bundle.name); }
        catch (e) {
          Logger.warn(`${e}`, 'Editor');
          setStage(i, 'failed', undefined, `${e}`);
          continue;
        }
        let { root, children } = parsedResult;

        const missing = await detectMissingTextures(bundle.files);
        const sizeRadius = meshBoundsRadius(root);
        const matKeys = new Set<string>();
        for (const c of children) { const m = (c.model as any).material; if (m) matKeys.add(JSON.stringify(m.serialize())); }

        // Park the parsed mesh and await the user's decision from MeshImportModal.
        setStage(i, 'review', missing.length
          ? `${missing.length} texture${missing.length === 1 ? '' : 's'} missing — awaiting review`
          : 'Awaiting review');
        const decision = await new Promise<MeshImportDecision | null>(resolve => {
          pendingResolverRef.current = resolve;
          setPendingMeshImport({
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
          : 'Serializing to the mesh library');

        if (separate) {
          const assets = await separateSubMeshes(root, children, bundle.name, materialIdOfChild);
          for (const asset of assets) addMesh(asset);
          eventEmitter.current.emit('TEXTURES_CHANGED');

          const summary = `${assets.length} separate mesh${assets.length === 1 ? '' : 'es'}`;
          setStage(i, 'done', summary);
          Logger.info(`Imported "${bundle.name}" as ${summary}`, 'Editor');
        } else {
          const meshAsset = await buildMeshAsset(root, materialIds, '');
          addMesh(meshAsset);
          eventEmitter.current.emit('TEXTURES_CHANGED');

          const summary = `${children.length} sub-mesh${children.length === 1 ? '' : 'es'}, ${materialIds.length} material${materialIds.length === 1 ? '' : 's'}`;
          setStage(i, 'done', summary);
          Logger.info(`Imported mesh "${bundle.name}" (${summary})`, 'Editor');
        }
      } catch (err) {
        Logger.error(`Failed to import "${bundle.name}": ${err}`, 'Editor');
        setStage(i, 'failed', undefined, `${err}`);
        // Make sure a stuck modal is cleared if we errored mid-review.
        if (pendingResolverRef.current) { pendingResolverRef.current = null; setPendingMeshImport(null); }
      }
    }

    task.finish();
  };

  // Save the active material tab to the library (capturing a sphere thumbnail) and propagate to references.
  const saveActiveMaterial = () => {
    const instance = instanceRef.current;
    const tab = tabs.find(t => t.id === activeTabId);
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
        syncMaterialInstances(tab.materialId, asset); // push edits to placed references
      } else {
        const asset = buildMaterialAsset(sphere.model.material, tab.title, thumbnail);
        addMaterial(asset); // asset carries a fresh id
        setTabs(prev => prev.map(x => x.id === tab.id ? { ...x, materialId: asset.id } : x));
      }
      setDirtyTabs(prev => ({ ...prev, [tab.id]: false }));
      Logger.info(`Material "${tab.title}" saved`, 'Editor');
    } catch (e) {
      Logger.error('Failed to save material: ' + e, 'Editor');
    }
  };

  // Rename the active material tab (bound to the name field in the material-mode inspector).
  const setActiveMaterialName = (name: string) => {
    setTabs(prev => prev.map(t => (t.id === activeTabId && t.kind === 'material') ? { ...t, title: name } : t));
    setDirtyTabs(prev => ({ ...prev, [activeTabId]: true }));
  };

  // --- Terrain materials (mirror the material asset flow above, but assigned to terrain paint layers) ---

  // Re-apply a saved/edited terrain material to every terrain paint layer that references it (by materialId).
  const syncTerrainMaterialInstances = (id: string, asset: TerrainMaterialAsset) => {
    const scene = editorSceneRef.current;
    let changed = false;
    for (const ln of Array.from(scene.landscapes) as any[]) {
      const terrain = ln.terrain;
      const layers = terrain.layers;
      for (let i = 0; i < layers.length; i++) {
        if (layers[i]?.materialId === id) { applyTerrainMaterialToLayer(terrain, i, asset); changed = true; }
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
  const openTerrainMaterialTab = (asset: TerrainMaterialAsset | null) => {
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

    const tabId = cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: previewNode.id, tm, helperTerrain, editNode });
    setTabs(prev => [...prev, { id: tabId, kind: 'terrainMaterial', title: asset?.name ?? 'New Terrain Material', terrainMaterialId: asset?.id ?? null }]);
    setActiveTabId(tabId);
  };

  // Re-derive the composite preview from the edited TerrainMaterial after any inspector change.
  const refreshTerrainMaterialPreview = () => {
    const runtime = tabRuntimeRef.current.get(activeTabId);
    if (runtime?.helperTerrain && runtime.tm) runtime.helperTerrain.setLayer(0, runtime.tm, { auto: false, tiling: 1 });
  };

  const enterTerrainMaterialEditor = (terrainMaterialId?: string) => {
    if (!instanceRef.current) return;
    if (terrainMaterialId) {
      captureAssetThumbnail('terrainMaterial', terrainMaterialId); // opening is what produces the preview
      const existing = tabs.find(t => t.kind === 'terrainMaterial' && t.terrainMaterialId === terrainMaterialId);
      if (existing) { setActiveTabId(existing.id); return; }
      const asset = terrainMaterials.find(m => m.id === terrainMaterialId);
      if (!asset) { Logger.error('Terrain material not found', 'Editor'); return; }
      openTerrainMaterialTab(asset);
    } else {
      openTerrainMaterialTab(null);
    }
  };

  // Save the active terrain-material tab to the library (capturing a sphere thumbnail) + propagate to layers.
  const saveActiveTerrainMaterial = () => {
    const instance = instanceRef.current;
    const tab = tabs.find(t => t.id === activeTabId);
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
        syncTerrainMaterialInstances(tab.terrainMaterialId, asset);
      } else {
        const asset = buildTerrainMaterialAsset(material, tab.title, thumbnail);
        addTerrainMaterial(asset);
        setTabs(prev => prev.map(x => x.id === tab.id ? { ...x, terrainMaterialId: asset.id } : x));
      }
      setDirtyTabs(prev => ({ ...prev, [tab.id]: false }));
      Logger.info(`Terrain material "${tab.title}" saved`, 'Editor');
    } catch (e) {
      Logger.error('Failed to save terrain material: ' + e, 'Editor');
    }
  };

  const setActiveTerrainMaterialName = (name: string) => {
    setTabs(prev => prev.map(t => (t.id === activeTabId && t.kind === 'terrainMaterial') ? { ...t, title: name } : t));
    setDirtyTabs(prev => ({ ...prev, [activeTabId]: true }));
  };

  // Keep non-reactive mirrors of the active tab (read by the once-registered SCENE_CHANGED/dimension listeners).
  useEffect(() => { activeTabIdRef.current = activeTabId; activeTabKindRef.current = activeTab.kind; }, [activeTabId, activeTab.kind]);

  // Switch the engine to the active tab's scene whenever the active tab changes.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    const tab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
    activeTabKindRef.current = tab.kind;
    const runtime = tab.kind !== 'main' ? tabRuntimeRef.current.get(tab.id) : undefined;
    instance.setScene(runtime ? runtime.scene : editorSceneRef.current);
    // Hide the editor ground grid in (terrain-)material tabs so the preview sphere + its thumbnail stay clean.
    instance.renderer.setGridVisible(tab.kind !== 'material' && tab.kind !== 'terrainMaterial');
    // Arm dirty-tracking only after the editor-helper reconciler's initial pass settles (it emits
    // SCENE_CHANGED as it adds light/gizmo helpers to the freshly-shown template scene).
    dirtyArmedRef.current = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { dirtyArmedRef.current = (tab.kind === 'template' || tab.kind === 'material' || tab.kind === 'terrainMaterial' || tab.kind === 'mesh' || tab.kind === 'main'); }));
    // Template scenes are authored in 3D; the Main tab restores its own remembered dimension. (Terrain-)
    // material tabs are skipped: their preview camera uses a self-contained orbit rig
    // (createMaterialPreviewScene) that the free-fly CHANGE_DIMENSION handler must not overwrite.
    if (tab.kind !== 'material' && tab.kind !== 'terrainMaterial')
      eventEmitter.current.emit('CHANGE_DIMENSION', tab.kind === 'main' ? dimensionRef.current : '3D');
    eventEmitter.current.emit('TEXTURES_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    // Animation tabs select via the skeleton tree (SELECT_JOINT), not the mesh, so start with none.
    eventEmitter.current.emit('SELECT_NODE', (runtime && tab.kind !== 'animation') ? runtime.rootId : null);
  }, [activeTabId]);

  // Mark the active tab dirty on scene edits (after the open-settle window). The Main tab drives the
  // multi-scene `mainDirty` flag (used to prompt Save/Discard/Cancel on scene switch); library tabs
  // drive their own per-tab dirtyTabs entry. Play mode never marks dirty — it runs a separate play
  // scene, so its edits must not make the editor scene look unsaved.
  useEffect(() => {
    const mark = () => {
      if (!dirtyArmedRef.current || isPlayModeRef.current) return;
      const kind = activeTabKindRef.current;
      if (kind === 'main') {
        if (!mainDirtyRef.current) { mainDirtyRef.current = true; setMainDirty(true); }
        return;
      }
      if (kind !== 'template' && kind !== 'material' && kind !== 'terrainMaterial' && kind !== 'mesh') return;
      const id = activeTabIdRef.current;
      setDirtyTabs(prev => prev[id] ? prev : { ...prev, [id]: true });
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
      const matSet = collectReferencedMaterialIds(scene, meshes);
      const meshSet = collectReferencedMeshIds(scene);
      const tplSet = collectReferencedTemplateIds(scene);
      const tmSet = collectReferencedTerrainMaterialIds(scene);
      const scriptSet = collectReferencedScriptIds(scene);
      const refs: SceneRefs = {
        materialIds: Array.from(matSet),
        meshIds: Array.from(meshSet),
        templateIds: Array.from(tplSet),
        terrainMaterialIds: Array.from(tmSet),
        textureIds: Array.from(referencedTextureIds(materials, terrainMaterials, templates, meshes)),
      };
      // Per-asset content hashes let a *closed* scene tell, when reopened, which referenced assets
      // changed while it was closed — so unchanged meshes/templates aren't needlessly re-instantiated.
      const assetHashes = buildAssetHashes(
        { materialIds: matSet, meshIds: meshSet, templateIds: tplSet, terrainMaterialIds: tmSet, scriptIds: scriptSet },
        currentLibs(),
      );
      await saveSceneData(sceneId, { ...gameData, assetHashes, savedAt: now });
      await updateProjectMeta(m => ({
        ...m,
        prefs: { dimension: dimensionRef.current, selectedNode },
        scenes: m.scenes.map(s => s.id === sceneId ? { ...s, updatedAt: now, refs } : s),
      }));
      setMainDirty(false);
      mainDirtyRef.current = false;
      return true;
    } catch (e: any) {
      Logger.error(`Failed to save scene: ${e?.message || e}`, 'Editor');
      return false;
    }
  };

  const saveProjectToStorage = async (): Promise<boolean> => {
    setSavingState('saving');
    // Indeterminate: serialize + IndexedDB write is one opaque operation, with no honest fraction to show.
    // The Save button keeps its own inline state; this puts it in the shared place alongside everything else.
    const task = startTask({
      title: 'Saving project',
      steps: [{ name: 'Saving project', status: 'running', detail: 'Serializing the scene' }],
      indeterminate: true,
    });
    try {
      // Race against a timeout as a defensive backstop so the UI never gets stuck "saving".
      const ok = await Promise.race<boolean>([
        saveCurrentScene(),
        new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error('Save timed out')), 15000)),
      ]);
      if (ok) {
        Logger.info('Scene saved', 'Editor');
        setSavingState('saved');
        task.setStep(0, { status: 'done', detail: 'Saved' });
      } else {
        setSavingState('error');
        task.setStep(0, { status: 'failed', error: 'Save failed' });
      }
      return ok;
    } catch (e: any) {
      Logger.error('Save failed: ' + (e?.message || e), 'Editor');
      setSavingState('error');
      task.setStep(0, { status: 'failed', error: String(e?.message || e) });
      return false;
    } finally {
      task.finish();
      setTimeout(() => setSavingState('idle'), 2000);
    }
  };

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
    if (sceneId === openSceneIdRef.current) { setActiveTabId('main'); return true; }

    // Leave play mode first — play snapshots the open scene, and swapping it mid-run would leave the
    // engine driving a scene the editor no longer shows.
    if (startedRef.current) stopPlay();

    if (mainDirtyRef.current) {
      const current = meta.scenes.find(s => s.id === openSceneIdRef.current);
      const decision = await confirmUnsavedScene(current?.name ?? 'current scene');
      if (decision === 'cancel') return false;
      if (decision === 'save' && !(await saveProjectToStorage())) return false;
    }

    // Load the target before tearing anything down, so a failed read aborts cleanly. A scene whose blob
    // was never written (e.g. a fresh "Main" before its first save) opens empty.
    const data = (await loadSceneData(sceneId)) ?? { ...(await buildEmptySceneData()), savedAt: Date.now() };

    setActiveTabId('main');
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
      setDirtyTabs(prev => {
        const next = { ...prev };
        for (const id of staleIds) delete next[id];
        return next;
      });
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
    resyncScene(scene, engineMaps(), currentLibs(), data.assetHashes);
    showBindPoseForSkinnedModels(scene);

    await updateProjectMeta(m => ({ ...m, openSceneId: sceneId }));
    setMainDirty(false);
    mainDirtyRef.current = false;
    eventEmitter.current.emit('TEXTURES_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    // Parsing a scene can replace camera settings/onUpdate handlers; re-apply editor camera controls.
    eventEmitter.current.emit('CHANGE_DIMENSION', dimensionRef.current);
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
    let meta = await loadProjectMeta();
    if (!meta) meta = await migrateLegacyProject();
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
          CleoEngine.eventEmitter.on('SCENE_CHANGED', () => { eventEmitter.current.emit('SCENE_CHANGED') });
          
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
          eventEmitter.current.emit('TEXTURES_CHANGED');

          // Setting the editor scene and camera
          engine.setScene(editorSceneRef.current);
          // The editor scene runs unpaused (for camera nav), so disable animator playback and pin
          // skinned models to their bind/T pose — animations only play in Play mode + the Anim Editor.
          editorSceneRef.current.animationsEnabled = false;
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
          // Drive the initial camera dimension now that the scene is live (restored pref, else 3D).
          eventEmitter.current.emit('CHANGE_DIMENSION', prefs?.dimension ?? '3D');

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
      if (isPlayMode || !activeScene || editorMode === 'material' || editorMode === 'terrainMaterial') return;
      suppressReconcileRef.current = true;
      try { reconcileEditorHelpers(activeScene, bodiesRef.current, triggersRef.current); }
      finally { suppressReconcileRef.current = false; }
    };
    const schedule = () => {
      if (suppressReconcileRef.current || reconcileScheduledRef.current) return;
      reconcileScheduledRef.current = true;
      requestAnimationFrame(runReconcile);
    };
    const emitter = eventEmitter.current;
    emitter.on('SCENE_CHANGED', schedule);
    emitter.on('PHYSICS_CHANGED', schedule);
    schedule(); // initial reconcile for the current scene / mode
    return () => {
      emitter.off('SCENE_CHANGED', schedule);
      emitter.off('PHYSICS_CHANGED', schedule);
    };
  }, [activeScene, isPlayMode, editorMode]);

  // Event handling
  useEffect(() => {
    eventEmitter.current.on('CHANGE_DIMENSION', (dimension: '2D' | '3D') => {
      if (!instanceRef.current) return;
      // Only the Main tab's dimension is persisted; template tabs render transiently in 3D.
      if (activeTabKindRef.current === 'main') dimensionRef.current = dimension;

      // Wait for scene to be ready
      if (!instanceRef.current.scene) {
        console.log('Scene not ready yet, retrying...');
        setTimeout(() => {
          eventEmitter.current.emit('CHANGE_DIMENSION', dimension);
        }, 100);
        return;
      }

      // change camera to 2D
      let cameraNode = instanceRef.current.scene.activeCamera;
      if (dimension === '2D') {
        cameraNode.camera.type = 'orthographic';
        cameraNode.camera.top = 4;
        cameraNode.camera.bottom = -4;
        cameraNode.camera.left = -4;
        cameraNode.camera.right = 4;
        cameraNode.setZ(10).setRotation([0, 180, 0]);
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
              const step = -mouse.wheel.deltaY * 0.001; // wheel up -> zoom in
              const factor = Math.max(0.1, 1 + step); // avoid inverting
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
        // Restore the editor grid when returning to the editor scene
        if (instanceRef.current.renderer) {
          instanceRef.current.renderer.setGridVisible(true);
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
      useCache: true,
    });
    const newScene = new Scene();
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
    resyncScene(tmp, maps, currentLibs(), data.assetHashes);
    const gd = await buildGameData({ scene: tmp, scripts: maps.scripts, bodies: maps.bodies, triggers: maps.triggers, ui: clone.ui ?? { version: 1, elements: [] }, useCache: true });
    const scene = new Scene();
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
  };

  const installGameHost = () => setGameHost({
    loadScene: (nameOrId: string) => { void playLoadScene(nameOrId); },
    currentSceneName: () => projectMetaRef.current?.scenes.find(s => s.id === currentPlaySceneIdRef.current)?.name ?? '',
    sceneNames: () => (projectMetaRef.current?.scenes ?? []).map(s => s.name),
  });

  const startPlay = async () => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.input.preventDefault();
    if (startedRef.current) { eventEmitter.current.emit('SET_PLAY_STATE', 'play'); return; }
    playEntrySceneIdRef.current = openSceneIdRef.current;
    currentPlaySceneIdRef.current = openSceneIdRef.current;
    playSceneUiRef.current = uiStateRef.current.elements;
    const newScene = await buildPlayScene();
    instance.setScene(newScene);
    instance.isPaused = false;
    installGameHost();
    setTimeout(() => { instance.scene.start(); startUIRuntime(); }, 100);
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
    setTimeout(() => { instance.scene.start(); startUIRuntime(); }, 50);
    startedRef.current = true;
    eventEmitter.current.emit('SET_PLAY_STATE', 'play');
  };
  const game: GameActions = { reset: () => { resetPlay(); }, exit: () => { stopPlay(); }, pause: () => { pausePlay(); } };

  // Warn before closing/reloading the page while a project save is in flight.
  useEffect(() => {
    if (savingState !== 'saving') return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [savingState]);

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
      saveActiveTemplate,
      saveActiveMaterial,
      saveActiveTerrainMaterial,
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
      enterScriptEditor,
      saveActiveScript,
      setScriptTabSource,
      getScriptTabSource,
      meshes,
      addMesh,
      removeMesh,
      updateMesh,
      enterMeshEditor,
      saveActiveMesh,
      meshSession: activeTab.kind === 'mesh' ? (meshSessions[activeTab.id] ?? null) : null,
      meshEditTargetId: activeTab.kind === 'mesh' && meshSessions[activeTab.id]
        ? meshSessions[activeTab.id].levelIds[meshSessions[activeTab.id].activeLevel] ?? null
        : null,
      setActiveMeshName,
      addMeshLodFromFiles,
      removeMeshLod,
      setMeshLodDistance,
      setMeshCullDistance,
      setActiveMeshLevel,
      importMeshFiles,
      assetsLoaded,
      pendingMeshImport,
      resolveMeshImport,
      importAnimationFiles,
      importSkeletonNames,
      renameAnimationClip,
      removeAnimationClip,
      pendingAnimationImport,
      resolveAnimationImport,
      replaceProjectMeta,
      saveProject: saveProjectToStorage,
      savingState,
      sceneList,
      mainSceneId,
      openSceneId,
      mainDirty,
      openScene,
      createScene,
      renameScene,
      deleteScene,
      duplicateScene,
      setMainScene,
      pendingSceneConfirm,
      resolveSceneConfirm,
    }}>
    {props.children}
  </EngineContext.Provider>
  );
}