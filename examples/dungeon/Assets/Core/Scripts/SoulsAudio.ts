import type { Node } from 'cleo'

/**
 * Hollow Keep — sound cues. A script MODULE: every template that makes a sound OWNS it, as a SoundNode
 * child of a `Sounds` group in its own tree (the Player's swings, an enemy's roar, a lever's clank). A
 * script plays a cue by name and the nearest owner up its ancestry answers:
 *
 *   import { playSound } from '@/Core/Scripts/SoulsAudio'
 *   playSound(this, 'Lever')
 *
 * So a script deep inside a template (the Player's bonfire menu, an enemy's attack) plays its owner's
 * cues, and a template placed in any scene brings its sounds with it. A missing cue is silent.
 */

/** Name of the group, directly under an owner, that holds its SoundNodes. */
export const SOUNDS_GROUP = 'Sounds'

/** The SoundNode named `name` in the `Sounds` group of `from` or its nearest ancestor that has one. */
export function soundOf(from: Node, name: string): Node {
  if (!name) return null
  for (let n: Node = from; n; n = n.parent) {
    const group = n.getChildByName(SOUNDS_GROUP)[0]
    if (group) return group.getChildByName(name)[0] ?? null
  }
  return null
}

/** Play the cue `name` owned by `from` (or an ancestor). Silent when there is none. */
export function playSound(from: Node, name: string): void {
  const sound = soundOf(from, name) as any
  sound?.play?.()
}

/** Stop the cue `name` owned by `from` (or an ancestor). */
export function stopSound(from: Node, name: string): void {
  const sound = soundOf(from, name) as any
  sound?.stop?.()
}

/**
 * Play a cue whose owner is about to be REMOVED (a bolt hitting a wall): a despawned SoundNode stops,
 * so the cue is moved to the scene root where it is, plays there, and removes itself after `seconds`.
 */
export function playDetached(from: Node, name: string, seconds: number = 4): void {
  const sound = soundOf(from, name) as any
  const root = from?.scene?.root
  if (!sound || !root) return
  const at = Array.from(sound.worldPosition as ArrayLike<number>)
  root.addChild(sound)
  sound.setPosition([at[0], at[1], at[2]])
  sound.play?.()
  sound.after(seconds, () => { try { sound.remove() } catch { /* already gone */ } })
}
