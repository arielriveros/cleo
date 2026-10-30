import { FluidVolumeNode, InputSystem, type CameraNode, type LightNode, type Scene } from 'cleo';
import type { FxParams } from '../fxParams';

// The FX Creator's stage: one engine FluidVolumeNode standing on the grid, an orbit camera around it,
// and the stage sun aimed where the smoke's light comes from -- so the self-shadowing baked into the
// volume (its light channel) and the scene's lighting agree.

const NODE_NAME = 'FX preview';

/** Show the preview volume (created on first use) and return it. */
export function showFxVolume(scene: Scene): FluidVolumeNode {
  const existing = scene.getNodesByName(NODE_NAME).find(n => n instanceof FluidVolumeNode) as FluidVolumeNode | undefined;
  if (existing) return existing;
  const node = new FluidVolumeNode(NODE_NAME);
  scene.addNode(node);
  return node;
}

export function hideFxVolume(scene: Scene, node: FluidVolumeNode | null): void {
  if (!node) return;
  scene.removeNode(node);
  node.dispose();
}

/**
 * Aim the sun so it shines along the FX's light: `lightVector` points from the volume toward the light,
 * and a node looks along `(cos p sin y, -sin p, cos p cos y)` for rotation `[p, y, 0]`.
 */
export function aimSun(sun: LightNode, p: Pick<FxParams, 'lightYaw' | 'lightElevation'>): void {
  sun.setRotation([p.lightElevation, p.lightYaw + 180, 0]);
}

/** Orbit state: a target, a distance and two angles, in the engine's degrees. */
export interface Orbit { target: [number, number, number]; distance: number; pitch: number; yaw: number }

/**
 * An orbit camera for inspecting one object: left-drag orbits, right-drag pans the target, the wheel
 * dollies. Reads the same EditorCamera actions the fly camera does. Returns a function that restores
 * the camera's previous controller.
 */
export function installOrbitCamera(camera: CameraNode, initial: Orbit): { frame(o: Orbit): void; current(): Orbit; restore(): void } {
  const previous = camera.onUpdate;
  const previousNear = camera.camera.near;
  // A metre-scale effect wants a near plane the size of a hand, not the World Creator's metre.
  camera.camera.near = 0.05;
  let o: Orbit = { ...initial, target: [...initial.target] as [number, number, number] };

  const place = () => {
    const p = o.pitch * Math.PI / 180, y = o.yaw * Math.PI / 180;
    const f = [Math.cos(p) * Math.sin(y), -Math.sin(p), Math.cos(p) * Math.cos(y)];
    camera.setPosition([o.target[0] - f[0] * o.distance, o.target[1] - f[1] * o.distance, o.target[2] - f[2] * o.distance]);
    camera.setRotation([o.pitch, o.yaw, 0]);
  };

  camera.onUpdate = (dt: number) => {
    const input = InputSystem.instance;
    const look = input.vector('EditorCamera/Look');
    if (look[0] !== 0 || look[1] !== 0) {
      o.yaw -= look[0] * dt * 10;
      o.pitch = Math.max(-85, Math.min(85, o.pitch + look[1] * dt * 10));
    }
    const pan = input.vector('EditorCamera/Pan');
    if (pan[0] !== 0 || pan[1] !== 0) {
      const y = o.yaw * Math.PI / 180;
      const k = o.distance * dt * 0.6;
      // The view follows the mouse: dragging right moves the scene right, so the target moves to the
      // camera's LEFT. Screen up is world up, which keeps the target on its plane.
      o.target[0] += Math.cos(y) * pan[0] * k;
      o.target[2] -= Math.sin(y) * pan[0] * k;
      o.target[1] += pan[1] * k;
    }
    const wheel = input.value('EditorCamera/Zoom');
    if (Math.abs(wheel) > 0) o.distance = Math.max(0.3, o.distance * Math.exp(wheel * 0.001));
    place();
  };
  place();

  return {
    frame(next: Orbit) { o = { ...next, target: [...next.target] as [number, number, number] }; place(); },
    current() { return { ...o, target: [...o.target] as [number, number, number] }; },
    restore() { camera.onUpdate = previous; camera.camera.near = previousNear; },
  };
}

/**
 * An orbit that frames a box of `size` whose floor centre is `floor`, seen from the front and a little
 * above.
 */
export function frameBox(size: readonly [number, number, number], yaw = 20, floor: readonly [number, number, number] = [0, 0, 0]): Orbit {
  const extent = Math.max(size[0], size[1], size[2]);
  return { target: [floor[0], floor[1] + size[1] * 0.5, floor[2]], distance: extent * 1.9, pitch: 12, yaw };
}

/** An orbit centred on `centre` from `distance` away, keeping the current angles. */
export function frameAt(current: { pitch: number; yaw: number }, centre: readonly [number, number, number], distance: number): Orbit {
  return { target: [centre[0], centre[1], centre[2]], distance: Math.max(0.5, distance), pitch: current.pitch, yaw: current.yaw };
}
