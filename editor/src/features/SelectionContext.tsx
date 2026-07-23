import { createContext, useContext } from 'react';
import type { GizmoMode } from './EngineContext';

/**
 * The viewport selection + transform-gizmo slice, split out of the large EngineContext.
 *
 * Selection changes fire on every click in the viewport/tree, so isolating them here lets a consumer
 * that only needs the current selection subscribe to just this slice (via {@link useSelection}) instead
 * of re-rendering on every unrelated EngineContext state change. The state itself still lives in and is
 * driven by EngineProvider (selection is set from the SELECT_NODE / GIZMO_DRAG events); this context only
 * re-exposes it as a narrow, memoized value.
 */
export interface SelectionContextValue {
  /** Id of the currently selected node, or null. Driven by the SELECT_NODE event. */
  selectedNode: string | null;
  /** True while a transform gizmo is being dragged. Driven by the GIZMO_DRAG_START/END events. */
  isGizmoDragging: boolean;
  /** Active transform-gizmo mode (move/rotate/scale). */
  gizmoMode: GizmoMode;
  setGizmoMode: (mode: GizmoMode) => void;
}

export const SelectionContext = createContext<SelectionContextValue | null>(null);

/** Read the selection / transform-gizmo slice. Provided by EngineProvider. */
export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be used within an EngineProvider');
  return ctx;
}
