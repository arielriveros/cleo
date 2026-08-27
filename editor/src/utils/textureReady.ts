import { TextureManager } from 'cleo'

// Waiting for a texture to finish decoding.
//
// `TextureManager.addTextureFromBase64`/`addTextureFromBytes` register an id SYNCHRONOUSLY and decode
// asynchronously, with no promise, callback or event for when that ends — so anything needing the decoded
// pixels has to poll. `addTextureFromData` is the exception: it takes an already-decoded
// HTMLImageElement and is ready the moment it returns.

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
 * Must precede a thumbnail capture; screenshotting early captures an untextured mesh.
 * Gives up after `timeoutMs` rather than hanging on a texture that will never decode.
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
 * Anything reading PIXEL DIMENSIONS must go through this: `naturalWidth` is 0 until the decode lands.
 */
export async function awaitTextureImage(id: string, timeoutMs = 10000): Promise<HTMLImageElement | null> {
  if (!id) return null
  const start = performance.now()
  while (!isReady(id) && performance.now() - start < timeoutMs)
    await new Promise<void>(r => setTimeout(r, 50))
  return textureImage(id)
}
