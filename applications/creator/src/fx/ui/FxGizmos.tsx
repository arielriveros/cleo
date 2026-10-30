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
import { regionOrigin } from '../liveSim';
import { bodyDistance } from '../obstacles';
import type { FxStage } from './fxStage';

// The FX viewport's direct manipulation: click to select a body, the emitter or the simulation region;
// the shared transform gizmo (app-kit, the editor's own) on a body or the emitter; and the shared box face
// handles (the editor's collision-shape / volume handles) on the region. Everything a handle changes is
// written back into the FxScene / FxParams the panels show, so the solver, the bake and the panels agree.

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
}

/** World position and radius of the emitter, for the marker, the gizmo and picking. */
export function emitterPose(p: FxParams, offset: readonly [number, number, number]): { position: [number, number, number]; radius: number } {
  const n = normaliseFx(p);
  const d = fluidDims(n);
  const v = n.voxelSize;
  const o = regionOrigin(d, v, offset);
  return {
    position: [o[0] + (n.emitterX * (d.nx - 1) + 0.5) * v, o[1] + (n.emitterHeight * (d.ny - 1) + 0.5) * v, o[2] + (n.emitterZ * (d.nz - 1) + 0.5) * v],
    radius: Math.max(1, n.emitterRadius * d.nx) * v,
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
  /** What the selection looked like when the drag began: the gizmo's scale is relative to it. */
  const grab = useRef<{ size?: [number, number, number]; radius?: number } | null>(null);
  const lastDragEnd = useRef(0);
  const gizmoDragging = useRef(false);

  // The emitter marker follows the parameters, and shows while the emitter is selected (or always, from
  // the eye menu). It is created here, after the render that picked the gizmo's target, so its id is
  // handed back through state. The region's wireframe follows the region the same way, except while the
  // region is selected: its box gizmo draws it then.
  const [markerId, setMarkerId] = useState<string | null>(null);
  useEffect(() => {
    const offset = fxScene.regionOffset ?? [0, 0, 0];
    const pose = emitterPose(params, offset);
    stage.current?.showEmitter(selection?.kind === 'emitter' || fxScene.showEmitter ? pose.position : null, pose.radius);
    const id = stage.current?.emitterNode?.id ?? null;
    if (id !== markerId) setMarkerId(id);
    const n = normaliseFx(params);
    const d = fluidDims(n);
    const size: [number, number, number] = [d.nx * n.voxelSize, d.ny * n.voxelSize, d.nz * n.voxelSize];
    stage.current?.showRegion(fxScene.showRegion !== false && selection?.kind !== 'region' ? regionOrigin(d, n.voxelSize, offset) : null, size);
  });

  useEffect(() => {
    const onStart = () => {
      const { selection: sel, fxScene: s, params: p } = live.current;
      if (sel?.kind === 'body') grab.current = { size: [...(s.bodies.find(b => b.id === sel.id)?.size ?? [1, 1, 1])] as [number, number, number] };
      else if (sel?.kind === 'emitter') grab.current = { radius: normaliseFx(p).emitterRadius };
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
      if (s.showBodies !== false) for (const b of s.bodies) if (b.visible) consider(rayBody(ray.origin, ray.direction, b), { kind: 'body', id: b.id });
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

  // The node the transform gizmo drives.
  const target: Node | null = selection?.kind === 'body' ? stage.current?.bodyNode(selection.id) ?? null
    : selection?.kind === 'emitter' && markerId ? stage.current?.emitterNode ?? null : null;

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
    } else if (sel?.kind === 'emitter') {
      const n = normaliseFx(p);
      const d = fluidDims(n);
      const v = n.voxelSize;
      if (patch.kind === 'position') {
        const o = regionOrigin(d, v, s.regionOffset ?? [0, 0, 0]);
        const frac = (w: number, lo: number, cells: number) => Math.min(0.98, Math.max(0.02, ((w - lo) / v - 0.5) / Math.max(1, cells - 1)));
        live.current.setParams({ ...p, emitterX: frac(patch.local[0], o[0], d.nx), emitterHeight: frac(patch.local[1], o[1], d.ny), emitterZ: frac(patch.local[2], o[2], d.nz) });
      } else if (patch.kind === 'scale') {
        const g = grab.current?.radius ?? n.emitterRadius;
        const s3 = (patch.local[0] + patch.local[1] + patch.local[2]) / 3;
        live.current.setParams({ ...p, emitterRadius: Math.min(0.45, Math.max(0.01, g * s3)) });
      }
    }
  };

  // The region's face handles edit the size (an FxParams value: part of the effect) and, through the
  // node's position, where it stands (an FxScene value: the preview's).
  const regionTarget: VolumeTarget = {
    size: () => [...normaliseFx(live.current.params).regionSize] as [number, number, number],
    setSize: s => {
      const node = volume.current;
      if (node) node.size = [s[0], s[1], s[2]];
      live.current.setParams({ ...live.current.params, regionSize: [s[0], s[1], s[2]] });
    },
    minSize: MIN_REGION,
  };
  const onRegionEdited = (n: Node) => {
    const size = normaliseFx(live.current.params).regionSize;
    const p = n.position;
    live.current.setFxScene({ ...live.current.fxScene, regionOffset: [p[0], p[1] - size[1] / 2, p[2]] });
  };

  return <>
    <TransformGizmoView instance={instance} scene={scene} bus={bus} selectedNodeId={target?.id ?? null}
                        mode={selection?.kind === 'emitter' && mode === 'rotation' ? 'position' : mode} space={space}
                        onTransformChange={onTransform} viewportRef={viewportRef} />
    <BoxVolumeGizmoView instance={instance} bus={bus} node={volume.current} target={regionTarget}
                        active={selection?.kind === 'region'} onEdited={onRegionEdited} viewportRef={viewportRef} />
  </>;
}
