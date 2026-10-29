import { useEffect, useState } from 'react';
import type EventEmitter from '../../utils/eventEmitter';

/**
 * Which collision shape is being edited: one shape of one channel (body or trigger) of one node.
 *
 * A module-level value rather than React state, because three places read it that do not share a tree:
 * the Physics panel (row highlight), the viewport handles (`CollisionGizmo`) and the per-frame wireframe
 * tint in `editorHelpers`, which runs inside the engine's update and has no React at all. Every write goes
 * through {@link setCollisionShapeSelection}, which also emits {@link COLLISION_SHAPE_SELECT} so the
 * React readers re-render.
 *
 * Selecting a shape puts the viewport in "shape edit": the node's own transform gizmo steps aside and the
 * move/rotate gizmo drives the shape's offset and rotation instead. Any node selection — another node,
 * empty space, or the same node clicked again — clears it, and so does Escape.
 */

export type CollisionChannel = 'body' | 'trigger';

export interface CollisionShapeRef {
  nodeId: string;
  channel: CollisionChannel;
  index: number;
}

export const COLLISION_SHAPE_SELECT = 'COLLISION_SHAPE_SELECT';
/**
 * A shape list changed mid-gesture without a `PHYSICS_CHANGED`: the viewport handles write the maps on
 * every pointer move and only announce the full change when the drag ends, so the panel listens to this
 * to keep its fields live without a helper reconcile per move.
 */
export const COLLISION_SHAPES_EDITED = 'COLLISION_SHAPES_EDITED';
/** Move the editor camera to look at a shape (payload: a {@link CollisionShapeRef}). `CollisionGizmo` does it. */
export const COLLISION_SHAPE_FRAME = 'COLLISION_SHAPE_FRAME';

let current: CollisionShapeRef | null = null;

export function selectedCollisionShape(): CollisionShapeRef | null {
  return current;
}

export function sameShapeRef(a: CollisionShapeRef | null, b: CollisionShapeRef | null): boolean {
  return a === b || (!!a && !!b && a.nodeId === b.nodeId && a.channel === b.channel && a.index === b.index);
}

/** Select a shape, or clear with null. A no-op (and no event) when nothing changes. */
export function setCollisionShapeSelection(emitter: EventEmitter, ref: CollisionShapeRef | null): void {
  if (sameShapeRef(current, ref)) return;
  current = ref ? { ...ref } : null;
  emitter.emit(COLLISION_SHAPE_SELECT, current);
}

/**
 * Keep the selection pointing at the same shape after a list edit. `remap` gets the selected index and
 * returns where that shape now is, or null when it is gone.
 */
export function remapCollisionShapeSelection(
  emitter: EventEmitter, nodeId: string, channel: CollisionChannel, remap: (index: number) => number | null,
): void {
  if (!current || current.nodeId !== nodeId || current.channel !== channel) return;
  const index = remap(current.index);
  setCollisionShapeSelection(emitter, index === null ? null : { nodeId, channel, index });
}

/** The selection, for a component: re-renders when it changes. */
export function useCollisionShapeSelection(emitter: EventEmitter): CollisionShapeRef | null {
  const [ref, setRef] = useState<CollisionShapeRef | null>(current);
  useEffect(() => {
    const onSelect = (next: CollisionShapeRef | null) => setRef(next);
    emitter.on(COLLISION_SHAPE_SELECT, onSelect);
    setRef(current);
    return () => { emitter.off(COLLISION_SHAPE_SELECT, onSelect); };
  }, [emitter]);
  return ref;
}
