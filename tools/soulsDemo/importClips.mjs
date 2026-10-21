#!/usr/bin/env node
// Turns the Mixamo combat .fbx downloads in `build/animations/` into the clips the souls generator bakes in.
//
//     node tools/soulsDemo/importClips.mjs
//
// Writes `soulsClips.json` next to this file. It is COMMITTED, because `build/` is gitignored and the
// examples must regenerate byte-identically on a clean checkout. The fold-map-retarget path is the one in
// tools/exampleKit/fbxImport.mjs.
//
// ## Names are a contract
//
// An imported clip takes the name of the PLACEHOLDER it replaces (`Souls_Sword_L1`, `Souls_Roll`...), so
// every move, script field and test that names one keeps working; `build.mjs` drops the placeholder of
// the same name. Clips with no placeholder before them get new `Souls_` names.
//
// ## In place
//
// Actions ignore root motion (only the base layer drives it), and the souls scripts already move the
// body during a swing with their own `lunge*` fields. So every clip is held in place except:
//  - the two deaths, which play as the base Dead state and keep their fall;
//  - the roll ('travel'), which keeps its travel: the player plays it as an action with `rootMotion`,
//    so the animator EXTRACTS the ground-plane travel and SoulsPlayer moves the body by exactly it.
//
// ## Downloaded on a different character
//
// These were downloaded on a smaller Mixamo character (hips rest ratio ~0.8 to the mannequin), so the
// importer's 0.9-1.1 guard is widened: the retarget scales the hips by that ratio, which is exactly
// right for in-place clips, and the two deaths' fall distance comes out at the mannequin's size.
//
// ## Markers
//
// The scripts open the blade's damage window on a clip's `hit` event and close it on `hitEnd`; `combo`
// opens the chain to the next swing and `recover` lets a roll cancel the rest. A Mixamo download carries
// none of that, so it is MEASURED: the right hand's speed over the clip, whose peaks are where the
// swing is moving fastest. Each peak becomes a short hit window. `MARKER_OVERRIDES` pins anything the
// measurement gets wrong.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as glMatrix from 'gl-matrix'
import { editorModules, engineModules, importClipFile, loadAssimp, retargetTargetOf } from '../exampleKit/fbxImport.mjs'

const { mat4, quat, vec3 } = glMatrix
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const DIR = path.join(ROOT, 'build', 'animations')
const OUT = path.join(HERE, 'soulsClips.json')
const MANNEQUIN_MODEL = '93cbfa0b91ad0e985b9993b34e60ad7a'

/**
 * file -> [clip name, kind]. kind: 'attack' (hit windows, combo, recover), 'combo' (an attack with up
 * to three swings), 'move' (no markers), 'death' (root motion kept), 'taunt' (one `roar` marker).
 * A file listed twice is imported twice, under both names.
 */
const CLIPS = [
  ['Stable Sword Inward Slash.fbx', 'Souls_Sword_L1', 'attack'],
  ['Stable Sword Outward Slash.fbx', 'Souls_Sword_L2', 'attack'],
  ['Standing Melee Attack Downward (1).fbx', 'Souls_Sword_L3', 'attack'],
  ['Thrust Slash.fbx', 'Souls_Sword_Heavy', 'attack'],
  ['Standing Melee Attack Backhand.fbx', 'Souls_GS_L1', 'attack'],
  ['Standing Melee Attack 360 High.fbx', 'Souls_GS_L2', 'attack'],
  ['Standing Melee Attack Downward (1).fbx', 'Souls_GS_Heavy', 'attack'],
  ['Standing Dive Forward (1).fbx', 'Souls_Roll', 'travel'],
  ['Standing React Large From Left.fbx', 'Souls_HitHeavy', 'move'],
  ['Standing Death Right 02.fbx', 'Souls_Death', 'death'],
  ['Sheathing Sword.fbx', 'Souls_Sheath', 'move'],
  ['Withdrawing Sword.fbx', 'Souls_Draw', 'move'],
  ['Stable Sword Outward Slash.fbx', 'Souls_Enemy_Swing', 'attack'],
  ['Standing Melee Attack Backhand.fbx', 'Souls_Enemy_Sweep', 'attack'],
  ['Standing Melee Attack Downward (1).fbx', 'Souls_Enemy_Overhead', 'attack'],
  ['Thrust Slash.fbx', 'Souls_Enemy_Thrust', 'attack'],
  ['Standing Melee Combo Attack Ver. 1.fbx', 'Souls_Knight_Combo1', 'combo'],
  ['Standing Melee Combo Attack Ver. 2.fbx', 'Souls_Knight_Combo2', 'combo'],
  ['Standing Melee Run Jump Attack.fbx', 'Souls_Leap', 'attack'],
  ['Standing Taunt Battlecry.fbx', 'Souls_Battlecry', 'taunt'],
  ['Dying.fbx', 'Souls_Dying', 'death'],
  ['Run With Sword.fbx', 'Souls_RunWithSword', 'move'],
]

