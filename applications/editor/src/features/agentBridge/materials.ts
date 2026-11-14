import { Material } from 'cleo'
import { buildMaterialAsset, type MaterialAsset } from '../../utils/materials'
import { renderMaterialAssetThumbnail } from '../../utils/modelThumbnails'
import type { TextureAsset } from '../../utils/textureAssets'
import { byName, notFound, type BridgeHost, type GetHost } from './bridgeHost'
import { nearestNames, round, simpleValue } from './inspect'

// Materials as the agent writes them: a spec (a shading model, colours, texture slots by texture NAME, any
// other property) applied to the asset's SERIALIZED form and read back through Material.parse, so exactly
// what the material editor would store is stored, whatever the shading model. A property that does not
// survive the round trip was never part of that model, and the agent is told so instead of being ignored.

export type { MaterialAsset }

/** The shading models the agent can ask for. */
export type MaterialKind = 'pbr' | 'cel' | 'foliage' | 'unlit'

export interface MaterialSpec {
  name?: string
  type?: MaterialKind
  baseColor?: number[]
  metallic?: number
  roughness?: number
  emissive?: number[]
  emissiveIntensity?: number
  opacity?: number
  transparent?: boolean
  /** Slot -> texture asset name; null clears the slot. */
  textures?: Record<string, string | null>
  props?: Record<string, unknown>
}

/**
 * Materials written during this call, by lowercased name. The library is React state: what a call adds is
 * not in `h.engine.materials` until the call is over, so a second op naming it would otherwise make another.
 */
export type MadeMaterials = Map<string, MaterialAsset>

/** What a serialized material is, by the names the tools use: pbr, foliage, cel, unlit, or its own type. */
export function materialKind(json: any): string {
  switch (json?.type) {
    case 'pbr': return 'pbr'
    case 'foliage': return 'foliage'
    case 'cel': return 'cel'
    case 'basic': return 'unlit'
    default: return String(json?.type ?? 'unknown')
  }
}

function freshJson(kind: MaterialKind): any {
  switch (kind) {
    case 'pbr': return Material.PBR().serialize()
    case 'foliage': return Material.Foliage().serialize()
    case 'cel': return Material.Cel().serialize()
    case 'unlit': return Material.Basic({}).serialize()
  }
}

/** Where a spec's colour goes in each serialized shading model. */
const COLOR_KEY: Record<string, string> = { pbr: 'baseColor', foliage: 'baseColor', cel: 'diffuse', blinn_phong: 'diffuse', basic: 'color' }
const EMISSIVE_KEY: Record<string, string> = { pbr: 'emissiveFactor', foliage: 'emissiveFactor', cel: 'emissive', blinn_phong: 'emissive' }
const HAS_PBR = new Set(['pbr', 'foliage'])

/** Texture slots by the names the tools use -> the serialized `textures` keys they fill, per model. */
const PBR_SLOTS: Record<string, string[]> = {
  baseColor: ['baseColorTexture'], normal: ['normalMap'], metallic: ['metallicMap'], roughness: ['roughnessMap'],
  metallicRoughness: ['metallicMap', 'roughnessMap'], occlusion: ['occlusionMap'], emissive: ['emissiveMap'],
  displacement: ['displacementMap'], mask: ['mask'],
}
const TEXTURE_SLOTS: Record<string, Record<string, string[]>> = {
  pbr: PBR_SLOTS,
  foliage: PBR_SLOTS,
  cel: { base: ['base'], ramp: ['ramp'], normal: ['normal'], emissive: ['emissive'], mask: ['mask'], displacement: ['displacementMap'] },
  blinn_phong: { base: ['base'], specular: ['specular'], normal: ['normal'], emissive: ['emissive'], mask: ['mask'], displacement: ['displacementMap'] },
  basic: { base: ['texture'], mask: ['mask'], displacement: ['displacementMap'] },
}
/** The other models' word for a slot: "baseColor" on a cel or unlit material is its base. */
const SLOT_ALIASES: Record<string, string> = { baseColor: 'base', texture: 'base', color: 'base' }

/** Keys of a serialized material that are structure, not properties. */
const NOT_PROPS = new Set(['type', 'textures', 'config', 'name'])

const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.every(x => typeof x === 'number' && Number.isFinite(x))

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a))
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  return a === b
}

/** The properties a serialized material carries, flat: what `props` names and material_write reports. */
export function materialProps(json: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(json ?? {})) {
    if (NOT_PROPS.has(k)) continue
    const s = simpleValue(v)
    if (s !== undefined && s !== null) out[k] = s
  }
  for (const [k, v] of Object.entries(json?.config ?? {})) {
    const s = simpleValue(v)
    if (s !== undefined && s !== null) out[`config.${k}`] = s
  }
  return out
}

