import { useEffect, useRef, useState } from 'react';
import { quat, vec3 } from 'gl-matrix';
import { Raycaster, type CleoEngine, type FluidVolumeNode, type Node, type Scene } from 'cleo';
import TransformGizmoView, { type GizmoBus } from '@cleo/app-kit/gizmo/TransformGizmo';
import BoxVolumeGizmoView, { type VolumeTarget } from '@cleo/app-kit/gizmo/BoxVolumeGizmo';
import type { TransformPatch } from '@cleo/app-kit/gizmo/gizmoDrag';
import type { GizmoMode, GizmoSpace } from '@cleo/app-kit/gizmo/types';
import { captureViewport, isViewportCaptured, releaseViewport } from '@cleo/app-kit/utils/pointerCapture';
import { fluidDims } from '../fluidCpu';
import { MIN_REGION, normaliseFx, type FxParams } from '../fxParams';
import type { FxBody, FxScene } from '../fxScene';
import { aimVector } from '../liquidCpu';
import { regionOrigin } from '../liveSim';
import { bodyDistance } from '../obstacles';
import type { AimArrow, FxStage } from './fxStage';

// The FX viewport's direct manipulation: click to select a body, the emitter or the simulation region;
// the shared transform gizmo (app-kit, the editor's own) on a body or the emitter; and the shared box face
// handles (the editor's collision-shape / volume handles) on the region. Everything a handle changes is
// written back into the FxScene / FxParams the panels show, so the solver, the bake and the panels agree:
//   - the emitter: move = its position (metres from the centre of the region's floor), rotate = a liquid's
//     Aim yaw / Aim pitch (its arrow shows it), scale = the radius;
//   - the region: move = where it stands, its face handles = its size. The effect stays where it is in the
//     world as a face moves: the region is room around it. Its box always shows, brighter while selected.
// These have no fields in the panels (FxSpec `gizmo`): the gizmo's drag readout shows the values.

export type FxSelection = { kind: 'body'; id: string } | { kind: 'emitter' } | { kind: 'region' } | null;

interface Props {
  instance: CleoEngine | null;
  scene: Scene | null;
  bus: GizmoBus & { on(event: string, fn: (...a: any[]) => void): unknown; off(event: string, fn: (...a: any[]) => void): unknown };
  stage: React.MutableRefObject<FxStage | null>;
  volume: React.MutableRefObject<FluidVolumeNode | null>;
  viewportRef: React.RefObject<HTMLDivElement>;
  params: FxParams;
  setParams: (p: FxParams) => void;
  fxScene: FxScene;
  setFxScene: (s: FxScene) => void;
  selection: FxSelection;
  select: (s: FxSelection) => void;
  mode: GizmoMode;
  space: GizmoSpace;
  /** Bumped when the stage is (re)built, so the markers are placed on it. */
  stageVersion: number;
}

/** The region's low corner in the stage: the region stands centred on its offset (its floor's centre). */
export function regionCorner(p: FxParams, offset: readonly [number, number, number]): [number, number, number] {
  const r = normaliseFx(p).regionSize;
  return [offset[0] - r[0] / 2, offset[1], offset[2] - r[2] / 2];
}

/**
 * The marker's turn for an aim (degrees; yaw from +Z toward +X, pitch up): the rotation taking the node's
 * forward (+Z) onto the aim, with no roll.
 */
export function quatFromAim(yawDeg: number, pitchDeg: number): quat {
  const q = quat.setAxisAngle(quat.create(), [0, 1, 0], (yawDeg * Math.PI) / 180);
  // About the node's own X, by minus the pitch: a positive aim pitch turns forward up.
  const tilt = quat.setAxisAngle(quat.create(), [1, 0, 0], (-pitchDeg * Math.PI) / 180);
  return quat.multiply(q, q, tilt);
}

/** The aim a turned marker points (its forward, +Z): yaw from +Z toward +X and pitch up, degrees. */
export function aimFromQuat(q: quat): { yaw: number; pitch: number } {
  const f = vec3.transformQuat(vec3.create(), [0, 0, 1], q);
  return { yaw: (Math.atan2(f[0], f[2]) * 180) / Math.PI, pitch: (Math.asin(Math.max(-1, Math.min(1, f[1]))) * 180) / Math.PI };
}

