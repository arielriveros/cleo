import { Scene, Camera, CameraNode, LightNode, DirectionalLight, ModelNode, Model, Geometry, Material } from 'cleo';
import { applyPreviewEnvironment } from './previewEnvironment';
import { PREVIEW_KEY_LIGHT_NAME, PREVIEW_FILL_LIGHT_NAME } from './createModelPreviewScene';

// Scene for the Animation Editor tab: auto-framed editor camera, shadow-casting key + fill lights, and a
// ground plane to catch the animated pose's shadow.
// `__editor__` names are excluded from selection and serialization.

const DIAG = 1 / Math.sqrt(3); // camera forward for rotation [30,-135,0] is -normalize([1,1,1])
const FOV = 55;

/**
 * @param opts.silently EngineContext's `withoutDirty`, forwarded to applyPreviewEnvironment. Its skybox insert
 *   lands asynchronously, once the cubemap has loaded, which is usually after the tab has activated and
 *   re-armed dirty tracking: unwrapped, it marked an untouched tab unsaved and pushed an
 *   'Add __editor__skybox' undo step.
 */
export function createAnimationEditorScene(
  scene: Scene, center: [number, number, number], radius: number,
  opts?: { silently?: <T>(fn: () => T) => T },
): void {
  const r = Math.max(radius, 0.001);
  const dist = (r / Math.sin((FOV / 2) * Math.PI / 180)) * 1.6;

  const cam = new CameraNode('__editor__Camera', new Camera({ fov: FOV, far: 100000 }));
  cam.active = true;
  cam.setPosition([center[0] + DIAG * dist, center[1] + DIAG * dist, center[2] + DIAG * dist]);
  cam.setRotation([30, -135, 0]);
  scene.addNode(cam);
  scene.setActiveCamera(cam);

  const key = new LightNode(PREVIEW_KEY_LIGHT_NAME, new DirectionalLight({ ambient: [0.20, 0.20, 0.22] }));
  key.setPosition([0, 1, 0]).setRotation([115, -30, 0]);
  key.castShadows = true;
  scene.addNode(key);

  const fill = new LightNode(PREVIEW_FILL_LIGHT_NAME, new DirectionalLight({ diffuse: [0.25, 0.27, 0.32], ambient: [0, 0, 0] }));
  fill.setPosition([0, 1, 0]).setRotation([55, 150, 0]);
  fill.castShadows = false;
  scene.addNode(fill);

  const size = Math.max(r * 20, 4);
  const ground = new ModelNode('__editor__ground',
    new Model(Geometry.Cube(size, Math.max(r * 0.02, 0.01), size),
      Material.Default({ diffuse: [0.32, 0.33, 0.38] }, { castShadow: false })));
  ground.setPosition([center[0], center[1] - r, center[2]]);
  scene.addNode(ground);

  void applyPreviewEnvironment(scene, { silently: opts?.silently });
}
