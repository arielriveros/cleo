import { Scene, Node, Camera, CameraNode, LightNode, DirectionalLight, InputManager } from 'cleo';
import { PREVIEW_FOV, fitDistance, previewClipPlanes } from './previewFraming';
import { applyPreviewEnvironment } from './previewEnvironment';
import { clamp } from '../../utils/math';

const RADIUS = 3.2;       // camera distance from the sphere (at the origin)
// Closer than the sphere's fit distance (~2.8) crops it; thumbnail capture clamps back out
// (saveActiveMaterial).
const MIN_RADIUS = 1.8;
const MAX_RADIUS = 12;
const INIT_PITCH = -18;   // degrees — slight downward tilt for a 3/4 view
// A terrain patch is looked DOWN at, not across: at the sphere's -18 a horizontal surface is nearly
// edge-on and its relief — the thing the preview exists to show — is invisible.
//
// POSITIVE, because positive pitch looks DOWN here (`setRotation([90,0,0])` gives forward `(0,-1,0)`,
// and every other rig in the editor uses positive to look at the origin from above). At -42 this rig put
// the camera 10.6 m UNDERNEATH the patch — the pivot's forward pointed up and the camera hangs at
// `-radius * forward` — which made the preview useless as a reference in three ways at once:
// `parallaxFrame` orients by the view vector (`select(-nGeo, nGeo, dot(nGeo, toEye) >= 0)`), so the
// whole POM basis mirrored while `addLayer`'s lighting normal still pointed up; the key light ended up
// on the far side of the surface; and terrain is `side: 'front'`, so the patch was being viewed from its
// culled face. `modelThumbnails` captures with no user interaction, so every terrain-material thumbnail
// was shot from below.
const TERRAIN_PITCH = 42;
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
  // `subjectRadius` frames something other than the unit sphere. A terrain-material preview is a patch
  // several metres across, and the sphere-tuned literals below would leave the camera inside it.
  opts?: { skybox?: boolean; silently?: <T>(fn: () => T) => T; subjectRadius?: number },
): Promise<void> {
  const subject = opts?.subjectRadius;
  const startRadius = subject ? fitDistance(subject) : RADIUS;
  const minRadius = subject ? startRadius * 0.5 : MIN_RADIUS;
  const maxRadius = subject ? startRadius * 4 : MAX_RADIUS;
  const startPitch = subject ? TERRAIN_PITCH : INIT_PITCH;

  const pivot = new Node('__editor__orbitPivot');
  scene.addNode(pivot);
  pivot.setRotation([startPitch, INIT_YAW, 0]);

  // The camera defaults (near 0.1 / far 100) only suit human-scale objects; a patch several metres wide
  // seen from its fit distance needs planes derived from the framing or it clips at one end.
  const clip = subject ? previewClipPlanes(startRadius, subject) : { near: undefined, far: 10000 };
  const cam = new CameraNode('__editor__Camera',
    new Camera({ fov: PREVIEW_FOV, near: clip.near, far: clip.far }));
  cam.active = true;
  // Engine forward is +Z, so the camera sits on the pivot's -Z side and looks back through the origin.
  cam.setPosition([0, 0, -startRadius]);
  pivot.addChild(cam);

  // CameraNode runs onUpdate before it re-derives the view from the node transform.
  let pitch = startPitch, yaw = INIT_YAW, radius = startRadius;
  cam.onUpdate = (delta) => {
    const mouse = InputManager.instance.mouse;
    if (mouse.buttons.Left) {
      yaw -= mouse.velocity[0] * delta * ROT_SPEED;
      pitch += mouse.velocity[1] * delta * ROT_SPEED;
      pitch = clamp(pitch, -85, 85); // don't roll over the poles
      pivot.setRotation([pitch, yaw, 0]);
    }
    if (Math.abs(mouse.wheel.deltaY) > 0 && InputManager.instance.isMouseOverCanvas()) {
      radius = clamp(radius + mouse.wheel.deltaY * ZOOM_SPEED, minRadius, maxRadius);
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
