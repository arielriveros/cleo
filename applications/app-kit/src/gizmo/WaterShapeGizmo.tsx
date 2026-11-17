import { useEffect, useRef, useState } from 'react';
import { mat4, vec3 } from 'gl-matrix';
import {
  Raycaster, uiProjectToScreen, normaliseWaterPoint, minWaterPoints, waterColumnAt, type CleoEngine, type WaterVolumeNode,
  type WaterBody,
} from 'cleo';
import type { GizmoBus } from './TransformGizmo';
import { snapSteps } from './gizmoDrag';
import { closestPointOnAxisToRay, intersectRayPlane, snapValue } from './gizmoMath';
import { fitOverlayToView, viewRectOf } from '../engine/viewRect';

/**
 * Handles for a Water node's body of water, drawn as small HTML buttons over the viewport, the way the
 * collision-shape handles are. The node itself moves with the transform gizmo; these shape the water:
 *
 *  - A river or lake: a handle per point (drag it over the ground plane at its height; Shift drags it up
 *    and down), a "+" between neighbours (press and drag to insert a point there) and, on a river, a
 *    handle on each bank to drag its width. Delete removes the selected point.
 *  - A river's first or last point dropped on another Water node's water joins the river to it (Flows from /
 *    Flows into); dragged back out, the join is dropped.
 *  - A pool: a handle on each face, resizing it about its centre.
 *
 * Ctrl snaps to the Options translate step; Escape puts the drag back. Edits go through `onEdited` after
 * the node's body was written; GIZMO_DRAG_START / GIZMO_DRAG_END on `bus` bracket a drag so a host can
 * close one undo step. Context-free: the editor hosts it through features/gizmo/WaterGizmo.tsx.
 */

export interface WaterShapeGizmoViewProps {
  instance: CleoEngine | null;
  bus: GizmoBus;
  node: WaterVolumeNode | null;
  /** The selected point of the river or lake, -1 for none. */
  selectedPoint: number;
  onSelectPoint: (point: number) => void;
  active: boolean;
  onEdited?: (node: WaterVolumeNode) => void;
  viewportRef: React.RefObject<HTMLDivElement>;
}

type Handle =
  | { kind: 'point'; key: string; index: number }
  | { kind: 'insert'; key: string; index: number }
  | { kind: 'width'; key: string; index: number; side: number }
  | { kind: 'face'; key: string; axis: number; side: number };

interface Drag {
  handle: Handle;
  before: WaterBody;
  pointerId: number;
  element: HTMLElement;
  cancelled: boolean;
  /** World point grabbed, and how the drag moves it. */
  start: vec3;
  mode: 'plane' | 'axis';
  axis: vec3;
  grab: number;
  /** The body the drag edits, as it was. */
  body: WaterBody;
}

const COLOR = '#3399ff';
const SELECTED = '#ff9933';
const MIN_SIZE = 0.05;

interface Frame { position: number[]; scale: number[]; }
const frameOf = (node: WaterVolumeNode): Frame => {
  const m = node.worldTransform;
  return { position: [m[12], m[13], m[14]], scale: [Math.hypot(m[0], m[1], m[2]) || 1, Math.hypot(m[4], m[5], m[6]) || 1, Math.hypot(m[8], m[9], m[10]) || 1] };
};
const toWorld = (f: Frame, p: readonly number[]): vec3 => vec3.fromValues(
  f.position[0] + p[0] * f.scale[0], f.position[1] + p[1] * f.scale[1], f.position[2] + p[2] * f.scale[2]);
const toLocal = (f: Frame, w: ArrayLike<number>): [number, number, number] => [
  (w[0] - f.position[0]) / f.scale[0], (w[1] - f.position[1]) / f.scale[1], (w[2] - f.position[2]) / f.scale[2]];
const copy = (b: WaterBody): WaterBody => JSON.parse(JSON.stringify(b));

/** XZ unit normal (toward the left bank) at river point `i`, from its neighbours. */
function bankNormal(body: WaterBody, i: number): [number, number] {
  const pts = body.points;
  const a = pts[Math.max(0, i - 1)].pos, b = pts[Math.min(pts.length - 1, i + 1)].pos;
  let tx = b[0] - a[0], tz = b[2] - a[2];
  const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
  return [-tz, tx];
}

