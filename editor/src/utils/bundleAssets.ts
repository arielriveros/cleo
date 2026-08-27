// Moving every bulk payload of an export bundle into one `assets.bin`, and putting it back on import.
// Numbers are written as raw little-endian bytes into a blob of 4-byte-aligned chunks with a reference
// left behind; the container primitives are shared with the publish packer — see utils/chunkBlob.ts.
//
// Three rules this packer must hold to that the publish packer does not:
//
//  1. EVERY payload is content-interned, not just geometry, so a clip reaching the writer from a model,
//     a template and a scene gets one chunk.
//  2. A payload is replaced IN PLACE by a marker (see `Marker` below), never moved to a new field:
//     `hashAsset` compares `JSON.stringify` output, so reordering an object's keys changes every
//     model's and template's content hash and resyncs every placement on first open.
//  3. Inflate restores the ORIGINAL JSON — plain `number[]`, base64 strings, data URLs, in their
//     original key order — because `bundleMerge` deep-clones and id-remaps these objects and
//     `Scene.parse` reads them. An export/import round trip must be byte-identical.
//
// Engine-free and DOM-free: this runs inside projectWorker.ts.

import { ChunkWriter, ChunkReader, type ChunkRef } from './chunkBlob'
import { base64ToBytes, bytesToBase64, bytesToDataUrl, parseBase64DataUri, deflateBytes, inflateBytes } from './bytes'
import {
  ATTR_STRIDE, GEOMETRY_ATTRS, type BundleAssetIndex, type BundleData, type BundleGeometry,
} from './bundle'

/**
 * What a packed value looks like while it sits in the JSON.
 *
 * Exactly one key each, so recognizing a marker is a single property test: `$geo` is an id into the
 * geometry table, `$f32`/`$f64`/`$idx` are number arrays, `$b64` is a base64 string (`z` when the bytes
 * were deflated first) and `$url` is a `data:` URI.
 *
 * Float width must be chosen per array by `narrowest`, never fixed: forcing f32 breaks the byte-identical
 * round trip (animation samplers and baked foliage geometry really carry float64), and forcing f64
 * doubles the largest payload in the bundle. A changed value changes that asset's content hash.
 */
type Marker =
  | { $geo: string }
  | { $f32: ChunkRef }
  | { $f64: ChunkRef }
  | { $idx: ChunkRef & { bits: 16 | 32 } }
  | { $b64: ChunkRef; z?: 1 }
  | { $url: ChunkRef; mime: string }

const isMarker = (v: any): v is Marker =>
  !!v && typeof v === 'object' &&
  (v.$geo !== undefined || !!v.$f32 || !!v.$f64 || !!v.$idx || !!v.$b64 || !!v.$url)

/** The six cubemap face keys, in the order Skybox.serialize writes them. */
const FACES = ['positiveX', 'negativeX', 'positiveY', 'negativeY', 'positiveZ', 'negativeZ'] as const

/**
 * Narrowest lossless index width. Mirrors `needs32Bit`/`createIndexArray` in src/graphics/indexFormat.ts
 * and the copy in publish/pack.ts; duplicated because the worker may not import `cleo`.
 * 65535 is excluded: WebGL2 reads it as the primitive-restart index.
 */
const INDEX_16_LIMIT = 65535

function toIndexArray(values: ArrayLike<number>): Uint16Array | Uint32Array {
  let max = -1
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i]
  return max >= INDEX_16_LIMIT ? new Uint32Array(values) : new Uint16Array(values)
}

const isNestedArray = (v: any): boolean =>
  Array.isArray(v) && v.length > 0 && (Array.isArray(v[0]) || (typeof v[0] === 'object' && v[0] !== null))

/**
 * Flatten `[[x,y,z], …]` into one array; a flat array passes straight through.
 * Float64Array, NOT Float32Array: narrowing is `narrowest`'s call and it must see the original values.
 */
function toFlat(input: any, stride: number): ArrayLike<number> {
  if (!input || input.length === 0) return EMPTY_FLAT
  if (!isNestedArray(input)) return input
  const out = new Float64Array(input.length * stride)
  for (let i = 0; i < input.length; i++)
    for (let k = 0; k < stride; k++) out[i * stride + k] = input[i][k] ?? 0
  return out
}

const EMPTY_FLAT = new Float64Array(0)

