// The Valley's effects, made with the FX Creator (applications/creator/src/fx): the torches' and the
// bonfire's flames, the smoke over the outdoor fires, the blood (the splatter at a wound, the spatter a hit
// leaves and the pool where the player died) and the pond's splashes are each a Creator preset with a seed
// and a few Valley-specific settings, baked headless by tools/valley/genFx.ts -- the solver, renderer and
// exporter the Creator's own Export flipbook uses.
//
// Two fires, one for the torches and one for the bonfire, and their smoke:
//   torch-fire     the torch preset in TALL tiles (128 x 256, 8 x 4): wall and standing torches, the hanging
//                  braziers and, small, the candles
//   bonfire-fire   the bonfire preset, tall too: the bonfire, the fire pits and the hearth
//   bonfire-ignite the bonfire catching, played once when a bonfire is lit, then cross-faded into the loop
//   fire-smoke     the smoke plume preset with its SIX-WAY LIGHTMAPS (lit from right/top/back, left/bottom/
//                  front): a lit sprite over the bonfire and the fire pits, shaded by the sun, its shadows
//                  and the fire's light in the engine
//
// The liquids (Creator presets of the same names) feed the souls blood and the pond (build.mjs):
//   blood-burst    the airborne splatter at a wound, with its SURFACE MAPS (albedo, normal, ORM): a lit
//                  sprite, "Blood Spray", played at the blade's contact point
//   blood-splash   the spatter thrown along the blow: its FLOOR DECAL (an animated pool), at three quarters
//                  of its size, is "Blood Drops"
//   blood-pool     blood pouring down into a pool: its floor decal is the Bloodstain's, where the player died
//   water-splash   the crown a body entering the pond throws up, its sprite
//   water-droplet  looping water drops for the splash's droplets
//
// The presets are the Creator's own, at real-world size (a torch flame 0.45 m tall, a bonfire's 2.4 m): the
// overrides here only frame them for the Valley's tiles.
//
// Baking is cached in build/valley_creator/, keyed by the spec and the generator's source, so a rebuild
// only re-bakes what changed.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'

/**
 * A game flame's look over the presets' physical one: orange through to a yellow core rather than a
 * white-hot one, and next to no smoke -- a sprite's smoke would sit dark over the fire at night, and the
 * embers already rise off it.
 */
const FLAME_LOOK = {
  edgeFade: 0.08,
  fireColorMode: 'gradient', emission: 1.5, fireIntensity: 1, blueCore: 0, smoke: 0, smokeYield: 0.06,
  fireGradient: {
    color: [{ t: 0, c: [0.45, 0.06, 0] }, { t: 0.35, c: [0.95, 0.32, 0.03] }, { t: 0.7, c: [1, 0.62, 0.14] }, { t: 1, c: [1, 0.84, 0.42] }],
    alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }],
  },
}

/** The bonfire's look and its room: FLAME_LOOK in a region wider and taller than the preset's (see below). */
const BONFIRE_ROOM = { ...FLAME_LOOK, regionSize: [2.9, 5.8, 2.9], voxelSize: 0.06 }

