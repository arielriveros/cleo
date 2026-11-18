import { describe, it, expect } from 'vitest'
import { Node, Scene } from 'cleo'
import { resyncScene } from '../src/utils/sceneResync'
import { instantiateTemplate, TEMPLATE_ID_VAR, type Template } from '../src/utils/templates'
import { isOverridden, setFieldOverride } from '../src/utils/templateOverrides'
import { buildScriptAsset, SCRIPT_ID_VAR, seedScriptFields } from '../src/utils/scripts'
import { buildGameData } from '../src/features/publish/buildGameData'

// A template's script attributes are edited PER INSTANCE: two diamonds placed from one Diamond template, one
// worth 2. The Behaviors panel writes the node's value and records it as that instance's override; a rebuild
// from the template keeps it, the other instance follows the template, and Play gets each instance's value.

const PICKUP = `import { Node } from 'cleo'
import { attribute } from 'cleo/decorators'
export default class Pickup extends Node {
  @attribute kind: string = 'diamond'
  @attribute amount: number = 1
}`
const pickup = { ...buildScriptAsset('Pickup', 'node', PICKUP, 'script-pickup'), reflect: 2 }

/** A diamond: a root with the pickup script and a gem, or (`onChild`) a holder whose child carries it. */
function diamond(amount = 1, onChild = false): Template {
  const scripted = { [SCRIPT_ID_VAR]: { type: 'string', value: pickup.id, access: 'public' } }
  const gem = { name: 'Gem', nodeType: 'node', id: 't-gem', children: [], ...(onChild ? { variables: scripted, scriptVars: { kind: 'diamond', amount } } : {}) }
  return {
    id: 'tpl-diamond', name: 'Diamond',
    nodeJson: { name: 'Diamond', nodeType: 'node', id: 't-root', children: [gem], ...(onChild ? {} : { variables: scripted, scriptVars: { kind: 'diamond', amount } }) },
    scripts: {},
  }
}

const libs = (templates: Template[]) =>
  ({ materials: [], models: [], templates, terrainMaterials: [], scripts: [pickup], tilesets: [], aiBrains: [] }) as any

function place(scene: Scene, template: Template, scripts: Map<string, string>): Node {
  const node = scene.getNodeById(instantiateTemplate(template, scene.root, { scripts }))!
  for (const n of [node, ...node.children]) if (n.getVariable(SCRIPT_ID_VAR)) seedScriptFields(n, pickup, false)
  return node
}

const scriptedIn = (root: Node) => (root.getVariable(SCRIPT_ID_VAR) ? root : root.children[0]) as any

for (const onChild of [false, true]) {
  describe(`two diamonds, one worth 2 (script on the ${onChild ? 'child' : 'root'})`, () => {
    it('keeps the instance\'s value through a template edit, and ships each instance\'s own', async () => {
      const scene = new Scene()
      try {
        const scripts = new Map<string, string>()
        const a = place(scene, diamond(1, onChild), scripts)
        const b = place(scene, diamond(1, onChild), scripts)
        // What the Behaviors panel does on an instance: set the value, record the override.
        scriptedIn(a).amount = 2
        setFieldOverride(scriptedIn(a), 'amount', 2)
        expect(isOverridden(scriptedIn(a), 'amount')).toBe(true)
        expect(isOverridden(scriptedIn(b), 'amount')).toBe(false)

        // The template's kind changes; its amount stays 1.
        const edited = diamond(1, onChild)
        const holder = onChild ? edited.nodeJson.children[0] : edited.nodeJson
        holder.scriptVars = { kind: 'gem', amount: 1 }
        expect(resyncScene(scene, { scripts }, libs([edited]), undefined)).toBe(true)

        const [x, y] = Array.from(scene.nodes).filter(n => n.getVariable(TEMPLATE_ID_VAR))
        const mine = scriptedIn(x).amount === 2 ? x : y
        const other = mine === x ? y : x
        expect(scriptedIn(mine).amount).toBe(2)
        expect(scriptedIn(mine).kind).toBe('gem')
        expect(scriptedIn(other).amount).toBe(1)
        expect(scriptedIn(other).kind).toBe('gem')

        // Play: each instance carries its own value into the game.
        const json = await buildGameData({ scene, scripts, scriptAssets: [pickup as any] })
        const amounts: number[] = []
        const visit = (n: any) => { if (n.scriptVars?.amount !== undefined) amounts.push(n.scriptVars.amount); (n.children ?? []).forEach(visit) }
        visit(json.scene)
        expect(amounts.sort()).toEqual([1, 2])
      } finally { scene.dispose() }
    })
  })
}
