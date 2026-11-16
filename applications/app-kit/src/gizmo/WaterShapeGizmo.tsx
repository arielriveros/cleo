import { useEffect, useRef, useState } from 'react';
import { mat4, vec3 } from 'gl-matrix';
import {
  Raycaster, uiProjectToScreen, normaliseWaterPoint, waterColumnAt, type CleoEngine, type WaterVolumeNode,
  type WaterShape,
} from 'cleo';
import type { GizmoBus } from './TransformGizmo';
import { snapSteps } from './gizmoDrag';
import { closestPointOnAxisToRay, intersectRayPlane, snapValue } from './gizmoMath';
import { fitOverlayToView, viewRectOf } from '../engine/viewRect';

/**
 * Handles for the shapes of a Water node (rivers, lakes, boxes, oceans), drawn as small HTML buttons over
 * the viewport, the way the collision-shape handles are.
 *
 *  - With no shape selected, a dot per shape: click one to select it.
 *  - A river or lake: a handle per point (drag it over the ground plane at its height; Shift drags it up
 *    and down), a "+" between neighbours (press and drag to insert a point there) and, on a river, a
 *    handle on each bank to drag its width. Delete removes the selected point.
 *  - A river's first or last point dropped inside another shape connects the river to it (Flows from /
 *    Flows into); dragged back out, the connection is dropped.
 *  - A box: a handle on each face (the opposite face stays put; Alt grows both).
 *  - A lake or ocean: a centre handle that moves it (Shift: its level).
 *
 * Ctrl snaps to the Options translate step; Escape puts the drag back. Edits go through `onEdited` after
 * the node's shapes were written; GIZMO_DRAG_START / GIZMO_DRAG_END on `bus` bracket a drag so a host can
 * close one undo step. Context-free: the editor hosts it through features/gizmo/WaterGizmo.tsx.
 */

export interface WaterSelection { shapeId: string; point: number; }

export interface WaterShapeGizmoViewProps {
  instance: CleoEngine | null;
  bus: GizmoBus;
  node: WaterVolumeNode | null;
  selection: WaterSelection | null;
  onSelect: (selection: WaterSelection | null) => void;
  active: boolean;
  onEdited?: (node: WaterVolumeNode) => void;
  viewportRef: React.RefObject<HTMLDivElement>;
}

type Handle =
  | { kind: 'pick'; key: string; shapeId: string }
  | { kind: 'point'; key: string; shapeId: string; index: number }
  | { kind: 'insert'; key: string; shapeId: string; index: number }
  | { kind: 'width'; key: string; shapeId: string; index: number; side: number }
  | { kind: 'face'; key: string; shapeId: string; axis: number; side: number }
  | { kind: 'centre'; key: string; shapeId: string };

interface Drag {
  handle: Handle;
  before: WaterShape[];
  pointerId: number;
  element: HTMLElement;
  cancelled: boolean;
  /** World point grabbed, and how the drag moves it. */
  start: vec3;
  mode: 'plane' | 'axis';
  axis: vec3;
  grab: number;
  /** The shape the drag edits, as it was. */
  shape: WaterShape;
  shapeIndex: number;
}

const COLOR = '#3399ff';
const SELECTED = '#ff9933';
const MIN_SIZE = 0.05;

interface Frame { position: number[]; scale: number[]; }
const frameOf = (node: WaterVolumeNode): Frame => {
  const m = node.worldTransform;
  return { position: [m[12], m[13], m[14]], scale: [Math.hypot(m[0], m[1], m[2]) || 1, Math.hypot(m[4], m[5], m[6]) || 1, Math.hypot(m[8], m[9], m[10]) || 1] };
};
const toWorld = (f: Frame, shape: WaterShape, p: readonly number[]): vec3 => vec3.fromValues(
  f.position[0] + (p[0] + shape.offset[0]) * f.scale[0],
  f.position[1] + (p[1] + shape.offset[1]) * f.scale[1],
  f.position[2] + (p[2] + shape.offset[2]) * f.scale[2]);
