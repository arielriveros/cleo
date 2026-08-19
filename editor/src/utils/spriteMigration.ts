import { Scene, SpriteNode, isInlineTilesetId } from 'cleo'
import { TilesetAsset, buildTilesetAsset, toRuntimeTileset } from './tilesets'
import { awaitTextureImage } from './textureReady'

// Promoting pre-tileset sprites into real tileset assets.
//
// A sprite saved before the tileset standardization carried a raw texture id (plus, if animated, its own
// columns/rows). `Sprite.parse` already turns that into a working INLINE tileset — the published player
// and runtime instantiation need no editor in scope, so migration has to be possible with no decoded
// image, and an inline tileset expresses its grid in tile units rather than pixels.
//
// That is enough to draw, but not enough to author: an inline tileset has no library asset, so it cannot
// be renamed, resliced, given margin/spacing, or given per-tile metadata. This pass closes that gap in
// the editor, where a decoded image IS available: it creates one real asset per distinct sheet and
// relinks the sprites onto it, with true pixel dimensions.
//
// Editor-owned helper sprites (the light and probe icons) keep their inline tilesets on purpose — they
// are not the user's content and must not appear in the asset explorer.

/** Textures belonging to the editor's own gizmos, which never become library assets. */
function isEditorTexture(textureId: string): boolean {
  return textureId.startsWith('__editor__') || textureId.startsWith('__debug__')
}

/** One distinct legacy sheet: an atlas plus the grid the sprites using it were cut with. */
type SheetKey = string
const sheetKey = (textureId: string, columns: number, rows: number): SheetKey =>
  `${textureId}::${columns}x${rows}`

export interface SpriteMigrationResult {
  /** Tileset assets to add to the library. Empty when there was nothing to migrate. */
  created: TilesetAsset[]
  /** Whether any sprite in the scene was relinked. */
  changed: boolean
}

/**
 * Relink every sprite in `scene` that still draws from an inline tileset onto a real library asset,
 * creating assets as needed.
 *
 * Awaits each atlas's decode before reading `naturalWidth` — `addTextureFromBase64` registers an id
 * synchronously and decodes later, so reading too early bakes a 1x1 grid in permanently.
 */
export async function migrateSceneSprites(
  scene: Scene | null | undefined,
  tilesets: TilesetAsset[],
): Promise<SpriteMigrationResult> {
  if (!scene) return { created: [], changed: false }

  const pending: { sprite: SpriteNode; key: SheetKey; textureId: string; columns: number; rows: number }[] = []
  for (const sprite of scene.sprites) {
    const tileset = sprite.tileset
    if (!tileset || !isInlineTilesetId(tileset.id)) continue
    const textureId = tileset.textureId
    if (!textureId || isEditorTexture(textureId)) continue
    pending.push({
      sprite, textureId,
      key: sheetKey(textureId, tileset.columns, tileset.rows),
      columns: tileset.columns, rows: tileset.rows,
    })
  }
  if (!pending.length) return { created: [], changed: false }

  // An asset already built for this exact sheet by an earlier run (or an earlier scene this session) is
  // reused rather than duplicated. Matching on the grid as well as the atlas matters: the same image can
  // legitimately be sliced two ways by two sprites.
  const byKey = new Map<SheetKey, TilesetAsset>()
  for (const asset of tilesets) byKey.set(sheetKey(asset.textureId, asset.columns, asset.rows), asset)

  const created: TilesetAsset[] = []
  let changed = false

  for (const item of pending) {
    let asset = byKey.get(item.key)
    if (!asset) {
      const image = await awaitTextureImage(item.textureId)
      // No decode, no honest pixel size. Leaving the sprite inline keeps it drawing correctly; a later
      // run migrates it once the image is available.
      if (!image) continue
      const name = item.textureId.replace(/\.[^./\\]+$/, '') || item.textureId
      const candidate = buildTilesetAsset(name, item.textureId, image.naturalWidth, image.naturalHeight, {
        tileWidth: Math.max(1, Math.floor(image.naturalWidth / item.columns)),
        tileHeight: Math.max(1, Math.floor(image.naturalHeight / item.rows)),
      })
      // buildTilesetAsset re-derives the grid from the pixel size, which will not match when the sheet
      // does not divide evenly. Tile indices are positions in that grid, so a mismatch would silently
      // repoint every frame at a different cell — leave the sprite inline instead. It still draws.
      if (candidate.columns !== item.columns || candidate.rows !== item.rows) continue
      asset = candidate
      byKey.set(item.key, asset)
      created.push(asset)
    }
    item.sprite.tileset = toRuntimeTileset(asset)
    changed = true
  }

  return { created, changed }
}
