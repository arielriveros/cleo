// Procedural RGBA textures for Hollow Keep, encoded as PNG with nothing but node's zlib.
//
// Seeded and pure: the same seed gives the same bytes, so the generator stays byte-identical across
// runs. Used for the blood decals — placeholder art like everything else here, swapped by replacing the
// texture on the material (SOULS_DEMO.md §9).

import zlib from 'zlib'

// ----- PNG ----------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Encode `rgba` (width × height × 4 bytes, rows top to bottom) as a PNG. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // RGBA
  // compression, filter and interlace all 0
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0   // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ----- shapes -------------------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

/**
 * Coverage from a signed distance (negative inside), anti-aliased over about `px` texels. A field of
 * shapes is the max of their coverages.
 */
function paint(size, shapes, px) {
  const rgba = new Uint8Array(size * size * 4)
  const edge = px / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Centred coordinates in [-0.5, 0.5]; +v is the image's top.
      const u = (x + 0.5) / size - 0.5, v = 0.5 - (y + 0.5) / size
      let a = 0, depth = 0
      for (const s of shapes) {
        const d = s(u, v)
        const c = 1 - smooth(-edge, edge, d)
        if (c > a) a = c
        // How far inside the deepest shape: thick blood reads darker.
        if (-d > depth) depth = -d
      }
      const shade = 0.72 + 0.28 * smooth(0, 0.08, depth)
      const i = (y * size + x) * 4
      rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.round(255 * shade)
      rgba[i + 3] = Math.round(255 * a)
    }
  }
  return rgba
}

const circle = (cx, cy, r) => (u, v) => Math.hypot(u - cx, v - cy) - r
// An ellipse stretched along `angle`: `len` long, `r` wide. Approximate distance, fine for coverage.
const streak = (cx, cy, angle, len, r) => (u, v) => {
  const ca = Math.cos(angle), sa = Math.sin(angle)
  const du = u - cx, dv = v - cy
  const along = du * ca + dv * sa, across = -du * sa + dv * ca
  return (Math.hypot(along / len, across / r) - 1) * r
}

/**
 * A splat seen from above: an irregular pool (a circle whose radius wobbles with angle), short streaks
 * thrown out of it, and satellite droplets. Fits inside the texture with a margin, as a decal must:
 * the image is shown once, so anything touching the border is cut along a straight line.
 */
export function bloodSplat(seed, size = 256) {
  const r = rng(seed)
  const lobes = Array.from({ length: 7 }, (_, k) => ({ k: k + 3, a: 0.008 + r() * 0.02 / (1 + k * 0.4), p: r() * Math.PI * 2 }))
  const pool = (u, v) => {
    const th = Math.atan2(v, u)
    let radius = 0.2
    for (const l of lobes) radius += l.a * Math.sin(l.k * th + l.p)
    return Math.hypot(u, v) - radius
  }
  const shapes = [pool]
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI * 2, d = 0.18 + r() * 0.1
    shapes.push(streak(Math.cos(a) * d, Math.sin(a) * d, a, 0.04 + r() * 0.07, 0.012 + r() * 0.016))
  }
  for (let i = 0; i < 22; i++) {
    const a = r() * Math.PI * 2, d = 0.26 + r() * 0.17
    shapes.push(circle(Math.cos(a) * d, Math.sin(a) * d, 0.006 + r() * 0.02))
  }
  return encodePng(size, size, paint(size, shapes, 1.5))
}

/**
 * Droplets flung in one direction: a fan along the image's VERTICAL axis (the decal's local Z), dense
 * and large near the bottom edge, thinning and shrinking toward the top. A script yaws the decal so
 * the fan points along the blow.
 */
export function bloodDrops(seed, size = 256) {
  const r = rng(seed)
  const shapes = []
  for (let i = 0; i < 60; i++) {
    const t = Math.pow(r(), 0.7)                    // 0 near the source, 1 far along the fan
    const v = -0.38 + t * 0.8
    const u = (r() - 0.5) * (0.12 + t * 0.42)
    const radius = (0.028 - t * 0.02) * (0.5 + r())
    if (radius < 0.003) continue
    // Far drops land elongated along the throw.
    shapes.push(t > 0.4 && r() < 0.6 ? streak(u, v, Math.PI / 2, radius * (1.5 + r() * 2), radius) : circle(u, v, radius))
  }
  return encodePng(size, size, paint(size, shapes, 1.2))
}