const toLocal = (f: Frame, shape: WaterShape, w: ArrayLike<number>): [number, number, number] => [
  (w[0] - f.position[0]) / f.scale[0] - shape.offset[0],
  (w[1] - f.position[1]) / f.scale[1] - shape.offset[1],
  (w[2] - f.position[2]) / f.scale[2] - shape.offset[2]];
const offsetWorld = (f: Frame, shape: WaterShape): vec3 => vec3.fromValues(
  f.position[0] + shape.offset[0] * f.scale[0], f.position[1] + shape.offset[1] * f.scale[1], f.position[2] + shape.offset[2] * f.scale[2]);

/** XZ unit normal (toward the left bank) at river point `i`, from its neighbours. */
function bankNormal(shape: WaterShape, i: number): [number, number] {
  const pts = shape.points;
  const a = pts[Math.max(0, i - 1)].pos, b = pts[Math.min(pts.length - 1, i + 1)].pos;
  let tx = b[0] - a[0], tz = b[2] - a[2];
  const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
  return [-tz, tx];
}

/** Where a shape's pick dot goes: its centre, or its middle point. */
function shapeAnchor(f: Frame, shape: WaterShape): vec3 {
  if (shape.type === 'river' && shape.points.length) return toWorld(f, shape, shape.points[Math.floor(shape.points.length / 2)].pos);
  if (shape.type === 'lake' && shape.points.length) {
    const c = [0, 0];
    for (const p of shape.points) { c[0] += p.pos[0]; c[1] += p.pos[2]; }
    return toWorld(f, shape, [c[0] / shape.points.length, 0, c[1] / shape.points.length]);
  }
  if (shape.type === 'box') return toWorld(f, shape, [0, shape.size[1] / 2, 0]);
  return offsetWorld(f, shape);
}

/** Every handle to draw, and where. */
function handlesFor(node: WaterVolumeNode, selection: WaterSelection | null): { handle: Handle; at: vec3; label: string }[] {
  const f = frameOf(node);
  const out: { handle: Handle; at: vec3; label: string }[] = [];
  const selected = selection ? node.shapes.find(s => s.id === selection.shapeId) : undefined;
  if (!selected) {
    for (const s of node.shapes) out.push({ handle: { kind: 'pick', key: `pick:${s.id}`, shapeId: s.id }, at: shapeAnchor(f, s), label: `Select ${s.name || s.type}` });
    return out;
  }
  const s = selected;
  if (s.type === 'river' || s.type === 'lake') {
    const pts = s.points;
    const closed = s.type === 'lake';
    pts.forEach((p, i) => {
      out.push({ handle: { kind: 'point', key: `pt:${s.id}:${i}`, shapeId: s.id, index: i }, at: toWorld(f, s, p.pos), label: `Point ${i + 1}: drag to move (Shift: up and down)` });
      const j = i + 1 < pts.length ? i + 1 : closed ? 0 : -1;
      if (j >= 0) {
        const q = pts[j].pos;
        out.push({ handle: { kind: 'insert', key: `ins:${s.id}:${i}`, shapeId: s.id, index: i + 1 },
          at: toWorld(f, s, [(p.pos[0] + q[0]) / 2, (p.pos[1] + q[1]) / 2, (p.pos[2] + q[2]) / 2]), label: 'Drag to add a point here' });
      }
      if (s.type === 'river') {
        const n = bankNormal(s, i);
        for (const side of [1, -1]) {
          out.push({ handle: { kind: 'width', key: `w:${s.id}:${i}:${side}`, shapeId: s.id, index: i, side },
            at: toWorld(f, s, [p.pos[0] + n[0] * side * p.width / 2, p.pos[1], p.pos[2] + n[1] * side * p.width / 2]), label: 'Drag to widen or narrow the river here' });
        }
      }
    });
  } else if (s.type === 'box') {
    for (let axis = 0; axis < 3; axis++) for (const side of [1, -1]) {
      const p = [0, 0, 0]; p[axis] = side * s.size[axis] / 2;
      out.push({ handle: { kind: 'face', key: `f:${s.id}:${axis}:${side}`, shapeId: s.id, axis, side }, at: toWorld(f, s, p),
        label: `${'XYZ'[axis]}${side > 0 ? '+' : '-'} face: drag to resize (Alt: both sides)` });
    }
  }
  if (s.type !== 'river') {
    out.push({ handle: { kind: 'centre', key: `c:${s.id}`, shapeId: s.id }, at: s.type === 'box' ? toWorld(f, s, [0, 0, 0]) : offsetWorld(f, s),
      label: 'Drag to move (Shift: up and down)' });
  }
  return out;
}

