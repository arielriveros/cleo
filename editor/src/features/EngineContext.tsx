import { createContext, useContext, useState, useRef, useEffect } from "react";
import { CleoEngine, Scene, Camera, LightNode, DirectionalLight, CameraNode, InputManager, Model, Geometry, Material, Node, ModelNode, Vec, TextureManager, SpriteNode, Sprite, Logger } from "cleo";
import NullImage from '../images/null.png';
import DinosaurImage from '../images/dinosaur.png';
import LightIcon from '../icons/light.png';
import EventEmitter from "events";
import { createEmptyScene, ensureEditorCamera } from './demoScene/createEmptyScene';
import { createMaterialPreviewScene } from './demoScene/createMaterialPreviewScene';
import { UIElement, UIState, cryptoRandomId } from "../utils/UIModel";
import { UIRuntime, GameActions } from "./uiInspector/uiRuntime";
import { Template, buildTemplateFromNode, instantiateTemplate, TEMPLATE_ID_VAR } from "../utils/templates";
import { MaterialAsset, buildMaterialAsset, applyMaterialAsset, getMaterialIdOf, getNodeMaterial, unlinkToFallback } from "../utils/materials";
import { buildGameData } from "./publish/buildGameData";
import { loadProject, applyGameData, saveProject, ProjectPrefs } from "../utils/projectStorage";
import { idbGet, idbSet } from "../utils/idb";
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

type PlaneShapeDescription = {
  type: 'plane';
  offset: number[];
  rotation: number[];
};

export type BodyDescription = {
  mass: number;
  linearDamping: number;
  angularDamping: number;
  linearConstraints: [number, number, number];
  angularConstraints: [number, number, number];
  shapes: ShapeDescription[];
}
export type ShapeDescription = BoxShapeDescription | SphereShapeDescription | CylinderShapeDescription | PlaneShapeDescription;

export type LoadingProgress = { loaded: number; total: number; label: string };

export type EditorMode = 'scene' | 'landscape' | 'template' | 'renderer' | 'material';
export type SavingState = 'idle' | 'saving' | 'saved' | 'error';

// Browser-style editor tabs. The 'main' tab hosts the real game scene and its scene/landscape/
// renderer sub-mode; template and material tabs each own a live edit session (a throwaway Scene in
// tabRuntimeRef). `editorMode` is derived from the active tab (see EngineProvider).
export type TabKind = 'main' | 'template' | 'material';
export interface EditorTab {
  id: string;
  kind: TabKind;
  title: string;
  templateId?: string | null; // template tabs: source template id, null = unsaved new template
  materialId?: string | null; // material tabs: source material asset id, null = unsaved new material
}
export type TerrainTool = 'raise' | 'lower' | 'smooth' | 'flatten';
export type TerrainBrushMode = 'sculpt' | 'paint' | 'foliage';
export type TerrainBrushState = {
  mode: TerrainBrushMode;
  tool: TerrainTool;
  radius: number;
  strength: number;
  falloff: number;
  /** Active splat layer (0..3) for the paint tool. */
  paintLayer: number;
  /** Active foliage layer index for the foliage tool. */
  foliageLayer: number;
  /** When true the foliage tool erases instead of scatters. */
  foliageErase: boolean;
  /** Id of the landscape node currently being edited (set by the inspector). */
  activeLandscapeId: string | null;
};

