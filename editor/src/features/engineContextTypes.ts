import type { AnimationCompatibility, BoneMapping, HullQuality } from "cleo";
import type { UnresolvedTexture } from "../utils/modelImport";
import type { PartInfo, PartGroup } from "../utils/submeshGroups";
import type { ModelLodDef } from "../utils/models";

// A mesh awaiting user review in the import modal (parsed but not yet committed to the library).
export type PendingModelImportView = {
  bundleName: string;
  subMeshCount: number;
  materialCount: number;
  /** Referenced texture files not present in the upload — pickable. `from` names the material + slot. */
  missing: UnresolvedTexture[];
  /**
   * References no upload can fix: a texture embedded in the model itself that could not be decoded
   * (a .dds/.tga payload, or raw pixels). Not pickable.
   */
  unloadable: UnresolvedTexture[];
  sizeRadius: number;     // combined bounding radius at scale 1 (diameter = 2*radius)
  /** One entry per sub-mesh, in parse order — what the modal's grouping editor lists and drags. */
  parts: PartInfo[];
};
// The user's decision from the import modal.
export type ModelImportDecision = {
  extraFiles: File[];     // textures uploaded to fill missing references (aliased to expected names)
  normalize: boolean;
  targetSize: number;     // desired bounding diameter in world units
  /** Split the file's sub-models into one ModelAsset each, instead of a single asset for the whole file. */
  separate: boolean;
  /**
   * Collapse the file's sub-meshes into ONE mesh carrying one submesh per material — the opposite of
   * `separate`. Merged, a character is one node with one Animator instead of several over one skeleton.
   */
  merge: boolean;
  /**
   * How to partition the sub-meshes into assets when `separate` and `merge` are BOTH on: one asset per
   * group, each group merged into a single mesh. Indices address the REVIEW-TIME sub-mesh order, so the
   * import re-validates them (isValidGrouping) — supplying missing textures re-parses the bundle.
   */
  groups?: PartGroup[];
};

/** A bone the mapping table lists in a target-joint dropdown: its node index and display name. */
export type RetargetBoneOption = { node: number; name: string };
// Animation clips parsed from a file, each with a compatibility report vs the target skeleton, plus the
// bone mapping (retarget) the user can inspect and correct — all awaiting review in the import modal.
export type PendingAnimationImportView = {
  fileName: string;
  /** `animatedNodes` are the source bones THIS clip drives, so the modal can recount matched/missing
   *  against the edited mapping. */
  clips: { name: string; report: AnimationCompatibility; animatedNodes: number[] }[];
  /** The source→target bone mapping the reports were computed from. Edited in the modal. */
  mapping: BoneMapping;
  /** Source bones the clips animate (the mapping's left column), and every target joint (the dropdowns). */
  sourceBones: RetargetBoneOption[];
  targetBones: RetargetBoneOption[];
};
/** The rig picker's data: which skinned models the animation could be retargeted onto. */
export type PendingRigPickView = { fileName: string; models: { id: string; name: string }[] };

export type AnimationImportDecision = {
  include: boolean[];
  mapping: BoneMapping;
  /**
   * Per-clip name as typed in the modal, parallel to `include`; blank or missing keeps the parsed name.
   * Rename HERE: a later rename rewrites state-machine references but not Animation Field samples.
   */
  names?: string[];
};

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
 * Capsule collider. `height` is the TOTAL tip-to-tip height, so the straight section is
 * `height - 2 * radius` and a height at or below `2 * radius` is a sphere.
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
 * Convex hull fitted to a mesh (see `hullFromPositions`). Vertices/faces are baked at authoring time and
 * centered on the hull's centroid; that displacement is folded into `offset`.
 */
type ConvexShapeDescription = {
  type: 'convex';
  offset: number[];
  rotation: number[];

  quality: HullQuality;
  vertices: number[][];
  faces: number[][];
  /**
   * Hull algorithm version. 3 = AABB-anchored carve with a containment audit over every mesh vertex.
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
   * Surface properties; absent = the engine defaults, 0.3 friction / 0 restitution.
   * Two bodies combine with min(friction) and max(restitution), so the deliberately-set value wins.
   */
  friction?: number;
  restitution?: number;
  /**
   * Two independent channels; absent means `true` for both. `simulatePhysics: false` leaves a ghost the
   * solver ignores but a camera probe still sees; `cameraCollision: false` is the reverse.
   */
  simulatePhysics?: boolean;
  cameraCollision?: boolean;
  /**
   * Meters below the collider's feet that still count as grounded. Absent/0 = off, grounding from solver
   * contacts only. ~0.1–0.2 stops `isGrounded` flickering under a resting body.
   */
  groundProbeDistance?: number;
  /** Time constant for this body's MEASURED motion, in seconds. 0/absent = the engine default (~0.09s). */
  motionSmoothing?: number;
  shapes: ShapeDescription[];
}
export type ShapeDescription = BoxShapeDescription | SphereShapeDescription | CylinderShapeDescription | CapsuleShapeDescription | PlaneShapeDescription | ConvexShapeDescription;

export type LoadingProgress = { loaded: number; total: number; label: string };

// Soft pastel-blue editor viewport background, used across every editor mode.
export const EDITOR_CLEAR_COLOR: [number, number, number, number] = [0.68, 0.80, 0.90, 1.0];
export const LEGACY_CLEAR_COLOR = [0.65, 0.65, 0.71];

