// Heightmap import for a landscape, kept out of the inspector component so the one rule that matters here
// can be tested without React: THE TERRAIN IS READ FROM THE NODE AT CALL TIME.
//
// `rebuildTerrain` swaps a brand-new `Terrain` onto the node (Rebuild after a size change does exactly
// this). The inspector used to capture `node.terrain` when it rendered, and nothing re-rendered it after a
// rebuild, so the next import wrote into the disposed old terrain — the landscape on screen never changed,
// however many times the file was re-picked or the amplitude edited.

/** The slice of a landscape node this module needs. Structural, so a test can stand in a fake. */
export interface HeightmapTarget {
  readonly terrain: {
    importHeightmap(path: string, amplitude: number): Promise<void>
    heightAt(localX: number, localZ: number): number
    readonly origin: ArrayLike<number>
    readonly foliage: ReadonlyArray<{ reseat(sampleHeight: (x: number, z: number) => number): boolean }>
  }
}

/**
 * Replace `node`'s height field from an image URL, then re-seat every foliage instance on the new ground.
 * The terrain is looked up on `node` HERE, never passed in, for the reason in the header.
 */
export async function importHeightmapInto(node: HeightmapTarget, url: string, amplitude: number): Promise<void> {
  const terrain = node.terrain
  await terrain.importHeightmap(url, amplitude)
  // Foliage Y is baked at scatter time, so a wholesale height change leaves it floating or buried.
  const origin = terrain.origin
  const sampleHeight = (x: number, z: number) => origin[1] + terrain.heightAt(x - origin[0], z - origin[2])
  for (const layer of terrain.foliage) layer.reseat(sampleHeight)
}

/**
 * Replace `node`'s whole height field and re-seat its foliage. Returns false on a terrain without
 * `setHeights` (see utils/terrainAccess). The terrain is looked up on the node here, as above.
 */
export function applyHeightsTo<T extends HeightmapTarget['terrain']>(node: { readonly terrain: T }, heights: Float32Array,
                                                                    setHeights: (terrain: T, h: Float32Array) => boolean): boolean {
  const terrain = node.terrain
  if (!setHeights(terrain, heights)) return false
  const origin = terrain.origin
  const sampleHeight = (x: number, z: number) => origin[1] + terrain.heightAt(x - origin[0], z - origin[2])
  for (const layer of terrain.foliage) layer.reseat(sampleHeight)
  return true
}

/** `heightmap_min-12.5_max40.png` — the range an export encodes in its name, read back on import. */
export function rangeFromFileName(name: string): { min: number; max: number } | null {
  const m = /_min(-?\d+(?:\.\d+)?)_max(-?\d+(?:\.\d+)?)/i.exec(name)
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null
}

/** Read a picked file as a data URL, rejecting (rather than hanging) when the read fails. */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'))
    reader.readAsDataURL(file)
  })
}
