// Moving every bulk payload of an export bundle into one `assets.bin`, and putting it back on import.
//
// Before this, a .cleoproj.zip stored its asset data twice-badly: texture bytes as one zip entry each,
// and everything else as text inside the JSON entries — mesh vertex arrays as decimal strings (a float
// costs ~19 bytes written as `0.011335190385580063` and 4 as a Float32), animation samplers the same,
// and terrain/tilemap/cubemap/thumbnail payloads as base64. On the shipped 3D example that was 56.6 MB of
// JSON, of which nearly all was numbers, plus one animation clip stored three times over (in the model
// asset, in a template, and in the scene) at ~10 MB a copy. Packed, the same project is 1.4 MB of JSON
// and a 4.8 MB blob.
//
// The fix is the one publishing already uses for game.bin: write the numbers as raw little-endian bytes
// into a blob of 4-byte-aligned chunks and leave a reference behind. The container primitives are shared
// — see utils/chunkBlob.ts. Three things differ from the publish packer, all on purpose:
//
//  1. EVERY payload is content-interned, not just geometry. That is what collapses the triplicated clip:
//     identical bytes reaching the writer from a model, a template and a scene get one chunk.
//  2. A payload is replaced IN PLACE by a marker (see `Marker` below) rather than moved to a new field.
//     Deleting `geometry` and adding `geometryRef` reorders the object's keys, and `hashAsset` compares
//     `JSON.stringify` output — so every model and template in the project would come back with a
//     different content hash and trigger a pointless resync of every placement on first open.
//  3. Inflate restores the ORIGINAL JSON — plain `number[]`, base64 strings, data URLs, in their original
//     key order. The player wants zero-copy typed-array views; an import wants the editor's data model
//     untouched, because `bundleMerge` deep-clones and id-remaps these objects and `Scene.parse` reads
//     them. An export/import round trip of the 3D example is byte-identical.
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
 * One key each, so recognizing one is a single property test and no ordinary editor object can be
 * mistaken for one: `$geo` is an id into the geometry table, `$f32`/`$f64`/`$idx` are number arrays,
 * `$b64` is a base64 string (`z` when the bytes were deflated first) and `$url` is a `data:` URI.
 *
 * Float width is chosen per array by `narrowest`, on the same principle as the 16-vs-32-bit index
 * narrowing: take the smallest form that loses nothing. Most float payloads are read off a Float32Array
 * before they are serialized (`Model.serialize` does `Array.from(this._geometry.positions)`, a joint's
 * inverse-bind matrix is a `mat4`) so they cost 4 bytes each — but animation samplers are typed
 * `number[]` and really do carry float64, as does the geometry the foliage baker computes. Guessing
 * either way is wrong: measured on the shipped 3D example, forcing f32 was the only thing stopping an
 * export/import round trip from being byte-identical, and forcing f64 would double the largest payload
 * in the bundle for nothing. A round trip that changes a value changes that asset's content hash, which
 * makes importing a project resync every placement of it.
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
 * and the copy in publish/pack.ts, duplicated for the same reason both of those are: the worker may not
 * import `cleo`. 65535 is excluded because WebGL2 reads it as the primitive-restart index.
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
 *
 * Float64Array, NOT Float32Array: narrowing is `narrowest`'s decision to make and it has to see the
 * original values to make it. Flattening through float32 here silently threw away the precision of the
 * one geometry that actually needs it — the foliage baker computes in float64 and emits nested tuples —
 * and the loss then showed up as a changed content hash on the terrain material.
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
 *
 * `Math.fround` is the float32 round-trip, so a value that survives it came from a Float32Array (or is
 * representable in one either way) and can go back into 4 bytes.
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
 *
 * MUTATES `bundle`, exactly as packGameBin mutates its input and for the same reason: the caller sent the
 * object into the worker by structured clone, so the editor's own copy is untouched.
 */
export async function packBundleAssets(bundle: BundleData): Promise<PackBundleResult> {
  const writer = new ChunkWriter()
  const geometries: Record<string, BundleGeometry> = {}
  // record-shape -> id. Keying on the stringified REF SET rather than on the mesh means the comparison is
  // six tiny objects instead of a megabyte of vertices — the chunks are already content-addressed by the
  // writer, so two identical meshes necessarily produce identical refs.
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
   * The base64 payloads are the only async work here (DEFLATE has no synchronous form), so they are
   * queued rather than awaited inline — that keeps the walk a plain synchronous recursion instead of
   * allocating a promise per node across a graph with millions of them. Run in order, so the chunk
   * layout a given bundle produces is deterministic.
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
      // premultiplied, so an image round-trip destroys the RGB of every texel where layer 3 is unused.
      // Same reasoning as publish/terrainImages.ts.
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
   * transform per skeleton node. Both are mat4s (Float32Array) on the live object, so Float32 is exact,
   * and interning collapses the identity matrices a rig is full of. The index/name maps stay in JSON —
   * they are small, and they are what makes the record readable.
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
   *
   * Shapes are recognized by the KEY that owns them (`o.model`, `o.terrain`, `o.faces`, `o.thumbnail`)
   * rather than by loose field names, so a `positions` array that is not geometry is never touched. And
   * it is one generic walk rather than a list of paths — scene trees, ModelAsset.nodeJson, Template.node,
   * AnimationAsset.clips, and the foliage prototype meshes buried in a terrain material's
   * `foliageInclude` all get visited without anyone having to remember they exist.
   */
  const visit = (value: any): void => {
    if (Array.isArray(value)) {
      // A leaf array of numbers is the common case by a wide margin (every vertex attribute is one) and
      // recursing into it would cost a call per float. Nothing here mixes numbers with objects.
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

    // A serialized skybox: six PNG data URLs, the one texture family that never reaches the texture
    // store (serializeTexture bails on a cubemap, so they ride inside the scene JSON).
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
    // FoliageLayer.serialize. Left uncompressed — it is float data, which deflate barely touches.
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
 *
 * MUTATES `bundle` — including refilling `bundle.textures`, which packing emptied.
 */
export async function inflateBundleAssets(
  bundle: BundleData,
  blob: ArrayBuffer,
  index: BundleAssetIndex,
): Promise<void> {
  const reader = new ChunkReader(blob, 0, 'assets.bin')

  // Copied out rather than viewed: Float64Array needs 8-byte alignment and the blob aligns to 4. The
  // result becomes a plain number[] anyway, so this is a copy that was already being paid.
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

  /**
   * The mirror of pack's walk, and simpler than it: a marker announces itself, so this needs none of the
   * shape knowledge — which is the point of packing in place. The two stay in step by construction.
   */
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

  // Each texture is SLICED out into its own buffer rather than handed a view onto the container.
  // bundleImport does `new Blob([t.bytes])` and bundleMerge dedupes on `byteLength`; a view would make
  // both of those read the whole multi-hundred-megabyte blob.
  bundle.textures = (index.textures ?? []).map(t => ({
    id: t.id,
    mime: t.mime,
    config: t.config,
    bytes: reader.bytes({ o: t.o, l: t.l })!.slice().buffer as ArrayBuffer,
  }))
}
