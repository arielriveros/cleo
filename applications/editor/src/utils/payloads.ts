// The one walker that moves bulk payloads out of editor JSON and puts them back: mesh geometry, joint
// attributes, skins, animation samplers, terrain height/splat/masks, foliage instances, tilemap cell grids,
// skybox faces and thumbnails. Two containers use it, so the shape knowledge exists exactly once:
//
//   - the export bundle (utils/bundleAssets.ts): every payload becomes a `{o,l}` chunk of one assets.bin,
//     meshes go through a shared geometry table;
//   - the project folder (utils/folder/): payloads past a size threshold become content-addressed files
//     under Blobs/, named by the sha256 of their bytes, and a mesh record is written inline.
//
// The container decides what a reference IS (the sink/source below); the walker decides WHICH values are
// payloads and how each one is restored. Three rules every container inherits:
//
//  1. A payload is replaced IN PLACE by a marker (see `Marker`), never moved to a new field: `hashAsset`
//     compares `JSON.stringify` output, so reordering an object's keys changes every model's and template's
//     content hash and resyncs every placement on first open.
//  2. Inflate restores the ORIGINAL JSON — plain `number[]` or typed arrays as they went in, base64
//     strings, data URLs, in their original key order. A round trip must be byte-identical.
//  3. Float width is chosen per array by `narrowest`, never fixed: forcing f32 rewrites float64 values
//     (animation samplers, baked foliage geometry), forcing f64 doubles the largest payload for nothing.
//
// Engine-free and DOM-free: this runs inside projectWorker.ts and in Node tests.

import { base64ToBytes, bytesToBase64, bytesToDataUrl, parseBase64DataUri, deflateBytes, inflateBytes } from '@cleo/app-kit/utils/bytes'
import { ATTR_STRIDE, GEOMETRY_ATTRS, type GeometryAttr } from './bundle'
import { isBinaryPayload } from './binaryPayload'

/**
 * A value small enough to stay in the JSON even though it had to be marked: a typed array under the
 * folder's size threshold (a typed array cannot be written as JSON as it is — it would come back as
 * `{"0":…}` — so it keeps a marker, but its numbers ride inline rather than in a file of their own).
 */
export interface InlineRef { n: number[] }

export const isInlineRef = (ref: any): ref is InlineRef => !!ref && typeof ref === 'object' && Array.isArray(ref.n)

/** One mesh's attribute payloads, by reference. The bundle keeps these in a table; the folder inline. */
export interface GeometryRecord<R> extends Partial<Record<GeometryAttr, (R | InlineRef) & { f64?: 1 }>> {
  /** Absent for an unindexed mesh. */
  indices?: (R | InlineRef) & { bits: 16 | 32 }
  /**
   * The source attributes were nested tuples (`[[x,y,z], …]`), so inflate must rebuild them that way or
   * the asset's content hash changes. The foliage rule baker emits that shape; Model.serialize emits flat.
   */
  nested?: true
  /** The source attributes were typed arrays (what `Model.serialize` writes). Exclusive with `nested`. */
  typed?: true
  /** Attributes the source held as an EMPTY plain array (`"tangents": []`), restored as `[]` in place. */
  empty?: GeometryAttr[]
}

/**
 * What a packed value looks like while it sits in the JSON. Exactly one `$` key each, so recognizing a
 * marker is a single property test: `$geo` is a mesh (a table id or an inline record), `$f32`/`$f64`/`$idx`
 * are number arrays, `$b64` is a base64 string (`z` when the bytes were deflated first) and `$url` is a
 * `data:` URI.
 */
export type Marker<R> =
  | { $geo: string | GeometryRecord<R> }
  | { $f32: R | InlineRef; t?: 1 }
  | { $f64: R | InlineRef; t?: 1 }
  | { $idx: (R | InlineRef) & { bits: 16 | 32 }; t?: 1 }
  | { $b64: R; z?: 1 }
  | { $url: R; mime: string }

