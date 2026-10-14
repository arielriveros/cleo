import { mat4, quat, vec3 } from 'gl-matrix';
import { decomposeTRS } from '../math';
import type { Node, SocketAttachment } from './nodes/node';
import { ModelNode } from './nodes/modelNode';

// The per-frame half of sockets: move every node that is pinned to one onto it.
//
// Runs in the scene's LATE pass, after every animator has posed and after a full transform pass, so the
// socket's world matrix is this frame's — a held sword read earlier trails the hand by a frame, which at
// a sword's length is very visible.

const scratchSocket = mat4.create();
const scratchInv = mat4.create();
const scratchLocal = mat4.create();
const t = vec3.create();
const r = quat.create();
const s = vec3.create();

/** True when `model` is `node` or inside its subtree — never a valid owner for `node`'s socket. */
function isWithin(model: Node, node: Node): boolean {
    for (let n: Node | null = model; n; n = n.parent) if (n === node) return true;
    return false;
}

/** The first skinned model in `root`'s subtree (breadth-first) that has `socket`, skipping `exclude`. */
function findIn(root: Node, socket: string, exclude: Node): ModelNode | null {
    const queue: Node[] = [root];
    while (queue.length) {
        const n = queue.shift()!;
        if (n === exclude) continue;
        if (n instanceof ModelNode && n.socketNames.includes(socket)) return n;
        queue.push(...n.children);
    }
    return null;
}

/**
 * The model whose skeleton carries the socket `node` is pinned to, or null.
 *
 * `'parent'` walks UP, and at each ancestor also looks DOWN into it: a character is usually a holder node
 * with its skinned meshes beneath it, and a weapon dropped under the holder is a sibling of the mesh, not
 * its child. The node's own subtree is never searched — a node cannot follow a socket on itself.
 *
 * The climb STOPS at the first character it passes, and never searches from the scene root. Unbounded, a
 * weapon whose own character had no such socket (a model swapped for a rig with other bone names) found
 * the first model ANYWHERE in the scene that had one, and rode a stranger's hand: the player's sword on a
 * distant knight, hurting it from across the level, and every enemy's blade swinging on that same hand.
 */
export function resolveSocketOwner(node: Node, attachment: SocketAttachment, byId: (id: string) => Node | null): ModelNode | null {
    if (attachment.target !== 'parent') {
        const target = byId(attachment.target);
        if (!target || isWithin(target, node)) return null;
        return findIn(target, attachment.socket, node);
    }
    const sceneRoot = node.scene?.root ?? null;
    for (let a = node.parent; a && a !== sceneRoot; a = a.parent) {
        const found = findIn(a, attachment.socket, node);
        if (found) return found;
        // A character owns everything beneath it; above it are other characters.
        if (a.nodeType === 'character') break;
    }
    return null;
}

/**
 * Put `node` on its socket this frame. Returns false when the socket does not resolve, in which case the
 * node is left exactly where it was.
 */
export function followSocket(node: Node, owner: ModelNode): boolean {
    const attachment = node.socketAttachment;
    const parent = node.parent;
    if (!attachment || !parent) return false;
    if (!owner.getSocketWorldMatrix(attachment.socket, scratchSocket)) return false;

    // local = inverse(parentWorld) x socketWorld, decomposed: a node stores TRS, not a matrix.
    if (!mat4.invert(scratchInv, parent.worldTransform)) return false;
    mat4.multiply(scratchLocal, scratchInv, scratchSocket);
    decomposeTRS(scratchLocal, t, r, s);
    node.setPosition(t);
    node.setQuaternion(r);
    node.setScale(s);
    node.updateTransforms(parent.worldTransform);
    return true;
}
