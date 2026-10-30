// Comparing two serialized node subtrees, and keeping the unchanged parts of them shared.
//
// Undo/redo diffs a node's snapshot before and after an interaction. Doing that with
// `JSON.stringify(a) === JSON.stringify(b)` builds two complete texts of the subtree — and a model node's
// subtree contains its vertex buffers, so on a real mesh that is hundreds of MB of string per comparison,
// several minutes of work, and eventually `RangeError: Invalid string length`. It is also the wrong shape
// of answer: the question is "did anything change", which can be answered on the first difference.

import { isBinaryPayload, isTupleBuffer } from './binaryPayload'

/**
 * Equality of two numeric payloads — same container, same length, same values.
 *
 * The container is part of it. Nothing here has to tell a `Float32Array` from the plain array of the same
 * numbers (`serialize` always writes the same one), but treating them as equal would let `shareBuffers`
 * swap one for the other and quietly change what a snapshot restores as.
 */
function sameBuffer(a: any, b: any): boolean {
  if (a === b) return true // the shared case, and the one shareBuffers below makes common
  if (ArrayBuffer.isView(a) !== ArrayBuffer.isView(b)) return false
  if (a.constructor !== b.constructor) return false
  const lengthA = (a as ArrayLike<number>).length
  if (lengthA !== (b as ArrayLike<number>).length) return false

  // The tuple shape (`[[x,y,z], …]`, what a baked foliage rule carries) needs its elements compared, not
  // its element REFERENCES — `a[i] !== b[i]` on two arrays is always true and would report a change on
  // every interaction over a landscape.
  if (isTupleBuffer(a)) {
    for (let i = 0; i < lengthA; i++) {
      const x = a[i], y = b[i]
      if (x === y) continue
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false
      for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false
    }
    return true
  }

  for (let i = 0; i < lengthA; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Deep structural equality, short-circuiting on the first difference and allocating nothing.
 *
 * Key ORDER is deliberately not significant, unlike the stringify comparison this replaces: two
 * serializations of the same node always produce the same order anyway, and an order-sensitive compare
 * would report a spurious edit if it ever did not.
 */
export function sameSnapshot(a: any, b: any): boolean {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return a === b

  const binaryA = isBinaryPayload(a)
  if (binaryA !== isBinaryPayload(b)) return false
  if (binaryA) return sameBuffer(a, b)

  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameSnapshot(a[i], b[i])) return false
    return true
  }

  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!sameSnapshot(a[key], b[key])) return false
  }
  return true
}

/**
 * Replace every buffer in `next` that is byte-equal to the one in the same place in `prev` with `prev`'s
 * array object, in place. Returns `next`.
 *
 * This is what makes an undo history over a model affordable. `Node.serialize()` COPIES each vertex
 * buffer, so without this every history entry holds its own copy of a mesh that never changed — 200
 * entries deep, that is 200 meshes. Sharing means one copy for however many entries reference it, and it
 * makes the next comparison hit `a === b` immediately instead of walking millions of floats.
 *
 * Safe because a serialized snapshot is only ever read: it is parsed to rebuild a subtree, and the
 * `Geometry` constructor copies a plain array and passes a typed array straight through to a node that
 * then owns its own instance.
 */
export function shareBuffers(next: any, prev: any): any {
  if (!next || !prev || typeof next !== 'object' || typeof prev !== 'object') return next
  if (isBinaryPayload(next) || isBinaryPayload(prev)) return next

  const keys = Array.isArray(next) ? next.map((_, i) => i) : Object.keys(next)
  for (const key of keys as any[]) {
    const a = (next as any)[key]
    const b = (prev as any)[key]
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') continue
    if (isBinaryPayload(a) && isBinaryPayload(b)) {
      if (a !== b && sameBuffer(a, b)) (next as any)[key] = b
      continue
    }
    shareBuffers(a, b)
  }
  return next
}
