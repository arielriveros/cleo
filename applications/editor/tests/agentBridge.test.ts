import { describe, expect, it } from 'vitest'
import { LightNode, Node, PointLight, Scene } from 'cleo'
import { NodeRefError, nodePath, resolveNodeRef, userChildren } from '../src/features/agentBridge/nodeRefs'
import { applyProp, elide, outline, settableProps, simpleValue } from '../src/features/agentBridge/inspect'
import { formatLogs, type AgentLogEntry } from '../src/features/agentBridge/agentLogs'

// The agent bridge's pure half: how an agent names nodes, what it is shown of them, and how its property
// writes are checked. The command layer above it needs the live editor; this is what can be pinned here.

function scene() {
  const s = new Scene()
  const player = new Node('Player')
  const model = new Node('Model')
  player.addChild(model)
  const coinA = new Node('Coin')
  const coinB = new Node('Coin')
  const helper = new Node('__editor__gizmo')
  s.root.addChild(player)
  s.root.addChild(coinA)
  s.root.addChild(coinB)
  s.root.addChild(helper)
  return { s, player, model, coinA, coinB, helper }
}

describe('node references', () => {
  it('builds and resolves paths from the scene root', () => {
    const { s, model } = scene()
    expect(nodePath(model, s.root)).toBe('/Player/Model')
    expect(nodePath(s.root, s.root)).toBe('/')
    expect(resolveNodeRef(s, '/Player/Model')).toBe(model)
    expect(resolveNodeRef(s, 'Model')).toBe(model)
    expect(resolveNodeRef(s, `#${model.id}`)).toBe(model)
    expect(resolveNodeRef(s, '/')).toBe(s.root)
  })

  it('hides editor helpers from paths, names and ids', () => {
    const { s, helper } = scene()
    expect(userChildren(s.root).map(n => n.name)).toEqual(['Player', 'Coin', 'Coin'])
    expect(() => resolveNodeRef(s, '__editor__gizmo')).toThrow(NodeRefError)
    expect(() => resolveNodeRef(s, `#${helper.id}`)).toThrow(/No node with id/)
  })

  it('refuses ambiguity and names the candidates by id', () => {
    const { s, coinA, coinB } = scene()
    expect(() => resolveNodeRef(s, 'Coin')).toThrow(new RegExp(`2 nodes are named "Coin".*${coinA.id}.*${coinB.id}`))
    expect(() => resolveNodeRef(s, '/Coin')).toThrow(/ambiguous/)
    expect(resolveNodeRef(s, `#${coinB.id}`)).toBe(coinB)
  })

  it('says what exists when a path misses', () => {
    const { s } = scene()
    expect(() => resolveNodeRef(s, '/Player/Arm')).toThrow(/No child "Arm" under \/Player\. Its children: "Model"/)
    expect(() => resolveNodeRef(s, 'play')).toThrow(/Did you mean: \/Player/)
  })

  it('resolves aliases from the same call only', () => {
    const { s, player } = scene()
    expect(resolveNodeRef(s, '$hero', new Map([['$hero', player]]))).toBe(player)
    expect(() => resolveNodeRef(s, '$hero')).toThrow(/Unknown alias/)
  })

  it('resolves @selected to the editor selection, and says so when there is none', () => {
    const { s, model, helper } = scene()
    expect(resolveNodeRef(s, '@selected', undefined, model.id)).toBe(model)
    expect(resolveNodeRef(s, ' @Selected ', undefined, model.id)).toBe(model)
    expect(() => resolveNodeRef(s, '@selected', undefined, null)).toThrow(/Nothing is selected/)
    expect(() => resolveNodeRef(s, '@selected', undefined, 'not-in-scene')).toThrow(/not in this scene/)
    expect(() => resolveNodeRef(s, '@selected', undefined, helper.id)).toThrow(NodeRefError)
  })
})