/** The material's texture slots by the tools' names, each as its texture asset's name. */
export function materialTextures(json: any, textures: readonly TextureAsset[]): Record<string, string> {
  const slots = TEXTURE_SLOTS[json?.type] ?? {}
  const t = json?.textures ?? {}
  const nameOf = (id: string) => textures.find(x => x.id === id)?.name ?? id
  const out: Record<string, string> = {}
  for (const [slot, keys] of Object.entries(slots)) {
    if (slot === 'metallicRoughness') continue
    const id = t[keys[0]]
    if (typeof id === 'string' && id) out[slot] = nameOf(id)
  }
  // One packed map in both slots reads back as the packed slot.
  if (out.metallic && out.metallic === out.roughness && HAS_PBR.has(json?.type)) {
    out.metallicRoughness = out.metallic
    delete out.metallic
    delete out.roughness
  }
  return out
}

/** A material as node_get and material_write show it: model, properties, textures by name. */
export function describeMaterial(asset: MaterialAsset, textures: readonly TextureAsset[]): Record<string, unknown> {
  const tex = materialTextures(asset.material, textures)
  return {
    name: asset.name,
    type: materialKind(asset.material),
    ...materialProps(asset.material),
    ...(Object.keys(tex).length ? { textures: tex } : {}),
  }
}

/** Set `path` ("bands", "config.side") in a serialized material, keeping the value's kind. */
function setJsonProp(json: any, path: string, value: unknown, kind: string) {
  const parts = path.split('.')
  if (NOT_PROPS.has(parts[0]) && parts[0] !== 'config')
    throw new Error(`"${path}" is not set through props: use type, textures or the colour fields.`)
  let target = json
  for (const part of parts.slice(0, -1)) {
    if (target[part] === undefined) target[part] = {}
    if (typeof target[part] !== 'object' || target[part] === null) throw new Error(`"${path}": "${part}" is not an object on a ${kind} material.`)
    target = target[part]
  }
  const key = parts[parts.length - 1]
  const current = target[key]
  if (current !== undefined && current !== null) {
    if (typeof current === 'number' && typeof value !== 'number') throw new Error(`"${path}" is a number; got ${JSON.stringify(value)}.`)
    if (typeof current === 'boolean' && typeof value !== 'boolean') throw new Error(`"${path}" is a boolean; got ${JSON.stringify(value)}.`)
    if (typeof current === 'string' && typeof value !== 'string') throw new Error(`"${path}" is a string; got ${JSON.stringify(value)}.`)
    if (isNumbers(current) && (!isNumbers(value) || value.length !== current.length))
      throw new Error(`"${path}" is a vector of ${current.length} numbers; got ${JSON.stringify(value)}.`)
  }
  target[key] = Array.isArray(value) ? [...value] : value
}

const getPath = (json: any, path: string) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), json)

/**
 * `spec` applied to a serialized material, in place. Textures are looked up by name in `textures`. Throws,
 * naming what the model does take, for a field it has no place for.
 */
export function applySpec(json: any, spec: MaterialSpec, textures: readonly TextureAsset[]): void {
  const t = String(json.type)
  const kind = materialKind(json)
  const lacks = (field: string, hint = '') => new Error(`A ${kind} material has no ${field}.${hint}`)
  if (spec.baseColor) {
    if (!COLOR_KEY[t]) throw lacks('colour')
    json[COLOR_KEY[t]] = [...spec.baseColor]
  }
  for (const f of ['metallic', 'roughness'] as const) {
    if (spec[f] === undefined) continue
    if (!HAS_PBR.has(t)) throw lacks(f, t === 'cel' ? ' Its highlight is props shininess and specularThreshold.' : '')
    json[f] = spec[f]
  }
  if (spec.emissive) {
    if (!EMISSIVE_KEY[t]) throw lacks('emission')
    json[EMISSIVE_KEY[t]] = [...spec.emissive]
  }
  if (spec.emissiveIntensity !== undefined) {
    if (!('emissiveIntensity' in json)) throw lacks('emissiveIntensity')
    json.emissiveIntensity = spec.emissiveIntensity
  }
  if (spec.opacity !== undefined) json.opacity = spec.opacity
  if (spec.transparent !== undefined) json.config = { ...(json.config ?? {}), transparent: spec.transparent }
  if (spec.textures) {
    const slots = TEXTURE_SLOTS[t]
    if (!slots) throw lacks('texture slots the agent can set')
    json.textures = { ...(json.textures ?? {}) }
    for (const [name, texName] of Object.entries(spec.textures)) {
      const keys = slots[name] ?? slots[SLOT_ALIASES[name] ?? '']
      if (!keys) throw new Error(`A ${kind} material has no texture slot "${name}". Slots: ${Object.keys(slots).join(', ')}.`)
      let id: string | undefined
      if (texName !== null) {
        const tex = byName(textures, texName)
        if (!tex) throw notFound('texture', texName, textures)
        id = tex.id
      }
      for (const k of keys) json.textures[k] = id
    }
  }
  for (const [path, value] of Object.entries(spec.props ?? {})) setJsonProp(json, path, value, kind)
}

