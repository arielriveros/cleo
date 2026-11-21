// Moving every bulk payload of an export bundle into one `assets.bin`, and putting it back on import.
// Numbers are written as raw little-endian bytes into a blob of 4-byte-aligned chunks with a reference
// left behind; the container primitives are shared with the publish packer — see utils/chunkBlob.ts.
//
// WHICH values are payloads, and how each is restored, is utils/payloads.ts — the same walker the project
// folder uses, so the two containers cannot drift. This file is the bundle's container: `{o,l}` chunk
// refs, a shared geometry table, and the texture/audio/bake tables at the end of the blob.
//
// Rules this packer holds to that the publish packer does not:
//
//  1. EVERY payload is content-interned, not just geometry, so a clip reaching the writer from a model,
//     a template and a scene gets one chunk.
//  2. A payload is replaced IN PLACE by a marker, never moved to a new field (see payloads.ts).
//  3. Inflate restores the ORIGINAL JSON — because `bundleMerge` deep-clones and id-remaps these objects and
//     `Scene.parse` reads them. An export/import round trip must be byte-identical.
//
// Engine-free and DOM-free: this runs inside projectWorker.ts.

import { ChunkWriter, ChunkReader, type ChunkRef } from '@cleo/app-kit/utils/chunkBlob'
import type { BundleAssetIndex, BundleData, BundleGeometry } from './bundle'
import { inflatePayloads, packPayloads, type GeometryRecord, type PayloadSink, type PayloadSource } from './payloads'

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

  const sink: PayloadSink<ChunkRef> = {
    minBytes: 0,
    deflate: true,
    add: (view, extra) => (extra ? { ...writer.addInterned(view), ...extra } : writer.addInterned(view)),
    geometry(record) {
      const key = JSON.stringify(record)
      const hit = geometryIds.get(key)
      if (hit) return hit
      const id = 'g' + geometryIds.size
      geometryIds.set(key, id)
      geometries[id] = record as BundleGeometry
      return id
    },
  }

  await packPayloads([bundle.manifest, bundle.scenes, bundle.libraries], sink)

  // Textures last, so the geometry chunks the JSON references sit at the front of the blob.
  const textures: BundleAssetIndex['textures'] = []
  for (const t of (bundle.textures ?? [])) {
    const bytes = t.bytes instanceof Uint8Array ? t.bytes : new Uint8Array(t.bytes)
    if (bytes.length === 0) continue
    const ref = writer.addInterned(bytes)
    textures.push({ id: t.id, mime: t.mime || 'image/png', config: t.config, o: ref.o, l: ref.l })
  }
  bundle.textures = []

  // Audio after the textures, on the same interning writer: two samples sharing a file store its bytes
  // once, which is the storage half of what the audio-source/sound-sample split buys.
  const audio: NonNullable<BundleAssetIndex['audio']> = []
  for (const a of (bundle.audio ?? [])) {
    const bytes = a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(a.bytes)
    if (bytes.length === 0) continue
    const ref = writer.addInterned(bytes)
    audio.push({ id: a.id, mime: a.mime || 'audio/mpeg', o: ref.o, l: ref.l })
  }
  bundle.audio = []

  // GI Volume bakes after the audio: each bake's .cgib bytes, whole.
  const giBakes: NonNullable<BundleAssetIndex['giBakes']> = []
  for (const g of (bundle.giBakes ?? [])) {
    const bytes = g.bytes instanceof Uint8Array ? g.bytes : new Uint8Array(g.bytes)
    if (bytes.length === 0) continue
    const ref = writer.addInterned(bytes)
    giBakes.push({ id: g.id, o: ref.o, l: ref.l })
  }
  bundle.giBakes = []

  return { blob: writer.finish(), index: { version: 1, geometries, textures, audio, ...(giBakes.length ? { giBakes } : {}) } }
}

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

  const source: PayloadSource<ChunkRef> = {
    bytes: ref => reader.bytes(ref),
    floats: ref => reader.floats(ref),
    u16: ref => reader.u16(ref),
    u32: ref => reader.u32(ref),
    // A bundle's meshes live in the table; an id is all the JSON holds.
    geometry: value => typeof value === 'string'
      ? index.geometries?.[value] as GeometryRecord<ChunkRef> | undefined
      : value,
  }

  await inflatePayloads([bundle.manifest, bundle.scenes, bundle.libraries], source)

  // Each texture must be SLICED into its own buffer, never handed a view onto the container: bundleImport
  // does `new Blob([t.bytes])` and bundleMerge dedupes on `byteLength`, and a view exposes the whole blob.
  bundle.textures = (index.textures ?? []).map(t => ({
    id: t.id,
    mime: t.mime,
    config: t.config,
    bytes: reader.bytes({ o: t.o, l: t.l })!.slice().buffer as ArrayBuffer,
  }))

  // Sliced for the same reason as the textures above. `?? []` is the compatibility arm: a bundle written
  // before audio existed simply has no table here.
  bundle.audio = (index.audio ?? []).map(a => ({
    id: a.id,
    mime: a.mime,
    bytes: reader.bytes({ o: a.o, l: a.l })!.slice().buffer as ArrayBuffer,
  }))

  // Sliced like the audio. A bundle written before GI bakes existed has no table: none.
  bundle.giBakes = (index.giBakes ?? []).map(g => ({
    id: g.id,
    bytes: reader.bytes({ o: g.o, l: g.l })!.slice().buffer as ArrayBuffer,
  }))
}
