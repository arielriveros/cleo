// The Valley's start menu and its cinematic tour, applied to the SHIPPED example.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applyCinematic.ts [--regenerate] [--dry]
//
// Adds (or replaces, by stable id — it can be run again) a `Cinematic` group at the scene root:
//
//   Cinematic
//     Cinematic Camera    a plain camera, inactive until the tour cuts to it
//     Valley Tour         a Sequence node playing tools/valley/cinematic/valley-tour.sequence.json
//     Cinematic Overlay   letterbox bars, a fade to black, a title and a caption the tour animates
//     Start Menu          "Cinematic demo" or "Free mode" (examples/scripts/ValleyStartMenu.ts)
//
// and, beside the Wind at the root, the `Weather` the tour's Act III keys: one unbounded volume falling
// rain and snow together ('mixed'), with the library's Snow material, all at 0 (dry, nothing falling) until
// the tour starts. The scene's render settings get `effectsFollowTimeScale`, so time x2 is a time-lapse.
//
// The sequence file is the tour's source of truth. `--regenerate` (or a missing file) rebuilds it from the shot
// list in tools/valley/cinematic/tour.ts against the shipped terrain; otherwise the file is used as it is, so a
// tour retimed in the editor and exported over it survives a re-run. split.ts calls `applyCinematic` too, so a
// re-split keeps all of this.

import fs from 'fs'
import path from 'path'
import { uiNode } from '../exampleKit/bundle.mjs'
import { parseInputMap } from '../../src/input/actionMap'
import { parseSequence } from '../../src/sequencer/parse'
import { FLY_INPUT_MAP } from './flyInputMap.mjs'
import { buildTour } from './cinematic/tour'
import { terrainHeightSampler } from './cinematic/terrainHeight'
import { ROOT, VALLEY_SCENE, id, log, child, refreshValleyScripts, attach } from './bundleOps'

export const TOUR_FILE = path.join(ROOT, 'tools', 'valley', 'cinematic', 'valley-tour.sequence.json')

const INK = [0.94, 0.91, 0.85, 1]
const DIM = [0.72, 0.69, 0.62, 1]
const GOLD = [0.92, 0.78, 0.46, 1]
const SERIF = 'Georgia, "Times New Roman", serif'

const rect = (anchorMin: number[], anchorMax: number[], offsetMin: number[], offsetMax: number[]) => ({ anchorMin, anchorMax, offsetMin, offsetMax })
const stretch = () => rect([0, 0], [1, 1], [0, 0], [0, 0])
const panel = (key: string, name: string, r: any, tint: number[], extra: any = {}, children: any[] = []) =>
  uiNode(name, 'uiPanel', { ...r, tint, borderRadius: extra.radius ?? 0, interactive: !!extra.interactive, opacity: extra.opacity ?? 1, zOrder: extra.z ?? 0 },
         { id: id(`cinematic:${key}`), children })
const text = (key: string, name: string, value: string, r: any, style: any = {}) => uiNode(name, 'uiText', {
  ...r, text: value, fontSize: style.size ?? 24, fontFamily: style.font ?? SERIF, fontWeight: style.weight ?? 400,
  align: style.align ?? 'center', vAlign: style.vAlign ?? 'middle', wrap: true, lineHeight: 1.25, tint: style.tint ?? INK,
  opacity: style.opacity ?? 1, zOrder: style.z ?? 0,
}, { id: id(`cinematic:${key}`) })
const button = (key: string, name: string, label: string, r: any) => uiNode(name, 'uiButton', {
  ...r, label, disabled: false, tint: [0.16, 0.14, 0.12, 1], hoverTint: [1, 1, 1, 0.16], pressedTint: [0, 0, 0, 0.22],
  disabledTint: [0.5, 0.5, 0.5, 0.4], interactive: true, borderRadius: 6,
}, { id: id(`cinematic:${key}`) })
const screenRoot = (key: string, name: string, children: any[], z: number, visible: boolean) => uiNode(name, 'uiRoot', {
  anchorMin: [0, 0], anchorMax: [1, 1], offsetMin: [0, 0], offsetMax: [0, 0], zOrder: z,
}, { id: id(`cinematic:${key}`), children, visible })

