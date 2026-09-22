import type { StoredClip } from './animationAssets'

// Reading and writing a clip's keyframes, one bone at a time.
//
// Engine-free by design, like animationAssets.ts — the maths here is array surgery, and keeping it out of
// `cleo` is what lets it be unit-tested without a GL context.
//
// Two properties every mutator below holds to, both of which are silent when broken:
//
//  - **COPY ON WRITE, always.** glTF lets two channels share a sampler and `gltfLoader.parseAnimation`
//    copies the indices verbatim, so editing one in place can change a curve the artist was not looking
//    at. Worse, `output` arrays are shared with the retarget cache and with every clip resolved from this
//    asset, so an in-place write corrupts every cached resolve for the rest of the session — and the
//    symptom shows up on a DIFFERENT character.
//  - **`input` stays strictly increasing.** Every sampler read in the engine (`Bone._getRotationIndex`,
//    and `clipEdit.ts`'s `keyIndexAt`) walks it forward assuming that, and an out-of-order key does not
//    throw: it just makes one segment of the clip play backwards.

/** Values per keyframe for each animated property. */
export const STRIDE: Record<string, number> = { translation: 3, rotation: 4, scale: 3, weights: 1 }

export type TrackPath = 'translation' | 'rotation' | 'scale'

/** One bone's curves in a clip. A path is absent when the clip does not drive it. */
export type BoneTrack = {
  nodeIndex: number
  name: string | null
  /** The humanoid slot this bone maps to (`'foreArm.R'`), when it is a recognisable one. */
  slot: string | null
  translation?: { channel: number; keys: number[] }
  rotation?: { channel: number; keys: number[] }
  scale?: { channel: number; keys: number[] }
}

/** The clip's length: the largest time any sampler reaches. There is no authored duration field. */
export function clipDuration(clip: StoredClip): number {
  let max = 0
  for (const s of clip.samplers) if (s.input.length) max = Math.max(max, s.input[s.input.length - 1])
  return max
}

/**
 * Every bone the clip drives, with its curves, in the skeleton's own joint order.
 *
 * Ordered by the skin rather than by channel order so the track list reads top-down like the bone tree;
 * two exporters disagree about channel order and neither matches the hierarchy.
 */
export function tracksOf(
  clip: StoredClip,
  skin: { nodeNames?: [number, string][] | Map<number, string>; joints?: { nodeIndex: number }[] } | null,
  slotOf?: (name: string) => string | null,
): BoneTrack[] {
  const names = new Map<number, string>(
    skin?.nodeNames instanceof Map ? skin.nodeNames : (skin?.nodeNames ?? []))

  const byNode = new Map<number, BoneTrack>()
  clip.channels.forEach((ch, index) => {
    if (ch.targetPath !== 'translation' && ch.targetPath !== 'rotation' && ch.targetPath !== 'scale') return
    const sampler = clip.samplers[ch.samplerIndex]
    if (!sampler) return
    let track = byNode.get(ch.targetNodeIndex)
    if (!track) {
      const name = names.get(ch.targetNodeIndex) ?? null
      track = { nodeIndex: ch.targetNodeIndex, name, slot: name && slotOf ? slotOf(name) : null }
      byNode.set(ch.targetNodeIndex, track)
    }
    track[ch.targetPath as TrackPath] = { channel: index, keys: sampler.input.slice() }
  })

  // Joint order first, then anything else the clip animates (an assimp pivot is not in `skin.joints`).
  const out: BoneTrack[] = []
  const seen = new Set<number>()
  for (const j of skin?.joints ?? []) {
    const t = byNode.get(j.nodeIndex)
    if (t) { out.push(t); seen.add(j.nodeIndex) }
  }
  for (const [node, t] of byNode) if (!seen.has(node)) out.push(t)
  return out
}

/** The channel driving `(node, path)`, or -1. */
export function channelOf(clip: StoredClip, nodeIndex: number, path: TrackPath): number {
  return clip.channels.findIndex(c => c.targetNodeIndex === nodeIndex && c.targetPath === path)
}

/** Index of the key at `time`, within `eps`, or -1. */
export function keyIndexAt(input: number[], time: number, eps = 1e-4): number {
  for (let i = 0; i < input.length; i++) if (Math.abs(input[i] - time) <= eps) return i
  return -1
}

/**
 * A clip with `values` written at `time` on `(node, path)` — replacing the key already there, or inserting
 * a new one in order.
 *
 * Creates the channel when the clip does not drive that bone yet, seeded with `rest` so the bone's other
 * frames stay where they were rather than snapping to identity.
 *
 * A brand-new channel gets TWO keys, never one: `Bone._getRotationIndex` returns `length - 2`, which is -1
 * for a single-key sampler, and a negative index reads `undefined` out of `output` and poses the bone with
 * NaNs — a collapsed skeleton, from what looks like an ordinary edit.
 */
