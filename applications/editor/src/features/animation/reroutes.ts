import type { AnimationStateMachine } from 'cleo'
import { graphPlan, groupsOf } from './stateGroups'

/**
 * Reroute points: where a drawn transition line is routed through on the graph, as in a Blueprint. Double-click a line
 * to add one, drag it, and from its hover buttons flip how the line passes through it (left to right, or top to bottom)
 * or delete it.
 *
 * They are layout, like a state's x/y: kept on each layer (`reroutes`, see AnimationReroutes in the engine), ignored
 * at runtime. A line is named by the view it is drawn in and its own key (stateGroups' PlanLink.key), so a line drawn
 * at the top and the same pair's line inside an opened group keep their own points.
 */

export interface ReroutePoint {
  x: number
  y: number
  /** How the line passes through it: 'h' left to right (the default), 'v' top to bottom. */
  axis?: 'h' | 'v'
}

export type RerouteTable = Record<string, ReroutePoint[]>

type WithReroutes = AnimationStateMachine & { reroutes?: RerouteTable }

export interface XY { x: number; y: number }

/** The key a line's points are kept under: the view ('' the whole layer, else the group opened) and the line's key. */
export const rerouteKey = (view: string | null, linkKey: string): string => `${view ?? ''}::${linkKey}`

/** A line's points, in order from its first end to its second. */
export const pointsOf = (sm: AnimationStateMachine, view: string | null, linkKey: string): ReroutePoint[] =>
  (sm as WithReroutes).reroutes?.[rerouteKey(view, linkKey)] ?? []

/** The machine (a layer view) with a line's points replaced: none removes the entry, an emptied table goes too. */
export function withPoints(sm: AnimationStateMachine, key: string, points: ReroutePoint[] | null): AnimationStateMachine {
  const table: RerouteTable = { ...((sm as WithReroutes).reroutes ?? {}) }
  if (points && points.length) table[key] = points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), ...(p.axis === 'v' ? { axis: 'v' as const } : {}) }))
  else delete table[key]
  const out: WithReroutes = { ...sm }
  if (Object.keys(table).length) out.reroutes = table
  else delete out.reroutes
  return out
}

/** Squared distance from `p` to the segment `a`–`b`. */
function segmentDistance2(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
  const x = a.x + dx * t - p.x, y = a.y + dy * t - p.y
  return x * x + y * y
}

/**
 * Where a point clicked at `at` goes among a line's points: on the stretch of the line (first end, its points, second
 * end) nearest the click. Its axis follows that stretch: across it if it runs more across than down.
 */
export function insertPoint(points: readonly ReroutePoint[], start: XY, end: XY, at: XY): { index: number; point: ReroutePoint } {
  const chain: XY[] = [start, ...points, end]
  let index = 0, best = Infinity
  for (let i = 0; i < chain.length - 1; i++) {
    const d = segmentDistance2(at, chain[i], chain[i + 1])
    if (d < best) { best = d; index = i }
  }
  const a = chain[index], b = chain[index + 1]
  const axis: 'h' | 'v' = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'h' : 'v'
  return { index, point: { x: Math.round(at.x), y: Math.round(at.y), ...(axis === 'v' ? { axis } : {}) } }
}

/** A line's points with one added at `index`. */
export const addedPoint = (points: readonly ReroutePoint[], index: number, point: ReroutePoint): ReroutePoint[] =>
  [...points.slice(0, index), point, ...points.slice(index)]

/** A line's points with one moved. */
export const movedPoint = (points: readonly ReroutePoint[], index: number, x: number, y: number): ReroutePoint[] =>
  points.map((p, i) => (i === index ? { ...p, x: Math.round(x), y: Math.round(y) } : p))

/** A line's points with one turned: left to right becomes top to bottom, and back. */
export const toggledPoint = (points: readonly ReroutePoint[], index: number): ReroutePoint[] =>
  points.map((p, i) => {
    if (i !== index) return p
    if (p.axis === 'v') { const { axis: _v, ...h } = p; return h }
    return { ...p, axis: 'v' as const }
  })

/** A line's points without one. */
export const removedPoint = (points: readonly ReroutePoint[], index: number): ReroutePoint[] =>
  points.filter((_, i) => i !== index)

