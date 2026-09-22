import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  Scene, Node, LightNode, CameraNode, TerrainMaterial, engineEventBus, parseNodeJson,
  setGLContext, setDevice, WebGL2Device,
} from 'cleo';
import type { SceneChange } from 'cleo';
// From the engine SOURCE, which is what `cleo` is aliased to in this suite (see vitest.config.ts), so this
// is the same flag `Node._notifyChange` reads.
import { authoring } from '../../src/core/eventBus';
import { createAnimationEditorScene } from '../src/features/demoScene/createAnimationEditorScene';
import { createMaterialPreviewScene } from '../src/features/demoScene/createMaterialPreviewScene';
import {
  createModelPreviewScene, PREVIEW_KEY_LIGHT_NAME, PREVIEW_FILL_LIGHT_NAME,
} from '../src/features/demoScene/createModelPreviewScene';
import { useRigEditor } from '../src/features/hooks/useRigEditor';
import { useClipEditor } from '../src/features/hooks/useClipEditor';
import { useAnimationFieldEditor } from '../src/features/hooks/useAnimationFieldEditor';
import {
  setThumbnailDirtySuppressor, renderModelAssetThumbnail, bakeModelImpostor, renderTerrainMaterialAssetThumbnail,
} from '../src/utils/modelThumbnails';
import { registerFoliageSourceResolver, resolveFoliageRuleGeometry, setFoliageFlattenSuppressor } from '../src/utils/foliageRules';

/**
 * What the editor builds INTO a preview or throwaway scene must never read as the user's work.
 *
 * The contract has two halves, and every builder here has to satisfy one of them for every event it
 * causes: the event says it is editor-owned (`SceneChange.editorOwned`, which dirty tracking and the undo
 * recorder skip), or it fires inside the editor's `withoutDirty` bracket. Both matter. The flag rides on
 * the event, so it survives async continuations that no bracket covers — the preview skybox lands after
 * the cubemap loads, long after the tab has activated. The bracket is needed because the flag can only
 * reach a node through its ancestors, and the parser attaches bottom-up: a nested node is attached while
 * its parent is still detached and owned by nothing.
 *
 * Before this the preview lights were plain 'key'/'fill', the rig/clip/field holders were plain nodes named
 * after their asset, and `createAnimationEditorScene` inserted its skybox unbracketed — each of which
 * marked a tab unsaved or pushed an undo step the user never made.
 */

// The real one loads six cubemap images, which a node test cannot decode. What matters here is only what
// it was HANDED: the async skybox insert runs inside `opts.silently`, or inside nothing.
const env = vi.hoisted(() => ({ calls: [] as { scene: any; opts: any }[] }));
vi.mock('../src/features/demoScene/previewEnvironment', () => ({
  applyPreviewEnvironment: async (scene: any, opts?: any) => { env.calls.push({ scene, opts }); },
}));

// A skinned character cannot be built headless, so the preview hooks get a stand-in: a small NESTED subtree
// parsed the way `instantiateModelAsset` parses a real one. Nested on purpose — the inner node is the one
// that attaches while its parent is still detached. Pass-through whenever `fake.character` is unset.
const fake = vi.hoisted(() => ({ character: false }));
vi.mock('../src/utils/models', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/utils/models')>();
  return {
    ...orig,
    instantiateModelAsset: (...args: Parameters<typeof orig.instantiateModelAsset>) => {
      if (!fake.character) return orig.instantiateModelAsset(...args);
      parseNodeJson(args[1], {
        id: `char-${Math.random()}`, name: 'Mannequin',
        children: [{ id: `hips-${Math.random()}`, name: 'Hips', children: [] }],
      });
      return '';
    },
  };
});
vi.mock('../src/utils/animationFields', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/utils/animationFields')>();
  return {
    ...orig,
    firstSkinnedModelNode: (root: Node) => (fake.character ? (root.children[0] as any) ?? null : orig.firstSkinnedModelNode(root)),
  };
});

