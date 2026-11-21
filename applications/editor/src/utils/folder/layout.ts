// Where everything of a folder project lives on disk, and the mapping between explorer paths and files.
//
//   project.cleo                  the project file (name, main scene, prefs)
//   ProjectSettings/settings.json ProjectSettings/input.json
//   Assets/                       the Asset Explorer root: "/X/Y.mat" <-> "Assets/X/Y.mat", beside "Y.mat.meta"
//   Derived/                      records that ship but have no explorer entry (LOD twins)
//   Blobs/ab/<sha256>.bin         content-addressed payloads, shared project-wide
//   Baked/<bakeId>.bake           GI and water bakes
//   .cleo/                        regenerable, never committed
//
// The VFS path <-> file mapping is BIJECTIVE on every platform: a segment is %-encoded where a file system
// would refuse or silently change it (reserved characters, a trailing dot or space, a device name), and `%`
// itself is encoded, so decoding is unambiguous. Explorer names stay free-form; only the file name is
// encoded. Scripts are the exception — their file name IS their module id and their `cleo-script:///`
// URL, so a script name must already be safe (see `isSafeScriptSegment`).
//
// Pure: no DOM, engine or Electron. Runs in the project worker and in Node tests.

import { AUDIO_EXTS, KIND_EXT, kindOfExt, type AssetKind } from '../vfs'

export const PROJECT_FILE = 'project.cleo'
export const SETTINGS_REL = 'ProjectSettings/settings.json'
export const INPUT_REL = 'ProjectSettings/input.json'
export const ASSETS_DIR = 'Assets'
export const DERIVED_DIR = 'Derived'
export const BLOBS_DIR = 'Blobs'
export const BAKED_DIR = 'Baked'
export const META_EXT = '.meta'
export const SCRIPT_FILE_EXT = '.ts'
export const BAKE_EXT = '.bake'

/** Top-level folders the editor owns and watches. Everything else at the root is tooling or the user's. */
export const WATCHED_DIRS = [ASSETS_DIR, 'ProjectSettings', DERIVED_DIR, BLOBS_DIR, BAKED_DIR] as const

/** The image extensions a file dropped into Assets/ is read as. Matches the explorer's upload router. */
export const IMAGE_FILE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.tiff', '.gif', '.ktx2', '.hdr', '.exr', '.avif'] as const

// ---------------------------------------------------------------------------------------------------
// Segment encoding
// ---------------------------------------------------------------------------------------------------

const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i
const pct = (ch: string) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')

/** One explorer path segment -> a file name that every platform stores unchanged. Never returns ''. */
export function encodeSegment(name: string): string {
  if (!name) return '%00'
  let out = ''
  for (const ch of name.normalize('NFC')) {
    const code = ch.codePointAt(0)!
    out += code < 0x20 || code === 0x7f || '<>:"/\\|?*%'.includes(ch) ? pct(ch) : ch
  }
  // Windows strips a trailing dot or space; encode the last character so the name survives.
  if (/[. ]$/.test(out)) out = out.slice(0, -1) + pct(out[out.length - 1])
  // A device name ('CON', 'nul.mat') opens the device instead of a file.
  if (RESERVED_NAME.test(out)) out = pct(out[0]) + out.slice(1)
  return out
}

/** The inverse of `encodeSegment`. A malformed escape is kept literally. */
export function decodeSegment(file: string): string {
  if (file === '%00') return ''
  return file.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * Whether a script name is already its own file name. A script's file path IS its module id and its
 * `cleo-script:///` URL, which VS Code maps straight onto the workspace (spaces arrive %20-encoded, which
 * the debugger decodes); a name this encoding would change can no longer be mapped.
 */
export function isSafeScriptSegment(name: string): boolean {
  return !!name && encodeSegment(name) === name && !name.includes('#')
}

/** The key two file names collide under on a case-insensitive, normalising file system. */
export function collisionKey(rel: string): string {
  return rel.normalize('NFC').toLowerCase()
}

// ---------------------------------------------------------------------------------------------------
// Explorer path <-> file
// ---------------------------------------------------------------------------------------------------

/**
 * '/Props/Rock.mat' -> 'Assets/Props/Rock.mat'; '/Player/Hero.script' -> 'Assets/Player/Hero.ts'.
 * Only a script changes extension: its file is the source an IDE edits.
 */
export function relOfVfsPath(path: string, kind: AssetKind): string {
  const parts = path.split('/').filter(Boolean)
  let base = parts.pop() ?? ''
  if (kind === 'script' && base.toLowerCase().endsWith(KIND_EXT.script)) base = base.slice(0, -KIND_EXT.script.length) + SCRIPT_FILE_EXT
  return [ASSETS_DIR, ...parts.map(encodeSegment), encodeSegment(base)].join('/')
}

/** The inverse, given the kind the file was read as. Null for a rel outside Assets/. */
export function vfsPathOfRel(rel: string, kind: AssetKind): string | null {
  const parts = rel.split('/')
  if (parts[0] !== ASSETS_DIR || parts.length < 2) return null
  const segments = parts.slice(1).map(decodeSegment)
  let base = segments.pop()!
  if (kind === 'script' && base.toLowerCase().endsWith(SCRIPT_FILE_EXT)) base = base.slice(0, -SCRIPT_FILE_EXT.length) + KIND_EXT.script
  return '/' + [...segments, base].join('/')
}

/** A folder's explorer path -> its directory. '/Props' -> 'Assets/Props'. */
export function relOfVfsFolder(path: string): string {
  return [ASSETS_DIR, ...path.split('/').filter(Boolean).map(encodeSegment)].join('/')
}

/** The inverse of `relOfVfsFolder`, or null outside Assets/ (Assets/ itself is the root, '/'). */
export function vfsFolderOfRel(rel: string): string | null {
  const parts = rel.split('/').filter(Boolean)
  if (parts[0] !== ASSETS_DIR) return null
  return '/' + parts.slice(1).map(decodeSegment).join('/')
}

const extOfName = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

/**
 * The kind a file is, from its name alone — what a file without a `.meta` is read as. Null when it is
 * not an asset at all (a `.d.ts`, a test, a README someone left in a folder).
 */
export function kindOfFileName(name: string): AssetKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.d.ts') || lower.endsWith('.test.ts') || lower.endsWith('.spec.ts')) return null
  const ext = extOfName(name)
  if (ext === SCRIPT_FILE_EXT) return 'script'
  if (ext === KIND_EXT.script) return null // a '.script' file on disk is not how scripts are stored
  if ((AUDIO_EXTS as readonly string[]).includes(ext)) return 'audioSource'
  if ((IMAGE_FILE_EXTS as readonly string[]).includes(ext)) return 'image'
  const kind = kindOfExt(ext)
  // kindOfExt falls back to 'image' for anything it does not know; on disk an unknown file is not an asset.
  return kind === 'image' ? null : kind
}

