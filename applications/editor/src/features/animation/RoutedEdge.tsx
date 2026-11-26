import { BaseEdge, useInternalNode, useStore, Position, type EdgeProps, type InternalNode } from '@xyflow/react'
import { routedPath, type Dir, type ReroutePoint, type XY } from './reroutes'

// The transition line. A plain one attaches to whichever border of each node faces where it goes (the other node, or
// its first reroute point), recomputed as you drag; a group's line runs from its port's handle. Either passes through
// its reroute points (reroutes.ts), each a node of the canvas, so a dragged point drags its line with it. Transitions
// both ways are drawn as two parallel lines with an arrow at each end.

export interface TransitionEdgeData {
  a: string
  b: string
  /** a -> b exists */
  forward: boolean
  /** b -> a exists */
  backward: boolean
  /** Runs handle to handle (a group's port), not along the borders. */
  ported?: boolean
  /** Its reroute points, first end to second, and the canvas nodes that stand for them (same order). */
  points?: ReroutePoint[]
  pointIds?: string[]
  /** Half a reroute node's size: its top-left is the point less this. */
  pointRadius?: number
  [key: string]: unknown
}

/** Half the gap between the two lines of a bidirectional edge. */
const DOUBLE_GAP = 1.8

const centerOf = (n: InternalNode): XY => ({
  x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2,
  y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2,
})

/**
 * Where the line from `node`'s centre to `toward` crosses `node`'s rectangle. Solved in a square normalised around
 * the node's centre, then mapped back.
 */
function intersection(node: InternalNode, toward: XY): XY {
  const w = (node.measured.width ?? 0) / 2
  const h = (node.measured.height ?? 0) / 2
  const c = centerOf(node)
  if (w === 0 || h === 0) return c
  const x1 = (toward.x - c.x) / (2 * w) - (toward.y - c.y) / (2 * h)
  const y1 = (toward.x - c.x) / (2 * w) + (toward.y - c.y) / (2 * h)
  const denom = Math.abs(x1) + Math.abs(y1)
  if (denom === 0) return c
  const a = 1 / denom
  const xx = a * x1
  const yy = a * y1
  return { x: w * (xx + yy) + c.x, y: h * (-xx + yy) + c.y }
}

/** Which border the intersection landed on: the line leaves the node square to it. */
function borderOf(node: InternalNode, point: XY): Position {
  const nx = Math.round(node.internals.positionAbsolute.x)
  const ny = Math.round(node.internals.positionAbsolute.y)
  const px = Math.round(point.x)
  const py = Math.round(point.y)
  if (px <= nx + 1) return Position.Left
  if (px >= nx + (node.measured.width ?? 0) - 1) return Position.Right
  if (py <= ny + 1) return Position.Top
  return Position.Bottom
}

/** The way out of a node through a border (or a handle on it). */
const outward = (p: Position): Dir =>
  p === Position.Left ? { x: -1, y: 0 } : p === Position.Right ? { x: 1, y: 0 } : p === Position.Top ? { x: 0, y: -1 } : { x: 0, y: 1 }
const reversed = (d: Dir): Dir => ({ x: -d.x, y: -d.y })

// `markerEnd`/`markerStart` arrive already resolved by xyflow into `url(#…)` strings; the marker objects
// they come from are set on the edge in MachineGraph.
export default function RoutedEdge({
  id, source, target, data, style, markerEnd, markerStart, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius,
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
}: EdgeProps) {
  const d = (data ?? {}) as Partial<TransitionEdgeData>
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  // The points where their nodes are now: mid-drag, before the drop commits them.
  const ids = d.pointIds ?? []
  const radius = d.pointRadius ?? 0
  const live = useStore(s => ids.map(pid => {
    const n = s.nodeLookup.get(pid)
    return n ? `${n.internals.positionAbsolute.x + radius},${n.internals.positionAbsolute.y + radius}` : ''
  }).join(';'))
  // Nodes are measured a frame after mount; drawing before that would put the edge at 0,0.
  if (!sourceNode || !targetNode) return null

  const at = live.split(';')
  const points: ReroutePoint[] = (d.points ?? []).map((p, i) => {
    const xy = at[i]?.split(',').map(Number)
    return xy && xy.length === 2 && xy.every(Number.isFinite) ? { ...p, x: xy[0], y: xy[1] } : p
  })

  let start: XY, startDir: Dir, end: XY, endDir: Dir
  if (d.ported) {
    // Handle to handle: xyflow has placed them.
    start = { x: sourceX, y: sourceY }
    startDir = outward(sourcePosition)
    end = { x: targetX, y: targetY }
    endDir = reversed(outward(targetPosition))
  } else {
    const first = points[0] ?? centerOf(targetNode)
    const last = points[points.length - 1] ?? centerOf(sourceNode)
    start = intersection(sourceNode, first)
    end = intersection(targetNode, last)
    startDir = outward(borderOf(sourceNode, start))
    endDir = reversed(outward(borderOf(targetNode, end)))
  }
  const { path, labelX, labelY } = routedPath(start, startDir, points, end, endDir)

  const both = !!d.forward && !!d.backward
  // The gate's summary at the line's middle (a fork's way out leads with its rank).
  const text = { label, labelX, labelY, labelStyle, labelShowBg: true, labelBgStyle, labelBgPadding, labelBgBorderRadius }

  if (!both) {
    return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} markerStart={markerStart} {...text} />
  }

  // Two directions: the same line drawn twice, translated along the normal of the straight start->end line. An
  // approximation: a true offset curve would mean re-solving the path.
  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * DOUBLE_GAP
  const ny = (dx / len) * DOUBLE_GAP

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd}
        style={{ ...style, transform: `translate(${nx}px, ${ny}px)` }} />
      <BaseEdge id={`${id}__back`} path={path} markerStart={markerStart}
        style={{ ...style, transform: `translate(${-nx}px, ${-ny}px)` }} {...text} />
    </>
  )
}