// `new Model` allocates buffers (the animation preview's ground is one), and a terrain patch builds chunks.
// The same stubbed context the other editor suites use: unknown members resolve to a no-op.
beforeAll(() => {
  let n = 0;
  const constants: Record<string, number> = {
    UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
  };
  const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
  const gl = new Proxy({}, {
    get: (_t, key: string) => (key in constants ? constants[key]
      : objects.has(key) ? () => ({ id: ++n })
      : () => undefined),
  });
  setGLContext(gl as any);
  setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
  // `awaitTexturesReady` waits one frame before resolving.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
});
afterAll(() => vi.unstubAllGlobals());

// Property events are gated on the authoring flag, which the editor turns on in edit mode. On here too, or
// the invariant below would pass by never seeing them.
let prevAuthoring = false;
beforeEach(() => {
  prevAuthoring = authoring.enabled;
  authoring.enabled = true;
  env.calls.length = 0;
  fake.character = false;
});
afterEach(() => {
  authoring.enabled = prevAuthoring;
  setThumbnailDirtySuppressor(fn => fn());
  registerFoliageSourceResolver(null);
});

/** A `withoutDirty` stand-in that knows whether it is open, and the events that fired while it was. */
function bracket() {
  let depth = 0;
  const withoutDirty = <T,>(fn: () => T): T => { depth++; try { return fn(); } finally { depth--; } };
  return { withoutDirty, isOpen: () => depth > 0 };
}

/**
 * Every SCENE_CHANGED emitted while `fn` runs (sync or async) that neither says it is editor-owned nor fired
 * inside the bracket: the events that would mark a tab unsaved or become an undo step.
 */
async function leaksDuring(isOpen: () => boolean, fn: () => unknown): Promise<string[]> {
  const leaks: string[] = [];
  const listener = (e: SceneChange) => {
    if (e.editorOwned !== true && !isOpen()) leaks.push(`${e.kind}/${e.prop ?? ''} ${e.node?.name ?? '(no node)'}`);
  };
  engineEventBus.on('SCENE_CHANGED', listener);
  try { await fn(); } finally { engineEventBus.off('SCENE_CHANGED', listener); }
  return leaks;
}

const lightNames = (scene: Scene) =>
  scene.root.children.filter((n): n is LightNode => n instanceof LightNode).map(n => n.name);

describe('preview scene builders', () => {
  it('the animation preview adds nothing the user owns, key light first', async () => {
    const scene = new Scene();
    const { isOpen } = bracket();
    const leaks = await leaksDuring(isOpen, () => createAnimationEditorScene(scene, [0, 1, 0], 1));

    expect(lightNames(scene)).toEqual([PREVIEW_KEY_LIGHT_NAME, PREVIEW_FILL_LIGHT_NAME]);
    // Camera, both lights and the shadow-catching ground.
    expect(scene.root.children.length).toBeGreaterThanOrEqual(4);
    for (const child of scene.root.children) expect(child.isEditorOwned, child.name).toBe(true);
    expect(leaks).toEqual([]);
  });

  it('the animation preview hands `silently` to its async environment attach', () => {
    const scene = new Scene();
    const { withoutDirty } = bracket();
    createAnimationEditorScene(scene, [0, 1, 0], 1, { silently: withoutDirty });
    const call = env.calls.find(c => c.scene === scene);
    expect(call?.opts?.silently).toBe(withoutDirty);
  });

  it('the material preview adds nothing the user owns, and keeps fill BEFORE key', async () => {
    // The deferred pipeline keeps only the last directional light uploaded, so the key has to come last
    // here or it stops lighting the sphere.
    const scene = new Scene();
    const { isOpen } = bracket();
    const leaks = await leaksDuring(isOpen, () => createMaterialPreviewScene(scene));

    expect(lightNames(scene)).toEqual([PREVIEW_FILL_LIGHT_NAME, PREVIEW_KEY_LIGHT_NAME]);
    for (const child of scene.root.children) expect(child.isEditorOwned, child.name).toBe(true);
    expect(leaks).toEqual([]);
  });

  it('the model preview adds nothing the user owns', async () => {
    const scene = new Scene();
    const { isOpen } = bracket();
    const leaks = await leaksDuring(isOpen, () => createModelPreviewScene(scene, [0, 0, 0], 1));

    expect(lightNames(scene)).toEqual([PREVIEW_KEY_LIGHT_NAME, PREVIEW_FILL_LIGHT_NAME]);
    for (const child of scene.root.children) expect(child.isEditorOwned, child.name).toBe(true);
    expect(leaks).toEqual([]);
  });
});

