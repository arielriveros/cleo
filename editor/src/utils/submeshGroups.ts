// How an imported file's sub-meshes are partitioned into model assets — the data behind the import
// modal's "Groups" editor, kept pure (no React, no engine, no GL) so it is directly testable.
//
// One group becomes one ModelAsset whose members are merged into a single mesh (see groupSubModels in
// ./models). The two older import options are the degenerate cases of this: one group per part is
// "Separate sub-models", a single group holding everything is "Merge sub-meshes".

/** One sub-mesh as the review modal sees it, before anything is committed to the library. */
export type PartInfo = {
  name: string
  /** Index of the part's material among the bundle's DISTINCT materials — the seed for the default split. */
  materialIndex: number
}

/** A set of sub-meshes destined for one model asset. `parts` are indices into the parsed children array. */
export type PartGroup = {
  name: string
  parts: number[]
}

/** `base_1`, `base_2`, … skipping any suffix already taken. Group names become ASSET names, so they matter. */
function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * The default split: one group per distinct material, parts in file order.
 *
 * Material is the right default because the split being undone here is usually an artefact of the FILE
 * FORMAT (glTF mandates one primitive per material), and because a group of parts sharing one material
 * is always mergeable — mergeBlocker rejects mixed material types and mixed opaque/transparent, and
 * neither can occur inside a group built this way.
 */
export function defaultGroupsByMaterial(parts: PartInfo[], bundleName: string): PartGroup[] {
  const byMaterial = new Map<number, number[]>()
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i].materialIndex
    const list = byMaterial.get(key)
    if (list) list.push(i)
    else byMaterial.set(key, [i])
  }

  const names: string[] = []
  return [...byMaterial.values()].map((members, i) => {
    // A single-part group is named after the part itself; a merged one after the bundle, since no one
    // member's name describes the whole.
    const base = members.length === 1
      ? (parts[members[0]].name?.trim() || `${bundleName}_${i + 1}`)
      : `${bundleName}_${i + 1}`
    const name = uniqueName(base, names)
    names.push(name)
    return { name, parts: members }
  })
}

/** Every part in its own group — the "Separate sub-models" split, expressed as groups. */
export function groupsPerPart(parts: PartInfo[], bundleName: string): PartGroup[] {
  const names: string[] = []
  return parts.map((p, i) => {
    const name = uniqueName(p.name?.trim() || `${bundleName}_${i + 1}`, names)
    names.push(name)
    return { name, parts: [i] }
  })
}

/**
 * Move `part` into the group at `toGroup`, appended in ascending part order so a group's members stay in
 * file order however they were dragged (merged geometry is concatenated in that order).
 *
 * A group left empty by the move is dropped: an empty column would produce an asset with no mesh, and
 * carrying "no parts here" state through to the import is worse than the column simply disappearing.
 */
export function movePart(groups: PartGroup[], part: number, toGroup: number): PartGroup[] {
  if (toGroup < 0 || toGroup >= groups.length) return groups
  if (groups[toGroup].parts.includes(part)) return groups

  return groups
    .map((g, i) => {
      if (i === toGroup) return { ...g, parts: [...g.parts, part].sort((a, b) => a - b) }
      if (!g.parts.includes(part)) return g
      return { ...g, parts: g.parts.filter(p => p !== part) }
    })
    .filter((g, i) => i === toGroup || g.parts.length > 0)
}

/** Append an empty group. It only survives to the import if the user drags something into it. */
export function addGroup(groups: PartGroup[], bundleName: string): PartGroup[] {
  const name = uniqueName(`${bundleName}_${groups.length + 1}`, groups.map(g => g.name))
  return [...groups, { name, parts: [] }]
}

/**
 * Delete a group, moving its parts to the group before it (or after it, for the first one) so no part is
 * ever orphaned. Deleting the only group is refused — there would be nowhere for its parts to go.
 */
export function removeGroup(groups: PartGroup[], index: number): PartGroup[] {
  if (groups.length < 2 || index < 0 || index >= groups.length) return groups
  const fallback = index === 0 ? 1 : index - 1
  const orphans = groups[index].parts
  return groups
    .map((g, i) => (i === fallback ? { ...g, parts: [...g.parts, ...orphans].sort((a, b) => a - b) } : g))
    .filter((_, i) => i !== index)
}

export function renameGroup(groups: PartGroup[], index: number, name: string): PartGroup[] {
  return groups.map((g, i) => (i === index ? { ...g, name } : g))
}

/** Drop the empty groups an editing session can leave behind. Called on accept, never mid-edit. */
export function compactGroups(groups: PartGroup[]): PartGroup[] {
  return groups.filter(g => g.parts.length > 0)
}

/**
 * True when `groups` is a usable partition of `partCount` sub-meshes: every part in exactly one group,
 * no index out of range. The import re-checks this because the missing-texture re-parse rebuilds the
 * children array after the modal closed — a grouping made against the old one must not be applied.
 */
export function isValidGrouping(groups: PartGroup[], partCount: number): boolean {
  const seen = new Set<number>()
  for (const g of groups) {
    for (const p of g.parts) {
      if (!Number.isInteger(p) || p < 0 || p >= partCount || seen.has(p)) return false
      seen.add(p)
    }
  }
  return seen.size === partCount
}

/** Which group each part is in, indexed by part. -1 for a part no group claims. */
export function groupOfPart(groups: PartGroup[], partCount: number): number[] {
  const out = new Array<number>(partCount).fill(-1)
  groups.forEach((g, i) => { for (const p of g.parts) if (p >= 0 && p < partCount) out[p] = i })
  return out
}
