import { sequencePresetsFor } from 'cleo'
import type { SequenceData, SequenceNode, SequenceSlot, SequenceTrack } from 'cleo'
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore'
import { toast } from '@cleo/app-kit/feedback/toastStore'

// What a slot's node can be driven by, and what a new section starts as: shared by the panel's + Track menu and
// lanes and the details' "Add section at the playhead". Bound nodes are probed the way the player probes them
// (sequencePlayer.ts), so what is offered here is what plays.

/** The parts of a node these probes read. */
type Probe = { nodeType?: string; animator?: unknown; model?: unknown; children?: readonly unknown[] } | null | undefined

/**
 * The node whose animator a slot's node animates with: its own, else the first one below it (a character's
 * model). As the player's `animatorOf`.
 */
export function animatorNodeOf(node: unknown): Probe {
  const n = node as Probe
  if (!n) return null
  const animator = n.animator as { playAction?: unknown } | null | undefined
  if (animator && typeof animator.playAction === 'function') return n
  for (const child of n.children ?? []) {
    const found = animatorNodeOf(child)
    if (found) return found
  }
  return null
}

/** The clips the node's animator can play (its model's animations), or none when there is no animator here. */
export function clipNamesOf(node: unknown): string[] {
  const animations = (animatorNodeOf(node)?.model as { animations?: { name?: string }[] } | null | undefined)?.animations
  return Array.isArray(animations) ? [...new Set(animations.map(a => a.name).filter((n): n is string => !!n))] : []
}

/**
 * The type of node a slot drives: its bound node's, else the slot's hint (an unbound slot: one a spawn fills,
 * or one found by its fallback path at runtime).
 */
function slotTypeOf(node: SequenceNode, slot: SequenceSlot): string | undefined {
  return node.resolveSlot(slot.id)?.nodeType ?? slot.nodeType
}

/** The slots a Possess track's controller can take over: every other one, characters first. */
export function pawnSlotsFor(node: SequenceNode, seq: SequenceData, controllerSlot: string): SequenceSlot[] {
  const others = seq.slots.filter(s => s.id !== controllerSlot)
  const isCharacter = (s: SequenceSlot) => slotTypeOf(node, s) === 'character'
  return [...others.filter(isCharacter), ...others.filter(s => !isCharacter(s))]
}

export interface TrackOffer { label: string; track: Omit<SequenceTrack, 'id'>; undo: string }

/**
 * The tracks a slot's node can take beyond Path and Property: presets for a node with a preset list, foliage for
 * a landscape, a script track on any node, animation for one with an animator (or below it), audio for a sound,
 * possession for a controller. An unbound slot is judged by its node type hint.
 */
export function slotTrackOffers(node: SequenceNode, slot: SequenceSlot): TrackOffer[] {
  const bound = node.resolveSlot(slot.id)
  const type = bound?.nodeType ?? slot.nodeType
  const out: TrackOffer[] = []
  const offer = (label: string, track: Record<string, unknown>) =>
    out.push({ label, track: { slot: slot.id, sections: [], ...track } as unknown as Omit<SequenceTrack, 'id'>, undo: `Add ${label.toLowerCase()} track` })
  if (sequencePresetsFor(bound ?? (slot.nodeType ?? null))) offer('Presets', { type: 'preset' })
  if (type === 'landscape') offer('Foliage', { type: 'foliage', layers: 'all' })
  offer('Script', { type: 'script' })
  if (bound ? animatorNodeOf(bound) : type === 'model' || type === 'character') offer('Animation', { type: 'animation' })
  if (type === 'sound') offer('Audio', { type: 'audio' })
  if (type === 'controller') offer('Possess', { type: 'possess' })
  return out
}

/**
 * What a new section on `track` starts as, or null when there is nothing to start it with: a preset blend into
 * the node's first preset, the animator's first clip, the project's first template, the first other slot as the
 * pawn (a character first). With no clip or template to offer it asks for the name (a slot a spawn fills shows
 * no clips while editing); with no slot to possess it says so.
 */
export async function newSectionInit(node: SequenceNode, seq: SequenceData, track: SequenceTrack,
                                     templates: readonly string[]): Promise<Record<string, unknown> | null> {
  switch (track.type) {
    case 'preset':
      return { preset: sequencePresetsFor(node.resolveSlot(track.slot) ?? null)?.[0]?.id ?? 'clear' }
    case 'animation': {
      const slotName = seq.slots.find(s => s.id === track.slot)?.name ?? track.slot
      const clip = clipNamesOf(node.resolveSlot(track.slot))[0] ?? await promptDialog({
        title: 'Clip to play',
        message: `${slotName} shows no clips here: it is unbound, or filled at runtime. The name of the clip to play:`,
        placeholder: 'Wave', confirmLabel: 'Add',
      })
      return clip?.trim() ? { clip: clip.trim() } : null
    }
    case 'spawn': {
      const template = templates[0] ?? await promptDialog({
        title: 'Template to spawn', message: 'The project has no templates yet. The name of the one to spawn:',
        placeholder: 'Bullet', confirmLabel: 'Add',
      })
      return template?.trim() ? { template: template.trim() } : null
    }
    case 'possess': {
      const pawn = pawnSlotsFor(node, seq, track.slot)[0]
      if (!pawn) { toast.info('Add a slot for the pawn first: the character the controller takes over.'); return null }
      return { pawn: pawn.id }
    }
    default:
      return {}
  }
}
