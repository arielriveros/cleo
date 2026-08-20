import { Scene, Node, ModelNode, Model, Geometry, Material, TextureManager, CleoEngine, AnimatedModel, Terrain } from 'cleo';
import { createModelPreviewScene } from '../features/demoScene/createModelPreviewScene';
import { createMaterialPreviewScene } from '../features/demoScene/createMaterialPreviewScene';
import { fitDistance, MATERIAL_SPHERE_RADIUS } from '../features/demoScene/previewFraming';
import type { MaterialAsset } from './materials';
import { ModelAsset } from './models';
import { parseByType, regenerateIds } from './nodeSubtree';
import { TerrainMaterialAsset, parseTerrainMaterialAsset } from './terrainMaterials';
import { awaitTexturesReady } from './textureReady';

const THUMB_SIZE = 256;

// Texture ids a material references (skip empties). Used to wait for async decode before capturing.
export function materialTextureIds(material: Material): string[] {
  const textures = (material.serialize() as any)?.textures;
  if (!textures || typeof textures !== 'object') return [];
  return Object.values(textures).filter((v): v is string => typeof v === 'string' && !!v);
}

/**
 * Push the camera node's world transform into its Camera.
 *
 * `Camera` keeps its own position/eye and is only synced by `CameraNode.update()`, which runs from
 * `scene.update()`. Preview scenes are throwaway — the engine's game loop only updates the *active* scene —
 * so without this the capture renders from a camera still at the origin (position == eye == [0,0,0]) and the
 * framing the preview scene computed is never actually applied.
 */
function syncPreviewCamera(scene: Scene): void {
  scene.root.updateTransforms();
  const cam = scene.activeCamera;
  if (cam) cam.update(0, 0);
}

// Capture a scene to a base64 PNG with the ground grid hidden (kept clean, then restored).
function captureClean(engine: CleoEngine, scene: Scene): string {
  const prevGrid = engine.renderer.gridVisible;
  engine.renderer.setGridVisible(false);
  try {
    syncPreviewCamera(scene);
    return engine.renderer.screenshotOffscreen(scene, THUMB_SIZE);
  } finally {
    engine.renderer.setGridVisible(prevGrid);
  }
}

/**
 * Capture the material editor's live preview sphere.
 *
 * The orbit rig lets the user zoom closer than the sphere's fit distance to inspect the material, which
 * crops it — a thumbnail must show the whole sphere, so the camera is dollied back out to the fit distance
 * for the capture only (keeping the user's orbit orientation) and restored afterwards. The orbit controller
 * is muted while dollied so it can't snap the camera back to its zoom radius mid-capture.
 */
