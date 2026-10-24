import type { Renderer, Scene, SceneLightLevel } from 'cleo'

/**
 * How bright `scene` is, for `presetForScene` / `newLightOptions`: the exposure it is seen at (the metered
 * EV while auto exposure is on) and its flat ambient fill — the luminance of the scene's ambient lux, times
 * a sky light's Ambient. Null without a renderer, which callers take as "use the real values".
 */
export function sceneLightLevel(scene: Scene | null | undefined, renderer: Renderer | null | undefined): SceneLightLevel | null {
  if (!scene || !renderer) return null
  const a = scene.ambientLight
  const lux = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]
  return { ev100: renderer.ev100, ambientLux: lux * (scene.skyLight?.ambient ?? 1) }
}
