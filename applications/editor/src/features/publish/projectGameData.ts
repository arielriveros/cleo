// The game data of a project read as a bundle (a project folder through the folder codec, or a bundle), packed
// the way Play in window packs it: for running a project headless without the editor — the netsync host's
// development games and tests (applications/host/src/exampleGame.ts), and `openProject` in cleo/testing.
//
// The same data a Play-in-window pack carries — scenes, baked templates (scripts injected, materials resolved), the
// shared animation clips, the input map, the project's settings — built with the editor's own publish helpers.
// Scripts stay source (the engine compiles them at parse): every scene node that runs a script asset gets the
// library's source, as the editor's Play does (fanOutScripts), so an edited .ts is what runs. Textures and sounds
// are left out (nothing headless draws or plays them). What it does NOT do that Publish does: re-resolve scenes
// against the asset libraries, strip features, stamp dimensions. Fine for projects saved resolved.

import { attachScriptModules, bakeTemplates } from './buildGameData'
import { sharedAnimationData } from './sharedAnimations'
import { parseProjectSettings, projectSettingsConfig } from '../options/projectSettings'
import { settleScriptCopies } from '../../utils/folder/scriptCopies'

export interface ProjectGameOptions {
  /** Physics backend to record in the game's config. Default: the project's, else the engine's. */
  physicsBackend?: string
  /** Change the game data before it is packed (a test raising a match's bot count, say). */
  edit?: (data: Record<string, any>) => void
}

/** The game data of `bundle` (readBundle's shape), as Play in window builds it, before packing. */
export function projectGameData(bundle: any, options: ProjectGameOptions = {}): Record<string, any> {
  const libs = bundle.libraries ?? {}
  const sceneTable: Record<string, { scene?: any }> = {}
  const scenes: Record<string, { name: string; scene: unknown }> = {}
  for (const meta of bundle.manifest?.sceneMetas ?? []) {
    const file = bundle.scenes?.[meta.id]
    if (!file?.scene) continue
    const scene = structuredClone(file.scene)
    sceneTable[meta.id] = { scene }
    scenes[meta.id] = { name: meta.name, scene }
  }
  // Each scene node that runs a script asset runs the library's source (a folder stores no copy on the node).
  settleScriptCopies({ scenes: sceneTable, libraries: { scripts: libs.scripts ?? [] } }, { fill: true })
  const entry = bundle.manifest?.mainSceneId in scenes ? bundle.manifest.mainSceneId : Object.keys(scenes)[0]
  if (!entry) throw new Error(`${bundle.manifest?.projectName ?? 'the project'} has no scenes`)

  const data: Record<string, any> = {
    version: 2,
    entry,
    scenes,
    templates: bakeTemplates(libs.templates ?? [], libs.materials, libs.scripts),
    textureBytes: [],
  }
  // Script modules (shared code scripts import), as the editor resolves them: each script asset's path in the
  // project's file tree, every scene and template stamped with its scripts' paths, the import closure shipped.
  const scriptPaths = new Map<string, string>(
    (bundle.vfs?.entries ?? []).filter((e: any) => e.kind === 'script').map((e: any) => [e.assetId, e.path] as [string, string]))
  if (libs.scripts?.length && scriptPaths.size) {
    const all: any = { scene: { children: Object.values(scenes).map((e) => e.scene) }, templates: data.templates }
    attachScriptModules(all, libs.scripts, scriptPaths)
    if (all.modules) data.modules = all.modules
  }
  const shared = sharedAnimationData(libs)
  if (shared.animations.length) {
    data.animations = shared.animations
    data.modelAnimations = shared.modelAnimations
    if (shared.retargets) data.retargets = shared.retargets
  }
  const config: Record<string, any> = {}
  // The project's own settings, as Publish writes them (physics, online play…), when it carries any.
  if (libs.projectSettings) Object.assign(config, projectSettingsConfig(parseProjectSettings(libs.projectSettings)))
  if (libs.inputMap) config.input = libs.inputMap
  if (options.physicsBackend) config.physics = { ...(config.physics ?? {}), backend: options.physicsBackend }
  data.config = config
  options.edit?.(data)
  return data
}
