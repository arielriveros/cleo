/** Which transform the gizmo edits. */
export type GizmoMode = 'position' | 'rotation' | 'scale';
/**
 * Which frame the transform gizmo's handles point along: the selected node's own orientation, or the
 * world axes however deep in the hierarchy it sits. Scale ignores this and is always local — see
 * `effectiveGizmoSpace` in `gizmoMath`.
 */
export type GizmoSpace = 'local' | 'world';
