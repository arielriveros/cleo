// One asset <-> its files in a folder project: the asset file, its `.meta`, and the blobs its payloads
// moved into.
//
//   JSON kinds   (.mat .tmat .tpl .model .anim .rig .tex .sound …) the record, payloads past BLOB_MIN_BYTES
//                moved to Blobs/ by the shared walker (utils/payloads.ts), the top-level thumbnail blanked
//   scene        SceneAssetData with its meta's `dimension` and `refs` in front; no `savedAt`
//   script       the source text; the record (minus the source) in the meta
//   image/audio  the bytes as they arrived; the record and the store's mime/config in the meta
//
// Thumbnails are not committed: the editor re-renders them after every save and GPU output is not
// deterministic, so a committed thumbnail would churn git on every machine. The key is kept with an empty
// value (`thumbnail` is a NON_STRUCTURAL key of hashAsset, and keeping the key keeps the order), and the
// editor's cache puts the rendered one back.
//
// Pure, async only for hashing (crypto.subtle). Runs in the project worker and in Node tests.

import type { AssetKind } from '../vfs'
import type { SceneAssetData, SceneMeta } from '../sceneStorage'
import { collectPayloadRefs, inflatePayloads, packPayloads, type GeometryRecord, type PayloadSink, type PayloadSource } from '../payloads'
import { isLfsPointerBytes, parseJsonText, toJsonText } from './jsonText'
import { metaText, recordWithFile, recordWithFileSlot, META_VERSION, type AssetMeta } from './meta'

/** A blob reference as it sits in a folder file: the sha256 of the bytes, and their length. */
export interface BlobRef { h: string; l: number }

/**
 * Payloads smaller than this stay in the JSON. A skin alone would otherwise make one 64-byte file per
 * joint matrix — thousands of tiny LFS objects for nothing.
 */
export const BLOB_MIN_BYTES = 4096

/** The format of a `.scene` file. */
export const SCENE_FILE_VERSION = 1

export async function sha256Hex(bytes: ArrayBufferView): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  const view = new Uint8Array(digest)
  let out = ''
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0')
  return out
}

/** A sink that collects payloads and names them by content once the walk is done. */
export class BlobCollector implements PayloadSink<BlobRef> {
  readonly minBytes: number
  readonly deflate = false
  private pending: { ref: BlobRef; bytes: Uint8Array }[] = []

  constructor(minBytes = BLOB_MIN_BYTES) { this.minBytes = minBytes }

  add(view: ArrayBufferView, extra?: Record<string, unknown>): BlobRef {
    // Placeholder digest, filled in by finish(): hashing is async and the walk is not.
    const ref: BlobRef = { h: '', l: view.byteLength, ...extra }
    this.pending.push({ ref, bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength) })
    return ref
  }

  /** A folder writes each mesh's record inline: there is no table to share it through. */
  geometry(record: GeometryRecord<BlobRef>): GeometryRecord<BlobRef> { return record }

  /** Hash every payload, patch the refs, and return the blobs by digest. */
  async finish(): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    for (const { ref, bytes } of this.pending) {
      ref.h = await sha256Hex(bytes)
      if (!out.has(ref.h)) out.set(ref.h, bytes)
    }
    this.pending = []
    return out
  }
}

/** Typed views onto blob bytes, copied when the bytes are not aligned for the view. */
export function blobSource(get: (hash: string) => Uint8Array | undefined): PayloadSource<BlobRef> {
  const bytes = (ref: BlobRef): Uint8Array | undefined => {
    const b = get(ref.h)
    if (!b) return undefined
    if (b.byteLength !== ref.l) throw new Error(`blob ${ref.h.slice(0, 12)}… is ${b.byteLength} bytes, ${ref.l} expected`)
    return b
  }
  const aligned = (b: Uint8Array, size: number): Uint8Array => (b.byteOffset % size === 0 ? b : b.slice())
  return {
    bytes,
    floats: ref => { const b = bytes(ref); if (!b) return undefined; const a = aligned(b, 4); return new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4) },
    u16: ref => { const b = bytes(ref); if (!b) return undefined; const a = aligned(b, 2); return new Uint16Array(a.buffer, a.byteOffset, a.byteLength / 2) },
    u32: ref => { const b = bytes(ref); if (!b) return undefined; const a = aligned(b, 4); return new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4) },
    geometry: value => (typeof value === 'object' ? value : undefined),
  }
}

