import { RENDER_2D_DEFAULTS, RENDER_3D_DEFAULTS } from 'cleo';
import type { RenderSettings } from 'cleo';

/**
 * The render settings a scene's look changes to when its dimension is switched, or null to leave them.
 *
 * To 2D: the 2D look (RENDER_2D_DEFAULTS: no tone curve, bloom only past white), so the flat 2D frame shows
 * the art as drawn from the first frame. Back to 3D: the engine's 3D values for the same keys, but only
 * while every one of them still holds its 2D value -- a 2D look the artist retuned is theirs to keep.
 */
export function dimensionLookPatch(current: Partial<RenderSettings>, to: '2D' | '3D'): Partial<RenderSettings> | null {
  if (to === '2D') return { ...RENDER_2D_DEFAULTS }
  for (const [key, value] of Object.entries(RENDER_2D_DEFAULTS))
    if ((current as Record<string, unknown>)[key] !== value) return null
  return { ...RENDER_3D_DEFAULTS }
}
