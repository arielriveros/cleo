import EventEmitter from '../../utils/eventEmitter';
import { Logger, Scene, ModelNode, Model, Geometry, Material, ParticleSystemNode, CleoEngine, markEditorOwned } from 'cleo';
import { cryptoRandomId } from '../../utils/ids';
import {
  ParticleSystemAsset, PARTICLE_PREVIEW_NODE_NAME, buildParticleSystemAsset, reembedParticleSystems, toRuntimeSystem,
} from '../../utils/particleSystems';
import { createAssetEditScene } from '../demoScene/createAssetEditScene';
import { addPreviewLights } from '../demoScene/createModelPreviewScene';
import { SCENE_TAB_ID } from '../engineContextTypes';
import type { EditorTab } from '../engineContextTypes';

type TabRuntime = { scene: Scene; rootId: string };

/** Side of the preview ground, in metres: wide enough that a fountain's splash lands on it. */
const GROUND_SIZE = 20;
/** Where the preview camera looks — about the height of a campfire's flames or a torch's head. */
const LOOK_AT: [number, number, number] = [0, 1.5, 0];
const VIEW_DISTANCE = 8;
// The editor camera's fixed [30,-135,0] rotation looks down -normalize([1,1,1]) (see makeEditorCamera),
// so standing it at target + normalize([1,1,1]) * d frames the target at the centre of the view.
const DIAG = 1 / Math.sqrt(3);

/**
 * The particle-system editor slice, in the shape of `useAnimationFieldEditor` for the 3D half and
 * `useAiBrainEditor` for the asset half.
 *
 * Like the field slice it owns no authoring state — the working copy lives in ParticleEditorProvider,
 * which drives the preview node this builds — but opening, minting, linking and saving belong together:
 * minting a new effect immediately opens it, and saving one has to push the new definition into every
 * live scene already playing a copy.
 */
