import { isEditorOwnedName, type Node, type Scene } from 'cleo'

// How an agent names nodes: "/Parent/Child" paths of names from the scene root, "#<id>", a unique bare
// name, or a "$alias" bound earlier in the same scene_edit call. Names are what the user sees in the scene
// tree and what scripts look nodes up by, so paths read naturally in both directions; ids disambiguate.
//
// The visible tree is the SceneInspector's: editor helpers (named __editor__/__debug__) and terrain chunks
// are hidden, by NAME, exactly as `isHiddenInTree` there does.

/** Left out of every agent view, as the scene tree leaves it out. */
export function isHiddenNode(node: Node): boolean {
  return isEditorOwnedName(node.name) || node.name.startsWith('__terrain_chunk__')
}

export function userChildren(node: Node): Node[] {
  return node.children.filter(c => !isHiddenNode(c))
}

/** "/A/B/C" from `root` (exclusive); the root itself is "/". */
export function nodePath(node: Node, root: Node): string {
  if (node === root) return '/'
  const parts: string[] = []
  for (let n: Node | null = node; n && n !== root; n = n.parent) parts.unshift(n.name)
  return '/' + parts.join('/')
}

/** Every visible node under `root`, depth first, the root excluded. */
export function walkUserNodes(root: Node, visit: (node: Node, depth: number) => void, depth = 0): void {
  for (const child of userChildren(root)) {
    visit(child, depth)
    walkUserNodes(child, visit, depth + 1)
  }
}

export class NodeRefError extends Error {}

const list = (nodes: Node[], root: Node, max = 8) =>
  nodes.slice(0, max).map(n => `${nodePath(n, root)} (#${n.id})`).join(', ') + (nodes.length > max ? `, … ${nodes.length - max} more` : '')

/**
 * The node `ref` names in `scene`, or a NodeRefError that says what exists instead: the agent reads that
 * message and corrects itself, so it names the near misses rather than just failing.
 */
export function resolveNodeRef(scene: Scene, ref: string, aliases?: ReadonlyMap<string, Node>): Node {
  const root = scene.root
  const r = ref.trim()
  if (!r) throw new NodeRefError('Empty node reference.')

  if (r.startsWith('$')) {
    const node = aliases?.get(r)
    if (!node) throw new NodeRefError(`Unknown alias "${r}". An alias is set by a create op's "as" earlier in the same call.`)
    return node
  }

  if (r.startsWith('#')) {
    const node = scene.getNodeById(r.slice(1))
    if (!node || isHiddenNode(node)) throw new NodeRefError(`No node with id ${r}.`)
    return node
  }

  if (r === '/') return root

  if (r.startsWith('/')) {
    let node = root
    for (const name of r.slice(1).split('/').filter(Boolean)) {
      const kids = userChildren(node)
      const matches = kids.filter(c => c.name === name)
      if (matches.length === 1) { node = matches[0]; continue }
      const here = nodePath(node, root)
      if (matches.length > 1)
        throw new NodeRefError(`"${r}" is ambiguous: ${matches.length} children of ${here} are named "${name}". Use an id: ${list(matches, root)}.`)
      const names = kids.map(c => `"${c.name}"`).slice(0, 20).join(', ')
      throw new NodeRefError(`No child "${name}" under ${here}. ${kids.length ? `Its children: ${names}${kids.length > 20 ? ', …' : ''}.` : 'It has no children.'}`)
    }
    return node
  }

  // A bare name: must be unique in the scene.
  const exact: Node[] = []
  const loose: Node[] = []
  const lower = r.toLowerCase()
  walkUserNodes(root, n => {
    if (n.name === r) exact.push(n)
    else if (n.name.toLowerCase() === lower || n.name.toLowerCase().includes(lower)) loose.push(n)
  })
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) throw new NodeRefError(`${exact.length} nodes are named "${r}"; use a path or an id: ${list(exact, root)}.`)
  if (loose.length) throw new NodeRefError(`No node named "${r}". Did you mean: ${list(loose, root)}?`)
  throw new NodeRefError(`No node named "${r}" in the scene. Call scene_tree to see what exists.`)
}
