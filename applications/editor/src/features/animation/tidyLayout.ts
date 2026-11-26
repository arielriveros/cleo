/**
 * Tidy: a graph laid out in columns, left to right, the way its lines run.
 *
 * A layered layout in three passes. Each node takes the column of the fewest lines from the entry to it (a state
 * machine is all cycles, idle to walk and back, so the shortest way, not the longest, keeps it compact); each column is
 * ordered by where its nodes' neighbours sit in the columns either side, a few times across and back; and the columns
 * are spaced by the widest node in each, the rows by the nodes' own heights, each column centred on the others.
 * Deterministic: the same graph lays out the same way.
 */

export interface TidyNode {
  id: string
  /** Its size on the canvas (px). */
  w: number
  h: number
}

export interface TidyEdge {
  from: string
  to: string
}

export interface TidyOptions {
  /** Where walks start, first: the entry, the Any State node. Then every node nothing leads to, then the rest. */
  roots?: string[]
  /** Space between columns, and between the nodes of a column (px). */
  gapX?: number
  gapY?: number
}

/** Top-left positions by id, integer. */
export type TidyPositions = Record<string, { x: number; y: number }>

export function tidyLayout(nodes: readonly TidyNode[], edges: readonly TidyEdge[], opts: TidyOptions = {}): TidyPositions {
  const gapX = opts.gapX ?? 150, gapY = opts.gapY ?? 44
  const ids = nodes.map(n => n.id)
  const known = new Set(ids)
  const order = new Map(ids.map((id, i) => [id, i]))
  // One edge per ordered pair, no loops.
  const seen = new Set<string>()
  const list: TidyEdge[] = []
  for (const e of edges) {
    if (e.from === e.to || !known.has(e.from) || !known.has(e.to)) continue
    const k = `${e.from}\u0000${e.to}`
    if (seen.has(k)) continue
    seen.add(k)
    list.push(e)
  }
  const out = new Map<string, string[]>(ids.map(id => [id, []]))
  const into = new Map<string, number>(ids.map(id => [id, 0]))
  for (const e of list) { out.get(e.from)!.push(e.to); into.set(e.to, (into.get(e.to) ?? 0) + 1) }
  for (const targets of out.values()) targets.sort((a, b) => order.get(a)! - order.get(b)!)

  // 1. Columns: how many lines from where walks start (the entry first), following lines the way they run. A state
  // machine is all cycles (idle to walk and back), so a node's column is the shortest way to it, not the longest.
  const starts = [
    ...(opts.roots ?? []).filter(id => known.has(id)),
    ...ids.filter(id => into.get(id) === 0),
    ...ids,
  ]
  const column = new Map<string, number>()
  const discovery: string[] = []
  for (const s of starts) {
    if (column.has(s)) continue
    column.set(s, 0); discovery.push(s)
    const queue = [s]
    while (queue.length) {
      const id = queue.shift()!
      for (const t of out.get(id)!) {
        if (column.has(t)) continue
        column.set(t, column.get(id)! + 1); discovery.push(t)
        queue.push(t)
      }
    }
  }
  // Neighbours either way, for the ordering: a line is a line whichever way it runs.
  const near = new Map<string, string[]>(ids.map(id => [id, []]))
  for (const e of list) { near.get(e.from)!.push(e.to); near.get(e.to)!.push(e.from) }

  // 2. Order each column: by first discovery, then by the mean row of its neighbours in the column before (going
  // right) or after (coming back), a few sweeps.
  const columns: string[][] = []
  const rank = new Map(discovery.map((id, i) => [id, i]))
  for (const id of ids) (columns[column.get(id)!] ??= []).push(id)
  for (const col of columns) col?.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
  const filled = columns.filter(Boolean)
  const rowOf = new Map<string, number>()
  for (const col of filled) col.forEach((id, i) => rowOf.set(id, i))
  const sweep = (from: number, to: number, step: number) => {
    for (let c = from; c !== to; c += step) {
      const col = filled[c], beside = new Set(filled[c - step])
      const keyOf = new Map(col.map(id => {
        const ns = near.get(id)!.filter(n => beside.has(n))
        return [id, ns.length ? ns.reduce((sum, n) => sum + rowOf.get(n)!, 0) / ns.length : rowOf.get(id)!]
      }))
      col.sort((a, b) => keyOf.get(a)! - keyOf.get(b)! || rowOf.get(a)! - rowOf.get(b)!)
      col.forEach((id, i) => rowOf.set(id, i))
    }
  }
  for (let k = 0; k < 4; k++) {
    sweep(1, filled.length, 1)
    sweep(filled.length - 2, -1, -1)
  }

  // 3. Place: columns by their widest node, rows by the nodes' heights, every column centred on the tallest.
  const size = new Map(nodes.map(n => [n.id, n]))
  const heightOf = (col: string[]) => col.reduce((s, id) => s + size.get(id)!.h, 0) + gapY * (col.length - 1)
  const tallest = Math.max(0, ...filled.map(heightOf))
  const pos: TidyPositions = {}
  let x = 0
  for (const col of filled) {
    const width = Math.max(...col.map(id => size.get(id)!.w))
    let y = (tallest - heightOf(col)) / 2
    for (const id of col) {
      const n = size.get(id)!
      pos[id] = { x: Math.round(x + (width - n.w) / 2), y: Math.round(y) }
      y += n.h + gapY
    }
    x += width + gapX
  }
  return pos
}

/**
 * A node's size on the animator's canvas when it has not been measured (MachineGraph's boxes: a state 156 wide, a
 * group 180 with a 16 px row per port, a fork's 116 px pill).
 */
export function estimatedSize(kind: 'state' | 'group' | 'fork', opts: { rows?: number; chips?: boolean } = {}): { w: number; h: number } {
  if (kind === 'group') return { w: 180, h: 28 + Math.max(1, opts.rows ?? 0) * 16 }
  if (kind === 'fork') return { w: 116, h: 38 }
  return { w: 156, h: 52 + (opts.chips ? 20 : 0) }
}
