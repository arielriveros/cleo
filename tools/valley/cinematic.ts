// The Valley's start menu and its cinematic tour, applied to the SHIPPED example.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applyCinematic.ts [--regenerate] [--dry]
//
// Adds (or replaces, by stable id — it can be run again) a `Cinematic` group at the scene root:
//
//   Cinematic
//     Cinematic Camera    a plain camera, inactive until the tour cuts to it
//     Valley Tour         a Sequence node playing the `Valley Tour.sequence` asset (/Cinematic), made from
//                         tools/valley/cinematic/valley-tour.sequence.json; its director
//                         examples/scripts/ValleyTourDirector.ts (the storm's lightning)
//     Lightning           the point light the director flashes, unbaked and unshadowed
//     Cinematic Overlay   letterbox bars, a fade to black, a title and a caption the tour animates, and the
//                         Cleo logo and wordmark it ends on (the logo a texture of its own, /Cinematic/Textures)
//     Start Menu          "Cinematic demo" or "Free mode" (examples/scripts/ValleyStartMenu.ts)
//
// The valley's day is keyed, never scripted: the tour keys the sun, the sky's fill, the mist, the god rays and
// the fog volumes itself (cinematic/dayPath.ts), and a `Day Cycle` Sequence node at the root (the
// `Day Cycle.sequence` asset, a whole day in 24 minutes, looping) plays them from the start of Play: under the
// menu and through Free mode, paused while the tour has the sun. The old `Time of Day` node and its
// ValleyDayNight script are removed, and the light probes follow the sun on their own (`relightDegrees`).
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
import { buildDayCycle, daySlots, type DayAuthored } from './cinematic/dayPath'
import { terrainHeightSampler } from './cinematic/terrainHeight'
import { ROOT, VALLEY_SCENE, id, log, child, nodes, refreshValleyScripts, attach } from './bundleOps'

export const TOUR_FILE = path.join(ROOT, 'tools', 'valley', 'cinematic', 'valley-tour.sequence.json')

const INK = [0.94, 0.91, 0.85, 1]
/** The editor's loading screen's wordmark: its colour and its font (app-kit theme.css `--font-ui`). */
const WORDMARK_INK = [0.898, 0.906, 0.922, 1]
const WORDMARK_FONT = 'Consolas, monaco, monospace'
/** The Cleo logo the tour ends on: the editor's own (applications/editor/public/brand/logo.png, 404x366). */
const LOGO_FILE = path.join(ROOT, 'applications', 'editor', 'public', 'brand', 'logo.png')
const LOGO_TEXTURE = id('texture:cleo-logo')
const LOGO_FOLDER = '/Cinematic/Textures'
/** The tour as a library asset, `/Cinematic/Valley Tour.sequence`, which the Valley Tour node links and embeds. */
export const TOUR_ASSET = id('sequence:valley-tour')
const TOUR_FOLDER = '/Cinematic'
/** Free mode's day, `/Cinematic/Day Cycle.sequence`, played by the `Day Cycle` node at the root. */
export const DAY_ASSET = id('sequence:day-cycle')
/** Degrees the sun may turn before a light probe relights itself (what the old time-of-day script did by hand). */
export const PROBE_RELIGHT_DEGREES = 4
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
    // Over the fade: the Cleo logo and its wordmark, as the editor's loading screen shows them.
    uiNode('Logo', 'uiImage', {
      ...rect([0.5, 0.5], [0.5, 0.5], [-170, -250], [170, 58]), textureId: LOGO_TEXTURE, fit: 'contain', opacity: 0, zOrder: 4,
    }, { id: id('cinematic:logo') }),
    uiNode('Wordmark', 'uiText', {
      ...rect([0.5, 0.5], [0.5, 0.5], [-700, 86], [700, 166]), text: 'CLEO ENGINE', fontSize: 56, fontFamily: WORDMARK_FONT,
      fontWeight: 600, letterSpacing: 0.3, align: 'center', vAlign: 'middle', wrap: false, lineHeight: 1.25,
      tint: WORDMARK_INK, opacity: 0, zOrder: 4,
    }, { id: id('cinematic:wordmark') }),
  ], 30, true)
}

