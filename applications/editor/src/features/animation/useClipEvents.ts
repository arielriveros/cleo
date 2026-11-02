import { useCallback, useRef } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useHistory } from '../HistoryContext'
import { sortEvents, type ClipEvent } from '../../utils/clipEvents'
import type { StoredClip } from '../../utils/animationAssets'

// The editor's only writes to a clip: its events, its root-motion flag, and dropping a legacy edit stack.
// Motion itself is authored in Cleo Creator.
//
// Every write goes straight into the `.anim` in the library (`editSharedClip`), which re-resolves the clip on
// every character playing it and emits ANIM_CLIPS_CHANGED. There is no working copy and nothing to save:
// the same write serves the Clip Player and the Animator's transport, where the clip is not the document
// being edited at all. Undo is a hand-built entry on the active tab's stack — the scene recorder cannot see
// a library asset.

export type ClipPatch = Partial<Pick<StoredClip, 'rootMotion' | 'events' | 'edits'>>

const NONE: readonly ClipEvent[] = []

/** Write one clip of a `.anim` asset, as one undo step. */
export function useClipAssetEdit() {
  const { animations } = useAssetLibrary()
  const { editSharedClip } = useCleoEngine()
  const { push } = useHistory()
  const animationsRef = useRef(animations)
  animationsRef.current = animations

  return useCallback((assetId: string, clipName: string, patch: ClipPatch, label: string) => {
    const clip = animationsRef.current.find(a => a.id === assetId)?.clips.find(c => c.name === clipName)
    if (!clip) return
    // Only the fields this write touches, so undoing it cannot revert an unrelated edit made since.
    const before: ClipPatch = {}
    for (const key of Object.keys(patch) as (keyof ClipPatch)[]) (before as any)[key] = clip[key]
    editSharedClip(assetId, clipName, patch)
    push({
      label,
      undo: () => editSharedClip(assetId, clipName, before),
      redo: () => editSharedClip(assetId, clipName, patch),
    })
  }, [editSharedClip, push])
}

/**
 * One clip's events, and the four edits a timeline makes to them.
 *
 * `editable` is false when the clip has no `.anim` asset to hold them — a clip embedded in a model — or the
 * asset no longer has a clip of that name. Every write keeps the list in time order and stores an empty list
 * rather than dropping the field: the Creator sync keeps a clip's events across a re-bake by checking
 * whether the clip has any, and an emptied list is a choice it must keep too.
 */
export function useClipEvents(assetId: string | undefined, clipName: string | undefined) {
  const { animations } = useAssetLibrary()
  const edit = useClipAssetEdit()
  const clip = assetId && clipName ? animations.find(a => a.id === assetId)?.clips.find(c => c.name === clipName) : undefined
  const events: readonly ClipEvent[] = clip?.events ?? NONE
  const editable = !!clip

  const write = (next: ClipEvent[], label: string) => {
    if (assetId && clipName && clip) edit(assetId, clipName, { events: sortEvents(next) }, label)
  }

  return {
    events,
    editable,
    add: (time: number, name: string) => write([...events, { time: Math.max(0, time), name }], 'Add event'),
    rename: (index: number, name: string) => write(events.map((e, i) => (i === index ? { ...e, name } : e)), 'Rename event'),
    move: (index: number, time: number) => write(events.map((e, i) => (i === index ? { ...e, time: Math.max(0, time) } : e)), 'Move event'),
    remove: (index: number) => write(events.filter((_, i) => i !== index), 'Delete event'),
  }
}
