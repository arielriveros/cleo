import { describe, it, expect } from 'vitest'
import { parseSequence, SequencePlayer } from 'cleo'
import type { PropertyTrack, SequenceData } from 'cleo'
import { conflictingTrack, keyProperties, unwrapEuler } from '../src/features/sequencer/autoKey'

// Sequencer mode keys a node's change at the playhead. The edit is pure: the slot, the track and the section are
// made when missing, a new track animates from what the scene had at 0 to the new value at t, and keying never
// touches the sequence it was given.

const empty = (): SequenceData => parseSequence({ name: 'Test', duration: 10, fps: 30, slots: [], tracks: [], markers: [] })
const cube = { id: 'n-cube', name: 'Cube', path: 'Cube', nodeType: 'model' }
const trackOf = (seq: SequenceData, path: string) =>
  seq.tracks.find((t): t is PropertyTrack => t.type === 'property' && t.path === path)!

describe('keyProperties', () => {
  it('a first change at 2 s keys the old value at 0 and the new one at 2, on a new slot bound to the node', () => {
    const seq = empty()
    const { seq: next, slotId } = keyProperties(seq, cube,
      [{ path: 'position', valueType: 'vector', before: [0, 0, 0], after: [0, 2, 1] }], 2)
    expect(seq.slots).toHaveLength(0)
    expect(seq.tracks).toHaveLength(0)
    expect(next.slots).toEqual([{ id: slotId, name: 'Cube', nodeId: 'n-cube', nodeType: 'model', path: 'Cube' }])
    const track = trackOf(next, 'position')
    expect(track.slot).toBe(slotId)
    expect(track.sections).toHaveLength(1)
    expect(track.sections[0].start).toBe(0)
    expect(track.sections[0].end).toBe(10)
    expect(track.sections[0].curve.keys).toEqual([{ t: 0, v: [0, 0, 0] }, { t: 2, v: [0, 2, 1] }])
    // It survives the parse whole, and plays as asked: half way at 1 s.
    expect(parseSequence(JSON.parse(JSON.stringify(next)))).toEqual(next)
    const node = { position: [0, 0, 0] as number[], setPosition(v: number[]) { this.position = [...v] } }
    const player = new SequencePlayer(next, { resolveSlot: () => node, director: null, scene: null })
    player.evaluate(2)
    expect(node.position).toEqual([0, 2, 1])
  })

  it('a change at 0 is a single key', () => {
    const { seq } = keyProperties(empty(), cube, [{ path: 'light.intensity', valueType: 'number', before: 100, after: 800 }], 0)
    expect(trackOf(seq, 'light.intensity').sections[0].curve.keys).toEqual([{ t: 0, v: 800 }])
  })

  it('a later change keys the same track and section, and replaces a key at the same time', () => {
    let { seq, slotId } = keyProperties(empty(), cube, [{ path: 'position', valueType: 'vector', before: [0, 0, 0], after: [0, 2, 1] }], 2)
    seq = keyProperties(seq, cube, [{ path: 'position', valueType: 'vector', before: [0, 2, 1], after: [5, 2, 1] }], 4, slotId).seq
    seq = keyProperties(seq, cube, [{ path: 'position', valueType: 'vector', before: [0, 2, 1], after: [0, 3, 1] }], 2, slotId).seq
    expect(seq.slots).toHaveLength(1)
    expect(seq.tracks).toHaveLength(1)
    expect(trackOf(seq, 'position').sections[0].curve.keys.map(k => [k.t, k.v])).toEqual([[0, [0, 0, 0]], [2, [0, 3, 1]], [4, [5, 2, 1]]])
  })

  it('finds the node\'s slot by its id when the caller names none', () => {
    const seq = parseSequence({ name: 'T', duration: 10, slots: [{ id: 'hero', name: 'Hero', nodeId: 'n-cube' }], tracks: [], markers: [] })
    const { seq: next, slotId } = keyProperties(seq, cube, [{ path: 'scale', valueType: 'vector', before: [1, 1, 1], after: [2, 2, 2] }], 1)
    expect(slotId).toBe('hero')
    expect(next.slots).toHaveLength(1)
  })

  it('stretches the nearest section to reach a key outside every section, keeping keys in place', () => {
    const seq = parseSequence({
      name: 'T', duration: 10, fps: 30, slots: [{ id: 'c', name: 'C', nodeId: 'n-cube' }], markers: [],
      tracks: [{ id: 'p', type: 'property', slot: 'c', path: 'opacity', valueType: 'number',
        sections: [{ id: 's', start: 3, end: 5, curve: { keys: [{ t: 0, v: 1 }, { t: 2, v: 0 }] } }] }],
    })
    const early = keyProperties(seq, cube, [{ path: 'opacity', valueType: 'number', before: 1, after: 0.5 }], 1, 'c').seq
    const s1 = trackOf(early, 'opacity').sections[0]
    expect([s1.start, s1.end]).toEqual([1, 5])
    // The old keys still sit at 3 s and 5 s on the timeline.
    expect(s1.curve.keys.map(k => [k.t + s1.start, k.v])).toEqual([[1, 0.5], [3, 1], [5, 0]])
    const late = keyProperties(seq, cube, [{ path: 'opacity', valueType: 'number', before: 0, after: 1 }], 8, 'c').seq
    const s2 = trackOf(late, 'opacity').sections[0]
    expect([s2.start, s2.end]).toEqual([3, 8])
  })

  it('grows the sequence to a key past its end', () => {
    const { seq } = keyProperties(empty(), cube, [{ path: 'visible', valueType: 'bool', before: true, after: false }], 12.01)
    expect(seq.duration).toBeCloseTo(12.0333, 3)
    expect(trackOf(seq, 'visible').sections[0].curve.keys).toEqual([{ t: 0, v: true }, { t: 12.01, v: false }])
  })

  it('flags a key inside an ease, where the frame blends', () => {
    const seq = parseSequence({
      name: 'T', duration: 10, slots: [{ id: 'c', name: 'C', nodeId: 'n-cube' }], markers: [],
      tracks: [{ id: 'p', type: 'property', slot: 'c', path: 'opacity', valueType: 'number',
        sections: [{ id: 's', start: 0, end: 10, easeIn: 2, curve: { keys: [{ t: 0, v: 1 }] } }] }],
    })
    expect(keyProperties(seq, cube, [{ path: 'opacity', valueType: 'number', before: 1, after: 0 }], 1, 'c').blended).toBe(true)
    expect(keyProperties(seq, cube, [{ path: 'opacity', valueType: 'number', before: 1, after: 0 }], 5, 'c').blended).toBe(false)
  })

  it('unwraps a rotation toward the value it turned from', () => {
    expect(unwrapEuler([0, -170, 0], [0, 170, 0])).toEqual([0, 190, 0])
    expect(unwrapEuler([10, 20, 30], [0, 0, 0])).toEqual([10, 20, 30])
    const { seq } = keyProperties(empty(), cube, [{ path: 'rotation', valueType: 'vector', before: [0, 170, 0], after: [0, -170, 0] }], 1)
    expect(trackOf(seq, 'rotation').sections[0].curve.keys[1].v).toEqual([0, 190, 0])
  })

  it('reports a path track that drives the position', () => {
    const seq = parseSequence({
      name: 'T', duration: 10, slots: [{ id: 'cam', name: 'Cam' }], markers: [],
      tracks: [{ id: 'fly', type: 'path', slot: 'cam', name: 'Fly', sections: [{ id: 's', start: 0, end: 5, points: [[0, 0, 0], [1, 0, 0]] }] }],
    })
    expect(conflictingTrack(seq, 'cam', 'position')?.name).toBe('Fly')
    expect(conflictingTrack(seq, 'cam', 'camera.fov')).toBeNull()
    expect(conflictingTrack(seq, 'other', 'position')).toBeNull()
  })
})
