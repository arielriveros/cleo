import { humanoidRigOf, skeletonTopology, isAncestorJoint, nearestCommonAncestor, validateIkRig } from 'cleo'
import type { IkRig, IkFootChain, Skin } from 'cleo'

// Foot placement guessed from bone NAMES — the Skeleton panel's "auto-fill" and the Animate wizard both
// use this, so the two can never disagree about which bones are a leg.

/** The humanoid slots each leg role maps to. Index 0 is the left leg, 1 the right. */
const SLOTS = {
  thigh: ['upLeg.L', 'upLeg.R'],
  shin: ['leg.L', 'leg.R'],
  foot: ['foot.L', 'foot.R'],
  toe: ['toe.L', 'toe.R'],
} as const

export type FootPlacementGuess = {
  /** The validated rig, or null when no leg could be identified. */
  rig: IkRig | null
  /** What was skipped and why, for a report line. */
  notes: string[]
}

/**
 * Both legs from the bone names, where recognizable, validated against the skeleton. `base` carries any
 * tuning already set (it is kept; only hips and feet are replaced).
 */
export function guessFootPlacement(skin: Skin, base: IkRig = { feet: [] }, labelOf?: (node: number) => string): FootPlacementGuess {
  // Must be the engine's own matcher: a private copy drifts from what retargeting believes about the
  // same skeleton.
  const bySlot = humanoidRigOf(skin)
  const topo = skeletonTopology(skin)

  const feet: IkFootChain[] = []
  const notes: string[] = []
  for (const [side, label] of [[0, 'left'], [1, 'right']] as const) {
    const thigh = bySlot.get(SLOTS.thigh[side])
    const shin = bySlot.get(SLOTS.shin[side])
    const foot = bySlot.get(SLOTS.foot[side])
    const missing = [['thigh', thigh], ['shin', shin], ['foot', foot]]
      .filter(([, v]) => v === undefined).map(([k]) => k)
    if (missing.length) { notes.push(`no ${label} ${missing.join('/')} found by name`); continue }
    const toe = bySlot.get(SLOTS.toe[side])
    feet.push(toe !== undefined ? { thigh: thigh!, shin: shin!, foot: foot!, toe } : { thigh: thigh!, shin: shin!, foot: foot! })
  }
  if (feet.length === 0) return { rig: null, notes }

  // The pelvis is the nearest common ancestor of the two thighs, by construction. Ask the hierarchy, never
  // the name: `root`/`cog` are synonyms for `hips` and a root-motion bone is usually joint 0.
  const thighJoints = feet.map(f => topo.jointOfNode.get(f.thigh) ?? -1).filter(j => j >= 0)
  const ncaJoint = thighJoints.length > 1 ? nearestCommonAncestor(topo, thighJoints) : -1
  const hips = ncaJoint >= 0 ? skin.joints[ncaJoint].nodeIndex : bySlot.get('hips') ?? base.hips

  const label = labelOf ?? ((n: number) => skin.nodeNames?.get(n) ?? `node ${n}`)
  const check = validateIkRig({ ...base, hips, feet }, topo, isAncestorJoint, label)
  notes.push(...check.problems.map(p => p.message))
  if (check.feet.length === 0) return { rig: null, notes }
  return { rig: { ...base, feet: check.feet, hips: check.hips }, notes }
}
