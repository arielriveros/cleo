import { resamplePlane, weightPlanesToAlphaPlanes, type WorldManifestLayer } from 'cleo/terrain/splatmapIO'
import type { TerrainBlendRule } from 'cleo/terrain/terrainLayers'

// Import world, as data: which world layer lands on which slot of the landscape material, and the mask
// each of those slots gets. No React, no engine objects -- only the shader-free terrain modules -- so the
// arithmetic that decides what a landscape looks like after an import is tested on its own.
//
// A world export says WHERE each surface is, as normalized weights (each texel's layers sum to one). The
// landscape composites its slots front to back, "over", in the landscape material's slot order. So the
// import merges the world's layers into the slots they were mapped to, turns the merged weights into
// over-alphas in THAT order -- the material's, not the world's -- and writes one alpha mask per mapped
// paint-only slot. The Ground is the bottom of the stack and takes whatever no slot was given.

/** The Ground: the landscape material's own surface, under every slot. Takes all unmapped weight. */
export const GROUND = 'ground'

/** Where one world layer goes: a paint-only slot (by id), the Ground, or nowhere (`null`: ignored). */
export type LayerTarget = string | null

/**
 * World layer id -> target. An ignored layer, a missing key, or a slot that no longer exists or is no
 * longer paint-only all fold into the Ground: normalized weights must still sum to one, and the Ground
 * is the surface that shows where nothing else does.
 */
export type WorldMapping = Record<string, LayerTarget>

/** Applied to the heights AND the weight planes alike (HeightImportOptions' flips and clockwise turn). */
export interface WorldOrientation {
  flipX: boolean
  flipY: boolean
  rotate: 0 | 90 | 180 | 270
}

export const DEFAULT_ORIENTATION: WorldOrientation = { flipX: false, flipY: false, rotate: 0 }

/** The slice of a landscape-material slot the planner reads. */
export interface ImportSlot {
  id: string
  /** As shown (slotDisplayName). */
  name: string
  manual: boolean
  rule: TerrainBlendRule
}

/** What a world layer carries that the planner reads (a manifest layer). */
export type ImportLayer = Pick<WorldManifestLayer, 'id' | 'name' | 'index' | 'kind'>

// --- orientation & merging ------------------------------------------------------------------------

/**
 * A square texel-centred plane turned and flipped exactly as `heightsFromImage` turns a heightmap: the
 * sampling point is rotated counter-clockwise (which turns the image clockwise on the ground), then
 * flipped. On a texel-centred grid `1 - u` is texel `res - 1 - c`, so this is an exact permutation.
 */
export function orientPlane(src: Uint8Array, res: number, o: WorldOrientation): Uint8Array {
  if (!o.flipX && !o.flipY && !o.rotate) return src
  const out = new Uint8Array(res * res)
  const last = res - 1
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      let x = c, y = r
      switch (o.rotate) {
        case 90: [x, y] = [y, last - x]; break
        case 180: [x, y] = [last - x, last - y]; break
        case 270: [x, y] = [last - y, x]; break
      }
      if (o.flipX) x = last - x
      if (o.flipY) y = last - y
      out[r * res + c] = src[y * res + x]
    }
  }
  return out
}

/** The slot a layer's weight lands on: its mapped slot when that is a paint-only slot here, else the Ground. */
export function resolveTarget(target: LayerTarget | undefined, slots: readonly ImportSlot[]): string {
  if (!target || target === GROUND) return GROUND
  return slots.some(s => s.id === target && s.manual) ? target : GROUND
}

/** The paint-only slots that receive weight, in the landscape material's slot order. */
export function mappedSlots(layers: readonly ImportLayer[], slots: readonly ImportSlot[], mapping: WorldMapping): string[] {
  const used = new Set(layers.map(l => resolveTarget(mapping[l.id], slots)))
  return slots.filter(s => used.has(s.id)).map(s => s.id)
}

/**
 * Sum each layer's weight plane into its target's (`targets[0]` is the Ground). Several layers on one
 * slot add up; a byte sum past 255 (a tool that does not quantize to exactly 255) is clamped, which only
 * happens where that target holds all of it.
 */
export function mergeWeights(layers: readonly ImportLayer[], planes: readonly Uint8Array[], texels: number,
                             slots: readonly ImportSlot[], mapping: WorldMapping, targets: readonly string[]): Uint8Array[] {
  const index = new Map(targets.map((id, i) => [id, i]))
  const sums = targets.map(() => new Uint16Array(texels))
  layers.forEach((l, i) => {
    const plane = planes[i]
    if (!plane) return
    const sum = sums[index.get(resolveTarget(mapping[l.id], slots)) ?? 0]
    for (let t = 0; t < texels; t++) sum[t] += plane[t]
  })
  return sums.map(s => {
    const out = new Uint8Array(texels)
    for (let t = 0; t < texels; t++) out[t] = s[t] > 255 ? 255 : s[t]
    return out
  })
}

