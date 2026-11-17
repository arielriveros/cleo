// A contact sheet of terrains for tools/world: each tile the terrain from above (hillshade, water in blue)
// over a low oblique view from its south edge at TRUE proportions (no vertical exaggeration), so a terrain
// too tall for its map looks it.

import fs from 'fs'
import { encodePngRgba8 } from '../../applications/creator/src/core/png'
import { WATER_DRY } from '../../applications/creator/src/world/lakes'

const TILE = 420, VIEW_H = 260, GAP = 6
const SKY = [120, 140, 165]

export class Sheet {
  readonly width: number
  readonly height: number
  private readonly px: Uint8Array

  constructor(count: number, private readonly cols = Math.min(4, count)) {
    const rows = Math.ceil(count / cols)
    this.width = cols * (TILE + GAP) - GAP
    this.height = rows * (TILE + VIEW_H + GAP) - GAP
    this.px = new Uint8Array(this.width * this.height * 4)
    for (let i = 0; i < this.width * this.height; i++) this.px.set([18, 20, 26, 255], i * 4)
  }

  private put(x: number, y: number, rgb: number[]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const o = (y * this.width + x) * 4
    this.px[o] = rgb[0]; this.px[o + 1] = rgb[1]; this.px[o + 2] = rgb[2]
  }

  /**
   * Tile `k`: heights `hm` (metres, res², row 0 at the -Z edge) on a map `size` metres across, the sea at
   * `sea`; `water` (optional) the water pass's kind and level per cell.
   */
  tile(k: number, hm: Float32Array, res: number, size: number, sea: number, water?: { kind: Uint8Array; level: Float32Array }): void {
    const R = res, cell = size / (R - 1)
    let lo = Infinity, hi = -Infinity
    for (const v of hm) { if (v < lo) lo = v; if (v > hi) hi = v }
    const shade = new Float32Array(R * R)
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      const hx = (hm[y * R + Math.min(R - 1, x + 1)] - hm[y * R + Math.max(0, x - 1)]) / (2 * cell)
      const hy = (hm[Math.min(R - 1, y + 1) * R + x] - hm[Math.max(0, y - 1) * R + x]) / (2 * cell)
      const l = Math.max(0, (hx * 0.6 + hy * 0.6 + 1) / Math.sqrt(1 + hx * hx + hy * hy) / 1.5)
      shade[y * R + x] = 0.3 + 0.7 * l
    }
    const wetAt = (i: number) => water ? water.kind[i] !== WATER_DRY : hm[i] <= sea
    const colour = (i: number): number[] => {
      if (wetAt(i)) return [40 * shade[i] + 20, 80 * shade[i] + 30, 150 * shade[i] + 40]
      const floor = Math.max(sea, lo)
      const t = Math.min(1, Math.max(0, (hm[i] - floor) / Math.max(1, hi - floor)))
      // Low green, mid ochre, high grey.
      const base = t < 0.5 ? [95 + 140 * t, 120 + 40 * t, 70 + 40 * t] : [165 - 40 * (t - 0.5), 140 + 20 * (t - 0.5), 90 + 120 * (t - 0.5)]
      return base.map(v => v * shade[i])
    }
    const ox = (k % this.cols) * (TILE + GAP), oy = Math.floor(k / this.cols) * (TILE + VIEW_H + GAP)
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const i = Math.round(y / (TILE - 1) * (R - 1)) * R + Math.round(x / (TILE - 1) * (R - 1))
      this.put(ox + x, oy + y, colour(i))
    }
    // From beyond the south edge, low: a voxel-space march, near to far.
    const camX = size / 2, camZ = size * 1.12, camH = hi + size * 0.12
    const focal = (TILE / 2) / Math.tan(30 * Math.PI / 180), horizon = VIEW_H * 0.22
    const ybuf = new Float32Array(TILE).fill(VIEW_H)
    for (let y = 0; y < VIEW_H; y++) for (let x = 0; x < TILE; x++) this.put(ox + x, oy + TILE + y, SKY.map(v => v * (0.75 + 0.25 * y / VIEW_H)))
    for (let z = size * 0.12; z < size * 1.15; z += Math.max(cell * 0.5, z * 0.002)) {
      const half = z * Math.tan(30 * Math.PI / 180)
      for (let x = 0; x < TILE; x++) {
        const wx = camX - half + (2 * half) * (x + 0.5) / TILE, wz = camZ - z
        if (wx < 0 || wz < 0 || wx > size || wz > size) continue
        const i = Math.round(wz / cell) * R + Math.round(wx / cell)
        const h = water && water.kind[i] !== WATER_DRY ? Math.max(hm[i], water.level[i]) : Math.max(hm[i], water ? -Infinity : sea)
        const sy = (camH - h) / z * focal + horizon
        if (sy >= ybuf[x]) continue
        const fog = Math.min(1, z / (size * 1.6))
        const rgb = colour(i).map((v, j) => v * (1 - fog) + SKY[j] * fog)
        for (let y = Math.max(0, Math.floor(sy)); y < ybuf[x]; y++) this.put(ox + x, oy + TILE + y, rgb)
        ybuf[x] = Math.max(0, sy)
      }
    }
  }

  async save(path: string): Promise<void> {
    fs.writeFileSync(path, await encodePngRgba8(this.width, this.height, this.px))
  }
}
