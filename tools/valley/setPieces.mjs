// The Valley's set pieces built from scanned models: the breakable barrel (and its debris), and the skull
// cave that replaced the boss's fog wall. Geometry only -- materials, templates and placement are the
// generator's (build.mjs), which owns the texture and material registries.

import fs from 'fs'
import path from 'path'
import { mat3, mat4, quat, vec3 } from 'gl-matrix'
import { boundsOf, decimate, mergeParts, normalizeParts, partsOf, readGltf } from './meshes.mjs'

// ---------------------------------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------------------------------

/** Transform a part's positions and normals in place by `m`. */
function transformPart(part, m) {
  const nm = mat3.normalFromMat4(mat3.create(), m)
  const v = vec3.create()
  for (let k = 0; k < part.positions.length; k += 3) {
    vec3.transformMat4(v, [part.positions[k], part.positions[k + 1], part.positions[k + 2]], m)
    part.positions.set(v, k)
    vec3.transformMat3(v, [part.normals[k], part.normals[k + 1], part.normals[k + 2]], nm)
    vec3.normalize(v, v)
    part.normals.set(v, k)
  }
  return part
}

/** A rotation taking axis `from` (0 x, 1 y, 2 z) onto axis `to`. */
function axisRotation(from, to) {
  const a = [0, 0, 0], b = [0, 0, 0]
  a[from] = 1; b[to] = 1
  return quat.rotationTo(quat.create(), a, b)
}

/**
 * The intact barrel and its 17 broken pieces, from build/props/wooden_barrels_01_1k.gltf.
 *
 * The file lays the pieces out FLAT, as a display, not where they sat in a barrel. They are re-posed here
 * into the intact shape -- staves and shell chunks upright round the rim, lid and bottom planks flat at
 * the ends, hoops round the middle -- so the debris spawns standing where the barrel was and bursts out
 * of it. Each piece keeps its own centre as its node position (geometry centred on it), which is what
 * SoulsDebris fits each piece's box to.
 */
export function buildBarrel(file) {
  const doc = readGltf(file)
  const meshOf = (name) => mergeParts(partsOf(doc, { filter: n => n.name === name, transform: () => mat4.create() }), name, 0)

  const barrel = meshOf('wooden_barrels_01_barrel01')
  normalizeParts([barrel])
  const b = boundsOf([barrel])
  const H = b.size[1], R = Math.max(b.size[0], b.size[2]) / 2

  const pieces = []
  for (let i = 1; i <= 17; i++) {
    const name = `wooden_barrels_01_piece${String(i).padStart(2, '0')}`
    const part = meshOf(name)
    // Centred on its own box first.
    const pb = boundsOf([part])
    const centre = [0, 1, 2].map(a => (pb.min[a] + pb.max[a]) / 2)
    transformPart(part, mat4.fromTranslation(mat4.create(), centre.map(v => -v)))
    const size = pb.size
    const longest = size.indexOf(Math.max(...size))
    const thinnest = size.indexOf(Math.min(...size))

    let rotation, position
    if (i <= 7) {
      // Shell chunks and staves: upright, thin side facing out, spaced round the rim.
      const up = axisRotation(longest, 1)
      const thinAfter = vec3.transformQuat(vec3.create(), [thinnest === 0 ? 1 : 0, thinnest === 1 ? 1 : 0, thinnest === 2 ? 1 : 0], up)
      const angle = (i - 1) / 7 * Math.PI * 2
      const outward = [Math.cos(angle), 0, Math.sin(angle)]
      const face = quat.rotationTo(quat.create(), vec3.normalize(vec3.create(), [thinAfter[0], 0, thinAfter[2]]), outward)
      rotation = quat.multiply(quat.create(), face, up)
      const thick = Math.min(...size)
      const r = Math.max(0.05, R - thick / 2 - 0.01)
      position = [outward[0] * r, H / 2, outward[2] * r]
    } else if (i <= 14) {
      // Lid and bottom planks: flat, side by side.
      rotation = axisRotation(thinnest, 1)
      const top = i <= 11
      const k = top ? i - 8 : i - 12
      const n = top ? 4 : 3
      position = [((k + 0.5) / n - 0.5) * R * 1.6, top ? H - 0.03 : 0.03, 0]
    } else {
      // Hoop fragments: flat, round the middle.
      rotation = axisRotation(thinnest, 1)
      const angle = (i - 15) / 3 * Math.PI * 2
      position = [Math.cos(angle) * R * 0.85, H * (0.25 + (i - 15) * 0.25), Math.sin(angle) * R * 0.85]
    }
    transformPart(part, mat4.fromQuat(mat4.create(), rotation))
    pieces.push({ name: `Piece ${String(i).padStart(2, '0')}`, part, position: position.map(v => Math.round(v * 1000) / 1000) })
  }
  return { barrel, pieces, height: H, radius: R }
}

// ---------------------------------------------------------------------------------------------------
// Skull cave
// ---------------------------------------------------------------------------------------------------

/**
 * The skull cave, decimated to `ratio` and scaled to `width` metres across, base centre at the origin,
 * the skull's face (and the arch through it) toward +Z. 813k triangles at the source: the decimation is
 * cached under build/valley_cache, keyed by the ratio, since it is the slowest step of a rebuild.
 */
export function buildSkullCave(root, file, { ratio = 0.075, width = 14 } = {}) {
  const cacheDir = path.join(root, 'build', 'valley_cache')
  const cache = path.join(cacheDir, `skull_cave_${ratio}.json`)
  let part
  if (fs.existsSync(cache)) {
    const j = JSON.parse(fs.readFileSync(cache, 'utf8'))
    part = {
      name: 'Skull Cave', material: 0, positions: Float32Array.from(j.positions), normals: Float32Array.from(j.normals),
      uvs: Float32Array.from(j.uvs), indices: Uint32Array.from(j.indices),
    }
  } else {
    const source = mergeParts(partsOf(readGltf(file)), 'Skull Cave', 0)
    part = decimate(root, source, ratio)
    part.name = 'Skull Cave'
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(cache, JSON.stringify({
      positions: Array.from(part.positions), normals: Array.from(part.normals), uvs: Array.from(part.uvs), indices: Array.from(part.indices),
    }))
  }
  const b = boundsOf([part])
  normalizeParts([part], { scale: width / b.size[0] })
  return part
}
