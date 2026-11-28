import { describe, it, expect } from 'vitest'
import type { AnimationStateMachine } from 'cleo'
import { graphPlan } from '@editor/features/animation/stateGroups'
import { dataReady, readThisExample } from '@tools/exampleKit/testKit'

// The animator editor's state groups (applications/editor/src/features/animation/stateGroups.ts; the rest of its
// tests are in applications/editor/tests/stateGroups.test.ts) on the Sandbox's own animator: what the graph draws.

describe.skipIf(!dataReady())('state groups on the Sandbox animator', () => {
  it('shows the Sandbox animator as a few states and its groups, every transition somewhere', async () => {
    const { bundle } = await readThisExample()
    const scene = bundle.scenes[bundle.manifest.mainSceneId].scene
    const find = (n: any): any => n.name === 'Mannequin' ? n : (n.children ?? []).map(find).find(Boolean)
    const sm: AnimationStateMachine = find(scene).stateMachine
    const top = graphPlan(sm, null)
    // Standing and Moving fold each stance's idle and locomotion (unarmed, pistol, rifle) into one box.
    expect(top.states.sort()).toEqual(['Stairs', 'Start'])
    expect(top.groups.map(g => g.name)).toEqual(['Turning', 'Stopping', 'Running Turn', 'Air', 'Landing', 'Car', 'Crouching', 'Standing', 'Moving', 'Down'])
    // Its forks are its groups': each drawn inside its group, the group standing for it outside.
    expect(top.forks).toEqual([])
    for (const f of ['Pick Turn', 'Pick Stop', 'Settle', 'Pick Run Turn', 'Take Off']) expect(top.groups.flatMap(g => g.forks)).toContain(f)
    expect(top.groups.flatMap(g => g.forks)).toContain('Pick Idle')
    const drawn = new Set(top.links.flatMap(l => [...l.forward, ...l.backward]))
    const memberOf = new Map(sm.groups!.flatMap(g => g.states.map(s => [s, g.name] as const)))
    for (const t of sm.transitions) {
      const inside = (memberOf.get(t.from) ?? t.from) === (memberOf.get(t.to) ?? t.to)
      if (inside) {
        const g = memberOf.get(t.from) ?? t.from
        const opened = graphPlan(sm, g)
        expect(opened.links.some(l => [...l.forward, ...l.backward].includes(t)), `${t.from} -> ${t.to} inside ${g}`).toBe(true)
      } else expect(drawn.has(t), `${t.from} -> ${t.to}`).toBe(true)
    }
  })
})
