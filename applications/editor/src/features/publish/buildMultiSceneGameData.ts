import { Scene, TextureManager, AudioManager, GiBakeRegistry, FEATURES, featureApiNames } from 'cleo'
import type { RenderSettings, InputMap } from 'cleo'
import { isDefaultInputMap } from 'cleo'
import { projectSettingsConfig } from '../options/projectSettings'
import type { ProjectSettings } from '../options/projectSettings'
import { buildGameData, bakeTemplates, attachScriptModules, injectSaveFields } from './buildGameData'
import { buildScriptGraphCtx } from '../../utils/scriptGraph'
import { compressTerrainData, compressTilemapData } from './terrainImages'
import { stripDimensionData, stampSceneDimension } from './stripDimensionData'
import { featureStripRules, stripFeatureNodes, stripFeatureSettings } from './featureStrip'
import { featureUsage, disabledFeatureUses, type FeatureUsage } from './featureUsage'
import { collectPublishedTextureIds, collectPublishedSoundIds, collectGiBakeIds } from '../../utils/references'
import { collectPrograms } from './collectProgramUsage'
import { extractNodeState } from '../../utils/projectStorage'
import { migrateScenePhysics } from '../../utils/physicsMigration'
import { resyncScene } from '../../utils/sceneResync'
import { loadSceneData } from '../../utils/sceneStorage'
import type { SceneMeta } from '../../utils/sceneStorage'
import type { AssetLibs } from '../../utils/assetHash'
import { migrateLegacyUI } from '../../utils/uiMigration'
import type { ScriptAsset } from '../../utils/scripts'
import { deepClone } from '@cleo/app-kit/utils/deepClone'
import { sharedAnimationData } from './sharedAnimations'

// game.json v2: a multi-scene published game. The entry (main) scene runs first; scripts call
// Game.loadScene(name|id) to switch at runtime. Textures are serialized ONCE at the top level (they are
// global) and every scene's tree goes through the same buildGameData path as a single-scene publish.
// Closed scenes are re-resolved against the current asset libraries first (resyncScene). Each scene
// carries its own render settings, which the player applies as it starts that scene: a dark interior
// and a daylit valley are not seen through one exposure.

export interface MultiSceneSources {
  mainSceneId: string
  openSceneId: string
  scenes: SceneMeta[]
  // The live, currently-open scene + its editor maps (so unsaved edits publish, as single-scene did).
  liveScene: Scene
  liveScripts: Map<string, string>
  libs: AssetLibs
  scriptAssets?: ScriptAsset[]
  /** Script asset id -> VFS path: turns on script modules (see GameDataSources.scriptPaths). */
  scriptPaths?: ReadonlyMap<string, string>
  settings?: RenderSettings
  /** The project's input action map. Written ONCE at the top level, never inside a scene's blob. */
  input?: InputMap
  /** Engine runtime + publish-window options; merged into `config` (see options/projectSettings). */
  projectSettings?: ProjectSettings
  /** The OPEN scene's live dimension. Its meta can be one save behind, and the live value is the truth. */
  liveDimension?: '2D' | '3D'
  /**
   * Pipeline recipes the editor recorded this session (Renderer.pipelineRecipes): the player builds them
   * while its loading screen is up, so a WebGPU game does not compile one on each first draw.
   */
  pipelines?: readonly unknown[]
  /**
   * The game uses features the project leaves out (Project ▸ Features): Publish asks what to do. Resolves to
   * the features to turn back on for this build (none: publish without them), or null to stop. Absent: the
   * build strips them without asking, as Play in window does to play what a publish would.
   */
  onDisabledFeatureUse?: (uses: FeatureUsage) => Promise<string[] | null>
}

/** The build was stopped at the features question (MultiSceneSources.onDisabledFeatureUse). */
export class PublishCanceledError extends Error {
  constructor() { super('Publish canceled') }
}

