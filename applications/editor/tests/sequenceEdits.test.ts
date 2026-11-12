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

/** The director the cast's script track calls. */
const director = { waitForGate() {} }

/** A cinematic with a cast: the director's script, a character's clip, a horn, a spawned guard and a possession. */
function cast(): SequenceData {
  return parseSequence({
    name: 'Cast', duration: 30, fps: 30,
    slots: [{ id: 'hero', name: 'Hero', nodeType: 'character' }, { id: 'pc', name: 'Player', nodeType: 'controller' },
            { id: 'horn', name: 'Horn', nodeType: 'sound' }, { id: 'guard', name: 'Guard' }],
    tracks: [
      { id: 'dir', type: 'script', sections: [{ id: 's1', start: 2, end: 8, method: 'waitForGate', args: [1], hold: true }] },
      { id: 'anim', type: 'animation', slot: 'hero', sections: [{ id: 'a1', start: 4, end: 14, clip: 'Wave', clipStart: 1, speed: 0.5 }] },
      { id: 'horn', type: 'audio', slot: 'horn',
        sections: [{ id: 'au1', start: 5, end: 15, offset: 2, volume: { keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 10, v: 1 }] } }] },
      { id: 'spawn', type: 'spawn', sections: [{ id: 'sp1', start: 0, end: 10, template: 'Guard', position: [1, 0, 2], parent: 'hero', bindAs: 'guard' }] },
      { id: 'own', type: 'possess', slot: 'pc', sections: [{ id: 'po1', start: 1, end: 9, pawn: 'hero' }] },
    ],
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

  it('keys a Foliage section channel by channel, and its last key takes the channel away', () => {
    let seq = parseSequence({ ...sample(), tracks: [{ id: 'f', type: 'foliage', slot: 'clock', layers: 'all', sections: [] }] })
    const r = E.addSection(seq, 'f', 2, 10)!
    seq = r.seq
    expect(E.findSection(seq, r.ref)!.density!.keys).toEqual([{ t: 0, v: 1 }])
    seq = E.setSectionKey(seq, r.ref, 4, 0.2, 'linear', 'cull')
    seq = E.setSectionKey(seq, r.ref, 1, false, undefined, 'shadows')
    const s = E.findSection(seq, r.ref)!
    expect(s.cull!.keys).toEqual([{ t: 4, v: 0.2, interp: 'linear' }])
    expect(s.shadows!.keys[0].v).toBe(false)
    // Trimming the start keeps every channel's keys where they were on the timeline.
    const trimmed = E.findSection(E.trimSectionStart(seq, r.ref, 3), r.ref)!
    expect(trimmed.start + trimmed.cull!.keys[0].t).toBeCloseTo(6, 9)
    // A razor cut splits every channel.
    const cut = E.splitSection(seq, r.ref, 7)!
    expect(E.findSection(cut.seq, cut.right)!.cull!.keys[0].v).toBeCloseTo(0.2, 9)
    // The channel's last key removes the channel: the layers' own value again.
    seq = E.deleteSectionKey(seq, r.ref, 0, 'cull')
    expect(E.findSection(seq, r.ref)!.cull).toBeUndefined()
    expect(parseSequence(seq).tracks[0].type).toBe('foliage')
  })

  it('adds preset blends with a preset, and never razors one', () => {
    const seq0 = parseSequence({ ...sample(), tracks: [{ id: 'p', type: 'preset', slot: 'clock', sections: [] }] })
    const r = E.addSection(seq0, 'p', 0, 10, { preset: 'stormy' })!
    expect(E.findSection(r.seq, r.ref)!.preset).toBe('stormy')
    expect(E.splitSection(r.seq, r.ref, 5)).toBeNull()
    expect(parseSequence(r.seq).tracks[0]).toMatchObject({ type: 'preset', sections: [{ preset: 'stormy' }] })
  })

  it('adds script, animation, audio, spawn and possess tracks as the parse keeps them, and refuses one with no slot', () => {
    let seq = cast()
    seq = E.addTrack(seq, { id: 't1', type: 'script', slot: '', sections: [] } as any)
    expect(E.findTrack(seq, 't1')).toEqual({ id: 't1', type: 'script', sections: [] })
    seq = E.addTrack(seq, { id: 't2', type: 'animation', slot: 'hero', animSlot: '' } as any)
    expect(E.findTrack(seq, 't2')).toEqual({ id: 't2', type: 'animation', slot: 'hero', sections: [] })
    seq = E.addTrack(seq, { id: 't3', type: 'spawn', sections: [] } as any)
    expect(parseSequence(seq).tracks.map(t => t.id)).toEqual(seq.tracks.map(t => t.id))
    // An audio or possess track drives a slot's node: with none it is not a track.
    for (const type of ['audio', 'possess', 'animation'] as const) expect(E.addTrack(seq, { id: 'x', type, sections: [] } as any)).toBe(seq)
  })

  it('adds sections shaped for the new track types, and none the parse would drop', () => {
    const seq = cast()
    const script = E.addSection(seq, 'dir', 10, 2)!
    expect(E.findSection(script.seq, script.ref)).toMatchObject({ start: 10, end: 12, method: E.DEFAULT_SCRIPT_METHOD })
    // An animation needs a clip, a spawn a template: the panel passes them in.
    expect(E.addSection(seq, 'anim', 0, 2)).toBeNull()
    expect(E.addSection(seq, 'spawn', 0, 2)).toBeNull()
    const anim = E.addSection(seq, 'anim', 16, 2, { clip: 'Bow' })!
    const spawn = E.addSection(seq, 'spawn', 12, 3, { template: 'Guard' })!
    const audio = E.addSection(seq, 'horn', 20, 4)!
    expect(E.findSection(audio.seq, audio.ref)).toEqual({ id: audio.ref.sectionId, start: 20, end: 24 })
    // A possession takes another slot than the controller's own, and none when there is no other.
    const possess = E.addSection(seq, 'own', 10, 2)!
    expect(E.findSection(possess.seq, possess.ref)!.pawn).toBe('hero')
    expect(E.addSection(parseSequence({ ...seq, slots: [{ id: 'pc', name: 'Player' }] }), 'own', 10, 2)).toBeNull()
    for (const r of [script, anim, spawn, audio, possess]) {
      const parsed = parseSequence(r.seq)
      expect(E.findSection(parsed, r.ref), r.ref.trackId).toEqual(E.findSection(r.seq, r.ref))
    }
  })

  it('razors an animation section on its clip: the clip time is the same everywhere after the cut', () => {
    const ref = { trackId: 'anim', sectionId: 'a1' }
    const r = E.splitSection(cast(), ref, 8)!
    const left = E.findSection(r.seq, ref)!, right = E.findSection(r.seq, r.right)!
    expect([left.start, left.end, right.start, right.end]).toEqual([4, 8, 8, 14])
    // clipStart + (cut - start) * speed = 1 + 4 * 0.5.
    expect([left.clipStart, right.clipStart, right.speed, right.clip]).toEqual([1, 3, 0.5, 'Wave'])
    const clipTimeAt = (seq: SequenceData, t: number) => {
      let started = NaN
      const hero = { animator: { lodExempt: false, playAction: (_clip: string, o: any) => {
        started = o.startTime ?? 0
        return { done: false, time: started, duration: 100, seek() {}, stop() {} }
      } }, children: [] }
      new SequencePlayer(seq, { resolveSlot: id => (id === 'hero' ? hero : null), director, scene: null }).evaluate(t)
      return started
    }
    for (const t of [5, 7.9, 8.1, 13]) expect(clipTimeAt(r.seq, t), `at ${t}`).toBeCloseTo(clipTimeAt(cast(), t), 9)
  })

  it('razors an audio section on its sample, its volume split like any curve', () => {
    const ref = { trackId: 'horn', sectionId: 'au1' }
    const r = E.splitSection(cast(), ref, 9)!
    const right = E.findSection(r.seq, r.right)!
    // offset + (cut - start) = 2 + 4.
    expect(right.offset).toBe(6)
    expect(right.volume!.keys[0].t).toBe(0)
    expect(right.volume!.keys[0].v).toBeCloseTo(0.4, 9)
    const heardAt = (seq: SequenceData, t: number) => {
      const horn: any = { gain: 1, playbackRate: 1, duration: 0, isPlaying: false, play(o: any) { this.offset = o.offset }, stop() {}, seek() {} }
      new SequencePlayer(seq, { resolveSlot: id => (id === 'horn' ? horn : null), director, scene: null }).evaluate(t)
      return [horn.offset, horn.gain]
    }
    for (const t of [6, 8.9, 9.1, 14]) {
      const [a, b] = [heardAt(cast(), t), heardAt(r.seq, t)]
      expect(b[0], `offset at ${t}`).toBeCloseTo(a[0], 9)
      expect(b[1], `gain at ${t}`).toBeCloseTo(a[1], 6)
    }
  })

  it('razors script, spawn and possess sections plainly, a hold staying on the second half', () => {
    const r = E.splitSection(cast(), { trackId: 'dir', sectionId: 's1' }, 5)!
    const left = E.findSection(r.seq, { trackId: 'dir', sectionId: 's1' })!, right = E.findSection(r.seq, r.right)!
    expect(left).toEqual({ id: 's1', start: 2, end: 5, method: 'waitForGate', args: [1] })
    expect(right).toEqual({ id: r.right.sectionId, start: 5, end: 8, method: 'waitForGate', args: [1], hold: true })
    // Playback still waits where it did: at the end of the whole span.
    const player = new SequencePlayer(r.seq, { resolveSlot: () => null, director: null, scene: null })
    expect(player.holdBetween(0, 30, new Set())).toEqual({ id: r.right.sectionId, end: 8 })
    const spawn = E.splitSection(cast(), { trackId: 'spawn', sectionId: 'sp1' }, 4)!
    expect(E.findSection(spawn.seq, spawn.right)).toMatchObject({ start: 4, end: 10, template: 'Guard', position: [1, 0, 2], parent: 'hero', bindAs: 'guard' })
    const possess = E.splitSection(cast(), { trackId: 'own', sectionId: 'po1' }, 3)!
    expect(E.findSection(possess.seq, possess.right)).toMatchObject({ start: 3, end: 9, pawn: 'hero' })
  })

  it('duplicates every new kind of section with what it plays', () => {
    const refs = [['dir', 's1'], ['anim', 'a1'], ['horn', 'au1'], ['spawn', 'sp1'], ['own', 'po1']] as const
    for (const [trackId, sectionId] of refs) {
      const seq = cast()
      const d = E.duplicateSection(seq, { trackId, sectionId })!
      const { id: _a, start: s0, end: e0, ...was } = E.findSection(seq, { trackId, sectionId })!
      const { id: _b, start, end, ...copy } = E.findSection(d.seq, d.copy)!
      expect([start, end], trackId).toEqual([e0, e0 + (e0 - s0)])
      expect(copy, trackId).toEqual(was)
    }
  })

  it('trims the start of an animation or audio section without moving its media on the timeline', () => {
    const anim = E.findSection(E.trimSectionStart(cast(), { trackId: 'anim', sectionId: 'a1' }, 6), { trackId: 'anim', sectionId: 'a1' })!
    expect(anim.clipStart).toBe(2) // 1 + 2 s * 0.5
    const audio = E.findSection(E.trimSectionStart(cast(), { trackId: 'horn', sectionId: 'au1' }, 6), { trackId: 'horn', sectionId: 'au1' })!
    expect(audio.offset).toBe(3)
    expect(audio.volume!.keys.map(k => k.t)).toEqual([-1, 9])
    // Grown back past the sample's start (2 s before the section, here 3): the sample starts with the section.
    const grown = E.findSection(E.trimSectionStart(cast(), { trackId: 'horn', sectionId: 'au1' }, 2), { trackId: 'horn', sectionId: 'au1' })!
    expect(grown.offset).toBeUndefined()
    expect(grown.volume!.keys.map(k => k.t)).toEqual([3, 13])
  })

  it('keys an audio section volume, and its last key takes the volume away', () => {
    const ref = { trackId: 'horn', sectionId: 'au1' }
    let seq = E.patchSection(cast(), ref, { volume: undefined })
    expect(E.findSection(seq, ref)!.volume).toBeUndefined()
    seq = E.setSectionKey(seq, ref, 2, 0.5, undefined, 'volume')
    expect(E.findSection(seq, ref)!.volume!.keys).toEqual([{ t: 2, v: 0.5 }])
    seq = E.deleteSectionKey(seq, ref, 0, 'volume')
    expect(E.findSection(seq, ref)!.volume).toBeUndefined()
  })

  it('drops what a patch sets back to its default, and what a deleted slot leaves behind', () => {
    const ref = { trackId: 'dir', sectionId: 's1' }
    expect(E.findSection(E.patchSection(cast(), ref, { hold: false, args: undefined }), ref)).toEqual({ id: 's1', start: 2, end: 8, method: 'waitForGate' })
    const anim = { trackId: 'anim', sectionId: 'a1' }
    expect(E.findSection(E.patchSection(cast(), anim, { clipStart: 0, loop: false }), anim)).toEqual({ id: 'a1', start: 4, end: 14, clip: 'Wave', speed: 0.5 })
    const seq = E.deleteSlot(cast(), 'hero')
    expect(seq.tracks.map(t => t.id)).toEqual(['dir', 'horn', 'spawn', 'own'])
    expect((E.findTrack(seq, 'own') as any).sections).toEqual([])
    expect(E.findSection(seq, { trackId: 'spawn', sectionId: 'sp1' })).not.toHaveProperty('parent')
    expect(E.findSection(E.deleteSlot(cast(), 'guard'), { trackId: 'spawn', sectionId: 'sp1' })).not.toHaveProperty('bindAs')
  })

  it('never mutates a sequence with the new track types', () => {
    const seq = cast()
    const before = JSON.stringify(seq)
    E.splitSection(seq, { trackId: 'anim', sectionId: 'a1' }, 6)
    E.splitSection(seq, { trackId: 'horn', sectionId: 'au1' }, 6)
    E.splitSection(seq, { trackId: 'dir', sectionId: 's1' }, 6)
    E.trimSectionStart(seq, { trackId: 'anim', sectionId: 'a1' }, 5)
    E.setSectionKey(seq, { trackId: 'horn', sectionId: 'au1' }, 1, 0.2, undefined, 'volume')
    E.deleteSlot(seq, 'hero')
    expect(JSON.stringify(seq)).toBe(before)
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
