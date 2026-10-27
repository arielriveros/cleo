import { useEffect, useRef, useState } from 'react';
import { mat4, vec3 } from 'gl-matrix';
import { Node, Raycaster, markEditorOwned, uiProjectToScreen } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { useHistory } from '../HistoryContext';
import { usePlayback } from '../PlaybackContext';
import { useSelection } from '../SelectionContext';
import { useDebugVisibility } from '../DebugVisibilityContext';
import type { ShapeDescription } from '../engineContextTypes';
import { isWithinTemplateInstance } from '../../utils/templates';
import { closestPointOnAxisToRay } from '../../utils/gizmoMath';
import { snapSteps, type TransformPatch, type GizmoOverlayModel } from './gizmoDrag';
import TransformGizmo from './TransformGizmo';
import GizmoDragOverlay, { type GizmoOverlayHandle } from './GizmoDragOverlay';
import {
  applyCollisionDrag, collisionHandles, dimensionReadout, handleDirection, handleKey, handlePoint, handleTitle,
  offsetForWorldPoint, rotationForWorldQuat, shapeFrame, type CollisionHandle, type OwnerPose,
} from './collisionGizmoMath';
import {
  COLLISION_SHAPE_FRAME, COLLISION_SHAPES_EDITED, setCollisionShapeSelection, useCollisionShapeSelection,
  type CollisionChannel, type CollisionShapeRef,
} from './collisionSelection';
import { shapeRowTitle } from '../nodeInspector/physicsEditors/shapeListOps';

/**
 * Collision shapes, edited where they are: the in-viewport half of the Physics panel.
 *
 * Every shape of the selected node shows a small dot at its centre, red for the body's and green for the
 * trigger's. Clicking one (or a row in the Physics panel) SELECTS that shape, and the viewport goes into
 * shape edit for it:
 *
 *   - square size handles sit on both faces of every axis the shape can be sized along. Dragging one
 *     moves that face alone — the opposite one stays put and the offset follows — Alt grows both sides
 *     about the centre, Ctrl snaps the size to the Options translate step;
 *   - the move/rotate gizmo (W / E) drives the shape's offset and rotation through a proxy node, the
 *     same trick SocketGizmo uses, while the node's own gizmo steps aside (EngineViewport);
 *   - Escape, or any node selection, goes back to editing the node.
 *
 * Every drag is one undo step and writes the same bodies/triggers maps the panel reads, so the two stay in
 * step. Nothing here re-renders per frame: one rAF loop places the DOM handles imperatively, and the
 * component only re-renders when the shape list's makeup (count, types) or the selection changes.
 */

interface Props {
  selectedNodeId: string | null;
  viewportRef: React.RefObject<HTMLDivElement>;
}

/** A size-handle drag in progress. `anchor`/`dir` are frozen at grab, so the solve has a fixed line. */
interface ShapeDrag {
  nodeId: string;
  channel: CollisionChannel;
  index: number;
  handle: CollisionHandle;
  before: ShapeDescription;
  beforeShapes: ShapeDescription[];
  anchor: vec3;
  dir: vec3;
  /** Where the cursor ray met the handle's line at grab; the drag is measured from here. */
  grab: number;
  scale: vec3;
  pointerId: number;
  element: HTMLElement;
  /** Escape put the shape back; the drag only waits for the button to come up. */
  cancelled: boolean;
}

const CHANNEL_COLOR: Record<CollisionChannel, string> = { body: '#ef4444', trigger: '#22c55e' };
/** The selected shape's colour: its wireframe's (editorHelpers SELECTED_SHAPE_COLOR). */
const SELECTED_COLOR = '#ff9933';
const AXIS_OVERLAY = ['x', 'y', 'z'] as const;
const PROXY_NAME = '__editor__collisionShapeProxy';

const ownerPose = (node: Node): OwnerPose => ({ position: node.worldPosition, quaternion: node.worldQuaternion, scale: node.worldScale });

/** "body:0;trigger:0" -> the makeup the DOM depends on: which shapes exist and of what type. */
function makeup(bodyShapes: ShapeDescription[] | undefined, triggerShapes: ShapeDescription[] | undefined): string {
  return `${(bodyShapes ?? []).map(s => s.type).join(',')}|${(triggerShapes ?? []).map(s => s.type).join(',')}`;
}

