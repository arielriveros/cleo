// Asset metadata: the `.meta` sidecar beside every asset file of a folder project.
//
// A meta is what lets git move, rename and merge game data without breaking it. References between assets
// are by id, and the id lives here — not in the file name — so `git mv Rock.mat Stone.mat` (with its meta)
// keeps every material slot, foliage rule and scene that points at the rock.
//
// What a meta holds, and what it deliberately does not:
//   guid      the asset id, in the form its kind already uses (32 hex for most; the file-name-like
//             TextureManager / AudioManager id for images, textures, audio sources and sounds). Moving a
//             project into a folder re-mints NOTHING.
//   kind      which library the asset belongs to. Identity is (kind, guid): an image and the texture that
//             reads it share an id by design, as do an audio source and its sound.
//   created   when the asset was made (the explorer's Date column). Never changes.
//   record    for the kinds whose file is not JSON — images, audio, scripts — the verbatim library record,
//             with the slot the file itself holds replaced by `{"$file": 1}`.
//   importer  what the byte store keeps beside the bytes (mime, and an image's TextureManager load config).
//   Never: content hashes, sizes, mtimes, references — anything that would make a meta change on every
//   edit and double every diff. Those live in the editor's cache index.
//
// Pure.

import type { AssetKind } from '../vfs'
import { parseJsonText, toJsonText } from './jsonText'

export const META_VERSION = 1

export interface AssetMeta {
  /** Meta format version. A newer one than this build knows is read, but never rewritten. */
  cleo: number
  guid: string
  kind: AssetKind
  created?: number
  /** The library record, for kinds whose file is raw bytes or source text. */
  record?: Record<string, unknown>
  /** What the byte store keeps beside the bytes. */
  importer?: { mime?: string; config?: unknown }
  /** Derived/ only: the asset whose generated data this is (a LOD twin's model). */
  owner?: { kind: AssetKind; guid: string }
}

/** The placeholder a meta's `record` holds in the slot its file provides. */
export const FILE_SLOT = { $file: 1 } as const
export const isFileSlot = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as any).$file === 1 && Object.keys(v as object).length === 1

const KINDS: ReadonlySet<string> = new Set<AssetKind>([
  'image', 'texture', 'audioSource', 'soundSample', 'material', 'terrainMaterial', 'template', 'model', 'scene',
  'script', 'animationField', 'animation', 'rig', 'tileset', 'aiBrain', 'animController', 'boneMask', 'pose',
  'particleSystem', 'sequence',
])

export function isAssetKind(v: unknown): v is AssetKind {
  return typeof v === 'string' && KINDS.has(v)
}

export type ParsedMeta =
  | { ok: true; meta: AssetMeta }
  | { ok: false; reason: 'conflict' | 'lfs-pointer' | 'invalid'; message: string }

export function parseMeta(text: string): ParsedMeta {
  const parsed = parseJsonText(text)
  if (!parsed.ok) return parsed
  const v = parsed.value
  if (!v || typeof v !== 'object') return { ok: false, reason: 'invalid', message: 'not an object' }
  if (typeof v.guid !== 'string' || !v.guid) return { ok: false, reason: 'invalid', message: 'no guid' }
  if (!isAssetKind(v.kind)) return { ok: false, reason: 'invalid', message: `unknown kind "${v.kind}"` }
  const meta: AssetMeta = { cleo: typeof v.cleo === 'number' ? v.cleo : META_VERSION, guid: v.guid, kind: v.kind }
  if (typeof v.created === 'number') meta.created = v.created
  if (v.record && typeof v.record === 'object') meta.record = v.record
  if (v.importer && typeof v.importer === 'object') meta.importer = v.importer
  if (v.owner && typeof v.owner === 'object' && isAssetKind(v.owner.kind) && typeof v.owner.guid === 'string') meta.owner = v.owner
  return { ok: true, meta }
}

export function metaText(meta: AssetMeta): string {
  const out: Record<string, unknown> = { cleo: meta.cleo ?? META_VERSION, guid: meta.guid, kind: meta.kind }
  if (meta.created !== undefined) out.created = meta.created
  if (meta.owner) out.owner = meta.owner
  if (meta.record) out.record = meta.record
  if (meta.importer) out.importer = meta.importer
  return toJsonText(out)
}

/** A record with the slot its file provides replaced by the placeholder, keys left in their order. */
export function recordWithFileSlot(record: Record<string, unknown>, slot: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) out[key] = key === slot ? FILE_SLOT : record[key]
  return out
}

/** The inverse: the placeholder replaced by the file's content (appended if the meta lacks the slot). */
export function recordWithFile(record: Record<string, unknown>, slot: string, content: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let placed = false
  for (const key of Object.keys(record)) {
    if (key === slot) { out[key] = content; placed = true } else out[key] = record[key]
  }
  if (!placed) out[slot] = content
  return out
}