/** The blob digests a parsed folder file references. */
export function blobRefsOf(value: unknown): string[] {
  return [...new Set(collectPayloadRefs<BlobRef>(value).map(r => r.h))]
}

/** What encoding one asset produces. */
export interface EncodedAsset {
  /** The asset file's content: JSON or source text, or the raw bytes of an image or sound. */
  content: string | Uint8Array
  meta: string
  blobs: Map<string, Uint8Array>
  /** Every blob digest `content` references (for the cache's refcounts). */
  refs: string[]
}

/** The input for one asset. `bytes` only for images and audio sources; `scene` only for scenes. */
export interface AssetInput {
  kind: AssetKind
  guid: string
  record?: any
  created?: number
  owner?: AssetMeta['owner']
  bytes?: { mime: string; config?: unknown; bytes: Uint8Array }
  scene?: { meta: SceneMeta; data: SceneAssetData }
}

/** The slot of a record a file provides, for the kinds whose file is not the JSON record. */
const FILE_SLOTS: Partial<Record<AssetKind, string>> = { script: 'source' }

export async function encodeAsset(input: AssetInput, minBytes = BLOB_MIN_BYTES): Promise<EncodedAsset> {
  const meta: AssetMeta = { cleo: META_VERSION, guid: input.guid, kind: input.kind }
  if (input.created !== undefined) meta.created = input.created
  if (input.owner) meta.owner = input.owner

  if (input.kind === 'image' || input.kind === 'audioSource') {
    if (!input.bytes) throw new Error(`${input.kind} ${input.guid} has no bytes`)
    if (input.record) meta.record = { ...input.record }
    meta.importer = input.kind === 'image'
      ? { mime: input.bytes.mime, config: input.bytes.config }
      : { mime: input.bytes.mime }
    return { content: input.bytes.bytes, meta: metaText(meta), blobs: new Map(), refs: [] }
  }

  const slot = FILE_SLOTS[input.kind]
  if (slot) {
    const record = input.record ?? {}
    meta.record = recordWithFileSlot(record, slot)
    const source = record[slot]
    return { content: typeof source === 'string' ? source : '', meta: metaText(meta), blobs: new Map(), refs: [] }
  }

  let value: any
  if (input.kind === 'scene') {
    if (!input.scene) throw new Error(`scene ${input.guid} has no data`)
    value = sceneFileValue(input.scene.meta, input.scene.data)
  } else {
    // A copy, because packing works in place, and the caller's record is live editor state.
    value = structuredClone(input.record)
    if (value && typeof value.thumbnail === 'string') value.thumbnail = ''
  }

  const sink = new BlobCollector(minBytes)
  await packPayloads([value], sink)
  const blobs = await sink.finish()
  return { content: toJsonText(value), meta: metaText(meta), blobs, refs: [...blobs.keys()] }
}

/** The JSON a `.scene` file holds: what the scene meta adds, then the stored scene minus its save time. */
function sceneFileValue(meta: SceneMeta, data: SceneAssetData): any {
  const out: any = { cleoScene: SCENE_FILE_VERSION }
  if (meta.dimension) out.dimension = meta.dimension
  if (meta.refs) out.refs = structuredClone(meta.refs)
  for (const key of Object.keys(data)) {
    if (key === 'savedAt') continue
    out[key] = structuredClone((data as any)[key])
  }
  return out
}