export function useParticleSystemEditor(deps: {
  instanceRef: React.MutableRefObject<CleoEngine | null>;
  particleSystemsRef: React.MutableRefObject<ParticleSystemAsset[]>;
  tabRuntimeRef: React.MutableRefObject<Map<string, TabRuntime>>;
  editorSceneRef: React.MutableRefObject<Scene>;
  dirtyArmedRef: React.MutableRefObject<boolean>;
  eventEmitter: React.MutableRefObject<EventEmitter>;
  tabsRef: React.MutableRefObject<EditorTab[]>;
  setTabs: React.Dispatch<React.SetStateAction<EditorTab[]>>;
  setActiveTab: (id: string) => void;
  commitTab: (tab: EditorTab, adoptTabId?: string) => void;
  withoutDirty: <T,>(fn: () => T) => T;
  markTabDirty: (id: string, reason?: string) => void;
  clearTabDirty: (id: string) => void;
  addParticleSystem: (p: ParticleSystemAsset) => void;
  updateParticleSystem: (id: string, p: ParticleSystemAsset) => void;
}) {
  const {
    instanceRef, particleSystemsRef, tabRuntimeRef, editorSceneRef, dirtyArmedRef, eventEmitter,
    tabsRef, setTabs, setActiveTab, commitTab, withoutDirty, markTabDirty, clearTabDirty,
    addParticleSystem, updateParticleSystem,
  } = deps;

  /**
   * Build the throwaway staging scene a particle tab previews its effect in: the asset-edit environment
   * (editor camera, a shadow-casting light, the preview cubemap) plus the key/fill pair, a ground, and ONE
   * editor-owned ParticleSystemNode playing the effect.
   *
   * The ground is real, opaque, depth-writing geometry — not a helper. Particles with depth collision
   * bounce off whatever is in the depth buffer, and an effect authored over empty sky would never show
   * the author that its sparks fall through the floor. The `__editor__` name keeps it out of the tree,
   * saves and probe captures while it still draws as lit content (see `Node.isEditorOwned`).
   */
  const buildPreviewScene = (asset: ParticleSystemAsset): { scene: Scene; node: ParticleSystemNode } => {
    const scene = new Scene();
    scene.spawnRulesEnabled = false;
    // The default is already on, but this tab is MEANINGLESS without it — the viewport's "preview
    // particles" toggle must never leave an effect editor showing a frozen effect.
    scene.particlePreview = true;
    void createAssetEditScene(scene, withoutDirty);
    addPreviewLights(scene);

    // Top face a centimetre under y = 0: close enough that a y = 0 collision plane and the ground agree on
    // where the floor is, far enough that the editor grid drawn AT y = 0 does not z-fight the surface.
    const thickness = 0.02;
    const sink = 0.01;
    const ground = new ModelNode('__editor__ground',
      new Model(Geometry.Cube(GROUND_SIZE, thickness, GROUND_SIZE),
        Material.Default({ diffuse: [0.32, 0.33, 0.38] }, { castShadow: false })));
    ground.setPosition([0, -thickness / 2 - sink, 0]);
    scene.addNode(ground);

    // Editor-OWNED through the flag rather than a name marker (see PARTICLE_PREVIEW_NODE_NAME): this tab
    // saves the provider's working copy, never scene content, so nothing this node emits — and pushing a
    // new definition into it emits on every edit — may mark the tab unsaved or become an undo step.
    // `particleSystemId` stays null on purpose: the provider pushes its unsaved working copy here, and a
    // link would let a save's re-embed restart the preview under the author's hands.
    const node = markEditorOwned(new ParticleSystemNode(PARTICLE_PREVIEW_NODE_NAME, {
      system: toRuntimeSystem(asset),
      playOnStart: true,
    }));
    withoutDirty(() => scene.addNode(node));

    const cam = scene.activeCamera;
    if (cam) {
      const d = VIEW_DISTANCE * DIAG;
      cam.setPosition([LOOK_AT[0] + d, LOOK_AT[1] + d, LOOK_AT[2] + d]);
    }
    scene.root.updateTransforms();
    return { scene, node };
  };

  /**
   * Open (or focus) a particle system's tab, minting a new asset when called with no id (the
   * "+ Add > Particle System" path).
   */
  const enterParticleSystemEditor = (id?: string | null, adoptTabId?: string) => {
    if (!instanceRef.current) return;
    let asset = id ? particleSystemsRef.current.find(p => p.id === id) : undefined;

    if (!id) {
      asset = buildParticleSystemAsset();
      addParticleSystem(asset);
      // The library update lands in the next commit, so seed the ref directly — otherwise the tab opens
      // against state that does not yet contain the asset it was just given.
      particleSystemsRef.current = [...particleSystemsRef.current, asset];
    }
    if (!asset) { Logger.error('Particle system not found', 'Editor'); return; }

    if (!adoptTabId && id) {
      const existing = tabsRef.current.find(t => t.kind === 'particleSystem' && t.particleSystemId === id);
      if (existing) { setActiveTab(existing.id); return; }
    }

    // Disarm before constructing the preview scene — see openMeshTab for why this is not optional. The
    // tab's activation re-arms it.
    dirtyArmedRef.current = false;
    const { scene, node } = buildPreviewScene(asset);
    // Started, unlike most preview scenes: `playOnStart` is honoured from `onStart`, so an unstarted
    // scene would show an effect that never begins.
    scene.start();
    if (!node.isPlaying) node.play();

    const tabId = adoptTabId ?? cryptoRandomId();
    tabRuntimeRef.current.set(tabId, { scene, rootId: node.id });
    commitTab({ id: tabId, kind: 'particleSystem', title: asset.name, particleSystemId: asset.id }, adoptTabId);
    // Sprite textures resolve through the TextureManager; let texture-aware panels see the new scene.
    eventEmitter.current.emit('TEXTURES_CHANGED');
  };

  /** Copy a library effect onto a node and record the link; null unlinks and leaves the copy playing. */
  const linkParticleSystemToNode = (node: ParticleSystemNode, id: string | null) => {
    if (!id) { node.particleSystemId = null; return; }
    const asset = particleSystemsRef.current.find(p => p.id === id);
    if (!asset) { Logger.warn('Particle system not found', 'Editor'); return; }
    node.setSystem(toRuntimeSystem(asset));
    node.particleSystemId = id;
  };

  /**
   * Turn a node's embedded effect into a library asset and link it — the "Create asset from this effect"
   * button. COPIED, never moved: the node keeps playing exactly what it was playing.
   *
   * Returns the new asset, not just its id — a caller wanting to open it immediately cannot find it in
   * `particleSystems` yet, since that state update lands a commit later.
   */
  const extractParticleSystemFromNode = (node: ParticleSystemNode, name?: string): ParticleSystemAsset => {
    const asset = buildParticleSystemAsset(name?.trim() || node.name, node.system);
    addParticleSystem(asset);
    particleSystemsRef.current = [...particleSystemsRef.current, asset];
    node.particleSystemId = asset.id;
    return asset;
  };

  /**
   * Persist an edited effect and push it into every node already holding a copy. The re-embed is what
   * keeps embed-on-link honest: a node stores a COPY, so without it an edit would only reach nodes linked
   * again afterwards. Every live scene is walked, and the tab owning each changed scene is marked unsaved —
   * its nodes now hold a definition its saved blob does not.
   */
  const saveParticleSystem = (asset: ParticleSystemAsset) => {
    updateParticleSystem(asset.id, asset);
    const assets = particleSystemsRef.current.map(p => p.id === asset.id ? asset : p);
    particleSystemsRef.current = assets;

    let count = 0;
    const touched = (tabId: string, scene: Scene) => {
      const n = reembedParticleSystems(scene, assets);
      if (n) { count += n; markTabDirty(tabId, 'particle-system-reembed'); }
    };
    touched(SCENE_TAB_ID, editorSceneRef.current);
    for (const [tabId, rt] of tabRuntimeRef.current) touched(tabId, rt.scene);
    if (count) eventEmitter.current.emit('SCENE_CHANGED');

    const open = tabsRef.current.find(t => t.kind === 'particleSystem' && t.particleSystemId === asset.id);
    if (open) {
      clearTabDirty(open.id);
      if (open.title !== asset.name) setTabs(prev => prev.map(t => t.id === open.id ? { ...t, title: asset.name } : t));
    }
    Logger.info(`Particle system "${asset.name}" saved${count ? ` (updated ${count} node${count === 1 ? '' : 's'})` : ''}`, 'Editor');
  };

  return { enterParticleSystemEditor, linkParticleSystemToNode, extractParticleSystemFromNode, saveParticleSystem };
}
