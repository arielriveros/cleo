import { Scene, Node, ModelNode, Model, Geometry, Material, TextureManager, CleoEngine, AnimatedModel, Terrain, Camera, CameraNode, Logger } from 'cleo';
import { createModelPreviewScene, addPreviewLights } from '../features/demoScene/createModelPreviewScene';
import { createMaterialPreviewScene } from '../features/demoScene/createMaterialPreviewScene';
import { fitDistance, MATERIAL_SPHERE_RADIUS, previewSphereGeometry, PREVIEW_TERRAIN_RADIUS } from '../features/demoScene/previewFraming';
import { buildTerrainPreviewSubject } from '../features/demoScene/previewTerrainSubject';
import type { MaterialAsset } from './materials';
import { ModelAsset } from './models';
import { parseByType, regenerateIds } from './nodeSubtree';
import { TerrainMaterialAsset, parseTerrainMaterialAsset } from './terrainMaterials';
import { awaitTexturesReady } from './textureReady';
import { deepClone } from './deepClone';

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
async function captureClean(engine: CleoEngine, scene: Scene, size: number = THUMB_SIZE): Promise<string> {
  const prevGrid = engine.renderer.gridVisible;
  engine.renderer.setGridVisible(false);
  let pending: Promise<string>;
  try {
    syncPreviewCamera(scene);
    pending = engine.renderer.screenshotOffscreen(scene, size);
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
 * World-space AABB of every ModelNode in a subtree.
 *
 * A BOX, where {@link combineBounds} gives a sphere, because an impostor has to match the card that
 * replaces it and that card is sized `[width, height]` from the prototype's box — see
 * `FoliageLayer._prototypeFootprint`. A sphere fitted to a tall thin tree would frame mostly empty air
 * and the card would not line up with the mesh it stands in for.
 */
export function combineBox(root: Node): { min: [number, number, number]; max: [number, number, number] } {
  const models: ModelNode[] = [];
  collectModelNodes(root, models);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const m of models) {
    const b = m.getBoundingBox();
    if (!b || !isFinite(b.min[0]) || !isFinite(b.max[0])) continue;
    minX = Math.min(minX, b.min[0]); maxX = Math.max(maxX, b.max[0]);
    minY = Math.min(minY, b.min[1]); maxY = Math.max(maxY, b.max[1]);
    minZ = Math.min(minZ, b.min[2]); maxZ = Math.max(maxZ, b.max[2]);
  }
  if (!isFinite(minX)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
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
    const clone = deepClone(asset.nodeJson);
    regenerateIds(clone, new Map());
    parseByType(holder, clone);
    return holder.children[0];
  });
  if (!root) return '';
  return renderModelThumbnail(engine, root); // reparents `root` into its own preview scene
}

// ---------------------------------------------------------------------------------------------------
// Impostor bake
// ---------------------------------------------------------------------------------------------------

/** Side of the baked impostor sheet. Four times a thumbnail: this one is looked at in the world. */
export const IMPOSTOR_SIZE = 512;

/**
 * The texture id an asset's impostor is registered under. Deterministic, so re-baking REPLACES the card
 * a foliage rule already points at instead of leaving the library to accumulate orphans — the same
 * reasoning as `lodTextures`' derived ids.
 */
export function impostorTextureId(modelId: string): string { return `${modelId}__impostor`; }

/** Where the impostor camera goes and what it sees. Pure, so the arithmetic can be tested. */
export interface ImpostorFraming {
  /** Card size the capture is framed for, matching `FoliageLayer._prototypeFootprint`. */
  width: number;
  height: number;
  /** Orthographic camera position. */
  position: [number, number, number];
  /**
   * Euler degrees that aim the camera back at the subject from {@link position}.
   *
   * Carried here rather than written at the call site so the pair can be checked against each other:
   * a camera placed correctly and aimed the wrong way captures an empty frame, which is a picture of
   * nothing that looks exactly like a picture of a missing asset.
   */
  rotation: [number, number, number];
  /** Half-extents of the orthographic volume. */
  left: number; right: number; bottom: number; top: number;
  near: number; far: number;
}

