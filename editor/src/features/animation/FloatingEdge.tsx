import { BaseEdge, getBezierPath, useInternalNode, Position, type EdgeProps, type InternalNode } from '@xyflow/react'

// The transition edge. Two jobs the stock bezier edge can't do:
//
//   FLOATING  — it attaches to whichever border of each node is actually facing the other one, recomputed as
//               you drag. The stock edge is nailed to the handles, so a link to a node on the LEFT loops all
//               the way around to reach the fixed left-hand target handle.
//   -> vs =>  — one direction draws a single line with one arrowhead; both directions draw two parallel lines
//               with an arrow at each end, which is also an honest picture of two independent transitions.

export interface TransitionEdgeData {
  a: string
  b: string
  /** a -> b exists */
  forward: boolean
  /** b -> a exists */
  backward: boolean
  [key: string]: unknown
}

/** Half the gap between the two lines of a bidirectional edge. */
const DOUBLE_GAP = 1.8

const centerOf = (n: InternalNode) => ({
  x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2,
  y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2,
})

/**
 * Where the line joining the two node centres crosses `node`'s rectangle. Standard xyflow floating-edge math:
 * work in a square normalised around the node's centre, solve for the crossing, then map back.
 */
function intersection(node: InternalNode, other: InternalNode) {
  const w = (node.measured.width ?? 0) / 2
  const h = (node.measured.height ?? 0) / 2
  const c = centerOf(node)
  const o = centerOf(other)
  if (w === 0 || h === 0) return c

  const x1 = (o.x - c.x) / (2 * w) - (o.y - c.y) / (2 * h)
  const y1 = (o.x - c.x) / (2 * w) + (o.y - c.y) / (2 * h)
  const denom = Math.abs(x1) + Math.abs(y1)
  if (denom === 0) return c
  const a = 1 / denom
  const xx = a * x1
  const yy = a * y1
  return { x: w * (xx + yy) + c.x, y: h * (-xx + yy) + c.y }
}

/** Which border the intersection landed on — the bezier needs it to know which way to leave the node. */
function borderOf(node: InternalNode, point: { x: number; y: number }): Position {
  const nx = Math.round(node.internals.positionAbsolute.x)
  const ny = Math.round(node.internals.positionAbsolute.y)
  const px = Math.round(point.x)
  const py = Math.round(point.y)
  if (px <= nx + 1) return Position.Left
  if (px >= nx + (node.measured.width ?? 0) - 1) return Position.Right
  if (py <= ny + 1) return Position.Top
  return Position.Bottom
}

// `markerEnd`/`markerStart` arrive already resolved by xyflow into `url(#…)` strings, from the marker objects
// set on the edge — which is why those still live in StateGraph rather than here.
export default function FloatingEdge({ id, source, target, data, style, markerEnd, markerStart }: EdgeProps) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  // Nodes are measured a frame after mount; drawing before that would put the edge at 0,0.
  if (!sourceNode || !targetNode) return null

  const sourcePoint = intersection(sourceNode, targetNode)
  const targetPoint = intersection(targetNode, sourceNode)

  const [path] = getBezierPath({
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    sourcePosition: borderOf(sourceNode, sourcePoint),
    targetX: targetPoint.x,
    targetY: targetPoint.y,
    targetPosition: borderOf(targetNode, targetPoint),
  })

  const d = (data ?? {}) as Partial<TransitionEdgeData>
  const both = !!d.forward && !!d.backward

  if (!both) {
    // One direction: a single line, arrowhead on whichever end is the destination.
    return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} markerStart={markerStart} />
  }

  // Two directions: the same curve drawn twice, shifted along the normal of the straight source->target line.
  // Offsetting a bezier properly would mean re-solving it; a translate is an approximation that reads exactly
  // right at these distances and costs nothing.
  const dx = targetPoint.x - sourcePoint.x
  const dy = targetPoint.y - sourcePoint.y
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * DOUBLE_GAP
  const ny = (dx / len) * DOUBLE_GAP

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd}
        style={{ ...style, transform: `translate(${nx}px, ${ny}px)` }} />
      <BaseEdge id={`${id}__back`} path={path} markerStart={markerStart}
        style={{ ...style, transform: `translate(${-nx}px, ${-ny}px)` }} />
    </>
  )
}
