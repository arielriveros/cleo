import { Scene, TextureManager, AudioManager } from 'cleo'
import type { RenderSettings, InputMap } from 'cleo'
import { isDefaultInputMap } from 'cleo'
import { buildGameData, bakeTemplates } from './buildGameData'
import { compressTerrainData, compressTilemapData } from './terrainImages'
import { stripDimensionData } from './stripDimensionData'
import { collectPublishedTextureIds, collectPublishedSoundIds } from '../../utils/references'
import { extractNodeState } from '../../utils/projectStorage'
import { resyncScene } from '../../utils/sceneResync'
import { loadSceneData } from '../../utils/sceneStorage'
import type { SceneMeta } from '../../utils/sceneStorage'
import type { AssetLibs } from '../../utils/assetHash'
import type { BodyDescription, ShapeDescription } from '../EngineContext'
import { migrateLegacyUI } from '../../utils/uiMigration'
import type { ScriptAsset } from '../../utils/scripts'
import { deepClone } from '../../utils/deepClone'

// game.json v2: a multi-scene published game. The entry (main) scene runs first; scripts call
// Game.loadScene(name|id) to switch at runtime. Textures are serialized ONCE at the top level (they are
// global) and every scene's tree goes through the same buildGameData path as a single-scene publish.
// Closed scenes are re-resolved against the current asset libraries first (resyncScene).

export interface MultiSceneSources {
  mainSceneId: string
  openSceneId: string
  scenes: SceneMeta[]
  // The live, currently-open scene + its editor maps (so unsaved edits publish, as single-scene did).
  liveScene: Scene
  liveScripts: Map<string, string>
  liveBodies: Map<string, BodyDescription>
  liveTriggers: Map<string, { shapes: ShapeDescription[] }>
  libs: AssetLibs
  scriptAssets?: ScriptAsset[]
  settings?: RenderSettings
  /** The project's input action map. Written ONCE at the top level, never inside a scene's blob. */
  input?: InputMap
  /** The OPEN scene's live dimension. Its meta can be one save behind, and the live value is the truth. */
  liveDimension?: '2D' | '3D'
}

export async function buildMultiSceneGameData(src: MultiSceneSources): Promise<any> {
  const scenes: Record<string, { name: string; scene: any }> = {}

  for (const meta of src.scenes) {
    if (meta.id === src.openSceneId) {
      // The open scene: serialize the live scene + live maps (includes unsaved edits).
      const gd = await buildGameData({
        scene: src.liveScene,
        scripts: src.liveScripts,
        scriptAssets: src.scriptAssets,
        bodies: src.liveBodies,
        triggers: src.liveTriggers,
        useCache: true, // textures are embedded once below, not per scene
      })
      scenes[meta.id] = { name: meta.name, scene: gd.scene }
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
    const maps = { scripts: new Map<string, string>(), bodies: new Map<string, any>(), triggers: new Map<string, any>() }
    extractNodeState(clone.scene, maps)
    const tmp = new Scene()
    tmp.parse({ scene: clone.scene, textures: [] }, true) // useCache: textures already live in TextureManager
    resyncScene(tmp, maps, src.libs, data.assetHashes, data.assetHashVersion)
    const gd = await buildGameData({
      scene: tmp,
      scripts: maps.scripts,
      scriptAssets: src.scriptAssets,
      bodies: maps.bodies,
      triggers: maps.triggers,
      useCache: true,
    })
    scenes[meta.id] = { name: meta.name, scene: gd.scene }
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
    if (dimension) stripDimensionData(entry.scene, dimension)
  }

  // Bulk terrain and tilemap data (height field, splat map, tile grids) out of the JSON manifest and into
  // deflated byte arrays the packer moves into game.bin. Main thread: CompressionStream lives here.
  for (const entry of Object.values(scenes)) {
    await compressTerrainData(entry.scene)
    await compressTilemapData(entry.scene)
  }

  // Templates once, like textures: the runtime registry is global and a Game.loadScene switch must not
  // invalidate what a script can still instantiate. Every template ships — a script may name any of them.
  const templates = bakeTemplates(src.libs.templates ?? [], src.libs.materials, src.scriptAssets)

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

  // Shared animation clips ONCE for the whole game, in their source rig's space, plus a map of which model
  // asset uses which. `AnimatedModel.serialize` drops an asset-backed clip, so the scenes above carry
  // none; the player resolves and retargets at load. Narrowed to what a shipped model references.
  const modelAnimations: Record<string, string[]> = {}
  const wantedAnims = new Set<string>()
  for (const m of src.libs.models ?? []) {
    if (!m.animationIds?.length) continue
    modelAnimations[m.id] = [...m.animationIds]
    for (const id of m.animationIds) wantedAnims.add(id)
  }
  const animations = (src.libs.animations ?? []).filter(a => wantedAnims.has(a.id))

  const out: any = {
    version: 2,
    entry: src.mainSceneId in scenes ? src.mainSceneId : Object.keys(scenes)[0],
    scenes,
    templates,
    textureBytes,
  }
  if (soundBytes.length) out.soundBytes = soundBytes
  if (animations.length) { out.animations = animations; out.modelAnimations = modelAnimations }
  // One config for the whole game. `render` is per-project here even though a scene blob carries its
  // own copy; `input` is project-wide by design and has no per-scene form at all.
  const config: Record<string, any> = {}
  if (src.settings) {
    config.graphics = { clearColor: src.settings.clearColor }
    config.render = src.settings
  }
  if (src.input && !isDefaultInputMap(src.input)) config.input = src.input
  if (Object.keys(config).length > 0) out.config = config
  return out
}
