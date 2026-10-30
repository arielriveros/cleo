// CPU mip chain and channel isolation for the texture viewer.
//
// The chain is built by successive halving, each level filtered from the one above rather than from the
// original — which is what `glGenerateMipmap` does, so the preview shows the levels the GPU will actually
// sample rather than an idealised downscale of level 0.
//
// Deliberately NOT `lodTextures.halveTo`: that clamps at MIN_LOD_TEXTURE_SIZE (64) because an LOD texture
// below that is not worth its own asset. A mip chain runs all the way down to 1x1.

/** Levels a full chain has over the larger dimension — the count `generateMipmap` produces. */
export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1
}

function halve(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    // Bilinear on a halving step IS a 2x2 box filter, which is the standard mip reduction.
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, width, height)
  }
  return canvas
}

/**
 * Every mip level of `image`, level 0 first. Each is a canvas so the viewer can draw and probe it.
 *
 * Building the whole chain up front costs about a third of level 0 again in memory and is bounded by the
 * image size; doing it lazily per level would mean re-deriving every level above the one asked for,
 * because each depends on its predecessor.
 */
export function buildMipChain(image: HTMLImageElement): HTMLCanvasElement[] {
  const w = image.naturalWidth || image.width
  const h = image.naturalHeight || image.height
  if (!w || !h) return []

  const levels: HTMLCanvasElement[] = [halve(image, w, h)]
  let lw = w
  let lh = h
  while (lw > 1 || lh > 1) {
    lw = Math.max(1, lw >> 1)
    lh = Math.max(1, lh >> 1)
    levels.push(halve(levels[levels.length - 1], lw, lh))
  }
  return levels
}

export type Channel = 'rgb' | 'r' | 'g' | 'b' | 'a'

/**
 * One channel of `source`, splatted to grey so it can be judged on its own.
 *
 * Returns `source` unchanged for 'rgb'. Alpha is shown as opaque grey rather than as transparency —
 * the point of isolating it is to SEE the mask, which a transparent image cannot show.
 */
export function isolateChannel(source: HTMLCanvasElement, channel: Channel): HTMLCanvasElement {
  if (channel === 'rgb') return source

  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const src = source.getContext('2d')
  const dst = out.getContext('2d')
  if (!src || !dst) return source

  const data = src.getImageData(0, 0, source.width, source.height)
  const px = data.data
  const offset = channel === 'r' ? 0 : channel === 'g' ? 1 : channel === 'b' ? 2 : 3
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i + offset]
    px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255
  }
  dst.putImageData(data, 0, 0)
  return out
}

/** The RGBA at one texel, for the pixel probe. Null when out of bounds. */
export function texelAt(source: HTMLCanvasElement, x: number, y: number): [number, number, number, number] | null {
  if (x < 0 || y < 0 || x >= source.width || y >= source.height) return null
  const ctx = source.getContext('2d')
  if (!ctx) return null
  const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data
  return [d[0], d[1], d[2], d[3]]
}
