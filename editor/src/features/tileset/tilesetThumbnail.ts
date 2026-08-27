import { TextureManager } from 'cleo'
import type { TilesetAsset } from '../../utils/tilesets'

// A tileset's card preview: its atlas, downscaled with canvas 2D rather than the shared 3D thumbnail
// renderer — there is nothing to pose or light, and the browser has already decoded the image.

const SIZE = 96

/**
 * A data-URL preview of `asset`'s atlas, or null when it has no image yet (or the image is cross-origin,
 * which taints the canvas and makes toDataURL throw).
 * Letterboxed rather than cropped, and drawn with smoothing off: bilinear filtering turns pixel art to
 * mush at card size.
 */
export function renderTilesetThumbnail(asset: TilesetAsset): string | null {
  const image = TextureManager.Instance.getTexture(asset.textureId)?.data as HTMLImageElement | undefined
  if (!(image instanceof HTMLImageElement) || !image.naturalWidth || !image.naturalHeight) return null

  try {
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = false

    const scale = Math.min(SIZE / image.naturalWidth, SIZE / image.naturalHeight)
    const w = Math.max(1, Math.round(image.naturalWidth * scale))
    const h = Math.max(1, Math.round(image.naturalHeight * scale))
    ctx.drawImage(image, Math.round((SIZE - w) / 2), Math.round((SIZE - h) / 2), w, h)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}
