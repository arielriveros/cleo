import { describe, it, expect } from 'vitest'
import { Scene, Node } from 'cleo'
import { buildScriptAsset, parseScriptVariables, saveFieldNames, type ScriptAsset } from '../src/utils/scripts'
import { buildScriptGraphCtx } from '../src/utils/scriptGraph'
import { injectSaveFields } from '../src/features/publish/buildGameData'
import { reinstantiate } from '../src/utils/sceneResync'
import { prepareNodeTypeChange } from '../src/utils/nodeTypeConversion'

// The editor half of saving: a script tags the fields a save keeps with `@save`, and the runtime builds list
// them per node as `saveFields`, because a published game ships no script schema at all. A field the build
// misses is a value a player's save silently loses.

const fields = (src: string) => saveFieldNames(parseScriptVariables(src))

describe('the @save tag', () => {
  it('marks the field it documents, and only that one', () => {
    expect(fields(`export default class P extends Node {
      /** @save */
      public souls: number = 0
      public speed: number = 4
      /** How many flasks are left. @save */
      public estus = 3
    }`)).toEqual(['souls', 'estus'])
  })

  it('works on the field’s own line, beside another tag, and on internal fields', () => {
    const src = `export default class P extends Node {
      /** @save */ public level = 1
      /** @save */ public lastClip: ClipName = 'Idle'
      /** @save */ private _respawn: number[] = [0, 0, 0]
      /** @save */ public opened: string[] = []
      /** @saved is not the tag */ public other = 2
    }`
    const vars = parseScriptVariables(src)
    expect(saveFieldNames(vars)).toEqual(['level', 'lastClip', '_respawn', 'opened'])
    expect(vars.find(v => v.name === 'lastClip')).toMatchObject({ type: { kind: 'name', name: 'clip' }, save: true })
    expect(vars.find(v => v.name === '_respawn')).toMatchObject({ hidden: true, save: true })
    expect(vars.find(v => v.name === 'other')?.save).toBeUndefined()
  })

  it('leaves a field without it alone, as before', () => {
    expect(fields(`export default class P extends Node { public hp = 100 }`)).toEqual([])
    expect(parseScriptVariables(`export default class P extends Node { public hp = 100 }`)[0]).not.toHaveProperty('save')
  })
})

describe('the build lists each node’s @save fields', () => {
  const BASE = `import { Node } from 'cleo'
export default class Base extends Node {
  /** @save */
  public souls: number = 0
}`
  const DERIVED = `import Base from './Base'
export default class Derived extends Base {
  /** @save */
  public level: number = 1
  public speed: number = 2
}`

  it('from the script the node runs, inherited fields included', () => {
    const assets: ScriptAsset[] = [buildScriptAsset('Base', 'node', BASE, 'base'), buildScriptAsset('Derived', 'node', DERIVED, 'derived')]
    const ctx = buildScriptGraphCtx(new Map([['base', '/Base.script'], ['derived', '/Derived.script']]), assets)
    const tree: any = {
      id: 'root', name: 'root', children: [
        { id: 'p', name: 'Player', script: DERIVED, scriptPath: '/Derived', children: [] },
        { id: 'q', name: 'Plain', script: `export default class Q extends Node { public x = 1 }`, children: [] },
        { id: 'r', name: 'Bare', children: [], saveFields: ['stale'] },
      ],
    }
    injectSaveFields(tree, ctx)
    expect(tree.children[0].saveFields).toEqual(['souls', 'level'])
    expect(tree.children[1].saveFields).toBeUndefined()
    // No script: whatever an older build left is not touched (nothing to read it from).
    expect(tree.children[2].saveFields).toEqual(['stale'])
  })

  it('without the script graph, from the node’s own source', () => {
    const tree: any = { id: 'root', name: 'root', children: [{ id: 'p', name: 'P', script: DERIVED, children: [] }] }
    injectSaveFields(tree)
    expect(tree.children[0].saveFields).toEqual(['level'])
  })
})

describe('Saved survives the editor’s rebuilds of a placement', () => {
  it('is kept when a copy is rebuilt from its asset', () => {
    const scene = new Scene()
    const old = new Node('Lever')
    old.saved = true
    scene.root.addChild(old)
    const rebuilt = reinstantiate(scene, old, { scripts: new Map() }, parent => {
      const n = new Node('Lever')
      parent.addChild(n)
      return n.id
    })
    expect(rebuilt?.saved).toBe(true)
  })

  it('is one of the keys a node type change keeps', async () => {
    const node = new Node('Crate')
    node.saved = true
    const prepared = await prepareNodeTypeChange(node, 'light', null)
    expect(prepared?.after.saved).toBe(true)
  })
})