/** The inverse of toFloats' nested branch. */
function toTuples(flat: ArrayLike<number>, stride: number): number[][] {
  const out: number[][] = new Array(Math.floor(flat.length / stride))
  for (let i = 0; i < out.length; i++) {
    const tuple = new Array(stride)
    for (let k = 0; k < stride; k++) tuple[k] = flat[i * stride + k]
    out[i] = tuple
  }
  return out
}

const isNumberArray = (v: any): v is number[] =>
  Array.isArray(v) && v.length > 0 && typeof v[0] === 'number'

/**
 * The narrowest float array that holds `values` exactly.
 * `Math.fround` is the float32 round trip: a value that survives it fits back into 4 bytes.
 */
function narrowest(values: ArrayLike<number>): Float32Array | Float64Array {
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Math.fround(v) !== v && !Number.isNaN(v)) return new Float64Array(values)
  }
  return new Float32Array(values)
}

/** Every own key of an object or index of an array, so both can be walked by the same code. */
const slotsOf = (v: any): (string | number)[] =>
  Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v)

// ---------------------------------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------------------------------

export interface PackBundleResult {
  blob: ArrayBuffer
  index: BundleAssetIndex
}

/**
 * Move every payload in `bundle` into a blob, replacing each with a marker.
 * MUTATES `bundle`; the caller sent it in by structured clone, so the editor's own copy is untouched.
 */