export interface WorldImportInput {
  /** The world's layers, bottom to top (the manifest's order), and their weight planes in that order. */
  layers: readonly ImportLayer[]
  planes: readonly Uint8Array[]
  /** Texels per side of every plane. */
  size: number
  /** The landscape material's slots 1..n, in slot order (the Ground is not one of them). */
  slots: readonly ImportSlot[]
  mapping: WorldMapping
  orientation: WorldOrientation
  /** The landscape's paint-mask resolution: the planes come out at this size. */
  maskResolution: number
}

export interface WorldImportPlan {
  resolution: number
  /** One alpha mask per mapped paint-only slot, in slot order, `resolution`² bytes each. */
  channels: { slotId: string; alpha: Uint8Array }[]
}

/**
 * The masks an import writes. Merge per target, orient, resample to the mask resolution, then convert
 * the weights to over-alphas in the material's slot order, the Ground first. Undefined alphas (a slot
 * whose texel nothing below it shows through) are filled from their neighbours by the engine, so linear
 * mask filtering never shows a third surface in a one-texel fringe along a boundary.
 */
export function planWorldImport(input: WorldImportInput): WorldImportPlan {
  const { layers, planes, size, slots, mapping, orientation, maskResolution } = input
  const targets = mappedSlots(layers, slots, mapping)
  const merged = mergeWeights(layers, planes, size * size, slots, mapping, [GROUND, ...targets])
  const prepared = merged.map(p => resamplePlane(orientPlane(p, size, orientation), size, maskResolution))
  const alphas = weightPlanesToAlphaPlanes(prepared, maskResolution, maskResolution)
  return { resolution: maskResolution, channels: targets.map((slotId, i) => ({ slotId, alpha: alphas[i + 1] })) }
}

// --- the default mapping --------------------------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase()

/**
 * A starting mapping: a slot with the layer's name (any case) first; then the base layer onto the Ground;
 * then the layer's kind hint ("sand", "forest") found in a slot's name. Each slot is offered once, so two
 * layers never land on one slot unless the user puts them there. Anything left is ignored -- which is
 * what "Add missing slots" makes slots for.
 */
export function defaultMapping(layers: readonly ImportLayer[], slots: readonly ImportSlot[]): WorldMapping {
  const manual = slots.filter(s => s.manual)
  const claimed = new Set<string>()
  const out: WorldMapping = {}
  const claim = (layer: ImportLayer, pick: (s: ImportSlot) => boolean) => {
    const slot = manual.find(s => !claimed.has(s.id) && pick(s))
    if (!slot) return false
    out[layer.id] = slot.id
    claimed.add(slot.id)
    return true
  }
  for (const l of layers) claim(l, s => norm(s.name) === norm(l.name))
  const base = layers.reduce<ImportLayer | null>((b, l) => (!b || l.index < b.index ? l : b), null)
  for (const l of layers) {
    if (l.id in out) continue
    if (l === base) { out[l.id] = GROUND; continue }
    const kind = l.kind ? norm(l.kind) : ''
    if (!kind || !claim(l, s => norm(s.name).includes(kind))) out[l.id] = null
  }
  return out
}

/** The layers "Add missing slots" makes paint-only slots for (the ignored ones, bottom to top), within `room`. */
export function missingSlotLayers<L extends ImportLayer>(layers: readonly L[], mapping: WorldMapping, room: number): { add: L[]; overflow: L[] } {
  const missing = layers.filter(l => !mapping[l.id])
  const n = Math.max(0, Math.min(room, missing.length))
  return { add: missing.slice(0, n), overflow: missing.slice(n) }
}

/** Kinds whose slot lets foliage grow (a new slot otherwise starts with it off, as a road would). */
export function kindAllowsFoliage(kind: string | undefined): boolean {
  return kind === 'grass' || kind === 'forest'
}

// --- rule warnings --------------------------------------------------------------------------------

export interface RuleWarning {
  slotId: string
  name: string
  /**
   * `above`: an automatic slot composites over imported surfaces by its own rule.
   * `rule`: a mapped slot's own rule limits or reshapes where the import puts it.
   */
  kind: 'above' | 'rule'
  /** For `rule`: which fields ("elevation", "noise"...). For `above`: the surfaces it covers. */
  detail: string[]
}

/** The fields of a rule that change where a mapped slot shows (empty when it passes the mask through). */
export function ruleDeviations(rule: TerrainBlendRule): string[] {
  const out: string[] = []
  if (rule.elevation.enabled) out.push('elevation')
  if (rule.slope.enabled) out.push('slope')
  if (rule.noise.amount > 0) out.push('noise')
  if (rule.opacity < 1) out.push('opacity')
  if (rule.heightBlend > 0) out.push('height blend')
  return out
}

/**
 * What would keep the landscape from matching the world after the import:
 *  - an AUTOMATIC slot (not paint-only) above any surface that receives weight: it blends in by its own
 *    rule on top of the imported ones, wherever that rule says (the Ground counts when it takes weight);
 *  - a MAPPED slot whose rule restricts or reshapes its mask (see {@link ruleDeviations}).
 */