/** Hand-pinned marker times (seconds) where the measured ones are wrong. `{ clip: { hit: [..] } }`. */
const MARKER_OVERRIDES = {}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const r3 = (v) => Math.round(v * 1000) / 1000

// ----- forward kinematics over a clip --------------------------------------------------------------

/** The clip's value for one channel at time t (linear / slerp; STEP holds). */
function sample(clip, channel, t) {
  const s = clip.samplers[channel.samplerIndex]
  const n = channel.targetPath === 'rotation' ? 4 : 3
  const input = s.input, out = s.output
  if (t <= input[0]) return out.slice(0, n)
  const last = input.length - 1
  if (t >= input[last]) return out.slice(last * n, last * n + n)
  let i = 0
  while (i < last - 1 && input[i + 1] < t) i++
  const a = out.slice(i * n, i * n + n), b = out.slice((i + 1) * n, (i + 1) * n + n)
  const k = (t - input[i]) / Math.max(1e-9, input[i + 1] - input[i])
  if (s.interpolation === 'STEP') return a
  if (n === 4) return Array.from(quat.slerp(quat.create(), a, b, k))
  return a.map((v, j) => v + (b[j] - v) * k)
}

/** World position of `node` at time t: rest transforms with the clip's channels applied, root to node. */
function worldPosition(clip, skin, node, t, cache) {
  const chain = []
  for (let n = node; n !== undefined && n !== -1; n = skin.nodeParents.get(n)) chain.unshift(n)
  let world = mat4.create()
  for (const n of chain) {
    const rest = skin.nodeTransforms.get(n) ?? mat4.create()
    const tr = mat4.getTranslation(vec3.create(), rest)
    const rot = mat4.getRotation(quat.create(), rest)
    const scl = mat4.getScaling(vec3.create(), rest)
    for (const c of cache.get(n) ?? []) {
      const v = sample(clip, c, t)
      if (c.targetPath === 'translation') vec3.set(tr, v[0], v[1], v[2])
      else if (c.targetPath === 'rotation') quat.set(rot, v[0], v[1], v[2], v[3])
      else if (c.targetPath === 'scale') vec3.set(scl, v[0], v[1], v[2])
    }
    world = mat4.multiply(world, world, mat4.fromRotationTranslationScale(mat4.create(), rot, tr, scl))
  }
  return mat4.getTranslation(vec3.create(), world)
}

/**
 * Hit windows from the right hand's speed: its fastest moments, one per swing. Returns event list.
 */