/** Why a file could not be read. Such a file is BLOCKED: the cached version stays and nothing overwrites it. */
export type DecodeProblem = { reason: 'conflict' | 'lfs-pointer' | 'invalid' | 'missing-blob'; message: string }

export type DecodedAsset =
  | { ok: true; record?: any; bytes?: { mime: string; config?: unknown; bytes: Uint8Array }; scene?: { meta: Omit<SceneMeta, 'id' | 'name'>; data: SceneAssetData }; refs: string[] }
  | ({ ok: false } & DecodeProblem)

/** Parse an asset file's JSON and list the blobs it needs, before anything is fetched. */
export function readAssetJson(text: string): { ok: true; value: any; refs: string[] } | ({ ok: false } & DecodeProblem) {
  const parsed = parseJsonText(text)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message }
  return { ok: true, value: parsed.value, refs: blobRefsOf(parsed.value) }
}

/**
 * The inverse of `encodeAsset`. `meta` is the paired meta (or a synthesised one for a file that has none);
 * `getBlob` must hold every digest `readAssetJson(...).refs` listed. The record's `id` is set to the
 * meta's guid IN PLACE: the meta is the identity, the id inside the file only a fallback.
 * `savedAt` for a scene is the file's mtime, since the file deliberately does not carry it.
 */
export async function decodeAsset(
  meta: AssetMeta,
  content: string | Uint8Array,
  getBlob: (hash: string) => Uint8Array | undefined,
  opts: { mtime?: number; parsed?: any } = {},
): Promise<DecodedAsset> {
  if (meta.kind === 'image' || meta.kind === 'audioSource') {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    if (isLfsPointerBytes(bytes)) return { ok: false, reason: 'lfs-pointer', message: 'a Git LFS pointer, not the file (run git lfs pull)' }
    const mime = meta.importer?.mime ?? (meta.record?.mime as string | undefined) ?? ''
    const record = meta.record ? { ...meta.record } : undefined
    if (record) setInPlace(record, 'id', meta.guid)
    return { ok: true, record, bytes: { mime, config: meta.importer?.config, bytes }, refs: [] }
  }

  const slot = FILE_SLOTS[meta.kind]
  if (slot) {
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
    if (text.startsWith('version https://git-lfs')) return { ok: false, reason: 'lfs-pointer', message: 'a Git LFS pointer, not the file (run git lfs pull)' }
    const record = recordWithFile(meta.record ?? { id: meta.guid }, slot, text)
    setInPlace(record, 'id', meta.guid)
    return { ok: true, record, refs: [] }
  }

  let value = opts.parsed
  if (value === undefined) {
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
    const read = readAssetJson(text)
    if (!read.ok) return read
    value = read.value
  }
  const refs = blobRefsOf(value)
  const missing = refs.filter(h => !getBlob(h))
  if (missing.length) return { ok: false, reason: 'missing-blob', message: `${missing.length} blob(s) missing (${missing[0].slice(0, 12)}…)` }
  await inflatePayloads([value], blobSource(getBlob))

  if (meta.kind === 'scene') {
    const sceneMeta: Omit<SceneMeta, 'id' | 'name'> = { updatedAt: opts.mtime ?? 0 }
    if (value.dimension === '2D' || value.dimension === '3D') sceneMeta.dimension = value.dimension
    if (value.refs && typeof value.refs === 'object') sceneMeta.refs = value.refs
    const data: any = {}
    for (const key of Object.keys(value)) {
      if (key === 'cleoScene' || key === 'dimension' || key === 'refs') continue
      data[key] = value[key]
    }
    data.savedAt = opts.mtime ?? 0
    return { ok: true, scene: { meta: sceneMeta, data }, refs }
  }

  if (value && typeof value === 'object') setInPlace(value, 'id', meta.guid)
  return { ok: true, record: value, refs }
}

/** Overwrite a key where it stands, or append it — never reorder (hashAsset is key-order sensitive). */
export function setInPlace(record: Record<string, unknown>, key: string, value: unknown): void {
  record[key] = value
}
