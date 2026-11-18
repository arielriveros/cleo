import type { Node } from 'cleo'

// Where a preview character stands before anything plays on it. A root-motion clip moves the model node ITSELF
// (the animator's root motion moves the nearest node with a body, and a preview has none), so without this a
// turn or a stop played once in the Clip Player left the character turned and moved off for every clip after it,
// until the tab was closed. The transports put it back on stop, on a clip change, on a loop and on the way out.

interface Home { position: [number, number, number]; quaternion: [number, number, number, number] }

const homes = new WeakMap<Node, Home>()

/** Remember where `node` stands now, unless its home is already known (a second call keeps the first). */
export function rememberPreviewHome(node: Node): void {
  if (homes.has(node)) return
  const p = node.position, q = node.quaternion
  homes.set(node, { position: [p[0], p[1], p[2]], quaternion: [q[0], q[1], q[2], q[3]] })
}

/** Put `node` back where it was remembered standing. A no-op for a node that never was. */
export function returnPreviewHome(node: Node): void {
  const home = homes.get(node)
  if (!home) return
  const p = node.position, q = node.quaternion
  const moved = p[0] !== home.position[0] || p[1] !== home.position[1] || p[2] !== home.position[2]
    || q[0] !== home.quaternion[0] || q[1] !== home.quaternion[1] || q[2] !== home.quaternion[2] || q[3] !== home.quaternion[3]
  if (!moved) return
  node.setPosition([...home.position] as any)
  node.setQuaternion([...home.quaternion] as any)
}
