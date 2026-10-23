// The data behind the bone mapper: where to draw each skeleton, and what colour each bone is.
//
// Both skeletons are drawn in a flat FRONT view of their bind pose, normalised to unit height, so a rig in
// centimetres and one in metres sit side by side at the same size. Colour comes from the engine's own
// retarget plan (`retargetSegments`), never from a re-derivation here, so what the mapper shows is exactly
// what will play.

import { mat4, vec3 } from 'gl-matrix'
import { humanoidSlotOf, retargetSegments, skeletonTopology } from 'cleo'
import type { BoneMapping, Skin } from 'cleo'

export type LayoutJoint = {
  node: number
  name: string
  /** Humanoid slot (`hips`, `hand.L`, …), or null. */
  slot: string | null
  /** Front view: x is lateral (the character's LEFT is +x, the viewer's right), y is up; feet at 0, top at 1. */
  x: number
  y: number
  /** Index into the layout's `joints` of the parent joint, or -1. */
  parent: number
}

export type SkeletonLayout = { joints: LayoutJoint[]; byNode: Map<number, number> }

const isIdentity = (m: ArrayLike<number>) => {
  const I = mat4.create()
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - I[i]) > 1e-6) return false
  return true
}

/** Each joint's bind-pose MODEL position: from `inverse(IBM)`, else the node transforms accumulated. */
function bindPositions(skin: Skin): vec3[] {
  const fromChain = (node: number) => {
    const m = mat4.create()
    const chain: number[] = []
    for (let n: number | undefined = node, g = 0; n !== undefined && g < 256; n = skin.nodeParents?.get(n), g++) chain.unshift(n)
    for (const n of chain) { const t = skin.nodeTransforms?.get(n); if (t) mat4.multiply(m, m, t as mat4) }
    return mat4.getTranslation(vec3.create(), m)
  }
  return skin.joints.map(j => {
    const ibm = j.inverseBindMatrix as mat4
    if (ibm && !isIdentity(ibm)) {
      const w = mat4.invert(mat4.create(), ibm)
      if (w) return mat4.getTranslation(vec3.create(), w)
    }
    return fromChain(j.nodeIndex)
  })
}

/** A skeleton's front view. Up is the tallest axis; lateral is the axis the left and right limbs differ on. */
export function skeletonLayout(skin: Skin): SkeletonLayout {
  const pos = bindPositions(skin)
  const names = skin.joints.map(j => skin.nodeNames?.get(j.nodeIndex) ?? `node ${j.nodeIndex}`)
  const slots = names.map(n => humanoidSlotOf(n))
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const p of pos) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]) }
  const ext = [0, 1, 2].map(a => (pos.length ? max[a] - min[a] : 0))
  // Up runs from the hips to the head when the names say where those are. NOT the tallest axis: a T-pose's
  // arm span is wider than the character is tall, which would lay the skeleton on its side.
  const at = (slot: string) => { const i = slots.indexOf(slot); return i >= 0 ? pos[i] : null }
  const low = at('hips'), high = at('head') ?? at('neck')
  let up = ext.indexOf(Math.max(...ext))
  let upSign = 1
  if (low && high) {
    const d = vec3.sub(vec3.create(), high, low)
    up = [0, 1, 2].reduce((a, b) => (Math.abs(d[b]) > Math.abs(d[a]) ? b : a))
    upSign = d[up] >= 0 ? 1 : -1
  }

  // Lateral: where the left limbs sit relative to the right ones, if the names say which is which.
  const sideOf = (side: 'L' | 'R') => {
    const v = vec3.create(); let n = 0
    slots.forEach((s, i) => { if (s?.endsWith(`.${side}`)) { vec3.add(v, v, pos[i]); n++ } })
    return n ? vec3.scale(v, v, 1 / n) : null
  }
  const left = sideOf('L'), right = sideOf('R')
  let lateral = [0, 1, 2].filter(a => a !== up).reduce((a, b) => (ext[b] > ext[a] ? b : a))
  let sign = 1
  if (left && right) {
    const d = vec3.sub(vec3.create(), left, right)
    lateral = [0, 1, 2].filter(a => a !== up).reduce((a, b) => (Math.abs(d[b]) > Math.abs(d[a]) ? b : a))
    sign = d[lateral] >= 0 ? 1 : -1
  }

  const height = ext[up] > 1e-9 ? ext[up] : 1
  const mid = pos.length ? (min[lateral] + max[lateral]) / 2 : 0
  const base = upSign > 0 ? min[up] : max[up]
  const topo = skeletonTopology(skin)
  const joints: LayoutJoint[] = skin.joints.map((j, i) => ({
    node: j.nodeIndex,
    name: names[i],
    slot: slots[i],
    x: (sign * (pos[i][lateral] - mid)) / height,
    y: (upSign * (pos[i][up] - base)) / height,
    parent: topo.parentJoint[i],
  }))
  return { joints, byNode: new Map(joints.map((j, i) => [j.node, i])) }
}

