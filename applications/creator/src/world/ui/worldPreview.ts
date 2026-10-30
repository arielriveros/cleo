import { LandscapeNode, Terrain, type CameraNode, type Scene } from 'cleo';
import { sampleBilinear } from '../features';
import type { WorldOutput } from '../generateWorld';

/** The 3D preview is a real engine landscape, so it shades exactly as an imported one will. */
const PREVIEW_RESOLUTION = 257;
const NODE_NAME = 'World preview';

let node: LandscapeNode | null = null;
let builtFor = { size: 0 };

/** Show `out` in the preview scene, rebuilding the landscape only when the world's size changes. */
export function showWorldPreview(scene: Scene, out: WorldOutput): void {
  const { size, heightScale, resolution } = out.frame;
  if (!node || builtFor.size !== size || !scene.getNodesByName(NODE_NAME).length) {
    if (node) scene.removeNode(node);
    node = new LandscapeNode(NODE_NAME, new Terrain({ size, resolution: PREVIEW_RESOLUTION, chunkQuads: 32 }));
    scene.addNode(node);
    builtFor = { size };
  }
  const R = PREVIEW_RESOLUTION;
  const heights = new Float32Array(R * R);
  for (let r = 0; r < R; r++) for (let c = 0; c < R; c++)
    heights[r * R + c] = sampleBilinear(out.heights, resolution, c / (R - 1), r / (R - 1)) * heightScale;
  node.terrain.setHeights(heights);
}

export function hideWorldPreview(scene: Scene): void {
  if (node) scene.removeNode(node);
  node = null;
}

/** Park the camera where the whole map is in view. */
export function frameWorld(camera: CameraNode, size: number, heightScale: number): void {
  camera.setPosition([0, Math.max(heightScale * 1.5, size * 0.45), size * 0.75]).setRotation([32, 180, 0]);
}
