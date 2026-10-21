// The valley's height field, read once from the 16-bit heightmap and queried by everything else.
//
// Two grids, on purpose:
//   - the FULL 4097² field at 0.5 m — what the map was authored at; used where only accuracy matters
//     (does a pad read flat, how high is the plaza);
//   - the TERRAIN grid, every second sample (2049² at 1 m) — exactly the heights the landscape ships, so
//     anything that must sit ON the rendered surface (a prop, a pine, a spawn point) is placed by it.
// A pine placed by the 0.5 m field on a 1 m mesh floats or sinks by up to a few centimetres per metre of
// local curvature; on a cliff foot that is a visible gap.
//
// The PNG is decoded by the engine's own heightmapIO.ts (byte for byte, 16 bits), not re-implemented.

import fs from 'fs'
import path from 'path'
import { moduleRegistry } from '../exampleKit/tsLoader.mjs'
import { MAP, TERRAIN } from './layout.mjs'

export async function loadHeights(root, buildDir) {
  const { decodePng } = moduleRegistry()(path.join(root, 'src', 'terrain', 'heightmapIO.ts'))
  const img = await decodePng(new Uint8Array(fs.readFileSync(path.join(buildDir, MAP.file))))
  if (img.width !== MAP.samples || img.height !== MAP.samples)
    throw new Error(`${MAP.file} is ${img.width}x${img.height}; the reference says ${MAP.samples}²`)
  if (img.bitDepth !== 16) throw new Error(`${MAP.file} is ${img.bitDepth}-bit; a 16-bit map was expected`)

  const N = MAP.samples
  const full = new Float32Array(N * N)
  for (let i = 0; i < full.length; i++) full[i] = MAP.heightMin + img.data[i] * MAP.heightSpan

  const R = TERRAIN.resolution
  const step = (N - 1) / (R - 1)
  if (!Number.isInteger(step)) throw new Error('the terrain grid must be a subsample of the heightmap')
  const grid = new Float32Array(R * R)
  for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) grid[r * R + c] = full[(r * step) * N + c * step]

  const element = TERRAIN.size / (R - 1)
  const half = TERRAIN.size / 2

  const bilinear = (data, n, spacing, x, z) => {
    const fx = Math.min(Math.max((x + half) / spacing, 0), n - 1)
    const fz = Math.min(Math.max((z + half) / spacing, 0), n - 1)
    const c0 = Math.min(Math.floor(fx), n - 2), r0 = Math.min(Math.floor(fz), n - 2)
    const tx = fx - c0, tz = fz - r0
    const a = data[r0 * n + c0], b = data[r0 * n + c0 + 1]
    const c = data[(r0 + 1) * n + c0], d = data[(r0 + 1) * n + c0 + 1]
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz
  }

  /** Height of the shipped (1 m) surface at world x/z. */
  const heightAt = (x, z) => bilinear(grid, R, element, x, z)
  /** Height of the authored (0.5 m) field at world x/z. */
  const fineHeightAt = (x, z) => bilinear(full, N, MAP.cell, x, z)
  /** Unit surface normal of the shipped surface — central differences over one grid cell. */
  const normalAt = (x, z) => {
    const e = element
    const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e)
    const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e)
    const l = Math.hypot(dx, 1, dz)
    return [-dx / l, 1 / l, -dz / l]
  }
  /** Slope in degrees, 0 flat .. 90 vertical (the unit the landscape material's rules use). */
  const slopeAt = (x, z) => Math.acos(Math.min(1, normalAt(x, z)[1])) * 180 / Math.PI

  /** The terrain's serialized height blob (Terrain.serialize's shape: u16 over its own range). */
  const serialize = () => {
    let min = Infinity, max = -Infinity
    for (const h of grid) { if (h < min) min = h; if (h > max) max = h }
    const span = (max - min) || 1
    const u16 = new Uint16Array(grid.length)
    for (let i = 0; i < grid.length; i++) u16[i] = Math.round(((grid[i] - min) / span) * 65535)
    return { heightFormat: 'u16', heightMin: min, heightMax: max, heights: Buffer.from(u16.buffer).toString('base64') }
  }

  return { full, grid, heightAt, fineHeightAt, normalAt, slopeAt, serialize, element }
}
