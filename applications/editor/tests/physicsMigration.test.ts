import { describe, it, expect } from 'vitest'
import { migrateScenePhysics, migrateTemplatePhysics } from '../src/utils/physicsMigration'
import { TEMPLATE_ID_VAR, type Template } from '../src/utils/templates'
import { OVERRIDES_VAR } from '../src/utils/templateOverrides'
import { createVariant, jsonPathMap } from '../src/utils/templateVariants'

// Physics saved before colliders and triggers were nodes, loaded into the editor: the engine converts a
// node's JSON (a body becomes a Collider around it, a trigger a Trigger child), and the editor carries the
// two things only it knows about across -- a template's id-keyed body/trigger maps, and a placed template
// instance's mark and overrides.

const IDENTITY = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
const box = { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }

/** A Goblin template: a character root with a body and a script field, and a plain Sword child with a trigger. */
function goblin(): Template {
  return {
    id: 'tpl-goblin', name: 'Goblin',
    nodeJson: {
      id: 'g-root', name: 'Goblin', type: 'character', ...IDENTITY, scriptVars: { hp: 10 },
      children: [{ id: 'g-sword', name: 'Sword', type: 'node', ...IDENTITY, children: [] }],
    },
    scripts: { 'g-root': 'class source' },
    bodies: { 'g-root': { mass: 80, shapes: [box] } },
    triggers: { 'g-sword': { shapes: [box], detectTriggers: true } },
  }
}

describe('migrateScenePhysics', () => {
  it('leaves a scene without old physics as it is', () => {
    const scene = { id: 'root', name: 'root', type: 'node', children: [{ id: 'a', name: 'A', type: 'node', children: [] }] }
    expect(migrateScenePhysics(scene)).toBe(scene)
  })

  it('wraps a bodied node in a Collider and gives a triggered one a Trigger child, deep in the tree', () => {
    const scene = {
      id: 'root', name: 'root', type: 'node', children: [{
        id: 'room', name: 'Room', type: 'node', ...IDENTITY, children: [{
          id: 'crate', name: 'Crate', type: 'model', position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1],
          body: { mass: 2, shapes: [box] }, trigger: { shapes: [box] },
          children: [{ id: 'lid', name: 'Lid', type: 'node', ...IDENTITY, children: [] }],
        }],
      }],
    }
    const out = migrateScenePhysics(scene)
    const collider = out.children[0].children[0]
    expect(collider).toMatchObject({ type: 'collider', name: 'Crate Collider', id: 'crate:collider', position: [1, 2, 3] })
    expect(collider.collider.mass).toBe(2)
    const crate = collider.children[0]
    expect(crate).toMatchObject({ id: 'crate', name: 'Crate', position: [0, 0, 0] })
    expect(crate.body).toBeUndefined()
    // Its own children first, then the Trigger.
    expect(crate.children.map((c: any) => c.name)).toEqual(['Lid', 'Crate Trigger'])
    expect(crate.children[1].type).toBe('trigger')
  })

  it('turns a plain node into the Collider or Trigger itself, keeping its id, name and script', () => {
    const scene = {
      id: 'root', name: 'root', type: 'node', children: [
        { id: 'gate', name: 'Gate', type: 'node', ...IDENTITY, variables: { __scriptId: { type: 'string', value: 's-gate' } },
          body: { mass: 0, shapes: [box] }, trigger: { shapes: [box] },
          children: [{ id: 'mesh', name: 'Mesh', type: 'model', ...IDENTITY, children: [] }] },
        { id: 'zone', name: 'Zone', type: 'node', ...IDENTITY, trigger: { shapes: [box] }, children: [] },
      ],
    }
    const [gate, zone] = migrateScenePhysics(scene).children
    expect(gate).toMatchObject({ id: 'gate', name: 'Gate', type: 'collider', collider: { mass: 0 } })
    expect(gate.variables.__scriptId.value).toBe('s-gate')
    expect(gate.children.map((c: any) => `${c.name} [${c.type}]`)).toEqual(['Mesh [model]', 'Gate Trigger [trigger]'])
    expect(zone).toMatchObject({ id: 'zone', name: 'Zone', type: 'trigger' })
  })

  it("moves a placed instance's mark and overrides up to the Collider that wraps its root", () => {
    const templates = migrateTemplatePhysics([goblin()])!
    const overrides = { '': { name: 'Goblin 2', fields: { hp: 12 } }, Sword: { fields: { reach: 2 } } }
    const scene = {
      id: 'root', name: 'root', type: 'node', children: [{
        id: 'inst', name: 'Goblin 2', type: 'character', position: [5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        variables: {
          [TEMPLATE_ID_VAR]: { type: 'string', value: 'tpl-goblin' },
          [OVERRIDES_VAR]: { type: 'string', value: JSON.stringify(overrides), access: 'private' },
          keep: { type: 'number', value: 1 },
        },
        body: { mass: 80, shapes: [box] },
        children: [{ id: 'inst-sword', name: 'Sword', type: 'node', ...IDENTITY, trigger: { shapes: [box] }, children: [] }],
      }],
    }
    const collider = migrateScenePhysics(scene, templates).children[0]
    expect(collider.type).toBe('collider')
    expect(collider.position).toEqual([5, 0, 0])
    expect(collider.variables[TEMPLATE_ID_VAR].value).toBe('tpl-goblin')
    const inner = collider.children[0]
    expect(inner.variables[TEMPLATE_ID_VAR]).toBeUndefined()
    expect(inner.variables.keep.value).toBe(1)
    // Named as its template names it, as a rebuild from the template would.
    expect(inner.name).toBe('Goblin')
    // The root's fields follow its node, under the name the template gives it; the Collider takes the instance's name.
    expect(JSON.parse(collider.variables[OVERRIDES_VAR].value)).toEqual({
      '': { name: 'Goblin 2 Collider' },
      Goblin: { fields: { hp: 12 } },
      'Goblin/Sword': { fields: { reach: 2 } },
    })
  })
})