/**
 * The rig, clip and animation-field tabs save a PROVIDER working copy, never their scene, so every event in
 * that scene is spurious — including the preview character's own playback, which writes transforms every
 * frame.
 */
describe('asset-tab preview holders', () => {
  const rig = { id: 'rig-1', name: 'Mannequin Rig' } as any;
  const model = { id: 'model-1', name: 'Mannequin', rigId: 'rig-1' } as any;

  const commonDeps = (withoutDirty: <T>(fn: () => T) => T) => ({
    instanceRef: { current: {} as any },
    modelsRef: { current: [model] },
    materialsRef: { current: [] },
    animationsRef: { current: [] },
    tabRuntimeRef: { current: new Map<string, any>() },
    dirtyArmedRef: { current: true },
    eventEmitter: { current: { emit: () => {} } as any },
    tabs: [],
    setActiveTab: () => {},
    commitTab: () => {},
    withoutDirty,
  });

  /** The one runtime the open built, with its holder and the character under it. */
  const opened = (tabRuntimeRef: { current: Map<string, any> }) => {
    const rt = [...tabRuntimeRef.current.values()][0];
    const holder: Node = rt.scene.getNodeById(rt.rootId);
    return { rt, holder, character: holder.children[0] };
  };

  const expectOwnedPreview = (
    { rt, holder, character }: ReturnType<typeof opened>, name: string,
    withoutDirty: unknown,
  ) => {
    // The holder keeps its asset name (the Scene panel is name-based and still shows it)...
    expect(holder.name).toBe(name);
    // ...and is owned by the flag, which the character under it inherits all the way down.
    expect(holder.isEditorOwned).toBe(true);
    expect(character.name).toBe('Mannequin');
    expect(character.isEditorOwned).toBe(true);
    expect(character.children[0].isEditorOwned).toBe(true);
    // Both environments the tab stacks (asset-edit + animation preview) insert their skybox bracketed.
    const calls = env.calls.filter(c => c.scene === rt.scene);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.opts?.silently).toBe(withoutDirty);
  };

  it('rig tab', async () => {
    fake.character = true;
    const { withoutDirty, isOpen } = bracket();
    const deps = { ...commonDeps(withoutDirty), rigsRef: { current: [rig] }, updateRig: () => {}, clearTabDirty: () => {}, applyActiveTab: () => {}, activeTabId: '' };
    const { enterRigEditor } = useRigEditor(deps as any);

    const leaks = await leaksDuring(isOpen, () => enterRigEditor(rig.id));
    expectOwnedPreview(opened(deps.tabRuntimeRef), rig.name, withoutDirty);
    expect(leaks).toEqual([]);
  });

  it('clip tab', async () => {
    fake.character = true;
    const clip = { id: 'clip-1', name: 'Walk', rigId: rig.id } as any;
    const { withoutDirty, isOpen } = bracket();
    const deps = {
      ...commonDeps(withoutDirty), animationsRef: { current: [clip] }, rigsRef: { current: [rig] }, setTabs: () => {},
      updateAnimation: () => {}, addAnimation: () => {}, linkAnimationToRig: () => {}, applyAnimationLinks: () => {},
      modelAnimationIdsOf: () => [], clearTabDirty: () => {}, applyActiveTab: () => {}, activeTabId: '',
    };
    const { enterClipEditor } = useClipEditor(deps as any);

    const leaks = await leaksDuring(isOpen, () => enterClipEditor(clip.id));
    expectOwnedPreview(opened(deps.tabRuntimeRef), clip.name, withoutDirty);
    expect(leaks).toEqual([]);
  });

  it('animation field tab', async () => {
    fake.character = true;
    const field = { id: 'field-1', name: 'Locomotion', rigId: rig.id } as any;
    const { withoutDirty, isOpen } = bracket();
    const deps = {
      ...commonDeps(withoutDirty), animationFieldsRef: { current: [field] }, liveScenes: () => [],
      markTabDirty: () => {}, addAnimationField: () => {}, ensureRigForModel: () => rig.id, updateAnimationField: () => {},
    };
    const { enterAnimationFieldEditor } = useAnimationFieldEditor(deps as any);

    const leaks = await leaksDuring(isOpen, () => enterAnimationFieldEditor(field.id));
    expectOwnedPreview(opened(deps.tabRuntimeRef), field.name, withoutDirty);
    expect(leaks).toEqual([]);
  });

  it('a rig with no character still opens, holder owned', () => {
    const { withoutDirty } = bracket();
    const deps = {
      ...commonDeps(withoutDirty), modelsRef: { current: [] }, rigsRef: { current: [rig] },
      updateRig: () => {}, clearTabDirty: () => {}, applyActiveTab: () => {}, activeTabId: '',
    };
    useRigEditor(deps as any).enterRigEditor(rig.id);
    const { holder } = opened(deps.tabRuntimeRef);
    expect(holder.name).toBe(rig.name);
    expect(holder.isEditorOwned).toBe(true);
  });
});

