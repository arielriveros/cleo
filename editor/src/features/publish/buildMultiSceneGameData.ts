import { Scene, TextureManager } from 'cleo'
import type { RenderSettings } from 'cleo'
import { buildGameData, bakeTemplates } from './buildGameData'
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
    resyncScene(tmp, maps, src.libs, data.assetHashes)
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

  // Textures once, for the whole game (they are global, not per scene). As raw compressed bytes, not
  // base64: the packer writes them verbatim into game.bin, so publishing neither encodes nor inflates
  // them. Must run on the main thread — the canvas fallback inside needs a DOM.
  let textureBytes: any[] = []
  try { textureBytes = TextureManager.Instance.serializeTextureBytes() } catch { textureBytes = [] }

  // Templates once too, for the same reason as textures: the runtime registry is global, the player loads it
  // at boot, and a Game.loadScene switch must not invalidate what a script can still instantiate. Every
  // template in the library ships — a script may name any of them, and there is no way to tell statically.
  const templates = bakeTemplates(src.libs.templates ?? [], src.libs.materials, src.scriptAssets)

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
