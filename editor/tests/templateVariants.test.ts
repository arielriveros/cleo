import { describe, it, expect } from 'vitest'
import {
  cascadeFrom, createVariant, derivedNodeId, diffTemplate, flattenVariant, jsonPathMap, materializeVariant,
  saveVariant, baseNodeAt, revertInDiff, hasOwnChanges, variantFromContent, rebaseVariant, type VariantSource,
} from '../src/utils/templateVariants'
import { hashAsset } from '../src/utils/assetHash'

/** A weapon-like base: root with script fields, a Mesh child with geometry + material, two Light children. */
function weaponBase(over: Partial<{ damage: number; colour: number[] }> = {}): VariantSource {
  return {
    id: 'tpl-weapon', name: 'Weapon',
    nodeJson: {
      id: 'w-root', name: 'Weapon', type: 'node',
      variables: { __scriptId: { type: 'string', value: 'scr-weapon' } },
      scriptVars: { damage: over.damage ?? 100, staminaMul: 1 },
      position: [0, 0, 0],
      children: [
        {
          id: 'w-mesh', name: 'Mesh', type: 'model', position: [0, 0, 0],
          model: { geometry: { positions: new Float32Array([0, 1, 2, 3, 4, 5]) }, material: { color: over.colour ?? [1, 1, 1], textures: { albedo: 'tex-a' } } },
          children: [],
        },
        { id: 'w-l1', name: 'Light', type: 'light', intensity: 1, children: [] },
        { id: 'w-l2', name: 'Light', type: 'light', intensity: 2, children: [] },
        { id: 'w-cam', name: 'Rig', type: 'cameraRig', followId: 'w-mesh', children: [] },
      ],
    },
    textureIds: ['tex-a'],
    scripts: { 'w-l1': 'inline light script' },
    bodies: { 'w-root': { mass: 1 } },
    triggers: {},
  }
}

/** Turn a materialized variant into an "edited tab" candidate: same content, a copy we can mutate. */
function editable(t: VariantSource): VariantSource {
  return { ...t, nodeJson: structuredCloneLike(t.nodeJson), scripts: { ...t.scripts }, bodies: { ...t.bodies }, triggers: { ...t.triggers } }
}
function structuredCloneLike(v: any): any {
  if (v === null || typeof v !== 'object') return v
  if (ArrayBuffer.isView(v)) return (v as any).slice()
  if (Array.isArray(v)) return v.map(structuredCloneLike)
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, structuredCloneLike(x)]))
}

describe('diffTemplate', () => {
  it('finds nothing between a template and itself', () => {
    const d = diffTemplate(weaponBase(), weaponBase())
    expect(d.nodes).toEqual({})
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.bodies).toEqual({})
    expect(d.scripts).toEqual({})
  })

  it('records only the changed leaves — a material tweak never copies the geometry', () => {
    const cand = weaponBase({ damage: 165, colour: [1, 0, 0] })
    cand.nodeJson.id = 'other-root'                         // ids never diff
    const d = diffTemplate(weaponBase(), cand)
    expect(d.nodes['']).toEqual({ merge: { scriptVars: { damage: 165 } } })
    expect(d.nodes['Mesh']).toEqual({ merge: { model: { material: { color: [1, 0, 0] } } } })
    expect(JSON.stringify(d)).not.toContain('positions')
  })

  it('records removed keys, added and removed children, and same-named siblings by #k', () => {
    const cand = weaponBase()
    delete cand.nodeJson.scriptVars.staminaMul
    cand.nodeJson.children.splice(2, 1)                      // drop the second Light
    cand.nodeJson.children.push({ id: 'x', name: 'Move', type: 'node', scriptVars: { clip: 'L1' }, children: [{ id: 'y', name: 'Fx', type: 'node', children: [] }] })
    const d = diffTemplate(weaponBase(), cand)
    expect(d.nodes['']).toEqual({ unset: [['scriptVars', 'staminaMul']] })
    expect(d.removed).toEqual(['Light#1'])
    expect(d.added).toHaveLength(1)                          // the Fx child travels inside Move
    expect(d.added[0]).toMatchObject({ parent: '', index: 3, node: { name: 'Move', children: [{ name: 'Fx' }] } })
    expect(d.added[0].node.id).toBeUndefined()
  })

  it('a changed node type is a replacement, not a patch', () => {
    const cand = weaponBase()
    cand.nodeJson.children[0] = { id: 'm2', name: 'Mesh', type: 'sprite', children: [] }
    const d = diffTemplate(weaponBase(), cand)
    expect(d.removed).toContain('Mesh')
    expect(d.added.map(a => a.node.name)).toContain('Mesh')
  })

  it('carries bodies and inline scripts by path', () => {
    const cand = weaponBase()
    cand.bodies = { 'w-root': { mass: 3 } }
    cand.triggers = { 'w-mesh': { shapes: [] } }
    cand.scripts = {}
    const d = diffTemplate(weaponBase(), cand)
    expect(d.bodies).toEqual({ '': { mass: 3 } })
    expect(d.triggers).toEqual({ Mesh: { shapes: [] } })
    expect(d.scripts).toEqual({ Light: null })
  })
})