/** Offscreen captures parse whole models into throwaway holders the user never sees. */
describe('thumbnail and impostor builders', () => {
  const subtree = () => ({
    id: 'tree-root', name: 'Tree', children: [{ id: 'branch', name: 'Branch', children: [] }],
  });
  const asset = () => ({ id: 'tree', name: 'Tree', nodeJson: subtree(), materialIds: [], thumbnail: '' }) as any;

  /** A renderer that records the scene it was asked to capture and hands back nothing. */
  const fakeEngine = (shots: Scene[]) => ({
    renderer: {
      gridVisible: true,
      setGridVisible: () => {},
      screenshotOffscreen: (s: Scene) => { shots.push(s); return Promise.resolve(''); },
    },
  }) as any;

  it('a model thumbnail emits nothing unbracketed or unowned', async () => {
    const shots: Scene[] = [];
    const { withoutDirty, isOpen } = bracket();
    setThumbnailDirtySuppressor(withoutDirty);

    const leaks = await leaksDuring(isOpen, () => renderModelAssetThumbnail(fakeEngine(shots), asset()));
    expect(leaks).toEqual([]);
    expect(shots).toHaveLength(1);
    expect(lightNames(shots[0])).toEqual([PREVIEW_KEY_LIGHT_NAME, PREVIEW_FILL_LIGHT_NAME]);
  });

  it("the '__thumb' holder flags its own attach even with no suppressor installed", async () => {
    // Thumbnails can render before the editor mounts and installs `withoutDirty`.
    const adds: SceneChange[] = [];
    const listener = (e: SceneChange) => { if (e.prop === 'add' && e.node?.name === 'Tree') adds.push({ ...e }); }; // copied DURING the dispatch: the ownership stamp is read against the live tree
    engineEventBus.on('SCENE_CHANGED', listener);
    try { await renderModelAssetThumbnail(fakeEngine([]), asset()); }
    finally { engineEventBus.off('SCENE_CHANGED', listener); }
    expect(adds).toHaveLength(1);
    expect(adds[0].editorOwned).toBe(true);
  });

  it('an impostor bake emits nothing unbracketed or unowned, and its camera is owned', async () => {
    const shots: Scene[] = [];
    const { withoutDirty, isOpen } = bracket();
    setThumbnailDirtySuppressor(withoutDirty);

    const leaks = await leaksDuring(isOpen, () => bakeModelImpostor(fakeEngine(shots), asset()));
    expect(leaks).toEqual([]);
    expect(shots).toHaveLength(1);
    // `__impostor__` is not an editor marker, so only the flag makes the capture camera owned.
    const cam = shots[0].root.children.find(n => n instanceof CameraNode)!;
    expect(cam.name).toBe('__impostor__Camera');
    expect(cam.isEditorOwned).toBe(true);
    expect(lightNames(shots[0])).toEqual([PREVIEW_KEY_LIGHT_NAME, PREVIEW_FILL_LIGHT_NAME]);
  });

  it("a terrain-material thumbnail parses its asset INSIDE the suppressor", async () => {
    // The parse re-derives each mesh foliage rule by flattening its model, whose nodes carry user names.
    const { withoutDirty, isOpen } = bracket();
    setThumbnailDirtySuppressor(withoutDirty);
    let resolvedInside: boolean | null = null;
    registerFoliageSourceResolver(() => {
      resolvedInside = isOpen();
      return { model: asset(), library: [asset()], materials: [] };
    });
    const tm = TerrainMaterial.Create('pbr', {});
    tm.foliageInclude = [{ kind: 'mesh', id: 'rule-1', name: 'Tree', modelId: 'tree', density: 0.05, densityUnit: 'm2' }] as any;
    const terrainAsset = { id: 'tm-1', name: 'Grass', material: tm.serialize(), thumbnail: '' };

    const leaks = await leaksDuring(isOpen, () => renderTerrainMaterialAssetThumbnail(fakeEngine([]), terrainAsset));
    expect(resolvedInside).toBe(true);
    expect(leaks).toEqual([]);
  });
});

