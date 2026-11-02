// Events live on the CLIP (`StoredClip.events` in its `.anim`), so they fire wherever it plays: a state, a
// layer, an action slot, any animator. Machines used to carry their own markers keyed by clip name
// (`AnimationStateMachine.events`); the engine still fires those, so an unmigrated scene or a published
// game keeps working, but the editor no longer authors them. `liftMachineEvents` moves them onto the clips
// when an animator is opened.
//
// Engine-free (type imports only), so it is unit-tested on its own.

import type { AnimationEventMarker, AnimationStateMachine } from 'cleo'
import type { AnimationAsset, StoredClip } from './animationAssets'

export type ClipEvent = NonNullable<StoredClip['events']>[number]

/** Two markers closer than this are the same moment. */
const SAME_TIME = 1e-4

/** A clip's events in time order — the order the timeline draws them and the engine fires them. */
export function sortEvents(events: readonly ClipEvent[]): ClipEvent[] {
  return [...events].sort((a, b) => a.time - b.time)
}

/** Whether `list` already has an event of this name at this moment. */
export function hasEvent(list: readonly ClipEvent[], e: ClipEvent): boolean {
  return list.some(x => x.name === e.name && Math.abs(x.time - e.time) < SAME_TIME)
}

export interface LiftedEvents {
  /** The machine without the markers that moved. The same object when none did. */
  machine: AnimationStateMachine
  /** Every clip that gained events, with its whole new list (sorted). */
  clips: { assetId: string; clipName: string; events: ClipEvent[] }[]
  /** How many markers left the machine, including ones the clip already had. */
  moved: number
}

/**
 * Move a machine's event markers onto the clips they name.
 *
 * A marker moves when its clip comes from a `.anim` asset (`clipAssetIds` maps a clip name to the asset it
 * was resolved from, as `Animation.assetId` does) and that asset holds a clip of that name. A marker the
 * clip already has — same name, same moment — is dropped from the machine without being added twice. The
 * rest stay on the machine: a clip embedded in the model has no asset to hold them, and the engine still
 * fires machine markers.
 */
export function liftMachineEvents(
  sm: AnimationStateMachine,
  clipAssetIds: ReadonlyMap<string, string | undefined>,
  animations: readonly Pick<AnimationAsset, 'id' | 'clips'>[],
): LiftedEvents {
  const markers = sm.events ?? []
  if (!markers.length) return { machine: sm, clips: [], moved: 0 }

  const kept: AnimationEventMarker[] = []
  // `${assetId}\n${clipName}` -> the clip's growing event list.
  const touched = new Map<string, { assetId: string; clipName: string; events: ClipEvent[]; added: boolean }>()
  let moved = 0

  for (const m of markers) {
    const assetId = m.clipName ? clipAssetIds.get(m.clipName) : undefined
    const stored = assetId ? animations.find(a => a.id === assetId)?.clips.find(c => c.name === m.clipName) : undefined
    if (!assetId || !stored) { kept.push(m); continue }
    const key = `${assetId}\n${m.clipName}`
    let entry = touched.get(key)
    if (!entry) {
      entry = { assetId, clipName: m.clipName, events: [...(stored.events ?? [])], added: false }
      touched.set(key, entry)
    }
    const event: ClipEvent = { time: m.time, name: m.eventName }
    if (!hasEvent(entry.events, event)) { entry.events.push(event); entry.added = true }
    moved++
  }

  if (!moved) return { machine: sm, clips: [], moved: 0 }
  return {
    machine: { ...sm, events: kept },
    clips: [...touched.values()].filter(e => e.added).map(e => ({ assetId: e.assetId, clipName: e.clipName, events: sortEvents(e.events) })),
    moved,
  }
}
