import { describe, it, expect } from 'vitest'
import type { AnimationStateMachine } from 'cleo'
import {
  addedPoint, clearView, insertPoint, movedPoint, pointsOf, pruneReroutes, removedPoint, renameInReroutes, rerouteKey,
  routedPath, toggledPoint, withPoints,
} from '../src/features/animation/reroutes'
import { layerView, writeLayer } from '../src/features/animation/stateGroups'
import { tidyLayout } from '../src/features/animation/tidyLayout'

// Reroute points on the animator graph (a Blueprint's reroute nodes): kept on each layer by the line they route, kept
// through renames, dropped with their line; and Tidy, the layered layout.

const state = (name: string, x = 0, y = 0) => ({ name, clipName: '', speed: 1, loop: true, x, y } as any)
const edge = (from: string, to: string) => ({ from, to, conditions: [] } as any)
const machine = (extra: Partial<AnimationStateMachine> = {}): AnimationStateMachine => ({
  parameters: [], events: [],
  states: [state('Idle', 0, 0), state('Walk', 300, 0), state('Run', 600, 0), state('Jump', 300, 200)],
  transitions: [edge('Idle', 'Walk'), edge('Walk', 'Idle'), edge('Walk', 'Run'), edge('Idle', 'Jump')],
  ...extra,
})

describe('reroute points', () => {
  it('are kept by view and line, and removed with their last point', () => {
    let sm = machine()
    const key = rerouteKey(null, 'Idle|Walk')
    expect(key).toBe('::Idle|Walk')
    sm = withPoints(sm, key, [{ x: 150.4, y: -80.6 }, { x: 200, y: -80, axis: 'v' }])
    expect(pointsOf(sm, null, 'Idle|Walk')).toEqual([{ x: 150, y: -81 }, { x: 200, y: -80, axis: 'v' }])
    // Another view's line of the same pair has its own.
    expect(pointsOf(sm, 'Locomotion', 'Idle|Walk')).toEqual([])
    sm = withPoints(sm, key, null)
    expect((sm as any).reroutes).toBeUndefined()
  })

  it('goes where the line was clicked, on its nearest stretch, across or down as that stretch runs', () => {
    const start = { x: 0, y: 0 }, end = { x: 400, y: 0 }
    const points = [{ x: 200, y: 200 }]
    // Near the first stretch (start to the point): first.
    expect(insertPoint(points, start, end, { x: 90, y: 110 })).toEqual({ index: 0, point: { x: 90, y: 110 } })
    // Near the second (the point to the end): after it. That stretch runs more across than down.
    expect(insertPoint(points, start, end, { x: 310, y: 95 }).index).toBe(1)
    // A stretch running down gives a point the line passes top to bottom.
    expect(insertPoint([], { x: 0, y: 0 }, { x: 10, y: 300 }, { x: 5, y: 150 }).point.axis).toBe('v')
  })

  it('moves, turns and goes one at a time', () => {
    const p = [{ x: 1, y: 1 }, { x: 2, y: 2, axis: 'v' as const }]
    expect(addedPoint(p, 1, { x: 9, y: 9 }).map(q => q.x)).toEqual([1, 9, 2])
    expect(movedPoint(p, 0, 5.6, 6.2)[0]).toEqual({ x: 6, y: 6 })
    expect(toggledPoint(p, 0)[0].axis).toBe('v')
    expect(toggledPoint(p, 1)[1].axis).toBeUndefined()
    expect(removedPoint(p, 0)).toEqual([{ x: 2, y: 2, axis: 'v' }])
  })

  it('follow a rename into their line keys and their view, re-sorting a plain pair', () => {
    let sm = withPoints(machine(), '::Idle|Walk', [{ x: 1, y: 1 }])
    sm = withPoints(sm, 'Idle::Idle>Run', [{ x: 2, y: 2 }])
    sm = renameInReroutes(sm, 'Idle', 'Stand')
    expect(Object.keys((sm as any).reroutes).sort()).toEqual(['::Stand|Walk', 'Stand::Stand>Run'])
    // 'Zed' sorts after 'Walk': the pair's key is written the way the plan writes it.
    sm = renameInReroutes(sm, 'Stand', 'Zed')
    expect(Object.keys((sm as any).reroutes)).toContain('::Walk|Zed')
  })

  it('go with their line: a transition removed takes its line\'s points, a line still drawn keeps them', () => {
    let sm = withPoints(machine(), '::Idle|Jump', [{ x: 1, y: 1 }])
    sm = withPoints(sm, '::Run|Walk', [{ x: 2, y: 2 }])
    expect(Object.keys((pruneReroutes(sm) as any).reroutes).sort()).toEqual(['::Idle|Jump', '::Run|Walk'])
    sm = { ...sm, transitions: sm.transitions.filter(t => t.to !== 'Jump') }
    expect(Object.keys((pruneReroutes(sm) as any).reroutes)).toEqual(['::Run|Walk'])
    // Tidy clears one view's.
    expect((clearView(sm, null) as any).reroutes).toBeUndefined()
  })

  it('are a layer\'s own, through its view and back', () => {
    const layer = { name: 'Upper', states: [state('A'), state('B')], transitions: [edge('A', 'B')] } as any
    let sm = machine({ layers: [layer] })
    let view = layerView(sm, 1)
    view = withPoints(view, '::A|B', [{ x: 3, y: 4 }])
    sm = writeLayer(sm, 1, view)
    expect((sm.layers![0] as any).reroutes).toEqual({ '::A|B': [{ x: 3, y: 4 }] })
    expect((sm as any).reroutes).toBeUndefined()
    expect(pointsOf(layerView(sm, 1), null, 'A|B')).toHaveLength(1)
    // Emptied, the layer carries none.
    sm = writeLayer(sm, 1, withPoints(layerView(sm, 1), '::A|B', null))
    expect('reroutes' in sm.layers![0]).toBe(false)
  })

  it('draw the line through each point, left to right or top to bottom', () => {
    const across = routedPath({ x: 0, y: 0 }, { x: 1, y: 0 }, [{ x: 100, y: 100 }], { x: 200, y: 0 }, { x: 1, y: 0 })
    // Two cubics, the point the end of the first; its control points level with it (passes left to right).
    expect(across.path).toMatch(/^M0,0 C[\d.,\- ]+ 100,100 C/)
    const [, c2] = across.path.split(' C')[1].split(' ')
    expect(Number(c2.split(',')[1])).toBe(100)
    const down = routedPath({ x: 0, y: 0 }, { x: 1, y: 0 }, [{ x: 100, y: 100, axis: 'v' }], { x: 200, y: 200 }, { x: 1, y: 0 })
    const [, d2] = down.path.split(' C')[1].split(' ')
    // Top to bottom: the control point straight above it, on its x.
    expect(Number(d2.split(',')[0])).toBe(100)
    // No points: one cubic, the label half way.
    const plain = routedPath({ x: 0, y: 0 }, { x: 1, y: 0 }, [], { x: 100, y: 0 }, { x: 1, y: 0 })
    expect(plain.path.match(/ C/g)).toHaveLength(1)
    expect(plain.labelX).toBeCloseTo(50)
  })
})

