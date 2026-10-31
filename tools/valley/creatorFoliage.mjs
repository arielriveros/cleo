// The Valley's plants, made with the Foliage Creator (applications/creator/src/foliage): every tree, bush
// and grass clump is a Creator preset with a seed and a few Valley-specific settings, generated headless
// by tools/valley/genFoliage.ts -- the generator, LOD ladder, materials and octahedral impostor the
// Creator's own Download writes. Nothing here is scanned or downloaded.
//
// `bark` names a scanned bark set (prepare.py `barks`) the tree wears instead of the generated bark: its
// colour, normal and ARM maps in the library material, and its colour in the impostor bake.
//
// `group` says where build.mjs scatters a prototype:
//   pine        the belt at the cliff foot, the stands in the valley and the trees about the hamlet and
//               the pond (split between the variants)
//   highland    the sparse forest beyond the rim
//   grass       the meadow, weighted by `rule.density`
//   undergrowth the Forest Floor surface (its own foliageInclude)
//   bush        forest edges, building walls and fences
//
// Generation is cached in build/valley_creator/, keyed by the spec and the generator's source, so a
// rebuild only regenerates what changed.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'

/** Trees switch to their impostor here, and are culled at the horizon. */
export const TREE_IMPOSTOR = 50
export const TREE_CULL = 450
/** Every tree's impostor: 8 x 8 views of 256 px, as the scanned pine's was. */
const TREE_IMPOSTOR_PARAMS = { impostor: true, impostorDistance: TREE_IMPOSTOR, cullDistance: TREE_CULL, impostorFrames: 8, impostorFrameSize: 256 }
/** Texture sizes: bark and leaf atlases at 512, grass at 256. */
const PLANT_TEXTURES = { barkTextureSize: 512, leafTextureSize: 512 }

export const CREATOR_FOLIAGE = [
  // --- Trees, all conifers. A tall pine sways a few percent of its height at full gust.
  ...[['a', 11], ['b', 23]].map(([v, seed]) => ({
    key: `pine-${v}`, name: `Scots Pine ${v.toUpperCase()}`, kind: 'tree', preset: 'pine', seed, group: 'pine', bark: 'bark_pine',
    params: { ...TREE_IMPOSTOR_PARAMS, ...PLANT_TEXTURES, windStrength: 0.03, windStiffness: 2.2, windFlutter: 0.4 },
    rule: { density: 0.004, minScale: 0.6, maxScale: 0.95, castShadows: true, cameraDither: true }, cellSize: 40,
  })),
  {
    key: 'spruce', name: 'Spruce', kind: 'tree', preset: 'spruce', seed: 5, group: 'highland', bark: 'bark_pine',
    params: { ...TREE_IMPOSTOR_PARAMS, ...PLANT_TEXTURES, windStrength: 0.03, windStiffness: 2.2 },
    rule: { density: 0.0014, minScale: 0.7, maxScale: 1.05, castShadows: true, cameraDither: true }, cellSize: 40,
  },

  // --- Grass: two meadow variants and a sprinkle of tall grass through them.
  ...[['a', 1], ['b', 2]].map(([v, seed]) => ({
    key: `grass-${v}`, name: `Meadow Grass ${v.toUpperCase()}`, kind: 'grass', preset: 'meadow', seed, group: 'grass',
    params: { cullDistance: 22 },
    rule: { density: 0.5, minScale: 0.8, maxScale: 1.25, castShadows: false }, cellSize: 13,
  })),
  {
    key: 'grass-tall', name: 'Tall Grass', kind: 'grass', preset: 'tallGrass', seed: 4, group: 'grass',
    params: { cullDistance: 30 },
    rule: { density: 0.12, minScale: 0.75, maxScale: 1.1, castShadows: false }, cellSize: 13,
  },

  // --- The undergrowth of the Forest Floor.
  ...[['a', 6], ['b', 8]].map(([v, seed]) => ({
    key: `undergrowth-${v}`, name: `Forest Undergrowth ${v.toUpperCase()}`, kind: 'bush', preset: 'fernBush', seed, group: 'undergrowth',
    params: { ...PLANT_TEXTURES, leafTextureSize: 256, barkTextureSize: 128 },
    rule: { density: 0.045, minScale: 0.8, maxScale: 1.3, castShadows: false }, cellSize: 16,
  })),
  {
    key: 'boxwood', name: 'Boxwood', kind: 'bush', preset: 'boxwood', seed: 12, group: 'undergrowth',
    params: { leafTextureSize: 256, barkTextureSize: 128 },
    rule: { density: 0.012, minScale: 0.8, maxScale: 1.3, castShadows: false }, cellSize: 16,
  },

  // --- Bushes on the ground: at the forest's edge, against the buildings and along the fences.
  ...[['a', 4], ['b', 9]].map(([v, seed]) => ({
    key: `shrub-${v}`, name: `Shrub ${v.toUpperCase()}`, kind: 'bush', preset: 'shrub', seed, group: 'bush',
    params: { leafTextureSize: 256, barkTextureSize: 256, cullDistance: 90 },
    rule: { density: 0.004, minScale: 0.85, maxScale: 1.35, castShadows: true }, cellSize: 24,
  })),
  {
    key: 'juniper', name: 'Juniper', kind: 'bush', preset: 'juniper', seed: 2, group: 'bush',
    params: { leafTextureSize: 256, barkTextureSize: 256, cullDistance: 90 },
    rule: { density: 0.004, minScale: 0.85, maxScale: 1.3, castShadows: true }, cellSize: 24,
  },
]