export const isMarker = (v: any): v is Marker<unknown> =>
  !!v && typeof v === 'object' &&
  (v.$geo !== undefined || !!v.$f32 || !!v.$f64 || !!v.$idx || !!v.$b64 || !!v.$url)

/** Where packed payloads go. The ref it returns is what the marker carries. */
export interface PayloadSink<R> {
  /**
   * Payloads with fewer bytes than this stay where they are (a plain array, a string) or ride inline (a
   * typed array). 0 moves everything — the bundle's rule, and what keeps its output unchanged.
   */
  readonly minBytes: number
  /** Whether base64 payloads may be DEFLATEd first. The bundle deflates terrain and tilemaps; the folder never does. */
  readonly deflate: boolean
  /**
   * Store bytes and return the reference. `extra` (an index width, a float64 flag) must end up on the
   * returned object itself, after the container's own fields: a sink may fill its fields in later (the
   * folder hashes after the walk), so the walker never copies a ref to add to it.
   */
  add(view: ArrayBufferView, extra?: Record<string, unknown>): R
  /** The `$geo` value for one mesh: an id into a table (the bundle) or the record itself (the folder). */
  geometry(record: GeometryRecord<R>): string | GeometryRecord<R>
}

/** Where packed payloads come back from. */
export interface PayloadSource<R> {
  bytes(ref: R): Uint8Array | undefined
  floats(ref: R): Float32Array | undefined
  u16(ref: R): Uint16Array | undefined
  u32(ref: R): Uint32Array | undefined
  geometry(value: string | GeometryRecord<R>): GeometryRecord<R> | undefined
}

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

/** The inverse of toFlat's nested branch. */
function toTuples(flat: ArrayLike<number>, stride: number): number[][] {
  const out: number[][] = new Array(Math.floor(flat.length / stride))
  for (let i = 0; i < out.length; i++) {
    const tuple = new Array(stride)
    for (let k = 0; k < stride; k++) tuple[k] = flat[i * stride + k]
    out[i] = tuple
  }
  return out
}

/**
 * A flat run of numbers, in either container. The view branch is load-bearing: `Model.serialize` writes
 * joint attributes and skin matrices as `Float32Array` (see serializeGeometry in src/graphics/model.ts),
 * and an `Array.isArray`-only guard silently skips them — they then fall through to `JSON.stringify` and
 * land as `{"0":…}` text.
 */
const isNumberArray = (v: any): v is ArrayLike<number> =>
  (Array.isArray(v) && v.length > 0 && typeof v[0] === 'number') ||
  (ArrayBuffer.isView(v) && !(v instanceof DataView) && (v as any).length > 0)

/** Whether a packed payload must be restored as a typed array to reproduce the original JSON. */
const wasTyped = (v: any): 1 | undefined =>
  ArrayBuffer.isView(v) && !(v instanceof DataView) ? 1 : undefined

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

/**
 * Every own key of an object or index of an array, so both can be walked by the same code.
 * A binary payload has no slots worth visiting — and `Object.keys` on a typed array would materialise one
 * string per element. Anything in one has already been packed by the time the walk reaches it.
 */
const slotsOf = (v: any): (string | number)[] =>
  isBinaryPayload(v) ? [] : Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v)

// ---------------------------------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------------------------------

/**
 * Replace every payload under each root with a marker, IN PLACE (the caller hands in a copy).
 * The walk is synchronous; base64 payloads are queued and run after it, in order, because DEFLATE has no
 * synchronous form and the chunk layout a given input produces has to be deterministic.
 */