/**
 * Frame an orthographic camera onto a subject's world AABB for an impostor capture.
 *
 * Separated from the bake because it is the part most likely to be subtly wrong and the part a GPU is
 * not needed to check: a clip plane through the subject, or a card sized off the wrong axis, produces a
 * picture that looks plausible and lines up with nothing.
 *
 * `width`/`height` are the same two numbers `FoliageLayer._prototypeFootprint` derives from the runtime
 * prototype — `max(dx, dz)` and `dy` — because the card this feeds is `crossQuadGeometry(width, height)`
 * and the two have to agree or the impostor is a different size from the mesh it stands in for.
 */
export function impostorFraming(box: { min: [number, number, number]; max: [number, number, number] }): ImpostorFraming {
  const dx = box.max[0] - box.min[0];
  const dy = box.max[1] - box.min[1];
  const dz = box.max[2] - box.min[2];
  // The same degenerate fallback the runtime footprint uses: a flat or empty subject gets a unit card
  // rather than collapsing to a zero-area quad that would draw nothing and look like a missing asset.
  const width = Math.max(dx, dz) > 1e-4 ? Math.max(dx, dz) : 1;
  const height = dy > 1e-4 ? dy : 1;

  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const cz = (box.min[2] + box.max[2]) / 2;

  // Back off along +Z past the subject's own extent. An orthographic projection does not care how far
  // the camera is, but the CLIP PLANES do, and a near plane cutting into the subject silently slices
  // the front off the card.
  const depth = Math.max(dz, width, height);
  const dist = depth * 2 + 1;

  return {
    width, height,
    position: [cx, cy, cz + dist],
    // Engine forward is +Z (`Node.worldForward`, which `CameraNode.update` turns into the look-at
    // target), so a camera standing on the subject's +Z side has to be YAWED ROUND to see it. Left
    // at [0, 0, 0] it looks away and the capture is empty. The 180 also keeps world +X on the right
    // of the frame, so the sheet is a front elevation rather than a mirror of one.
    rotation: [0, 180, 0],
    // Half-extents. `Camera` scales left/right by the aspect ratio and leaves top/bottom alone; the
    // capture target is square, so aspect is 1 and these are used as written.
    left: -width / 2, right: width / 2, bottom: -height / 2, top: height / 2,
    // `near` clears the subject's far side by the same margin the distance was built with.
    near: Math.max(0.01, dist - depth), far: dist + depth * 2 + 1,
  };
}

/** What a bake produced: the registered texture, and the card size it was framed for. */
export interface ImpostorBake {
  id: string; data: string; width: number; height: number;
  /** Fraction of the sheet the runtime cutout will KEEP. See {@link opaqueFraction}. */
  coverage: number;
}

/**
 * The fraction of a captured sheet the runtime billboard will actually draw.
 *
 * Measured against the same threshold the shader uses -- `geometryFoliageBillboard.wgsl` does
 * `if (c.a < 0.5) { discard; }` -- so this is not a general alpha statistic, it is the answer to
 * "how much of this card survives the cutout".
 *
 * It exists because both ways this bake has failed were SILENT. An empty capture and a fully opaque
 * one are both just a black PNG, and the editor has no transparency checkerboard anywhere, so a
 * correct cut-out sheet and a solid black tile look identical against the dark asset panel. One
 * number distinguishes every case: ~0 is a capture that framed nothing, ~1 is a capture whose
 * coverage alpha never got written, and anything between is a real silhouette.
 */
export async function opaqueFraction(dataUrl: string): Promise<number> {
  const image = await new Promise<HTMLImageElement | null>(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
  if (!image || !image.width || !image.height) return NaN;

  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return NaN;
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);

  let kept = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= 128) kept++;
  return kept / (data.length / 4);
}