/** Hash of every source the generator reads: a change to any of them regenerates everything. */
function generatorHash(root) {
  const h = crypto.createHash('sha1')
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'ui') walk(p) } else if (/\.ts$/.test(e.name)) h.update(e.name).update(fs.readFileSync(p))
    }
  }
  walk(path.join(root, 'applications', 'creator', 'src', 'foliage'))
  for (const f of ['applications/creator/src/core/png.ts', 'src/terrain/octahedralBake.ts', 'tools/valley/genFoliage.ts'])
    h.update(fs.readFileSync(path.join(root, f)))
  return h.digest('hex')
}

/**
 * Generate (or reuse) every spec and read it back: `{ spec, manifest, dir, levels }`, where `levels` is
 * `[{ distance, parts: [{ name, material, positions, normals, uvs, indices }] }]` in meshes.mjs's part
 * shape (engine uvs, base centre at the origin).
 */
export function generateCreatorFoliage(root, buildDir, specs, log = () => {}) {
  const gen = generatorHash(root)
  const barkImage = (spec) => spec.bark ? { file: path.join(buildDir, 'valley_prepared', `${spec.bark}_diff_512.rgba`), width: 512, height: 512 } : undefined
  const items = specs.map(spec => {
    const hash = crypto.createHash('sha1').update(gen).update(JSON.stringify([spec.kind, spec.preset, spec.seed, spec.params ?? {}, spec.bark ?? null]))
      .update(spec.bark ? fs.readFileSync(barkImage(spec).file) : '').digest('hex').slice(0, 10)
    return { spec, dir: path.join(buildDir, 'valley_creator', `${spec.key}-${hash}`) }
  })
  const missing = items.filter(i => !fs.existsSync(path.join(i.dir, 'manifest.json')))
  if (missing.length) {
    const request = path.join(buildDir, 'valley_creator', 'request.json')
    fs.mkdirSync(path.dirname(request), { recursive: true })
    fs.writeFileSync(request, JSON.stringify({ items: missing.map(({ spec, dir }) => ({
      key: spec.key, kind: spec.kind, preset: spec.preset, seed: spec.seed, params: spec.params ?? {}, barkImage: barkImage(spec), outDir: dir,
    })) }))
    const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vite-node', '--config', 'applications/creator/vitest.config.ts', 'tools/valley/genFoliage.ts', request],
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20 })
    if (res.status !== 0) throw new Error(`Foliage Creator generation failed:\n${res.stdout}\n${res.stderr}`)
    for (const line of res.stdout.trim().split('\n')) if (line.includes(':')) log('creator', line.trim())
  } else log('creator', `${items.length} plants cached in build/valley_creator`)

  return items.map(({ spec, dir }) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    const levels = manifest.levels.map(level => ({
      distance: level.distance,
      parts: level.parts.map(p => {
        const b = fs.readFileSync(path.join(dir, p.file))
        const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
        const v = p.vertices, n = p.indices
        return {
          name: p.name, material: p.material,
          positions: new Float32Array(buf, 0, v * 3),
          normals: new Float32Array(buf, v * 12, v * 3),
          uvs: new Float32Array(buf, v * 24, v * 2),
          indices: new Uint32Array(buf, v * 32, n),
        }
      }),
    }))
    return { spec, manifest, dir, levels }
  })
}