export async function packPayloads<R>(roots: unknown[], sink: PayloadSink<R>): Promise<void> {
  const min = sink.minBytes

  /** A typed array under the threshold keeps its marker but carries its numbers inline. */
  const refOf = (array: Float32Array | Float64Array | Uint16Array | Uint32Array, extra?: Record<string, unknown>): any =>
    array.byteLength < min ? { n: Array.from(array), ...extra } : sink.add(array, extra)

  /** A run of floats, or undefined to leave a small plain array where it is. */
  const floats = (values: ArrayLike<number>): Marker<R> | undefined => {
    const array = narrowest(values)
    const t = wasTyped(values)
    if (!t && array.byteLength < min) return undefined
    const ref = refOf(array)
    return array instanceof Float64Array ? { $f64: ref, t } : { $f32: ref, t }
  }

  const indices = (values: ArrayLike<number>): Marker<R> | undefined => {
    const array = toIndexArray(values)
    const t = wasTyped(values)
    if (!t && array.byteLength < min) return undefined
    return { $idx: refOf(array, { bits: array instanceof Uint32Array ? 32 : 16 }), t }
  }

  /** A mesh, or undefined to leave a small plain one where it is. */
  const packGeometry = (raw: any): Marker<R> | undefined => {
    // Two passes, so a small plain mesh can be left alone before anything is stored. The second pass
    // writes the record's keys in the order the single-pass packer always did (an `empty` list lands
    // where its first empty attribute is), which keeps the bundle's geometry table byte-identical.
    const steps: ({ name: GeometryAttr; empty: true } | { name: GeometryAttr; array: Float32Array | Float64Array })[] = []
    let nested = false
    let typed = false
    let total = 0
    for (const name of GEOMETRY_ATTRS) {
      const source = raw[name]
      if (Array.isArray(source) && source.length === 0) { steps.push({ name, empty: true }); continue }
      if (!source || source.length === 0) continue
      if (isNestedArray(source)) nested = true
      if (wasTyped(source)) typed = true
      const flat = toFlat(source, ATTR_STRIDE[name])
      if (flat.length === 0) continue
      const array = narrowest(flat)
      total += array.byteLength
      steps.push({ name, array })
    }
    const index = raw.indices && raw.indices.length > 0 ? toIndexArray(raw.indices) : undefined
    if (index) total += index.byteLength
    const anyTyped = typed || !!wasTyped(raw.indices)
    if (!anyTyped && min > 0 && total < min) return undefined

    const record: GeometryRecord<R> = {}
    for (const step of steps) {
      if ('empty' in step) { (record.empty ??= []).push(step.name); continue }
      record[step.name] = step.array instanceof Float64Array ? refOf(step.array, { f64: 1 }) : refOf(step.array)
    }
    if (index) record.indices = refOf(index, { bits: index instanceof Uint32Array ? 32 : 16 })
    if (nested) record.nested = true
    // Mutually exclusive with `nested` by construction: the nested tuple shape is only ever plain arrays.
    else if (anyTyped) record.typed = true
    return { $geo: sink.geometry(record) }
  }

  /** A `data:` URL -> a marker that remembers its mime, so inflate rebuilds the identical string. */
  const packDataUrl = (uri: string): Marker<R> | undefined => {
    const parsed = parseBase64DataUri(uri)
    if (!parsed || parsed.bytes.length === 0 || parsed.bytes.length < min) return undefined
    return { $url: sink.add(parsed.bytes), mime: parsed.mime }
  }

  const deferred: (() => Promise<void>)[] = []

  const packBase64 = (owner: any, slot: string, compress: boolean): void => {
    const value = owner[slot]
    if (typeof value !== 'string' || value.length === 0) return
    deferred.push(async () => {
      let bytes: Uint8Array
      try { bytes = base64ToBytes(value) } catch { return }
      if (bytes.length === 0 || bytes.length < min) return
      const deflate = compress && sink.deflate
      // DEFLATE, never a PNG re-encode: a splat map's alpha is layer 3's blend weight and canvas 2D is
      // premultiplied, so an image round trip destroys the RGB of every texel where layer 3 is unused.
      if (deflate) { try { bytes = await deflateBytes(bytes) } catch { /* ship it raw */ } }
      owner[slot] = deflate
        ? { $b64: sink.add(bytes), z: 1 }
        : { $b64: sink.add(bytes) }
    })
  }

  const replace = (owner: any, slot: string | number, marker: Marker<R> | undefined) => {
    if (marker) owner[slot] = marker
  }

  const packModel = (model: any): void => {
    if (!model || typeof model !== 'object') return
    if (model.geometry && typeof model.geometry === 'object' && !isMarker(model.geometry))
      replace(model, 'geometry', packGeometry(model.geometry))
    if (isNumberArray(model.jointIndices)) replace(model, 'jointIndices', indices(model.jointIndices))
    if (isNumberArray(model.jointWeights)) replace(model, 'jointWeights', floats(model.jointWeights))
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
      if (isNumberArray(joint?.inverseBindMatrix)) replace(joint, 'inverseBindMatrix', floats(joint.inverseBindMatrix))
    for (const entry of (skin.nodeTransforms ?? []))
      if (Array.isArray(entry) && isNumberArray(entry[1])) replace(entry, 1, floats(entry[1]))
  }

  /** One animation clip: the sampler keyframe times and values, the largest payload of all. */
  const packClip = (clip: any): void => {
    for (const sampler of (clip?.samplers ?? [])) {
      if (!sampler || typeof sampler !== 'object') continue
      if (isNumberArray(sampler.input)) replace(sampler, 'input', floats(sampler.input))
      if (isNumberArray(sampler.output)) replace(sampler, 'output', floats(sampler.output))
    }
  }

  /**
   * One recursive pass over the graph.
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
    if (value.skin && !value.model) packSkin(value.skin) // a bare skin: a rig
    if (value.sourceSkin) packSkin(value.sourceSkin) // AnimationAsset.sourceSkin

    if (typeof value.thumbnail === 'string') replace(value, 'thumbnail', packDataUrl(value.thumbnail))

    // A serialized skybox: six PNG data URLs. serializeTexture bails on a cubemap, so these never reach
    // the texture store and ride inside the scene JSON instead.
    const faces = value.faces
    if (faces && typeof faces === 'object' && typeof faces.positiveX === 'string') {
      for (const face of FACES)
        if (typeof faces[face] === 'string') replace(faces, face, packDataUrl(faces[face]))
    }

    const terrain = value.terrain
    if (terrain && typeof terrain === 'object') {
      packBase64(terrain, 'heights', true)
      packBase64(terrain, 'splat', true)
      // The layer stack's paint masks (see TerrainLayerStack.serialize), the successor to `splat`.
      if (terrain.layerStack && typeof terrain.layerStack === 'object') packBase64(terrain.layerStack, 'masks', true)
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

  for (const root of roots) visit(root)
  for (const job of deferred) await job()
}

// ---------------------------------------------------------------------------------------------------
// Inflating
// ---------------------------------------------------------------------------------------------------

/** Replace every marker under each root with the payload it points at, IN PLACE. */
export async function inflatePayloads<R>(roots: unknown[], source: PayloadSource<R>): Promise<void> {
  // Copied out, not viewed: Float64Array needs 8-byte alignment and a bundle blob aligns to 4.
  const readDoubles = (ref: R | InlineRef): Float64Array =>
    isInlineRef(ref) ? new Float64Array(ref.n) : new Float64Array(need(source.bytes(ref as R)).slice().buffer)
  const readFloats = (ref: R | InlineRef): ArrayLike<number> =>
    isInlineRef(ref) ? ref.n : need(source.floats(ref as R))
  const readIndices = (ref: (R | InlineRef) & { bits: 16 | 32 }): ArrayLike<number> =>
    isInlineRef(ref) ? ref.n : need(ref.bits === 32 ? source.u32(ref as R) : source.u16(ref as R))

  const restoreGeometry = (value: string | GeometryRecord<R>): any => {
    const record = source.geometry(value)
    if (!record) return undefined
    const out: any = {}
    for (const name of GEOMETRY_ATTRS) {
      if (record.empty?.includes(name)) { out[name] = []; continue }
      const chunk = record[name]
      if (!chunk) continue
      const flat = chunk.f64 ? readDoubles(chunk) : readFloats(chunk)
      // Copied out either way — a source's float view may be a VIEW into a whole blob, and keeping it
      // would pin the entire container in memory behind one attribute.
      out[name] = record.nested ? toTuples(flat, ATTR_STRIDE[name])
        : record.typed ? new Float32Array(flat)
        : Array.from(flat)
    }
    if (record.indices) {
      const array = readIndices(record.indices)
      out.indices = record.typed ? new Uint32Array(array) : Array.from(array)
    }
    return out
  }

  /** The synchronous markers. `$b64` is handled separately — inflating it is async. */
  const restore = (marker: Marker<R>): any => {
    if ('$geo' in marker) return restoreGeometry(marker.$geo)
    // `t` says the value was a typed array before it was packed. Restoring the ORIGINAL container is the
    // round-trip rule (see rule 2 at the top): a model's joint attributes are Float32Array, while an
    // animation sampler and a baked foliage grid are plain arrays, and both must come back as they went.
    if ('$f32' in marker) return marker.t ? new Float32Array(readFloats(marker.$f32)) : Array.from(readFloats(marker.$f32))
    if ('$f64' in marker) return marker.t ? new Float32Array(readDoubles(marker.$f64)) : Array.from(readDoubles(marker.$f64))
    if ('$idx' in marker) {
      const array = readIndices(marker.$idx)
      return marker.t ? new Float32Array(array) : Array.from(array)
    }
    if ('$url' in marker) return bytesToDataUrl(need(source.bytes(marker.$url)), marker.mime)
    return undefined
  }

  const deferred: (() => Promise<void>)[] = []

  /** The mirror of pack's walk. A marker announces itself, so this needs none of the shape knowledge. */
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return

    for (const slot of slotsOf(value)) {
      const child = (value as any)[slot]
      if (!child || typeof child !== 'object') continue

      if (isMarker(child)) {
        if ('$b64' in child) {
          const marker = child as { $b64: R; z?: 1 }
          deferred.push(async () => {
            const packed = need(source.bytes(marker.$b64))
            const bytes = marker.z ? await inflateBytes(packed) : packed
            ;(value as any)[slot] = bytesToBase64(bytes)
          })
        } else {
          const restored = restore(child as Marker<R>)
          if (restored !== undefined) (value as any)[slot] = restored
        }
        continue
      }
      visit(child)
    }
  }

  for (const root of roots) visit(root)
  for (const job of deferred) await job()
}

/**
 * Every reference a packed value holds (inline refs excluded), so a reader can fetch exactly the payloads
 * one file needs before inflating it, and so a folder can count which blobs are still in use.
 */
export function collectPayloadRefs<R>(root: unknown, out: R[] = []): R[] {
  const geometryRefs = (record: GeometryRecord<R>) => {
    for (const name of GEOMETRY_ATTRS) {
      const chunk = record[name]
      if (chunk && !isInlineRef(chunk)) out.push(chunk as R)
    }
    if (record.indices && !isInlineRef(record.indices)) out.push(record.indices as R)
  }
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return
    if (isMarker(value)) {
      const m = value as any
      if (m.$geo !== undefined) { if (typeof m.$geo === 'object') geometryRefs(m.$geo) }
      else {
        const ref = m.$f32 ?? m.$f64 ?? m.$idx ?? m.$b64 ?? m.$url
        if (ref && !isInlineRef(ref)) out.push(ref)
      }
      return
    }
    for (const slot of slotsOf(value)) {
      const child = (value as any)[slot]
      if (child && typeof child === 'object') visit(child)
    }
  }
  visit(root)
  return out
}

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('a packed payload is missing')
  return value
}
