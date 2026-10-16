import { createProgramUsage, usageFromSceneJson, usageFromRenderSettings, castsShadows, programsFor } from 'cleo'
import type { RenderSettings } from 'cleo'

/**
 * The shader programs a published game needs (`config.graphics.programs`): what every scene and every
 * template draws, plus what the render settings switch on. The player builds only these at boot, which
 * is most of a first launch's wait on Windows. Anything this misses still builds the first time it is
 * drawn (with a warning in the console), so the list errs toward including.
 *
 * Templates count in full: a script can spawn any of them into any scene.
 */
export function collectPrograms(game: { scenes: Record<string, { scene: any }>; templates?: { node: any }[] },
                                render: Partial<RenderSettings> | undefined): string[] {
  const use = createProgramUsage()
  const roots = [...Object.values(game.scenes).map(e => e.scene), ...(game.templates ?? []).map(t => t.node)]
  const shadows = roots.some(castsShadows)
  for (const root of roots) usageFromSceneJson(root, use, shadows)
  usageFromRenderSettings(render, use)
  return programsFor(use)
}
