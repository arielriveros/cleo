import { Scene, Camera, CameraNode, LightNode, DirectionalLight } from 'cleo';
import { PREVIEW_FOV, fitDistance, previewClipPlanes } from './previewFraming';

// Fixed viewing direction matching makeEditorCamera's [30,-135,0]: that rotation's forward is exactly
// -normalize([1,1,1]), so the camera goes at center + normalize([1,1,1]) * distance.
const DIAG = 1 / Math.sqrt(3);

/**
 * Preview scene for a freshly-imported mesh: key + fill directional lights and an editor camera
 * auto-framed to the model's combined bounding sphere (`center`, `radius`), so any model size fits.
 */
export function createModelPreviewScene(scene: Scene, center: [number, number, number], radius: number): void {
  const r = Math.max(radius, 0.001);
  // Clip planes must track the bounds: the camera defaults clip very small or very large meshes.
  const dist = fitDistance(r);
  const { near, far } = previewClipPlanes(dist, r);

  const cam = new CameraNode('__editor__Camera', new Camera({ fov: PREVIEW_FOV, near, far }));
  cam.active = true;
  cam.setPosition([center[0] + DIAG * dist, center[1] + DIAG * dist, center[2] + DIAG * dist]);
  cam.setRotation([30, -135, 0]);
  scene.addNode(cam);

  const key = new LightNode('key', new DirectionalLight({ ambient: [0.18, 0.18, 0.20] }));
  key.setPosition([0, 5, 0]).setRotation([120, -35, 0]);
  key.castShadows = false;
  scene.addNode(key);

  const fill = new LightNode('fill', new DirectionalLight({ diffuse: [0.30, 0.32, 0.38], ambient: [0, 0, 0] }));
  fill.setPosition([0, 5, 0]).setRotation([55, 150, 0]);
  fill.castShadows = false;
  scene.addNode(fill);
}