export default function WaterShapeGizmoView({ instance, bus, node, selection, onSelect, active: enabled, onEdited, viewportRef }: WaterShapeGizmoViewProps) {
  const active = enabled && !!node;
  const nodeRef = useRef(node); nodeRef.current = node;
  const selRef = useRef(selection); selRef.current = selection;
  const activeRef = useRef(active); activeRef.current = active;
  const editedRef = useRef(onEdited); editedRef.current = onEdited;
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  const rootRef = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLButtonElement>());
  const dragRef = useRef<Drag | null>(null);
  const handlesRef = useRef<{ handle: Handle; at: vec3; label: string }[]>([]);

  const view = () => {
    const cam = instance?.scene?.activeCamera?.camera;
    const rect = viewRectOf(instance, viewportRef.current);
    if (!cam || !rect) return null;
    return { cam, rect, viewProj: mat4.multiply(mat4.create(), cam.projectionMatrix, cam.viewMatrix) };
  };
  const rayAt = (x: number, y: number) => {
    const v = view();
    return v ? Raycaster.screenToRay(x - v.rect.left, y - v.rect.top, v.rect.width, v.rect.height, v.cam) : null;
  };

  const write = (shapes: WaterShape[]) => {
    const n = nodeRef.current;
    if (!n) return;
    n.shapes = shapes;
    editedRef.current?.(n);
  };

  // Place the handles every frame (the handle set itself is rebuilt on every frame too: cheap, and it
  // follows inspector edits, undo and the node moving without any bookkeeping).
  const handleKeysRef = useRef('');
  const forceRef = useRef<() => void>(() => {});
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const root = rootRef.current, n = nodeRef.current, v = view();
      if (!root) return;
      if (!n || !activeRef.current || !v) { root.style.display = 'none'; return; }
      root.style.display = '';
      fitOverlayToView(root, viewportRef.current, v.rect);
      const hs = handlesFor(n, selRef.current);
      handlesRef.current = hs;
      const keys = hs.map(h => h.handle.key).join('|');
      if (keys !== handleKeysRef.current) { handleKeysRef.current = keys; forceRef.current(); return; }
      for (const h of hs) {
        const el = els.current.get(h.handle.key);
        if (!el) continue;
        const s = uiProjectToScreen(v.viewProj, h.at, v.rect.width, v.rect.height);
        if (!s.inFront) { el.style.display = 'none'; continue; }
        el.style.display = '';
        el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
        const sel = selRef.current;
        const isSel = h.handle.kind === 'point' && sel?.shapeId === h.handle.shapeId && sel.point === h.handle.index;
        el.style.borderColor = isSel ? SELECTED : COLOR;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [instance]);

  /** Applies the drag at the current ray to a copy of the shape. */
  const applyDrag = (drag: Drag, ray: { origin: vec3; direction: vec3 }, keys: { shift: boolean; alt: boolean; ctrl: boolean }): WaterShape | null => {
    const n = nodeRef.current;
    if (!n) return null;
    const f = frameOf(n);
    const snap = (v: number) => keys.ctrl ? snapValue(v, snapSteps.translate) : v;
    let world: vec3 | null = null, along = 0;
    if (drag.mode === 'axis' || keys.shift) {
      const axis = drag.mode === 'axis' ? drag.axis : vec3.fromValues(0, 1, 0);
      const hit = closestPointOnAxisToRay(drag.start, axis, ray.origin, ray.direction);
      if (hit.degenerate) return null;
      along = hit.s - (drag.mode === 'axis' ? drag.grab : 0);
      world = vec3.scaleAndAdd(vec3.create(), drag.start, axis, along);
    } else {
      const hit = intersectRayPlane(ray.origin, ray.direction, drag.start, [0, 1, 0]);
      if (!hit) return null;
      world = hit.point;
    }
    const s: WaterShape = JSON.parse(JSON.stringify(drag.shape));
    const h = drag.handle;
    if (h.kind === 'point' || h.kind === 'insert') {
      const local = toLocal(f, s, world);
      const p = s.points[h.index];
      p.pos = [snap(local[0]), snap(local[1]), snap(local[2])];
    } else if (h.kind === 'width') {
      const p = s.points[h.index];
      const c = toWorld(f, s, p.pos);
      const nrm = bankNormal(s, h.index);
      const lateral = ((world[0] - c[0]) * nrm[0] + (world[2] - c[2]) * nrm[1]) * h.side;
      p.width = Math.max(0.1, snap(2 * lateral / ((f.scale[0] + f.scale[2]) / 2)));
    } else if (h.kind === 'face') {
      const delta = along / f.scale[h.axis];
      const size = [...s.size] as [number, number, number];
      const offset = [...s.offset] as [number, number, number];
      if (keys.alt) {
        size[h.axis] = Math.max(MIN_SIZE, snap(drag.shape.size[h.axis] + 2 * delta));
      } else {
        size[h.axis] = Math.max(MIN_SIZE, snap(drag.shape.size[h.axis] + delta));
        offset[h.axis] = drag.shape.offset[h.axis] + h.side * (size[h.axis] - drag.shape.size[h.axis]) / 2;
      }
      s.size = size; s.offset = offset;
    } else if (h.kind === 'centre') {
      const start = drag.start;
      const d = [(world[0] - start[0]) / f.scale[0], (world[1] - start[1]) / f.scale[1], (world[2] - start[2]) / f.scale[2]];
      s.offset = [snap(drag.shape.offset[0] + d[0]), snap(drag.shape.offset[1] + d[1]), snap(drag.shape.offset[2] + d[2])];
    }
    return s;
  };

  /** A river end dropped inside another shape connects to it; dropped outside, it disconnects. */
  const connectEnd = (shape: WaterShape, index: number): WaterShape => {
    const n = nodeRef.current;
    if (!n || shape.type !== 'river' || (index !== 0 && index !== shape.points.length - 1)) return shape;
    const f = frameOf(n);
    const w = toWorld(f, shape, shape.points[index].pos);
    const others = n.resolvedShapes().filter(r => r.id !== shape.id);
    const col = waterColumnAt(others, w[0], w[2]);
    const target = col ? others[col.shape].id : null;
    const key = index === 0 ? 'start' : 'end';
    return { ...shape, connect: { ...shape.connect, [key]: target } };
  };

  const endDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try { drag.element.releasePointerCapture(drag.pointerId); } catch { /* released */ }
    if (!commit || drag.cancelled) write(drag.before);
    else if (drag.handle.kind === 'point') {
      const n = nodeRef.current;
      const current = n?.shapes.find(s => s.id === drag.handle.shapeId);
      if (n && current) write(n.shapes.map(s => s.id === current.id ? connectEnd(current, (drag.handle as any).index) : s));
    }
    bus.emit('GIZMO_DRAG_END', { axis: 'water', nodeId: nodeRef.current?.id });
  };

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>, entry: { handle: Handle; at: vec3 }) => {
    const n = nodeRef.current;
    if (event.button !== 0 || !n || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const h = entry.handle;
    if (h.kind === 'pick') { selectRef.current({ shapeId: h.shapeId, point: -1 }); return; }
    const before = n.shapes.map(s => JSON.parse(JSON.stringify(s)) as WaterShape);
    const shapeIndex = before.findIndex(s => s.id === h.shapeId);
    if (shapeIndex < 0) return;
    let shape = before[shapeIndex];
    if (h.kind === 'insert') {
      // The new point starts where the "+" is, then follows the drag like any point.
      const f = frameOf(n);
      const prev = shape.points[h.index - 1], next = shape.points[h.index % shape.points.length];
      const inserted = normaliseWaterPoint({ ...prev, pos: toLocal(f, shape, entry.at),
        width: (prev.width + next.width) / 2, depth: (prev.depth + next.depth) / 2, flowSpeed: (prev.flowSpeed + next.flowSpeed) / 2 });
      shape = { ...shape, points: [...shape.points.slice(0, h.index), inserted, ...shape.points.slice(h.index)] };
      write(before.map((s, i) => i === shapeIndex ? shape : s));
    }
    if (h.kind === 'point' || h.kind === 'insert') selectRef.current({ shapeId: h.shapeId, point: h.index });
    const ray = rayAt(event.clientX, event.clientY);
    if (!ray) return;
    let mode: 'plane' | 'axis' = 'plane';
    const axis = vec3.fromValues(0, 1, 0);
    let grab = 0;
    if (h.kind === 'face') {
      mode = 'axis';
      vec3.set(axis, 0, 0, 0); axis[h.axis] = h.side;
      const hit = closestPointOnAxisToRay(entry.at, axis, ray.origin, ray.direction);
      grab = hit.degenerate ? 0 : hit.s;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      handle: h, before, pointerId: event.pointerId, element: event.currentTarget, cancelled: false,
      start: vec3.clone(entry.at), mode, axis, grab, shape, shapeIndex,
    };
    bus.emit('GIZMO_DRAG_START', { axis: 'water', nodeId: n.id });
  };

  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const n = nodeRef.current;
    if (!drag || !n || drag.cancelled || event.pointerId !== drag.pointerId) return;
    const ray = rayAt(event.clientX, event.clientY);
    if (!ray) return;
    const next = applyDrag(drag, ray, { shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey || event.metaKey });
    if (!next) return;
    write(n.shapes.map(s => s.id === next.id ? next : s));
  };

  // Escape puts a drag back; Delete removes the selected point (and stops there: it must not delete the
  // node). Losing the window or unmounting cancels a drag.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const drag = dragRef.current;
      if (event.key === 'Escape' && drag) {
        if (!drag.cancelled) { drag.cancelled = true; write(drag.before); }
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !drag && activeRef.current) {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
        const n = nodeRef.current, sel = selRef.current;
        const shape = sel && n?.shapes.find(s => s.id === sel.shapeId);
        if (!n || !sel || !shape || sel.point < 0) return;
        const min = shape.type === 'river' ? 2 : 3;
        if (shape.points.length <= min) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        bus.emit('GIZMO_DRAG_START', { axis: 'water', nodeId: n.id });
        write(n.shapes.map(s => s.id === shape.id ? { ...s, points: s.points.filter((_, k) => k !== sel.point) } : s));
        bus.emit('GIZMO_DRAG_END', { axis: 'water', nodeId: n.id });
        selectRef.current({ shapeId: shape.id, point: -1 });
      }
    };
    const onBlur = () => endDrag(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      endDrag(false);
    };
  }, [bus]);

  // Re-render when the handle set changes (a shape selected, a point added).
  const [, setTick] = useState(0);
  forceRef.current = () => setTick(t => t + 1);

  const setRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) els.current.set(key, el); else els.current.delete(key);
  };
  const hs = active && node ? handlesFor(node, selection) : [];

  return (
    <div ref={rootRef} data-cleo-overlay className='pointer-events-none absolute inset-0 z-10 overflow-hidden' style={{ display: 'none' }}>
      {hs.map(entry => {
        const k = entry.handle.kind;
        const round = k === 'point' || k === 'pick' || k === 'centre';
        return (
          <button key={entry.handle.key} ref={setRef(entry.handle.key)} type='button' aria-label={entry.label} title={entry.label}
            className={'pointer-events-auto absolute left-0 top-0 border-2 bg-surface-raised flex items-center justify-center text-[9px] leading-none '
              + (round ? 'rounded-full ' : '') + (k === 'insert' ? 'h-2.5 w-2.5 opacity-70 ' : k === 'pick' ? 'h-3.5 w-3.5 ' : 'h-3 w-3 ')
              + 'hover:scale-125 transition-transform'}
            style={{ borderColor: COLOR, cursor: k === 'pick' ? 'pointer' : 'grab', display: 'none' }}
            onPointerDown={(event) => beginDrag(event, entry)}
            onPointerMove={moveDrag}
            onPointerUp={() => endDrag(true)}
            onLostPointerCapture={() => endDrag(true)}>{k === 'insert' ? '+' : null}</button>
        );
      })}
    </div>
  );
}
