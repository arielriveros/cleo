/**
 * Whether something moves a node at runtime, for a GI volume: a capture leaves such a node out (it would be
 * baked where it happened to stand), and so does the bake's geometry signature. Pure: no GPU, no node classes
 * (duck-typed), so it can be tested on its own.
 *
 * The node, or any ancestor, moves when it has:
 * - its own `onUpdate`: a script updating it in place (the windmill's sails);
 * - a dynamic Collider (authored mass above 0): it falls and gets pushed, and carries everything under it
 *   (the pond's floating crates). Asked of the AUTHORED mass, never of the live body: the editor's scene
 *   never builds bodies and a running one does, and a bake made in Edit must match the scene in Play;
 * - capture only (`linked` false): a live dynamic body nothing authored, one a script made at runtime.
 *   It cannot be seen in Edit, so it never enters the signature.
 *
 * `linked` (the signature) also counts any node a script asset is linked to (`__scriptId`, set at parse),
 * whether or not its script has been compiled and attached yet. A load's signature is taken in its first
 * frames and an export's long after, so only that answer is the same at both; a scripted node that never
 * moves (the skull cave's entrance) is still captured, it just does not make a bake stale.
 */
export function giMoves(node: object, linked: boolean = false): boolean {
    for (let p: any = node; p; p = p.parent) {
        if (Object.prototype.hasOwnProperty.call(p, 'onUpdate')) return true;
        if (p.nodeType === 'collider' && p.isDynamic) return true;
        if (!linked && p.ownBody?.isDynamic) return true;
        if (linked && typeof p.getVariable === 'function' && p.getVariable('__scriptId') != null) return true;
    }
    return false;
}