/** A line key with a name renamed in it: `a|b` (kept sorted, as the plan makes it) or `from>to`. */
function renamedLinkKey(linkKey: string, from: string, to: string): string {
  for (const sep of ['>', '|']) {
    const parts = linkKey.split(sep)
    if (parts.length !== 2 || !parts.includes(from)) continue
    const [a, b] = parts.map(p => (p === from ? to : p))
    return sep === '|' ? (a <= b ? `${a}|${b}` : `${b}|${a}`) : `${a}>${b}`
  }
  return linkKey
}

/**
 * The machine (a layer view) with a state, group or fork renamed in its reroute keys: the lines it is an end of, and
 * the view of a group renamed, keep their points.
 */
export function renameInReroutes(sm: AnimationStateMachine, from: string, to: string): AnimationStateMachine {
  const table = (sm as WithReroutes).reroutes
  if (!table || from === to) return sm
  const next: RerouteTable = {}
  for (const [key, points] of Object.entries(table)) {
    const cut = key.indexOf('::')
    const view = cut >= 0 ? key.slice(0, cut) : ''
    const line = cut >= 0 ? key.slice(cut + 2) : key
    next[`${view === from ? to : view}::${renamedLinkKey(line, from, to)}`] = points
  }
  return { ...sm, reroutes: next } as AnimationStateMachine
}

/**
 * The machine (a layer view) without the points of lines it no longer draws: a transition removed, a state deleted
 * or moved into a group takes its lines' points with it.
 */
export function pruneReroutes(sm: AnimationStateMachine): AnimationStateMachine {
  const table = (sm as WithReroutes).reroutes
  if (!table || !Object.keys(table).length) return sm
  const drawn = new Set<string>()
  for (const view of [null, ...groupsOf(sm).map(g => g.name)])
    for (const l of graphPlan(sm, view).links) drawn.add(rerouteKey(view, l.key))
  const kept = Object.entries(table).filter(([key]) => drawn.has(key))
  if (kept.length === Object.keys(table).length) return sm
  const out: WithReroutes = { ...sm }
  if (kept.length) out.reroutes = Object.fromEntries(kept)
  else delete out.reroutes
  return out
}

/** The machine (a layer view) without any points in one view: what Tidy clears, as it moves every node of the view. */
export function clearView(sm: AnimationStateMachine, view: string | null): AnimationStateMachine {
  const table = (sm as WithReroutes).reroutes
  if (!table) return sm
  const prefix = `${view ?? ''}::`
  const kept = Object.entries(table).filter(([key]) => !key.startsWith(prefix))
  const out: WithReroutes = { ...sm }
  if (kept.length) out.reroutes = Object.fromEntries(kept)
  else delete out.reroutes
  return out
}

// ----- drawing ---------------------------------------------------------------------------------------------------

/** A unit direction: which way a line leaves (or enters) an end. */
export type Dir = XY

/**
 * The path of a line from `start` (leaving along `startDir`) through `points` to `end` (arriving along `endDir`, the
 * way it travels into the node): one cubic per stretch, passing through each point left to right or top to bottom as
 * its axis says, whichever way the line is heading there. Returns the SVG path and where its label sits: the middle of
 * the middle stretch.
 */
export function routedPath(start: XY, startDir: Dir, points: readonly ReroutePoint[], end: XY, endDir: Dir): { path: string; labelX: number; labelY: number } {
  const anchors: { p: XY; dir: Dir }[] = [{ p: start, dir: startDir }]
  points.forEach((pt, i) => {
    const prev = i === 0 ? start : points[i - 1]
    const next = i === points.length - 1 ? end : points[i + 1]
    const sign = (v: number) => (v < 0 ? -1 : 1)
    const dir = pt.axis === 'v' ? { x: 0, y: sign(next.y - prev.y) } : { x: sign(next.x - prev.x), y: 0 }
    anchors.push({ p: pt, dir })
  })
  anchors.push({ p: end, dir: endDir })
  let path = `M${r(start.x)},${r(start.y)}`
  const segments: [XY, XY, XY, XY][] = []
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1]
    const k = Math.max(20, 0.45 * Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y))
    const c1 = { x: a.p.x + a.dir.x * k, y: a.p.y + a.dir.y * k }
    const c2 = { x: b.p.x - b.dir.x * k, y: b.p.y - b.dir.y * k }
    segments.push([a.p, c1, c2, b.p])
    path += ` C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(b.p.x)},${r(b.p.y)}`
  }
  const [p0, p1, p2, p3] = segments[Math.floor((segments.length - 1) / 2)]
  // The cubic at t = 1/2.
  const labelX = (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8
  const labelY = (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8
  return { path, labelX, labelY }
}

const r = (v: number) => Math.round(v * 10) / 10
