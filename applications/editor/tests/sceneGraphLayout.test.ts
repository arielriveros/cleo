import { describe, expect, it } from 'vitest'
import {
  CARD_H, CARD_W, STACK_INDENT, filterSceneTree, layoutSceneGraph, nameMatches, nearestInDirection, zoneAt,
  type GraphCard, type NodeDescription,
} from '../src/features/sceneInspector/sceneGraphLayout'

// The Scene panel's Graph view: the filter both views share, and the top-down layout with stacked leaves.

const n = (id: string, children: NodeDescription[] = [], name = id): NodeDescription =>
  ({ id, name, type: 'node', visible: true, spawnOnStart: true, children })

const ids = (d: NodeDescription | null): unknown =>
  d && (d.children.length ? { [d.id]: d.children.map(ids) } : d.id)

const overlaps = (a: GraphCard, b: GraphCard) =>
  a.x < b.x + CARD_W && b.x < a.x + CARD_W && a.y < b.y + CARD_H && b.y < a.y + CARD_H

describe('filterSceneTree (the tree view\'s searchMatch)', () => {
  const scene = n('root', [
    n('player', [n('mesh'), n('sword')]),
    n('lights', [n('sun'), n('fill')]),
    n('camera'),
  ])

  it('keeps each match and its ancestors, drops everything else', () => {
    expect(ids(filterSceneTree(scene, 'sun'))).toEqual({ root: [{ lights: ['sun'] }] })
  })

  it("drops a match's children unless they match too", () => {
    expect(ids(filterSceneTree(scene, 'player'))).toEqual({ root: ['player'] })
  })

  it('returns the tree itself for an empty term and null when nothing matches', () => {
    expect(filterSceneTree(scene, '   ')).toBe(scene)
    expect(filterSceneTree(scene, 'zzz')).toBeNull()
  })

  it('is case-blind and trims the term', () => {
    expect(nameMatches('SwordHand', '  sword ')).toBe(true)
    expect(ids(filterSceneTree(scene, ' MESH '))).toEqual({ root: [{ player: ['mesh'] }] })
  })
})

describe('layoutSceneGraph', () => {
  const scene = n('root', [
    n('camera'), n('sun'), n('fog'),
    n('player', [n('mesh'), n('sword')]),
    n('lights', [n('key'), n('fill'), n('rim')]),
    n('ground'),
  ])
  const layout = layoutSceneGraph(scene, new Set())
  const at = (id: string) => layout.byId.get(id)!

  it('lays out every node exactly once, without overlaps', () => {
    expect(layout.cards.map(c => c.id).sort()).toEqual(
      ['camera', 'fill', 'fog', 'ground', 'key', 'lights', 'mesh', 'player', 'rim', 'root', 'sun', 'sword'])
    for (const a of layout.cards) for (const b of layout.cards) if (a !== b) expect(overlaps(a, b), `${a.id} / ${b.id}`).toBe(false)
  })

  it('stacks a run of childless siblings into one column under its parent, with left-side edges', () => {
    for (const id of ['camera', 'sun', 'fog']) {
      expect(at(id).stacked).toBe(true)
      expect(at(id).x).toBe(at('camera').x)
      expect(layout.links.find(l => l.target === id)?.targetHandle).toBe('left')
    }
    expect(at('sun').y).toBeGreaterThan(at('camera').y)
    expect(at('fog').y).toBeGreaterThan(at('sun').y)
    // A lone leaf after the subtrees is a run of its own.
    expect(at('ground').stacked).toBe(true)
    expect(at('ground').y).toBe(at('camera').y)
  })

  it('spreads children that have children of their own side by side, with top edges', () => {
    expect(at('player').stacked).toBe(false)
    expect(layout.links.find(l => l.target === 'player')?.targetHandle).toBe('top')
    expect(at('player').y).toBe(at('camera').y)
  })

  it('keeps sibling order left to right, then top to bottom', () => {
    const order = ['camera', 'player', 'lights', 'ground'].map(id => at(id).x)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(at('mesh').y).toBeLessThan(at('sword').y)
  })

  it('centres a parent over its columns', () => {
    const kids = scene.children.map(c => at(c.id))
    const left = Math.min(...kids.map(c => c.x - (c.stacked ? STACK_INDENT : 0)))
    const right = Math.max(...kids.map(c => c.x + CARD_W))
    expect(at('root').x + CARD_W / 2).toBeCloseTo((left + right) / 2)
    expect(at('player').x + CARD_W / 2).toBeCloseTo(at('mesh').x - STACK_INDENT + (STACK_INDENT + CARD_W) / 2)
  })

  it('lays out nothing under a collapsed node and counts what it hides', () => {
    const deep = n('root', [n('a', [n('b', [n('c'), n('d')])])])
    const closed = layoutSceneGraph(deep, new Set(['a']))
    expect(closed.cards.map(c => c.id)).toEqual(['root', 'a'])
    expect(closed.byId.get('a')).toMatchObject({ collapsed: true, hasChildren: true, hiddenCount: 3 })
    // A collapsed node counts as childless, so it stacks with its siblings.
    expect(closed.byId.get('a')!.stacked).toBe(true)
    expect(closed.links).toEqual([{ id: 'root->a', source: 'root', target: 'a', targetHandle: 'left' }])
  })

  it('records each card\'s parent for drop checks', () => {
    expect(layout.parentOf.get('sword')).toBe('player')
    expect(layout.parentOf.get('player')).toBe('root')
    expect(layout.parentOf.has('root')).toBe(false)
  })
})

describe('graph navigation and drop zones', () => {
  const layout = layoutSceneGraph(n('root', [n('a', [n('a1'), n('a2')]), n('b', [n('b1')])]), new Set())

  it('moves to the nearest card in the arrow\'s direction', () => {
    expect(nearestInDirection(layout.cards, 'root', 'down')).toMatch(/^[ab]$/)
    expect(nearestInDirection(layout.cards, 'a1', 'down')).toBe('a2')
    expect(nearestInDirection(layout.cards, 'a', 'right')).toBe('b')
    expect(nearestInDirection(layout.cards, 'a', 'up')).toBe('root')
    expect(nearestInDirection(layout.cards, 'root', 'up')).toBeNull()
  })

  it('splits a card into before / inside / after along its siblings\' axis', () => {
    expect(zoneAt(0.1)).toBe('before')
    expect(zoneAt(0.5)).toBe('inside')
    expect(zoneAt(0.9)).toBe('after')
  })
})
