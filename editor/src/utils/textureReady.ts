import { TextureManager } from 'cleo'

// Waiting for a texture to finish decoding.
//
// `TextureManager.addTextureFromBase64`/`addTextureFromBytes` register an id SYNCHRONOUSLY and decode the
// image asynchronously — `Texture.data` stays null for the whole decode window, and the engine exposes no
// promise, callback or event for when that ends. So anything that needs the decoded pixels (a thumbnail
// capture, or reading an atlas's dimensions) has to poll.
//
// The one exception is `addTextureFromData`, which takes an already-decoded HTMLImageElement and is
// therefore ready the moment it returns. Prefer it when you control the load — see importAtlasImage.

/** The decoded image behind a texture id, or null while it is still decoding (or if it is not an image). */
export function textureImage(id: string): HTMLImageElement | null {
  const data: any = TextureManager.Instance.getTexture(id)?.data
  if (data instanceof HTMLImageElement && data.complete && data.naturalWidth > 0) return data
  return null
}

/** True once this texture has nothing left to wait for. Unknown ids and data-backed textures count as ready. */
function isReady(id: string): boolean {
  const tex = TextureManager.Instance.getTexture(id)
  if (!tex) return true // unknown id — nothing to wait for
  const data: any = (tex as any).data
  if (!data) return false // still loading (image not attached yet)
  if (data instanceof HTMLImageElement) return data.complete && data.naturalWidth > 0
  return true // data-backed texture (no image to decode)
}

/**
 * Wait until every referenced texture has finished decoding, then yield one frame so the GPU upload lands.
 *
 * Used before a thumbnail capture — screenshotting too early captures an untextured mesh. Gives up after
 * `timeoutMs` rather than hanging on a texture that will never decode.
 */
export async function awaitTexturesReady(ids: string[], timeoutMs = 10000): Promise<void> {
  const start = performance.now()
  while (!ids.every(isReady) && performance.now() - start < timeoutMs)
    await new Promise<void>(r => setTimeout(r, 50))
  await new Promise<void>(r => requestAnimationFrame(() => r()))
}

/**
 * The decoded image for one texture id, waiting for it if it is still loading. Null on timeout, or when the
 * id names something that is not an image.
 *
 * This is what any consumer reading an image's PIXEL DIMENSIONS needs: `naturalWidth` is 0 until decode
 * lands, and a caller that reads it too early silently records a 0x0 image.
 */
export async function awaitTextureImage(id: string, timeoutMs = 10000): Promise<HTMLImageElement | null> {
  if (!id) return null
  const start = performance.now()
  while (!isReady(id) && performance.now() - start < timeoutMs)
    await new Promise<void>(r => setTimeout(r, 50))
  return textureImage(id)
}