/** The logo's texture, its two Assets entries (the record and its source image) and their folders. Idempotent. */
function logoTexture(bundle: any) {
  const bytes = fs.readFileSync(LOGO_FILE)
  const texture = {
    id: LOGO_TEXTURE, mime: 'image/png',
    config: { flipY: false, usage: 'color', wrapping: 'clamp', mipMap: false, mipMapFilter: 'linear', precision: 'low', target: 'texture2D' },
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
  const at = bundle.textures.findIndex((t: any) => t.id === LOGO_TEXTURE)
  if (at >= 0) bundle.textures[at] = texture
  else bundle.textures.push(texture)
  bundle.vfs.entries = bundle.vfs.entries.filter((e: any) => e.assetId !== LOGO_TEXTURE)
  bundle.vfs.entries.push(
    { path: `${LOGO_FOLDER}/Cleo Logo.tex`, kind: 'texture', assetId: LOGO_TEXTURE, created: bundle.manifest.createdAt },
    { path: `${LOGO_FOLDER}/Source/Cleo Logo.png`, kind: 'image', assetId: LOGO_TEXTURE, created: bundle.manifest.createdAt },
  )
  for (let d = `${LOGO_FOLDER}/Source`; d && d !== '/'; d = path.posix.dirname(d))
    if (!bundle.vfs.folders.includes(d)) bundle.vfs.folders.push(d)
  // The scene names it now: its refs list it, as the editor's own save would.
  for (const meta of bundle.manifest.sceneMetas) {
    if (meta.id !== VALLEY_SCENE) continue
    const refs = (meta.refs ??= {})
    refs.textureIds = [...new Set([...(refs.textureIds ?? []), LOGO_TEXTURE])]
  }
}

/**
 * The tour as a `.sequence` library asset, its Assets entry and the scene's reference to it. The Valley Tour node
 * links it (`sequenceId`) and plays its own copy, as the editor's Sequence nodes do. Idempotent.
 */
function sequenceAsset(bundle: any, assetId: string, data: any) {
  const asset = { id: assetId, name: data.name, sequence: data }
  const list: any[] = (bundle.libraries.sequences ??= [])
  const at = list.findIndex(q => q.id === assetId)
  if (at >= 0) list[at] = asset
  else list.push(asset)
  bundle.vfs.entries = bundle.vfs.entries.filter((e: any) => e.assetId !== assetId)
  bundle.vfs.entries.push({ path: `${TOUR_FOLDER}/${data.name}.sequence`, kind: 'sequence', assetId, created: bundle.manifest.createdAt })
  if (!bundle.vfs.folders.includes(TOUR_FOLDER)) bundle.vfs.folders.push(TOUR_FOLDER)
  for (const meta of bundle.manifest.sceneMetas) {
    if (meta.id !== VALLEY_SCENE) continue
    const refs = (meta.refs ??= {})
    refs.sequenceIds = [...new Set([...(refs.sequenceIds ?? []), assetId])]
  }
}

/** A node's name path from the scene root ("Fog Volumes/Pond Mist"). */
function namePath(root: any, target: any): string | null {
  const walk = (n: any, trail: string[]): string | null => {
    for (const c of n.children ?? []) {
      const here = [...trail, c.name]
      if (c === target) return here.join('/')
      const deeper = walk(c, here)
      if (deeper) return deeper
    }
    return null
  }
  return walk(root, [])
}

const slotIdOf = (name: string) => name.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, c => c.toLowerCase())

/** What the scene holds by day, which the day's keys move away from: read off the scene as authored. */
export function dayAuthored(root: any): DayAuthored {
  const sky = root.children.find((c: any) => c.type === 'skyAtmosphere')?.atmosphere
  const skyLight = root.children.find((c: any) => c.type === 'skyLight')?.skyLight
  if (!sky) throw new Error('the Valley has no sky atmosphere for the day to light')
  const fogVolumes = [...nodes(root)].filter((n: any) => n.type === 'volumetricFog').map((n: any) => ({
    slot: `fog${slotIdOf(n.name).replace(/^./, (c: string) => c.toUpperCase())}`, name: n.name,
    path: namePath(root, n) ?? n.name, density: n.volumetricFog?.density ?? 0.02,
  }))
  return {
    skyLight: skyLight?.intensity ?? 1,
    fog: { density: sky.fogDensity ?? 0, falloff: sky.fogHeightFalloff ?? 0, opacity: sky.fogMaxOpacity ?? 1 },
    godRays: sky.godRayExposure ?? 0,
    fogVolumes,
  }
}

