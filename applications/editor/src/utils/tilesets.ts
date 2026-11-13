import { Tileset, TilemapNode, isInlineTilesetId } from 'cleo'
import type { Scene, TileMeta, TerrainSet, VariantSet, TilesetConfig, PrecipitationSprite } from 'cleo'
import { cryptoRandomId } from './ids'

// A reusable, named Tileset asset — an atlas image sliced into a grid, plus the per-tile metadata that
// makes tiles solid, animated, tinted or depth-anchored.
//
// A TilemapNode stores `tilesetId` per layer AND a full embedded copy of every tileset it references. The
// EMBEDDED copy is what draws and collides, so it travels with the serialized scene; see reembedTilesets
// for how an edit reaches already-placed maps.

export type { TileMeta, TerrainSet, VariantSet }

export type TilesetAsset = {
  id: string
  name: string
  /** TextureManager id of the atlas. Also its filename — texture ids are never renamed. */
  textureId: string
  imageWidth: number
  imageHeight: number
  tileWidth: number
  tileHeight: number
  margin: number
  spacing: number
  /** Derived from the image once at import and then stored — see TilesetConfig for why. */
  columns: number
  rows: number
  /** Linear brightness multiplier for every tile (TilesetConfig.overdrive). Absent = 1. */
  overdrive?: number
  /**
   * Lighting maps for lit sprites (TilesetConfig.sixWayPositiveTextureId): six-way lightmaps, or a normal
   * map and an ORM map, cut into the same cells as the atlas. Absent = none. Listed in `textureIds` too.
   */
  sixWayPositiveTextureId?: string
  sixWayNegativeTextureId?: string
  normalTextureId?: string
  ormTextureId?: string
  /** Art pixels per world unit (TilesetConfig.pixelsPerUnit): sizes sprites and tilemap cells. Absent = none. */
  pixelsPerUnit?: number
  /** Free-form regions [x, y, w, h] instead of the grid (TilesetConfig.regions). Absent = the grid. */
  regions?: [number, number, number, number][]
  /** Sparse: only the tiles that actually carry metadata. */
  tiles: Record<number, TileMeta>
  terrains: TerrainSet[]
  variantSets: VariantSet[]
  thumbnail?: string
  /** Duplicated from `textureId`: `referencedTextureIds` (utils/textureStore) scans `textureIds` only. */
  textureIds: string[]
}

export const DEFAULT_TILE_SIZE = 16

/** How many whole tiles fit across an atlas of this size. Never less than 1. */
export function gridOf(imageWidth: number, imageHeight: number, tileWidth: number, tileHeight: number,
                       margin = 0, spacing = 0): { columns: number; rows: number } {
  const fit = (extent: number, tile: number) => {
    if (tile <= 0) return 1
    // Every tile after the first also costs its leading gap, hence the +spacing on both sides.
    return Math.max(1, Math.floor((extent - 2 * margin + spacing) / (tile + spacing)))
  }
  return { columns: fit(imageWidth, tileWidth), rows: fit(imageHeight, tileHeight) }
}

/** Tile sizes worth guessing at, largest first. Atlases are overwhelmingly powers of two. */
const TILE_SIZE_CANDIDATES = [64, 32, 16, 8]
/** Below this many tiles per side a "guess" is almost certainly reading a big sheet as a few huge tiles. */
const MIN_GUESS_GRID = 4

/**
 * A plausible starting tile size for a freshly imported atlas: the largest candidate that divides BOTH
 * dimensions evenly and still leaves at least a 4x4 grid. A heuristic — the user corrects it against the
 * grid drawn over the atlas.
 */
export function guessTileSize(imageWidth: number, imageHeight: number): number {
  if (imageWidth <= 0 || imageHeight <= 0) return DEFAULT_TILE_SIZE
  for (const size of TILE_SIZE_CANDIDATES) {
    if (imageWidth % size || imageHeight % size) continue
    if (imageWidth / size < MIN_GUESS_GRID || imageHeight / size < MIN_GUESS_GRID) continue
    return size
  }
  return DEFAULT_TILE_SIZE
}