/**
 * Render a model asset to a single flat card, for foliage to draw past its farthest LOD band.
 *
 * This is the change that matters most for a heavy prototype. A LOD level reduces triangles linearly;
 * a card replaces a hundred thousand of them with four, and at the distances it takes over the
 * difference is invisible. It also sidesteps the real cost of distant foliage, which is not the
 * triangle COUNT but that every one of those triangles is smaller than a pixel and still costs a whole
 * 2x2 rasterizer quad.
 *
 * Three things make the framing correct, and all three are load-bearing:
 *
 * - **Orthographic.** A perspective capture bakes in convergence, and the card it lands on is flat, so
 *   the tree would appear to lean as the camera moved past it.
 * - **Framed to the BOX, not the bounding sphere**, matching `FoliageLayer._prototypeFootprint`:
 *   `width = max(dx, dz)`, `height = dy`. The runtime card is `crossQuadGeometry(width, height)`.
 * - **Square target, non-square framing.** The capture stretches the subject to fill a square sheet;
 *   the card's 0..1 UV over a `width x height` quad stretches it back by exactly the inverse. So a
 *   square texture is correct with no letterboxing and no wasted texels — which matters, because
 *   `screenshotOffscreen` is square-only.
 *
 * Coverage comes from the scene DEPTH buffer (`_presentThumbnail`), never the colour alpha, so the
 * cut-out gaps between leaves come back transparent and the runtime `c.a < 0.5` test lands on the
 * silhouette rather than on the bloom mask.
 *
 * Lit by the same key + fill the library thumbnail uses, so a card reads as the asset it replaces. The
 * runtime billboard shader writes a fixed straight-up normal, so this bake carries its lighting in the
 * albedo; a baked normal map is the separable next step, and until it exists a distant tree lights
 * flatly rather than following the sun.
 */
export async function bakeModelImpostor(engine: CleoEngine, asset: ModelAsset): Promise<ImpostorBake | null> {
  restoreEmbeddedTextures(asset.textures);

  const root = silently(() => {
    const holder = new Node('__impostor');
    const clone = deepClone(asset.nodeJson);
    regenerateIds(clone, new Map());
    parseByType(holder, clone);
    return holder.children[0];
  });
  if (!root) return null;

  const framed = silently(() => {
    const s = new Scene();
    s.addNode(root);
    s.root.updateTransforms();

    const f = impostorFraming(combineBox(root));

    const cam = new CameraNode('__impostor__Camera', new Camera({
      type: 'orthographic',
      left: f.left, right: f.right, bottom: f.bottom, top: f.top,
      near: f.near, far: f.far,
    }));
    cam.active = true;
    // A front elevation, level with the subject: the view a distant instance is almost always seen
    // from. Both halves come from `impostorFraming` — see the note there on why the rotation is not
    // the identity.
    cam.setPosition(f.position);
    cam.setRotation(f.rotation);
    s.addNode(cam);
    // Pinned, not merely `active`. One camera in a throwaway scene reaches `Scene.activeCamera`
    // through the first-active fallback either way, but every other preview builder pins, and the
    // fallback is tree-order dependent the moment anything else in here grows a camera.
    s.setActiveCamera(cam);

    addPreviewLights(s);
    s.start();
    return { scene: s, width: f.width, height: f.height };
  });

  await awaitSubtreeTexturesReady(root);
  const data = await captureClean(engine, framed.scene, IMPOSTOR_SIZE);
  if (!data) return null;

  // Checked every time, not only when something looks wrong: a card is authored once and then only
  // ever seen from far away, so a bad bake is not noticed until someone wonders why the horizon has
  // black rectangles on it.
  const coverage = await opaqueFraction(data);
  if (coverage > 0.98)
    Logger.print('warn', [`Impostor for "${asset.name}" came back ${Math.round(coverage * 100)}% opaque.`,
                          'The card will draw as a solid rectangle: the runtime cutout discards on',
                          'alpha < 0.5 and nothing in this sheet is below it. The capture writes its',
                          'coverage alpha from the scene depth in Renderer._presentThumbnail.'], 'Editor');
  else if (coverage < 0.005)
    Logger.print('warn', [`Impostor for "${asset.name}" is empty (${(coverage * 100).toFixed(2)}% covered).`,
                          'Nothing was inside the capture frustum -- check impostorFraming.'], 'Editor');
  else
    Logger.info(`Baked impostor for "${asset.name}": ${Math.round(coverage * 100)}% of the sheet covered.`, 'Editor');

  const id = impostorTextureId(asset.id);
  // Replace in place: a re-bake must update the card a rule already names, not mint a second one.
  TextureManager.Instance.removeTexture(id);
  TextureManager.Instance.addTextureFromBase64(data, { mipMap: true }, id);
  return { id, data, width: framed.width, height: framed.height, coverage };
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
  // `screenshotOffscreen` renders once and never calls `scene.update()`, so a chunk whose geometry was
  // rebuilt would never reach the GPU. Pump it by hand, the way renderModelThumbnail already does for
  // transforms.
  scene.root.updateTransforms();
  node.update(0, 0);
  return captureClean(engine, scene);
}
