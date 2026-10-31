// The Creator library's change feed: a BroadcastChannel every same-origin window shares. The Creator
// posts after each committed write; the editor's sync listens. BroadcastChannel never delivers to the
// sender's own object, so a window that both writes and listens hears only the others -- `post` also
// tells this window's own listeners, so a single window (or a test) sees its writes too.

import type { CreatorMessage } from './types';

const NAME = 'cleo-creator';

export interface CreatorChannel {
  post(msg: CreatorMessage): void;
  /** Listen; returns the unsubscribe. */
  subscribe(fn: (msg: CreatorMessage) => void): () => void;
}

let channel: CreatorChannel | null = null;
let open: BroadcastChannel | null = null;

export function creatorChannel(): CreatorChannel {
  if (channel) return channel;
  const listeners = new Set<(msg: CreatorMessage) => void>();
  const bc = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NAME);
  open = bc;
  if (bc) bc.onmessage = (e: MessageEvent<CreatorMessage>) => { for (const fn of listeners) fn(e.data); };
  channel = {
    post(msg) {
      bc?.postMessage(msg);
      for (const fn of listeners) fn(msg);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
  return channel;
}

/** Drop the channel (tests): the next `creatorChannel()` opens a fresh one. */
export function resetCreatorChannel(): void { open?.close(); open = null; channel = null; }
