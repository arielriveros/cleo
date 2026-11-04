// When a Creator liquid decal's flipbook first shows liquid on the floor.
//
// A liquid bake's decal frames run from the effect's start, so the first few are empty while the liquid
// is still in the air. A decal that is the whole effect (the Valley's hit blood: no spray) should start
// where the liquid lands; this reads the colour atlas's coverage cell by cell to find that frame.
//
// Plain Node, no image library: an 8-bit RGBA, non-interlaced PNG (what the Creator writes) decoded with
// zlib, as tools/brandIcons.mjs does.

import fs from 'fs'
import { inflateSync } from 'zlib'

/** Decode an 8-bit RGBA, non-interlaced PNG to `{ width, height, data }` (RGBA bytes). */
function decodeRgba(file) {
  const buf = fs.readFileSync(file)
  let width = 0, height = 0
  const idat = []
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    if (type === 'IHDR') {
      width = buf.readUInt32BE(p + 8)
      height = buf.readUInt32BE(p + 12)
      const [depth, colorType, , , interlace] = buf.subarray(p + 16, p + 21)
      if (depth !== 8 || colorType !== 6 || interlace !== 0) throw new Error(`${file}: expected an 8-bit RGBA, non-interlaced PNG`)
    }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len))
    if (type === 'IEND') break
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[row + x - 4] : 0
      const b = y > 0 ? data[row - stride + x] : 0
      const c = x >= 4 && y > 0 ? data[row - stride + x - 4] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      data[row + x] = v & 255
    }
  }
  return { width, height, data }
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * The first cell of a flipbook atlas (cells left to right from the top row) with liquid in it: more than
 * `minCoverage` of its texels above `minAlpha`. `frames` when no cell has any.
 */
export function firstWetFrame(file, { columns, rows, frames }, { minAlpha = 0.1, minCoverage = 0.005 } = {}) {
  const { width, height, data } = decodeRgba(file)
  const tw = Math.floor(width / columns), th = Math.floor(height / rows)
  const alpha = Math.round(minAlpha * 255)
  for (let f = 0; f < frames; f++) {
    const cx = (f % columns) * tw, cy = Math.floor(f / columns) * th
    let wet = 0
    for (let y = cy; y < cy + th; y++) for (let x = cx; x < cx + tw; x++) if (data[(y * width + x) * 4 + 3] > alpha) wet++
    if (wet > minCoverage * tw * th) return f
  }
  return frames
}
