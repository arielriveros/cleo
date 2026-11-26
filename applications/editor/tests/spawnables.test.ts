import { describe, expect, it } from 'vitest'
import { Node, Scene } from 'cleo'
import { spawnableSubtrees, unplacedTemplates } from '../src/features/publish/spawnables'
import type { Template } from '../src/utils/templates'

// What a scene can spawn, for its shader step: the library's templates it does not place, baked as Play bakes them
// (scripts injected, so they can be compiled ahead), with no back-link to the library.

const template = (id: string, name: string, extra: Record<string, unknown> = {}): Template => ({
  id, name, scripts: {},
  nodeJson: { id: `${id}-root`, name, type: 'node', children: [], variables: { __templateId: { type: 'string', value: id } }, ...extra },
})

describe('what a scene can spawn', () => {
  it('is every template the scene does not place', () => {
    const scene = new Scene()
    const placed = new Node('Player')
    placed.setVariable('__templateId', 'player')
    scene.addNode(placed)
    const library = [template('player', 'Player'), template('flash', 'Muzzle Flash'), template('hole', 'Bullet Hole')]
    expect(unplacedTemplates(library, scene).map(t => t.id)).toEqual(['flash', 'hole'])
    expect(unplacedTemplates(library, null).length).toBe(3)
  })

  it('bakes each as Play does: its scripts in, its link to the library out', () => {
    const t = template('flash', 'Muzzle Flash')
    t.scripts = { 'flash-root': 'export default class {}' }
    const [node] = spawnableSubtrees([t]) as any[]
    expect(node.script).toBe('export default class {}')
    expect(node.variables?.__templateId).toBeUndefined()
    // The library's copy is untouched.
    expect((t.nodeJson as any).variables.__templateId).toBeDefined()
  })
})
