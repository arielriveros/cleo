import type { Node } from 'cleo'

// Nodes the USER put inside a placed model — a fire sprite on a torch's tip, a light in a lantern, a
// particle system on a sword — as opposed to the nodes the model asset itself produces.
//
// A model instance is rebuilt wholesale from its asset whenever the asset changes (a model save, or a
// scene opening after the model changed while it was closed). The rebuild knows only the asset, so every
// node the user had added under the model's hierarchy silently vanished with it. That is the "the fire
// sprite is gone after reload" bug: a torch template whose sprite sits under its torch MODEL lost the
// sprite on every placed copy the first time the scene reopened with that model's hash not yet recorded.
//
// Matched by NAME path (with `#k` for the k-th namesake, as templateOverrides.ts does): a live node with
// no counterpart at the same place in the asset's tree is the user's. Those are detached before the
// rebuild and re-attached at the same place in the rebuilt tree afterwards — the same node objects, so
// their ids, scripts and bodies survive untouched.

/** The shape the asset instantiates as: a `{ name, children }` tree. Only names and nesting are read. */
export interface ShapeNode { name?: string; children?: ShapeNode[] }

export interface ForeignChild {
  /** Name path (`name#k` segments) of the parent, relative to the instance root. Empty = the root. */
  parentPath: string[]
  node: Node
  /** Its index among its old parent's children, so it goes back in the same order. */
  index: number
}

/** `name#k` for each child, k counting earlier siblings with the same name. */
function segments(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map(n => {
    const k = seen.get(n) ?? 0
    seen.set(n, k + 1)
    return k === 0 ? n : `${n}#${k}`
  })
}

/**
 * Detach, and return, every node under `inst` that the asset's `shape` does not produce. Its own subtree
 * comes with it unexamined: whatever the user hung under their own node is theirs too.
 */
export function detachForeignChildren(inst: Node, shape: ShapeNode): ForeignChild[] {
  const out: ForeignChild[] = []
  const walk = (live: Node, expected: ShapeNode, path: string[]) => {
    const liveSegs = segments(live.children.map(c => c.name))
    const expectedSegs = new Set(segments((expected.children ?? []).map(c => c.name ?? '')))
    const expectedBySeg = new Map<string, ShapeNode>()
    const exp = expected.children ?? []
    segments(exp.map(c => c.name ?? '')).forEach((s, i) => expectedBySeg.set(s, exp[i]))
    // Snapshot: detaching mutates `live.children`.
    const children = live.children.slice()
    children.forEach((child, i) => {
      const seg = liveSegs[i]
      // Editor chrome (a light's icon, a socket preview) is rebuilt by its own reconciler; carrying it
      // over would leave a duplicate beside the fresh one.
      if (child.isEditorOwned) return
      if (expectedSegs.has(seg)) walk(child, expectedBySeg.get(seg)!, [...path, seg])
      else out.push({ parentPath: path, node: child, index: i })
    })
  }
  walk(inst, shape, [])
  // `reparent`: a move, not a despawn — no onDespawn, timers kept.
  for (const f of out) f.node.parent?.removeChild(f.node, true)
  return out
}

/** Put detached foreign nodes back under the rebuilt instance, at the same name path where it still exists. */
export function reattachForeignChildren(rebuilt: Node, foreign: ForeignChild[]): void {
  for (const f of foreign) {
    let parent: Node = rebuilt
    for (const seg of f.parentPath) {
      const segs = segments(parent.children.map(c => c.name))
      const i = segs.indexOf(seg)
      if (i < 0) break   // the asset no longer has that node: keep the child at the deepest surviving level
      parent = parent.children[i]
    }
    parent.addChild(f.node, Math.min(f.index, parent.children.length))
  }
}