// Create a context to hold the engine and scene
const EngineContext = createContext<{
  instance: CleoEngine | null;
  editorScene: Scene;
  eventEmitter: EventEmitter;
  selectedNode: string | null;
  isGizmoDragging: boolean;
  isPlayMode: boolean;
  isSceneReady: boolean;
  editorMode: EditorMode;
  setEditorMode: (mode: EditorMode) => void;
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
  // Template editor
  enterTemplateEditor: (templateId?: string) => void;
  editingTemplateName: string | null;
  templateRootId: string | null;
  // Material editor
  enterMaterialEditor: (materialId?: string) => void;
  createMaterialForNode: (node: Node) => void;
  editingMaterialName: string | null;
  setActiveMaterialName: (name: string) => void;
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
  // Project persistence
  saveProject: () => void;
  savingState: SavingState;
  }>({
    instance: null,
    editorScene: new Scene(),
    eventEmitter: new EventEmitter(),
    selectedNode: null,
    isGizmoDragging: false,
    isPlayMode: false,
    isSceneReady: false,
    editorMode: 'scene',
    setEditorMode: () => {},
    tabs: [{ id: 'main', kind: 'main', title: 'Main' }],
    activeTabId: 'main',
    activeTab: { id: 'main', kind: 'main', title: 'Main' },
    dirtyTabs: {},
    setActiveTab: () => {},
    closeTab: () => {},
    reorderTabs: () => {},
    saveActiveTemplate: () => {},
    saveActiveMaterial: () => {},
    enterTemplateEditor: () => {},
    editingTemplateName: null,
    templateRootId: null,
    enterMaterialEditor: () => {},
    createMaterialForNode: () => {},
    editingMaterialName: null,
    setActiveMaterialName: () => {},
    terrainBrush: { current: { mode: 'sculpt', tool: 'raise', radius: 10, strength: 8, falloff: 0.5, paintLayer: 0, foliageLayer: 0, foliageErase: false, activeLandscapeId: null } },
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
    saveProject: () => {},
    savingState: 'idle',
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
  // Editor tabs: the Main tab (real game scene) plus any open template tabs. Each template tab's live
  // scene + root live in tabRuntimeRef (not React state — Scene objects shouldn't be serialized).
  const [tabs, setTabs] = useState<EditorTab[]>([{ id: 'main', kind: 'main', title: 'Main' }]);
  const [activeTabId, setActiveTabId] = useState<string>('main');
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({}); // tab id -> has unsaved edits
  const tabRuntimeRef = useRef<Map<string, { scene: Scene; rootId: string }>>(new Map());
  const activeTabIdRef = useRef<string>('main');
  const activeTabKindRef = useRef<TabKind>('main');
  const dirtyArmedRef = useRef(false); // suppress false-dirty from the helper reconciler right after open
  const [savingState, setSavingState] = useState<SavingState>('idle');
  const dimensionRef = useRef<'2D' | '3D'>('3D'); // the Main tab's dimension (template tabs are always 3D)
  const pendingPrefsRef = useRef<ProjectPrefs | null>(null);
  const terrainBrush = useRef<TerrainBrushState>({ mode: 'sculpt', tool: 'raise', radius: 10, strength: 8, falloff: 0.5, paintLayer: 0, foliageLayer: 0, foliageErase: false, activeLandscapeId: null });
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
  useEffect(() => {
    if (!templatesLoadedRef.current) return;
    idbSet('cleo_templates', templates).catch(e => console.warn('Failed to persist templates:', e));
  }, [templates]);

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
  useEffect(() => {
    if (!materialsLoadedRef.current) return;
    idbSet('cleo_materials', materials).catch(e => console.warn('Failed to persist materials:', e));
  }, [materials]);

  const addMaterial = (m: MaterialAsset) => setMaterials(prev => [...prev, m]);
  const updateMaterial = (id: string, m: MaterialAsset) => setMaterials(prev => prev.map(x => x.id === id ? m : x));

  // Derive the active tab and everything that used to hang off `editorMode === 'template'`.
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
  const activeRuntime = (activeTab.kind === 'template' || activeTab.kind === 'material') ? tabRuntimeRef.current.get(activeTab.id) : undefined;
  // The scene the inspectors/gizmo/AddNew currently edit: the game scene (Main tab) or a template/material scene.
  const activeScene = activeRuntime ? activeRuntime.scene : editorSceneRef.current;
  // Legacy single mode value, now derived from the active tab kind. Keeps every existing
  // `editorMode === ...` consumer working unchanged.
  const editorMode: EditorMode = activeTab.kind === 'main' ? mainMode : activeTab.kind === 'material' ? 'material' : 'template';
  const templateRootId = activeTab.kind === 'template' && activeRuntime ? activeRuntime.rootId : null;
  const editingTemplateName = activeTab.kind === 'template' ? activeTab.title : null;
  const editingMaterialName = activeTab.kind === 'material' ? activeTab.title : null;

  const engineMaps = () => ({ scripts: scriptsRef.current, bodies: bodiesRef.current, triggers: triggersRef.current });

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
    createEmptyScene(scene); // editor camera + a light so the template content is lit

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

  // Public mode switch — only the Main tab's sub-mode (scene/landscape/renderer). Template editing is
  // a tab now (opened via enterTemplateEditor), not a mode, so 'template' is not accepted here.
  const setEditorMode = (mode: EditorMode) => {
    if (mode === 'scene' || mode === 'landscape' || mode === 'renderer') setMainMode(mode);
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
    tabRuntimeRef.current.delete(id);
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
    if (instances.length) {
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
    createMaterialPreviewScene(scene);

    if (asset) {
      for (const t of asset.textures || []) {
        if (t?.id && !TextureManager.Instance.getTexture(t.id)) TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id);
      }
    }
    const material: Material = asset ? Material.parse(asset.material) : Material.PBR({});
    const sphere = new ModelNode('preview', new Model(Geometry.Sphere(48), material));
    scene.addNode(sphere);
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
      const thumbnail = instance.renderer.screenshot(runtime.scene, 256);
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

  // Keep non-reactive mirrors of the active tab (read by the once-registered SCENE_CHANGED/dimension listeners).
  useEffect(() => { activeTabIdRef.current = activeTabId; activeTabKindRef.current = activeTab.kind; }, [activeTabId, activeTab.kind]);

  // Switch the engine to the active tab's scene whenever the active tab changes.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    const tab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
    activeTabKindRef.current = tab.kind;
    const runtime = (tab.kind === 'template' || tab.kind === 'material') ? tabRuntimeRef.current.get(tab.id) : undefined;
    instance.setScene(runtime ? runtime.scene : editorSceneRef.current);
    // Hide the editor ground grid in material tabs so the preview sphere + its thumbnail stay clean.
    instance.renderer.setGridVisible(tab.kind !== 'material');
    // Arm dirty-tracking only after the editor-helper reconciler's initial pass settles (it emits
    // SCENE_CHANGED as it adds light/gizmo helpers to the freshly-shown template scene).
    dirtyArmedRef.current = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { dirtyArmedRef.current = (tab.kind === 'template' || tab.kind === 'material'); }));
    // Template scenes are authored in 3D; the Main tab restores its own remembered dimension. Material
    // tabs are skipped: their preview camera uses a self-contained orbit rig (createMaterialPreviewScene)
    // that the free-fly CHANGE_DIMENSION handler must not overwrite.
    if (tab.kind !== 'material')
      eventEmitter.current.emit('CHANGE_DIMENSION', tab.kind === 'main' ? dimensionRef.current : '3D');
    eventEmitter.current.emit('TEXTURES_CHANGED');
    eventEmitter.current.emit('SCENE_CHANGED');
    eventEmitter.current.emit('SELECT_NODE', runtime ? runtime.rootId : null);
  }, [activeTabId]);

  // Mark the active template tab dirty on scene edits (after the open-settle window).
  useEffect(() => {
    const mark = () => {
      if (!dirtyArmedRef.current || (activeTabKindRef.current !== 'template' && activeTabKindRef.current !== 'material')) return;
      const id = activeTabIdRef.current;
      setDirtyTabs(prev => prev[id] ? prev : { ...prev, [id]: true });
    };
    const emitter = eventEmitter.current;
    emitter.on('SCENE_CHANGED', mark);
    return () => { emitter.off('SCENE_CHANGED', mark); };
  }, []);

  const saveProjectToStorage = async () => {
    setSavingState('saving');
    try {
      // Race against a timeout as a defensive backstop so the UI never gets stuck "saving".
      const ok = await Promise.race<boolean>([
        saveProject({
          scene: editorSceneRef.current,
          scripts: scriptsRef.current,
          bodies: bodiesRef.current,
          triggers: triggersRef.current,
          ui: uiStateRef.current,
          prefs: { dimension: dimensionRef.current, selectedNode },
        }),
        new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error('Save timed out')), 15000)),
      ]);
      if (ok) { Logger.info('Project saved', 'Editor'); setSavingState('saved'); }
      else { setSavingState('error'); }
    } catch (e: any) {
      Logger.error('Save failed: ' + (e?.message || e), 'Editor');
      setSavingState('error');
    } finally {
      setTimeout(() => setSavingState('idle'), 2000);
    }
  };

  // Startup: restore the saved project if present, otherwise open a blank scene.
  const setupInitialScene = async () => {
    const project = await loadProject();
    if (project) {
      applyGameData(project, { ...engineMaps(), scene: editorSceneRef.current, setUI: setUiState });
      ensureEditorCamera(editorSceneRef.current);
      pendingPrefsRef.current = project.prefs ?? null;
    } else {
      createEmptyScene(editorSceneRef.current);
      pendingPrefsRef.current = null;
    }
  };

  useEffect(() => {
      const initializeEngine = async () => {
        try {
          const engine = new CleoEngine({
              graphics: {
                  clearColor: [0.65, 0.65, 0.71, 1.0],
              },
          });

          instanceRef.current = engine;
          instanceRef.current.isPaused = false;

          CleoEngine.eventEmitter.on('LOG', (log) => { eventEmitter.current.emit('LOG', log) });
          CleoEngine.eventEmitter.on('SCENE_CHANGED', () => { eventEmitter.current.emit('SCENE_CHANGED') });
          
          await setupInitialScene();

          TextureManager.Instance.addTextureFromBase64(NullImage, {}, 'Null');
          TextureManager.Instance.addTextureFromBase64(DinosaurImage, {}, 'dinosaur.png');
          TextureManager.Instance.addTextureFromBase64(LightIcon, {
            mipMap: false
          }, '__editor__light_icon');
          eventEmitter.current.emit('TEXTURES_CHANGED');

          // Setting the editor scene and camera
          engine.setScene(editorSceneRef.current);
          editorSceneRef.current.start();

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
      // Material preview scenes want no editor helper icons (light sprites/gizmos) cluttering the sphere.
      if (isPlayMode || !activeScene || editorMode === 'material') return;
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
        cameraNode.onUpdate = (node, delta, time) => {
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
        cameraNode.onUpdate = (node, delta, time) => {
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
      
      // Use stencil-based outlining instead of creating outline nodes
      if (instanceRef.current && instanceRef.current.renderer) {
        instanceRef.current.renderer.setSelectedNode(node);
        console.log('Selection updated in renderer:', node);
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
  const buildPlayScene = async (): Promise<Scene> => {
    // useCache: true — textures already live in TextureManager for in-editor play, so skip re-embedding.
    const json = await buildGameData({
      scene: editorSceneRef.current,
      scripts: scriptsRef.current,
      bodies: bodiesRef.current,
      triggers: triggersRef.current,
      ui: uiStateRef.current,
      useCache: true,
    });
    const newScene = new Scene();
    newScene.parse(json, true);
    return newScene;
  };
  const startUIRuntime = () => {
    UIRuntime.start(uiStateRef.current.elements, {
      emit: (n) => eventEmitter.current.emit(n),
      getScene: () => instanceRef.current?.scene,
      game,
    });
  };
  const startPlay = async () => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.input.preventDefault();
    if (startedRef.current) { eventEmitter.current.emit('SET_PLAY_STATE', 'play'); return; }
    const newScene = await buildPlayScene();
    instance.setScene(newScene);
    instance.isPaused = false;
    setTimeout(() => { instance.scene.start(); startUIRuntime(); }, 100);
    eventEmitter.current.emit('SET_PLAY_STATE', 'play');
    startedRef.current = true;
  };
  const stopPlay = () => {
    startedRef.current = false;
    const instance = instanceRef.current;
    UIRuntime.stop();
    if (!instance) return;
    instance.setScene(editorSceneRef.current);
    instance.input.clear();
    instance.physics.clear();
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
    const newScene = await buildPlayScene();
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
      eventEmitter: eventEmitter.current,
      selectedNode,
      isGizmoDragging,
      isPlayMode,
      isSceneReady,
      editorMode,
      setEditorMode,
      tabs,
      activeTabId,
      activeTab,
      dirtyTabs,
      setActiveTab,
      closeTab,
      reorderTabs,
      saveActiveTemplate,
      saveActiveMaterial,
      enterTemplateEditor,
      editingTemplateName,
      templateRootId,
      enterMaterialEditor,
      createMaterialForNode,
      editingMaterialName,
      setActiveMaterialName,
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
      saveProject: saveProjectToStorage,
      savingState,
    }}>
    {props.children}
  </EngineContext.Provider>
  );
}