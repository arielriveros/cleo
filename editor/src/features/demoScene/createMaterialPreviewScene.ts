import { Scene, Node, Camera, CameraNode, LightNode, DirectionalLight, InputManager } from 'cleo';
import { PREVIEW_FOV } from './previewFraming';
import { applyPreviewEnvironment } from './previewEnvironment';

const RADIUS = 3.2;       // camera distance from the sphere (at the origin)
// Closer than the sphere's fit distance (~2.8) crops it; thumbnail capture clamps back out
// (saveActiveMaterial).
const MIN_RADIUS = 1.8;
const MAX_RADIUS = 12;
const INIT_PITCH = -18;   // degrees — slight downward tilt for a 3/4 view
const INIT_YAW = 28;      // degrees
const ROT_SPEED = 10;     // matches the editor's free-fly look sensitivity
const ZOOM_SPEED = 0.005; // wheel delta -> radius

/**
 * Preview scene for the Material editor: an orbit rig (pivot Node at the origin with the camera as a
 * child) plus key and fill directional lights. Drag rotates, wheel zooms; there is no free-fly or pan.
 * The caller adds the sphere as the editable root.
 *
 * The rig is built synchronously; the returned promise resolves once the environment cubemap attaches.
 */
export function createMaterialPreviewScene(
  scene: Scene,
  // `silently` is forwarded to applyPreviewEnvironment so a thumbnail render does not dirty the
  // active tab when its async skybox insert lands.
  opts?: { skybox?: boolean; silently?: <T>(fn: () => T) => T },
): Promise<void> {
  const pivot = new Node('__editor__orbitPivot');
  scene.addNode(pivot);
  pivot.setRotation([INIT_PITCH, INIT_YAW, 0]);

  const cam = new CameraNode('__editor__Camera', new Camera({ fov: PREVIEW_FOV, far: 10000 }));
  cam.active = true;
  // Engine forward is +Z, so the camera sits on the pivot's -Z side and looks back through the origin.
  cam.setPosition([0, 0, -RADIUS]);
  pivot.addChild(cam);

  // CameraNode runs onUpdate before it re-derives the view from the node transform.
  let pitch = INIT_PITCH, yaw = INIT_YAW, radius = RADIUS;
  cam.onUpdate = (delta) => {
    const mouse = InputManager.instance.mouse;
    if (mouse.buttons.Left) {
      yaw -= mouse.velocity[0] * delta * ROT_SPEED;
      pitch += mouse.velocity[1] * delta * ROT_SPEED;
      pitch = Math.max(-85, Math.min(85, pitch)); // don't roll over the poles
      pivot.setRotation([pitch, yaw, 0]);
    }
    if (Math.abs(mouse.wheel.deltaY) > 0 && InputManager.instance.isMouseOverCanvas()) {
      radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius + mouse.wheel.deltaY * ZOOM_SPEED));
      cam.setPosition([0, 0, -radius]);
    }
  };

  // Added FIRST: the deferred pipeline keeps only the last directional light uploaded, so the key light
  // below must be the one that lights the sphere.
  const fill = new LightNode('fill', new DirectionalLight({ diffuse: [0.30, 0.32, 0.38], ambient: [0, 0, 0] }));
  fill.setPosition([0, 5, 0]).setRotation([55, 150, 0]);
  fill.castShadows = false;
  scene.addNode(fill);

  const key = new LightNode('key', new DirectionalLight({ ambient: [0.18, 0.18, 0.20] }));
  key.setPosition([0, 5, 0]).setRotation([120, -35, 0]);
  key.castShadows = false;
  scene.addNode(key);

  return applyPreviewEnvironment(scene, opts);
}