/** The aim's arrows from the emitter: one along a liquid's aim, or one per side of a crown at its pitch. */
export function aimArrows(p: FxParams, offset: readonly [number, number, number]): AimArrow[] {
  const n = normaliseFx(p);
  if (n.medium !== 'liquid') return [];
  const from = emitterPose(n, offset).position;
  const length = Math.max(0.02, 0.2 * Math.min(n.regionSize[0], n.regionSize[2]));
  if (n.sourceShape === 'ring') {
    const pitch = (n.sourcePitch * Math.PI) / 180, R = Math.max(n.dropletSize * 2, n.sourceRadius);
    return [0, 1, 2, 3].map(k => {
      const a = (k * Math.PI) / 2;
      const out: [number, number, number] = [Math.sin(a), 0, Math.cos(a)];
      return { from: [from[0] + out[0] * R, from[1], from[2] + out[2] * R], dir: [Math.cos(pitch) * out[0], Math.sin(pitch), Math.cos(pitch) * out[2]], length };
    });
  }
  return [{ from, dir: aimVector(n), length }];
}

/**
 * World position and radius of the emitter, for the marker, the gizmo and picking: `emitterPosition` from
 * the centre of the region's floor, as both solvers place it (fluidCpu `emitterVoxels`, liquidCpu
 * `sourceCenter`).
 */
export function emitterPose(p: FxParams, offset: readonly [number, number, number]): { position: [number, number, number]; radius: number } {
  const n = normaliseFx(p);
  const e = n.emitterPosition;
  return {
    position: [offset[0] + e[0], offset[1] + e[1], offset[2] + e[2]],
    radius: n.medium === 'liquid'
      ? (n.sourceShape === 'point' ? Math.max(0.02, n.dropletSize * 3) : Math.max(0.01, n.sourceRadius))
      : Math.max(n.emitterRadius, n.voxelSize),
  };
}

/**
 * A region resized by its handles to `size`, its box now centred at world `centre`: the parameters and
 * floor offset that hold it, with the emitter kept at `emitterWorld` (where it stood when the drag began)
 * -- the region is room around the effect, so growing a face never moves or scales what it holds.
 */
export function regionEdit(p: FxParams, size: readonly number[], centre: readonly number[], emitterWorld?: readonly number[]):
    { params: FxParams; regionOffset: [number, number, number] } {
  const regionOffset: [number, number, number] = [centre[0], centre[1] - size[1] / 2, centre[2]];
  return {
    params: {
      ...p, regionSize: [size[0], size[1], size[2]],
      ...(emitterWorld ? { emitterPosition: [emitterWorld[0] - regionOffset[0], emitterWorld[1] - regionOffset[1], emitterWorld[2] - regionOffset[2]] as [number, number, number] } : {}),
    },
    regionOffset,
  };
}

/**
 * Turn and tilt (degrees) of a rotation with its roll dropped -- bodies have no roll. Read off the rotated
 * axes rather than an Euler decomposition, whose yaw is confined to +/-90 and would flip a turned body.
 */
export function turnTiltOf(q: quat): { yaw: number; pitch: number } {
  const x = vec3.transformQuat(vec3.create(), [1, 0, 0], q);
  const y = vec3.transformQuat(vec3.create(), [0, 1, 0], q);
  const yaw = Math.atan2(-x[2], x[0]);
  const pitch = Math.atan2(y[0] * Math.sin(yaw) + y[2] * Math.cos(yaw), y[1]);
  return { yaw: (yaw * 180) / Math.PI, pitch: (pitch * 180) / Math.PI };
}

/** Ray against a sphere: distance along the ray, or null. */
function raySphere(o: vec3, d: vec3, c: readonly number[], r: number): number | null {
  const oc = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
  const b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2];
  const k = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - r * r;
  const h = b * b - k;
  if (h < 0) return null;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : (-b + Math.sqrt(h) >= 0 ? 0 : null);
}

