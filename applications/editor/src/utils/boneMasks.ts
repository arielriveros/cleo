// BONE MASK assets: which bones a controller layer or action slot affects, and how strongly — Unity's
// Avatar Mask, Unreal's per-bone layered blend.
//
// A mask is a SUBSET OF A SKELETON, so it names its rig and stores weights by bone NAME, like a socket
// or a retarget correction: a name backfill or a re-export cannot repoint it. Being an asset rather than
// rig data is what lets "Upper Body" be picked by name in any layer of any controller on that rig.
//
// The editor works in BRANCHES (tick Spine and everything above the hips follows) but the stored form
// is flat per-bone weights, so the runtime is one lookup per bone.
//
// Must stay engine-free so it is unit-testable without a GL context.

import { cryptoRandomId } from './ids'

export type BoneMaskAsset = {
  id: string
  name: string
  rigId?: string
  /** Bone name -> weight 0..1. A bone not listed is 0. */
  weights: Record<string, number>
  thumbnail?: string
}

export function buildBoneMaskAsset(name: string, rigId?: string, weights: Record<string, number> = {}, id?: string): BoneMaskAsset {
  return { id: id ?? cryptoRandomId(), name, ...(rigId ? { rigId } : {}), weights: { ...weights } }
}

/** A skeleton as names and parent links — the only shape the branch helpers need. */
export type BoneTree = { name: string; parent: string | null }[]

/** `bone` and every bone below it. */
export function branchOf(tree: BoneTree, bone: string): string[] {
  const children = new Map<string, string[]>()
  for (const b of tree) {
    if (b.parent === null) continue
    const list = children.get(b.parent)
    if (list) list.push(b.name); else children.set(b.parent, [b.name])
  }
  const out: string[] = []
  const stack = [bone]
  while (stack.length) {
    const n = stack.pop()!
    out.push(n)
    stack.push(...(children.get(n) ?? []))
  }
  return out
}

/** Set a whole branch to `weight` (0 removes it). Returns new weights. */
export function withBranch(weights: Record<string, number>, tree: BoneTree, bone: string, weight: number): Record<string, number> {
  const next = { ...weights }
  for (const name of branchOf(tree, bone)) {
    if (weight > 0) next[name] = Math.min(1, weight)
    else delete next[name]
  }
  return next
}

/** Find the first bone whose name contains one of `hints` (case-insensitive), nearest the root. */
export function findBone(tree: BoneTree, hints: string[]): string | null {
  const lower = hints.map(h => h.toLowerCase())
  for (const b of tree) {
    const n = b.name.toLowerCase()
    if (lower.some(h => n.includes(h))) return b.name
  }
  return null
}

/**
 * Starting points for the common masks, found by bone NAME so they work on Mixamo, UE mannequin and
 * Blender rigs alike. Null when the skeleton has nothing that looks like the part.
 */
export function presetMask(tree: BoneTree, preset: 'upperBody' | 'lowerBody' | 'leftArm' | 'rightArm' | 'head'): Record<string, number> | null {
  const pick = (hints: string[]) => findBone(tree, hints)
  let roots: (string | null)[]
  switch (preset) {
    case 'upperBody': roots = [pick(['spine'])]; break
    case 'lowerBody': roots = [pick(['leftupleg', 'l_thigh', 'thigh_l', 'upperleg_l', 'left_thigh', 'lthigh']), pick(['rightupleg', 'r_thigh', 'thigh_r', 'upperleg_r', 'right_thigh', 'rthigh'])]; break
    case 'leftArm': roots = [pick(['leftshoulder', 'l_clavicle', 'clavicle_l', 'leftarm', 'upperarm_l'])]; break
    case 'rightArm': roots = [pick(['rightshoulder', 'r_clavicle', 'clavicle_r', 'rightarm', 'upperarm_r'])]; break
    case 'head': roots = [pick(['neck', 'head'])]; break
  }
  const found = roots.filter((r): r is string => !!r)
  if (!found.length) return null
  let weights: Record<string, number> = {}
  for (const r of found) weights = withBranch(weights, tree, r, 1)
  return weights
}
