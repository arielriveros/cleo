import { Scene, Node, Camera, CameraNode, LightNode, DirectionalLight, InputManager } from 'cleo';
import { PREVIEW_FOV } from './previewFraming';
import { applyPreviewEnvironment } from './previewEnvironment';

// Orbit preview tunables.
const RADIUS = 3.2;       // camera distance from the sphere (at the origin)
// Zooming closer than the sphere's fit distance (~2.8) crops it — fine for inspecting the material, but a
// thumbnail must show the whole sphere, so the capture clamps the distance back out (see saveActiveMaterial).
const MIN_RADIUS = 1.8;
const MAX_RADIUS = 12;
const INIT_PITCH = -18;   // degrees — slight downward tilt for a 3/4 view
const INIT_YAW = 28;      // degrees
const ROT_SPEED = 10;     // matches the editor's free-fly look sensitivity
const ZOOM_SPEED = 0.005; // wheel delta -> radius

/**
 * Dedicated preview scene for the Material editor. The camera is mounted on an **orbit rig**: a pivot
 * Node at the origin (the sphere's centre) with the camera as a child sitting +Z away and looking back
 * down its -Z at the pivot. Rotating the pivot orbits the camera around the sphere while it always
 * frames the origin — drag to rotate, wheel to zoom, and there is no free-fly or panning. Key + fill
 * directional lights make Basic/Blinn-Phong/PBR all read well. The caller adds the sphere (a ModelNode)
 * as the editable root. No light icons appear because the editor-helper reconciler is skipped in
 * material mode (see EngineContext).
 *
 * The rig is set up synchronously; the environment cubemap (reflections + skybox background) attaches
 * asynchronously — the returned promise resolves once it has. Live tabs fire-and-forget; thumbnail
 * renders await it (with `skybox: false` — the background is skipped in thumbnail captures anyway).
 */
export function createMaterialPreviewScene(scene: Scene, opts?: { skybox?: boolean }): Promise<void> {
  const pivot = new Node('__editor__orbitPivot');
  scene.addNode(pivot);
  pivot.setRotation([INIT_PITCH, INIT_YAW, 0]);

  const cam = new CameraNode('__editor__Camera', new Camera({ fov: PREVIEW_FOV, far: 10000 }));
  cam.active = true;
  // The engine's forward is +Z, so sit the camera on the -Z side of the pivot; its forward then points
  // back through the pivot at the origin. worldForward = pivot·[0,0,1] = -normalize(worldPos) = look-at-origin.
  cam.setPosition([0, 0, -RADIUS]);
  pivot.addChild(cam);

  // Orbit controller lives on the camera's onUpdate (which CameraNode runs before it re-derives the view
  // from the node transform). It rotates the pivot (orbit) and dollies the camera (zoom); the target is
  // always the origin, so the sphere never leaves the centre of the frame.
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

  // Dim fill from the opposite side to reveal the sphere's form. Added FIRST so that in the deferred
  // pipeline (which supports a single directional light — the last one uploaded wins) the brighter key
  // light below is the one that actually lights the sphere; the fill only contributes in forward
  // (Basic/Blinn-Phong) previews.
  const fill = new LightNode('fill', new DirectionalLight({ diffuse: [0.30, 0.32, 0.38], ambient: [0, 0, 0] }));
  fill.setPosition([0, 5, 0]).setRotation([55, 150, 0]);
  fill.castShadows = false;
  scene.addNode(fill);

  // Key light — a touch of ambient keeps metallic PBR from going pitch-black without an environment map.
  const key = new LightNode('key', new DirectionalLight({ ambient: [0.18, 0.18, 0.20] }));
  key.setPosition([0, 5, 0]).setRotation([120, -35, 0]);
  key.castShadows = false;
  scene.addNode(key);

  return applyPreviewEnvironment(scene, opts);
}
