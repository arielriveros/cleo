import { describe, expect, it } from 'vitest'
import type { StartTaskOptions, TaskHandle, TaskStep } from '@cleo/app-kit/feedback/progressStore'
import { DelayedTask } from '../src/features/backgroundWork/delayedTask'
import { programLabel, shaderRows } from '../src/features/backgroundWork/shaderTask'
import { giRows, probeRows } from '../src/features/backgroundWork/bakeRows'

// The progress popup's cards for the engine's own work (features/backgroundWork): shader builds, GI captures and
// light probe bakes, each mirrored into one card that opens only for work that lasts, and closes when it ends.

const materials = [
  { name: 'Sketch', material: { type: 'customScreen:5o42wrwxo5' } },
  { name: 'Glass', material: { type: 'custom:abc' } },
]

describe('the Compiling shaders rows', () => {
  it('names a custom material by its library name, an engine program by what it draws', () => {
    expect(programLabel('customScreen:5o42wrwxo5', 'customScreen:5o42wrwxo5', materials)).toBe('Sketch')
    expect(programLabel('pbr', 'custom:abc', materials)).toBe('Glass')
    expect(programLabel('custom:gone', null, materials)).toBe('Custom material')
    expect(programLabel('water', null, materials)).toBe('Water')
    expect(programLabel('volumetricClouds', null, materials)).toBe('Volumetric clouds')
  })

  it('gives one row per program however many of its pipelines build, then the warm-up with its count', () => {
    const rows = shaderRows({
      active: [
        { id: 1, program: 'pbr', builtFor: null, kind: 'pipeline', started: 1000 },
        { id: 2, program: 'pbr', builtFor: null, kind: 'pipeline', started: 500 },
        { id: 3, program: 'customScreen:5o42wrwxo5', builtFor: 'customScreen:5o42wrwxo5', kind: 'pipeline', started: 2000 },
      ],
      warm: { done: 30, total: 120 },
    }, materials, 4600)
    expect(rows).toEqual([
      { key: 'program:pbr', name: 'Lit materials', detail: 'Building 2 pipelines · 4 s' },
      { key: 'program:customScreen:5o42wrwxo5', name: 'Sketch', detail: 'Building · 2 s' },
      { key: 'warm', name: 'Shaders from the last session', detail: '30 of 120', progress: 0.25 },
    ])
    expect(shaderRows({ active: [], warm: null }, materials, 0)).toEqual([])
  })
})

describe('the bake rows', () => {
  it('lists the GI volumes still capturing, with how far each is', () => {
    expect(giRows([
      { id: 'a', name: 'Hall GI', probes: 200, captured: 50 },
      { id: 'b', name: 'Done GI', probes: 64, captured: 64 },
      { id: 'c', name: '', probes: 0, captured: 0 },
    ])).toEqual([{ key: 'gi:a', name: 'Hall GI', detail: '50 of 200 probes', progress: 0.25 }])
  })

  it('names the probe job in flight by what it does', () => {
    expect(probeRows(null)).toEqual([])
    expect(probeRows({ probe: { id: 'p', name: 'Kitchen probe' }, kind: 'relight', fraction: 0.5 }))
      .toEqual([{ key: 'probe:p', name: 'Kitchen probe', detail: 'Relighting', progress: 0.5 }])
  })
})

/** A progress store stand-in: the card's rows as they are now. */
function fakeStore() {
  const cards: { title: string; steps: TaskStep[]; finished: boolean; indeterminate: boolean }[] = []
  let publishes = 0
  const start = (o: StartTaskOptions): TaskHandle => {
    const card = { title: o.title, steps: [] as TaskStep[], finished: false, indeterminate: !!o.indeterminate }
    cards.push(card)
    return {
      id: String(cards.length), cancelled: false,
      setStep(i, p) { publishes++; card.steps[i] = { ...card.steps[i], ...p } },
      addStep(s) { publishes++; card.steps.push(s); return card.steps.length - 1 },
      setTitle() {},
      finish() { card.finished = true },
    }
  }
  return { cards, start, get publishes() { return publishes } }
}

describe('a card for watched work', () => {
  it('never opens for work over within half a second', () => {
    let now = 0
    const store = fakeStore()
    const task = new DelayedTask({ title: 'Baking light probes', start: store.start, now: () => now })
    task.update([{ key: 'p', name: 'Probe' }])
    now = 300; task.update([{ key: 'p', name: 'Probe' }])
    now = 400; task.update([])
    now = 1300; task.update([])
    expect(store.cards).toEqual([])
  })

  it('opens for lasting work, marks rows done as they end, and finishes once nothing is left', () => {
    let now = 0
    const store = fakeStore()
    const task = new DelayedTask({ title: 'Compiling shaders', indeterminate: true, start: store.start, now: () => now })
    task.update([{ key: 'a', name: 'Sketch', detail: 'Building' }])
    now = 600; task.update([{ key: 'a', name: 'Sketch', detail: 'Building' }, { key: 'b', name: 'Water', detail: 'Building' }])
    expect(store.cards).toHaveLength(1)
    expect(store.cards[0]).toMatchObject({ title: 'Compiling shaders', indeterminate: true, finished: false })
    // Nothing changed: the store is not touched again.
    const before = store.publishes
    now = 850; task.update([{ key: 'a', name: 'Sketch', detail: 'Building' }, { key: 'b', name: 'Water', detail: 'Building' }])
    expect(store.publishes).toBe(before)
    now = 1100; task.update([{ key: 'a', name: 'Sketch', detail: 'Building' }])
    expect(store.cards[0].steps.map(s => s.status)).toEqual(['running', 'done'])
    // A gap shorter than the linger (a probe between two jobs) does not end it...
    now = 1200; task.update([])
    expect(store.cards[0].finished).toBe(false)
    expect(store.cards[0].steps.map(s => s.status)).toEqual(['done', 'done'])
    // ...one longer does.
    now = 2100; task.update([])
    expect(store.cards[0].finished).toBe(true)
    // New work later: a new card.
    now = 5000; task.update([{ key: 'c', name: 'Glass' }])
    now = 5600; task.update([{ key: 'c', name: 'Glass' }])
    expect(store.cards).toHaveLength(2)
  })
})