/** Every handle to draw, and where. */
function handlesFor(node: WaterVolumeNode): { handle: Handle; at: vec3; label: string }[] {
  const f = frameOf(node);
  const out: { handle: Handle; at: vec3; label: string }[] = [];
  const s = node.waterBody;
  if (s.type === 'river' || s.type === 'lake') {
    const pts = s.points;
    const closed = s.type === 'lake';
    // A lake's points lie at its level (the node's height), whatever their own y says.
    const at = (p: readonly number[]) => toWorld(f, closed ? [p[0], 0, p[2]] : p);
    pts.forEach((p, i) => {
      out.push({ handle: { kind: 'point', key: `pt:${i}`, index: i }, at: at(p.pos), label: `Point ${i + 1}: drag to move${closed ? '' : ' (Shift: up and down)'}` });
      const j = i + 1 < pts.length ? i + 1 : closed ? 0 : -1;
      if (j >= 0) {
        const q = pts[j].pos;
        out.push({ handle: { kind: 'insert', key: `ins:${i}`, index: i + 1 },
          at: at([(p.pos[0] + q[0]) / 2, (p.pos[1] + q[1]) / 2, (p.pos[2] + q[2]) / 2]), label: 'Drag to add a point here' });
      }
      if (s.type === 'river') {
        const n = bankNormal(s, i);
        for (const side of [1, -1]) {
          out.push({ handle: { kind: 'width', key: `w:${i}:${side}`, index: i, side },
            at: toWorld(f, [p.pos[0] + n[0] * side * p.width / 2, p.pos[1], p.pos[2] + n[1] * side * p.width / 2]), label: 'Drag to widen or narrow the river here' });
        }
      }
    });
  } else if (s.type === 'pool') {
    for (let axis = 0; axis < 3; axis++) for (const side of [1, -1]) {
      const p = [0, 0, 0]; p[axis] = side * s.size[axis] / 2;
      out.push({ handle: { kind: 'face', key: `f:${axis}:${side}`, axis, side }, at: toWorld(f, p),
        label: `${'XYZ'[axis]}${side > 0 ? '+' : '-'} face: drag to resize about the centre` });
    }
  }
  return out;
}

