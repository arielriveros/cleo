import { useEffect, useRef, useState } from 'react';
import { mat4, vec3 } from 'gl-matrix';
import { uiProjectToScreen, type Node } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { useHistory } from '../HistoryContext';
import type { ShapeDescription } from '../engineContextTypes';
import { applyCollisionDrag, collisionHandles, type CollisionHandle } from './collisionGizmoMath';

interface Props {
  selectedNodeId: string | null;
  viewportRef: React.RefObject<HTMLDivElement>;
}

type ActiveDrag = { channel: 'body' | 'trigger'; index: number; handle: CollisionHandle; start: { x: number; y: number }; before: ShapeDescription };

const COLORS = { body: '#ef4444', trigger: '#22c55e' };

/**
 * Selection-scoped handles for collision descriptors. The wireframes themselves are maintained by the
 * editor helper reconciler; this component only supplies authoring affordances and writes the same maps
 * used by the inspector, so both editing paths stay in lockstep.
 */
export default function CollisionGizmo({ selectedNodeId, viewportRef }: Props) {
  const { editorScene, bodies, triggers, eventEmitter } = useCleoEngine();
  const { push } = useHistory();
  const [, redraw] = useState(0);
  const active = useRef<ActiveDrag | null>(null);
  const startShapes = useRef<ShapeDescription[] | null>(null);

  const node = selectedNodeId && editorScene ? editorScene.getNodeById(selectedNodeId) : null;
  const entries = node ? ([
    ...(bodies.get(node.id)?.shapes ?? []).map((shape, index) => ({ channel: 'body' as const, shape, index })),
    ...(triggers.get(node.id)?.shapes ?? []).map((shape, index) => ({ channel: 'trigger' as const, shape, index })),
  ]) : [];

  const project = (point: vec3) => {
    const cam = editorScene?.activeCamera?.camera;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!cam || !rect) return null;
    return uiProjectToScreen(mat4.multiply(mat4.create(), cam.projectionMatrix, cam.viewMatrix), point, rect.width, rect.height);
  };
  const worldPoint = (target: Node, local: number[]): vec3 => vec3.transformMat4(vec3.create(), [local[0], local[1], local[2]], target.worldTransform);
  const localUnitScreen = (target: Node, offset: number[], axis: 0 | 1 | 2) => {
    const a = worldPoint(target, offset);
    const b = worldPoint(target, [offset[0] + (axis === 0 ? 1 : 0), offset[1] + (axis === 1 ? 1 : 0), offset[2] + (axis === 2 ? 1 : 0)]);
    const pa = project(a), pb = project(b);
    if (!pa || !pb) return null;
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const length = Math.hypot(dx, dy);
    return length < 1e-4 ? null : { x: dx / length, y: dy / length, pixels: length };
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = active.current;
      const target = selectedNodeId && editorScene ? editorScene.getNodeById(selectedNodeId) : null;
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!drag || !target || !rect) return;
      const axis = localUnitScreen(target, (drag.before.offset ?? [0, 0, 0]) as number[], drag.handle.axis);
      if (!axis) return;
      const deltaPixels = (event.clientX - rect.left - drag.start.x) * axis.x + (event.clientY - rect.top - drag.start.y) * axis.y;
      const scale = Math.abs(target.scale[drag.handle.axis]) || 1;
      const shape = applyCollisionDrag(drag.before, drag.handle, deltaPixels / axis.pixels / scale);
      const map = drag.channel === 'body' ? bodies : triggers;
      const record = map.get(target.id);
      if (!record) return;
      const shapes = [...record.shapes]; shapes[drag.index] = shape;
      map.set(target.id, { ...record, shapes });
      eventEmitter.emit('PHYSICS_CHANGED');
      redraw(x => x + 1);
    };
    const up = () => {
      const drag = active.current;
      if (!drag) return;
      active.current = null;
      const target = selectedNodeId && editorScene ? editorScene.getNodeById(selectedNodeId) : null;
      const map = drag.channel === 'body' ? bodies : triggers;
      const after = target ? map.get(target.id)?.shapes : null;
      if (target && after && startShapes.current && JSON.stringify(startShapes.current) !== JSON.stringify(after)) {
        const before = startShapes.current;
        const channel = drag.channel;
        const index = drag.index;
        push({ label: `${channel === 'body' ? 'Body' : 'Trigger'} shape`, undo: () => {
          const current = map.get(target.id); if (current) { map.set(target.id, { ...current, shapes: before }); eventEmitter.emit('PHYSICS_CHANGED'); eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node: target }); }
        }, redo: () => {
          const current = map.get(target.id); if (current) { map.set(target.id, { ...current, shapes: after }); eventEmitter.emit('PHYSICS_CHANGED'); eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node: target }); }
        } });
        eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node: target });
      }
      startShapes.current = null;
      redraw(x => x + 1);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [selectedNodeId, editorScene, bodies, triggers, eventEmitter, push]);

  if (!node) return null;
  return <div data-cleo-overlay className='pointer-events-none absolute inset-0 z-10'>
    {entries.flatMap(entry => collisionHandles(entry.shape).map((handle, handleIndex) => {
      const local = [...entry.shape.offset];
      local[handle.axis] += handle.extent;
      const screen = project(worldPoint(node, local));
      if (!screen?.inFront) return [];
      const color = COLORS[entry.channel];
      return <button key={`${entry.channel}-${entry.index}-${handleIndex}`} type='button'
        aria-label={`${entry.channel} ${entry.shape.type} ${handle.kind} ${'XYZ'[handle.axis]}`}
        className='pointer-events-auto absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-surface-raised'
        style={{ left: screen.x, top: screen.y, borderColor: color, cursor: 'crosshair' }}
        onPointerDown={event => {
          event.preventDefault(); event.stopPropagation();
          active.current = { channel: entry.channel, index: entry.index, handle, start: { x: event.clientX - (viewportRef.current?.getBoundingClientRect().left ?? 0), y: event.clientY - (viewportRef.current?.getBoundingClientRect().top ?? 0) }, before: entry.shape };
          startShapes.current = [...(entry.channel === 'body' ? bodies.get(node.id)?.shapes ?? [] : triggers.get(node.id)?.shapes ?? [])];
        }} />;
    }))}
  </div>;
}
