import { Tileset, TilemapNode, isInlineTilesetId } from 'cleo'
import type { Scene, TileMeta, TerrainSet, VariantSet, TilesetConfig } from 'cleo'
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

/** Re-derive `columns`/`rows` after a slicing change. Returns a new asset; the old one is left alone. */
export function resliceTileset(asset: TilesetAsset, patch: Partial<TilesetAsset>): TilesetAsset {
  const next = { ...asset, ...patch, textureIds: [patch.textureId ?? asset.textureId] }
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
    tiles: json.tiles,
    terrains: json.terrains,
    variantSets: json.variantSets,
    textureIds: [json.textureId],
  }
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
  return changed
}

/** Tileset ASSET ids a live scene references, from tilemap layers and sprites alike. */
export function tilesetIdsInScene(scene: Scene | null | undefined): string[] {
  const ids = new Set<string>()
  for (const node of scene?.tilemaps ?? []) {
    for (const layer of node.tilemap.layers) if (layer.cfg.tilesetId) ids.add(layer.cfg.tilesetId)
  }
  for (const sprite of scene?.sprites ?? []) {
    const id = sprite.tileset?.id
    if (id && !isInlineTilesetId(id)) ids.add(id)
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