/** A day's slots bound to this scene's nodes by id, as an editor-made Sequence node would be. */
function dayBindings(root: any, day: DayAuthored): Record<string, string> {
  const out: Record<string, string> = {}
  for (const slot of daySlots(day)) {
    const node = [...nodes(root)].find((n: any) => namePath(root, n) === slot.path)
    if (node) out[slot.id] = node.id
  }
  return out
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
  const root = bundle.scenes[VALLEY_SCENE].scene
  const heightAt = terrainHeightSampler(root)
  const pond = child(child(root, 'Water'), 'Pond Water')
  const tour = parseSequence(buildTour(heightAt, { pondLevel: pond?.position?.[1], day: dayAuthored(root) }))
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
  const fly = child(root, 'Fly Camera')
  if (!fly) throw new Error('the Valley has no Fly Camera to build the cinematic around')
  const day = dayAuthored(root)

  // The day is keyed now (Day Cycle, below): the time-of-day node and its script go, and the probes relight
  // themselves as the sun turns.
  const oldClock = root.children.findIndex((c: any) => c.name === 'Time of Day')
  if (oldClock >= 0) root.children.splice(oldClock, 1)
  const oldScript = id('script:ValleyDayNight')
  bundle.libraries.scripts = bundle.libraries.scripts.filter((s: any) => s.id !== oldScript)
  bundle.vfs.entries = bundle.vfs.entries.filter((e: any) => e.assetId !== oldScript)
  for (const meta of bundle.manifest.sceneMetas)
    if (meta.refs?.scriptIds) meta.refs.scriptIds = meta.refs.scriptIds.filter((s: string) => s !== oldScript)
  for (const n of nodes(root)) if (n.type === 'lightProbe') n.relightDegrees = PROBE_RELIGHT_DEGREES
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

  refreshValleyScripts(bundle, ['ValleyStartMenu', 'ValleyTourDirector'])
  logoTexture(bundle)
  const menuScript = bundle.libraries.scripts.find((s: any) => s.id === id('script:ValleyStartMenu'))
  const directorScript = bundle.libraries.scripts.find((s: any) => s.id === id('script:ValleyTourDirector'))
  const tour = tourSequence(bundle, options.regenerate)
  sequenceAsset(bundle, TOUR_ASSET, tour)
  const dayCycle = parseSequence(buildDayCycle(day))
  sequenceAsset(bundle, DAY_ASSET, dayCycle)

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
  attach(menu, menuScript, { tourName: 'Valley Tour', dayName: 'Day Cycle' })
  const ui = (n: any, name: string): any => n.name === name ? n : (n.children ?? []).map((c: any) => ui(c, name)).find(Boolean)

  const sequence = {
    id: id('cinematic:tour'), name: 'Valley Tour', type: 'sequence',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], variables: {}, spawnOnStart: true,
    sequence: tour, sequenceId: TOUR_ASSET,
    bindings: {
      ...dayBindings(root, day),
      camera: camera.id,
      barTop: ui(over, 'Letterbox Top').id, barBottom: ui(over, 'Letterbox Bottom').id, fade: ui(over, 'Fade').id,
      title: ui(over, 'Title').id, caption: ui(over, 'Caption').id,
      logo: ui(over, 'Logo').id, wordmark: ui(over, 'Wordmark').id,
      clouds: clouds.id, wind: wind.id, weather: weather.id, landscape: landscape.id, pond: pond.id,
    },
  }
  // The tour's director: the Script track's methods (the storm's lightning).
  attach(sequence, directorScript, {})

  // What the lightning flashes: a point light high in the clouds, off until a strike. Not baked (the GI and the
  // probes never see it) and unshadowed; the director moves it over the camera.
  const lightning = {
    id: id('cinematic:lightning'), name: 'Lightning', type: 'light',
    position: [0, 700, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], variables: {}, spawnOnStart: true,
    lightType: 'point', castShadows: false, bake: false,
    light: { unit: 'photometric', color: [0.78, 0.84, 1], intensity: 0, range: 2500, sourceRadius: 2, legacyFalloff: false },
  }

  const group = {
    id: id('cinematic'), name: 'Cinematic', type: 'node',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], variables: {}, spawnOnStart: true,
    children: [camera, sequence, lightning, over, menu],
  }
  const at = root.children.findIndex((c: any) => c.id === group.id)
  if (at >= 0) root.children[at] = group
  else root.children.push(group)

  // Free mode's day: plays from the first frame of Play, under the menu and through Free mode (the menu pauses
  // it while the tour has the sun). Where the Time of Day node was, after the Weather.
  const dayNode = {
    id: id('day-cycle'), name: 'Day Cycle', type: 'sequence',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], variables: {}, spawnOnStart: true,
    sequence: dayCycle, sequenceId: DAY_ASSET, bindings: dayBindings(root, day), autoplay: true,
  }
  const dayAt = root.children.findIndex((c: any) => c.id === dayNode.id)
  if (dayAt >= 0) root.children[dayAt] = dayNode
  else root.children.splice(Math.max(0, root.children.indexOf(weather) + 1), 0, dayNode)

  // The menu's own map beside the fly camera's (flyInputMap.mjs).
  bundle.libraries.inputMap = parseInputMap(FLY_INPUT_MAP)
  log(`cinematic: ${tour.tracks.length} tracks, ${tour.duration} s; day cycle ${dayCycle.tracks.length} tracks, ${dayCycle.duration} s; start menu and overlay ${at >= 0 ? 'replaced' : 'added'}`)
  return bundle
}
