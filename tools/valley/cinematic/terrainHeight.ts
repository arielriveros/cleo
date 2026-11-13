// The shipped Valley landscape's height at a world x/z: the u16 grid in its node's `terrain.heights`
// (base64 once the bundle is read), bilinear, the landscape at the origin. The same decode
// tests/valleyProject.test.ts checks the map with.

export type HeightAt = (x: number, z: number) => number

export function terrainHeightSampler(sceneRoot: any): HeightAt {
  const find = (n: any): any => n?.type === 'landscape' ? n : (n?.children ?? []).map(find).find(Boolean)
  const landscape = find(sceneRoot)
  if (!landscape) throw new Error('no landscape in the Valley scene')
  const t = landscape.terrain
  const raw: any = t.heights
  const bytes = typeof raw === 'string' ? new Uint8Array(Buffer.from(raw, 'base64')) : new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength)
  const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const R: number = t.resolution, size: number = t.size
  const grid = new Float32Array(u16.length)
  for (let i = 0; i < u16.length; i++) grid[i] = t.heightMin + (u16[i] / 65535) * (t.heightMax - t.heightMin)
  const e = size / (R - 1)
  const ox = landscape.position?.[0] ?? 0, oz = landscape.position?.[2] ?? 0, oy = landscape.position?.[1] ?? 0
  return (x: number, z: number) => {
    const fx = Math.min(R - 1.001, Math.max(0, (x - ox + size / 2) / e))
    const fz = Math.min(R - 1.001, Math.max(0, (z - oz + size / 2) / e))
    const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r
    const at = (cc: number, rr: number) => grid[rr * R + cc]
    const a = at(c, r) + (at(c + 1, r) - at(c, r)) * tx
    const b = at(c, r + 1) + (at(c + 1, r + 1) - at(c, r + 1)) * tx
    return oy + a + (b - a) * tz
  }
}
