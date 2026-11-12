import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseSequence, SequencePlayer, Spline3 } from 'cleo'
import type { SequenceData } from 'cleo'
import * as E from '../src/features/sequencer/sequenceEdits'
import { sequenceFromText, sequenceToText, sequenceFileName } from '../src/features/sequencer/sequenceFile'

// The Sequencer's edits are pure functions over SequenceData. What matters: they never mutate their input (the
// undo recorder diffs snapshots), keys keep their place on the timeline when a section's start is trimmed, and a
// razor cut changes nothing on screen.

function sample(): SequenceData {
  return parseSequence({
    name: 'Test', duration: 20, fps: 30,
    slots: [{ id: 'cam', name: 'Camera', nodeType: 'camera' }, { id: 'clock', name: 'Clock' }],
    tracks: [
      { id: 'path', type: 'path', slot: 'cam', sections: [{ id: 'p1', start: 2, end: 12, points: [[0, 2, 0], [0, 2, 50], [30, 5, 80]], look: { mode: 'ahead' } }] },
      { id: 'cut', type: 'cameraCut', sections: [{ id: 'c1', start: 0, end: 20, slot: 'cam' }] },
      { id: 'hour', type: 'property', slot: 'clock', path: 'hour', valueType: 'number',
        sections: [{ id: 'h1', start: 4, end: 14, curve: { keys: [{ t: 0, v: 10, interp: 'linear' }, { t: 10, v: 20 }] } }] },
      { id: 'ev', type: 'event', keys: [{ t: 5, method: 'go' }] },
    ],
    markers: [{ t: 3, name: 'A' }],
  })
}