describe('materializeVariant', () => {
  it('gives every node a derived id: deterministic, and disjoint from the base', () => {
    const a = materializeVariant(weaponBase(), 'tpl-sword', diffTemplate(weaponBase(), weaponBase()))
    const b = materializeVariant(weaponBase(), 'tpl-sword', diffTemplate(weaponBase(), weaponBase()))
    const ids = [...jsonPathMap(a.nodeJson).values()].map(e => e.node.id)
    expect(ids).toEqual([...jsonPathMap(b.nodeJson).values()].map(e => e.node.id))
    expect(ids[0]).toBe(derivedNodeId('tpl-sword', ''))
    expect(ids).not.toContain('w-root')
    expect(new Set(ids).size).toBe(ids.length)
    expect(a.nodeJson.children[0].model.geometry.positions).toBeInstanceOf(Float32Array)
  })

  it('re-keys bodies, scripts and in-template references onto the new ids', () => {
    const m = materializeVariant(weaponBase(), 'v', diffTemplate(weaponBase(), weaponBase()))
    const map = jsonPathMap(m.nodeJson)
    expect(m.bodies).toEqual({ [map.get('')!.node.id]: { mass: 1 } })
    expect(m.scripts).toEqual({ [map.get('Light')!.node.id]: 'inline light script' })
    expect(map.get('Rig')!.node.followId).toBe(map.get('Mesh')!.node.id)
    expect(m.textureIds).toEqual(['tex-a'])
  })

  it('reproduces an edited candidate exactly (round trip)', () => {
    const variant = createVariant(weaponBase(), 'Sword', 'tpl-sword')
    const edited = editable(variant as VariantSource)
    edited.nodeJson.scriptVars.damage = 140
    edited.nodeJson.children[0].model.material.color = [0, 1, 0]
    edited.nodeJson.children.splice(1, 1)
    edited.nodeJson.children.push({ id: 'n', name: 'Move', type: 'node', scriptVars: { clip: 'L1' }, children: [] })
    edited.bodies = { [edited.nodeJson.id]: { mass: 2 } }
    const saved = saveVariant(variant, edited, weaponBase(), weaponBase())
    const strip = (j: any): any => ({ ...j, id: undefined, children: (j.children ?? []).map(strip) })
    expect(strip(saved.nodeJson)).toEqual(strip(edited.nodeJson))
    expect(Object.values(saved.bodies)).toEqual([{ mass: 2 }])
  })

  it('a base edit flows into the variant, and the variant\'s own overrides survive it', () => {
    const v0 = createVariant(weaponBase(), 'Sword', 'tpl-sword')
    const edited = editable(v0 as VariantSource)
    edited.nodeJson.scriptVars.damage = 140
    const v1 = saveVariant(v0, edited, weaponBase(), weaponBase())

    const newBase = weaponBase({ colour: [0, 0, 1] })
    newBase.nodeJson.scriptVars.staminaMul = 2
    newBase.nodeJson.children.push({ id: 'w-new', name: 'Guard', type: 'node', children: [] })
    const [v2] = cascadeFrom([newBase, v1], 'tpl-weapon')
    expect(v2.nodeJson.scriptVars).toEqual({ damage: 140, staminaMul: 2 })
    expect(v2.nodeJson.children[0].model.material.color).toEqual([0, 0, 1])
    expect(v2.nodeJson.children.map((c: any) => c.name)).toContain('Guard')
    expect(v2.nodeJson.name).toBe('Sword')
  })

  it('keeps a patch whose path the base dropped, and applies it again when the path returns', () => {
    const v0 = createVariant(weaponBase(), 'Sword', 'v')
    const edited = editable(v0 as VariantSource)
    edited.nodeJson.children[0].position = [0, 1, 0]
    const v1 = saveVariant(v0, edited, weaponBase(), weaponBase())
    const noMesh = weaponBase(); noMesh.nodeJson.children.splice(0, 1)
    const gone = materializeVariant(noMesh, 'v', v1.variant!.diff)
    expect(gone.nodeJson.children.map((c: any) => c.name)).not.toContain('Mesh')
    expect(v1.variant!.diff.nodes['Mesh']).toBeDefined()
    expect(materializeVariant(weaponBase(), 'v', v1.variant!.diff).nodeJson.children[0].position).toEqual([0, 1, 0])
  })

  it('drops a cached script source when the variant swaps the node\'s script asset', () => {
    const base = weaponBase()
    base.scripts['w-root'] = 'base class source'
    const v0 = createVariant(base, 'Sword', 'v')
    const edited = editable(v0 as VariantSource)
    edited.nodeJson.variables.__scriptId.value = 'scr-sword'
    const v1 = saveVariant(v0, edited, base, base)
    expect(Object.values(v1.scripts)).not.toContain('base class source')
  })

  it('hashes identically when re-materialized from an unchanged base', () => {
    const v = createVariant(weaponBase(), 'Sword', 'v')
    const again = { ...v, ...materializeVariant(weaponBase(), 'v', v.variant!.diff) }
    expect(hashAsset(again)).toBe(hashAsset(v))
  })
})

