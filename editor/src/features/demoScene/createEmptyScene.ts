import { Scene, Camera, CameraNode, LightNode, DirectionalLight } from 'cleo';

/**
 * Build the editor's navigable camera. Prefixed with `__editor__` so it is excluded from
 * selection, serialization and published builds (stripped by buildGameData). Navigation
 * handlers are wired separately by the CHANGE_DIMENSION handler onto scene.activeCamera.
 */
export function makeEditorCamera(): CameraNode {
  const cam = new CameraNode('__editor__Camera', new Camera({ far: 10000 }));
  cam.active = true;
  cam.setPosition([4, 4, 4]).setRotation([30, -135, 0]);
  return cam;
}

/**
 * Ensure the scene has the editor's own navigation camera. Restored/imported scenes have their
 * `__editor__Camera` stripped by buildGameData, so it must be re-added. We add it whenever it is
 * missing — even when the scene already has (active) game cameras — so the editor never flies
 * *through* a game camera. Being a root-level active camera, it wins `scene.activeCamera` over any
 * nested game camera, which also lets those game cameras keep their frustum gizmos.
 */
export function ensureEditorCamera(scene: Scene): void {
  if (scene.getNodesByName('__editor__Camera').length) return;
  scene.addNode(makeEditorCamera());
}

/** A blank starting scene: just an editor camera and a single directional light so content is lit. */
export function createEmptyScene(scene: Scene): void {
  scene.addNode(makeEditorCamera());

  // Only the light content is created here; its editor icon (__editor__LightSprite) is added
  // automatically by the editor-helper reconciler, keyed off the LightNode type.
  const light = new LightNode('light', new DirectionalLight({}));
  light.setPosition([0, 1, 0]).setRotation([100, 25, 0]);
  light.castShadows = true;
  scene.addNode(light);
}
