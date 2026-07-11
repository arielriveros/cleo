import { Scene, Node, ModelNode, Model, Geometry, Material, TextureManager, CleoEngine } from 'cleo';
import { createMeshPreviewScene } from '../features/demoScene/createMeshPreviewScene';
import { createMaterialPreviewScene } from '../features/demoScene/createMaterialPreviewScene';

const THUMB_SIZE = 256;

// Texture ids a material references (skip empties). Used to wait for async decode before capturing.
export function materialTextureIds(material: Material): string[] {
  const textures = (material.serialize() as any)?.textures;
  if (!textures || typeof textures !== 'object') return [];
  return Object.values(textures).filter((v): v is string => typeof v === 'string' && !!v);
}

/**
 * Wait until every referenced texture has finished decoding. TextureManager loads base64/file images
 * asynchronously (Texture.data is null until the image loads), so screenshotting too early captures an
 * untextured mesh. Polls the referenced textures with a hard timeout, then yields one frame so the GPU
 * upload lands before the render.
 */
async function awaitTexturesReady(ids: string[], timeoutMs = 5000): Promise<void> {
  const tm = TextureManager.Instance;
  const ready = () => ids.every(id => {
    const tex = tm.getTexture(id);
    if (!tex) return true; // unknown id — nothing to wait for
    const data: any = (tex as any).data;
    if (!data) return false; // still loading (image not attached yet)
    if (data instanceof HTMLImageElement) return data.complete && data.naturalWidth > 0;
    return true; // data-backed texture (no image to decode)
  });
  const start = performance.now();
  while (!ready() && performance.now() - start < timeoutMs)
    await new Promise<void>(r => setTimeout(r, 50));
  await new Promise<void>(r => requestAnimationFrame(() => r()));
}

// Capture a scene to a base64 PNG with the ground grid hidden (kept clean, then restored).
function captureClean(engine: CleoEngine, scene: Scene): string {
  const prevGrid = engine.renderer.gridVisible;
  engine.renderer.setGridVisible(false);
  try {
    return engine.renderer.screenshot(scene, THUMB_SIZE);
  } finally {
    engine.renderer.setGridVisible(prevGrid);
  }
}

function collectModelNodes(node: Node, out: ModelNode[]): void {
  if ((node as any).nodeType === 'model') out.push(node as ModelNode);
  for (const c of node.children) collectModelNodes(c, out);
}

// Union of every child ModelNode's world-space bounding sphere (center + radius).
function combineBounds(root: Node): { center: [number, number, number]; radius: number } {
  const models: ModelNode[] = [];
  collectModelNodes(root, models);
  const spheres = models.map(m => m.getBoundingSphere()).filter(s => s && isFinite(s.radius));
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
 * Render a base64 PNG thumbnail of an imported mesh subtree: a throwaway scene auto-framed to the
 * model's bounds, lit by the mesh preview lights, captured after its textures finish loading.
 */
export async function renderMeshThumbnail(engine: CleoEngine, root: Node): Promise<string> {
  const scene = new Scene();
  scene.addNode(root);
  scene.root.updateTransforms(); // make world transforms current so bounding spheres are correct

  const { center, radius } = combineBounds(root);
  createMeshPreviewScene(scene, center, radius);
  scene.start();

  const models: ModelNode[] = [];
  collectModelNodes(root, models);
  const texIds = new Set<string>();
  for (const m of models) for (const id of materialTextureIds(m.model.material)) texIds.add(id);
  await awaitTexturesReady([...texIds]);

  return captureClean(engine, scene);
}

/**
 * Render a base64 PNG sphere thumbnail for a material (used to give each imported MaterialAsset a
 * preview), mirroring the material editor's preview sphere.
 */
export async function renderMaterialThumbnail(engine: CleoEngine, material: Material): Promise<string> {
  const scene = new Scene();
  createMaterialPreviewScene(scene);
  // Render an independent copy so we never share GPU/material state with the live node's material.
  const preview = Material.parse(material.serialize());
  const sphere = new ModelNode('preview', new Model(Geometry.Sphere(48), preview));
  scene.addNode(sphere);
  scene.start();

  await awaitTexturesReady(materialTextureIds(preview));
  return captureClean(engine, scene);
}