export function buildTilesetAsset(
  name: string,
  textureId: string,
  imageWidth: number,
  imageHeight: number,
  patch?: Partial<TilesetAsset>,
): TilesetAsset {
  const tileWidth = patch?.tileWidth ?? DEFAULT_TILE_SIZE
  const tileHeight = patch?.tileHeight ?? DEFAULT_TILE_SIZE
  const margin = patch?.margin ?? 0
  const spacing = patch?.spacing ?? 0
  const { columns, rows } = gridOf(imageWidth, imageHeight, tileWidth, tileHeight, margin, spacing)
  return {
    id: patch?.id ?? cryptoRandomId(),
    name,
    textureId,
    imageWidth,
    imageHeight,
    tileWidth,
    tileHeight,
    margin,
    spacing,
    columns,
    rows,
    tiles: {},
    terrains: [],
    variantSets: [],
    ...patch,
    textureIds: [textureId],
  }
}

/**
 * A stored tileset with every collection present. One written by an older build or by hand can lack its
 * terrain and variant sets (which the inspector maps over) or `textureIds` (which the texture store scans
 * to keep the atlas alive): read as empty, and as the atlas alone.
 */
export function normalizeTilesetAsset(asset: TilesetAsset): TilesetAsset {
  return {
    ...asset,
    tiles: asset.tiles ?? {},
    terrains: asset.terrains ?? [],
    variantSets: asset.variantSets ?? [],
    textureIds: asset.textureIds?.length ? asset.textureIds : [asset.textureId],
  }
}

/** Re-derive `columns`/`rows` after a slicing change. Returns a new asset; the old one is left alone. */
export function resliceTileset(asset: TilesetAsset, patch: Partial<TilesetAsset>): TilesetAsset {
  const next = { ...asset, ...patch }
  // The atlas AND its lighting maps: re-deriving from the atlas alone dropped the maps from the reference
  // scans the moment the tile size changed, so they stopped persisting and shipping with the tileset.
  next.textureIds = tilesetTextureIds(next)
  const { columns, rows } = gridOf(next.imageWidth, next.imageHeight, next.tileWidth, next.tileHeight,
                                   next.margin, next.spacing)
  next.columns = columns
  next.rows = rows
  // Metadata on a tile index that no longer exists must be dropped: it still ships, and it reattaches to
  // a different tile if the grid grows back.
  const kept: Record<number, TileMeta> = {}
  for (const key of Object.keys(next.tiles)) {
    const index = Number(key)
    if (index >= 0 && index < columns * rows) kept[index] = next.tiles[index]
  }
  next.tiles = kept
  return next
}

// --- Animation frames, as picked on the atlas ----------------------------------------------------------

/**
 * Atlas labels for an animation: each tile that plays gets its 1-based position(s) in the sequence, so a
 * tile used twice (a ping-pong flame) reads "2,4".
 */
export function frameBadges(frames: readonly number[]): Map<number, string> {
  const at = new Map<number, number[]>()
  frames.forEach((tile, i) => { const list = at.get(tile); if (list) list.push(i + 1); else at.set(tile, [i + 1]) })
  return new Map([...at].map(([tile, positions]) => [tile, positions.join(',')]))
}

/** `frames` with `picked` added at the end, in the order they were picked. */
export function appendFrames(frames: readonly number[], picked: readonly number[]): number[] {
  return [...frames, ...picked]
}

/** `frames` without the LAST occurrence of `tile` — undoing the most recent pick of it. */
export function removeLastFrame(frames: readonly number[], tile: number): number[] {
  const i = frames.lastIndexOf(tile)
  return i < 0 ? [...frames] : [...frames.slice(0, i), ...frames.slice(i + 1)]
}

/** `frames` with the entry at `from` moved to `to`. */
export function moveFrame(frames: readonly number[], from: number, to: number): number[] {
  const next = [...frames]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next
  const [tile] = next.splice(from, 1)
  next.splice(to, 0, tile)
  return next
}

