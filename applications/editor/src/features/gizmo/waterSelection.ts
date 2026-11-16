import { useEffect, useState } from 'react';
import type EventEmitter from '@cleo/app-kit/utils/eventEmitter';

/**
 * Which shape of which Water node is being edited (and, for a river or lake, which of its points): the
 * water's twin of collisionSelection.ts. A module-level value, because the inspector rows, the viewport's
 * shape and spline handles, and the per-frame helper drawing all read it without sharing a React tree.
 * Every write goes through {@link setWaterShapeSelection}, which emits {@link WATER_SHAPE_SELECT}.
 */

export interface WaterShapeRef {
  nodeId: string;
  /** The shape's id (not its index: ids survive reordering). */
  shapeId: string;
  /** A control point of a river or lake, or -1 for the shape as a whole. */
  point: number;
}

export const WATER_SHAPE_SELECT = 'WATER_SHAPE_SELECT';
/** The viewport handles changed a shape mid-drag (the full change is announced when the drag ends). */
export const WATER_SHAPES_EDITED = 'WATER_SHAPES_EDITED';
/** Move the editor camera to look at a shape (payload: a {@link WaterShapeRef}). */
export const WATER_SHAPE_FRAME = 'WATER_SHAPE_FRAME';

let current: WaterShapeRef | null = null;

export function selectedWaterShape(): WaterShapeRef | null {
  return current;
}

const same = (a: WaterShapeRef | null, b: WaterShapeRef | null) =>
  a === b || (!!a && !!b && a.nodeId === b.nodeId && a.shapeId === b.shapeId && a.point === b.point);

/** Select a shape (or one of its points), or clear with null. No event when nothing changes. */
export function setWaterShapeSelection(emitter: EventEmitter, ref: WaterShapeRef | null): void {
  if (same(current, ref)) return;
  current = ref ? { ...ref } : null;
  emitter.emit(WATER_SHAPE_SELECT, current);
}

/** The selection, for a component: re-renders when it changes. */
export function useWaterShapeSelection(emitter: EventEmitter): WaterShapeRef | null {
  const [ref, setRef] = useState<WaterShapeRef | null>(current);
  useEffect(() => {
    const onSelect = (next: WaterShapeRef | null) => setRef(next);
    emitter.on(WATER_SHAPE_SELECT, onSelect);
    setRef(current);
    return () => { emitter.off(WATER_SHAPE_SELECT, onSelect); };
  }, [emitter]);
  return ref;
}
