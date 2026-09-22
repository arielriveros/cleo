import { describe, it, expect } from 'vitest'
import { tracksOf, channelOf, keyIndexAt, withKey, withoutKey, withMovedKey, clipDuration } from '../src/utils/clipTracks'
import type { StoredClip } from '../src/utils/animationAssets'

// Keyframe surgery, and the two ways it goes wrong without anyone noticing:
//
//  - a shared sampler written through one channel moves a bone the artist was not editing (and, because
//    `output` arrays are shared with the retarget cache, does it on other CHARACTERS too);
//  - an out-of-order `input` does not throw, it just plays one segment of the clip backwards.

const skin = {
  joints: [{ nodeIndex: 0 }, { nodeIndex: 1 }, { nodeIndex: 2 }],
  nodeNames: [[0, 'Hips'], [1, 'Spine'], [2, 'LeftArm']] as [number, string][],
}

/** A clip driving node 1's rotation with three keys. */
const clip = (): StoredClip => ({
  name: 'walk',
  samplers: [{ input: [0, 0.5, 1], output: [0, 0, 0, 1, /**/ 0, 0, 0.1, 0.99, /**/ 0, 0, 0, 1], interpolation: 'LINEAR' }],
  channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' }],
})

/** Two channels deliberately sharing ONE sampler — legal glTF, and what the loader preserves. */
const shared = (): StoredClip => ({
  name: 'shared',
  samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0, 0, 1], interpolation: 'LINEAR' }],
  channels: [
    { samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' },
    { samplerIndex: 0, targetNodeIndex: 2, targetPath: 'rotation' },
  ],
})

const samplerFor = (c: StoredClip, node: number, path: any) => c.samplers[c.channels[channelOf(c, node, path)].samplerIndex]

describe('tracksOf', () => {
  it('groups a clip’s channels by bone, in skeleton order', () => {
    const c: StoredClip = {
      name: 'a',
      samplers: [
        { input: [0], output: [0, 0, 0, 1], interpolation: 'LINEAR' },
        { input: [0], output: [0, 1, 0], interpolation: 'LINEAR' },
      ],
      // Deliberately out of skeleton order — two exporters disagree, and neither matches the hierarchy.
      channels: [
        { samplerIndex: 0, targetNodeIndex: 2, targetPath: 'rotation' },
        { samplerIndex: 1, targetNodeIndex: 0, targetPath: 'translation' },
      ],
    }
    const tracks = tracksOf(c, skin)
    expect(tracks.map(t => t.nodeIndex)).toEqual([0, 2])          // joint order, not channel order
    expect(tracks[0].name).toBe('Hips')
    expect(tracks[0].translation?.keys).toEqual([0])
    expect(tracks[1].rotation?.keys).toEqual([0])
  })

  it('still lists a bone that is not a joint', () => {
    // An assimp-converted FBX puts a bone's curve on a `$AssimpFbx$` pivot, which is not in `skin.joints`.
    // Dropping those from the track list would hide half the motion on those rigs.
    const c = clip()
    c.channels[0].targetNodeIndex = 99
    expect(tracksOf(c, skin).map(t => t.nodeIndex)).toEqual([99])
  })

  it('reads a Map-shaped nodeNames as well as entry pairs', () => {
    // A live `Skin` has Maps; a stored one has entry pairs. Both reach this.
    const tracks = tracksOf(clip(), { joints: skin.joints, nodeNames: new Map(skin.nodeNames) })
    expect(tracks[0].name).toBe('Spine')
  })
})

describe('withKey', () => {
  it('replaces the key already at that time', () => {
    const out = withKey(clip(), 1, 'rotation', 0.5, [0, 0, 1, 0])
    const s = samplerFor(out, 1, 'rotation')
    expect(s.input).toEqual([0, 0.5, 1])                          // no new key
    expect(s.output.slice(4, 8)).toEqual([0, 0, 1, 0])
  })

  it('inserts a new key in time order', () => {
    const s = samplerFor(withKey(clip(), 1, 'rotation', 0.25, [0, 0, 1, 0]), 1, 'rotation')
    expect(s.input).toEqual([0, 0.25, 0.5, 1])
    expect(s.output.slice(4, 8)).toEqual([0, 0, 1, 0])            // the value went in with the time
    expect(s.output).toHaveLength(16)                             // four keys x four components
  })

  it('creates a channel for a bone the clip never drove, spanning the clip', () => {
    const out = withKey(clip(), 2, 'rotation', 0.5, [0, 0, 1, 0], [0, 0, 0, 1])
    const s = samplerFor(out, 2, 'rotation')
    expect(s.input).toEqual([0, 0.5, 1])
    expect(s.output.slice(0, 4)).toEqual([0, 0, 0, 1])            // rest before...
    expect(s.output.slice(4, 8)).toEqual([0, 0, 1, 0])            // ...the authored key...
    expect(s.output.slice(8, 12)).toEqual([0, 0, 0, 1])           // ...and rest after
  })

  it('never creates a single-key channel', () => {
    // `Bone._getRotationIndex` returns `length - 2`, which is -1 for one key: a negative index reads
    // undefined out of `output` and poses the bone with NaNs. A collapsed skeleton from an ordinary edit.
    for (const time of [0, 1, 0.5]) {
      const out = withKey({ name: 'empty', samplers: [], channels: [] }, 1, 'rotation', time, [0, 0, 0, 1])
      expect(samplerFor(out, 1, 'rotation').input.length).toBeGreaterThanOrEqual(2)
    }
    // ...including on a clip whose duration lands exactly on the authored key.
    expect(samplerFor(withKey(clip(), 2, 'rotation', 1, [0, 0, 1, 0]), 2, 'rotation').input.length).toBeGreaterThanOrEqual(2)
  })

  it('does not mutate the clip it was given', () => {
    const c = clip()
    const before = JSON.parse(JSON.stringify(c))
    withKey(c, 1, 'rotation', 0.25, [0, 0, 1, 0])
    expect(JSON.parse(JSON.stringify(c))).toEqual(before)
  })

  it('UN-SHARES a sampler two channels point at', () => {
    // The bug this exists to stop: writing node 1 through a shared sampler also moves node 2 — and,
    // because output arrays are shared with the retarget cache, on other characters as well.
    const before = shared()
    const out = withKey(before, 1, 'rotation', 0, [0, 0, 1, 0])

    expect(samplerFor(out, 1, 'rotation').output.slice(0, 4)).toEqual([0, 0, 1, 0])   // written
    expect(samplerFor(out, 2, 'rotation').output.slice(0, 4)).toEqual([0, 0, 0, 1])   // untouched
    // The two channels no longer point at the same sampler...
    expect(out.channels[0].samplerIndex).not.toBe(out.channels[1].samplerIndex)
    // ...and the edited channel points at a sampler that really exists.
    expect(out.samplers[out.channels[0].samplerIndex]).toBeTruthy()
    // The original is still intact, shared sampler and all.
    expect(before.samplers).toHaveLength(1)
  })
})

