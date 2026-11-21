import { isAssetRef, type AssetFieldKind, type AssetFieldRef, type AssetTable } from 'cleo'
import type { AssetKind } from './vfs'
import type { MaterialAsset } from './materials'
import { toRuntimeTileset, type TilesetAsset } from './tilesets'
import { deepClone } from '@cleo/app-kit/utils/deepClone'

// The assets script fields hold (`skin: Material`, `icon: Texture`, …), as the editor sees them: stored as
// `{ $asset, id }` inside a node's `scriptVars` (src/core/properties/fieldRefs.ts). This module finds them in
// serialized trees, says which library each kind lives in, and builds the game's ONE asset table, where a
// material or tileset several fields name is stored once.

/** The library an asset field's kind is kept in (a sound field names a sound SAMPLE). */
export const FIELD_ASSET_LIBRARY: Record<AssetFieldKind, AssetKind> = {
  material: 'material', texture: 'texture', sound: 'soundSample', tileset: 'tileset',
}

/** Every asset reference in `value` (a field's stored value: a reference, or a list holding some). */
function refsIn(value: unknown, field: string, out: (ref: AssetFieldRef, field: string) => void): void {
  if (isAssetRef(value)) { out(value, field); return }
  if (Array.isArray(value)) value.forEach((v, i) => { if (isAssetRef(v)) out(v, `${field}[${i}]`) })
}

/**
 * Each asset reference the script fields of a SERIALIZED node tree hold, with the field it sits in
 * (`scriptVars.skin`, `scriptVars.decals[1]`). Children are walked; nothing outside `scriptVars` is read.
 */
export function forEachFieldAssetRef(node: any, visit: (ref: AssetFieldRef, field: string) => void): void {
  if (!node || typeof node !== 'object') return
  const vars = node.scriptVars
  if (vars && typeof vars === 'object')
    for (const name of Object.keys(vars)) refsIn(vars[name], `scriptVars.${name}`, visit)
  for (const child of Array.isArray(node.children) ? node.children : []) forEachFieldAssetRef(child, visit)
}

/** The ids of `kind` the script fields of the trees in `roots` name. */
export function fieldAssetIds(roots: readonly any[], kind: AssetFieldKind): Set<string> {
  const out = new Set<string>()
  for (const root of roots) forEachFieldAssetRef(root, ref => { if (ref.$asset === kind) out.add(ref.id) })
  return out
}

/**
 * The game's asset table for the trees in `roots` (scenes and templates, serialized): each material and
 * tileset a script field names, once, as the JSON the engine parses. Undefined when no field names one.
 */
export function buildFieldAssetTable(
  roots: readonly any[],
  libs: { materials?: readonly MaterialAsset[]; tilesets?: readonly TilesetAsset[] },
): AssetTable | undefined {
  const table: AssetTable = {}
  for (const id of fieldAssetIds(roots, 'material')) {
    const asset = libs.materials?.find(m => m.id === id)
    // A copy: every build hands the engine new JSON, so a Play never starts from a Material the last one's
    // scripts changed (the engine keeps one object per JSON it was given).
    if (asset?.material) (table.materials ??= {})[id] = deepClone(asset.material)
  }
  for (const id of fieldAssetIds(roots, 'tileset')) {
    const asset = libs.tilesets?.find(t => t.id === id)
    if (asset) (table.tilesets ??= {})[id] = toRuntimeTileset(asset).serialize()
  }
  return table.materials || table.tilesets ? table : undefined
}

/** Add the ids of everything `table` draws from: its materials' and tilesets' textures. */
export function collectAssetTableTextureIds(table: AssetTable | undefined, set: Set<string>, collectTextureIds: (obj: any, set: Set<string>) => void): void {
  for (const json of Object.values(table?.materials ?? {})) collectTextureIds(json, set)
  for (const json of Object.values(table?.tilesets ?? {}) as any[]) {
    for (const key of ['textureId', 'sixWayPositiveTextureId', 'sixWayNegativeTextureId', 'normalTextureId', 'ormTextureId'])
      if (typeof json?.[key] === 'string' && json[key]) set.add(json[key])
  }
}
