import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Node, declarationOf, writeProperty } from 'cleo'

/**
 * Selecting a node must not mark its tab unsaved.
 *
 * The Transform section used to push its local state back into the node from a `useEffect` on
 * `[position, rotation, scale]`. That effect runs on mount and after every selection change, and every
 * transform setter emits a `transform` change once the engine is in authoring mode. So each click in the tree
 * dirtied the tab and round-tripped the node's rotation through Euler angles. Its rows are generated from the
 * Transform declaration now (src/properties/transform.ts): drawing them reads the node, and only an edit writes
 * it, through the setters.
 */

vi.mock('@cleo/app-kit/docs/DocScope', async (original) => ({ ...(await original<any>()), useDocEntry: () => null }))
vi.mock('../src/features/EngineContext', () => ({
  useCleoEngine: () => ({
    eventEmitter: { on() {}, off() {}, emit() {} },
    editorScene: null, rigs: [], animations: [], templates: [], animControllers: [],
    inputMap: { maps: [] }, sceneList: [], projectSettings: { collisionLayers: [] }, scriptAssetOf: () => undefined, scriptAssets: [],
  }),
}))

const { default: DeclaredSections } = await import('../src/features/properties/DeclaredSections')

const SOURCE = readFileSync(join(__dirname, '../src/features/nodeInspector/propertyEditors/TransformEditor.tsx'), 'utf8')

/** The body text of every `useEffect(() => { ... }` in the file, brace-matched. */
function effectBodies(src: string): string[] {
  const bodies: string[] = []
  let at = 0
  while ((at = src.indexOf('useEffect(', at)) >= 0) {
    const open = src.indexOf('{', at)
    let depth = 0, i = open
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) break
    }
    bodies.push(src.slice(open, i + 1))
    at = i
  }
  return bodies
}

const SETTERS = ['setPosition', 'setRotation', 'setScale', 'setQuaternion'] as const

describe('TransformEditor', () => {
  it('never writes the node from an effect', () => {
    for (const body of effectBodies(SOURCE)) expect(body).not.toMatch(/\.set(Position|Rotation|Scale|Quaternion)\(/)
  })

  it('draws the node without writing it', () => {
    const node = new Node('probe')
    node.setPosition([1, 2, 3])
    const spies = SETTERS.map(name => vi.spyOn(node, name))
    const html = renderToStaticMarkup(createElement(DeclaredSections, { node, of: Node }))
    expect(html).toContain('Position')
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('writes the node through its setters when a row is edited', () => {
    const node = new Node('probe')
    const transform = declarationOf(node, Node)!
    const row = (key: string) => transform.sections.flatMap(s => s.props).find(p => p.key === key)!
    const spies = Object.fromEntries(SETTERS.map(name => [name, vi.spyOn(node, name)]))
    writeProperty(node, row('position'), [1, 2, 3])
    writeProperty(node, row('rotation'), [0, 90, 0])
    writeProperty(node, row('scale'), [2, 2, 2])
    expect(spies.setPosition).toHaveBeenCalledOnce()
    expect(spies.setRotation).toHaveBeenCalledOnce()
    expect(spies.setScale).toHaveBeenCalledOnce()
    expect(Array.from(node.position)).toEqual([1, 2, 3])
    expect(Array.from(node.scale)).toEqual([2, 2, 2])
  })
})