export async function packBundleAssets(bundle: BundleData): Promise<PackBundleResult> {
  const writer = new ChunkWriter()
  const geometries: Record<string, BundleGeometry> = {}
  // record-shape -> id, keyed on the stringified REF SET, not the mesh: chunks are content-addressed by
  // the writer, so two identical meshes necessarily produce identical refs.
  const geometryIds = new Map<string, string>()

  const floats = (values: ArrayLike<number>): Marker => {
    const array = narrowest(values)
    const ref = writer.addInterned(array)
    return array instanceof Float64Array ? { $f64: ref } : { $f32: ref }
  }

  const indices = (values: ArrayLike<number>): Marker => {
    const array = toIndexArray(values)
    return { $idx: { ...writer.addInterned(array), bits: array instanceof Uint32Array ? 32 : 16 } }
  }

  const internGeometry = (raw: any): string => {
    const record: BundleGeometry = {}
    let nested = false
    for (const name of GEOMETRY_ATTRS) {
      const source = raw[name]
      if (!source || source.length === 0) continue
      if (isNestedArray(source)) nested = true
      const flat = toFlat(source, ATTR_STRIDE[name])
      if (flat.length === 0) continue
      const array = narrowest(flat)
      record[name] = array instanceof Float64Array
        ? { ...writer.addInterned(array), f64: 1 }
        : writer.addInterned(array)
    }
    if (raw.indices && raw.indices.length > 0) {
      const array = toIndexArray(raw.indices)
      record.indices = { ...writer.addInterned(array), bits: array instanceof Uint32Array ? 32 : 16 }
    }
    if (nested) record.nested = true

    const key = JSON.stringify(record)
    const hit = geometryIds.get(key)
    if (hit) return hit
    const id = 'g' + geometryIds.size
    geometryIds.set(key, id)
    geometries[id] = record
    return id
  }

  /** A `data:` URL -> a marker that remembers its mime, so inflate rebuilds the identical string. */
  const packDataUrl = (uri: string): Marker | undefined => {
    const parsed = parseBase64DataUri(uri)
    if (!parsed || parsed.bytes.length === 0) return undefined
    return { $url: writer.addInterned(parsed.bytes), mime: parsed.mime }
  }

  /**
   * Base64 payloads are the only async work here (DEFLATE has no synchronous form), so they are queued
   * rather than awaited inline to keep the walk a plain synchronous recursion.
   * Must run in order: the chunk layout a given bundle produces has to be deterministic.
   */
  const deferred: (() => Promise<void>)[] = []

  const packBase64 = (owner: any, slot: string, compress: boolean): void => {
    const value = owner[slot]
    if (typeof value !== 'string' || value.length === 0) return
    deferred.push(async () => {
      let bytes: Uint8Array
      try { bytes = base64ToBytes(value) } catch { return }
      if (bytes.length === 0) return
      // DEFLATE, never a PNG re-encode: a splat map's alpha is layer 3's blend weight and canvas 2D is
      // premultiplied, so an image round trip destroys the RGB of every texel where layer 3 is unused.
      if (compress) { try { bytes = await deflateBytes(bytes) } catch { /* ship it raw */ } }
      owner[slot] = compress
        ? { $b64: writer.addInterned(bytes), z: 1 }
        : { $b64: writer.addInterned(bytes) }
    })
  }

  const packModel = (model: any): void => {
    if (!model || typeof model !== 'object') return
    if (model.geometry && typeof model.geometry === 'object' && !isMarker(model.geometry))
      model.geometry = { $geo: internGeometry(model.geometry) }
    if (isNumberArray(model.jointIndices)) model.jointIndices = indices(model.jointIndices)
    if (isNumberArray(model.jointWeights)) model.jointWeights = floats(model.jointWeights)
    packSkin(model.skin)
  }

  /**
   * The regular float grids inside a serialized skin: one inverse-bind matrix per joint and one local
   * transform per skeleton node. Both are mat4s (Float32Array) live, so Float32 is exact.
   * The index/name maps stay in JSON.
   */
  const packSkin = (skin: any): void => {
    if (!skin || typeof skin !== 'object') return
    for (const joint of (skin.joints ?? []))
      if (isNumberArray(joint?.inverseBindMatrix)) joint.inverseBindMatrix = floats(joint.inverseBindMatrix)
    for (const entry of (skin.nodeTransforms ?? []))
      if (Array.isArray(entry) && isNumberArray(entry[1])) entry[1] = floats(entry[1])
  }

  /** One animation clip: the sampler keyframe times and values, the bundle's single largest payload. */
  const packClip = (clip: any): void => {
    for (const sampler of (clip?.samplers ?? [])) {
      if (!sampler || typeof sampler !== 'object') continue
      if (isNumberArray(sampler.input)) sampler.input = floats(sampler.input)
      if (isNumberArray(sampler.output)) sampler.output = floats(sampler.output)
    }
  }

  /**
   * One recursive pass over the whole bundle graph.
   * Shapes must be recognized by the KEY that owns them (`o.model`, `o.terrain`, `o.faces`,
   * `o.thumbnail`), never by loose field names, so a `positions` array that is not geometry is untouched.
   */
  const visit = (value: any): void => {
    if (Array.isArray(value)) {
      // A leaf array of numbers is the common case; nothing here mixes numbers with objects.
      if (value.length === 0 || typeof value[0] === 'number') return
      for (const item of value) if (item && typeof item === 'object') visit(item)
      return
    }
    if (!value || typeof value !== 'object' || isMarker(value)) return

    packModel(value.model)
    for (const m of (value.models ?? [])) packModel(m)
    if (value.samplers) packClip(value)
    if (value.skin && !value.model) packSkin(value.skin) // a bare skin: AnimationAsset.sourceSkin

    if (typeof value.thumbnail === 'string') {
      const marker = packDataUrl(value.thumbnail)
      if (marker) value.thumbnail = marker
    }

    // A serialized skybox: six PNG data URLs. serializeTexture bails on a cubemap, so these never reach
    // the texture store and ride inside the scene JSON instead.
    const faces = value.faces
    if (faces && typeof faces === 'object' && typeof faces.positiveX === 'string') {
      for (const face of FACES) {
        const marker = typeof faces[face] === 'string' ? packDataUrl(faces[face]) : undefined
        if (marker) faces[face] = marker
      }
    }

    const terrain = value.terrain
    if (terrain && typeof terrain === 'object') {
      packBase64(terrain, 'heights', true)
      packBase64(terrain, 'splat', true)
    }

    // A scattered foliage layer's instance buffer: stride-5 float32 `[x,y,z,yaw,scale]`, base64'd by
    // FoliageLayer.serialize. Left uncompressed; deflate barely touches float data.
    if (typeof value.instances === 'string') packBase64(value, 'instances', false)

    // A tilemap chunk, recognized by its grid coordinates so an unrelated `data` string is never taken.
    if (typeof value.cx === 'number' && typeof value.cy === 'number') {
      packBase64(value, 'data', true)
      packBase64(value, 'tint', true)
    }

    for (const slot of slotsOf(value)) {
      const child = (value as any)[slot]
      if (child && typeof child === 'object') visit(child)
    }
  }

  visit(bundle.manifest)
  visit(bundle.scenes)
  visit(bundle.libraries)
  for (const job of deferred) await job()

  // Textures last, so the geometry chunks the JSON references sit at the front of the blob.
  const textures: BundleAssetIndex['textures'] = []
  for (const t of (bundle.textures ?? [])) {
    const bytes = t.bytes instanceof Uint8Array ? t.bytes : new Uint8Array(t.bytes)
    if (bytes.length === 0) continue
    const ref = writer.addInterned(bytes)
    textures.push({ id: t.id, mime: t.mime || 'image/png', config: t.config, o: ref.o, l: ref.l })
  }
  bundle.textures = []

  return { blob: writer.finish(), index: { version: 1, geometries, textures } }
}

