// Where things are in the valley — the numbers from the map's technical reference, in one place.
//
// The heightmap (build/valley_height_4097_16bit.png) was generated with these features CUT into it: the
// building pads are flattened discs, the roads are graded 0.18 m below the ground around them, the gate
// plaza sits at a fixed 4.59 m. So everything here is a position the terrain was shaped for, not a guess
// at one; heights are never stored here, they are sampled from the heightmap at build time.
//
// Conventions (the reference's): metres, Y up, origin = valley centre, north = -Z, east = +X. Yaw in the
// reference is RADIANS about +Y; the engine's node rotations are degrees, converted where a node is built.

/** Heightmap footprint and height decode. Row 0 = z -1024 (north), column 0 = x -1024 (west). */
export const MAP = {
  file: 'valley_height_4097_16bit.png',
  samples: 4097,
  half: 1024,
  cell: 0.5,
  heightMin: -0.84,
  heightSpan: 430.35,
}

/** The landscape this example builds: the whole map, at a 1 m grid (every second heightmap sample). */
export const TERRAIN = { size: 2048, resolution: 2049, chunkQuads: 64 }

/** Valley rim radius by angle (before the generator's domain warp, so an approximation — see uses). */
export function rimRadius(x, z) {
  const a = Math.atan2(z, x)
  return 118 + 13 * Math.sin(3 * a + 0.7) + 7 * Math.sin(5 * a + 2.1) + 4 * Math.sin(9 * a + 4.0)
}

export const SPAWN = { x: -12, z: 82, yawDeg: 180 }        // facing north (-Z)
export const HAMLET = { x: -38, z: 34 }                     // the well; the bonfire stands beside it
export const GATE_PLAZA = { x: 0, z: -130.09, y: 4.59 }
export const NOTCH_HALF_WIDTH = 6.5
export const GATE_FACADE_Z = -141.59
export const WATCHTOWER = { x: 58, z: -44 }
export const POND = { x: 44, z: 22, r: 9.5 }

/** Building pads: flattened discs, each blended into the terrain over a further 6 m. */
export const PADS = [
  { key: 'cottage-a', x: -44, z: 26, r: 9 },
  { key: 'cottage-b', x: -30, z: 42, r: 8 },
  { key: 'shed', x: -52, z: 44, r: 7 },
  { key: 'well', x: -38, z: 34, r: 13 },
  { key: 'tower', x: 58, z: -44, r: 8 },
]

/** Dirt roads: Catmull-Rom through these points. Half-widths are the graded core; the blend is wider. */
export const ROADS = [
  {
    key: 'main', halfWidth: 2.6, blend: 4.5,
    points: [[-12, 82], [-18, 64], [-30, 48], [-31, 30], [-22, 10], [-10, -18], [-4, -50], [-1, -78], [0, -139.6]],
  },
  {
    key: 'side', halfWidth: 1.6, blend: 3,
    points: [[-22, 10], [5, -8], [30, -26], [54, -38]],
  },
]

/** The fences of the reference, as polylines — kept clear of foliage (no fence geometry is built). */
export const FENCES = [
  [[-56, 30], [-54, 18], [-44, 14], [-36, 17]],
  [[-24, 50], [-34, 54], [-46, 54], [-56, 50]],
]

/** Sun: the direction light TRAVELS (from the south-west, high). */
export const SUN_TRAVEL = [0.32, -0.62, -0.72]

/** Catmull-Rom (centripetal-free, uniform) through `pts`, sampled every ~`step` metres. */
export function catmullRom(pts, step = 0.5) {
  const out = []
  const P = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2)
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const n = Math.max(2, Math.ceil(len / step))
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** Distance from (x, z) to a polyline. */
export function distanceToPolyline(x, z, line) {
  let best = Infinity
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1]
    const dx = bx - ax, dz = bz - az
    const len2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2))
    const d = Math.hypot(x - ax - t * dx, z - az - t * dz)
    if (d < best) best = d
  }
  return best
}
