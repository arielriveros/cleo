import type { AssetGraph, AssetKey, AssetRef } from 'cleo'

// Layout for the reference viewer: the root in the middle, what REFERENCES it fanning left, what it
// REFERENCES fanning right — the reading Unreal's reference viewer established, and the one that matches
// the question being asked ("what breaks if I change this" on the left, "what does this need" on the right).
//
// Hand-rolled rather than dagre or elk. Neither is in the project, and this graph is already layered by
// construction: BFS depth from the root IS the column. A layout library would be a dependency, a bundle
// cost and a source of non-determinism, in exchange for a tidier row order.
//
// Pure and total, so it is unit-testable in the node suite alongside the graph itself.

/** Horizontal gap between depth columns. Wide enough for an edge label to sit on the curve. */
export const DX = 240
/** Vertical gap between siblings in one column. */
export const DY = 92

export type AssetNodeView = {
  key: AssetKey
  ref: AssetRef
  name: string
  /** Negative = referencer (left of root), 0 = the root, positive = reference (right). */
  depth: number
  x: number
  y: number
  /** The asset does not exist: something points at it and nothing declares it. */
  missing: boolean
  /** A scene whose saved refs predate a reference kind, so its edge list may be incomplete. */
  partial: boolean
}

export type AssetEdgeView = {
  id: string
  source: AssetKey
  target: AssetKey
  field: string
}

export type ReferenceView = {
  nodes: AssetNodeView[]
  edges: AssetEdgeView[]
  /** Nodes whose asset does not exist — surfaced in the header, since they are the actionable finding. */
  missingCount: number
}

export type ViewOptions = {
  /** How far to follow "what references this". `Infinity` for the whole closure. */
  referencerDepth?: number
  /** How far to follow "what this references". */
  referenceDepth?: number
  /** Display name for an asset. The graph stores identity, never names. */
  nameOf: (ref: AssetRef) => string
  /** True for a scene whose saved reference snapshot is known to be incomplete. */
  isPartial?: (ref: AssetRef) => boolean
  /** Kinds to hide. The root is never filtered out — a view with no root is not a view. */
  hiddenKinds?: ReadonlySet<string>
}

/**
 * The nodes and edges to draw around `root`, already positioned.
 *
 * A node reachable on BOTH sides — which a cycle makes possible, and which a diamond makes common — is
 * placed once, at the depth nearest the root. Drawing it twice would imply two assets.
 */
export function buildReferenceView(
  graph: AssetGraph,
  root: AssetRef,
  opts: ViewOptions,
): ReferenceView {
  const rootKey = `${root.kind}:${root.id}`
  const hidden = opts.hiddenKinds ?? new Set<string>()

  // key -> depth, keeping whichever sighting is nearest the root.
  const depths = new Map<AssetKey, number>([[rootKey, 0]])
  const place = (key: AssetKey, depth: number) => {
    const existing = depths.get(key)
    // Ties resolve to the LEFT (referencers) only when strictly nearer; otherwise first writer wins, and
    // references are walked first, so a tie shows the asset as a dependency. Either reading is defensible;
    // what matters is that it is deterministic.
    if (existing === undefined || Math.abs(depth) < Math.abs(existing)) depths.set(key, depth)
  }

  for (const [key, depth] of bfs(graph, rootKey, 'out', opts.referenceDepth ?? Infinity)) place(key, depth)
  for (const [key, depth] of bfs(graph, rootKey, 'in', opts.referencerDepth ?? Infinity)) place(key, -depth)

  const refOf = (key: AssetKey): AssetRef =>
    graph.refOf(key) ?? { kind: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1) }

  // Filtering happens BEFORE layout, so hiding a kind closes the gap it left rather than leaving a hole.
  const visible = [...depths.keys()].filter(key => key === rootKey || !hidden.has(refOf(key).kind))
  const inView = new Set(visible)

  const nodes: AssetNodeView[] = visible.map(key => {
    const ref = refOf(key)
    return {
      key,
      ref,
      name: opts.nameOf(ref),
      depth: depths.get(key)!,
      x: 0,
      y: 0,
      missing: !graph.has(key),
      partial: !!opts.isPartial?.(ref),
    }
  })

  // Columns: one per depth, ordered kind-then-name so a redraw does not reshuffle rows under the cursor.
  const byDepth = new Map<number, AssetNodeView[]>()
  for (const node of nodes) {
    const column = byDepth.get(node.depth)
    if (column) column.push(node)
    else byDepth.set(node.depth, [node])
  }
  for (const [depth, column] of byDepth) {
    column.sort((a, b) => a.ref.kind.localeCompare(b.ref.kind) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
    // Centred on the root's row, so the root sits on the axis rather than at the top of its column.
    const top = -((column.length - 1) * DY) / 2
    column.forEach((node, i) => { node.x = depth * DX; node.y = top + i * DY })
  }

  const edges: AssetEdgeView[] = []
  const seen = new Set<string>()
  for (const key of inView) {
    for (const edge of graph.outgoing(key)) {
      if (!inView.has(edge.to)) continue
      const id = `${edge.from}->${edge.to}|${edge.field}`
      if (seen.has(id)) continue
      seen.add(id)
      edges.push({ id, source: edge.from, target: edge.to, field: edge.field })
    }
  }

  return { nodes, edges, missingCount: nodes.filter(n => n.missing).length }
}

/**
 * Breadth-first from `start`, yielding each reachable key WITH its hop count.
 *
 * The graph's own `dependencies`/`dependents` return a flat nearest-first list and drop the depth, which
 * is the one thing a layout needs — asking them per node instead would re-walk the graph once per node.
 * Cycle-safe for the same reason they are: a template can embed a node referencing that template.
 */
function bfs(
  graph: AssetGraph, start: AssetKey, direction: 'in' | 'out', maxDepth: number,
): [AssetKey, number][] {
  if (maxDepth < 1) return []
  const seen = new Set<AssetKey>([start])
  const out: [AssetKey, number][] = []
  let frontier = [start]
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const following: AssetKey[] = []
    for (const key of frontier) {
      const edges = direction === 'out' ? graph.outgoing(key) : graph.incoming(key)
      for (const edge of edges) {
        const next = direction === 'out' ? edge.to : edge.from
        if (seen.has(next)) continue
        seen.add(next)
        out.push([next, depth])
        following.push(next)
      }
    }
    frontier = following
  }
  return out
}