export const CREATOR_FX = [
  // A region just wide enough for the flame, so it fills its tall frame: the torch preset's, framed three
  // quarters as wide (its emitter a little wider and higher, its eddies a little smaller), in metres.
  { key: 'torch-fire', name: 'Torch Fire', medium: 'gas', preset: 'torch', seed: 7,
    params: { ...FLAME_LOOK, regionSize: [0.552, 1.104, 0.552], emitterPosition: [0, 0.1165, 0], emitterRadius: 0.0717, turbulenceSize: 0.138, tileSize: 128, tileAspect: 'tall', frames: 32, loopBlend: 8, warmup: 60, view: 'front' } },
  // The bonfire preset: a ball of fuel above the floor (a bed's flames would run out along the floor to the
  // frame's edges, a hard bright band at the sprite's bottom), in a region with ROOM round the flame. The
  // preset's own 2.1 x 4.3 m region is just the 2.4 m flame's width, and the loop used to start while the
  // fire's IGNITION was still in it: the first ball of flame rising and spreading into a mushroom wider than
  // the frame, cut flat at the tile's sides and top, every 0.9 s. 2.9 x 5.8 m (still 1:2, the tall tile) at
  // voxels a little coarser than the preset's, and a warm-up of 160 frames (4.4 s), by which time the
  // ignition has left the region and only the steady fire is filmed (that start is Bonfire Ignition's).
  // 96 frames at 36 fps loop every 2.7 s, long enough that the repeat no longer shows; the last 16
  // cross-fade into the first.
  { key: 'bonfire-fire', name: 'Bonfire Fire', medium: 'gas', preset: 'bonfire', seed: 11,
    params: { ...BONFIRE_ROOM, tileSize: 128, tileAspect: 'tall', frames: 96, loopBlend: 16, warmup: 160, view: 'front' } },
  // The bonfire catching when it is lit: the same fire, from nothing (no warm-up), with a short pressure
  // pulse at the fuel as it goes up (`blast`, the first 0.1 s), so it flares and settles; played once, then
  // cross-faded into Bonfire Fire's loop (ValleyFireLight). Same region and framing, so the two line up.
  { key: 'bonfire-ignite', name: 'Bonfire Ignition', medium: 'gas', preset: 'bonfire', seed: 11,
    params: { ...BONFIRE_ROOM, blast: 8, tileSize: 128, tileAspect: 'tall', frames: 64, loopBlend: 0, warmup: 0, view: 'front' } },
  // The wound 0.9 m behind the region's centre. The Valley lays it at twice its size from
  // SoulsGameManager.bloodDropsOffset (0.9 m) ahead of the target, so it starts at their feet (build.mjs).
  // A column rising off a fire, in tall tiles like the flames; a 1.8 s loop (smoke rises slowly: a shorter
  // one shows its repeat), warmed up until the plume fills its region.
  { key: 'fire-smoke', name: 'Fire Smoke', medium: 'gas', preset: 'smoke-plume', seed: 13,
    params: { bakeSixWay: true, tileSize: 128, tileAspect: 'tall', frames: 64, loopBlend: 16, warmup: 150, view: 'front' } },
  { key: 'blood-burst', name: 'Blood Burst', medium: 'liquid', preset: 'blood-burst', seed: 3, params: { bakeSurfaceMaps: true } },
  { key: 'blood-splash', name: 'Blood Spatter', medium: 'liquid', preset: 'blood-splash', seed: 5, params: { emitterPosition: [0, 1, -0.9] } },
  { key: 'blood-pool', name: 'Blood Pool', medium: 'liquid', preset: 'blood-pool', seed: 6, params: {} },
  { key: 'water-splash', name: 'Water Splash', medium: 'liquid', preset: 'water-splash', seed: 8, params: {} },
  { key: 'water-droplet', name: 'Water Droplets', medium: 'liquid', preset: 'water-droplet', seed: 9, params: {} },
]

/** The sources a bake of each medium reads (applications/creator/src/fx/, then shared ones). */
const SOURCES = {
  shared: ['fxParams.ts', 'fxUnits.ts', 'generateFx.ts', 'flipbook.ts', 'fluidCpu.ts', 'volumeRender.ts', '../core/png.ts', '../core/generator.ts'],
  gas: ['realism.ts', 'blackbody.ts'],
  liquid: ['liquidCpu.ts', 'liquidFilm.ts', 'liquidRender.ts'],
}

/** Hash of every source a bake of `medium` reads: a change to any of them re-bakes those effects. */
function generatorHash(root, medium) {
  const h = crypto.createHash('sha1')
  for (const f of [...SOURCES.shared, ...SOURCES[medium]]) h.update(f).update(fs.readFileSync(path.join(root, 'applications', 'creator', 'src', 'fx', f)))
  h.update(fs.readFileSync(path.join(root, 'tools', 'valley', 'genFx.ts')))
  return h.digest('hex')
}

/**
 * Bake (or reuse) every spec and read it back: `{ spec, dir, manifest, file(name) }`, where `manifest` is
 * genFx.ts's (the sidecar's `output` block, the parameters, the file names) and `file` the path of one of
 * its files.
 */
export function generateCreatorFx(root, buildDir, specs = CREATOR_FX, log = () => {}) {
  const gen = { gas: generatorHash(root, 'gas'), liquid: generatorHash(root, 'liquid') }
  const items = specs.map(spec => {
    const hash = crypto.createHash('sha1').update(gen[spec.medium]).update(JSON.stringify([spec.preset, spec.seed, spec.params ?? {}])).digest('hex').slice(0, 10)
    return { spec, dir: path.join(buildDir, 'valley_creator', `fx-${spec.key}-${hash}`) }
  })
  const missing = items.filter(i => !fs.existsSync(path.join(i.dir, 'manifest.json')))
  if (missing.length) {
    const request = path.join(buildDir, 'valley_creator', 'fx-request.json')
    fs.mkdirSync(path.dirname(request), { recursive: true })
    fs.writeFileSync(request, JSON.stringify({ items: missing.map(({ spec, dir }) => ({
      key: spec.key, preset: spec.preset, seed: spec.seed, params: spec.params ?? {}, outDir: dir,
    })) }))
    log('creator', `baking ${missing.length} FX: ${missing.map(i => i.spec.key).join(', ')}`)
    const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vite-node', '--config', 'applications/creator/vitest.config.ts', 'tools/valley/genFx.ts', request],
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20 })
    if (res.status !== 0) throw new Error(`FX Creator bake failed:\n${res.stdout}\n${res.stderr}`)
    for (const line of res.stdout.trim().split('\n')) if (line.includes(':')) log('creator', line.trim())
  } else log('creator', `${items.length} effects cached in build/valley_creator`)

  return items.map(({ spec, dir }) => ({
    spec, dir,
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
    file: (name) => path.join(dir, name),
  }))
}
