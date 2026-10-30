// How much memory an asset costs, without ever building a string.
//
// The obvious measure — `JSON.stringify(asset).length` — is the very thing that fails on the assets worth
// measuring: a large model runs past V8's maximum string length (see utils/deepClone). This walks the
// structure instead and adds up what the payloads actually occupy, which is also what decides whether a
// structured clone of the whole library will fit.

/** Which part of a model asset the bytes are in. Enough to tell "one huge mesh" from "duplicated clips". */
export type SizeBreakdown = {
  total: number
  geometry: number
  joints: number
  clips: number
  thumbnail: number
  other: number
}

const EMPTY: SizeBreakdown = { total: 0, geometry: 0, joints: 0, clips: 0, thumbnail: 0, other: 0 }

/**
 * Bytes a value occupies, approximately:
 *  - a typed array is its real `byteLength` (4 bytes per float32 element);
 *  - a plain array of numbers costs 8 bytes each — V8 holds it as PACKED_DOUBLE_ELEMENTS, which is why
 *    `Array.from`-ing a Float32Array into JSON doubles a mesh;
 *  - a string costs 2 bytes per char (a base64 thumbnail is mostly this).
 * Object overhead is ignored; it is noise next to a vertex buffer.
 */
function bytesOf(value: any, seen: Set<object>): number {
  if (value == null) return 0
  if (typeof value === 'string') return value.length * 2
  if (typeof value === 'number' || typeof value === 'boolean') return 8
  if (typeof value !== 'object') return 0

  // A shared sub-object is counted ONCE — the question is "how much memory does this hold", and a
  // structured clone of a graph writes a shared node once too. Not hypothetical: the loader hands the
  // same animation array to every sub-mesh of a file, so a naive walk triples a character.
  // Registering before the buffer branches is what makes that true of buffers as well.
  if (seen.has(value)) return 0
  seen.add(value)

  if (ArrayBuffer.isView(value)) return (value as ArrayBufferView).byteLength
  if (value instanceof ArrayBuffer) return value.byteLength

  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === 'number') return value.length * 8
    let n = 0
    for (const item of value) n += bytesOf(item, seen)
    return n
  }

  let n = 0
  for (const key of Object.keys(value)) n += bytesOf(value[key], seen)
  return n
}

/** Bytes a single value occupies. The un-categorised half of {@link estimateAssetBytes}. */
export function estimateBytes(value: any): number {
  return bytesOf(value, new Set())
}

/**
 * A model asset's size, split by what it is spent on. `nodeJson` is walked for `model.geometry`,
 * `model.jointIndices`/`jointWeights`/`skin` and `model.animations` at every depth; everything else in
 * the asset (materials, node variables, submesh tables) lands in `other`.
 */
export function estimateAssetBytes(asset: { nodeJson?: any; thumbnail?: string } | null | undefined): SizeBreakdown {
  if (!asset) return { ...EMPTY }
  const seen = new Set<object>()
  const out: SizeBreakdown = { ...EMPTY }

  out.thumbnail = bytesOf(asset.thumbnail, seen)

  const walk = (json: any): void => {
    if (!json || typeof json !== 'object') return
    const model = json.model
    if (model && typeof model === 'object') {
      out.geometry += bytesOf(model.geometry, seen)
      out.joints += bytesOf(model.jointIndices, seen) + bytesOf(model.jointWeights, seen) + bytesOf(model.skin, seen)
      out.clips += bytesOf(model.animations, seen)
    }
    // Everything on the node that is not the model subtree already counted above.
    for (const key of Object.keys(json)) {
      if (key === 'model' || key === 'children') continue
      out.other += bytesOf(json[key], seen)
    }
    if (model && typeof model === 'object')
      for (const key of Object.keys(model)) {
        if (key === 'geometry' || key === 'jointIndices' || key === 'jointWeights' || key === 'skin' || key === 'animations') continue
        out.other += bytesOf(model[key], seen)
      }
    for (const child of json.children ?? []) walk(child)
  }
  walk(asset.nodeJson)

  out.total = out.geometry + out.joints + out.clips + out.thumbnail + out.other
  return out
}

/** `1.4 GB` / `312 MB` / `88 kB` — for log lines a human reads. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** The category holding most of an asset's bytes, for a one-line "what is big about it". */
export function dominantCategory(b: SizeBreakdown): keyof SizeBreakdown {
  const parts: (keyof SizeBreakdown)[] = ['geometry', 'joints', 'clips', 'thumbnail', 'other']
  return parts.reduce((best, k) => (b[k] > b[best] ? k : best), parts[0])
}

/** An asset this size deserves a warning: past here a whole-library structured clone starts failing. */
export const LARGE_ASSET_BYTES = 128 * 1024 * 1024
/** A library this size is why writes fail; the repair path uses it as its trigger. */
export const LARGE_LIBRARY_BYTES = 512 * 1024 * 1024

/**
 * A one-line-per-offender report of a model library, or null when nothing is worth saying.
 * Cheap enough to run on every load — it never stringifies and never copies.
 */
export function libraryReport(assets: { id: string; name: string; nodeJson?: any; thumbnail?: string }[]): {
  total: number
  lines: string[]
  oversized: boolean
} {
  let total = 0
  const rows: { name: string; b: SizeBreakdown }[] = []
  for (const a of assets) {
    const b = estimateAssetBytes(a)
    total += b.total
    rows.push({ name: a.name, b })
  }
  rows.sort((x, y) => y.b.total - x.b.total)
  const lines = rows
    .filter(r => r.b.total >= LARGE_ASSET_BYTES)
    .map(r => `  ${r.name}: ${formatBytes(r.b.total)} (mostly ${dominantCategory(r.b)})`)
  return { total, lines, oversized: total >= LARGE_LIBRARY_BYTES || lines.length > 0 }
}
