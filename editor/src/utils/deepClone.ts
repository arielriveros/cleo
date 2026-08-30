/**
 * Deep-copy plain data (a serialized node subtree, an asset, a scene payload).
 *
 * Use this instead of `JSON.parse(JSON.stringify(x))` for anything that can hold a model: a serialized
 * mesh writes `positions`/`normals`/`tangents`/`bitangents`/`texCoords`/`indices` as number arrays, plus
 * — for a skinned model — joint attributes and every animation clip. On a large import that intermediate
 * JSON string runs past V8's maximum string length (~512MB) and `JSON.stringify` throws
 * `RangeError: Invalid string length`, taking down whatever was merely trying to COPY the object.
 *
 * The data itself is fine when this happens: IndexedDB persists through structured clone and never builds
 * a string, which is why such an asset stores and reloads but cannot be opened. `structuredClone` is the
 * same algorithm, so it has no such ceiling — and it is faster, and it preserves typed arrays, Map and Set
 * instead of silently mangling them.
 *
 * Two behaviour differences from the JSON round trip, neither of which affects serialized node data:
 * `undefined` properties survive rather than being dropped, and a function or class instance throws
 * `DataCloneError` rather than being silently discarded — so that case falls back to the old behaviour.
 */
export function deepClone<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch (e) {
    // DataCloneError only: something in there is not structured-cloneable (a function, a DOM node, a
    // class instance). The JSON round trip drops those, which is what the call site used to rely on.
    if (e instanceof Error && e.name === 'DataCloneError') return JSON.parse(JSON.stringify(value))
    throw e
  }
}