describe('Tidy', () => {
  const nodes = ['Idle', 'Walk', 'Run', 'Jump', 'Land'].map(id => ({ id, w: 156, h: 52 }))
  const edges = [
    { from: 'Idle', to: 'Walk' }, { from: 'Walk', to: 'Idle' }, { from: 'Walk', to: 'Run' }, { from: 'Run', to: 'Walk' },
    { from: 'Idle', to: 'Jump' }, { from: 'Run', to: 'Jump' }, { from: 'Jump', to: 'Land' }, { from: 'Land', to: 'Idle' },
  ]

  it('lays the graph out in columns by the fewest lines from the entry, the way they run', () => {
    const pos = tidyLayout(nodes, edges, { roots: ['Idle'] })
    const col = (id: string) => pos[id].x
    // Idle first; Walk and Jump one line on; Run and Land two (a loop back to Idle does not pull Idle right).
    expect(col('Idle')).toBeLessThan(col('Walk'))
    expect(col('Walk')).toBe(col('Jump'))
    expect(col('Walk')).toBeLessThan(col('Run'))
    expect(col('Run')).toBe(col('Land'))
  })

  it('never overlaps two nodes, and lays the same graph out the same way', () => {
    const pos = tidyLayout(nodes, edges, { roots: ['Idle'] })
    const boxes = nodes.map(n => ({ ...pos[n.id], w: n.w, h: n.h }))
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
      expect(apart, `${nodes[i].id} / ${nodes[j].id}`).toBe(true)
    }
    expect(tidyLayout(nodes, edges, { roots: ['Idle'] })).toEqual(pos)
    for (const p of Object.values(pos)) { expect(Number.isInteger(p.x)).toBe(true); expect(Number.isInteger(p.y)).toBe(true) }
  })
})
