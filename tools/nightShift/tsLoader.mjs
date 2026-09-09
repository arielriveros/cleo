// Running the project's own TypeScript inside these Node tools.
//
// The Night Shift generator authors a project in the editor's on-disk shapes, and the importers apply the
// engine's retarget maths. Both are the kind of thing that fails SILENTLY when a second copy drifts: a
// skeleton stored with `nodeParents` as entry pairs instead of a Map retargets against nothing and reports
// no error; a VFS entry with the wrong virtual extension is simply never classified.
//
// So rather than restating those rules here, the modules that hold them are transpiled and run. Only pure
// ones are eligible — anything reaching the `cleo` barrel would drag in a renderer and a GL context that
// does not exist in Node. `loadScriptReflector` in bundle.mjs is the same trick with a hand-written stub;
// this is that generalised.

import fs from 'fs'
import path from 'path'
import { transform } from 'sucrase'
import * as glMatrix from 'gl-matrix'

/**
 * A module registry, sucrase-transpiled and linked by hand.
 *
 * `stub` maps a specifier SUFFIX to a namespace, so `'/animatedModel'` catches any relative path ending
 * that way. Relative imports not stubbed are resolved and loaded for real; anything else throws, which is
 * what stops a heavy dependency from creeping in unnoticed.
 *
 * Type-only imports need no handling: sucrase's TypeScript transform elides them, so a module importing
 * nothing but types loads with an empty stub table.
 */
export function moduleRegistry(stub = {}) {
  const cache = new Map()

  const load = (file) => {
    const key = path.resolve(file)
    if (cache.has(key)) return cache.get(key)

    const code = transform(fs.readFileSync(key, 'utf8'), {
      transforms: ['typescript', 'imports'],
      filePath: key,
    }).code

    const module = { exports: {} }
    cache.set(key, module.exports) // set before running, so a cycle resolves to the partial namespace

    const req = (name) => {
      if (name === 'gl-matrix') return glMatrix
      for (const [suffix, namespace] of Object.entries(stub)) {
        if (name === suffix || name.endsWith(suffix)) return namespace
      }
      if (name.startsWith('.')) return load(path.join(path.dirname(key), name) + '.ts')
      throw new Error(`${path.basename(key)} reached for an unstubbed module: ${name}`)
    }
    new Function('require', 'module', 'exports', code)(req, module, module.exports)
    cache.set(key, module.exports)
    return module.exports
  }

  return load
}