/** The bars, the black and the two lines of text the tour animates. Everything starts transparent. */
function overlay() {
  return screenRoot('overlay', 'Cinematic Overlay', [
    panel('bar-top', 'Letterbox Top', rect([0, 0], [1, 0], [0, 0], [0, 118]), [0, 0, 0, 1], { opacity: 0, z: 1 }),
    panel('bar-bottom', 'Letterbox Bottom', rect([0, 1], [1, 1], [0, -118], [0, 0]), [0, 0, 0, 1], { opacity: 0, z: 1 }),
    text('title', 'Title', '', rect([0.5, 0.5], [0.5, 0.5], [-900, -90], [900, 90]), { size: 92, opacity: 0, z: 2, tint: INK }),
    text('caption', 'Caption', '', rect([0.5, 1], [0.5, 1], [-860, -104], [860, -20]), { size: 30, opacity: 0, z: 2, tint: DIM }),
    panel('fade', 'Fade', stretch(), [0, 0, 0, 1], { opacity: 0, z: 3 }),
  ], 30, true)
}

function startMenu() {
  const card = panel('menu:card', 'Card', rect([0.5, 0.5], [0.5, 0.5], [-380, -230], [380, 230]), [0.05, 0.045, 0.04, 0.92], { radius: 10 }, [
    text('menu:title', 'Title', 'The Valley', rect([0, 0], [1, 0], [0, 30], [0, 104]), { size: 60, tint: GOLD }),
    text('menu:subtitle', 'Subtitle', 'A Cleo Engine example', rect([0, 0], [1, 0], [0, 104], [0, 140]), { size: 22, tint: DIM }),
    button('menu:cinematic', 'Cinematic', 'Cinematic demo', rect([0.5, 0], [0.5, 0], [-230, 186], [230, 244])),
    button('menu:free', 'Free', 'Free mode', rect([0.5, 0], [0.5, 0], [-230, 262], [230, 320])),
    text('menu:hint', 'Hint', 'Up / Down choose  ·  Enter confirm  ·  Esc or P brings you back here',
      rect([0, 1], [1, 1], [24, -84], [-24, -28]), { size: 17, tint: DIM }),
  ])
  const backdrop = panel('menu:backdrop', 'Backdrop', stretch(), [0, 0, 0, 0.35], { interactive: true }, [card])
  return screenRoot('menu', 'Start Menu', [backdrop], 40, true)
}

/**
 * Read the tour file, or build it from the shot list against the shipped terrain (and write it). Both go
 * through the engine's `parseSequence`, so the file is in exactly the form the editor's Export writes and a
 * tour exported over it differs only where it was edited.
 */
export function tourSequence(bundle: any, regenerate = false): any {
  if (!regenerate && fs.existsSync(TOUR_FILE)) return parseSequence(JSON.parse(fs.readFileSync(TOUR_FILE, 'utf8')))
  const heightAt = terrainHeightSampler(bundle.scenes[VALLEY_SCENE].scene)
  const tour = parseSequence(buildTour(heightAt))
  fs.writeFileSync(TOUR_FILE, JSON.stringify(tour, null, 2) + '\n')
  log(`cinematic: tour written to ${path.relative(ROOT, TOUR_FILE)}`)
  return tour
}

/** The library material the weather's snow is drawn with. */
const SNOW_MATERIAL = 'd98e78bfc92c6273d7546237b34958cf'

/** The tour's weather: dry and still until the tour keys it. */
function weatherNode(bundle: any) {
  const snow = bundle.libraries.materials.find((m: any) => m.id === SNOW_MATERIAL)
  if (!snow) throw new Error('the Valley has no Snow material to snow with')
  return {
    id: id('cinematic:weather'), name: 'Weather', type: 'weather',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], variables: {}, spawnOnStart: true,
    weather: {
      wetness: 0, snow: 0, puddles: 0, size: [0, 0, 0], blendDistance: 4, priority: 0, enabled: true,
      snowTiling: 4, snowSlope: 45, snowBreakup: 0.4, shelter: true,
      precipitation: 'mixed', precipitationRate: 0, precipitationSnowShare: 0,
      precipitationSize: 1, precipitationSpeed: 1, precipitationWind: 0.6, precipitationTrailMin: 0.7, precipitationTrailMax: 1.3,
      snowMaterial: structuredClone(snow.material), snowMaterialId: snow.id,
    },
  }
}