// --- Reading the grid ----------------------------------------------------------------------------------

type Slicing = Pick<TilesetAsset, 'imageWidth' | 'imageHeight' | 'tileWidth' | 'tileHeight' | 'margin' | 'spacing' | 'columns' | 'rows'>

/** Where a tile sits in the atlas, in image pixels from the top-left. Tile 0 is the top-left tile. */
export function tileRect(asset: Slicing, index: number): { x: number; y: number; w: number; h: number } {
  const col = index % asset.columns
  const row = Math.floor(index / asset.columns)
  return {
    x: asset.margin + col * (asset.tileWidth + asset.spacing),
    y: asset.margin + row * (asset.tileHeight + asset.spacing),
    w: asset.tileWidth,
    h: asset.tileHeight,
  }
}

/**
 * Image pixels the grid leaves unused at the right and the bottom, inside the far margin. Non-zero means the
 * slicing does not divide the image — usually a wrong tile size, margin or spacing.
 */
export function leftoverPixels(asset: Slicing): { right: number; bottom: number } {
  const used = (count: number, tile: number) => count * tile + Math.max(0, count - 1) * asset.spacing
  return {
    right: Math.max(0, asset.imageWidth - 2 * asset.margin - used(asset.columns, asset.tileWidth)),
    bottom: Math.max(0, asset.imageHeight - 2 * asset.margin - used(asset.rows, asset.tileHeight)),
  }
}

// --- Per-tile metadata, as the inspector writes it -----------------------------------------------------

/**
 * `meta` without the fields that hold their default (absent, null, false), or undefined when nothing is
 * left: a husk record would ship in every embedded copy and make the atlas markers lie.
 */
export function compactTileMeta(meta: TileMeta): TileMeta | undefined {
  const out: TileMeta = { ...meta }
  for (const key of Object.keys(out) as (keyof TileMeta)[]) {
    const v = out[key]
    if (v === undefined || v === null || v === false) delete out[key]
  }
  return Object.keys(out).length ? out : undefined
}

/** `asset` with `patch` merged into every tile in `indices` — one step, so one undo entry. */
export function applyTileMeta(asset: TilesetAsset, indices: readonly number[], patch: Partial<TileMeta>): TilesetAsset {
  const tiles = { ...asset.tiles }
  for (const index of indices) {
    // Each tile gets its OWN copy of an array or object value (a tint, an animation): one shared between
    // tiles would change all of them the moment anything edited one in place. Field by field rather than a
    // JSON round trip, which would drop the `undefined`s that mean "clear this field".
    const own: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(patch)) own[key] = v && typeof v === 'object' ? structuredClone(v) : v
    const merged = compactTileMeta({ ...(tiles[index] ?? {}), ...own })
    if (merged) tiles[index] = merged
    else delete tiles[index]
  }
  return { ...asset, tiles }
}

/** `asset` with every tile in `indices` back to plain. */
export function clearTileMeta(asset: TilesetAsset, indices: readonly number[]): TilesetAsset {
  const tiles = { ...asset.tiles }
  for (const index of indices) delete tiles[index]
  return { ...asset, tiles }
}

/** The fields the Selected tiles card edits, in the order it shows them. */
const EDITED_TILE_FIELDS: (keyof TileMeta)[] = [
  'solid', 'anchorRow', 'zBias', 'spanX', 'spanY', 'tint', 'opacity', 'overdrive', 'animation',
]