export function captureMaterialSphere(engine: CleoEngine, scene: Scene): string {
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
 *
 * `cullingMargin` keeps the extra room a skinned model's bounds carry so an animated pose cannot poke
 * outside them (SKINNED_BOUNDS_MARGIN). That is right for framing a camera and wrong for MEASURING —
 * pass false to get the true bind-pose size.
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
 *
 * Measured WITHOUT the skinned culling margin. Including it made every rigged import land at 1/1.75 of
 * the size the user asked for, and the import review report a "current size" 1.75x larger than the model.
 */
export function meshBoundsRadius(root: Node): number {
  root.updateTransforms();
  return combineBounds(root, false).radius;
}

/**
 * Scale a model so its bounding diameter becomes `targetSize` world units (imported models arrive at
 * wildly different scales — many far too big for the scene). Returns the applied factor.
 *
 * Scaling is baked into the mesh **vertices** (`Geometry.scale`) so the asset keeps an identity node
 * transform. Skinned models are the exception: their vertices are bound to a skeleton, so vertex scaling
 * would break the skinning — those fall back to transform-space scaling on the root.
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

  // Static subtree: scale each unique geometry's vertices (dedupe in case a geometry is shared).
  const scaled = new Set<Geometry>();
  for (const m of models) {
    const geo = m.model.geometry;
    if (scaled.has(geo)) continue;
    scaled.add(geo);
    geo.scale(factor);
  }
  // Sub-models can carry glTF node translations (multi-part layouts); scale those too, or the parts
  // shrink in place while their spacing stays at the original size.
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
 * Wait until every texture referenced by any material in the subtree has finished decoding. Imported
 * textures (and modal-uploaded ones after a re-parse) load asynchronously, so callers must await this
 * before serializing the mesh/material — TextureManager.serializeTextureData() silently drops any texture
 * whose image hasn't loaded yet.
 */
export async function awaitSubtreeTexturesReady(root: Node): Promise<void> {
  const models: ModelNode[] = [];
  collectModelNodes(root, models);
  const texIds = new Set<string>();
  for (const m of models) for (const id of materialTextureIds(m.model.material)) texIds.add(id);
  await awaitTexturesReady([...texIds]);
}

/**
 * Every render in this module builds a throwaway scene, and `Node.addChild` emits `SCENE_CHANGED`
 * unconditionally — even for a node with no scene attached. The editor reads that event as "the user
 * edited something", so rendering a thumbnail marked the active tab unsaved: a mesh save would clear the
 * tab's dirty flag, then its own thumbnail render would set it straight back, and Save All (which reports
 * failure purely on "is the tab still dirty") called the successful save a failure.
 *
 * Nothing offscreen here is ever a user edit, so EngineContext installs its `withoutDirty` once and every
 * helper wraps its scene mutations in it. Defaults to a pass-through: thumbnails can be rendered before
 * the editor mounts, when there is no tab to dirty.
 */
let silently: <T>(fn: () => T) => T = fn => fn();

/** Install the editor's dirty-suppressor. Called once by EngineContext. */
export function setThumbnailDirtySuppressor(fn: <T>(f: () => T) => T): void { silently = fn; }

/**
 * Render a base64 PNG thumbnail of an imported mesh subtree: a throwaway scene auto-framed to the
 * model's bounds, lit by the mesh preview lights, captured after its textures finish loading.
 */
export async function renderModelThumbnail(engine: CleoEngine, root: Node): Promise<string> {
  // Only the synchronous scene building is suppressed, never the awaits below — holding the suppression
  // across the render would also swallow a genuine edit the user makes while it is in flight.
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

/**
 * Render a base64 PNG sphere thumbnail for a material (used to give each imported MaterialAsset a
 * preview), mirroring the material editor's preview sphere.
 */
export async function renderMaterialThumbnail(engine: CleoEngine, material: Material): Promise<string> {
  const { scene, envReady, preview } = silently(() => {
    const s = new Scene();
    // No skybox: thumbnail captures skip background draws anyway, but the environment map must be applied
    // (awaited below) so the sphere's reflections make it into the capture.
    const ready = createMaterialPreviewScene(s, { skybox: false, silently });
    // Render an independent copy so we never share GPU/material state with the live node's material.
    const mat = Material.parse(material.serialize());
    const sphere = new ModelNode('preview', new Model(Geometry.Sphere(48), mat));
    s.addNode(sphere);
    s.start();
    return { scene: s, envReady: ready, preview: mat };
  });

  await awaitTexturesReady(materialTextureIds(preview));
  await envReady;
  return captureClean(engine, scene);
}

// ---------------------------------------------------------------------------------------------------
// Re-rendering a thumbnail from a *saved asset* (the explorer's refresh button), as opposed to from the
// live object it was created from. Each of these rebuilds the same preview the asset's editor/import
// showed, from the asset's own embedded data, so it can run for assets nothing currently has open.
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
 * Re-render a saved ModelAsset's preview. Only the base level (LOD0) is instantiated — directly from its
 * nodeJson, never via instantiateModelAsset, so no LodGroupNode ends up auto-swapping levels inside a
 * throwaway thumbnail scene.
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
 * Re-render a saved TerrainMaterialAsset's preview sphere. Mirrors the terrain-material tab: the material
 * is layer 0 of a tiny helper terrain, so the sphere renders through the terrain shader (height blending,
 * displacement and parallax all show up) rather than as a plain PBR surface.
 */
export async function renderTerrainMaterialAssetThumbnail(engine: CleoEngine, asset: TerrainMaterialAsset): Promise<string> {
  const texIds = restoreEmbeddedTextures(asset.textures);
  const tm = parseTerrainMaterialAsset(asset);

  const { scene, envReady } = silently(() => {
    const s = new Scene();
    const ready = createMaterialPreviewScene(s, { skybox: false, silently }); // see renderMaterialThumbnail
    const helperTerrain = new Terrain({ size: 2, resolution: 2 });
    helperTerrain.setLayer(0, tm, { auto: false, tiling: 1 }); // always show the surface, without terrain-space tiling
    const sphere = new ModelNode('preview', new Model(Geometry.Sphere(48), helperTerrain.material));
    s.addNode(sphere);
    s.start();
    return { scene: s, envReady: ready };
  });

  await awaitTexturesReady(texIds);
  await envReady;
  return captureClean(engine, scene);
}
