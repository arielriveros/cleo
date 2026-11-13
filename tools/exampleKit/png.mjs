// PNG in and out for the example generators, with nothing but node's zlib: decode an 8-bit RGB or RGBA,
// non-interlaced PNG (what the art packs and the Creator write) and encode RGBA. Plus the one image
// operation an atlas packer needs, a rectangle copy.

import fs from 'fs'
import { inflateSync } from 'zlib'
import { encodePng } from '../soulsDemo/png.mjs'

export { encodePng }

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG (a file path or its bytes) to `{ width, height, data }` (RGBA). */
export function decodePng(fileOrBytes) {
  const buf = typeof fileOrBytes === 'string' ? fs.readFileSync(fileOrBytes) : Buffer.from(fileOrBytes)
  let width = 0, height = 0, channels = 4
  const idat = []
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    if (type === 'IHDR') {
      width = buf.readUInt32BE(p + 8)
      height = buf.readUInt32BE(p + 12)
      const [depth, colorType, , , interlace] = buf.subarray(p + 16, p + 21)
      if (depth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0)
        throw new Error(`expected an 8-bit RGB or RGBA, non-interlaced PNG (got depth ${depth}, colour type ${colorType})`)
      channels = colorType === 6 ? 4 : 3
    }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len))
    if (type === 'IEND') break
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const line = new Uint8Array(stride)
  const prev = new Uint8Array(stride)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = y > 0 ? prev[x] : 0
      const c = x >= channels && y > 0 ? prev[x - channels] : 0
      let v = src[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      line[x] = v & 255
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      data[o] = line[x * channels]
      data[o + 1] = line[x * channels + 1]
      data[o + 2] = line[x * channels + 2]
      data[o + 3] = channels === 4 ? line[x * channels + 3] : 255
    }
    prev.set(line)
  }
  return { width, height, data }
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** A blank RGBA image. */
export function blankImage(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

/** Copy the `w` x `h` rectangle at (sx, sy) of `src` to (dx, dy) of `dst`. Both are `{ width, height, data }`. */
export function blit(dst, src, sx, sy, w, h, dx, dy) {
  for (let y = 0; y < h; y++) {
    const sy_ = sy + y, dy_ = dy + y
    if (sy_ < 0 || sy_ >= src.height || dy_ < 0 || dy_ >= dst.height) continue
    for (let x = 0; x < w; x++) {
      const sx_ = sx + x, dx_ = dx + x
      if (sx_ < 0 || sx_ >= src.width || dx_ < 0 || dx_ >= dst.width) continue
      const s = (sy_ * src.width + sx_) * 4, d = (dy_ * dst.width + dx_) * 4
      dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1]; dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = src.data[s + 3]
    }
  }
}
