// The Creator library: assets saved in Cleo Creator, shared with the Cleo Editor.
//
// Both apps run on one origin (the Creator at /creator/), so they share this IndexedDB database. The
// Creator writes an asset whenever it changes; the editor mirrors every asset into each project's
// /Creator folder and listens on the channel to follow edits live. See store.ts and channel.ts.

export type CreatorAssetKind = 'foliage' | 'fx' | 'world';

export const CREATOR_KINDS: readonly CreatorAssetKind[] = ['foliage', 'fx', 'world'];

/** One file an asset carries: a .glb, a PNG, a sidecar JSON... */
export interface CreatorFile {
  name: string;
  mime: string;
  blob: Blob;
}

/**
 * What an asset is, without its files. Listing reads only these, never the blobs.
 *
 * `revision` grows by one with every write that changed something, so a reader that has applied revision
 * N knows exactly whether it is behind. A delete leaves a tombstone (`deleted`, no files) at a new revision,
 * so a project that still uses the asset learns that it is gone rather than never hearing of it again.
 */
export interface CreatorAssetMeta {
  id: string;
  kind: CreatorAssetKind;
  name: string;
  /** The Creator's document: what reopening the asset in the Creator loads. Opaque to the editor. */
  doc: unknown;
  revision: number;
  /** A hash of every file's bytes and the document; a write with the same hash is skipped. */
  contentHash: string;
  updatedAt: number;
  /** The generator's sidecar (core/generator.ts `sidecar`), parsed: what the editor builds the asset from. */
  sidecar: Record<string, unknown> | null;
  /** Files the editor imports. */
  fileNames: string[];
  /** Files only the Creator reads back (a user's texture overrides): kept with the asset, never imported. */
  privateFileNames: string[];
  deleted?: true;
}

/** Messages on the `cleo-creator` BroadcastChannel, posted after the write commits. */
export type CreatorMessage =
  | { type: 'upsert'; id: string; revision: number }
  | { type: 'delete'; id: string; revision: number };
