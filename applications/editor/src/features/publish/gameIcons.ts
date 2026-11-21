// The published game's icon (Options ▸ Project ▸ Published game ▸ Icon): one image asset made into the files a
// publish ships beside the game, icon.png and icon.ico.
//
//   - icon.png, 512 px: the desktop window's icon on Linux, the macOS bundle's (electron-builder makes the .icns
//     from it, and wants 512 or more), and the web page's favicon and home-screen icon;
//   - icon.ico, 16 to 256 px: the Windows window, executable, installer and uninstaller.
//
// Made here, in the editor, from what the image looks like in the browser (any format it decodes), so the desktop
// shell only checks and writes bytes. The ICO is the PNG-in-ICO kind tools/brandIcons.mjs writes for the editor's
// own: Windows Vista and later, and electron-builder, read PNG entries at any size.

import { TextureManager } from 'cleo'
import type { TextureAsset } from '../../utils/textureAssets'
import { getStoredTexture } from '../../utils/textureStore'

/** The sizes in icon.ico (electron-builder needs the 256). */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const
/** icon.png's size. */
export const ICON_PNG_SIZE = 512
/** Smaller than this, the icon is scaled up and the big sizes come out soft. */
export const ICON_MIN_SOURCE = 256

/** The icon files a publish writes beside the game. Raw buffers: they cross into the worker and over IPC. */
export interface GameIconFiles {
  png: ArrayBuffer
  ico: ArrayBuffer
}

/** A PNG-in-ICO container of the given PNGs. Pure; tools/brandIcons.mjs `encodeIco`, without Node's Buffer. */
export function encodeIco(entries: readonly { size: number; png: Uint8Array }[]): Uint8Array {
  const headerBytes = 6 + 16 * entries.length
  const total = entries.reduce((n, e) => n + e.png.length, headerBytes)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true)                 // reserved
  view.setUint16(2, 1, true)                 // type: icon
  view.setUint16(4, entries.length, true)
  let offset = headerBytes
  entries.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i
    out[e] = size >= 256 ? 0 : size          // width, 0 meaning 256
    out[e + 1] = size >= 256 ? 0 : size      // height
    view.setUint16(e + 4, 1, true)           // colour planes
    view.setUint16(e + 6, 32, true)          // bits per pixel
    view.setUint32(e + 8, png.length, true)
    view.setUint32(e + 12, offset, true)
    out.set(png, offset)
    offset += png.length
  })
  return out
}

/** What to say about an image as an icon: not square, or too small to stay sharp. */
export function iconWarnings(width: number, height: number): string[] {
  const warnings: string[] = []
  if (width > 0 && height > 0 && width !== height) warnings.push(`The icon image is ${width}×${height}, not square: it is fitted inside a square with clear sides.`)
  if (Math.max(width, height) > 0 && Math.max(width, height) < ICON_MIN_SOURCE) warnings.push(`The icon image is under ${ICON_MIN_SOURCE} px: its larger sizes are scaled up and look soft.`)
  return warnings
}

type Canvas2D = OffscreenCanvas
const canvas = (size: number): Canvas2D => new OffscreenCanvas(size, size)
function context(c: Canvas2D): OffscreenCanvasRenderingContext2D {
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas to make the icon with')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

/** `source` fitted (whole, centred) into a `size` square with clear sides. */
function fitted(source: ImageBitmap, size: number): Canvas2D {
  const c = canvas(size)
  const scale = Math.min(size / source.width, size / source.height)
  const w = source.width * scale, h = source.height * scale
  context(c).drawImage(source, (size - w) / 2, (size - h) / 2, w, h)
  return c
}

/**
 * `master` down to `size`, halving on the way: one big drawImage step skips most of the source's pixels, and the
 * small sizes alias.
 */
function downscaled(master: Canvas2D, size: number): Canvas2D {
  let current = master
  while (current.width / 2 >= size) {
    const half = canvas(Math.max(size, Math.floor(current.width / 2)))
    context(half).drawImage(current, 0, 0, half.width, half.height)
    current = half
  }
  if (current.width === size) return current
  const out = canvas(size)
  context(out).drawImage(current, 0, 0, size, size)
  return out
}

async function pngOf(c: Canvas2D): Promise<Uint8Array> {
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

/** icon.png and icon.ico from an image's bytes, and what to say about the image. Browser only. */
export async function buildGameIcons(source: Blob): Promise<{ files: GameIconFiles; warnings: string[] }> {
  const bitmap = await createImageBitmap(source)
  try {
    const warnings = iconWarnings(bitmap.width, bitmap.height)
    // Drawn once, larger than every output, and taken down from there.
    const master = fitted(bitmap, Math.max(ICON_PNG_SIZE, 1024))
    const png = await pngOf(downscaled(master, ICON_PNG_SIZE))
    const entries: { size: number; png: Uint8Array }[] = []
    for (const size of ICO_SIZES) entries.push({ size, png: await pngOf(downscaled(master, size)) })
    const ico = encodeIco(entries)
    return { files: { png: png.slice().buffer, ico: ico.slice().buffer }, warnings }
  } finally {
    bitmap.close()
  }
}

/**
 * The bytes behind a texture, for making an icon of it: its image's, a channel pack's baked image's, or (a texture
 * from before the image split) its own. Null when the project holds none.
 */
export async function textureSourceBlob(textureId: string, textures: readonly TextureAsset[]): Promise<Blob | null> {
  const asset = textures.find(t => t.id === textureId)
  const source = asset?.source
  const imageId = source?.kind === 'image' ? source.imageId : source?.kind === 'pack' ? source.bakedImageId : undefined
  for (const id of [imageId, textureId]) {
    if (!id) continue
    // The bytes the TextureManager kept first: an image just captured or uploaded is there before the store has it.
    const live = TextureManager.Instance.getSource(id)
    if (live) return new Blob([live.bytes as unknown as BlobPart], { type: live.mime })
    const stored = await getStoredTexture(id)
    if (stored?.blob) return stored.blob
  }
  return null
}

/**
 * The game's icon files, made from the project's icon texture: none when it has no icon, or when the image's bytes
 * are gone (said in `warnings`; the game then keeps the default icon).
 */
export async function gameIconFiles(
  textureId: string, textures: readonly TextureAsset[],
): Promise<{ files: GameIconFiles | null; warnings: string[] }> {
  if (!textureId) return { files: null, warnings: [] }
  const blob = await textureSourceBlob(textureId, textures)
  if (!blob) return { files: null, warnings: ['The icon image has no data in this project: the game keeps the default icon.'] }
  return buildGameIcons(blob)
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * The player's index.html, as this game's page: its title in `<title>` (the player also sets it at boot, but a
 * tab and a bookmark read the file's), and its icon linked when it ships one. The player's own template is not
 * touched, so nothing here needs a player rebuild.
 */
export function withGameHead(html: string, { title, icon }: { title?: string; icon?: boolean }): string {
  let out = html
  const name = (title ?? '').trim()
  if (name) out = out.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(name)}</title>`)
  if (icon) {
    const links = [
      '<link rel="icon" href="icon.ico" sizes="any">',
      '<link rel="icon" type="image/png" href="icon.png">',
      '<link rel="apple-touch-icon" href="icon.png">',
    ].map(l => `    ${l}\n`).join('')
    out = out.replace(/(\s*)<\/head>/, (_m, space: string) => `\n${links}${space.replace(/^\n/, '')}</head>`)
  }
  return out
}