// ---- Colour ---------------------------------------------------------------------------------------------

/**
 * A SOURCE bone: `auto`/`manual` — mapped; `merged` — no target of its own, its motion folds into a mapped
 * bone below it; `dropped` — unmapped on purpose; `lost` — animated but its motion reaches nothing (needs
 * attention); `static` — no clip animates it, so there is nothing to map.
 */
export type SourceStatus = 'auto' | 'manual' | 'merged' | 'dropped' | 'lost' | 'static'

/**
 * A TARGET bone: `driven` — one source drives it; `merged` — several source bones combined into it;
 * `shared` — nothing maps to it, but it takes a share of the bend below it; `rest` — holds its rest pose.
 */
export type TargetStatus = 'driven' | 'merged' | 'shared' | 'rest'

export type RetargetView = {
  source: Map<number, SourceStatus>
  target: Map<number, TargetStatus>
  /** Every source → target link the retarget will use (mapped and merged), for drawing. */
  links: { source: number; target: number; merged: boolean }[]
  counts: { mapped: number; merged: number; lost: number; dropped: number; driven: number; shared: number; rest: number }
}

export function retargetView(mapping: BoneMapping, sourceSkin: Skin, targetSkin: Skin): RetargetView {
  const plan = retargetSegments(mapping, sourceSkin, targetSkin)
  const byNode = new Map(mapping.entries.map(e => [e.sourceNode, e] as const))
  const source = new Map<number, SourceStatus>()
  const links: RetargetView['links'] = []
  for (const j of sourceSkin.joints) {
    const e = byNode.get(j.nodeIndex)
    let status: SourceStatus
    if (!e) status = 'static'
    else if (e.targetNode !== null) {
      status = e.kind === 'manual' ? 'manual' : 'auto'
      links.push({ source: j.nodeIndex, target: e.targetNode, merged: false })
    } else if (e.dropped) status = 'dropped'
    else if (plan.contributions.has(j.nodeIndex)) {
      status = 'merged'
      links.push({ source: j.nodeIndex, target: plan.contributions.get(j.nodeIndex)!, merged: true })
    } else status = 'lost'
    source.set(j.nodeIndex, status)
  }

  const sharedNodes = new Set([...plan.shares.values()].flat())
  const sourcesPerTarget = new Map<number, number>()
  for (const l of links) sourcesPerTarget.set(l.target, (sourcesPerTarget.get(l.target) ?? 0) + 1)
  const target = new Map<number, TargetStatus>()
  for (const j of targetSkin.joints) {
    const seg = plan.segments.get(j.nodeIndex)
    const n = sourcesPerTarget.get(j.nodeIndex) ?? 0
    target.set(j.nodeIndex,
      seg ? (n > 1 || seg.length > 1 ? 'merged' : 'driven') : sharedNodes.has(j.nodeIndex) ? 'shared' : 'rest')
  }

  const count = <T,>(m: Map<number, T>, ...vals: T[]) => [...m.values()].filter(v => vals.includes(v)).length
  return {
    source, target, links,
    counts: {
      mapped: count(source, 'auto', 'manual'), merged: count(source, 'merged'), lost: count(source, 'lost'),
      dropped: count(source, 'dropped'), driven: count(target, 'driven', 'merged'), shared: count(target, 'shared'),
      rest: count(target, 'rest'),
    },
  }
}

/** Legend text, shared by the mapper and its summary line. */
export const SOURCE_LABEL: Record<SourceStatus, string> = {
  auto: 'Matched automatically',
  manual: 'Matched by hand',
  merged: 'Merged into the bone below it',
  dropped: 'Not animated (your choice)',
  lost: 'Animated, but its motion is lost',
  static: 'No clip animates it',
}
export const TARGET_LABEL: Record<TargetStatus, string> = {
  driven: 'Driven by one bone',
  merged: 'Driven by several bones, combined',
  shared: 'Shares the bend of the bone below',
  rest: 'Holds its rest pose',
}
