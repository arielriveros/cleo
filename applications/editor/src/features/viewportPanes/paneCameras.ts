// The split viewport's cameras. Pane 0 looks through the editor's main camera (`__editor__Camera`, which
// the 2D/3D switch rigs); panes 1-3 each own an editor camera of their own, `__editor__CameraPane<n>`:
// hidden from the tree, never saved, never picked, never given a camera gizmo, by the same `__editor__`
// rules as the main one. Never put "gizmo" in these names: the raycaster picks editor nodes that say gizmo.

import { Camera, CameraNode, markEditorOwned, type Scene } from 'cleo';
import { vec3 } from 'gl-matrix';
import type { PanePose, PanePreset } from './paneState';

export const MAIN_CAMERA_NAME = '__editor__Camera';
export const paneCameraName = (index: number): string => `__editor__CameraPane${index}`;

/** How far an orthographic pane camera stands back from what it frames, along its axis. */
export const ORTHO_STANDOFF = 100;
/** The half-height an orthographic pane starts at, in metres. */
export const DEFAULT_ORTHO_HALF = 20;
/** How far ahead of a perspective pane camera its view centre is taken to be. */
const PERSPECTIVE_DISTANCE = 20;

type Vec3 = [number, number, number];

/**
 * Each orthographic view: its rotation (Euler degrees: forward is +Z, a positive X turn looks down, a
 * positive yaw turns toward +X), the direction it looks, and the camera's up. Top and Bottom need an up of
 * their own, or the look-at that builds the view matrix degenerates looking straight along the world up.
 * "Front" faces a character that faces +Z (the engine's forward) and so looks along -Z; "Right" shows its
 * right side, which is -X, and so looks along +X.
 */
const ORTHO_VIEWS: Record<Exclude<PanePreset, 'perspective'>, { rotation: Vec3; dir: Vec3; up: Vec3 }> = {
  top: { rotation: [90, 0, 0], dir: [0, -1, 0], up: [0, 0, 1] },
  bottom: { rotation: [-90, 0, 0], dir: [0, 1, 0], up: [0, 0, -1] },
  front: { rotation: [0, 180, 0], dir: [0, 0, -1], up: [0, 1, 0] },
  back: { rotation: [0, 0, 0], dir: [0, 0, 1], up: [0, 1, 0] },
  right: { rotation: [0, 90, 0], dir: [1, 0, 0], up: [0, 1, 0] },
  left: { rotation: [0, -90, 0], dir: [-1, 0, 0], up: [0, 1, 0] },
};

export const isOrthoPreset = (preset: PanePreset): preset is Exclude<PanePreset, 'perspective'> => preset !== 'perspective';

/** The camera node called `name` in `scene`, if any. */
export function findCamera(scene: Scene, name: string): CameraNode | null {
  return scene.getNodesByName(name).find((n): n is CameraNode => n instanceof CameraNode) ?? null;
}

/** The editor's main camera: pane 0's, and the one Simulate, the Sequencer and the 2D/3D switch use. */
export const mainCamera = (scene: Scene): CameraNode | null => findCamera(scene, MAIN_CAMERA_NAME);

/** Whether `node` is one of the split viewport's own pane cameras (not the main one). */
export const isPaneCamera = (node: { name?: string } | null | undefined): boolean =>
  !!node?.name && node.name.startsWith('__editor__CameraPane');

/** The point a camera frames: straight ahead of it, at its standoff. */
export function viewCentre(node: CameraNode): Vec3 {
  const ahead = node.camera.type === 'orthographic' ? ORTHO_STANDOFF : PERSPECTIVE_DISTANCE;
  const p = node.worldPosition, f = node.worldForward;
  return [p[0] + f[0] * ahead, p[1] + f[1] * ahead, p[2] + f[2] * ahead];
}

/** Euler degrees that aim a camera at `from` toward `to` (see ORTHO_VIEWS for the conventions). */
export function lookRotation(from: ArrayLike<number>, to: ArrayLike<number>): Vec3 {
  const d = vec3.normalize(vec3.create(), [to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
  const yaw = Math.atan2(d[0], d[2]) * 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -d[1]))) * 180 / Math.PI;
  return [pitch, yaw, 0];
}

