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

export { EDITOR_NODE_MARKERS, isEditorOwnedName } from './editorOwnership';

/**
 * Whether a node is EDITOR-OWNED — editor chrome or a preview prop, not authored content — and so must
 * never mark a document unsaved, never become an undo step and never be saved. See
 * {@link Node.isEditorOwned}, which this reads.
 *
 * Deliberately a different question from {@link isEditorOnlyNode}. That one routes rendering into the
 * overlay layer; this one is about the user's document. Every editor-only node is editor-owned, but the
 * preview ground, the preview skybox and the editor camera are owned and still draw as lit scene content.
 */
export function isEditorOwnedNode(node: Node): boolean {
    return node.isEditorOwned;
}

/**
 * Mark a node, and through inheritance everything under it, now or added later, as editor-owned. For the
 * editor-built nodes whose name cannot carry an `__editor__`/`__debug__` marker, such as a preview holder
 * named after the asset it shows. Returns the node, so it can wrap a `new`.
 */
export function markEditorOwned<T extends Node>(node: T, value: boolean = true): T {
    node.editorOwned = value;
    return node;
}
