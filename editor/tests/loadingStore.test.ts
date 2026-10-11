import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  beginLoad, beginLoadWithHandoff, continueLoad, currentLoad, handoffFromCurrent, hasHandoff, loadFraction,
  resetLoadStore, runStep, saveHandoff, stepFraction, subscribeLoad, takeHandoff,
} from '../src/features/loading/loadingStore'
import { BOOT_STEPS, BOOT_TITLE, beginBootLoad, currentOrNoop, NOOP_LOAD } from '../src/features/loading/bootLoad'

// The tests run under node: a Map stands in for sessionStorage.
const store = new Map<string, string>()
const fakeSession = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}

beforeEach(() => {
  store.clear()
  ;(globalThis as any).sessionStorage = fakeSession
  resetLoadStore()
})
afterEach(() => { delete (globalThis as any).sessionStorage })

describe('a load', () => {
  it('weights the total by step, counting a running step by its count', () => {
    const load = beginLoad('Test', [
      { id: 'a', label: 'A', weight: 1 },
      { id: 'b', label: 'B', weight: 3 },
    ])
    expect(loadFraction(currentLoad())).toBe(0)
    load.step('a').done()
    expect(loadFraction(currentLoad())).toBeCloseTo(0.25)
    load.step('b').progress(1, 3)
    expect(loadFraction(currentLoad())).toBeCloseTo(0.25 + 0.75 / 3)
    load.step('b').done()
    expect(loadFraction(currentLoad())).toBe(1)
  })

  it('counts a running step with nothing to count as halfway, and failed or skipped as finished', () => {
    const load = beginLoad('Test', [{ id: 'a', label: 'A' }])
    load.step('a').start()
    expect(stepFraction(currentLoad()!.steps[0])).toBe(0.5)
    load.step('a').fail('boom')
    expect(currentLoad()!.steps[0]).toMatchObject({ status: 'failed', detail: 'boom' })
    expect(stepFraction(currentLoad()!.steps[0])).toBe(1)
  })

  it('records counts and timings, and fills the count in on done', () => {
    const load = beginLoad('Test', [{ id: 'tex', label: 'Textures' }])
    load.step('tex').progress(3, 10)
    let s = currentLoad()!.steps[0]
    expect(s).toMatchObject({ status: 'running', done: 3, total: 10 })
    expect(s.startedAt).not.toBeNull()
    load.step('tex').done()
    s = currentLoad()!.steps[0]
    expect(s).toMatchObject({ status: 'done', done: 10, total: 10 })
    expect(s.endedAt).toBeGreaterThanOrEqual(s.startedAt!)
  })

  it('ignores a stale handle once a newer load has started', () => {
    const old = beginLoad('Old', [{ id: 'a', label: 'A' }])
    const fresh = beginLoad('New', [{ id: 'a', label: 'A' }])
    old.step('a').done()
    old.finish()
    expect(currentLoad()?.title).toBe('New')
    expect(currentLoad()!.steps[0].status).toBe('pending')
    expect(old.active).toBe(false)
    expect(fresh.active).toBe(true)
  })

  it('adds steps mid-load, renames, and closes on finish', () => {
    const load = beginLoad('Test', [{ id: 'a', label: 'A' }])
    load.addSteps([{ id: 'b', label: 'B' }, { id: 'a', label: 'dup' }])
    expect(currentLoad()!.steps.map(s => s.id)).toEqual(['a', 'b'])
    load.setTitle('Opening Hollow Keep')
    expect(currentLoad()!.title).toBe('Opening Hollow Keep')
    let calls = 0
    const off = subscribeLoad(() => calls++)
    load.finish()
    off()
    expect(currentLoad()).toBeNull()
    expect(calls).toBe(1)
    expect(continueLoad()).toBeNull()
  })

  it('runs a step and marks it failed when it throws', async () => {
    const load = beginLoad('Test', [{ id: 'ok', label: 'Ok' }, { id: 'bad', label: 'Bad' }])
    expect(await runStep(load, 'ok', () => 7)).toBe(7)
    await expect(runStep(load, 'bad', async () => { throw new Error('nope') })).rejects.toThrow('nope')
    expect(currentLoad()!.steps.map(s => s.status)).toEqual(['done', 'failed'])
  })
})

describe('the hand-off across a reload', () => {
  it('carries the title and the finished steps into the next startup', () => {
    const load = beginLoad('Installing Hollow Keep', [
      { id: 'download', label: 'Downloading' },
      { id: 'textures', label: 'Writing textures' },
      { id: 'audio', label: 'Writing audio' },
    ])
    load.step('download').progress(40, 40)
    load.step('download').done()
    load.step('textures').done('5 written')
    saveHandoff(handoffFromCurrent()!)
    expect(hasHandoff()).toBe(true)

    resetLoadStore()
    const boot = beginLoadWithHandoff('Opening project', [{ id: 'textures', label: 'Textures' }])
    const s = currentLoad()!
    expect(s.title).toBe('Installing Hollow Keep')
    expect(s.steps.map(x => [x.id, x.status])).toEqual([
      ['prior:download', 'done'], ['prior:textures', 'done'], ['textures', 'pending'],
    ])
    expect(s.steps[0].detail).toBe('40 / 40')
    // The startup's own step is not confused with the prior one of the same name.
    boot.step('textures').start()
    expect(currentLoad()!.steps[1].status).toBe('done')
    expect(hasHandoff()).toBe(false)
  })

  it('is read once, and a missing or corrupt one is no hand-off', () => {
    expect(takeHandoff()).toBeNull()
    store.set('cleo_load_handoff', '{nope')
    expect(takeHandoff()).toBeNull()
    store.set('cleo_load_handoff', JSON.stringify({ title: 3 }))
    expect(takeHandoff()).toBeNull()
    saveHandoff({ title: 'Opening Night Shift', steps: [] })
    expect(takeHandoff()?.title).toBe('Opening Night Shift')
    expect(takeHandoff()).toBeNull()
  })

  it('survives a storage that throws', () => {
    ;(globalThis as any).sessionStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() {} }
    expect(() => saveHandoff({ title: 't', steps: [] })).not.toThrow()
    expect(takeHandoff()).toBeNull()
    expect(hasHandoff()).toBe(false)
  })
})

describe('the startup load', () => {
  it('lists every boot step under the generic title', () => {
    beginBootLoad()
    const s = currentLoad()!
    expect(s.title).toBe(BOOT_TITLE)
    expect(s.steps.map(x => x.id)).toEqual(BOOT_STEPS.map(x => x.id))
    expect(currentOrNoop().id).toBe(s.id)
  })

  it('reports nowhere when there is no load', () => {
    expect(currentOrNoop()).toBe(NOOP_LOAD)
    expect(() => NOOP_LOAD.step('x').start().progress(1, 2).done().fail('f').skip()).not.toThrow()
  })
})
