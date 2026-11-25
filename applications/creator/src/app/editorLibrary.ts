// Which Creator library this window uses, settled before anything reads it.
//
// Served on the editor's origin (the desktop app's app://editor/creator/, dev through the editor's /creator proxy),
// the Creator opens the shared library itself: nothing to do. On a site of its own (creator.cleoengine.com, the
// web build: VITE_CLEO_EDITOR_ORIGIN), it reaches the editor's library through the editor's storage frame
// (app-kit creatorLibrary/frame.ts); if that does not answer, it keeps a library of its own and says the editor
// will not see what it saves.

import { connectCreatorFrame } from '@cleo/app-kit/creatorLibrary/frame';
import { toast } from '@cleo/app-kit/feedback/toastStore';

/** The editor's origin, when it is not this page's: where the storage frame is. */
export function editorOriginToReach(configured: string | undefined, here: string): string | null {
  if (!configured) return null;
  let origin: string;
  try { origin = new URL(configured).origin; } catch { return null; }
  return origin === here ? null : origin;
}

/** Settle the library; resolves once reads and writes may begin. Never rejects. */
export async function settleEditorLibrary(): Promise<void> {
  const origin = editorOriginToReach(import.meta.env.VITE_CLEO_EDITOR_ORIGIN, location.origin);
  if (!origin) return;
  try {
    const result = await connectCreatorFrame(`${origin}/creator-library.html`);
    if (result.connected) return;
    console.warn(`[Creator library] ${result.reason}`);
  } catch (e) {
    console.warn('[Creator library] could not reach the editor\'s library', e);
  }
  toast.warning('What you save here is kept in this browser but will not appear in the editor until it reconnects. Reload to try again.', {
    title: 'Not syncing with the editor',
    duration: 0,
  });
}