describe('foliage prototype flatten', () => {
  // A plain subtree flattens to no meshes, which is fine: what is under test is what the PARSE emits.
  const source = () => ({
    model: { id: 'tree', name: 'Tree', nodeJson: { id: 'r', name: 'Tree', children: [{ id: 'b', name: 'Branch', children: [] }] } } as any,
    library: [], materials: [],
  });
  const rule = () => ({ kind: 'mesh', id: 'rule-1', name: 'Tree', modelId: 'tree' });

  it('emits nothing unbracketed or unowned once the editor installs its suppressor', async () => {
    // Installed through the thumbnail setter, which is the one EngineContext calls.
    const { withoutDirty, isOpen } = bracket();
    setThumbnailDirtySuppressor(withoutDirty);
    registerFoliageSourceResolver(() => source());
    const leaks = await leaksDuring(isOpen, () => resolveFoliageRuleGeometry(rule()));
    expect(leaks).toEqual([]);
  });

  it("flags the '__foliage_flatten' holder's own attach with no suppressor at all", () => {
    setFoliageFlattenSuppressor(fn => fn());
    registerFoliageSourceResolver(() => source());
    const adds: SceneChange[] = [];
    const listener = (e: SceneChange) => { if (e.prop === 'add' && e.node?.name === 'Tree') adds.push({ ...e }); }; // copied DURING the dispatch: the ownership stamp is read against the live tree
    engineEventBus.on('SCENE_CHANGED', listener);
    try { resolveFoliageRuleGeometry(rule()); } finally { engineEventBus.off('SCENE_CHANGED', listener); }
    expect(adds).toHaveLength(1);
    expect(adds[0].editorOwned).toBe(true);
  });

  it('still bakes a real mesh: ownership changes nothing the flatten outputs', () => {
    const { withoutDirty } = bracket();
    setFoliageFlattenSuppressor(withoutDirty);
    const geometry = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      tangents: new Float32Array(9), bitangents: new Float32Array(9),
      texCoords: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    };
    registerFoliageSourceResolver(() => ({
      model: { id: 'oak', name: 'Oak', nodeJson: {
        id: 'oak-root', name: 'Oak', position: [0, 2, 0],
        children: [{ id: 'leaf', type: 'model', name: 'Leaf', model: { geometry, material: { type: 'pbr' } }, children: [] }],
      } } as any,
      library: [], materials: [],
    }));
    const r: any = { kind: 'mesh', id: 'rule-oak', name: 'Oak', modelId: 'oak' };
    resolveFoliageRuleGeometry(r);
    expect(r.models).toHaveLength(1);
    // The level root's +2 Y is baked into the vertices, so the transform chain still resolves through the holder.
    expect(Array.from(r.models[0].geometry.positions.slice(0, 3))).toEqual([0, 2, 0]);
  });
});
