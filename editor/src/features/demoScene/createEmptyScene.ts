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
 * Ensure the scene has the editor's own navigation camera, adding it whenever it is missing — even when
 * the scene already has active game cameras — and PIN it as `scene.activeCamera`.
 *
 * The pin is what keeps authored cameras independent of the viewport. Without it the winner was whichever
 * active camera came first in breadth-first order, so a game camera parsed from a saved scene (parsing
 * runs before this) outranked the editor camera appended after it: the viewport rendered through the game
 * camera and the free-fly handler drove it, dragging it around every time the view moved.
 */
export function ensureEditorCamera(scene: Scene): void {
  const existing = scene.getNodesByName('__editor__Camera').find((n): n is CameraNode => n instanceof CameraNode);
  const cam = existing ?? makeEditorCamera();
  if (!existing) scene.addNode(cam);
  scene.setActiveCamera(cam);
}

/** A blank starting scene: just an editor camera and a single directional light so content is lit. */
export function createEmptyScene(scene: Scene): void {
  ensureEditorCamera(scene);

  const light = new LightNode('light', new DirectionalLight({}));
  light.setPosition([0, 1, 0]).setRotation([100, 25, 0]);
  light.castShadows = true;
  scene.addNode(light);
}
