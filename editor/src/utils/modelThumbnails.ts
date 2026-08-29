import { Scene, Node, ModelNode, Model, Geometry, Material, TextureManager, CleoEngine, AnimatedModel, Terrain } from 'cleo';
import { createModelPreviewScene } from '../features/demoScene/createModelPreviewScene';
import { createMaterialPreviewScene } from '../features/demoScene/createMaterialPreviewScene';
import { fitDistance, MATERIAL_SPHERE_RADIUS, previewSphereGeometry, PREVIEW_TERRAIN_RADIUS } from '../features/demoScene/previewFraming';
import { buildTerrainPreviewSubject } from '../features/demoScene/previewTerrainSubject';
import type { MaterialAsset } from './materials';
import { ModelAsset } from './models';
import { parseByType, regenerateIds } from './nodeSubtree';
import { TerrainMaterialAsset, parseTerrainMaterialAsset } from './terrainMaterials';
import { awaitTexturesReady } from './textureReady';

const THUMB_SIZE = 256;

// Texture ids a material references, empties skipped.
export function materialTextureIds(material: Material): string[] {
  const textures = (material.serialize() as any)?.textures;
  if (!textures || typeof textures !== 'object') return [];
  return Object.values(textures).filter((v): v is string => typeof v === 'string' && !!v);
}

/**
 * Push the camera node's world transform into its Camera.
 * `Camera` is normally synced by `CameraNode.update()` from `scene.update()`, which never runs for a
 * throwaway preview scene — without this the capture renders from a camera still at the origin.
 */
function syncPreviewCamera(scene: Scene): void {
  scene.root.updateTransforms();
  const cam = scene.activeCamera;
  if (cam) cam.update(0, 0);
}

// Capture a scene to a base64 PNG with the ground grid hidden, then restored.
//
// The restore must NOT be awaited: `screenshotOffscreen` has already drawn the frame by the time it
// returns its promise, so the grid goes back on immediately. Awaiting first leaves the live viewport
// without its grid for the whole readback, which on WebGPU is a visible gap.
async function captureClean(engine: CleoEngine, scene: Scene): Promise<string> {
  const prevGrid = engine.renderer.gridVisible;
  engine.renderer.setGridVisible(false);
  let pending: Promise<string>;
  try {
    syncPreviewCamera(scene);
    pending = engine.renderer.screenshotOffscreen(scene, THUMB_SIZE);
  } finally {
    engine.renderer.setGridVisible(prevGrid);
  }
  return pending;
}

/**
 * Capture the material editor's live preview sphere.
 * The camera is dollied back out to the sphere's fit distance for the capture only, keeping the user's
 * orbit orientation. The orbit controller must be muted while dollied or it snaps the camera back.
 */
export function captureMaterialSphere(engine: CleoEngine, scene: Scene): Promise<string> {
  const cam = scene.activeCamera;
  if (!cam) return captureClean(engine, scene);

  const fit = fitDistance(MATERIAL_SPHERE_RADIUS);
  const prev: [number, number, number] = [cam.position[0], cam.position[1], cam.position[2]];
  const dollied = Math.hypot(prev[0], prev[1], prev[2]) < fit;
  const prevOnUpdate = cam.onUpdate;
  try {
    if (dollied) {
      cam.onUpdate = () => {};
      cam.setPosition([0, 0, -fit]); // the rig looks down its local -Z at the pivot (the sphere)
    }
    // The promise, not its value — see the note in `captureClean`: the frame is already drawn.
    return captureClean(engine, scene);
  } finally {
    if (dollied) {
      cam.setPosition(prev);
      cam.onUpdate = prevOnUpdate; // the game loop's next update restores the live view
    }
  }
}

export function collectModelNodes(node: Node, out: ModelNode[]): void {
  if ((node as any).nodeType === 'model') out.push(node as ModelNode);
  for (const c of node.children) collectModelNodes(c, out);
}

/**
 * Union of every child ModelNode's world-space bounding sphere (center + radius).
 * `cullingMargin` keeps a skinned model's SKINNED_BOUNDS_MARGIN slack. Right for framing a camera, wrong
 * for MEASURING — pass false to get the true bind-pose size.
 */