// ---------------------------------------------------------------------------------------------------
// Inflating
// ---------------------------------------------------------------------------------------------------

/**
 * Replace every marker with the payload it points at, restoring the JSON a format-1 bundle had.
 * MUTATES `bundle`, including refilling `bundle.textures`, which packing emptied.
 */
export async function inflateBundleAssets(
  bundle: BundleData,
  blob: ArrayBuffer,
  index: BundleAssetIndex,
): Promise<void> {
  const reader = new ChunkReader(blob, 0, 'assets.bin')

  // Copied out, not viewed: Float64Array needs 8-byte alignment and the blob aligns to 4.
  const readDoubles = (ref: ChunkRef): Float64Array =>
    new Float64Array(reader.bytes(ref)!.slice().buffer)

  const restoreGeometry = (ref: string): any => {
    const record = index.geometries?.[ref]
    if (!record) return undefined
    const out: any = {}
    for (const name of GEOMETRY_ATTRS) {
      const chunk = record[name] as (ChunkRef & { f64?: 1 }) | undefined
      if (!chunk) continue
      const flat = chunk.f64 ? readDoubles(chunk) : reader.floats(chunk)!
      out[name] = record.nested ? toTuples(flat, ATTR_STRIDE[name]) : Array.from(flat)
    }
    if (record.indices) {
      const array = record.indices.bits === 32 ? reader.u32(record.indices)! : reader.u16(record.indices)!
      out.indices = Array.from(array)
    }
    return out
  }

  /** The synchronous markers. `$b64` is handled separately — inflating it is async. */
  const restore = (marker: Marker): any => {
    if ('$geo' in marker) return restoreGeometry(marker.$geo)
    if ('$f32' in marker) return Array.from(reader.floats(marker.$f32)!)
    if ('$f64' in marker) return Array.from(readDoubles(marker.$f64))
    if ('$idx' in marker) {
      const array = marker.$idx.bits === 32 ? reader.u32(marker.$idx)! : reader.u16(marker.$idx)!
      return Array.from(array)
    }
    if ('$url' in marker) return bytesToDataUrl(reader.bytes(marker.$url)!, marker.mime)
    return undefined
  }

  /** Deferred for the same reason packing defers: DEFLATE has no synchronous form. */
  const deferred: (() => Promise<void>)[] = []

  /** The mirror of pack's walk. A marker announces itself, so this needs none of the shape knowledge. */
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return

    for (const slot of slotsOf(value)) {
      const child = (value as any)[slot]
      if (!child || typeof child !== 'object') continue

      if (isMarker(child)) {
        if ('$b64' in child) {
          const marker = child as { $b64: ChunkRef; z?: 1 }
          deferred.push(async () => {
            const packed = reader.bytes(marker.$b64)!
            const bytes = marker.z ? await inflateBytes(packed) : packed
            ;(value as any)[slot] = bytesToBase64(bytes)
          })
        } else {
          const restored = restore(child)
          if (restored !== undefined) (value as any)[slot] = restored
        }
        continue
      }
      visit(child)
    }
  }

  visit(bundle.manifest)
  visit(bundle.scenes)
  visit(bundle.libraries)
  for (const job of deferred) await job()

  // Each texture must be SLICED into its own buffer, never handed a view onto the container: bundleImport
  // does `new Blob([t.bytes])` and bundleMerge dedupes on `byteLength`, and a view exposes the whole blob.
  bundle.textures = (index.textures ?? []).map(t => ({
    id: t.id,
    mime: t.mime,
    config: t.config,
    bytes: reader.bytes({ o: t.o, l: t.l })!.slice().buffer as ArrayBuffer,
  }))
}
