/**
 * The name markers that make a node EDITOR-OWNED: something the editor put into a scene for its own
 * purposes — the free-fly camera, a gizmo handle, a helper icon, a collider wireframe, a brush cursor,
 * a preview light — as opposed to content the user authored.
 *
 * `includes`, not `startsWith`, on purpose: it is the contract the publish strip, the save-time strip and
 * the scene tree already follow, and `validateNodeName` refuses either marker anywhere in a user-typed
 * name, so authored content can never match.
 *
 * A leaf module with no imports, because `Node` reads it and anything heavier would close a cycle through
 * the class every node type extends. See `Node.isEditorOwned` for the full predicate, which also honours
 * an explicit flag and inherits from ancestors.
 */
export const EDITOR_NODE_MARKERS = ['__editor__', '__debug__'] as const;

/**
 * Whether a node NAME alone marks it editor-owned. Prefer `Node.isEditorOwned` when you have the node.
 *
 * Type-checked rather than trusted: a script can assign `node.name = 7` and a hand-edited scene can carry a
 * numeric name, and this runs on every structural event, so a TypeError here would abort a whole load.
 */
export function isEditorOwnedName(name: unknown): boolean {
    return typeof name === 'string' && (name.includes('__editor__') || name.includes('__debug__'));
}