export function combineBounds(root: Node, cullingMargin = true): { center: [number, number, number]; radius: number } {
  const models: ModelNode[] = [];
  collectModelNodes(root, models);
  const spheres = models
    .map(m => {
      const s = m.getBoundingSphere();
      if (cullingMargin || !s) return s;
      return { center: s.center, radius: s.radius / (m.boundsMargin || 1) };
    })
    .filter(s => s && isFinite(s.radius));
  if (spheres.length === 0) return { center: [0, 0, 0], radius: 1 };

  let cx = spheres[0].center[0], cy = spheres[0].center[1], cz = spheres[0].center[2];
  let r = spheres[0].radius;
  for (let i = 1; i < spheres.length; i++) {
    const s = spheres[i];
    const dx = s.center[0] - cx, dy = s.center[1] - cy, dz = s.center[2] - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r >= d + s.radius) continue;            // sphere i already inside the accumulated sphere
    if (s.radius >= d + r) { cx = s.center[0]; cy = s.center[1]; cz = s.center[2]; r = s.radius; continue; }
    const newR = (r + d + s.radius) / 2;
    const t = d > 1e-6 ? (newR - r) / d : 0;    // shift center toward sphere i
    cx += dx * t; cy += dy * t; cz += dz * t;
    r = newR;
  }
  return { center: [cx, cy, cz], radius: r };
}

/**
 * Combined bounding-sphere radius of a subtree at its current scale (updates transforms first).
 * Measured WITHOUT the skinned culling margin, which would inflate a rigged model by 1.75x.
 */
export function meshBoundsRadius(root: Node): number {
  root.updateTransforms();
  return combineBounds(root, false).radius;
}

/**
 * Scale a model so its bounding diameter becomes `targetSize` world units. Returns the applied factor.
 * Baked into the mesh **vertices** (`Geometry.scale`) so the asset keeps an identity node transform.
 * A skinned model's vertices are bound to its skeleton, so those fall back to scaling the root transform.
 */
export function normalizeRootScale(root: Node, targetSize: number): number {
  const radius = meshBoundsRadius(root);
  if (!(radius > 0)) return 1;
  const factor = targetSize / (2 * radius);
  if (factor === 1) return 1;

  const models: ModelNode[] = [];
  collectModelNodes(root, models);
  const hasSkinned = models.some(m => m.model instanceof AnimatedModel && (m.model as AnimatedModel).hasSkin);
  if (hasSkinned) {
    root.setUniformScale(factor); // transform-space to keep the skeleton consistent
    return factor;
  }

  // Static subtree: scale each unique geometry's vertices; a geometry may be shared.
  const scaled = new Set<Geometry>();
  for (const m of models) {
    const geo = m.model.geometry;
    if (scaled.has(geo)) continue;
    scaled.add(geo);
    geo.scale(factor);
  }
  // Sub-models can carry glTF node translations; scale those too, or the parts shrink in place while
  // their spacing stays at the original size.
  const scalePositions = (n: Node) => {
    for (const c of n.children) {
      c.setPosition([c.position[0] * factor, c.position[1] * factor, c.position[2] * factor]);
      scalePositions(c);
    }
  };
  scalePositions(root);
  root.updateTransforms(); // refresh cached bounds after the vertex edit
  return factor;
}

/**
 * Wait until every texture referenced by any material in the subtree has finished decoding.
 * Must be awaited before serializing the mesh/material: TextureManager.serializeTextureData() silently
 * drops any texture whose image has not loaded yet.
 */
export async function awaitSubtreeTexturesReady(root: Node): Promise<void> {
  const models: ModelNode[] = [];
  collectModelNodes(root, models);
  const texIds = new Set<string>();
  for (const m of models) for (const id of materialTextureIds(m.model.material)) texIds.add(id);
  await awaitTexturesReady([...texIds]);
}

/**
 * `Node.addChild` emits `SCENE_CHANGED` even for a node with no scene attached, and the editor reads that
 * as a user edit — so every throwaway scene built here must wrap its mutations in this suppressor.
 * Defaults to a pass-through: thumbnails can be rendered before the editor mounts.
 */
let silently: <T>(fn: () => T) => T = fn => fn();

/** Install the editor's dirty-suppressor. Called once by EngineContext. */
export function setThumbnailDirtySuppressor(fn: <T>(f: () => T) => T): void { silently = fn; }

/**
 * Render a base64 PNG thumbnail of an imported mesh subtree: a throwaway scene auto-framed to the model's
 * bounds, lit by the mesh preview lights, captured after its textures finish loading.
 */
export async function renderModelThumbnail(engine: CleoEngine, root: Node): Promise<string> {
  // Suppress only the synchronous scene building, never the awaits below: holding it across the render
  // would also swallow a genuine edit made while it is in flight.
  const scene = silently(() => {
    const s = new Scene();
    s.addNode(root);
    s.root.updateTransforms(); // make world transforms current so bounding spheres are correct

    const { center, radius } = combineBounds(root);
    createModelPreviewScene(s, center, radius);
    s.start();
    return s;
  });

  await awaitSubtreeTexturesReady(root);

  return captureClean(engine, scene);
}

