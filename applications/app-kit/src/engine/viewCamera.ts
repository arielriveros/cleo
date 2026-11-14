import { InputSystem, type CameraNode } from 'cleo';

/**
 * The free-navigation viewport camera every Cleo application shares: fly/orbit/pan/dolly in 3D, pan and
 * zoom in 2D. Reads the `EditorCamera` action map (see viewCameraMap.ts), so the chords -- and turning
 * the whole map off during a gizmo drag or while a game plays -- live in one place, not in `if`s here.
 *
 * The controller is a per-frame step, not an object: install it as the camera node's `onUpdate`
 * (`cam.onUpdate = (dt) => stepViewCamera3D(cam, dt, prefs())`), and pass the prefs by getter so a
 * slider moved in an options panel takes effect on the next frame.
 */
export interface ViewCameraPrefs {
  /** Multiplier on translation speed (fly, pan, nudge). 1 is the default. */
  flySpeed: number;
  /** Multiplier on mouse-look rotation. 1 is the default. */
  lookSensitivity: number;
}

export const DEFAULT_VIEW_CAMERA_PREFS: ViewCameraPrefs = { flySpeed: 1, lookSensitivity: 1 };

/** One frame of 3D navigation: left-drag look, WASD/QE fly while a button is held, right-drag pan, wheel dolly. */
export function stepViewCamera3D(node: CameraNode, delta: number, prefs: ViewCameraPrefs): void {
  const input = InputSystem.instance;
  const movement = delta * 2 * prefs.flySpeed;
  const lookRate = delta * 2 * prefs.lookSensitivity;
  // Every chord below is a BINDING (see viewCameraMap): the button each one needs held is a modifier
  // on the binding rather than an `if` here, and the whole map goes off during a gizmo drag and Play.
  const look = input.vector('EditorCamera/Look');
  if (look[0] !== 0 || look[1] !== 0)
    node.rotateX(look[1] * lookRate * 5).rotateY(-look[0] * lookRate * 5);
  const fly = input.vector('EditorCamera/Fly');
  const lift = input.value('EditorCamera/Lift');
  if (fly[1] !== 0) node.addForward(fly[1] * movement);
  if (fly[0] !== 0) node.addRight(fly[0] * movement);
  if (lift !== 0) node.addY(lift * movement);
  const pan = input.vector('EditorCamera/Pan');
  if (pan[0] !== 0 || pan[1] !== 0) {
    node.addRight(-pan[0] * movement);
    node.addUp(pan[1] * movement);
  }
  const wheel = input.value('EditorCamera/Zoom');
  if (Math.abs(wheel) > 0) node.addForward(-wheel * 0.01); // wheel up -> move forward
}

/** Smallest half-extent the 2D zoom allows, so a fast scroll can never collapse the frustum. */
const MIN_ORTHO_EXTENT = 0.1;

function clampExtent(v: number): number {
  if (Math.abs(v) >= MIN_ORTHO_EXTENT) return v;
  return (v >= 0 ? 1 : -1) * MIN_ORTHO_EXTENT;
}

/** One frame of 2D navigation on an orthographic camera: drag to pan with either button, WASD nudge, wheel zoom. */
export function stepViewCamera2D(node: CameraNode, delta: number, prefs: ViewCameraPrefs): void {
  const input = InputSystem.instance;
  const movement = delta * prefs.flySpeed;
  const pan = input.vector('EditorCamera/Pan2D');
  const nudge = input.vector('EditorCamera/Fly');
  if (pan[0] !== 0 || pan[1] !== 0) {
    node.addX(-pan[0] * movement);
    node.addY(pan[1] * movement);
  }
  node.addX(nudge[0] * movement * 10);
  node.addY(nudge[1] * movement * 10);
  zoomOrthoExtents(node, input.value('EditorCamera/Zoom'));
}

/**
 * Scale an orthographic camera's extents by a wheel reading. Wheel up (deltaY < 0) SHRINKS them -- shows
 * less world, zooms in -- matching the 3D rig's dolly and every other wheel in the apps.
 */
export function zoomOrthoExtents(node: CameraNode, wheel: number): void {
  if (!(Math.abs(wheel) > 0)) return;
  const factor = Math.max(0.1, 1 + wheel * 0.001); // avoid inverting the frustum on a fast scroll
  const cam = node.camera;
  cam.top = clampExtent(cam.top * factor);
  cam.bottom = clampExtent(cam.bottom * factor);
  cam.left = clampExtent(cam.left * factor);
  cam.right = clampExtent(cam.right * factor);
}

/**
 * One frame of navigation on an orthographic camera looking along ANY axis -- the editor's Top, Front,
 * Right... panes. Drag with either button to pan in the view plane, the scene staying under the cursor
 * (one pointer pixel is one pixel of the view, `viewHeightPx` tall); WASD nudges half a view a second;
 * the wheel zooms the extents. Unlike {@link stepViewCamera2D}, which pans in world X/Y, this pans along
 * the camera's own right and up, so it works for a camera looking down as well as one looking along Z.
 */
export function stepViewCameraOrtho(node: CameraNode, delta: number, prefs: ViewCameraPrefs, viewHeightPx: number): void {
  const input = InputSystem.instance;
  const cam = node.camera;
  const span = Math.abs(cam.top - cam.bottom);
  const unitsPerPixel = span / Math.max(1, viewHeightPx);
  const pan = input.vector('EditorCamera/Pan2D');
  if (pan[0] !== 0 || pan[1] !== 0) {
    // Grab the scene: dragging right moves the camera left, dragging down moves it up.
    node.addRight(-pan[0] * unitsPerPixel);
    node.addUp(pan[1] * unitsPerPixel);
  }
  const nudge = input.vector('EditorCamera/Fly');
  const step = span * 0.5 * delta * prefs.flySpeed;
  if (nudge[0] !== 0) node.addRight(nudge[0] * step);
  if (nudge[1] !== 0) node.addUp(nudge[1] * step);
  zoomOrthoExtents(node, input.value('EditorCamera/Zoom'));
}