describe('migrateTemplatePhysics', () => {
  it('is null when nothing needs converting', () => {
    const t = goblin()
    t.bodies = {}; t.triggers = {}
    expect(migrateTemplatePhysics([t])).toBeNull()
  })

  it("folds a template's body and trigger maps into Collider and Trigger nodes", () => {
    const [t] = migrateTemplatePhysics([goblin()])!
    expect(t.bodies).toBeUndefined()
    expect(t.triggers).toBeUndefined()
    expect(t.nodeJson).toMatchObject({ type: 'collider', name: 'Goblin Collider', collider: { mass: 80 } })
    const root = t.nodeJson.children[0]
    expect(root).toMatchObject({ id: 'g-root', name: 'Goblin', scriptVars: { hp: 10 } })
    // A plain node with only a trigger IS the Trigger now: same name and id.
    expect(root.children[0]).toMatchObject({ type: 'trigger', name: 'Sword', id: 'g-sword', sensor: { detectTriggers: true } })
    // Inline scripts stay keyed by the node they were on, which kept its id.
    expect(t.scripts['g-root']).toBe('class source')
  })

  it("re-bases a variant on its converted base, its body change a patch of the base's Collider", () => {
    const base = goblin()
    const variant = createVariant(base as any, 'Goblin Brute', 'tpl-brute') as Template
    // A legacy variant: its own heavier body, in the maps beside its materialized tree.
    variant.bodies = { [variant.nodeJson.id]: { mass: 200, shapes: [box] } }
    const sword = variant.nodeJson.children[0]
    variant.triggers = { [sword.id]: { shapes: [box], detectTriggers: true } }
    variant.variant!.diff = { ...variant.variant!.diff, version: 1, bodies: { '': { mass: 200, shapes: [box] } }, triggers: {} }

    const out = migrateTemplatePhysics([base, variant])!
    const brute = out.find(t => t.id === 'tpl-brute')!
    const diff = brute.variant!.diff
    expect(diff.version).toBe(2)
    expect(diff.bodies).toBeUndefined()
    // The wrapped node keeps the base's name under the Collider, so it and its Sword stay inherited.
    expect(diff.removed).toEqual([])
    expect(diff.added).toEqual([])
    expect(diff.nodes['']).toEqual({ merge: { name: 'Goblin Brute Collider', collider: { mass: 200 } } })
    const map = jsonPathMap(brute.nodeJson)
    expect(map.get('')!.node.collider.mass).toBe(200)
    expect(map.get('Goblin/Sword')!.node.type).toBe('trigger')
  })
})