// ---------------------------------------------------------------------------------------------------
// Sidecars and stores
// ---------------------------------------------------------------------------------------------------

export const metaRelOf = (rel: string): string => rel + META_EXT
export const isMetaRel = (rel: string): boolean => rel.toLowerCase().endsWith(META_EXT)
export const assetRelOfMeta = (metaRel: string): string => metaRel.slice(0, -META_EXT.length)

const HEX64 = /^[0-9a-f]{64}$/

/** 'Blobs/ab/ab…ff.bin' for a sha256 hex digest. */
export function blobRel(hash: string): string {
  return `${BLOBS_DIR}/${hash.slice(0, 2)}/${hash}.bin`
}

/** The digest a blob file is named by, or null when the rel is not a blob. */
export function hashOfBlobRel(rel: string): string | null {
  const m = /^Blobs\/([0-9a-f]{2})\/([0-9a-f]{64})\.bin$/.exec(rel)
  return m && m[2].startsWith(m[1]) && HEX64.test(m[2]) ? m[2] : null
}

export const bakeRel = (bakeId: string): string => `${BAKED_DIR}/${encodeSegment(bakeId)}${BAKE_EXT}`

export function bakeIdOfRel(rel: string): string | null {
  const m = /^Baked\/([^/]+)\.bake$/.exec(rel)
  return m ? decodeSegment(m[1]) : null
}

/**
 * A record that ships but has no explorer entry (a LOD level's downscaled texture) lives in Derived/,
 * named by its id. `ext` is the byte file's real extension, or the kind's virtual one.
 */
export function derivedRel(kind: AssetKind, id: string, ext: string): string {
  return `${DERIVED_DIR}/${encodeSegment(id + (kind === 'texture' ? KIND_EXT.texture : ext))}`
}

/** What a project-relative path is to the editor. */
export type RelRole =
  | 'project' | 'settings' | 'input'
  | 'asset' | 'derived' | 'meta' | 'blob' | 'bake'
  | 'other'

export function roleOfRel(rel: string): RelRole {
  if (rel === PROJECT_FILE) return 'project'
  if (rel === SETTINGS_REL) return 'settings'
  if (rel === INPUT_REL) return 'input'
  const top = rel.slice(0, rel.indexOf('/'))
  if (top === BLOBS_DIR) return hashOfBlobRel(rel) ? 'blob' : 'other'
  if (top === BAKED_DIR) return bakeIdOfRel(rel) !== null ? 'bake' : 'other'
  if (top === ASSETS_DIR || top === DERIVED_DIR) {
    if (isMetaRel(rel)) return 'meta'
    return top === ASSETS_DIR ? 'asset' : 'derived'
  }
  return 'other'
}

/**
 * Whether a file is the project's binary data rather than text: a blob, a bake, or the bytes of an image or a
 * sound (in Assets/, or a LOD twin in Derived/, which is named by its id and so needs no extension). Every
 * `.meta`, record, scene and script is text. What a repository can keep out of git (the shipped examples keep
 * these in a release, not in the repo).
 */
export function isDataRel(rel: string, kind?: AssetKind | null): boolean {
  const role = roleOfRel(rel)
  if (role === 'blob' || role === 'bake') return true
  if (role === 'derived') return !rel.toLowerCase().endsWith(KIND_EXT.texture)
  if (role !== 'asset') return false
  const k = kind ?? kindOfFileName(nameOfRel(rel))
  return k === 'image' || k === 'audioSource'
}

/** The file name of a rel. */
export const nameOfRel = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

/** The directory of a rel ('' at the root). */
export const dirOfRel = (rel: string): string => {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}