describe('sequence edits', () => {
  it('never mutates the sequence it is given', () => {
    const seq = sample()
    const before = JSON.stringify(seq)
    const ref = { trackId: 'hour', sectionId: 'h1' }
    E.moveSection(seq, ref, 3)
    E.trimSectionStart(seq, ref, 6)
    E.splitSection(seq, ref, 9)
    E.setSectionKey(seq, ref, 2, 15)
    E.deleteSlot(seq, 'clock')
    E.addMarker(seq, 1, 'B')
    expect(JSON.stringify(seq)).toBe(before)
  })

  it('moves a section with its keys, never before 0, and grows the duration to cover it', () => {
    const ref = { trackId: 'hour', sectionId: 'h1' }
    const moved = E.moveSection(sample(), ref, -10)
    const s = E.findSection(moved, ref)!
    expect([s.start, s.end]).toEqual([0, 10])
    expect(s.curve!.keys.map(k => k.t)).toEqual([0, 10])
    const late = E.moveSection(sample(), ref, 20)
    expect(E.findSection(late, ref)!.end).toBe(34)
    expect(late.duration).toBe(34)
  })

  it('trims the start without moving any key on the timeline', () => {
    const ref = { trackId: 'hour', sectionId: 'h1' }
    const trimmed = E.trimSectionStart(sample(), ref, 6)
    const s = E.findSection(trimmed, ref)!
    expect(s.start).toBe(6)
    // The key that was at 4 + 10 = 14 is still at 14.
    expect(s.start + s.curve!.keys[1].t).toBeCloseTo(14, 9)
    // Never past the end.
    expect(E.findSection(E.trimSectionStart(sample(), ref, 99), ref)!.start).toBeLessThan(14)
  })

  it('splits a property section with no visible change', () => {
    const ref = { trackId: 'hour', sectionId: 'h1' }
    const r = E.splitSection(sample(), ref, 9)!
    expect(r).not.toBeNull()
    const left = E.findSection(r.seq, ref)!, right = E.findSection(r.seq, r.right)!
    expect([left.start, left.end, right.start, right.end]).toEqual([4, 9, 9, 14])
    const clock: any = { hour: 0 }
    for (const t of [5, 8.9, 9, 9.1, 13]) {
      const player = new SequencePlayer(r.seq, { resolveSlot: id => (id === 'clock' ? clock : null), director: null, scene: null })
      player.evaluate(t)
      expect(clock.hour, `at ${t}`).toBeCloseTo(10 + (t - 4), 6)
    }
  })

  it('splits a path section without moving the camera', () => {
    const ref = { trackId: 'path', sectionId: 'p1' }
    const cam: any = { position: new Float32Array(3), quaternion: new Float32Array([0, 0, 0, 1]),
      worldPosition: new Float32Array(3), worldQuaternion: new Float32Array([0, 0, 0, 1]), parent: null,
      setPosition(p: ArrayLike<number>) { this.position.set(p); this.worldPosition.set(p) }, setQuaternion(q: ArrayLike<number>) { this.quaternion.set(q); this.worldQuaternion.set(q) } }
    const poseAt = (seq: SequenceData, t: number) => {
      const player = new SequencePlayer(seq, { resolveSlot: id => (id === 'cam' ? cam : null), director: null, scene: null })
      player.evaluate(t)
      return Array.from(cam.worldPosition as Float32Array)
    }
    const r = E.splitSection(sample(), ref, 6)!
    for (const t of [3, 5.9, 6.1, 11]) {
      const a = poseAt(sample(), t), b = poseAt(r.seq, t)
      for (let c = 0; c < 3; c++) expect(b[c], `at ${t}`).toBeCloseTo(a[c], 3)
    }
  })

  it('refuses to split outside a section', () => {
    expect(E.splitSection(sample(), { trackId: 'hour', sectionId: 'h1' }, 2)).toBeNull()
  })

  it('duplicates a section after itself and adds sections shaped for their track', () => {
    const d = E.duplicateSection(sample(), { trackId: 'hour', sectionId: 'h1' })!
    const copy = E.findSection(d.seq, d.copy)!
    expect([copy.start, copy.end]).toEqual([14, 24])
    const path = E.addSection(sample(), 'path', 13, 4)!
    expect(E.findSection(path.seq, path.ref)!.points!.length).toBe(2)
    const cut = E.addSection(sample(), 'cut', 0, 2)!
    expect(E.findSection(cut.seq, cut.ref)!.slot).toBe('cam')
  })

  it('edits keys, events, slots and markers', () => {
    const ref = { trackId: 'hour', sectionId: 'h1' }
    let seq = E.setSectionKey(sample(), ref, 5, 99)
    expect(E.findSection(seq, ref)!.curve!.keys.map(k => k.t)).toEqual([0, 5, 10])
    seq = E.deleteSectionKey(seq, ref, 1)
    expect(E.findSection(seq, ref)!.curve!.keys.length).toBe(2)
    seq = E.addEventKey(seq, 'ev', { t: 1, name: 'early' })
    expect((E.findTrack(seq, 'ev') as any).keys.map((k: any) => k.t)).toEqual([1, 5])
    seq = E.deleteSlot(seq, 'cam')
    expect(seq.tracks.map(t => t.id)).toEqual(['cut', 'hour', 'ev'])
    expect((E.findTrack(seq, 'cut') as any).sections).toEqual([])
    expect(E.slotIdFor(sample(), 'Camera')).toBe('camera')
    expect(E.slotIdFor(parseSequence({ ...sample(), slots: [{ id: 'camera', name: 'x' }] }), 'Camera')).toBe('camera2')
    seq = E.addMarker(sample(), 1, 'Start')
    expect(seq.markers.map(m => m.name)).toEqual(['Start', 'A'])
  })

  it('splits curves into halves that meet at the cut', () => {
    const [a, b] = E.splitCurve({ keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 4, v: 8 }] }, 1)
    expect(a.keys.at(-1)).toMatchObject({ t: 1, v: 2 })
    expect(b.keys[0]).toMatchObject({ t: 0, v: 2 })
    expect(b.keys.at(-1)!.t).toBe(3)
  })
})

describe('sequence files', () => {
  it('round-trips a sequence through its file format', () => {
    const seq = sample()
    expect(sequenceFromText(sequenceToText(seq))).toEqual(seq)
    expect(sequenceFileName({ ...seq, name: 'Valley Tour' })).toBe('valley-tour.sequence.json')
    expect(() => sequenceFromText('not json')).toThrow(/Not a sequence file/)
  })

  it("reads the Valley's checked-in tour back unchanged", () => {
    const file = join(__dirname, '..', '..', '..', 'tools', 'valley', 'cinematic', 'valley-tour.sequence.json')
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const seq = sequenceFromText(text)
    expect(sequenceToText(seq)).toBe(text)
    // Every path is a real spline.
    for (const t of seq.tracks) if (t.type === 'path') for (const s of t.sections) expect(new Spline3(s.points).length).toBeGreaterThan(1)
  })
})
