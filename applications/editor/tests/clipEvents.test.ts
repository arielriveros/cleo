import { describe, it, expect } from 'vitest'
import type { AnimationStateMachine } from 'cleo'
import { hasEvent, liftMachineEvents, sortEvents } from '../src/utils/clipEvents'

// Events moved from the animator onto the clip. A machine opened in the editor hands its markers to the
// clips they name (liftMachineEvents); what has no `.anim` to go to stays, because the engine still fires it.

const machine = (events: AnimationStateMachine['events']): AnimationStateMachine =>
  ({ parameters: [], states: [], transitions: [], events })

const clip = (name: string, events?: { time: number; name: string }[]) =>
  ({ name, samplers: [], channels: [], ...(events ? { events } : {}) })

const animations = [
  { id: 'walk_anim', clips: [clip('Walk'), clip('Walk Back', [{ time: 0.1, name: 'step' }])] },
  { id: 'attack_anim', clips: [clip('Slash', [{ time: 0.4, name: 'hit' }])] },
]
const clipAssetIds = new Map<string, string | undefined>([
  ['Walk', 'walk_anim'], ['Walk Back', 'walk_anim'], ['Slash', 'attack_anim'], ['Embedded Idle', undefined],
])

describe('liftMachineEvents', () => {
  it('moves each marker onto the clip it names, in time order', () => {
    const sm = machine([
      { clipName: 'Walk', time: 0.6, eventName: 'footR' },
      { clipName: 'Walk', time: 0.1, eventName: 'footL' },
      { clipName: 'Walk Back', time: 0.5, eventName: 'step' },
    ])
    const out = liftMachineEvents(sm, clipAssetIds, animations)
    expect(out.moved).toBe(3)
    expect(out.machine.events).toEqual([])
    expect(out.clips).toEqual([
      { assetId: 'walk_anim', clipName: 'Walk', events: [{ time: 0.1, name: 'footL' }, { time: 0.6, name: 'footR' }] },
      // The clip's own events are kept, and the new one joins them.
      { assetId: 'walk_anim', clipName: 'Walk Back', events: [{ time: 0.1, name: 'step' }, { time: 0.5, name: 'step' }] },
    ])
  })

  it('drops a marker the clip already has rather than adding it twice', () => {
    const sm = machine([
      { clipName: 'Slash', time: 0.4, eventName: 'hit' },
      { clipName: 'Slash', time: 0.40000001, eventName: 'hit' },
    ])
    const out = liftMachineEvents(sm, clipAssetIds, animations)
    // Both leave the machine (the clip fires it), and the clip is not written at all: nothing new.
    expect(out.moved).toBe(2)
    expect(out.machine.events).toEqual([])
    expect(out.clips).toEqual([])
  })

  it('dedupes markers among themselves too', () => {
    const sm = machine([
      { clipName: 'Walk', time: 0.3, eventName: 'foot' },
      { clipName: 'Walk', time: 0.3, eventName: 'foot' },
      { clipName: 'Walk', time: 0.3, eventName: 'dust' },
    ])
    const out = liftMachineEvents(sm, clipAssetIds, animations)
    expect(out.clips[0].events).toEqual([{ time: 0.3, name: 'foot' }, { time: 0.3, name: 'dust' }])
  })

  it('keeps what has nowhere to go: an embedded clip, a clip the asset lacks, a marker with no clip', () => {
    const embedded = { clipName: 'Embedded Idle', time: 0.2, eventName: 'blink' }
    const unknown = { clipName: 'Run', time: 0.2, eventName: 'foot' }
    const noClip = { clipName: '', time: 0, eventName: 'orphan' }
    // `Walk` resolves to an asset that no longer has a clip of that name.
    const renamedAway = { clipName: 'Walk', time: 0.2, eventName: 'foot' }
    const out = liftMachineEvents(machine([embedded, unknown, noClip, renamedAway]), clipAssetIds,
      [{ id: 'walk_anim', clips: [clip('Walk Fast')] }])
    expect(out.moved).toBe(0)
    expect(out.clips).toEqual([])
    expect(out.machine.events).toEqual([embedded, unknown, noClip, renamedAway])
  })

  it('returns the very same machine when nothing moves, so a caller can tell nothing happened', () => {
    const empty = machine([])
    expect(liftMachineEvents(empty, clipAssetIds, animations).machine).toBe(empty)
    const stays = machine([{ clipName: 'Embedded Idle', time: 0.2, eventName: 'blink' }])
    expect(liftMachineEvents(stays, clipAssetIds, animations).machine).toBe(stays)
  })

  it('leaves the rest of the machine alone', () => {
    const sm: AnimationStateMachine = {
      ...machine([{ clipName: 'Walk', time: 0.3, eventName: 'foot' }]),
      parameters: [{ name: 'speed', type: 'float', default: 0 }],
      states: [{ name: 'Walk', clipName: 'Walk', loop: true, speed: 1, isEntry: true }],
    }
    const out = liftMachineEvents(sm, clipAssetIds, animations)
    expect(out.machine).toEqual({ ...sm, events: [] })
    // Not mutated in place: the working copy before the lift is still what it was.
    expect(sm.events).toHaveLength(1)
    expect(animations[0].clips[0]).not.toHaveProperty('events')
  })
})

describe('event helpers', () => {
  it('sorts by time without touching the input', () => {
    const list = [{ time: 2, name: 'b' }, { time: 1, name: 'a' }]
    expect(sortEvents(list).map(e => e.name)).toEqual(['a', 'b'])
    expect(list[0].name).toBe('b')
  })

  it('matches an event by name and moment', () => {
    const list = [{ time: 1, name: 'hit' }]
    expect(hasEvent(list, { time: 1.00001, name: 'hit' })).toBe(true)
    expect(hasEvent(list, { time: 1.01, name: 'hit' })).toBe(false)
    expect(hasEvent(list, { time: 1, name: 'hitEnd' })).toBe(false)
  })
})