export async function buildMultiSceneGameData(src: MultiSceneSources): Promise<any> {
  const scenes: Record<string, { name: string; scene: any; render?: Partial<RenderSettings> }> = {}

  for (const meta of src.scenes) {
    if (meta.id === src.openSceneId) {
      // The open scene: serialize the live scene + live maps (includes unsaved edits).
      const gd = await buildGameData({
        scene: src.liveScene,
        scripts: src.liveScripts,
        scriptAssets: src.scriptAssets,
        useCache: true, // textures are embedded once below, not per scene
      })
      scenes[meta.id] = { name: meta.name, scene: gd.scene, ...(src.settings ? { render: src.settings } : {}) }
      continue
    }

    // A closed scene: load its blob, parse a throwaway Scene, re-resolve its assets against the current
    // libraries, then serialize it the normal way.
    const data = await loadSceneData(meta.id)
    if (!data) continue
    const clone = deepClone({ scene: data.scene, ui: data.ui })
    // A scene never opened in this build still carries its UI as the legacy blob; without this it
    // publishes and runs with no HUD.
    migrateLegacyUI(clone.scene, clone.ui)
    const maps = { scripts: new Map<string, string>() }
    // Its legacy bodies and triggers as Collider and Trigger nodes, as opening it would make them.
    clone.scene = migrateScenePhysics(clone.scene, src.libs.templates)
    extractNodeState(clone.scene, maps)
    const tmp = new Scene()
    tmp.parse({ scene: clone.scene, textures: [] }, true) // useCache: textures already live in TextureManager
    resyncScene(tmp, maps, src.libs, data.assetHashes, data.assetHashVersion)
    const gd = await buildGameData({
      scene: tmp,
      scripts: maps.scripts,
      scriptAssets: src.scriptAssets,
      useCache: true,
    })
    scenes[meta.id] = { name: meta.name, scene: gd.scene, ...(data.config?.render ? { render: data.config.render } : {}) }
  }

  // Templates once, like textures: the runtime registry is global and a Game.loadScene switch must not
  // invalidate what a script can still instantiate. Every template ships — a script may name any of them.
  // Baked before the strips below, which apply to templates too.
  const libs = src.libs as any
  const templates = bakeTemplates(src.libs.templates ?? [], src.libs.materials, src.scriptAssets,
    libs.animControllers && libs.boneMasks && libs.poseAssets
      ? { controllers: libs.animControllers, boneMasks: libs.boneMasks, poses: libs.poseAssets, animationFields: libs.animationFields ?? [] }
      : undefined)
  // Script modules ONCE for the whole game, like templates: a module's state lives across Game.loadScene,
  // and two scenes importing the same helper must get the same instance. Every scene and template is
  // stamped with its scripts' paths in place, and the union of their import closures ships here.
  let modules: Record<string, string> | undefined
  if (src.scriptPaths && src.scriptAssets) {
    const all = { scene: { children: Object.values(scenes).map(e => e.scene) }, templates } as any
    attachScriptModules(all, src.scriptAssets, src.scriptPaths)
    if (all.modules) modules = all.modules
  }
  // Each script's `@save` fields, which the game's saves keep: after the paths above, so fields a script
  // inherits from a base-class script count too.
  const graph = src.scriptPaths && src.scriptAssets ? buildScriptGraphCtx(src.scriptPaths, src.scriptAssets) : undefined
  for (const entry of Object.values(scenes)) injectSaveFields(entry.scene, graph)
  for (const template of templates) injectSaveFields(template.node, graph)

  // The features the project leaves out (Project ▸ Features, src/modules/catalog.ts in the engine). A game
  // that still uses one is asked about first: turn it back on, or publish without it.
  let rules = featureStripRules(src.projectSettings?.features.disabled ?? [])
  const dimensionOf = (id: string) => (id === src.openSceneId ? (src.liveDimension ?? src.scenes.find(m => m.id === id)?.dimension) : src.scenes.find(m => m.id === id)?.dimension)
  const scanned = Object.fromEntries(Object.entries(scenes).map(([id, e]) => [id, { ...e, dimension: dimensionOf(id) }]))
  const uses = disabledFeatureUses(featureUsage({ scenes: scanned, templates, modules }), rules.enabled)
  if (uses.size && src.onDisabledFeatureUse) {
    const enable = await src.onDisabledFeatureUse(uses)
    if (!enable) throw new PublishCanceledError()
    if (enable.length) rules = featureStripRules((src.projectSettings?.features.disabled ?? []).filter(id => !enable.includes(id)))
  }

  // Discard the authoring each scene's dimension does not use. The ordering is load-bearing: the texture
  // filter below is driven off the SERIALIZED scenes, so a landscape stripped after it would still drag
  // its layer textures into the build.
  for (const meta of src.scenes) {
    const entry = scenes[meta.id]
    if (!entry) continue
    // An UNKNOWN dimension strips nothing: a scene saved before dimension became per-scene has none
    // recorded, and guessing wrong would delete the authoring the game is built around.
    const dimension = meta.id === src.openSceneId ? (src.liveDimension ?? meta.dimension) : meta.dimension
    if (dimension) {
      stripDimensionData(entry.scene, dimension)
      // ...and record it where the player's engine reads it.
      stampSceneDimension(entry.scene, dimension)
    }
  }
  // ...and the nodes and render settings of the features it leaves out, from the scenes and the templates,
  // for the same reason: what they reference must not be collected below. A scene's render settings can be
  // the renderer's own object, so each is copied before it changes.
  for (const entry of Object.values(scenes)) {
    stripFeatureNodes(entry.scene, rules)
    if (entry.render) { entry.render = { ...entry.render }; stripFeatureSettings(entry.render, rules) }
  }
  for (const t of templates) stripFeatureNodes((t as any).node, rules)

  // Bulk terrain and tilemap data (height field, splat map, tile grids) out of the JSON manifest and into
  // deflated byte arrays the packer moves into game.bin. Main thread: CompressionStream lives here.
  for (const entry of Object.values(scenes)) {
    await compressTerrainData(entry.scene)
    await compressTilemapData(entry.scene)
  }

  // Textures once, for the whole game, as raw compressed bytes the packer writes verbatim into game.bin.
  // Must run on the main thread — the canvas fallback inside needs a DOM. Narrowed to what the SERIALIZED
  // scenes and templates reference, so it must run AFTER bakeTemplates: a template can be a texture's
  // only referrer.
  const wanted = new Set<string>()
  for (const entry of Object.values(scenes)) collectPublishedTextureIds(entry.scene, wanted)
  for (const t of templates) collectPublishedTextureIds((t as any).node, wanted)
  // The colour-grading LUT is referenced by RenderSettings, not by any node, so the walks above
  // cannot see it. Without this the build ships a LUT id with no bytes behind it and the published
  // game runs ungraded, with nothing to say why.
  if (src.settings?.colorGradingLut) wanted.add(src.settings.colorGradingLut)
  // Same for a lens-dirt mask the project assigned. Leaving it null means the built-in overlay, which
  // is compiled into the engine and needs nothing here — only a texture the USER picked has bytes to
  // carry, and without this line it ships as an id with nothing behind it.
  if (src.settings?.lensDirtTexture) wanted.add(src.settings.lensDirtTexture)

  let textureBytes: any[] = []
  try {
    // Empty means the walker found nothing to keep — more likely a walker bug than a textureless game,
    // so fall back to shipping everything.
    textureBytes = wanted.size > 0
      ? TextureManager.Instance.serializeTextureBytes(wanted)
      : TextureManager.Instance.serializeTextureBytes()
  } catch { textureBytes = [] }

  // Sounds, narrowed the same way: what the SERIALIZED scenes and templates actually play. A sample
  // nothing references is a file the player would download and never use.
  const wantedSounds = new Set<string>()
  for (const entry of Object.values(scenes)) collectPublishedSoundIds(entry.scene, wantedSounds)
  for (const t of templates) collectPublishedSoundIds((t as any).node, wantedSounds)

  let soundBytes: any[] = []
  try {
    // Unlike textures there is no ship-everything fallback: a game with no Sound nodes genuinely has no
    // audio to carry, and guessing would bloat every silent build with the project's whole sound library.
    soundBytes = wantedSounds.size > 0 ? AudioManager.Instance.serializeSoundBytes(wantedSounds) : []
  } catch { soundBytes = [] }

  const out: any = {
    version: 2,
    entry: src.mainSceneId in scenes ? src.mainSceneId : Object.keys(scenes)[0],
    scenes,
    templates,
    textureBytes,
  }
  if (modules) out.modules = modules
  const { animations, modelAnimations, retargets } = sharedAnimationData(src.libs)
  if (retargets) out.retargets = retargets

  if (soundBytes.length) out.soundBytes = soundBytes
  // GI Volume bakes, narrowed like the sounds: the ones the serialized scenes' volumes name. A volume
  // whose bake is missing captures at runtime instead, so nothing here is required.
  const wantedBakes = new Set<string>()
  for (const entry of Object.values(scenes)) collectGiBakeIds(entry.scene, wantedBakes)
  const giBakes: { id: string; bytes: Uint8Array }[] = []
  for (const id of wantedBakes) {
    const bytes = GiBakeRegistry.get(id)
    if (bytes) giBakes.push({ id, bytes })
  }
  if (giBakes.length) out.giBakes = giBakes
  if (animations.length) { out.animations = animations; out.modelAnimations = modelAnimations }
  // One config for the whole game. `render` is per-project here even though a scene blob carries its
  // own copy; `input` is project-wide by design and has no per-scene form at all.
  const config: Record<string, any> = {}
  if (src.settings) {
    config.graphics = { clearColor: src.settings.clearColor }
    config.render = { ...src.settings }
    stripFeatureSettings(config.render, rules)
  }
  // A game without the Input feature takes no input: it ships no input map, and the player binds none.
  if (src.input && !isDefaultInputMap(src.input) && rules.enabled.has('input')) config.input = src.input
  if (src.projectSettings) Object.assign(config, projectSettingsConfig(src.projectSettings))
  // The features the game was built with, for the player (and the shaders publish picks: see publishClient).
  config.features = [...rules.enabled].sort()
  // The script names of the features it goes without (each a chunk the player does not load), with the feature's
  // name: a script that imports one gets the reason rather than undefined.
  const absentApi: Record<string, string> = {}
  for (const f of FEATURES) if (!rules.enabled.has(f.id)) for (const name of featureApiNames(f.id)) absentApi[name] = f.label
  if (Object.keys(absentApi).length) config.absentApi = absentApi
  // The shader programs the game uses: the player builds only these at boot (see collectPrograms).
  if (src.projectSettings?.publish.onlyUsedShaders !== false)
    (config.graphics ??= {}).programs = collectPrograms(out, config.render)
  if (src.pipelines?.length) (config.graphics ??= {}).pipelines = src.pipelines
  // Published without its WebGL 2 shaders: the player asks for WebGPU and says so where there is none.
  if (src.projectSettings?.publish.webgl2Fallback === false) (config.graphics ??= {}).webgl2 = false
  if (Object.keys(config).length > 0) out.config = config
  return out
}