/** Render a base64 PNG sphere thumbnail for a material, mirroring the material editor's preview sphere. */
export async function renderMaterialThumbnail(engine: CleoEngine, material: Material): Promise<string> {
  const { scene, envReady, preview } = silently(() => {
    const s = new Scene();
    // No skybox, but the environment map must still be applied (awaited below) or the sphere's
    // reflections miss the capture.
    const ready = createMaterialPreviewScene(s, { skybox: false, silently });
    // An independent copy: never share GPU/material state with the live node's material.
    const mat = Material.parse(material.serialize());
    const sphere = new ModelNode('preview', new Model(previewSphereGeometry(), mat));
    s.addNode(sphere);
    s.start();
    return { scene: s, envReady: ready, preview: mat };
  });

  await awaitTexturesReady(materialTextureIds(preview));
  await envReady;
  return captureClean(engine, scene);
}

// ---------------------------------------------------------------------------------------------------
// Re-rendering a thumbnail from a *saved asset* (the explorer's refresh button) rather than from a live
// object, so it can run for assets nothing currently has open.
// ---------------------------------------------------------------------------------------------------

/** Re-register an asset's embedded textures so its material parses against real images, not the fallback. */
function restoreEmbeddedTextures(textures: any[] | undefined): string[] {
  const ids: string[] = [];
  for (const t of textures || []) {
    if (!t?.id) continue;
    ids.push(t.id);
    if (!TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id);
  }
  return ids;
}

/** Re-render a saved MaterialAsset's preview sphere. */
export async function renderMaterialAssetThumbnail(engine: CleoEngine, asset: MaterialAsset): Promise<string> {
  restoreEmbeddedTextures(asset.textures);
  return renderMaterialThumbnail(engine, Material.parse(asset.material));
}

/**
 * Re-render a saved ModelAsset's preview. Instantiate only the base level, directly from its nodeJson and
 * never via instantiateModelAsset, or a LodGroupNode auto-swaps levels inside the throwaway scene.
 */
export async function renderModelAssetThumbnail(engine: CleoEngine, asset: ModelAsset): Promise<string> {
  restoreEmbeddedTextures(asset.textures); // legacy embedded-texture assets
  const root = silently(() => {
    const holder = new Node('__thumb');
    const clone = JSON.parse(JSON.stringify(asset.nodeJson));
    regenerateIds(clone, new Map());
    parseByType(holder, clone);
    return holder.children[0];
  });
  if (!root) return '';
  return renderModelThumbnail(engine, root); // reparents `root` into its own preview scene
}

/**
 * Re-render a saved TerrainMaterialAsset's preview sphere. The material is layer 0 of a tiny helper
 * terrain, so the sphere renders through the terrain shader rather than as a plain PBR surface.
 */
export async function renderTerrainMaterialAssetThumbnail(engine: CleoEngine, asset: TerrainMaterialAsset): Promise<string> {
  const texIds = restoreEmbeddedTextures(asset.textures);
  const tm = parseTerrainMaterialAsset(asset);

  // The textures are awaited BEFORE the layer is assigned, and that ordering is a fix rather than a
  // tidy-up: `setLayer` resolves the normal+height pack synchronously, and against undecoded images it
  // resolves to nothing — so terrain-material thumbnails never showed a height or normal map at all.
  // Nothing retried it, because a one-shot capture never reaches the per-frame sync.
  await awaitTexturesReady(texIds);

  const { scene, node, envReady } = silently(() => {
    const s = new Scene();
    const ready = createMaterialPreviewScene(s, {
      skybox: false, silently, subjectRadius: PREVIEW_TERRAIN_RADIUS,   // see renderMaterialThumbnail
    });
    // A real terrain patch, the same subject the editor tab previews — see buildTerrainPreviewSubject.
    const landscape = buildTerrainPreviewSubject(s, tm);
    s.start();
    return { scene: s, node: landscape, envReady: ready };
  });

  await envReady;
  // `screenshotOffscreen` renders once and never calls `scene.update()`, so the chunk vertex upload —
  // which is what carries the baked displacement to the GPU — would never happen. Pump it by hand, the
  // way renderModelThumbnail already does for transforms.
  scene.root.updateTransforms();
  node.update(0, 0);
  return captureClean(engine, scene);
}