export function ruleWarnings(layers: readonly ImportLayer[], slots: readonly ImportSlot[], mapping: WorldMapping): RuleWarning[] {
  const targets = new Set(layers.map(l => resolveTarget(mapping[l.id], slots)))
  const warnings: RuleWarning[] = []
  const below: string[] = targets.has(GROUND) ? ['Ground'] : []
  for (const s of slots) {
    if (targets.has(s.id)) {
      const fields = ruleDeviations(s.rule)
      if (fields.length) warnings.push({ slotId: s.id, name: s.name, kind: 'rule', detail: fields })
      below.push(s.name)
    } else if (!s.manual && s.rule.opacity > 0 && below.length) {
      warnings.push({ slotId: s.id, name: s.name, kind: 'above', detail: [...below] })
    }
  }
  return warnings
}

/**
 * A mapped slot's rule with everything that reshapes its mask switched off: both range tests, noise,
 * height blend, and opacity back to full. The ranges' numbers are kept, so turning a test back on in the
 * landscape material restores what was authored.
 */
export function neutralRule(rule: TerrainBlendRule): TerrainBlendRule {
  return {
    elevation: { ...rule.elevation, enabled: false },
    slope: { ...rule.slope, enabled: false },
    noise: { ...rule.noise, amount: 0 },
    heightBlend: 0,
    opacity: 1,
  }
}

// --- the landscape's memory of the world: the `__creatorWorld` variable ---------------------------

/** On a landscape: the Creator world it was imported from, and how, so a change offers a re-apply. */
export const CREATOR_WORLD_VAR = '__creatorWorld'

export interface CreatorWorldLink {
  /** The Creator library asset. */
  id: string
  /** Its revision at the import. */
  revision: number
  /** The manifest's `exportHash` at the import: what the re-apply prompt compares, when both have one. */
  exportHash?: string
  /** Absent for a heights-only import (the old `<id>@<revision>` form): nothing to re-apply in one click. */
  mapping?: WorldMapping
  orientation?: WorldOrientation
  /** Whether the import rebuilt the landscape to the world's size. */
  matchSize?: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseOrientation(v: unknown): WorldOrientation | undefined {
  if (!isObj(v)) return undefined
  const rotate = [0, 90, 180, 270].includes(v.rotate as number) ? v.rotate as WorldOrientation['rotate'] : 0
  return { flipX: v.flipX === true, flipY: v.flipY === true, rotate }
}

/**
 * Read the variable: the JSON this importer writes, or the `<id>@<revision>` string a heightmap-only
 * Creator import wrote before it. Null for anything else.
 */
export function parseCreatorWorldLink(value: unknown): CreatorWorldLink | null {
  if (typeof value !== 'string' || !value) return null
  if (value.trimStart().startsWith('{')) {
    let json: unknown
    try { json = JSON.parse(value) } catch { return null }
    if (!isObj(json) || typeof json.id !== 'string' || !json.id || typeof json.revision !== 'number' || !Number.isFinite(json.revision)) return null
    const link: CreatorWorldLink = { id: json.id, revision: json.revision }
    if (typeof json.exportHash === 'string' && json.exportHash) link.exportHash = json.exportHash
    if (isObj(json.mapping)) {
      link.mapping = {}
      for (const [k, v] of Object.entries(json.mapping)) if (typeof v === 'string' || v === null) link.mapping[k] = v
    }
    const orientation = parseOrientation(json.orientation)
    if (orientation) link.orientation = orientation
    if (typeof json.matchSize === 'boolean') link.matchSize = json.matchSize
    return link
  }
  const m = /^(.+)@(\d+)$/.exec(value)
  return m ? { id: m[1], revision: Number(m[2]) } : null
}

export function serializeCreatorWorldLink(link: CreatorWorldLink): string {
  return JSON.stringify({
    id: link.id, revision: link.revision,
    ...(link.exportHash ? { exportHash: link.exportHash } : {}),
    ...(link.mapping ? { mapping: link.mapping } : {}),
    ...(link.orientation ? { orientation: link.orientation } : {}),
    ...(link.matchSize !== undefined ? { matchSize: link.matchSize } : {}),
  })
}

/**
 * Whether the library's world is newer than what the landscape holds. By `exportHash` when both sides
 * have one -- a preview-only edit in the Creator (a tint, the water look) bumps the revision and changes
 * no exported file -- otherwise by revision.
 */
export function worldChanged(link: CreatorWorldLink, world: { id: string; revision: number; exportHash?: string }): boolean {
  if (world.id !== link.id) return false
  if (link.exportHash && world.exportHash) return link.exportHash !== world.exportHash
  return world.revision > link.revision
}

/**
 * The mapping a re-apply uses: the stored one, with any layer the world gained since given its default
 * (a name match, or ignored).
 */
export function reapplyMapping(stored: WorldMapping, layers: readonly ImportLayer[], slots: readonly ImportSlot[]): WorldMapping {
  const fresh = defaultMapping(layers, slots)
  const out: WorldMapping = {}
  for (const l of layers) out[l.id] = l.id in stored ? stored[l.id] : fresh[l.id]
  return out
}
