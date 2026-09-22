import { Scene, Camera, CameraNode, LightNode, DirectionalLight } from 'cleo';
import { PREVIEW_FOV, fitDistance, previewClipPlanes } from './previewFraming';

// Fixed viewing direction matching makeEditorCamera's [30,-135,0]: that rotation's forward is exactly
// -normalize([1,1,1]), so the camera goes at center + normalize([1,1,1]) * distance.
const DIAG = 1 / Math.sqrt(3);

/**
 * Names of the preview key + fill lights, shared by every preview builder (model, material, animation).
 *
 * The `__editor__` marker is what makes them editor-OWNED (`Node.isEditorOwned`). They used to be plain
 * 'key'/'fill', which is a user-content name: they showed in the scene tree, the helper reconciler hung a
 * light icon on each, and any event on them marked the tab unsaved or became an undo step.
 */
export const PREVIEW_KEY_LIGHT_NAME = '__editor__keyLight';
export const PREVIEW_FILL_LIGHT_NAME = '__editor__fillLight';

/**
 * The key + fill pair every model preview is lit by, without the camera.
 *
 * Shared so the impostor bake lights its subject EXACTLY as the library thumbnail does. A card baked
 * under different lighting than the thumbnail it sits beside reads as a different asset, and the
 * brightness of these two against the pinned preview exposure is the one part of the capture that has
 * been visually verified over time.
 */
export function addPreviewLights(scene: Scene): void {
  const key = new LightNode(PREVIEW_KEY_LIGHT_NAME, new DirectionalLight({ ambient: [0.18, 0.18, 0.20] }));
  key.setPosition([0, 5, 0]).setRotation([120, -35, 0]);
  key.castShadows = false;
  scene.addNode(key);

  const fill = new LightNode(PREVIEW_FILL_LIGHT_NAME, new DirectionalLight({ diffuse: [0.30, 0.32, 0.38], ambient: [0, 0, 0] }));
  fill.setPosition([0, 5, 0]).setRotation([55, 150, 0]);
  fill.castShadows = false;
  scene.addNode(fill);
}

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
  scene.setActiveCamera(cam);

  addPreviewLights(scene);
}
