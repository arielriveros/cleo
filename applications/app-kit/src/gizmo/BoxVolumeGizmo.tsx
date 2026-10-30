import { useEffect, useRef } from 'react';
import { mat4, vec3 } from 'gl-matrix';
import { Raycaster, uiProjectToScreen, type CleoEngine, type Node } from 'cleo';
import type { GizmoOverlayModel } from './gizmoDrag';
import { snapSteps } from './gizmoDrag';
import { closestPointOnAxisToRay } from './gizmoMath';
import GizmoDragOverlay, { type GizmoOverlayHandle } from './GizmoDragOverlay';
import type { GizmoBus } from './TransformGizmo';
import {
  collisionHandles, dimensionReadout, handleDirection, handleKey, handlePoint, handleTitle, shapeFrame,
  type CollisionHandle, type OwnerPose,
} from './collisionGizmoMath';
import { applyVolumeDrag, volumeAsBoxShape } from './boxVolumeGizmoMath';

/**
 * Face handles for a BOX centred on a node — the editor's light probes and exposure volumes, Cleo Creator's
 * simulation region — the same square handles the collision shapes use (CollisionGizmo), on the six faces.
 *
 * Dragging one moves that face alone: the opposite face stays put and the node follows by half the change.
 * Alt grows both faces about the centre, Ctrl snaps the size to the Options translate step, and Escape puts
 * the box back. The node's own move/rotate/scale gizmo stays up alongside.
 *
 * Nothing here records undo itself: it edits the node through `target` and calls `onEdited`; the drag's
 * GIZMO_DRAG_END (on `bus`) is what lets a host close an undo step or re-enable its camera.
 *
 * Context-free: the editor hosts it through features/gizmo/BoxVolumeGizmo.tsx, Cleo Creator directly.
 */

/** What the handles edit: the box's size, and its smallest allowed side. */
export interface VolumeTarget {
  size: () => [number, number, number];
  setSize: (size: [number, number, number]) => void;
  minSize: number;
}

export interface BoxVolumeGizmoViewProps {
  instance: CleoEngine | null;
  bus: GizmoBus;
  /** The node the box is centred on; null shows nothing. */
  node: Node | null;
  /** How the box's size is read and written; null shows nothing. */
  target: VolumeTarget | null;
  /** False hides the handles (read-only, Play, another tool). */
  active: boolean;
  /** After every change the handles make: the node's size and position have just been written. */
  onEdited?: (node: Node) => void;
  viewportRef: React.RefObject<HTMLDivElement>;
}

interface VolumeDrag {
  node: Node;
  target: VolumeTarget;
  handle: CollisionHandle;
  beforeSize: [number, number, number];
  beforePosition: [number, number, number];
  world: mat4;
  worldScale: vec3;
  parentWorld: mat4 | null;
  anchor: vec3;
  dir: vec3;
  grab: number;
  pointerId: number;
  element: HTMLElement;
  cancelled: boolean;
}

/** The volume's colour: its selected wireframe's. */
const VOLUME_COLOR = '#ff9933';
const AXIS_OVERLAY = ['x', 'y', 'z'] as const;
const HANDLES = collisionHandles(volumeAsBoxShape([1, 1, 1]));

const ownerPose = (node: Node): OwnerPose => ({ position: node.worldPosition, quaternion: node.worldQuaternion, scale: node.worldScale });

