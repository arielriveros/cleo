// The one way a folder project writes JSON: stable, diffable, and exactly `JSON.stringify`'s data.
//
//  - 2-space indentation, LF, a trailing newline;
//  - an array of numbers / booleans / nulls stays on one line (a vector, a colour, a small curve), so a
//    changed value is a one-line diff instead of a column of numbers;
//  - keys in their ORIGINAL order — `hashAsset` (utils/assetHash.ts) is key-order sensitive, and an asset
//    must hash the same after a trip through a file;
//  - every value means what `JSON.stringify` makes of it (undefined and functions dropped, NaN/Infinity ->
//    null, `toJSON` honoured), checked by the property `JSON.stringify(JSON.parse(text)) === JSON.stringify(x)`.
//
// Pure; runs in the worker.

const isFlatLeaf = (v: unknown): boolean => v === null || typeof v === 'number' || typeof v === 'boolean'

/** `value` as the text a folder project stores. */
export function toJsonText(value: unknown): string {
  // Normalising through JSON first gives `JSON.stringify`'s exact semantics for free (toJSON, dropped
  // undefined, NaN -> null, a Map -> {}), so the printer below only ever sees plain JSON values.
  const plain = JSON.parse(JSON.stringify(value) ?? 'null')
  const out: string[] = []
  write(plain, '', out)
  out.push('\n')
  return out.join('')
}

function write(value: unknown, indent: string, out: string[]): void {
  if (value === null || typeof value !== 'object') { out.push(JSON.stringify(value)); return }
  const inner = indent + '  '
  if (Array.isArray(value)) {
    if (value.length === 0) { out.push('[]'); return }
    if (value.every(isFlatLeaf)) { out.push('[', value.map(v => JSON.stringify(v)).join(', '), ']'); return }
    out.push('[\n')
    value.forEach((item, i) => {
      out.push(inner)
      write(item, inner, out)
      out.push(i < value.length - 1 ? ',\n' : '\n')
    })
    out.push(indent, ']')
    return
  }
  const keys = Object.keys(value)
  if (keys.length === 0) { out.push('{}'); return }
  out.push('{\n')
  keys.forEach((key, i) => {
    out.push(inner, JSON.stringify(key), ': ')
    write((value as Record<string, unknown>)[key], inner, out)
    out.push(i < keys.length - 1 ? ',\n' : '\n')
  })
  out.push(indent, '}')
}

/**
 * Parse a folder file. Distinguishes the two ways a file a person or git touched goes wrong, because the
 * editor must react to them differently from a plain typo: an unresolved merge leaves conflict markers,
 * and a Git LFS checkout without `git lfs pull` leaves a pointer file where the content should be.
 */
export type ParsedJson =
  | { ok: true; value: any }
  | { ok: false; reason: 'conflict' | 'lfs-pointer' | 'invalid'; message: string }

export function parseJsonText(text: string): ParsedJson {
  if (isLfsPointerText(text)) return { ok: false, reason: 'lfs-pointer', message: 'a Git LFS pointer, not the file (run git lfs pull)' }
  if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) return { ok: false, reason: 'conflict', message: 'unresolved merge conflict markers' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, reason: 'invalid', message: e instanceof Error ? e.message : String(e) }
  }
}

const LFS_HEADER = 'version https://git-lfs.github.com/spec/'

/** A Git LFS pointer: a small text file standing in for content that was never fetched. */
export function isLfsPointerText(text: string): boolean {
  return text.length < 1024 && text.startsWith(LFS_HEADER)
}

/** The byte form of `isLfsPointerText`, for files that should be binary (images, audio, blobs). */
export function isLfsPointerBytes(bytes: Uint8Array): boolean {
  if (bytes.length >= 1024 || bytes.length < LFS_HEADER.length) return false
  for (let i = 0; i < LFS_HEADER.length; i++) if (bytes[i] !== LFS_HEADER.charCodeAt(i)) return false
  return true
}