export function withKey(
  clip: StoredClip, nodeIndex: number, path: TrackPath, time: number, values: number[],
  rest?: number[],
): StoredClip {
  const stride = STRIDE[path]
  const at = Math.max(0, time)
  const channel = channelOf(clip, nodeIndex, path)

  if (channel < 0) {
    const seed = rest ?? values
    const duration = clipDuration(clip)
    // Span the clip so the bone is driven throughout, and put the authored key at `at`.
    const input: number[] = []
    const output: number[] = []
    const push = (t: number, v: number[]) => { input.push(t); output.push(...v.slice(0, stride)) }
    if (at > 1e-4) push(0, seed)
    push(at, values)
    if (duration > at + 1e-4) push(duration, seed)
    // Still short of two keys (an empty clip, or a key at both ends): hold the value for a beat.
    if (input.length < 2) push(at + Math.max(duration, 1), values)
    return {
      ...clip,
      samplers: [...clip.samplers, { input, output, interpolation: 'LINEAR' }],
      channels: [...clip.channels, { samplerIndex: clip.samplers.length, targetNodeIndex: nodeIndex, targetPath: path }],
    }
  }

  const samplerIndex = clip.channels[channel].samplerIndex
  const src = clip.samplers[samplerIndex]
  const input = src.input.slice()
  const output = src.output.slice()
  const existing = keyIndexAt(input, at)

  if (existing >= 0) {
    for (let c = 0; c < stride; c++) output[existing * stride + c] = values[c] ?? 0
  } else {
    let i = 0
    while (i < input.length && input[i] < at) i++
    input.splice(i, 0, at)
    output.splice(i * stride, 0, ...Array.from({ length: stride }, (_, c) => values[c] ?? 0))
  }
  return writeChannelSampler(clip, channel, { ...src, input, output })
}

/** A clip with the key at `index` on `(node, path)` removed. A two-key sampler is left alone. */
export function withoutKey(clip: StoredClip, nodeIndex: number, path: TrackPath, index: number): StoredClip {
  const channel = channelOf(clip, nodeIndex, path)
  if (channel < 0) return clip
  const samplerIndex = clip.channels[channel].samplerIndex
  const src = clip.samplers[samplerIndex]
  // Refuse to go below two keys rather than deleting the channel: a bone that stops being driven snaps to
  // its rest for the whole clip, which is a much bigger change than the artist asked for.
  if (index < 0 || index >= src.input.length || src.input.length <= 2) return clip
  const stride = STRIDE[path]
  const input = src.input.slice()
  const output = src.output.slice()
  input.splice(index, 1)
  output.splice(index * stride, stride)
  return writeChannelSampler(clip, channel, { ...src, input, output })
}

/**
 * A clip with the key at `index` on `(node, path)` moved to `time`, keeping `input` sorted.
 *
 * The value moves WITH the key — the artist is dragging a pose to a different moment, not swapping which
 * pose happens at which time.
 */
export function withMovedKey(
  clip: StoredClip, nodeIndex: number, path: TrackPath, index: number, time: number,
): StoredClip {
  const channel = channelOf(clip, nodeIndex, path)
  if (channel < 0) return clip
  const samplerIndex = clip.channels[channel].samplerIndex
  const src = clip.samplers[samplerIndex]
  if (index < 0 || index >= src.input.length) return clip

  const stride = STRIDE[path]
  const at = Math.max(0, time)
  const value = src.output.slice(index * stride, index * stride + stride)

  const input = src.input.slice()
  const output = src.output.slice()
  input.splice(index, 1)
  output.splice(index * stride, stride)

  // Landing on an existing key REPLACES it, matching what dropping one thing onto another means anywhere
  // else. Two keys at the same time would otherwise give a zero-length segment the samplers divide by.
  const collision = keyIndexAt(input, at)
  if (collision >= 0) {
    for (let c = 0; c < stride; c++) output[collision * stride + c] = value[c]
  } else {
    let i = 0
    while (i < input.length && input[i] < at) i++
    input.splice(i, 0, at)
    output.splice(i * stride, 0, ...value)
  }
  return writeChannelSampler(clip, channel, { ...src, input, output })
}

/**
 * A clip with `channel`'s sampler replaced by `next`, UN-SHARING it when another channel points at the
 * same one.
 *
 * Sharing is legal glTF and the loader preserves it, so writing through one channel would otherwise move
 * a bone the artist was not editing. Appending the new sampler and re-pointing only this channel is the
 * only way to write one bone without touching the other, and doing both halves here is deliberate: split
 * across two exported functions, a caller that forgot the second would leave the channel pointing at the
 * OLD sampler and the edit would silently do nothing.
 */
function writeChannelSampler(
  clip: StoredClip, channel: number, next: StoredClip['samplers'][number],
): StoredClip {
  const samplerIndex = clip.channels[channel].samplerIndex
  const shared = clip.channels.filter(c => c.samplerIndex === samplerIndex).length > 1
  if (!shared) return { ...clip, samplers: clip.samplers.map((s, i) => (i === samplerIndex ? next : s)) }
  return {
    ...clip,
    samplers: [...clip.samplers, next],
    channels: clip.channels.map((c, i) => (i === channel ? { ...c, samplerIndex: clip.samplers.length } : c)),
  }
}