// What play_control and logs_read return: a script logging every frame must not flood the agent's context.
describe('log formatting', () => {
  const entry = (seq: number, text: string, level: AgentLogEntry['level'] = 'log', scope = 'Script'): AgentLogEntry =>
    ({ seq, level, scope, time: Date.UTC(2026, 0, 1, 12, 0, 0), text })

  it('collapses a run of identical entries into one line', () => {
    const out = formatLogs([entry(1, 'tick'), entry(2, 'tick'), entry(3, 'tick'), entry(4, 'boom', 'error'), entry(5, 'tick')])
    expect(out.split('\n')).toEqual([
      '1 12:00:00 LOG [Script] tick (x3, last #3)',
      '4 12:00:00 ERROR [Script] boom',
      '5 12:00:00 LOG [Script] tick',
    ])
  })

  it('cuts long lines and keeps the newest lines, saying how to page back', () => {
    expect(formatLogs([entry(1, 'x'.repeat(2000))])).toMatch(/x{600}… \[1400 more chars\]$/)
    const many = Array.from({ length: 50 }, (_, i) => entry(i + 10, `line ${i}`))
    const lines = formatLogs(many, { maxLines: 40 }).split('\n')
    expect(lines).toHaveLength(41)
    expect(lines[0]).toMatch(/^… 10 older lines not shown \(logs_read with since 9/)
    expect(lines.at(-1)).toMatch(/line 49$/)
  })
})

describe('outline', () => {
  it('indents children, flags duplicates with ids and leaves helpers out', () => {
    const { s, coinA } = scene()
    const { text } = outline(s, { root: s.root, depth: 4, limit: 100 })
    const lines = text.split('\n')
    expect(lines[0]).toBe('/ (scene root)')
    expect(lines).toContain('Player [node]')
    expect(lines).toContain('  Model [node]')
    expect(lines).toContain(`Coin [node] #${coinA.id}`)
    expect(text).not.toContain('__editor__')
  })

  it('summarises what lies past the depth limit', () => {
    const { s } = scene()
    expect(outline(s, { root: s.root, depth: 1, limit: 100 }).text).toContain('Player [node] (+1 below)')
  })

  it('searches by type or name as flat paths', () => {
    const { s } = scene()
    const { text, total } = outline(s, { root: s.root, depth: 4, limit: 100, name: 'mod' })
    expect(total).toBe(1)
    expect(text).toMatch(/^1 match:\n\/Player\/Model \[node\] #/)
  })
})

describe('properties', () => {
  it('lists settable props, including one level into a light', () => {
    const light = new LightNode('Lamp', new PointLight({ intensity: 800 } as any))
    const props = settableProps(light)
    expect(props['light.intensity']).toBe(800)
    expect(props).not.toHaveProperty('position') // transform has its own fields
    expect(Object.keys(props).some(k => k.startsWith('_'))).toBe(false)
  })

  it('assigns through dotted paths and keeps value kinds', () => {
    const light = new LightNode('Lamp', new PointLight({ intensity: 800 } as any))
    applyProp(light, 'light.intensity', 1200)
    expect(light.light.intensity).toBe(1200)
    expect(() => applyProp(light, 'light.intensity', 'bright')).toThrow(/is a number/)
    expect(() => applyProp(light, 'light.wattage', 60)).toThrow(/not a property/)
    expect(() => applyProp(light, '_internal', 1)).toThrow(/internal/)
  })

  it('validates without assigning on a dry run', () => {
    const light = new LightNode('Lamp', new PointLight({ intensity: 800 } as any))
    applyProp(light, 'light.intensity', 5, true)
    expect(light.light.intensity).toBe(800)
    expect(() => applyProp(light, 'light.intensity', 'x', true)).toThrow(/is a number/)
  })

  it('reduces values and serialized payloads to something readable', () => {
    expect(simpleValue(0.1 + 0.2)).toBe(0.3)
    expect(simpleValue(new Float32Array([1, 2, 3]))).toEqual([1, 2, 3])
    expect(simpleValue(new Float32Array(100))).toBeUndefined()
    expect(elide({ positions: new Float32Array(3000), img: 'data:image/png;base64,' + 'A'.repeat(4096) }))
      .toEqual({ positions: '<Float32Array x3000>', img: '<data URL, 4 KB>' })
  })
})