const sameField = (key: keyof TileMeta, a: unknown, b: unknown): boolean => {
  // Animated is a yes/no across a selection: the frames belong to one tile and are edited one at a time.
  if (key === 'animation') return !!a === !!b
  const norm = (v: unknown) => (v === undefined || v === null || v === false ? undefined : v)
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

/**
 * What the multi-tile editor shows: the first selected tile's metadata (the fields display it, and a write
 * applies to all), plus the fields on which the rest of the selection disagrees with it.
 */
export function selectionFieldState(asset: TilesetAsset, indices: readonly number[]): { primary: TileMeta; mixed: Set<keyof TileMeta> } {
  const primary = (indices.length ? asset.tiles[indices[0]] : undefined) ?? {}
  const mixed = new Set<keyof TileMeta>()
  for (const index of indices.slice(1)) {
    const meta = asset.tiles[index] ?? {}
    for (const key of EDITED_TILE_FIELDS) if (!sameField(key, primary[key], meta[key])) mixed.add(key)
  }
  return { primary, mixed }
}

/**
 * The fields Copy / Paste carry between tiles: what a tile IS (collision, sorting, look). Animation frames,
 * terrain membership and variant weights name specific tiles and stay where they are.
 */
export const COPYABLE_TILE_FIELDS = ['solid', 'shape', 'anchorRow', 'zBias', 'spanX', 'spanY', 'tint', 'opacity', 'overdrive'] as const
export type TileMetaClip = Pick<TileMeta, typeof COPYABLE_TILE_FIELDS[number]>

/** A detached copy of the copyable fields of `meta`. */
export function copyableTileMeta(meta: TileMeta | undefined): TileMetaClip {
  const out: Record<string, unknown> = {}
  if (meta) {
    for (const key of COPYABLE_TILE_FIELDS) {
      if (meta[key] !== undefined) out[key] = JSON.parse(JSON.stringify(meta[key]))
    }
  }
  return out as TileMetaClip
}

/**
 * `asset` with `clip` pasted onto every tile in `indices`. The copyable fields are replaced WHOLESALE — a
 * field the copied tile lacked is cleared on the targets — so a paste makes the tiles match the source.
 */
export function pasteTileMeta(asset: TilesetAsset, indices: readonly number[], clip: TileMetaClip): TilesetAsset {
  const reset: Partial<TileMeta> = {}
  for (const key of COPYABLE_TILE_FIELDS) (reset as Record<string, unknown>)[key] = undefined
  return applyTileMeta(asset, indices, { ...reset, ...JSON.parse(JSON.stringify(clip)) })
}

/** A one-line description of a tile's metadata, for the atlas status bar: "solid · animated, 4 frames". */
export function tileMetaSummary(meta: TileMeta | undefined): string {
  if (!meta) return 'plain'
  const parts: string[] = []
  if (meta.solid) parts.push('solid')
  if (meta.animation) parts.push(`animated, ${meta.animation.frames.length} frame${meta.animation.frames.length === 1 ? '' : 's'}`)
  if ((meta.spanX ?? 1) > 1 || (meta.spanY ?? 1) > 1) parts.push(`${meta.spanX ?? 1}x${meta.spanY ?? 1} cells`)
  if (meta.anchorRow) parts.push(`anchor row ${meta.anchorRow}`)
  if (meta.zBias) parts.push(`z bias ${meta.zBias}`)
  if (meta.tint) parts.push('tinted')
  if (meta.opacity !== undefined && meta.opacity < 1) parts.push(`opacity ${meta.opacity}`)
  if (meta.overdrive !== undefined) parts.push(`overdrive ${meta.overdrive}`)
  if (meta.terrain) parts.push('auto-tile')
  return parts.length ? parts.join(' · ') : 'plain'
}

/** The lighting-map fields of a tileset asset, in the order the inspector lists them. */
export const TILESET_LIGHTING_MAPS = ['sixWayPositiveTextureId', 'sixWayNegativeTextureId', 'normalTextureId', 'ormTextureId'] as const
export type TilesetLightingMap = typeof TILESET_LIGHTING_MAPS[number]

/** `textureIds` for an asset: its atlas, then every lighting map it has (what reference scans read). */
export function tilesetTextureIds(asset: Pick<TilesetAsset, 'textureId' | TilesetLightingMap>): string[] {
  const ids = [asset.textureId]
  for (const key of TILESET_LIGHTING_MAPS) { const id = asset[key]; if (id && !ids.includes(id)) ids.push(id) }
  return ids
}

/** The engine-facing view: exactly what a Tilemap registers and embeds. */
export function toRuntimeTileset(asset: TilesetAsset): Tileset {
  const cfg: TilesetConfig = {
    id: asset.id,
    textureId: asset.textureId,
    imageWidth: asset.imageWidth,
    imageHeight: asset.imageHeight,
    tileWidth: asset.tileWidth,
    tileHeight: asset.tileHeight,
    margin: asset.margin,
    spacing: asset.spacing,
    columns: asset.columns,
    rows: asset.rows,
    overdrive: asset.overdrive,
    sixWayPositiveTextureId: asset.sixWayPositiveTextureId,
    sixWayNegativeTextureId: asset.sixWayNegativeTextureId,
    normalTextureId: asset.normalTextureId,
    ormTextureId: asset.ormTextureId,
    pixelsPerUnit: asset.pixelsPerUnit,
    regions: asset.regions,
  }
  const ts = new Tileset(cfg)
  for (const key of Object.keys(asset.tiles ?? {})) {
    const index = Number(key)
    if (Number.isFinite(index)) ts.setMeta(index, asset.tiles[index])
  }
  ts.terrains.push(...(asset.terrains ?? []).map(t => ({ ...t, tiles: { ...t.tiles } })))
  ts.variantSets.push(...(asset.variantSets ?? []).map(v => ({ ...v, tiles: v.tiles.map(t => ({ ...t })) })))
  return ts
}

/** The asset view of a runtime tileset — used when a scene arrives holding a tileset the library lost. */
export function fromRuntimeTileset(ts: Tileset, name: string): TilesetAsset {
  const json = ts.serialize()
  return {
    id: json.id,
    name,
    textureId: json.textureId,
    imageWidth: json.imageWidth,
    imageHeight: json.imageHeight,
    tileWidth: json.tileWidth,
    tileHeight: json.tileHeight,
    margin: json.margin,
    spacing: json.spacing,
    columns: json.columns,
    rows: json.rows,
    ...(json.overdrive !== undefined ? { overdrive: json.overdrive } : {}),
    ...(json.pixelsPerUnit !== undefined ? { pixelsPerUnit: json.pixelsPerUnit } : {}),
    ...(json.regions !== undefined ? { regions: json.regions } : {}),
    ...Object.fromEntries(TILESET_LIGHTING_MAPS.filter(k => json[k]).map(k => [k, json[k]])),
    tiles: json.tiles,
    terrains: json.terrains,
    variantSets: json.variantSets,
    textureIds: tilesetTextureIds(json),
  }
}

/**
 * A weather volume's falling-rain-or-snow sprite sheet cut from a tileset: its atlas and grid, copied in
 * (the volume embeds them, as a tilemap embeds its tileset) and linked back by `tilesetId`. `previous`
 * keeps the frame count (clamped to the grid) and the playback rate; a fresh pick uses every cell, one
 * random still cell per particle.
 */
export function weatherSpriteFromTileset(asset: TilesetAsset, previous: PrecipitationSprite | null = null): PrecipitationSprite {
  const cells = Math.max(1, asset.columns * asset.rows)
  const sameSheet = previous?.tilesetId === asset.id
  return {
    textureId: asset.textureId, tilesetId: asset.id, columns: Math.max(1, asset.columns), rows: Math.max(1, asset.rows),
    frames: sameSheet ? Math.min(cells, Math.max(1, previous!.frames)) : cells,
    fps: previous?.fps ?? 0,
  }
}

/**
 * Whether a tileset's grid covers its whole atlas with no margin or spacing: what a particle flipbook (a
 * weather sprite sheet) assumes. Otherwise its cells draw slightly off.
 */
export function tilesetGridIsTight(asset: Pick<TilesetAsset, 'margin' | 'spacing' | 'columns' | 'rows' | 'tileWidth' | 'tileHeight' | 'imageWidth' | 'imageHeight'>): boolean {
  return !asset.margin && !asset.spacing
    && asset.columns * asset.tileWidth === asset.imageWidth && asset.rows * asset.tileHeight === asset.imageHeight
}

/**
 * Push the current library into every tilemap in a live scene, so an edited tileset reaches maps that
 * already embedded an older copy. Returns true when anything changed, so the caller can skip a save.
 */
export function reembedTilesets(scene: Scene | null | undefined, tilesets: TilesetAsset[]): boolean {
  if (!scene) return false
  let changed = false
  for (const node of scene.tilemaps) {
    for (const layer of node.tilemap.layers) {
      const id = layer.cfg.tilesetId
      if (!id) continue
      const asset = tilesets.find(t => t.id === id)
      if (!asset) continue
      const current = node.tilemap.tilesetById(id)
      const next = toRuntimeTileset(asset)
      if (current && JSON.stringify(current.serialize()) === JSON.stringify(next.serialize())) continue
      node.tilemap.registerTileset(next)
      changed = true
    }
  }
  // Sprites embed one tileset each, with the same staleness problem.
  for (const sprite of scene.sprites) {
    const current = sprite.tileset
    if (!current || isInlineTilesetId(current.id)) continue
    const asset = tilesets.find(t => t.id === current.id)
    if (!asset) continue
    const next = toRuntimeTileset(asset)
    if (JSON.stringify(current.serialize()) === JSON.stringify(next.serialize())) continue
    sprite.tileset = next
    changed = true
  }
  // Weather volumes copy a tileset's atlas and grid into their falling rain or snow.
  for (const weather of scene.weatherVolumes) {
    const current = weather.precipitationSprite
    if (!current?.tilesetId) continue
    const asset = tilesets.find(t => t.id === current.tilesetId)
    if (!asset) continue
    const next = weatherSpriteFromTileset(asset, current)
    if ((['textureId', 'tilesetId', 'columns', 'rows', 'frames', 'fps'] as const).every(k => next[k] === current[k])) continue
    weather.precipitationSprite = next
    changed = true
  }
  return changed
}

/** Clear every reference to a deleted tileset, so a layer or sprite degrades to "nothing to draw". */
export function detachTileset(scene: Scene | null | undefined, tilesetId: string): boolean {
  if (!scene) return false
  let changed = false
  for (const node of scene.tilemaps) {
    for (const layer of node.tilemap.layers) {
      if (layer.cfg.tilesetId !== tilesetId) continue
      layer.cfg.tilesetId = null
      layer.markAllMeshesDirty()
      changed = true
    }
  }
  for (const sprite of scene.sprites) {
    if (sprite.tileset?.id !== tilesetId) continue
    sprite.tileset = null
    changed = true
  }
  // A weather sprite keeps the atlas it copied (it draws on its own); only the link goes.
  for (const weather of scene.weatherVolumes) {
    const current = weather.precipitationSprite
    if (current?.tilesetId !== tilesetId) continue
    weather.precipitationSprite = { ...current, tilesetId: null }
    changed = true
  }
  return changed
}

/** Tileset ASSET ids a live scene references, from tilemap layers, sprites and weather sprites alike. */
export function tilesetIdsInScene(scene: Scene | null | undefined): string[] {
  const ids = new Set<string>()
  for (const node of scene?.tilemaps ?? []) {
    for (const layer of node.tilemap.layers) if (layer.cfg.tilesetId) ids.add(layer.cfg.tilesetId)
  }
  for (const sprite of scene?.sprites ?? []) {
    const id = sprite.tileset?.id
    if (id && !isInlineTilesetId(id)) ids.add(id)
  }
  for (const weather of scene?.weatherVolumes ?? []) {
    const id = weather.precipitationSprite?.tilesetId
    if (id) ids.add(id)
  }
  return [...ids]
}

/** Every tilemap in a subtree, for panels that need one without walking the tree themselves. */
export function tilemapsUnder(root: any): TilemapNode[] {
  const out: TilemapNode[] = []
  const walk = (n: any) => {
    if (!n) return
    if (n instanceof TilemapNode) out.push(n)
    for (const child of n.children ?? []) walk(child)
  }
  walk(root)
  return out
}
