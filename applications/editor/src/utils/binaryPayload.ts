/**
 * Where a generic walk over serialized node JSON must stop.
 *
 * A model's vertex buffers are typed arrays (see `serializeGeometry` in src/graphics/model.ts), and a
 * `Float32Array` is an object — so a recursive walker that reaches one calls `Object.keys` on it and
 * materialises one string per element. On a real mesh that is millions of strings for nothing.
 *
 * A plain `number[]` of the same values is the cheaper mistake but still a wasted million calls, so both
 * are treated the same: a run of numbers holds no ids, no texture references and no children, and there
 * is never a reason to descend into one.
 *
 * No imports on purpose — this is used inside projectWorker.ts, which cannot pull in `cleo`.
 */
export function isFlatBuffer(value: any): boolean {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true
  // Checking both ends catches a buffer without paying for a full scan; a mixed array of that shape is
  // not something the serializer produces.
  return Array.isArray(value) && value.length > 0 &&
    typeof value[0] === 'number' && typeof value[value.length - 1] === 'number'
}

/** A short run of numbers and nothing else — one vertex of a tuple-shaped attribute. */
function isTuple(value: any): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return false
  for (let i = 0; i < value.length; i++) if (typeof value[i] !== 'number') return false
  return true
}

/**
 * `[[x,y,z], [x,y,z], …]` — the tuple-per-vertex shape the foliage rule baker emits
 * (`bakeModel` in utils/foliageRules.ts), as opposed to the flat buffers `Model.serialize` writes.
 *
 * Worth recognising separately because it is just as big and just as pointless to walk, and it defeats
 * a flat-array check: the outer array's elements are arrays, not numbers. A skin's `nodeTransforms`
 * (`[index, matrix]`) and `nodeNames` (`[index, string]`) deliberately do NOT match — their second
 * element is not a number.
 */
export function isTupleBuffer(value: any): boolean {
  return Array.isArray(value) && value.length > 0 &&
    isTuple(value[0]) && isTuple(value[value.length - 1])
}

export function isBinaryPayload(value: any): boolean {
  return isFlatBuffer(value) || isTupleBuffer(value)
}
