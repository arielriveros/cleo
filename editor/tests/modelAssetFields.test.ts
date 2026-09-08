import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { carryModelAssetFields, MODEL_ASSET_PRESERVED_KEYS } from '../src/utils/modelClips'

// A model asset is rebuilt from a live subtree on every save, and anything the subtree cannot express is
// lost unless it is deliberately carried over. That is how every Model Editor save came to silently drop
// the model's `.anim` links: a linked clip is filtered out of `AnimatedModel.serialize`, so it exists
// nowhere in `nodeJson` to be read back.

const SRC = join(__dirname, '..', 'src')
// core.autocrlf checks this tree out with CRLF on Windows; every pattern below is written against \n.
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf-8').replace(/\r\n/g, '\n')

describe('carryModelAssetFields', () => {
  const prev = {
    id: 'm', name: 'old',
    animationIds: ['idle', 'run'],
    rigId: 'mannequin-rig',
    lodSource: { modelId: 'boulder', level: 1 },
  }

  it('restores every preserved field a rebuild did not derive', () => {
    const next: any = { id: 'm', name: 'new' }
    carryModelAssetFields(next, prev)
    expect(next).toMatchObject({
      animationIds: ['idle', 'run'],
      rigId: 'mannequin-rig',
      lodSource: { modelId: 'boulder', level: 1 },
    })
  })

  it('leaves everything else alone', () => {
    const next: any = { id: 'm', name: 'new', materialIds: ['stone'] }
    carryModelAssetFields(next, prev)
    expect(next.name).toBe('new')
    expect(next.materialIds).toEqual(['stone'])
  })

  // The reason the guard is `=== undefined` and not falsiness: unlinking the LAST animation writes `[]`,
  // and restoring the old list underneath that would make the unlink impossible.
  it('does not resurrect a deliberately emptied list', () => {
    const next: any = { id: 'm', animationIds: [] }
    carryModelAssetFields(next, prev)
    expect(next.animationIds).toEqual([])
  })

  it('does not overwrite a value the rebuild did derive', () => {
    const next: any = { id: 'm', animationIds: ['walk'] }
    carryModelAssetFields(next, prev)
    expect(next.animationIds).toEqual(['walk'])
  })

  it('is a no-op with no previous record', () => {
    const next: any = { id: 'm', name: 'new' }
    expect(carryModelAssetFields(next, undefined)).toBe(next)
    expect(carryModelAssetFields(next, null)).toBe(next)
    expect(next.animationIds).toBeUndefined()
  })

  it('returns the same object it was given', () => {
    const next: any = { id: 'm' }
    expect(carryModelAssetFields(next, prev)).toBe(next)
  })

  it('skips a field absent from both', () => {
    const next: any = { id: 'm' }
    carryModelAssetFields(next, { id: 'm' } as any)
    expect('rigId' in next).toBe(false)
  })
})

// The drift guard. A new ModelAsset field that buildModelAsset does not assign, and that nobody remembered
// to preserve, is silently dropped on every save — which is exactly the bug this phase fixes, and exactly
// the bug that would come back. Source-scanned in the idiom of assetEdgeCoverage.test.ts, because the
// question is about the SHAPE of a type and the BODY of a function, neither of which is data at runtime.
describe('ModelAsset field coverage', () => {
  const models = read('utils', 'models.ts')

  /** The field names declared in `export type ModelAsset = { … }`. */
  function modelAssetFields(source: string): string[] {
    const start = source.indexOf('export type ModelAsset = {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    // Field lines only: `  name: string`, `  lods?: ModelLodDef[]`. Comments and doc blocks are indented
    // further or start with * / /, so anchoring at exactly two spaces is enough.
    return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map(m => m[1])
  }

  /** The body of `buildModelAsset`, where a derived field must be assigned. */
  function buildBody(source: string): string {
    const start = source.indexOf('export async function buildModelAsset(')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n}', start)
    return source.slice(start, end)
  }

  it('parses the type and the builder', () => {
    expect(modelAssetFields(models).length).toBeGreaterThan(5)
    expect(buildBody(models)).toContain('carryModelAssetFields')
  })

  /**
   * Fields a re-save is SUPPOSED to drop.
   *
   * `textures` is the legacy shape that embedded texture payloads as base64 in the asset itself — the type
   * calls it "Still read; never written". A rebuilt asset references the texture store through `textureIds`
   * instead, so carrying the old blob forward would keep megabytes alive per model forever.
   */
  const DELIBERATELY_DROPPED = new Set(['textures'])

  it('every field is either derived by buildModelAsset, preserved, or deliberately dropped', () => {
    const body = buildBody(models)
    const preserved = new Set<string>(MODEL_ASSET_PRESERVED_KEYS)
    const missing = modelAssetFields(models).filter(field => {
      if (preserved.has(field) || DELIBERATELY_DROPPED.has(field)) return false
      // Assigned in the literal, as `asset.x = …`, or named in the destructured build.
      return !new RegExp(`\\b${field}\\b`).test(body)
    })
    expect(
      missing,
      `these ModelAsset fields are neither built by buildModelAsset nor listed in ` +
      `MODEL_ASSET_PRESERVED_KEYS, so a re-save drops them: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('keeps animationIds preserved — the field the bug was about', () => {
    expect(MODEL_ASSET_PRESERVED_KEYS).toContain('animationIds')
  })
})
