import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The drift guard between the asset reference graph and the canonical reference table.
//
// `bundleMerge.ts`'s `remapDeep`/`remapVariables` is the exhaustive list of every cross-asset reference
// key in the project: merging a bundle has to rewrite every id that points at another asset, so a field
// missing there is a merge bug someone would notice. That makes it the natural authority, and it predates
// the graph.
//
// `assetEdges.ts` mirrors it branch for branch. A new reference field added to the merge table but not to
// the extractor would make the graph silently UNDER-report: the asset would look unreferenced in the
// viewer, safe to delete in the delete dialog, and would never mark its dependents stale. Silent
// under-reporting is worse than no graph at all, so it is a test failure.
//
// Source-scanned rather than imported, in the idiom of editorModeReachability.test.ts: importing
// bundleMerge to introspect its branches is not possible — they are `if` statements, not data.

const SRC = join(__dirname, '..', 'src')
// core.autocrlf checks this tree out with CRLF on Windows; every pattern below is written against \n.
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf-8').replace(/\r\n/g, '\n')

/** Every `key === 'name'` the source branches on. */
function branchKeys(source: string): Set<string> {
  return new Set([...source.matchAll(/key === '([^']+)'/g)].map(m => m[1]))
}

/** Every node variable the source reads, via the shared `one(...)` / `list(...)` helpers. */
function variableKeys(source: string): Set<string> {
  return new Set([...source.matchAll(/\b(?:one|list)\('(__[A-Za-z]+)'/g)].map(m => m[1]))
}

/**
 * Keys `remapDeep` rewrites that `assetEdges` deliberately does not read, each with the reason.
 *
 * Both are MIRROR arrays whose entries duplicate a reference the record already states properly —
 * `soundIds[0]` is the sound sample's own id, `audioIds[0]` repeats `source.audioId`. The merge has to
 * rewrite them because they are stored and shipped; the graph must not read them, or every sound sample
 * would reference itself and every audio file would gain a duplicate edge.
 */
const NOT_REFERENCES = new Set(['audioIds', 'soundIds'])

describe('asset edge coverage', () => {
  const merge = read('utils', 'bundleMerge.ts')
  const edges = read('utils', 'assetEdges.ts')

  it('reads both sources', () => {
    expect(merge).toContain('export function remapDeep')
    expect(edges).toContain('export function walkRefs')
  })

  it('handles every reference key the bundle merge rewrites', () => {
    const canonical = branchKeys(merge)
    // Sanity: if the regex stops matching, this test would pass vacuously forever.
    expect(canonical.size).toBeGreaterThan(10)
    expect(canonical).toContain('materialId')

    const covered = branchKeys(edges)
    const missing = [...canonical].filter(k => !covered.has(k) && !NOT_REFERENCES.has(k))
    expect(missing, `assetEdges.ts must branch on these keys from bundleMerge's remapDeep: ${missing.join(', ')}`)
      .toEqual([])
  })

  it('handles every asset-link node variable the bundle merge rewrites', () => {
    const canonical = variableKeys(merge)
    expect(canonical.size).toBeGreaterThan(5)
    expect(canonical).toContain('__materialId')
    expect(canonical).toContain('__screenMaterialIds')

    const covered = variableKeys(edges)
    const missing = [...canonical].filter(k => !covered.has(k))
    expect(missing, `assetEdges.ts must read these node variables: ${missing.join(', ')}`).toEqual([])
  })

  // The exclusions are load-bearing: without them the graph reports permanent dangling edges for ids that
  // are working exactly as designed. If either predicate is dropped, the reason should be recorded.
  it('excludes engine-derived and inline ids', () => {
    expect(edges).toContain('isDerivedTextureId')
    expect(edges).toContain('isInlineTilesetId')
  })

  // `lodSource` names the model a generated LOD was decimated FROM. Reading it as a reference would
  // cascade a rebuild across assets that merely share an ancestry.
  it('skips provenance fields', () => {
    expect(edges).toContain('lodSource')
    expect(edges).toContain('PROVENANCE_KEYS')
  })
})
