import { describe, it, expect } from 'vitest'
import { buildFieldAssetTable, collectAssetTableTextureIds, fieldAssetIds, forEachFieldAssetRef } from '../src/utils/fieldAssets'
import { walkRefs, type EdgeSpec } from '../src/utils/assetEdges'
import { remapDeep } from '../src/utils/bundleMerge'
import { collectPublishedSoundIds, collectPublishedTextureIds } from '../src/utils/references'
import { collectTextureIds } from '../src/utils/nodeSubtree'

// The assets script fields hold (`skin: Material`, stored `{ $asset, id }` in a node's `scriptVars`): found in a
// built game's trees, packed ONCE however many fields name them, followed by the reference graph and merges.

const scene = {
  name: 'root',
  children: [
    { name: 'A', scriptVars: { skin: { $asset: 'material', id: 'm1' }, speed: 3 } },
    { name: 'B', scriptVars: { skin: { $asset: 'material', id: 'm1' }, decals: [{ $asset: 'texture', id: 't1' }, { $asset: 'texture', id: 't2' }] },
      children: [{ name: 'C', scriptVars: { hit: { $asset: 'sound', id: 's1' }, tiles: { $asset: 'tileset', id: 'ts1' } } }] },
  ],
}
const template = { name: 'Enemy', scriptVars: { skin: { $asset: 'material', id: 'm2' } } }

const materials = [
  { id: 'm1', name: 'Red', material: { type: 'pbr', textures: { baseTexture: 'tm1' } }, thumbnail: '' },
  { id: 'm2', name: 'Blue', material: { type: 'pbr', textures: {} }, thumbnail: '' },
  { id: 'unused', name: 'Grey', material: { type: 'pbr' }, thumbnail: '' },
]

describe('asset fields in a built game', () => {
  it('are found with the field they sit in', () => {
    const seen: string[] = []
    forEachFieldAssetRef(scene, (ref, field) => seen.push(`${ref.$asset}:${ref.id}@${field}`))
    expect(seen).toEqual([
      'material:m1@scriptVars.skin', 'material:m1@scriptVars.skin',
      'texture:t1@scriptVars.decals[0]', 'texture:t2@scriptVars.decals[1]',
      'sound:s1@scriptVars.hit', 'tileset:ts1@scriptVars.tiles',
    ])
    expect([...fieldAssetIds([scene, template], 'material')]).toEqual(['m1', 'm2'])
  })

  it('pack each material once, however many fields name it, and nothing no field names', () => {
    const table = buildFieldAssetTable([scene, template], { materials: materials as any })!
    expect(Object.keys(table.materials!)).toEqual(['m1', 'm2'])
    expect(table.materials!.m1).toEqual(materials[0].material)
    expect(table.materials!.m1).not.toBe(materials[0].material)
    expect(buildFieldAssetTable([{ name: 'empty' }], { materials: materials as any })).toBeUndefined()
  })

  it('ship the textures and sounds they name, and those the packed materials draw', () => {
    const textures = new Set<string>()
    collectPublishedTextureIds(scene, textures)
    collectAssetTableTextureIds(buildFieldAssetTable([scene], { materials: materials as any }), textures, collectTextureIds)
    expect([...textures].sort()).toEqual(['t1', 't2', 'tm1'])
    const sounds = new Set<string>()
    collectPublishedSoundIds(scene, sounds)
    expect([...sounds]).toEqual(['s1'])
  })

  it('are edges of the reference graph, and move with their asset in a merge', () => {
    const edges: EdgeSpec[] = []
    walkRefs(JSON.parse(JSON.stringify(scene)), edges)
    expect(edges.map(e => `${e.to.kind}:${e.to.id}@${e.field}`)).toEqual([
      'material:m1@scriptVars.skin', 'material:m1@scriptVars.skin',
      'texture:t1@scriptVars.decals[0]', 'texture:t2@scriptVars.decals[1]',
      'soundSample:s1@scriptVars.hit', 'tileset:ts1@scriptVars.tiles',
    ])
    const copy = JSON.parse(JSON.stringify(scene))
    const map = (pairs: [string, string][]) => new Map(pairs)
    const empty = new Map<string, string>()
    remapDeep(copy, {
      tex: map([['t1', 'T1']]), mat: map([['m1', 'M1']]), sound: map([['s1', 'S1']]), tileset: map([['ts1', 'TS1']]),
      tmat: empty, model: empty, afield: empty, brain: empty, vfx: empty, seq: empty, ctrl: empty, mask: empty, pose: empty,
      audio: empty, rig: empty, tpl: empty, anim: empty,
    } as any)
    expect(copy.children[0].scriptVars.skin.id).toBe('M1')
    expect(copy.children[1].scriptVars.decals.map((d: any) => d.id)).toEqual(['T1', 't2'])
    expect(copy.children[1].children[0].scriptVars).toEqual({ hit: { $asset: 'sound', id: 'S1' }, tiles: { $asset: 'tileset', id: 'TS1' } })
  })
})
