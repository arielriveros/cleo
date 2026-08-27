import { createContext, useContext } from 'react';
import type { GizmoMode } from './EngineContext';

/**
 * The viewport selection + transform-gizmo slice. Selection changes fire on every click in the
 * viewport/tree, so a consumer that needs only the selection subscribes here (via {@link useSelection})
 * rather than to the whole EngineContext. The state itself lives in EngineProvider, driven by the
 * SELECT_NODE / GIZMO_DRAG events.
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
