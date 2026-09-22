// The layers of a SERIALIZED terrain, whichever format it was saved in.
//
// A landscape saved before the layer stack carries `layers[]` (four slots over a normalized splat); one
// saved since carries `layerStack.base` and `layerStack.paintLayers[]` (see `TerrainLayerStack.serialize`).
// Every walker that looks inside a terrain's layers — publish texture collection, geometry interning,
// foliage inflation, reference collection — reads BOTH, through this one function, so none of them can
// learn the new shape and forget the old one or the other way round.
//
// Deliberately dependency-free: the published player's unpack imports it.

/** One layer of a serialized terrain, normalised across the two formats. */
export interface SerializedTerrainLayer {
  /** The layer's embedded landscape-material JSON, or null. */
  material: any | null
  /** Its landscape-material library link, or null. */
  materialId: string | null
  /** A legacy plain-albedo layer's texture (old format only). */
  textureId: string | null
}

/** Every layer of a serialized terrain: the base first, then the paint layers (or the four legacy slots). */
export function serializedTerrainLayers(terrain: any): SerializedTerrainLayer[] {
  if (!terrain || typeof terrain !== 'object') return []
  const out: SerializedTerrainLayer[] = []
  const add = (l: any) => {
    if (!l || typeof l !== 'object') return
    out.push({
      material: l.material && typeof l.material === 'object' ? l.material : null,
      materialId: typeof l.materialId === 'string' ? l.materialId : null,
      textureId: typeof l.textureId === 'string' ? l.textureId : null,
    })
  }
  const stack = terrain.layerStack
  if (stack && typeof stack === 'object') {
    add(stack.base)
    for (const l of Array.isArray(stack.paintLayers) ? stack.paintLayers : []) add(l)
  }
  // Legacy, and also still read when both are present: a half-migrated blob is not worth losing data over.
  for (const l of Array.isArray(terrain.layers) ? terrain.layers : []) add(l)
  return out
}

/**
 * Every foliage rule a serialized terrain's layer materials include — the prototypes pack interns and
 * unpack inflates. Slot surfaces carry no foliage rules; the rules belong to the landscape material.
 */
export function serializedTerrainFoliageRules(terrain: any): any[] {
  const rules: any[] = []
  for (const layer of serializedTerrainLayers(terrain))
    for (const rule of Array.isArray(layer.material?.foliageInclude) ? layer.material.foliageInclude : []) rules.push(rule)
  return rules
}