function measureMarkers(clip, skin, kind, seconds) {
  const hand = [...skin.nodeNames].find(([, n]) => /RightHand$/.test(String(n)))?.[0]
  if (hand === undefined) throw new Error('the target skeleton has no RightHand')
  const byNode = new Map()
  for (const c of clip.channels) {
    if (!byNode.has(c.targetNodeIndex)) byNode.set(c.targetNodeIndex, [])
    byNode.get(c.targetNodeIndex).push(c)
  }
  const dt = 1 / 60
  const speeds = []
  let prev = worldPosition(clip, skin, hand, 0, byNode)
  for (let t = dt; t <= seconds + 1e-6; t += dt) {
    const p = worldPosition(clip, skin, hand, t, byNode)
    speeds.push({ t, v: vec3.distance(p, prev) / dt })
    prev = p
  }
  // Smooth over ~0.1 s so a single noisy frame is not a swing.
  const smooth = speeds.map((s, i) => {
    let sum = 0, n = 0
    for (let k = Math.max(0, i - 3); k <= Math.min(speeds.length - 1, i + 3); k++) { sum += speeds[k].v; n++ }
    return { t: s.t, v: sum / n }
  })

  if (kind === 'taunt') {
    // The roar: the most energetic moment of the whole body is close enough to the hand's.
    const peak = smooth.reduce((a, b) => (b.v > a.v ? b : a))
    return [{ time: r3(peak.t), name: 'roar' }]
  }

  // Peaks, strongest first, at least 0.35 s apart and not in the first/last 8%.
  const maxSwings = kind === 'combo' ? 3 : 1
  const top = Math.max(...smooth.map(s => s.v))
  const candidates = smooth.filter((s, i) =>
    i > 0 && i < smooth.length - 1 && s.v >= smooth[i - 1].v && s.v >= smooth[i + 1].v
    && s.v > top * 0.55 && s.t > seconds * 0.08 && s.t < seconds * 0.92)
    .sort((a, b) => b.v - a.v)
  const peaks = []
  for (const c of candidates) {
    if (peaks.length >= maxSwings) break
    if (peaks.every(p => Math.abs(p.t - c.t) >= 0.35)) peaks.push(c)
  }
  if (!peaks.length) peaks.push(smooth.reduce((a, b) => (b.v > a.v ? b : a)))
  peaks.sort((a, b) => a.t - b.t)

  const events = []
  for (const p of peaks) {
    // The window straddles the fastest point: a little before it (the blade is already moving fast)
    // and through the follow-through.
    events.push({ time: r3(Math.max(0, p.t - 0.08)), name: 'hit' })
    events.push({ time: r3(Math.min(seconds, p.t + 0.12)), name: 'hitEnd' })
  }
  const lastEnd = events[events.length - 1].time
  events.push({ time: r3(Math.min(seconds, lastEnd + 0.08)), name: 'combo' })
  // Recovery: a little after the last swing lands, not 80% in -- a Mixamo attack ends with a long
  // settle back to idle that a souls player must be able to roll out of.
  events.push({ time: r3(Math.min(seconds * 0.85, lastEnd + 0.4)), name: 'recover' })
  return events.sort((a, b) => a.time - b.time)
}

async function main() {
  if (!fs.existsSync(DIR)) throw new Error(`missing ${path.relative(ROOT, DIR)} — the source .fbx files are not checked in`)
  const ajs = await loadAssimp(ROOT)
  const ctx = { ajs, ...engineModules(ROOT) }
  const { loadSkin, storeSkin } = editorModules(ROOT)

  const models = readJson(path.join(HERE, 'seed', 'models.json'))
  const mannequin = models.find(m => m.id === MANNEQUIN_MODEL)
  if (!mannequin) throw new Error('the mannequin model is not in the seed library')
  const target = retargetTargetOf(loadSkin, storeSkin(mannequin.nodeJson.children[0].model.skin))
  console.log(`souls: ${CLIPS.length} clips onto ${target.joints.length} joints (${path.relative(ROOT, DIR)})`)

  const out = []
  for (const [file, name, kind] of CLIPS) {
    const res = await importClipFile(ctx, path.join(DIR, file), name, target, { rootMotion: kind === 'death' || kind === 'travel', ratioRange: [0.6, 1.4] })
    const clip = res.clip
    const measured = kind === 'attack' || kind === 'combo' || kind === 'taunt'
      ? measureMarkers(clip, target, kind, res.seconds) : []
    const pinned = MARKER_OVERRIDES[name]
    clip.events = pinned
      ? Object.entries(pinned).flatMap(([ev, times]) => times.map(time => ({ time, name: ev }))).sort((a, b) => a.time - b.time)
      : measured
    out.push(clip)
    console.log(`  ${name.padEnd(22)} ${res.seconds.toFixed(2).padStart(5)}s  ratio ${res.ratio.toFixed(3)}`
      + `${clip.rootMotion ? '  rootMotion' : ''}${res.held > 0.5 ? `  held ${(res.held / 100).toFixed(2)}m` : ''}`
      + (clip.events.length ? `  [${clip.events.map(e => `${e.name}@${e.time}`).join(' ')}]` : ''))
  }
  // Five decimals is far below anything visible and roughly halves the committed file.
  fs.writeFileSync(OUT, JSON.stringify(out, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e5) / 1e5 : v)))
  console.log(`  wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`)
  console.log('Next:  node tools/soulsDemo/build.mjs && node --max-old-space-size=12288 tools/valley/build.mjs')
}

await main()
