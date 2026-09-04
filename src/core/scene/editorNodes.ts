import { Node } from './nodes/node';

/**
 * Editor/debug chrome: the one predicate the renderer asks before deciding whether a node belongs to
 * the SCENE or to the overlay layer drawn after post-processing.
 *
 * `isGizmo` is folded in rather than replaced. It is a duck-typed flag the editor's transform gizmo
 * has always set, and several renderer paths (probe capture, shadow casters, overdraw) already read
 * it; keeping both means an older caller that sets only `isGizmo` still gets the right answer.
 */
export function isEditorOnlyNode(node: Node): boolean {
    return node.editorOnly || (node as any).isGizmo === true;
}

/**
 * Mark a node and everything under it as editor chrome.
 *
 * Recursive because helpers are built as subtrees — a `__debug__body_<id>` group holding one
 * `__debug__shape_N` wireframe per collider — and the renderer tests each drawable node on its own.
 * Call it AFTER the children exist; a child added later must be marked itself.
 */
export function markEditorOnly(node: Node, value: boolean = true): void {
    node.editorOnly = value;
    for (const child of node.children) markEditorOnly(child, value);
}