describe('variant chains', () => {
  it('a 3-level chain cascades base-first', () => {
    const base = weaponBase()
    const mid = createVariant(base, 'Sword', 'mid')
    const leaf = createVariant(mid, 'Sword+1', 'leaf')
    const newBase = weaponBase({ damage: 999 })
    const out = cascadeFrom([newBase, mid, leaf], 'tpl-weapon')
    expect(out.map(t => t.id)).toEqual(['mid', 'leaf'])
    expect(out[1].nodeJson.scriptVars.damage).toBe(999)
    expect(out[1].nodeJson.name).toBe('Sword+1')
  })

  it('cuts a cycle instead of looping', () => {
    const a = createVariant(weaponBase(), 'A', 'a')
    const b = createVariant(a, 'B', 'b')
    const cyclic = { ...a, variant: { baseTemplateId: 'b', diff: a.variant!.diff } }
    const warnings: string[] = []
    const out = cascadeFrom([cyclic, b], 'a', m => warnings.push(m))
    expect(out.map(t => t.id)).toEqual(['b'])
    expect(warnings.length).toBe(1)
  })

  it('saving a stale tab does not freeze old base values as overrides', () => {
    const baseAtOpen = weaponBase()
    const v0 = createVariant(baseAtOpen, 'Sword', 'v')
    const edited = editable(v0 as VariantSource)              // the tab, opened before the base changed
    edited.nodeJson.children[0].position = [0, 2, 0]
    const current = weaponBase({ damage: 120 })               // the base was edited meanwhile
    const saved = saveVariant(v0, edited, baseAtOpen, current)
    expect(saved.nodeJson.scriptVars.damage).toBe(120)
    expect(saved.variant!.diff.nodes['']).toEqual({ merge: { name: 'Sword' } })
  })

  it('flattening keeps the content and drops the link', () => {
    const v = createVariant(weaponBase(), 'Sword', 'v')
    const flat = flattenVariant(v)
    expect(flat.variant).toBeUndefined()
    expect(flat.nodeJson).toBe(v.nodeJson)
  })

  it('tells inherited nodes from added ones', () => {
    const base = weaponBase()
    const v = createVariant(base, 'Sword', 'v')
    expect(baseNodeAt(base, v.variant!.diff, 'Mesh')).toBe(base.nodeJson.children[0])
    expect(baseNodeAt(base, v.variant!.diff, 'Move')).toBe('added')
  })
})