export default function BoxVolumeGizmoView({ instance, bus: eventEmitter, node, target: volumeTarget, active: enabled, onEdited, viewportRef }: BoxVolumeGizmoViewProps) {
  const active = enabled && !!node && !!volumeTarget;
  const targetRef = useRef(volumeTarget); targetRef.current = volumeTarget;
  const editedRef = useRef(onEdited); editedRef.current = onEdited;
  const boxVolumeTarget = (_n: Node | null | undefined): VolumeTarget | null => targetRef.current;

  const nodeRef = useRef(node); nodeRef.current = node;
  const activeRef = useRef(active); activeRef.current = active;
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const overlayRef = useRef<GizmoOverlayHandle>(null);
  const dragRef = useRef<VolumeDrag | null>(null);

  const view = () => {
    const cam = instance?.scene?.activeCamera?.camera;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!cam || !rect) return null;
    return { cam, rect, viewProj: mat4.multiply(mat4.create(), cam.projectionMatrix, cam.viewMatrix) };
  };
  const rayAt = (clientX: number, clientY: number) => {
    const v = view();
    return v ? Raycaster.screenToRay(clientX - v.rect.left, clientY - v.rect.top, v.rect.width, v.rect.height, v.cam) : null;
  };

  /** Write a size and position onto the node and tell the scene and the inspector. */
  const write = (n: Node, target: VolumeTarget, size: [number, number, number], position: [number, number, number]) => {
    target.setSize(size);
    n.setPosition(position);
    n.updateTransforms(n.parent ? n.parent.worldTransform : null);
    editedRef.current?.(n);
  };

  // The per-frame loop: place the handles and draw the drag readout.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const root = rootRef.current;
      const n = nodeRef.current;
      const target = boxVolumeTarget(n);
      const v = view();
      if (!root) return;
      if (!n || !target || !activeRef.current || !v) {
        root.style.display = 'none';
        overlayRef.current?.draw(null, null);
        return;
      }
      root.style.display = '';
      const owner = ownerPose(n);
      const shape = volumeAsBoxShape(target.size());
      const frame = shapeFrame(owner, shape);
      for (const h of HANDLES) {
        const el = handleRefs.current.get(handleKey(h));
        if (!el) continue;
        const point = handlePoint(frame, h);
        const s = uiProjectToScreen(v.viewProj, point, v.rect.width, v.rect.height);
        if (!s.inFront) { el.style.display = 'none'; continue; }
        el.style.display = '';
        el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
        // A handle on a face turned away from the camera stays grabbable but reads as behind.
        const toCamera = vec3.subtract(vec3.create(), v.cam.position, point);
        el.style.opacity = vec3.dot(handleDirection(frame, h), toCamera) < 0 ? '0.45' : '1';
      }

      const drag = dragRef.current;
      if (drag) {
        const point = handlePoint(frame, drag.handle);
        const opposite = handlePoint(frame, { ...drag.handle, side: drag.handle.side > 0 ? -1 : 1 });
        const color = AXIS_OVERLAY[drag.handle.axis];
        const model: GizmoOverlayModel = {
          lines: [{ points: [opposite, point], color, dashed: true }],
          labels: [{ at: point, text: dimensionReadout(shape, drag.handle, owner.scale), color }],
        };
        overlayRef.current?.draw(model, { viewProj: v.viewProj, width: v.rect.width, height: v.rect.height });
      } else {
        overlayRef.current?.draw(null, null);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [instance]);

  const revertDrag = (drag: VolumeDrag) => write(drag.node, drag.target, drag.beforeSize, drag.beforePosition);

  const endDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try { drag.element.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
    if (!commit && !drag.cancelled) revertDrag(drag);
    // Closes the history interaction (one undo step), re-enables the camera, and swallows the release click.
    eventEmitter.emit('GIZMO_DRAG_END', { axis: 'volume', nodeId: drag.node.id });
  };

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>, handle: CollisionHandle) => {
    const n = nodeRef.current;
    const target = boxVolumeTarget(n);
    if (event.button !== 0 || !n || !target || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const ray = rayAt(event.clientX, event.clientY);
    if (!ray) return;
    const size = target.size();
    const frame = shapeFrame(ownerPose(n), volumeAsBoxShape(size));
    const anchor = handlePoint(frame, handle);
    const dir = handleDirection(frame, handle);
    const hit = closestPointOnAxisToRay(anchor, dir, ray.origin, ray.direction);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      node: n, target, handle, beforeSize: size,
      beforePosition: [n.position[0], n.position[1], n.position[2]],
      world: mat4.clone(n.worldTransform), worldScale: vec3.clone(n.worldScale),
      parentWorld: n.parent ? mat4.clone(n.parent.worldTransform) : null,
      anchor, dir, grab: hit.degenerate ? 0 : hit.s,
      pointerId: event.pointerId, element: event.currentTarget, cancelled: false,
    };
    eventEmitter.emit('GIZMO_DRAG_START', { axis: 'volume', nodeId: n.id });
  };

  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.cancelled || event.pointerId !== drag.pointerId) return;
    const ray = rayAt(event.clientX, event.clientY);
    if (!ray) return;
    // Sighting straight down the handle's line leaves no answer; hold the last one rather than jump.
    const hit = closestPointOnAxisToRay(drag.anchor, drag.dir, ray.origin, ray.direction);
    if (hit.degenerate) return;
    const next = applyVolumeDrag(drag.beforeSize, drag.world, drag.worldScale, drag.parentWorld, drag.beforePosition,
      drag.handle, hit.s - drag.grab, {
        symmetric: event.altKey,
        snap: event.ctrlKey || event.metaKey ? snapSteps.translate : 0,
        minSize: drag.target.minSize,
      });
    write(drag.node, drag.target, next.size, next.position);
  };

  // Escape stops a drag following and puts the box back; the drag still ends on the release, so the click
  // it makes is not sent to whatever is under the cursor. Losing the window or unmounting cancels too.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const drag = dragRef.current;
      if (event.key !== 'Escape' || !drag) return;
      if (!drag.cancelled) { drag.cancelled = true; revertDrag(drag); }
    };
    const onBlur = () => endDrag(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      endDrag(false);
    };
  }, [eventEmitter]);

  const setRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) handleRefs.current.set(key, el); else handleRefs.current.delete(key);
  };

  return <>
    {/* Hidden (display: none) until the loop has placed it, so nothing flashes at the top-left. */}
    <div ref={rootRef} data-cleo-overlay className='pointer-events-none absolute inset-0 z-10 overflow-hidden' style={{ display: 'none' }}>
      {active && HANDLES.map(h => (
        <button key={handleKey(h)} ref={setRef(handleKey(h))} type='button'
          aria-label={handleTitle(h)} title={handleTitle(h)}
          className='pointer-events-auto absolute left-0 top-0 h-2.5 w-2.5 border-2 bg-surface-raised transition-[width,height] hover:h-3.5 hover:w-3.5 active:bg-[#ff9933]'
          style={{ borderColor: VOLUME_COLOR, cursor: 'grab', display: 'none' }}
          onPointerDown={(event) => beginDrag(event, h)}
          onPointerMove={moveDrag}
          onPointerUp={() => endDrag(true)}
          onLostPointerCapture={() => endDrag(true)} />
      ))}
    </div>
    <GizmoDragOverlay ref={overlayRef} />
  </>;
}
