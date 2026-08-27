import { Scene, Camera, CameraNode, LightNode, DirectionalLight } from 'cleo';

/**
 * Build the editor's navigable camera. The `__editor__` prefix excludes it from selection,
 * serialization and published builds; navigation is wired by the CHANGE_DIMENSION handler.
 */
export function makeEditorCamera(): CameraNode {
  const cam = new CameraNode('__editor__Camera', new Camera({ far: 10000 }));
  cam.active = true;
  cam.setPosition([4, 4, 4]).setRotation([30, -135, 0]);
  return cam;
}

/**
 * Ensure the scene has the editor's own navigation camera, adding it whenever it is missing — even
 * when the scene already has active game cameras. As a root-level active camera it wins
 * `scene.activeCamera` over any nested game camera.
 */
export function ensureEditorCamera(scene: Scene): void {
  if (scene.getNodesByName('__editor__Camera').length) return;
  scene.addNode(makeEditorCamera());
}

/** A blank starting scene: just an editor camera and a single directional light so content is lit. */
export function createEmptyScene(scene: Scene): void {
  scene.addNode(makeEditorCamera());

  const light = new LightNode('light', new DirectionalLight({}));
  light.setPosition([0, 1, 0]).setRotation([100, 25, 0]);
  light.castShadows = true;
  scene.addNode(light);
}