/**
 * The material `json` describes, checked: every `props` value must come back from Material.parse and
 * serialize unchanged, or the model does not have that property (or clamps it) and the agent hears which.
 */
export function buildChecked(json: any, spec: MaterialSpec): { material: Material; stored: any } {
  const material = Material.parse(json)
  const stored = material.serialize()
  for (const [path, value] of Object.entries(spec.props ?? {})) {
    const got = getPath(stored, path)
    if (sameValue(got, value)) continue
    const known = Object.keys(materialProps(stored))
    if (got === undefined) {
      const near = nearestNames(path, known)
      throw new Error(`"${path}" is not a property of a ${materialKind(stored)} material.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} Its properties: ${known.join(', ')}.`)
    }
    throw new Error(`"${path}" was stored as ${JSON.stringify(simpleValue(got) ?? got)}, not ${JSON.stringify(value)}: it is clamped or derived.`)
  }
  return { material, stored }
}

export function findMaterial(h: BridgeHost, name: string, made?: MadeMaterials): MaterialAsset | undefined {
  return made?.get(name.toLowerCase()) ?? byName(h.engine.materials, name)
}

export function uniqueMaterialName(h: BridgeHost, base: string, made?: MadeMaterials): string {
  let name = base
  for (let i = 2; findMaterial(h, name, made); i++) name = `${base} ${i}`
  return name
}

/**
 * Create or update the material asset `name` (by name, case-insensitive) from `spec`, and push the change
 * everywhere the material is used. With `label`, it is an undo entry of the open transaction, under the
 * call's node changes (pushFirst): undone after them, redone before them. Its thumbnail follows later.
 */
export function upsertMaterial(h: BridgeHost, getHost: GetHost, name: string, spec: MaterialSpec, opts: { made?: MadeMaterials; label?: string } = {}): { asset: MaterialAsset; created: boolean; retyped: boolean } {
  const existing = findMaterial(h, name, opts.made)
  const existingKind = existing ? materialKind(existing.material) : null
  if (existing && !['pbr', 'foliage', 'cel', 'unlit'].includes(existingKind!) && !spec.type)
    throw new Error(`"${existing.name}" is a ${existingKind} material, which the agent cannot edit property by property. `
      + 'Pass type to replace it with a pbr, cel, foliage or unlit one, or edit it in its material tab.')
  const retyped = !!existing && !!spec.type && spec.type !== existingKind
  let json: any
  if (existing && !retyped) json = JSON.parse(JSON.stringify(existing.material))
  else {
    json = freshJson(spec.type ?? 'pbr')
    // A change of model keeps the colour, so "make it toon" does not also make it white.
    const oldColor = existing ? existing.material?.[COLOR_KEY[existing.material?.type] ?? ''] : undefined
    if (isNumbers(oldColor) && COLOR_KEY[json.type] && !spec.baseColor) json[COLOR_KEY[json.type]] = [...oldColor]
  }
  applySpec(json, spec, h.engine.textures)
  const { material } = buildChecked(json, spec)
  const asset = buildMaterialAsset(material, existing?.name ?? name, existing?.thumbnail ?? '', existing?.id)
  const prev = existing

  const apply = (next: MaterialAsset, before: MaterialAsset | undefined) => {
    const e = getHost().engine
    if (before) { e.updateMaterial(next.id, next); e.propagateMaterialAsset(next) } else e.addMaterial(next)
  }
  apply(asset, prev)
  if (opts.label) {
    h.history.pushFirst({
      label: opts.label,
      undo: () => {
        const e = getHost().engine
        if (prev) { e.updateMaterial(prev.id, prev); e.propagateMaterialAsset(prev) } else e.removeMaterial(asset.id)
      },
      redo: () => apply(asset, prev),
    })
  }
  opts.made?.set(asset.name.toLowerCase(), asset)
  // The explorer card's thumbnail, rendered after the fact so the call does not wait on it.
  const engine = h.engine.instance
  if (engine) {
    void renderMaterialAssetThumbnail(engine, asset).then(thumbnail => {
      const current = getHost().engine.materials.find(m => m.id === asset.id)
      if (thumbnail && current) getHost().engine.updateMaterial(asset.id, { ...current, thumbnail })
    }).catch(() => { /* a thumbnail is cosmetic */ })
  }
  return { asset, created: !existing, retyped }
}

/** One line per property for the agent: `name=value`, numbers rounded. */
export function formatMaterial(desc: Record<string, unknown>): string {
  const { name, type, textures, ...props } = desc as any
  const values = Object.entries(props).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.map(x => typeof x === 'number' ? round(x, 3) : x).join(',')}]` : typeof v === 'number' ? round(v, 3) : v}`)
  const tex = textures ? Object.entries(textures).map(([k, v]) => `${k}=${v}`).join(', ') : 'none'
  return `"${name}" (${type}): ${values.join(' ')}\ntextures: ${tex}`
}