/** Ray against an axis-aligned box: entry distance, or null. */
function rayBox(o: vec3, d: vec3, min: readonly number[], max: readonly number[]): number | null {
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) { if (o[k] < min[k] || o[k] > max[k]) return null; continue; }
    let a = (min[k] - o[k]) / d[k], b = (max[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  return t1 >= t0 ? t0 : null;
}

/** Ray against a body, by marching its exact signed distance (sphere tracing). */
function rayBody(o: vec3, d: vec3, b: FxBody, far = 200): number | null {
  let t = 0;
  for (let i = 0; i < 96 && t < far; i++) {
    const dist = bodyDistance(b, [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
    if (dist < 1e-3) return t;
    t += dist;
  }
  return null;
}

export function FxGizmos({ instance, scene, bus, stage, volume, viewportRef, params, setParams, fxScene, setFxScene, selection, select, mode, space }: Props) {
  // Latest values for the listeners and the callbacks the gizmos hold.
  const live = useRef({ params, fxScene, selection, select, setParams, setFxScene });
  live.current = { params, fxScene, selection, select, setParams, setFxScene };
  /**
   * What the selection looked like when the drag began: the gizmo's scale is relative to it, and a region
   * resize keeps the emitter where it was in the world.
   */
  const grab = useRef<{ size?: [number, number, number]; radius?: number; emitterWorld?: [number, number, number] } | null>(null);
  const lastDragEnd = useRef(0);
  const gizmoDragging = useRef(false);
  /** The size the region's handles last set: newer than `params` until the next render. */
  const regionSize = useRef<[number, number, number] | null>(null);

  // The emitter marker follows the parameters (a liquid's turned to its aim, with the aim's arrows), and
  // shows while the emitter is selected (or always, from the eye menu). It is created here, after the
  // render that picked the gizmo's target, so its id is handed back through state. The region's
  // wireframe follows the region the same way, and while the region is selected it stays, brighter.
  const [markerId, setMarkerId] = useState<string | null>(null);
  useEffect(() => {
    const offset = fxScene.regionOffset ?? [0, 0, 0];
    const n = normaliseFx(params);
    const pose = emitterPose(n, offset);
    const showEmitter = selection?.kind === 'emitter' || fxScene.showHelpers !== false;
    const turn = n.medium === 'liquid' ? quatFromAim(n.sourceShape === 'ring' ? 0 : n.sourceYaw, n.sourcePitch) : undefined;
    stage.current?.showEmitter(showEmitter ? pose.position : null, pose.radius, turn);
    stage.current?.showAim(showEmitter ? aimArrows(n, offset) : []);
    const id = stage.current?.emitterNode?.id ?? null;
    if (id !== markerId) setMarkerId(id);
    if (!gizmoDragging.current) regionSize.current = null;
    const regionSelected = selection?.kind === 'region';
    stage.current?.showRegion(fxScene.showHelpers !== false || regionSelected ? regionCorner(n, offset) : null, [...n.regionSize] as [number, number, number], regionSelected);
  });

  useEffect(() => {
    const onStart = () => {
      const { selection: sel, fxScene: s, params: p } = live.current;
      if (sel?.kind === 'body') grab.current = { size: [...(s.bodies.find(b => b.id === sel.id)?.size ?? [1, 1, 1])] as [number, number, number] };
      else if (sel?.kind === 'emitter') { const n = normaliseFx(p); grab.current = { radius: n.medium === 'liquid' ? n.sourceRadius : n.emitterRadius }; }
      else if (sel?.kind === 'region') grab.current = { emitterWorld: emitterPose(p, s.regionOffset ?? [0, 0, 0]).position };
      else grab.current = null;
      gizmoDragging.current = true;
    };
    const onEnd = () => { lastDragEnd.current = performance.now(); grab.current = null; gizmoDragging.current = false; };
    bus.on('GIZMO_DRAG_START', onStart);
    bus.on('GIZMO_DRAG_END', onEnd);
    return () => { bus.off('GIZMO_DRAG_START', onStart); bus.off('GIZMO_DRAG_END', onEnd); };
  }, [bus]);

  // Orbit and pan drags capture the mouse, as the editor's viewport does (EngineViewport): once a press
  // has moved 5 px -- so a plain click never hides the cursor -- and never under a gizmo drag, which takes
  // the capture itself. A press and release in place is a click: it selects.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !instance) return;
    let down: { x: number; y: number; button: number } | null = null;
    let dragged = false;
    let captured = false;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-cleo-overlay]')) return;
      down = { x: e.clientX, y: e.clientY, button: e.button };
      dragged = false;
    };
    const onMove = (e: MouseEvent) => {
      if (!down || dragged || gizmoDragging.current) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 5) return;
      dragged = true;
      if (!isViewportCaptured()) { captureViewport(instance); captured = true; }
    };
    const onUp = (e: MouseEvent) => {
      const start = down;
      const wasDrag = dragged;
      down = null;
      dragged = false;
      if (captured) { captured = false; if (isViewportCaptured()) releaseViewport(); }
      if (!start || wasDrag || e.button !== 0 || start.button !== 0) return;
      if (performance.now() - lastDragEnd.current < 150) return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-cleo-overlay]')) return;
      const cam = instance.scene?.activeCamera?.camera;
      const rect = el.getBoundingClientRect();
      if (!cam) return;
      const ray = Raycaster.screenToRay(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, cam);
      const { fxScene: s, params: p } = live.current;
      let best: { t: number; sel: FxSelection } | null = null;
      const consider = (t: number | null, sel: FxSelection) => { if (t !== null && (!best || t < best.t)) best = { t, sel }; };
      if (s.showHelpers !== false) for (const b of s.bodies) if (b.visible) consider(rayBody(ray.origin, ray.direction, b), { kind: 'body', id: b.id });
      const em = emitterPose(p, s.regionOffset ?? [0, 0, 0]);
      consider(raySphere(ray.origin, ray.direction, em.position, Math.max(em.radius, 0.15)), { kind: 'emitter' });
      if (!best) {
        // The region box itself, only when nothing inside it was hit: it encloses everything else.
        const n = normaliseFx(p);
        const off = s.regionOffset ?? [0, 0, 0];
        const [w, h, dpt] = n.regionSize;
        consider(rayBox(ray.origin, ray.direction, [off[0] - w / 2, off[1], off[2] - dpt / 2], [off[0] + w / 2, off[1] + h, off[2] + dpt / 2]), { kind: 'region' });
      }
      live.current.select(best ? (best as { sel: FxSelection }).sel : null);
    };
    el.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (captured && isViewportCaptured()) releaseViewport();
    };
  }, [instance, viewportRef]);

  // The node the transform gizmo drives: a body, the emitter, or (moving it) the region's handle.
  const target: Node | null = selection?.kind === 'body' ? stage.current?.bodyNode(selection.id) ?? null
    : selection?.kind === 'emitter' && markerId ? stage.current?.emitterNode ?? null
    : selection?.kind === 'region' && mode === 'position' ? stage.current?.regionNode ?? null : null;

  const onTransform = (_id: string, patch: TransformPatch) => {
    const { selection: sel, fxScene: s, params: p } = live.current;
    if (sel?.kind === 'body') {
      const body = s.bodies.find(b => b.id === sel.id);
      if (!body) return;
      let next: FxBody = body;
      if (patch.kind === 'position') next = { ...body, position: [patch.local[0], patch.local[1], patch.local[2]] };
      else if (patch.kind === 'rotation') next = { ...body, ...turnTiltOf(patch.localQuat) };
      else {
        const g = grab.current?.size ?? body.size;
        next = { ...body, size: [Math.max(0.02, g[0] * patch.local[0]), Math.max(0.02, g[1] * patch.local[1]), Math.max(0.02, g[2] * patch.local[2])] };
        // The size carries the scale; the node stays at scale 1 so the mesh and collider are rebuilt exact.
        stage.current?.bodyNode(sel.id)?.setScale([1, 1, 1]);
      }
      live.current.setFxScene({ ...s, bodies: s.bodies.map(b => (b.id === body.id ? next : b)) });
    } else if (sel?.kind === 'region') {
      // The region moved whole: it carries the effect (the emitter is placed in it) to its new place.
      if (patch.kind !== 'position') return;
      const size = normaliseFx(p).regionSize;
      live.current.setFxScene({ ...s, regionOffset: [patch.local[0], patch.local[1] - size[1] / 2, patch.local[2]] });
    } else if (sel?.kind === 'emitter') {
      const n = normaliseFx(p);
      if (patch.kind === 'position') {
        // The inverse of `emitterPose`; `normaliseFx` keeps it inside the region.
        const o = s.regionOffset ?? [0, 0, 0];
        live.current.setParams({ ...p, emitterPosition: [patch.local[0] - o[0], patch.local[1] - o[1], patch.local[2] - o[2]] });
      } else if (patch.kind === 'rotation' && n.medium === 'liquid') {
        // The marker's forward is the aim. A crown's aim is only its pitch (out and up, all round).
        const aim = aimFromQuat(patch.localQuat);
        const pitch = Math.round(Math.max(-90, Math.min(90, aim.pitch)) * 10) / 10;
        const yaw = Math.round(aim.yaw * 10) / 10;
        live.current.setParams(n.sourceShape === 'ring' ? { ...p, sourcePitch: pitch } : { ...p, sourceYaw: yaw, sourcePitch: pitch });
      } else if (patch.kind === 'scale' && n.medium === 'liquid') {
        const g = grab.current?.radius ?? n.sourceRadius;
        const s3 = (patch.local[0] + patch.local[1] + patch.local[2]) / 3;
        live.current.setParams({ ...p, sourceRadius: Math.min(1, Math.max(0.005, g * s3)) });
      } else if (patch.kind === 'scale') {
        const g = grab.current?.radius ?? n.emitterRadius;
        const s3 = (patch.local[0] + patch.local[1] + patch.local[2]) / 3;
        const most = 0.5 * Math.min(n.regionSize[0], n.regionSize[2]);
        live.current.setParams({ ...p, emitterRadius: Math.min(most, Math.max(n.voxelSize, g * s3)) });
      }
    }
  };

  // The region's face handles edit the size (an FxParams value: part of the effect) and, through the
  // handle node's position, where it stands (an FxScene value: the preview's). Both land in
  // `onRegionEdited`, which the handles call right after.
  const regionTarget: VolumeTarget = {
    size: () => [...(regionSize.current ?? normaliseFx(live.current.params).regionSize)] as [number, number, number],
    setSize: s => { regionSize.current = [s[0], s[1], s[2]]; },
    minSize: MIN_REGION,
  };
  // The handles set the size, then move the node (its centre), then report: the offset is the centre of
  // the region's floor, from the size just set rather than the not-yet-rendered parameters. The emitter
  // keeps its place in the world -- the region is room around the effect -- and the box follows at once,
  // so it never lags the handles.
  const onRegionEdited = (n: Node) => {
    const { params: p, fxScene: s } = live.current;
    const size = regionSize.current ?? normaliseFx(p).regionSize;
    const c = n.position;
    const edit = regionEdit(p, size, [c[0], c[1], c[2]], grab.current?.emitterWorld);
    live.current.setParams(edit.params);
    live.current.setFxScene({ ...s, regionOffset: edit.regionOffset });
    stage.current?.showRegion([c[0] - size[0] / 2, c[1] - size[1] / 2, c[2] - size[2] / 2], [size[0], size[1], size[2]], true);
  };

  return <>
    <TransformGizmoView instance={instance} scene={scene} bus={bus} selectedNodeId={target?.id ?? null}
                        mode={selection?.kind === 'emitter' && mode === 'rotation' && params.medium !== 'liquid' ? 'position' : mode} space={space}
                        onTransformChange={onTransform} viewportRef={viewportRef} />
    <BoxVolumeGizmoView instance={instance} bus={bus} node={stage.current?.regionNode ?? null} target={regionTarget}
                        active={selection?.kind === 'region'} onEdited={onRegionEdited} viewportRef={viewportRef} />
  </>;
}