/** Add or replace the Cinematic group, its scripts and the input map. Idempotent. */
export function applyCinematic(bundle: any, options: { regenerate?: boolean } = {}) {
  const data = bundle.scenes[VALLEY_SCENE]
  if (!data) throw new Error('no Valley scene')
  const root = data.scene
  const clock = child(root, 'Time of Day')
  const fly = child(root, 'Fly Camera')
  if (!clock || !fly) throw new Error('the Valley has no Time of Day / Fly Camera to build the cinematic around')
  const clouds = root.children.find((c: any) => c.type === 'volumetricClouds')
  const wind = root.children.find((c: any) => c.type === 'wind')
  const landscape = root.children.find((c: any) => c.type === 'landscape')
  const pond = child(child(root, 'Water'), 'Pond Water')
  if (!clouds || !wind || !landscape || !pond) throw new Error('the Valley has no clouds / wind / landscape / pond for the tour')

  // The weather, at the root beside the Wind (replaced in place on a re-run).
  const weather = weatherNode(bundle)
  const was = root.children.findIndex((c: any) => c.id === weather.id)
  if (was >= 0) root.children[was] = weather
  else root.children.splice(root.children.indexOf(wind) + 1, 0, weather)
  // Time x2 runs the wind, the clouds and the water at x2 too.
  data.config.render.effectsFollowTimeScale = true

  refreshValleyScripts(bundle, ['ValleyStartMenu', 'ValleyDayNight'])
  const menuScript = bundle.libraries.scripts.find((s: any) => s.id === id('script:ValleyStartMenu'))
  const tour = tourSequence(bundle, options.regenerate)

  // A plain camera (a rig would overwrite it every frame), shaped like the fly camera's, switched off.
  const flyCam = fly.children.find((c: any) => c.type === 'camera')
  const first = tour.tracks.find((t: any) => t.type === 'path')?.sections?.[0]?.points?.[0] ?? [0, 10, 0]
  const camera = {
    ...flyCam, id: id('cinematic:camera'), name: 'Cinematic Camera', position: first, rotation: [0, 0, 0],
    children: [], variables: {}, camera: { ...flyCam.camera, fov: 60, far: Math.max(3000, flyCam.camera.far ?? 0) }, active: false,
  }
  delete (camera as any).script
  delete (camera as any).scriptVars

  const over = overlay()
  const menu = startMenu()
  attach(menu, menuScript, { tourName: 'Valley Tour' })
  const ui = (n: any, name: string): any => n.name === name ? n : (n.children ?? []).map((c: any) => ui(c, name)).find(Boolean)

  const sequence = {
    id: id('cinematic:tour'), name: 'Valley Tour', type: 'sequence',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], variables: {}, spawnOnStart: true,
    sequence: tour,
    bindings: {
      camera: camera.id, clock: clock.id,
      barTop: ui(over, 'Letterbox Top').id, barBottom: ui(over, 'Letterbox Bottom').id, fade: ui(over, 'Fade').id,
      title: ui(over, 'Title').id, caption: ui(over, 'Caption').id,
      clouds: clouds.id, wind: wind.id, weather: weather.id, landscape: landscape.id, pond: pond.id,
    },
  }

  const group = {
    id: id('cinematic'), name: 'Cinematic', type: 'node',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], variables: {}, spawnOnStart: true,
    children: [camera, sequence, over, menu],
  }
  const at = root.children.findIndex((c: any) => c.id === group.id)
  if (at >= 0) root.children[at] = group
  else root.children.push(group)

  // The menu's own map beside the fly camera's (flyInputMap.mjs).
  bundle.libraries.inputMap = parseInputMap(FLY_INPUT_MAP)
  log(`cinematic: ${tour.tracks.length} tracks, ${tour.duration} s; start menu and overlay ${at >= 0 ? 'replaced' : 'added'}`)
  return bundle
}
