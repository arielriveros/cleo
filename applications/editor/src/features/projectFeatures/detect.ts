// What the whole project uses of the engine's optional features: every scene (the open one live, the rest as
// saved), every template and every script asset. The Features panel's badges and Detect from Project. A
// lighter read than a publish: nothing is re-resolved and no texture is touched.
import type { Scene, RenderSettings } from 'cleo'
import { FEATURES } from 'cleo'
import { loadSceneData, type SceneMeta } from '../../utils/sceneStorage'
import type { Template } from '../../utils/templates'
import type { MaterialAsset } from '../../utils/materials'
import type { ScriptAsset } from '../../utils/scripts'
import { bakeTemplates } from '../publish/buildGameData'
import { featureUsage, type FeatureUsage, type UsageSource } from '../publish/featureUsage'

export interface ProjectUsageSources {
  liveScene: Scene | null;
  openSceneId: string;
  scenes: readonly SceneMeta[];
  liveSettings?: Partial<RenderSettings>;
  /** The open scene's live dimension (its meta can be a save behind). */
  liveDimension?: '2D' | '3D';
  templates: Template[];
  materials?: MaterialAsset[];
  scriptAssets: ScriptAsset[];
}

/** Every use of a feature in the project. */
export async function detectProjectUsage(src: ProjectUsageSources): Promise<FeatureUsage> {
  const scenes: UsageSource['scenes'] = {}
  for (const meta of src.scenes) {
    if (meta.id === src.openSceneId && src.liveScene) {
      const json = await src.liveScene.serialize(true)
      scenes[meta.id] = { name: meta.name, scene: json.scene, render: src.liveSettings, dimension: src.liveDimension ?? meta.dimension }
      continue
    }
    const data = await loadSceneData(meta.id).catch(() => null)
    if (data) scenes[meta.id] = { name: meta.name, scene: data.scene, render: data.config?.render, dimension: meta.dimension }
  }
  let templates: UsageSource['templates'] = []
  try { templates = bakeTemplates(src.templates, src.materials, src.scriptAssets) } catch { /* a template that cannot bake is skipped */ }
  const modules = Object.fromEntries(src.scriptAssets.map(a => [a.name, a.source]))
  return featureUsage({ scenes, templates, modules })
}

/**
 * Detect from Project: each feature the scan can see (one with nodes, materials or render settings to look for)
 * is on if the project uses it and off if not; the rest keep their state, since nothing here can tell
 * whether a game takes input. Returns the new disabled list.
 */
export function detectedDisabled(usage: FeatureUsage, current: readonly string[]): string[] {
  const out = new Set(current)
  for (const f of FEATURES) {
    const visible = !!(f.nodeTypes?.length || f.materialTypes?.length || f.renderSettingsOff?.length)
    if (!visible) continue
    if (usage.has(f.id)) out.delete(f.id)
    else out.add(f.id)
  }
  // What an enabled feature needs stays on.
  for (const f of FEATURES) if (!out.has(f.id)) for (const d of f.dependsOn ?? []) out.delete(d)
  return [...out].sort()
}
