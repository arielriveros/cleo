import {
  TextureManager, bakeOctahedralImpostor, rgbaSampler, OCTA_DEFAULT_FRAMES,
  type OctahedralBakePart, type OctahedralImpostorInfo,
} from 'cleo'

// The editor half of an OCTAHEDRAL foliage impostor: gather a rule's LOD0 prototype (the flattened Model
// JSON foliageRules builds, transforms already baked), decode each texture it samples, run the engine's
// CPU baker (src/terrain/octahedralBake.ts — the same one the Valley generator runs), and register the two
// atlases. The single-view card stays in modelThumbnails.ts `bakeModelImpostor`.

/** Views per side the editor bakes. */
export const OCTAHEDRAL_FRAMES = OCTA_DEFAULT_FRAMES
/** Default atlas side: 8 x 8 views of 128 px. 2048 (256 px views) for a tree seen large, close up. */
export const OCTAHEDRAL_ATLAS_SIZE = 1024

export function octahedralNormalTextureId(modelId: string): string { return `${modelId}__impostorNormal` }

export interface OctahedralBakeOutput {
  info: OctahedralImpostorInfo
  albedo: string   // PNG data URL
  normal: string   // PNG data URL
  coverage: number
}

/** Decode a registered texture's image into RGBA8 rows (row 0 = top), or null when it has no source. */
async function decodeTexture(id: string): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  const source = TextureManager.Instance.getSource(id)
  if (!source) return null
  try {
    const bitmap = await createImageBitmap(new Blob([source.bytes as unknown as BlobPart], { type: source.mime }),
                                           { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    bitmap.close()
    return { data, width: canvas.width, height: canvas.height }
  } catch {
    return null
  }
}

async function encodePng(rgba: Uint8ClampedArray, size: number): Promise<string> {
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(rgba as any, size, size), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** What a serialized material contributes to the bake: base colour (texture and tint) and its cutout. */
function surfaceOf(material: any): { color: [number, number, number, number]; base?: string; mask?: string; cutoff: number } {
  const t = material?.textures ?? {}
  const tint = material?.type === 'basic' ? material.color : material?.baseColor
  const color: [number, number, number, number] = [tint?.[0] ?? 1, tint?.[1] ?? 1, tint?.[2] ?? 1, 1]
  const base: string | undefined = material?.type === 'basic' ? t.texture : t.baseColorTexture
  const mask: string | undefined = t.mask
  const cutoff = Number(material?.alphaCutoff ?? (mask ? 0.5 : 0)) || 0
  return { color, base: base || undefined, mask: mask || undefined, cutoff }
}

/**
 * Bake an octahedral impostor of `models` (Model.serialize() payloads, one per sub-mesh). `atlasSize` is
 * the albedo atlas's side; the normals are baked at half of it. Returns null when there is nothing to draw.
 */
export async function bakeOctahedralFromModels(models: readonly any[], atlasSize = OCTAHEDRAL_ATLAS_SIZE): Promise<OctahedralBakeOutput | null> {
  const textures = new Map<string, Promise<ReturnType<typeof rgbaSampler> | null>>()
  const sampler = (id: string | undefined) => {
    if (!id) return Promise.resolve(null)
    if (!textures.has(id))
      textures.set(id, decodeTexture(id).then(t => t ? rgbaSampler(t.data, t.width, t.height) : null))
    return textures.get(id)!
  }

  const parts: OctahedralBakePart[] = []
  for (const model of models) {
    const g = model?.geometry
    if (!g?.positions?.length) continue
    const materials: any[] = Array.isArray(model.materials) && model.materials.length ? model.materials : [model.material]
    // One part per submesh, each with its own surface; a whole-buffer model is one part.
    const ranges: { start: number; count: number }[] = Array.isArray(model.submeshes) && model.submeshes.length === materials.length
      ? model.submeshes : [{ start: 0, count: g.indices?.length ?? 0 }]
    for (let k = 0; k < ranges.length; k++) {
      const surface = surfaceOf(materials[k] ?? materials[0])
      const [base, mask] = await Promise.all([sampler(surface.base), sampler(surface.mask)])
      const scratch = new Float32Array(4)
      const sample = base || mask
        ? (u: number, v: number, out: Float32Array) => {
          if (base) base(u, v, out); else { out[0] = out[1] = out[2] = out[3] = 1 }
          // The mask is read from RED, as the material reads it (material.ts applyMask).
          if (mask) { mask(u, v, scratch); out[3] = scratch[0] }
        }
        : null
      const { start, count } = ranges[k]
      parts.push({
        positions: g.positions, normals: g.normals, uvs: g.texCoords,
        indices: g.indices ? Array.prototype.slice.call(g.indices, start, start + count) : null,
        sample, color: surface.color, cutoff: surface.cutoff,
      })
    }
  }
  if (!parts.length) return null

  // Yield once so the "Baking…" state paints before a few seconds of synchronous work.
  await new Promise(resolve => setTimeout(resolve, 0))
  const frameSize = Math.max(16, Math.round(atlasSize / OCTAHEDRAL_FRAMES))
  const bake = bakeOctahedralImpostor(parts, {
    frames: OCTAHEDRAL_FRAMES, frameSize, normalFrameSize: Math.max(8, frameSize >> 1), supersample: 2,
  })
  const [albedo, normal] = await Promise.all([encodePng(bake.albedo, bake.albedoSize), encodePng(bake.normal, bake.normalSize)])
  return { info: bake.info, albedo, normal, coverage: bake.coverage }
}
