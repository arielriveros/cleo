// "Open this saved asset": asked by the Assets explorer, answered by the tool that owns the asset's kind.
//
// The tool may not be mounted yet (the explorer switches to it first, and a tool's workspace loads on
// demand), so a request waits here until that tool's `useCreatorAsset` takes it.

import type { CreatorAssetKind } from '@cleo/app-kit/creatorLibrary';

let pending: { kind: CreatorAssetKind; id: string } | null = null;
const listeners = new Set<() => void>();

export function requestOpen(kind: CreatorAssetKind, id: string): void {
  pending = { kind, id };
  for (const fn of listeners) fn();
}

/** The asset waiting to be opened by the `kind` tool, consumed. */
export function takeOpen(kind: CreatorAssetKind): string | null {
  if (!pending || pending.kind !== kind) return null;
  const { id } = pending;
  pending = null;
  return id;
}

export function subscribeOpen(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
