// Where the explorer files the assets the Creator sync made, and what it calls their textures.
//
// The sync (creatorSync.ts) owns these; the asset index (VfsContext) reads them. A pinned asset always
// sits in its folder under /Creator -- the reconciler moves it back if anything else moved it -- and
// that folder is read-only in the explorer (useFileManagerBridge), because the next sync would undo any
// edit made there. A module store rather than React state: the sync runs outside any component.

import { useSyncExternalStore } from 'react'
import type { AssetKind } from '../../utils/vfs'

/** The explorer's root for Creator assets. */
export const CREATOR_ROOT = '/Creator'

export interface CreatorPins {
  /** `${kind}:${assetId}` -> the folder the asset is kept in. */
  folders: ReadonlyMap<string, string>
  /** Texture (and image) id -> a readable name, for textures a .glb registered under a hash id. */
  names: ReadonlyMap<string, string>
}

let pins: CreatorPins = { folders: new Map(), names: new Map() }
const listeners = new Set<() => void>()

export const pinKey = (kind: AssetKind, assetId: string) => `${kind}:${assetId}`

export function getCreatorPins(): CreatorPins { return pins }

export function setCreatorPins(next: CreatorPins): void {
  pins = next
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function useCreatorPins(): CreatorPins {
  return useSyncExternalStore(subscribe, getCreatorPins, getCreatorPins)
}

/** True for /Creator and anything inside it. */
export function isCreatorPath(path: string): boolean {
  return path === CREATOR_ROOT || path.startsWith(`${CREATOR_ROOT}/`)
}
