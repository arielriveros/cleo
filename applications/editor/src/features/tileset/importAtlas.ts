import { TextureManager, Logger } from 'cleo'

// Bringing an atlas image in from disk.
// A tileset STORES the atlas's pixel dimensions and never re-derives them (the published player has no
// decoded image when it parses a scene), so the image must be decoded BEFORE it is registered — hence
// `addTextureFromData`, not the explorer's register-then-decode `addTextureFromBase64`.

export interface ImportedAtlas {
  /** The TextureManager id, which is also the texture's permanent name. */
  textureId: string
  width: number
  height: number
}

/** A free texture id derived from a filename, suffixed on collision. A texture id is never renamed. */
function uniqueTextureId(filename: string): string {
  const tm = TextureManager.Instance
  if (!tm.getTexture(filename)) return filename
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let n = 1
  while (tm.getTexture(`${stem}_${n}${ext}`)) n++
  return `${stem}_${n}${ext}`
}

/**
 * Register an image file as a texture and report its real pixel size. Null when the file cannot be decoded.
 * Emits `TEXTURES_CHANGED` on success so the Assets explorer indexes the new texture.
 */
export async function importAtlasImage(file: File, emit: (event: string) => void): Promise<ImportedAtlas | null> {
  // `addTextureFromData` retains no source of its own, and the editor's texture store skips a texture with
  // no source bytes — the atlas would draw this session and be missing after a reload.
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mime = file.type || 'image/png'
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onerror = () => {
      Logger.error(`Could not read "${file.name}"`, 'Editor')
      resolve(null)
    }
    reader.onload = (e) => {
      const data = e.target?.result
      if (typeof data !== 'string') { resolve(null); return }
      const image = new Image()
      image.onload = () => {
        if (!image.naturalWidth || !image.naturalHeight) {
          Logger.error(`"${file.name}" decoded to an empty image`, 'Editor')
          resolve(null)
          return
        }
        const textureId = uniqueTextureId(file.name)
        TextureManager.Instance.addTextureFromData(image, { wrapping: 'repeat' }, textureId, { bytes, mime })
        emit('TEXTURES_CHANGED')
        resolve({ textureId, width: image.naturalWidth, height: image.naturalHeight })
      }
      image.onerror = () => {
        Logger.error(`"${file.name}" is not an image the browser can decode`, 'Editor')
        resolve(null)
      }
      image.src = data
    }
    reader.readAsDataURL(file)
  })
}