describe('reverting a variant to its base', () => {
  /** A Sword variant with a damage change, a recoloured Mesh, a body change and an added Move. */
  function sword() {
    const v0 = createVariant(weaponBase(), 'Sword', 'v')
    const edited = editable(v0 as VariantSource)
    edited.nodeJson.scriptVars.damage = 140
    edited.nodeJson.children[0].model.material.color = [1, 0, 0]
    edited.nodeJson.children.push({ id: 'n', name: 'Move', type: 'node', children: [] })
    edited.bodies = { [edited.nodeJson.id]: { mass: 9 } }
    return saveVariant(v0, edited, weaponBase(), weaponBase())
  }

  it("drops one node's changes, keeping the rest", () => {
    const v = sword()
    expect(hasOwnChanges(v.variant!.diff, 'Mesh')).toBe(true)
    const diff = revertInDiff(v.variant!.diff, 'Mesh')
    expect(hasOwnChanges(diff, 'Mesh')).toBe(false)
    const m = materializeVariant(weaponBase(), 'v', diff)
    expect(m.nodeJson.children[0].model.material.color).toEqual([1, 1, 1])
    expect(m.nodeJson.scriptVars.damage).toBe(140)
    expect(m.nodeJson.children.map((c: any) => c.name)).toContain('Move')
    expect(v.variant!.diff.nodes['Mesh']).toBeDefined()                // the input is untouched
  })

  it('reverting the root drops its values and body but not its name', () => {
    const diff = revertInDiff(sword().variant!.diff, '')
    const m = materializeVariant(weaponBase(), 'v', diff)
    expect(m.nodeJson.name).toBe('Sword')
    expect(Object.values(m.bodies)).toEqual([{ mass: 1 }])
    expect(hasOwnChanges(diff, '')).toBe(false)
  })

  it('reverting everything keeps the name and the structure', () => {
    const diff = revertInDiff(sword().variant!.diff)
    const m = materializeVariant(weaponBase(), 'v', diff)
    expect(m.nodeJson.name).toBe('Sword')
    expect(m.nodeJson.scriptVars.damage).toBe(100)
    expect(m.nodeJson.children[0].model.material.color).toEqual([1, 1, 1])
    expect(m.nodeJson.children.map((c: any) => c.name)).toContain('Move')
    expect(Object.values(m.bodies)).toEqual([{ mass: 1 }])
    for (const p of Object.keys(diff.nodes)) expect(hasOwnChanges(diff, p)).toBe(false)
  })

  it('a name-only root patch is not a change', () => {
    expect(hasOwnChanges(createVariant(weaponBase(), 'Sword', 'v').variant!.diff, '')).toBe(false)
  })
})

describe('a variant from a placed copy', () => {
  it("turns what the copy changed into the variant's own changes", () => {
    const copy = weaponBase({ damage: 175 })
    copy.nodeJson.id = 'placed-root'
    const v = variantFromContent(weaponBase(), copy, 'tpl-new', 'Heavy Sword')
    expect(v.name).toBe('Heavy Sword')
    expect(v.nodeJson.name).toBe('Heavy Sword')
    expect(v.variant!.baseTemplateId).toBe('tpl-weapon')
    expect(v.variant!.diff.nodes['']).toEqual({ merge: { name: 'Heavy Sword', scriptVars: { damage: 175 } } })
    expect(v.nodeJson.id).toBe(derivedNodeId('tpl-new', ''))
  })
})

describe('rebasing a variant', () => {
  it('keeps its content and follows the new base from then on', () => {
    const a = weaponBase()
    const b = { ...weaponBase({ damage: 120, colour: [0, 1, 0] }), id: 'tpl-other', name: 'Other' }
    const v = createVariant(a, 'Sword', 'v')
    const r = rebaseVariant([a, b, v], v, b)!
    expect(r.variant!.baseTemplateId).toBe('tpl-other')
    expect(r.nodeJson.scriptVars.damage).toBe(100)                       // content unchanged...
    expect(r.variant!.diff.nodes['']?.merge).toMatchObject({ scriptVars: { damage: 100 } })  // ...as an override
    expect(r.id).toBe('v')
  })

  it('refuses itself or its own descendants as a base', () => {
    const a = weaponBase()
    const v = createVariant(a, 'Sword', 'v')
    const w = createVariant(v, 'Sword+1', 'w')
    expect(rebaseVariant([a, v, w], v, w)).toBeNull()
    expect(rebaseVariant([a, v, w], v, v)).toBeNull()
  })
})
