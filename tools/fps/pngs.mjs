// Procedural RGBA textures for the FPS example, encoded as PNG with nothing but node's zlib (the encoder is
// tools/soulsDemo/png.mjs's). Seeded and pure, so the generator stays byte-identical across runs.

import { encodePng } from '../soulsDemo/png.mjs'

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
 * A bullet hole seen square on, as a decal shows it once: a dark crater, a scorched ring round it, and a few
 * cracks and chips thrown out. Coverage is the alpha channel; a decal's texture must clear the border.
 */
export function bulletHole(seed, size = 128) {
  const r = rng(seed)
  const rgba = new Uint8Array(size * size * 4)
  const cracks = Array.from({ length: 7 }, () => ({ a: r() * Math.PI * 2, len: 0.14 + r() * 0.2, w: 0.004 + r() * 0.006 }))
  const chips = Array.from({ length: 9 }, () => ({ a: r() * Math.PI * 2, d: 0.1 + r() * 0.22, s: 0.008 + r() * 0.02 }))
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size - 0.5, v = 0.5 - (y + 0.5) / size
    const d = Math.hypot(u, v), th = Math.atan2(v, u)
    // The scorch: soft, wider than the hole, a little ragged.
    const ragged = 1 + 0.18 * Math.sin(th * 5 + seed) + 0.1 * Math.sin(th * 11)
    let a = (1 - smooth(0.05 * ragged, 0.2 * ragged, d)) * 0.55
    let shade = 0.1
    // The crater: opaque black.
    const hole = 1 - smooth(0.022, 0.034, d)
    if (hole > 0) { a = Math.max(a, hole); shade = 0.02 }
    for (const c of cracks) {
      const along = u * Math.cos(c.a) + v * Math.sin(c.a)
      const across = Math.abs(-u * Math.sin(c.a) + v * Math.cos(c.a))
      if (along > 0.02 && along < c.len) a = Math.max(a, (1 - smooth(0, c.w, across)) * 0.8 * (1 - along / c.len))
    }
    for (const c of chips) {
      const dd = Math.hypot(u - Math.cos(c.a) * c.d, v - Math.sin(c.a) * c.d)
      a = Math.max(a, (1 - smooth(c.s * 0.6, c.s, dd)) * 0.7)
    }
    const i = (y * size + x) * 4
    rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.round(255 * shade)
    rgba[i + 3] = Math.round(255 * Math.min(1, a))
  }
  return encodePng(size, size, rgba)
}