/**
 * What an orthographic pane camera needs beyond its projection: detail (LOD, draw distance, foliage)
 * measured at the depth it frames rather than from where it stands, `ORTHO_STANDOFF` back -- or every
 * view would show the scene at its coarsest -- and no depth of field, which would blur a flat view that
 * has no focus distance. A perspective pane camera gets neither, like the main camera.
 */
function setOrthoLook(node: CameraNode, ortho: boolean): void {
  node.camera.detailDistance = ortho ? ORTHO_STANDOFF : 0;
  node.postChain = ortho ? [{ effect: 'depthOfField', enabled: false }] : null;
}

function setOrthoHalf(camera: Camera, half: number): void {
  camera.top = half;
  camera.bottom = -half;
  camera.left = -half;
  camera.right = half;
}

/** The half-height of an orthographic camera. */
export const orthoHalf = (camera: Camera): number => Math.abs(camera.top - camera.bottom) / 2;

/**
 * Point `node` the way `preset` looks, framing `pivot`: an orthographic view along its axis, standing
 * `ORTHO_STANDOFF` back (inside the shadow distance, which the cascades measure along the view), `half`
 * metres up and down; a perspective view from above and to the side.
 */
export function applyPreset(node: CameraNode, preset: PanePreset, pivot: ArrayLike<number>, half: number = DEFAULT_ORTHO_HALF): void {
  const camera = node.camera;
  if (isOrthoPreset(preset)) {
    const view = ORTHO_VIEWS[preset];
    camera.type = 'orthographic';
    setOrthoHalf(camera, half);
    setOrthoLook(node, true);
    camera.up = vec3.fromValues(view.up[0], view.up[1], view.up[2]);
    node.setPosition([pivot[0] - view.dir[0] * ORTHO_STANDOFF, pivot[1] - view.dir[1] * ORTHO_STANDOFF,
                      pivot[2] - view.dir[2] * ORTHO_STANDOFF]);
    node.setRotation(view.rotation);
  } else {
    camera.type = 'perspective';
    setOrthoLook(node, false);
    camera.up = vec3.fromValues(0, 1, 0);
    const d = PERSPECTIVE_DISTANCE;
    const eye: Vec3 = [pivot[0] + d * 0.6, pivot[1] + d * 0.5, pivot[2] + d * 0.6];
    node.setPosition(eye);
    node.setRotation(lookRotation(eye, pivot));
  }
}

/** Where a pane camera is now, to store. */
export function poseOf(node: CameraNode): PanePose {
  const p = node.position, r = node.rotation;
  const pose: PanePose = { position: [p[0], p[1], p[2]], rotation: [r[0], r[1], r[2]] };
  if (node.camera.type === 'orthographic') pose.ortho = orthoHalf(node.camera);
  return pose;
}

/** Put a pane camera back where `pose` left it, looking the way `preset` looks. */
export function applyPose(node: CameraNode, preset: PanePreset, pose: PanePose): void {
  if (isOrthoPreset(preset)) {
    const view = ORTHO_VIEWS[preset];
    node.camera.type = 'orthographic';
    setOrthoHalf(node.camera, pose.ortho ?? DEFAULT_ORTHO_HALF);
    setOrthoLook(node, true);
    node.camera.up = vec3.fromValues(view.up[0], view.up[1], view.up[2]);
  } else {
    node.camera.type = 'perspective';
    setOrthoLook(node, false);
    node.camera.up = vec3.fromValues(0, 1, 0);
  }
  node.setPosition(pose.position);
  node.setRotation(pose.rotation);
}

/** A new pane camera, editor-owned, not yet in a scene. */
export function createPaneCamera(index: number): CameraNode {
  const node = new CameraNode(paneCameraName(index), new Camera({ far: 10000 }));
  node.active = true;
  markEditorOwned(node);
  return node;
}