export default function WaterShapeGizmoView({ instance, bus, node, selectedPoint, onSelectPoint, active: enabled, onEdited, viewportRef }: WaterShapeGizmoViewProps) {
  const active = enabled && !!node;
  const nodeRef = useRef(node); nodeRef.current = node;
  const selRef = useRef(selectedPoint); selRef.current = selectedPoint;
  const activeRef = useRef(active); activeRef.current = active;
  const editedRef = useRef(onEdited); editedRef.current = onEdited;
  const selectRef = useRef(onSelectPoint); selectRef.current = onSelectPoint;
  const rootRef = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLButtonElement>());
  const dragRef = useRef<Drag | null>(null);

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

  const write = (body: WaterBody) => {
    const n = nodeRef.current;
    if (!n) return;
    n.waterBody = body;
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
      const hs = handlesFor(n);
      const keys = hs.map(h => h.handle.key).join('|');
      if (keys !== handleKeysRef.current) { handleKeysRef.current = keys; forceRef.current(); return; }
      for (const h of hs) {
        const el = els.current.get(h.handle.key);
        if (!el) continue;
        const s = uiProjectToScreen(v.viewProj, h.at, v.rect.width, v.rect.height);
        if (!s.inFront) { el.style.display = 'none'; continue; }
        el.style.display = '';
        el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
        const isSel = h.handle.kind === 'point' && selRef.current === h.handle.index;
        el.style.borderColor = isSel ? SELECTED : COLOR;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [instance]);

  /** Applies the drag at the current ray to a copy of the body. */
  const applyDrag = (drag: Drag, ray: { origin: vec3; direction: vec3 }, keys: { shift: boolean; ctrl: boolean }): WaterBody | null => {
    const n = nodeRef.current;
    if (!n) return null;
    const f = frameOf(n);
    const snap = (v: number) => keys.ctrl ? snapValue(v, snapSteps.translate) : v;
    let world: vec3 | null = null, along = 0;
    const lake = drag.body.type === 'lake';
    if (drag.mode === 'axis' || (keys.shift && !lake)) {
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
    const s = copy(drag.body);
    const h = drag.handle;
    if (h.kind === 'point' || h.kind === 'insert') {
      const local = toLocal(f, world);
      const p = s.points[h.index];
      p.pos = [snap(local[0]), lake ? 0 : snap(local[1]), snap(local[2])];
    } else if (h.kind === 'width') {
      const p = s.points[h.index];
      const c = toWorld(f, p.pos);
      const nrm = bankNormal(s, h.index);
      const lateral = ((world[0] - c[0]) * nrm[0] + (world[2] - c[2]) * nrm[1]) * h.side;
      p.width = Math.max(0.1, snap(2 * lateral / ((f.scale[0] + f.scale[2]) / 2)));
    } else if (h.kind === 'face') {
      const size = [...s.size] as [number, number, number];
      size[h.axis] = Math.max(MIN_SIZE, snap(drag.body.size[h.axis] + 2 * along / f.scale[h.axis]));
      s.size = size;
    }
    return s;
  };

  /** A river end dropped on another Water node's water joins the river to it; dropped outside, it lets go. */
  const connectEnd = (body: WaterBody, index: number): WaterBody => {
    const n = nodeRef.current;
    if (!n || body.type !== 'river' || (index !== 0 && index !== body.points.length - 1)) return body;
    const w = toWorld(frameOf(n), body.points[index].pos);
    let target: string | null = null;
    for (const other of (n.scene?.waterVolumes ?? []) as Set<WaterVolumeNode>) {
      if (other === n) continue;
      const r = other.resolved();
      if (r && waterColumnAt([r], w[0], w[2])) { target = other.id; break; }
    }
    const key = index === 0 ? 'start' : 'end';
    return { ...body, connect: { ...body.connect, [key]: target } };
  };

  const endDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try { drag.element.releasePointerCapture(drag.pointerId); } catch { /* released */ }
    if (!commit || drag.cancelled) write(drag.before);
    else if (drag.handle.kind === 'point') {
      const n = nodeRef.current;
      if (n) write(connectEnd(copy(n.waterBody), drag.handle.index));
    }
    bus.emit('GIZMO_DRAG_END', { axis: 'water', nodeId: nodeRef.current?.id });
  };

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>, entry: { handle: Handle; at: vec3 }) => {
    const n = nodeRef.current;
    if (event.button !== 0 || !n || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const h = entry.handle;
    const before = copy(n.waterBody);
    let body = before;
    if (h.kind === 'insert') {
      // The new point starts where the "+" is, then follows the drag like any point.
      const f = frameOf(n);
      const prev = body.points[h.index - 1], next = body.points[h.index % body.points.length];
      const inserted = normaliseWaterPoint({ ...prev, pos: toLocal(f, entry.at),
        width: (prev.width + next.width) / 2, depth: (prev.depth + next.depth) / 2, flowSpeed: (prev.flowSpeed + next.flowSpeed) / 2 });
      body = { ...body, points: [...body.points.slice(0, h.index), inserted, ...body.points.slice(h.index)] };
      write(body);
    }
    if (h.kind === 'point' || h.kind === 'insert') selectRef.current(h.index);
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
      start: vec3.clone(entry.at), mode, axis, grab, body,
    };
    bus.emit('GIZMO_DRAG_START', { axis: 'water', nodeId: n.id });
  };

  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !nodeRef.current || drag.cancelled || event.pointerId !== drag.pointerId) return;
    const ray = rayAt(event.clientX, event.clientY);
    if (!ray) return;
    const next = applyDrag(drag, ray, { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey });
    if (next) write(next);
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
        if (!n || sel < 0) return;
        const body = n.waterBody;
        if (body.points.length <= minWaterPoints(body.type)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        bus.emit('GIZMO_DRAG_START', { axis: 'water', nodeId: n.id });
        write({ ...copy(body), points: body.points.filter((_, k) => k !== sel) });
        bus.emit('GIZMO_DRAG_END', { axis: 'water', nodeId: n.id });
        selectRef.current(-1);
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

  // Re-render when the handle set changes (a point added, the type changed).
  const [, setTick] = useState(0);
  forceRef.current = () => setTick(t => t + 1);

  const setRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) els.current.set(key, el); else els.current.delete(key);
  };
  const hs = active && node ? handlesFor(node) : [];

  return (
    <div ref={rootRef} data-cleo-overlay className='pointer-events-none absolute inset-0 z-10 overflow-hidden' style={{ display: 'none' }}>
      {hs.map(entry => {
        const k = entry.handle.kind;
        const round = k === 'point';
        return (
          <button key={entry.handle.key} ref={setRef(entry.handle.key)} type='button' aria-label={entry.label} title={entry.label}
            className={'pointer-events-auto absolute left-0 top-0 border-2 bg-surface-raised flex items-center justify-center text-[9px] leading-none '
              + (round ? 'rounded-full ' : '') + (k === 'insert' ? 'h-2.5 w-2.5 opacity-70 ' : 'h-3 w-3 ')
              + 'hover:scale-125 transition-transform'}
            style={{ borderColor: COLOR, cursor: 'grab', display: 'none' }}
            onPointerDown={(event) => beginDrag(event, entry)}
            onPointerMove={moveDrag}
            onPointerUp={() => endDrag(true)}
            onLostPointerCapture={() => endDrag(true)}>{k === 'insert' ? '+' : null}</button>
        );
      })}
    </div>
  );
}
