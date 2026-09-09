#!/usr/bin/env node
// Turns animation-only Mixamo .fbx files into the clip sets the Night Shift generator bakes in.
//
//     node tools/nightShift/importClips.mjs zombie
//
// Reads `build/Zombie/`, writes `zombieClips.json` next to this file. It is committed.
//
// ## The player imports nothing
//
// Its clips are the ones already baked into the 3d-example mannequin, read straight off that model asset
// by `build.mjs`. They were briefly imported from `build/Locomotion Pack/` instead — a more faithful
// import, since it kept the travel a Mixamo download carries where the baked ones had theirs destroyed by
// an old retarget bug. But faithful was the wrong thing: the player's gait plays through a blend FIELD,
// and a field never reaches the root-motion path, so that travel went straight into the pose and dragged
// the mesh off its own capsule. The baked clips are in-place already, which is what a field wants.
//
// ## Why the OUTPUT is committed and the input is not
//
// `build/` is gitignored, so the .fbx files cannot be a build input — the night-shift example has to
// regenerate byte-identically on a clean checkout. So this runs ONCE, by hand, when the art changes,
// and its result is committed. `build.mjs` stays a pure function of committed sources. Same bargain
// `packSprites.py` already documents for the pickup atlases.
//
// ## Why the CHARACTER is not re-imported here
//
// The clips retarget onto a skeleton read out of the already-committed `zombieModel.json`, never a fresh
// conversion. The character .fbx is 110 MB and needs an 8 GB heap (see `importZombie.mjs`); its output is
// committed precisely so adding a clip does not drag it along. Retargeting onto the character the project
// actually ships is also what the editor's own import modal does when you drop a clip onto a model.
//
// ## Clip NAMES are a contract
//
// Every `AnimationState.clipName` and every Animation Field sample names its clip as a STRING, resolved
// against the live model at play time. A rename here is a silent break — the state machine reports
// "model does not have clip X" once per frame and the character T-poses. The tables below therefore
// reproduce the names the shipped example already uses, and the zombie's five are prefixed `Zombie`
// only because the two characters now share their rigs: an unprefixed `Idle` on both would collide, and
// `AnimatedModel.addAnimation` resolves a collision by de-duping to `Idle (2)`.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  editorModules, engineModules, importClipFile, loadAssimp, retargetTargetOf,
} from './fbxImport.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const SETS = {
  /**
   * The zombie's own clips, native to its `mixamorig5:` rig.
   *
   * `Zombie Running` is imported but unused: a shambler never runs, and the state machine has two gaits
   * only. It is here so the rig owns the whole downloaded set rather than a subset chosen once.
   */
  zombie: {
    dir: path.join(ROOT, 'build', 'Zombie'),
    out: path.join(HERE, 'zombieClips.json'),
    target: () => readJson(path.join(HERE, 'zombieModel.json')).skin,
    targetHint: 'tools/nightShift/zombieModel.json — run importZombie.mjs',
    clips: {
      'Zombie Idle.fbx': 'Zombie Idle',
      'Zombie Walk.fbx': 'Zombie Walk',
      'Zombie Running.fbx': 'Zombie Running',
      'Zombie Attack.fbx': 'Zombie Attack',
      'Zombie Dying.fbx': 'Zombie Dying',
    },
    // Idle and Walk are driven by steering, so a travelling Walk would fight the controller and slide
    // the whole horde across the map. The attack is a stationary swing — the behaviour state that plays
    // it sets `speedScale: 0`. Only the death collapse travels.
    rootMotion: new Set(['Zombie Dying']),
  },
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

async function importSet(ctx, loadSkin, name) {
  const set = SETS[name]
  if (!fs.existsSync(set.dir)) {
    throw new Error(`missing ${path.relative(ROOT, set.dir)} — the source .fbx files are not checked in`)
  }

  let stored
  try {
    stored = set.target()
  } catch (err) {
    throw new Error(`cannot read the target skeleton (${set.targetHint}): ${err.message}`)
  }
  const target = retargetTargetOf(loadSkin, stored)

  console.log(`${name}: ${Object.keys(set.clips).length} clips onto ${target.joints.length} joints`
    + ` (${path.relative(ROOT, set.dir)})`)

  const clips = []
  for (const [file, clipName] of Object.entries(set.clips)) {
    const res = await importClipFile(
      ctx, path.join(set.dir, file), clipName, target, { rootMotion: set.rootMotion.has(clipName) })
    clips.push(res.clip)
    console.log(`  ${clipName.padEnd(16)} ${res.seconds.toFixed(2).padStart(6)}s`
      + `  ${String(res.clip.channels.length).padStart(3)} channels`
      + `  rig ratio ${res.ratio.toFixed(3)}${res.sameRig ? ' (raw)' : ' (delta)'}`
      + `${res.clip.rootMotion ? '  rootMotion' : ''}`
      // How far the clip WOULD have travelled. A large number here on a gait is the whole reason this
      // pass exists; a zero means the download was already in-place.
      + `${res.held > 0.5 ? `  held ${(res.held / 100).toFixed(2)}m in place` : ''}`)
  }

  // Names must be unique inside one set, or `addAnimation` de-dupes the loser to "Walk (2)" and every
  // state machine naming it stops resolving.
  const names = clips.map(c => c.name)
  const duplicated = names.filter((n, i) => names.indexOf(n) !== i)
  if (duplicated.length) throw new Error(`${name}: duplicate clip names ${duplicated.join(', ')}`)

  fs.writeFileSync(set.out, JSON.stringify(clips))
  const mb = (fs.statSync(set.out).size / 1024 / 1024).toFixed(2)
  console.log(`  wrote ${path.relative(ROOT, set.out)} (${mb} MB)\n`)
}

async function main() {
  const wanted = process.argv.slice(2)
  const names = wanted.length ? wanted : Object.keys(SETS)

  for (const name of names) {
    if (!SETS[name]) throw new Error(`unknown set "${name}" — expected one of ${Object.keys(SETS).join(', ')}`)
  }

  const ajs = await loadAssimp(ROOT)
  const ctx = { ajs, ...engineModules(ROOT) }
  const { loadSkin } = editorModules(ROOT)

  for (const name of names) await importSet(ctx, loadSkin, name)
  console.log('Next:  node tools/nightShift/build.mjs')
}

await main()
