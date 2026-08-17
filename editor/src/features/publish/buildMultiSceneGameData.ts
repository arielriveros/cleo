import { Scene, TextureManager } from 'cleo'
import type { RenderSettings } from 'cleo'
import { buildGameData, bakeTemplates } from './buildGameData'
import { compressTerrainData, compressTilemapData } from './terrainImages'
import { stripDimensionData } from './stripDimensionData'
import { collectPublishedTextureIds } from '../../utils/references'
import { extractNodeState } from '../../utils/projectStorage'
import { resyncScene } from '../../utils/sceneResync'
import { loadSceneData } from '../../utils/sceneStorage'
import type { SceneMeta } from '../../utils/sceneStorage'
import type { AssetLibs } from '../../utils/assetHash'
import type { BodyDescription, ShapeDescription } from '../EngineContext'
import type { UIState } from '../../utils/UIModel'
import type { ScriptAsset } from '../../utils/scripts'

// game.json v2: a multi-scene published game. The entry (main) scene runs first; scripts can call
// Game.loadScene(name|id) to switch at runtime. Textures are serialized ONCE at the top level (they are
// global), and every scene's tree is built through the same buildGameData path as a single-scene publish
// so nothing about the runtime shape changes per scene.
//
// Closed scenes are re-resolved against the current asset libraries first (resyncScene), so an asset
// edited while a scene was closed still ships up to date — the cross-scene propagation requirement, at
// publish time.

export interface MultiSceneSources {
  mainSceneId: string
  openSceneId: string
  scenes: SceneMeta[]
  // The live, currently-open scene + its editor maps (so unsaved edits publish, as single-scene did).
  liveScene: Scene
  liveScripts: Map<string, string>
  liveBodies: Map<string, BodyDescription>
  liveTriggers: Map<string, { shapes: ShapeDescription[] }>
  liveUi: UIState
  libs: AssetLibs
  scriptAssets?: ScriptAsset[]
  settings?: RenderSettings
  /** The OPEN scene's live dimension. Its meta can be one save behind, and the live value is the truth. */
  liveDimension?: '2D' | '3D'
}

export async function buildMultiSceneGameData(src: MultiSceneSources): Promise<any> {
  const scenes: Record<string, { name: string; scene: any; ui: any }> = {}

  for (const meta of src.scenes) {
    if (meta.id === src.openSceneId) {
      // The open scene: serialize the live scene + live maps (includes unsaved edits).
      const gd = await buildGameData({
        scene: src.liveScene,
        scripts: src.liveScripts,
        scriptAssets: src.scriptAssets,
        bodies: src.liveBodies,
        triggers: src.liveTriggers,
        ui: src.liveUi,
        useCache: true, // textures are embedded once below, not per scene
      })
      scenes[meta.id] = { name: meta.name, scene: gd.scene, ui: gd.ui }
      continue
    }

    // A closed scene: load its blob, pull scripts/bodies/triggers into temp maps, parse a throwaway
    // Scene, re-resolve its assets against the current libraries, then serialize it the normal way.
    const data = await loadSceneData(meta.id)
    if (!data) continue
    const clone = JSON.parse(JSON.stringify({ scene: data.scene, ui: data.ui }))
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
      ui: clone.ui ?? { version: 1, elements: [] },
      useCache: true,
    })
    scenes[meta.id] = { name: meta.name, scene: gd.scene, ui: gd.ui }
  }

  // Discard the authoring each scene's dimension does not use — a landscape in a 2D scene, a tilemap in
  // a 3D one. The ordering here is load-bearing and there are two reasons for it: compressing a heightfield
  // we are about to delete is pure waste, and the texture filter below is driven off the SERIALIZED scenes,
  // so a landscape stripped after it would still drag its layer textures into the build.
  for (const meta of src.scenes) {
    const entry = scenes[meta.id]
    if (!entry) continue
    // An UNKNOWN dimension strips nothing. A scene saved before dimension became per-scene has none
    // recorded, and guessing wrong here would silently delete the authoring the game is built around —
    // the same asymmetry the texture walker reasons about, so it errs the same way. One save per scene
    // records the resolved value and the strip starts applying.
    const dimension = meta.id === src.openSceneId ? (src.liveDimension ?? meta.dimension) : meta.dimension
    if (dimension) stripDimensionData(entry.scene, dimension)
  }

  // Bulk terrain and tilemap data (height field, splat map, tile grids) out of the JSON manifest and into
  // deflated byte arrays the packer moves into game.bin. Main thread: CompressionStream lives here,
  // alongside the rest of the DOM-dependent publish prep.
  for (const entry of Object.values(scenes)) {
    await compressTerrainData(entry.scene)
    await compressTilemapData(entry.scene)
  }

  // Templates once too, for the same reason as textures: the runtime registry is global, the player loads it
  // at boot, and a Game.loadScene switch must not invalidate what a script can still instantiate. Every
  // template in the library ships — a script may name any of them, and there is no way to tell statically.
  const templates = bakeTemplates(src.libs.templates ?? [], src.libs.materials, src.scriptAssets)

  // Textures once, for the whole game (they are global, not per scene). As raw compressed bytes, not
  // base64: the packer writes them verbatim into game.bin, so publishing neither encodes nor inflates
  // them. Must run on the main thread — the canvas fallback inside needs a DOM.
  //
  // Narrowed to what the SERIALIZED scenes and templates actually reference. Unfiltered, this shipped
  // the entire TextureManager — every texture the project had ever imported, used or not. Note the
  // filter must run AFTER bakeTemplates, since a template can be the only referrer of a texture.
  const wanted = new Set<string>()
  for (const entry of Object.values(scenes)) collectPublishedTextureIds(entry.scene, wanted)
  for (const t of templates) collectPublishedTextureIds((t as any).node, wanted)

  let textureBytes: any[] = []
  try {
    // Empty means the walker found nothing to keep — far more likely a walker bug than a genuinely
    // textureless game, so fall back to shipping everything rather than a build with no textures.
    textureBytes = wanted.size > 0
      ? TextureManager.Instance.serializeTextureBytes(wanted)
      : TextureManager.Instance.serializeTextureBytes()
  } catch { textureBytes = [] }

  const out: any = {
    version: 2,
    entry: src.mainSceneId in scenes ? src.mainSceneId : Object.keys(scenes)[0],
    scenes,
    templates,
    textureBytes,
  }
  if (src.settings) out.config = { graphics: { clearColor: src.settings.clearColor }, render: src.settings }
  return out
}
