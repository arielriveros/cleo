import { Scene, Camera, CameraNode, LightNode, DirectionalLight } from 'cleo';
import { PREVIEW_FOV, fitDistance, previewClipPlanes } from './previewFraming';

// Fixed viewing direction (matches makeEditorCamera's [30,-135,0] look-at-origin orientation): the
// camera forward for that rotation is exactly -normalize([1,1,1]), so placing the camera at
// center + normalize([1,1,1]) * distance frames the target regardless of where it sits in space.
const DIAG = 1 / Math.sqrt(3);

/**
 * Dedicated preview scene for a freshly-imported mesh: key + fill directional lights and an editor
 * camera auto-framed to the model's combined bounding sphere (`center`, `radius`). Mirrors
 * createMaterialPreviewScene but distances the camera by the bounds so any model size fits the thumbnail.
 * No light icons are created (the editor-helper reconciler never touches this throwaway scene).
 */
export function createMeshPreviewScene(scene: Scene, center: [number, number, number], radius: number): void {
  const r = Math.max(radius, 0.001);
  // Distance so the sphere of radius r fits within the vertical FOV, with a margin for breathing room.
  // Clip planes track the bounds too — the camera defaults would clip very small or very large meshes.
  const dist = fitDistance(r);
  const { near, far } = previewClipPlanes(dist, r);

  const cam = new CameraNode('__editor__Camera', new Camera({ fov: PREVIEW_FOV, near, far }));
  cam.active = true;
  cam.setPosition([center[0] + DIAG * dist, center[1] + DIAG * dist, center[2] + DIAG * dist]);
  cam.setRotation([30, -135, 0]);
  scene.addNode(cam);

  // Key light with a touch of ambient so metallic PBR doesn't go pitch-black without an environment map.
  const key = new LightNode('key', new DirectionalLight({ ambient: [0.18, 0.18, 0.20] }));
  key.setPosition([0, 5, 0]).setRotation([120, -35, 0]);
  key.castShadows = false;
  scene.addNode(key);

  // Dim fill from the opposite side to reveal form.
  const fill = new LightNode('fill', new DirectionalLight({ diffuse: [0.30, 0.32, 0.38], ambient: [0, 0, 0] }));
  fill.setPosition([0, 5, 0]).setRotation([55, 150, 0]);
  fill.castShadows = false;
  scene.addNode(fill);
}