export default function CollisionGizmo({ selectedNodeId, viewportRef }: Props) {
  const { instance, editorScene, bodies, triggers, eventEmitter, withoutDirty, editorMode } = useCleoEngine();
  const { push } = useHistory();
  const { isPlayMode } = usePlayback();
  const { gizmoMode } = useSelection();
  const { visibility } = useDebugVisibility();
  const selection = useCollisionShapeSelection(eventEmitter);
  const [, rerender] = useState(0);

  const node = selectedNodeId && editorScene && selectedNodeId !== editorScene.root?.id
    ? editorScene.getNodeById(selectedNodeId) ?? null : null;
  // A placed template instance is read-only in Scene mode, exactly as the Physics panel is.
  const readOnly = editorMode === 'scene' && !!node && isWithinTemplateInstance(node);
  const active = !!node && !isPlayMode && !readOnly;
  const showChannel: Record<CollisionChannel, boolean> = { body: visibility.colliders.editor, trigger: visibility.triggers.editor };

  const listOf = (channel: CollisionChannel, id: string) => (channel === 'body' ? bodies : triggers).get(id)?.shapes;
  const entries = active ? (['body', 'trigger'] as const).flatMap(channel => !showChannel[channel] ? [] :
    (listOf(channel, node!.id) ?? []).map((shape, index) => ({ channel, index, shape }))) : [];
  const selected = selection && node && selection.nodeId === node.id
    ? entries.find(e => e.channel === selection.channel && e.index === selection.index) ?? null : null;
  const handles = selected ? collisionHandles(selected.shape) : [];
  const proxyActive = !!selected && (gizmoMode === 'position' || gizmoMode === 'rotation');

  // Render-time mirrors for the loop and the listeners, which are bound once.
  const nodeRef = useRef(node); nodeRef.current = node;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const entriesRef = useRef(entries); entriesRef.current = entries;
  const activeRef = useRef(active); activeRef.current = active;

  const rootRef = useRef<HTMLDivElement>(null);
  const dotRefs = useRef(new Map<string, HTMLButtonElement>());
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const overlayRef = useRef<GizmoOverlayHandle>(null);
  const dragRef = useRef<ShapeDrag | null>(null);
  /** True from any gizmo's drag start until just after its end, so that Escape ends the drag, not the edit. */
  const gizmoBusyRef = useRef(false);

  // ------------------------------------------------------------------------------------------------
  // Selection lifecycle
  // ------------------------------------------------------------------------------------------------

  // Any node selection ends shape edit — another node, empty space, or the same node clicked again.
  useEffect(() => {
    const onSelectNode = () => setCollisionShapeSelection(eventEmitter, null);
    eventEmitter.on('SELECT_NODE', onSelectNode);
    return () => { eventEmitter.off('SELECT_NODE', onSelectNode); };
  }, [eventEmitter]);

  useEffect(() => { if (isPlayMode) setCollisionShapeSelection(eventEmitter, null); }, [isPlayMode]);

  // A selection whose shape is gone (removed, undone away) is dropped rather than left pointing at a
  // neighbour that slid into its index. So is one on a channel the eye menu hides: there would be nothing
  // to edit it with, and the node's own gizmo would stay hidden for it.
  useEffect(() => {
    if (!selection || !node || selection.nodeId !== node.id) return;
    const list = listOf(selection.channel, node.id);
    if (!list || selection.index >= list.length || !showChannel[selection.channel]) setCollisionShapeSelection(eventEmitter, null);
  });

  // Re-render only when the makeup of the lists changes: the handle set is keyed by it.
  const makeupRef = useRef('');
  useEffect(() => {
    const check = () => {
      const n = nodeRef.current;
      const next = n ? makeup(bodies.get(n.id)?.shapes, triggers.get(n.id)?.shapes) : '';
      if (next !== makeupRef.current) { makeupRef.current = next; rerender(x => x + 1); }
    };
    check();
    eventEmitter.on('PHYSICS_CHANGED', check);
    eventEmitter.on(COLLISION_SHAPES_EDITED, check);
    return () => {
      eventEmitter.off('PHYSICS_CHANGED', check);
      eventEmitter.off(COLLISION_SHAPES_EDITED, check);
    };
  }, [eventEmitter, bodies, triggers, selectedNodeId]);

  useEffect(() => {
    const onStart = () => { gizmoBusyRef.current = true; };
    const onEnd = () => { window.setTimeout(() => { gizmoBusyRef.current = false; }, 0); };
    eventEmitter.on('GIZMO_DRAG_START', onStart);
    eventEmitter.on('GIZMO_DRAG_END', onEnd);
    return () => { eventEmitter.off('GIZMO_DRAG_START', onStart); eventEmitter.off('GIZMO_DRAG_END', onEnd); };
  }, [eventEmitter]);

  // ------------------------------------------------------------------------------------------------
  // Writing the maps
  // ------------------------------------------------------------------------------------------------

  const writeShapes = (nodeId: string, channel: CollisionChannel, shapes: ShapeDescription[]) => {
    const map = (channel === 'body' ? bodies : triggers) as Map<string, { shapes: ShapeDescription[] }>;
    const record = map.get(nodeId);
    if (record) map.set(nodeId, { ...record, shapes });
  };
  const replaceShape = (nodeId: string, channel: CollisionChannel, index: number, shape: ShapeDescription) => {
    const list = listOf(channel, nodeId);
    if (!list || !list[index]) return;
    const next = [...list]; next[index] = shape;
    writeShapes(nodeId, channel, next);
    eventEmitter.emit(COLLISION_SHAPES_EDITED);
  };
  /** One undo step for a finished gesture, and the full announcement (helpers, nav soup, dirty flag). */
  const commitGesture = (nodeId: string, channel: CollisionChannel, before: ShapeDescription[], label: string) => {
    const target = editorScene?.getNodeById(nodeId);
    const after = listOf(channel, nodeId);
    const announce = () => {
      eventEmitter.emit('PHYSICS_CHANGED');
      if (target) eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node: target });
    };
    if (!after || JSON.stringify(after) === JSON.stringify(before)) { eventEmitter.emit('PHYSICS_CHANGED'); return; }
    push({
      label: `${label} ${channel === 'body' ? 'body' : 'trigger'} shape`,
      undo: () => { writeShapes(nodeId, channel, before); announce(); },
      redo: () => { writeShapes(nodeId, channel, after); announce(); },
    });
    announce();
  };

  // ------------------------------------------------------------------------------------------------
  // View helpers
  // ------------------------------------------------------------------------------------------------

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

  // ------------------------------------------------------------------------------------------------
  // The per-frame loop: dots, handles and the drag readout
  // ------------------------------------------------------------------------------------------------

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const root = rootRef.current;
      const target = nodeRef.current;
      const v = view();
      if (!root) return;
      if (!target || !activeRef.current || !v) {
        root.style.display = 'none';
        overlayRef.current?.draw(null, null);
        return;
      }
      root.style.display = '';
      const owner = ownerPose(target);
      const camPos = v.cam.position;

      const place = (el: HTMLElement, world: vec3, away = false) => {
        const s = uiProjectToScreen(v.viewProj, world, v.rect.width, v.rect.height);
        if (!s.inFront) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
        // A handle on a face turned away from the camera stays grabbable but reads as behind.
        el.style.opacity = away ? '0.45' : '1';
      };

      for (const [key, el] of dotRefs.current) {
        const [channel, index] = key.split(':') as [CollisionChannel, string];
        const shape = listOf(channel, target.id)?.[Number(index)];
        if (!shape) { el.style.display = 'none'; continue; }
        place(el, shapeFrame(owner, shape).centre);
      }

      const sel = selectedRef.current;
      const shape = sel ? listOf(sel.channel, target.id)?.[sel.index] : null;
      const frame = shape ? shapeFrame(owner, shape) : null;
      if (frame) {
        for (const h of collisionHandles(shape!)) {
          const el = handleRefs.current.get(handleKey(h));
          if (!el) continue;
          const point = handlePoint(frame, h);
          const toCamera = vec3.subtract(vec3.create(), camPos, point);
          place(el, point, vec3.dot(handleDirection(frame, h), toCamera) < 0);
        }
      }

      const drag = dragRef.current;
      if (drag && frame && shape) {
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
  }, [instance, bodies, triggers]);

  // ------------------------------------------------------------------------------------------------
  // Size-handle drags
  // ------------------------------------------------------------------------------------------------

  /** Put the shape back as it was at grab. */
  const revertDrag = (drag: ShapeDrag) => {
    writeShapes(drag.nodeId, drag.channel, drag.beforeShapes);
    eventEmitter.emit('PHYSICS_CHANGED');
  };

  const endDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try { drag.element.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
    if (commit && !drag.cancelled) commitGesture(drag.nodeId, drag.channel, drag.beforeShapes, 'Resize');
    else if (!drag.cancelled) revertDrag(drag);
    // Re-enables the EditorCamera input map, and lets the viewport ignore the click this release makes.
    eventEmitter.emit('GIZMO_DRAG_END', { axis: 'collision', nodeId: drag.nodeId });
  };

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>, handle: CollisionHandle) => {
    const target = nodeRef.current;
    const sel = selectedRef.current;
    if (event.button !== 0 || !target || !sel || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const shapes = listOf(sel.channel, target.id);
    const shape = shapes?.[sel.index];
    const ray = rayAt(event.clientX, event.clientY);
    if (!shapes || !shape || !ray) return;

    const owner = ownerPose(target);
    const frame = shapeFrame(owner, shape);
    const anchor = handlePoint(frame, handle);
    const dir = handleDirection(frame, handle);
    const hit = closestPointOnAxisToRay(anchor, dir, ray.origin, ray.direction);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      nodeId: target.id, channel: sel.channel, index: sel.index, handle,
      before: shape, beforeShapes: shapes, anchor, dir, grab: hit.degenerate ? 0 : hit.s,
      scale: vec3.clone(owner.scale), pointerId: event.pointerId, element: event.currentTarget, cancelled: false,
    };
    eventEmitter.emit('GIZMO_DRAG_START', { axis: 'collision', nodeId: target.id });
  };

  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.cancelled || event.pointerId !== drag.pointerId) return;
    const ray = rayAt(event.clientX, event.clientY);
    if (!ray) return;
    // Sighting straight down the handle's line leaves no answer; hold the last one rather than jump.
    const hit = closestPointOnAxisToRay(drag.anchor, drag.dir, ray.origin, ray.direction);
    if (hit.degenerate) return;
    const shape = applyCollisionDrag(drag.before, drag.handle, hit.s - drag.grab, drag.scale, {
      // Read off the event, so either can be pressed or released mid-drag.
      symmetric: event.altKey,
      snap: event.ctrlKey || event.metaKey ? snapSteps.translate : 0,
    });
    replaceShape(drag.nodeId, drag.channel, drag.index, shape);
  };

  // Escape cancels a size drag, restoring the shape, and losing the window or unmounting does too. Escape
  // with no drag at all leaves shape edit.
  //
  // Escape does not END the drag: the button is still down and the pointer still captured, and letting go
  // of the capture here would send the release, and the click it makes, to whatever is under the cursor —
  // selecting it. The drag just stops following, and ends on the release like any other.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const drag = dragRef.current;
      if (drag) {
        if (!drag.cancelled) { drag.cancelled = true; revertDrag(drag); }
        return;
      }
      const t = event.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (!gizmoBusyRef.current) setCollisionShapeSelection(eventEmitter, null);
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

  // ------------------------------------------------------------------------------------------------
  // Offset and rotation: the transform gizmo on a proxy parked on the selected shape
  // ------------------------------------------------------------------------------------------------

  const proxyRef = useRef<Node | null>(null);
  const [proxyId, setProxyId] = useState<string | null>(null);
  /** The list before the proxy gesture now in progress, or null between gestures. */
  const proxyBeforeRef = useRef<{ nodeId: string; channel: CollisionChannel; shapes: ShapeDescription[] } | null>(null);

  useEffect(() => {
    if (!editorScene || !proxyActive) return;
    const proxy = markEditorOwned(new Node(PROXY_NAME));
    withoutDirty(() => editorScene.addNode(proxy));
    proxyRef.current = proxy;
    setProxyId(proxy.id);
    return () => {
      proxyRef.current = null;
      setProxyId(null);
      try { withoutDirty(() => editorScene.removeNode(proxy)); } catch { /* scene gone with the tab */ }
    };
  }, [editorScene, proxyActive]);

  // Park the proxy on the shape, except mid-gesture when the gizmo owns it.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const proxy = proxyRef.current;
      const target = nodeRef.current;
      const sel = selectedRef.current;
      if (!proxy || !target || !sel || proxyBeforeRef.current) return;
      const shape = listOf(sel.channel, target.id)?.[sel.index];
      if (!shape) return;
      const frame = shapeFrame(ownerPose(target), shape);
      withoutDirty(() => { proxy.setPosition(frame.centre).setQuaternion(frame.quaternion).setScale([1, 1, 1]); });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bodies, triggers]);

  const onProxyChange = (_id: string, patch: TransformPatch) => {
    const proxy = proxyRef.current;
    const target = nodeRef.current;
    const sel = selectedRef.current;
    if (!proxy || !target || !sel) return;
    const shape = listOf(sel.channel, target.id)?.[sel.index];
    if (!shape) return;
    if (!proxyBeforeRef.current)
      proxyBeforeRef.current = { nodeId: target.id, channel: sel.channel, shapes: listOf(sel.channel, target.id)! };

    const owner = ownerPose(target);
    // The proxy sits under the scene root, so the patch's parent-local values are world values.
    if (patch.kind === 'position') {
      withoutDirty(() => proxy.setPosition(patch.local));
      replaceShape(target.id, sel.channel, sel.index, { ...shape, offset: offsetForWorldPoint(owner, patch.local) });
    } else if (patch.kind === 'rotation') {
      withoutDirty(() => proxy.setQuaternion(patch.localQuat));
      replaceShape(target.id, sel.channel, sel.index, { ...shape, rotation: rotationForWorldQuat(owner, patch.localQuat) });
    }
  };

  useEffect(() => {
    const onEnd = () => {
      const before = proxyBeforeRef.current;
      if (!before) return;
      proxyBeforeRef.current = null;
      commitGesture(before.nodeId, before.channel, before.shapes, gizmoMode === 'rotation' ? 'Rotate' : 'Move');
    };
    eventEmitter.on('GIZMO_DRAG_END', onEnd);
    return () => { eventEmitter.off('GIZMO_DRAG_END', onEnd); };
  });

  // ------------------------------------------------------------------------------------------------
  // Frame in viewport (the panel row's button)
  // ------------------------------------------------------------------------------------------------

  useEffect(() => {
    const onFrame = (ref: CollisionShapeRef) => {
      const target = editorScene?.getNodeById(ref.nodeId);
      const camNode = instance?.scene?.activeCamera;
      const shape = target ? listOf(ref.channel, target.id)?.[ref.index] : null;
      if (!target || !camNode || !shape) return;
      const frame = shapeFrame(ownerPose(target), shape);
      const cam = camNode.camera;
      const view = cam.viewMatrix;
      // The camera's +Z in the world: straight back from where it looks.
      const back = vec3.normalize(vec3.create(), vec3.fromValues(view[2], view[6], view[10]));
      const radius = Math.max(vec3.length(frame.half), 0.25);
      const position = cam.type === 'orthographic'
        ? vec3.fromValues(frame.centre[0], frame.centre[1], camNode.position[2])
        : vec3.scaleAndAdd(vec3.create(), frame.centre, back, (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.6);
      camNode.setPosition(position);
    };
    eventEmitter.on(COLLISION_SHAPE_FRAME, onFrame);
    return () => { eventEmitter.off(COLLISION_SHAPE_FRAME, onFrame); };
  }, [eventEmitter, editorScene, instance, bodies, triggers]);

  // ------------------------------------------------------------------------------------------------

  const setRef = (map: Map<string, HTMLButtonElement>, key: string) => (el: HTMLButtonElement | null) => {
    if (el) map.set(key, el); else map.delete(key);
  };
  const stop = (event: React.PointerEvent) => { event.stopPropagation(); };

  return <>
    {/* Hidden (display: none) until the loop has placed it, so nothing flashes at the top-left. */}
    <div ref={rootRef} data-cleo-overlay className='pointer-events-none absolute inset-0 z-10 overflow-hidden' style={{ display: 'none' }}>
      {entries.filter(e => e !== selected).map(e => {
        const key = `${e.channel}:${e.index}`;
        return <button key={key} ref={setRef(dotRefs.current, key)} type='button'
          aria-label={`Edit ${e.channel} ${shapeRowTitle(e.shape, e.index)}`}
          title={`${e.channel === 'body' ? 'Body' : 'Trigger'} · ${shapeRowTitle(e.shape, e.index)} — click to edit`}
          className='pointer-events-auto absolute left-0 top-0 h-2.5 w-2.5 rounded-full border border-black/50 transition-[width,height] hover:h-3.5 hover:w-3.5'
          style={{ background: CHANNEL_COLOR[e.channel], display: 'none' }}
          onPointerDown={stop}
          onClick={(event) => { event.stopPropagation(); setCollisionShapeSelection(eventEmitter, { nodeId: node!.id, channel: e.channel, index: e.index }); }} />;
      })}
      {selected && handles.map(h => (
        <button key={handleKey(h)} ref={setRef(handleRefs.current, handleKey(h))} type='button'
          aria-label={handleTitle(h)} title={handleTitle(h)}
          className='pointer-events-auto absolute left-0 top-0 h-2.5 w-2.5 border-2 bg-surface-raised transition-[width,height] hover:h-3.5 hover:w-3.5 active:bg-[#ff9933]'
          style={{ borderColor: SELECTED_COLOR, cursor: 'grab', display: 'none' }}
          onPointerDown={(event) => beginDrag(event, h)}
          onPointerMove={moveDrag}
          onPointerUp={() => endDrag(true)}
          onLostPointerCapture={() => endDrag(true)} />
      ))}
    </div>
    <GizmoDragOverlay ref={overlayRef} />
    {proxyActive && proxyId && <TransformGizmo selectedNodeId={proxyId} onTransformChange={onProxyChange} viewportRef={viewportRef} />}
  </>;
}