export type EditorMode = 'scene' | 'landscape' | 'tilemap' | 'ui' | 'template' | 'renderer' | 'material' | 'terrainMaterial' | 'animation' | 'animationField' | 'model' | 'script' | 'tileset' | 'texture' | 'soundSample';

/**
 * Whether a mode paints the 3D viewport, or replaces it with a full-panel editor of its own; the
 * viewport's floating chrome is gated on it. Exhaustive by design — a new mode with no entry is a
 * compile error.
 */
export const MODE_RENDERS_VIEWPORT: Record<EditorMode, boolean> = {
  scene: true,
  landscape: true,
  tilemap: true,
  ui: true,
  template: true,
  renderer: true,        // its own perf HUD sits over a live render
  material: true,        // preview sphere
  terrainMaterial: true, // preview sphere
  animation: true,       // except in Graph view — see `hideForGraph`
  animationField: true,  // the blend-space plot is translucent over the 3D preview
  model: true,
  script: false,         // ScriptTabView fills the panel
  tileset: false,        // TilesetTabView fills the panel
  texture: false,        // TextureTabView fills the panel
  soundSample: false,    // SoundTabView fills the panel
};
export type GizmoMode = 'position' | 'rotation' | 'scale';
export type SavingState = 'idle' | 'saving' | 'saved' | 'error';

// Browser-style editor tabs. `editorMode` is derived from the active tab (see EngineProvider). The scene
// tab hosts the open scene asset; the library tabs each own a live edit session (a throwaway Scene in
// tabRuntimeRef), except 'script' and 'tileset', which own no 3D scene and get no tabRuntimeRef entry.
export type TabKind = 'scene' | 'template' | 'material' | 'terrainMaterial' | 'animation' | 'animationField' | 'model' | 'script' | 'tileset' | 'texture' | 'soundSample';

/**
 * Whether a tab's contents may drive AUTO-EXPOSURE. Exhaustive, like `MODE_RENDERS_VIEWPORT` above — a
 * new tab kind with no entry is a compile error.
 *
 * Only the scene tab. Every other tab renders a throwaway session lit by
 * `createMaterialPreviewScene`'s fixed key/fill studio rig, which has nothing to do with the project —
 * so an exposure metered from it is meaningless, and it drifts as the preview subject changes. With
 * metering suppressed those tabs fall back to the AUTHORED exposure, which keeps every thumbnail in the
 * asset library comparable with the others and stable as the scene is retuned.
 *
 * `template` is false deliberately: it is a throwaway edit session under the preview rig, not the
 * project's scene.
 */
export const TAB_METERS_EXPOSURE: Record<TabKind, boolean> = {
  scene: true,           // the project's scene, in every one of its sub-modes
  template: false,
  material: false,       // preview sphere
  terrainMaterial: false,// preview sphere
  animation: false,
  animationField: false,
  model: false,
  script: false,         // no viewport at all
  tileset: false,        // no viewport at all
  texture: false,        // no viewport at all
  soundSample: false,    // no viewport at all
};

/**
 * Whether a tab's contents run the POST-PROCESS CHAIN. Exhaustive, like the tables above — a new tab
 * kind with no entry is a compile error.
 *
 * Only the scene tab, and for the same underlying reason `TAB_METERS_EXPOSURE` is: every other tab
 * renders a throwaway preview session, and a preview is a picture of the ASSET rather than of the
 * project's look. Someone judging a roughness value wants to see the material, not the material behind
 * whatever bloom, depth of field, vignette and grain the scene happens to be authored with.
 *
 * Kept as its own table rather than folded into `TAB_METERS_EXPOSURE`, which it currently matches
 * entry for entry: the two answer different questions (may this drive exposure adaptation / should
 * this wear the project's look), and a future tab kind could easily want one without the other.
 *
 * Antialiasing is not covered here. TAA resolves inside the scene render rather than in the chain, so
 * it keeps running everywhere and previews stay free of crawling edges.
 */
export const TAB_RUNS_POST_PROCESSING: Record<TabKind, boolean> = {
  scene: true,           // the project's scene, in every one of its sub-modes
  template: false,
  material: false,       // preview sphere
  terrainMaterial: false,// preview sphere
  animation: false,
  animationField: false,
  model: false,
  script: false,         // no viewport at all
  tileset: false,        // no viewport at all
  texture: false,        // no viewport at all
  soundSample: false,    // no viewport at all
};

/**
 * The scene tab's id — a fixed sentinel, unlike the library tabs' random ids. Deliberately NOT the open
 * scene's id: the tab is a stable slot different scene assets pass through, and only its title follows
 * the open scene's name.
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
  texture: 'Texture',
  soundSample: 'Sound',
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
  textureId?: string | null; // texture tabs: the edited texture asset id (also its TextureManager id)
  soundId?: string | null; // sound tabs: the edited sample asset id (also its AudioManager id)
}
export type TerrainTool = 'raise' | 'lower' | 'smooth' | 'flatten';
// No 'move': landscape mode is brushes only; a landscape is positioned with the scene-mode gizmo.
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
 * brush. Held in a ref: the brush reads it from pointer handlers that register once.
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