describe('withoutKey', () => {
  it('removes the key and its values together', () => {
    const s = samplerFor(withoutKey(clip(), 1, 'rotation', 1), 1, 'rotation')
    expect(s.input).toEqual([0, 1])
    expect(s.output).toHaveLength(8)
    expect(s.output.slice(4, 8)).toEqual([0, 0, 0, 1])            // the LAST key survived, not the middle
  })

  it('refuses to go below two keys', () => {
    // Deleting the channel instead would snap the bone to its rest for the whole clip — a far bigger
    // change than "remove this key", and not what the artist asked for.
    const two = withoutKey(clip(), 1, 'rotation', 1)
    expect(withoutKey(two, 1, 'rotation', 0)).toBe(two)
  })

  it('ignores an index that is not there', () => {
    const c = clip()
    expect(withoutKey(c, 1, 'rotation', 9)).toBe(c)
    expect(withoutKey(c, 7, 'rotation', 0)).toBe(c)
  })

  it('un-shares before deleting', () => {
    const out = withoutKey({ ...shared(), samplers: [{ input: [0, 0.5, 1], output: new Array(12).fill(0), interpolation: 'LINEAR' }] }, 1, 'rotation', 1)
    expect(samplerFor(out, 1, 'rotation').input).toEqual([0, 1])
    expect(samplerFor(out, 2, 'rotation').input).toEqual([0, 0.5, 1])
  })
})

describe('withMovedKey', () => {
  it('carries the value with the key and keeps input sorted', () => {
    // Dragging a pose to a different moment, not swapping which pose happens when.
    const s = samplerFor(withMovedKey(clip(), 1, 'rotation', 1, 0.9), 1, 'rotation')
    expect(s.input).toEqual([0, 0.9, 1])
    expect(s.output.slice(4, 8)).toEqual([0, 0, 0.1, 0.99])       // the moved key's own value
  })

  it('reorders when a key is dragged past its neighbour', () => {
    const s = samplerFor(withMovedKey(clip(), 1, 'rotation', 0, 0.75), 1, 'rotation')
    expect(s.input).toEqual([0.5, 0.75, 1])
    expect([...s.input]).toEqual([...s.input].sort((a, b) => a - b))
  })

  it('REPLACES a key it is dropped onto', () => {
    // Two keys at the same time give a zero-length segment that the samplers divide by. Replacing also
    // matches what dropping one thing onto another means everywhere else.
    const s = samplerFor(withMovedKey(clip(), 1, 'rotation', 0, 0.5), 1, 'rotation')
    expect(s.input).toEqual([0.5, 1])
    expect(s.output.slice(0, 4)).toEqual([0, 0, 0, 1])            // the dragged key's value won
    expect(s.output).toHaveLength(8)
  })

  it('clamps a key dragged before zero', () => {
    expect(samplerFor(withMovedKey(clip(), 1, 'rotation', 1, -5), 1, 'rotation').input[0]).toBe(0)
  })

  it('does not mutate the clip it was given', () => {
    const c = clip()
    const before = JSON.parse(JSON.stringify(c))
    withMovedKey(c, 1, 'rotation', 1, 0.9)
    expect(JSON.parse(JSON.stringify(c))).toEqual(before)
  })
})

describe('helpers', () => {
  it('keyIndexAt tolerates float drift', () => {
    expect(keyIndexAt([0, 0.5, 1], 0.50001)).toBe(1)
    expect(keyIndexAt([0, 0.5, 1], 0.7)).toBe(-1)
  })

  it('clipDuration reads the furthest key, over every sampler', () => {
    expect(clipDuration(clip())).toBe(1)
    expect(clipDuration({ name: 'x', samplers: [], channels: [] })).toBe(0)
  })
})
