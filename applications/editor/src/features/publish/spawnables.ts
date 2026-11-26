// What a scene can spawn, for its shader preparation (utils/sceneShaders.ts, Renderer.prepareShaders): the library's
// templates it does not place, baked the way Play bakes them (materials resolved, scripts injected). A template the
// scene places is drawn by the sweep already; one only a script instantiates (a muzzle flash, an impact, a bullet
// hole) would otherwise build its shaders the frame it first appears, and a GPU particle system or a decal can hold
// the window for seconds doing it.

import { TextureManager, type Scene } from 'cleo'
import { bakeTemplates } from './buildGameData'
import { collectReferencedTemplateIds } from '../../utils/references'
import type { Template } from '../../utils/templates'
import type { MaterialAsset } from '../../utils/materials'
import type { ScriptAsset } from '../../utils/scripts'

/** The templates `scene` does not place: the ones it can only spawn. */
export function unplacedTemplates(templates: readonly Template[], scene: Scene | null | undefined): Template[] {
  const placed = collectReferencedTemplateIds(scene)
  return templates.filter(t => !placed.has(t.id))
}

/**
 * The subtrees to draw with `scene` while its shaders are prepared: each template it does not place, baked as Play
 * bakes it. The editor's `instantiateTemplate` is not used: it files the copy's scripts under its new ids. A legacy
 * template's embedded textures are registered as an instance of it would register them. One that fails to bake is
 * left out.
 */
export function spawnableSubtrees(templates: readonly Template[], materials?: MaterialAsset[], scriptAssets?: ScriptAsset[]): unknown[] {
  const out: unknown[] = []
  for (const template of templates) {
    for (const t of template.textures || []) {
      if (!TextureManager.Instance.getTexture(t.id)) TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
    }
    try {
      const [baked] = bakeTemplates([template], materials, scriptAssets)
      if (!baked?.node) continue
      if (baked.node.variables) delete baked.node.variables.__templateId
      out.push(baked.node)
    } catch { /* a template that cannot bake cannot be spawned either */ }
  }
  return out
}
