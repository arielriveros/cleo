import { createContext, useContext } from 'react';

/**
 * The play-mode lifecycle slice, split out of the large EngineContext.
 *
 * `isPlayMode` and the play controls are read by the toolbar, viewport and gizmo. The state lives in and
 * is driven by EngineProvider (starting/stopping Play swaps the live scene); this context re-exposes it as
 * a narrow, memoized value so a consumer that only drives playback need not depend on the whole context.
 * The action wrappers are referentially stable, so the value changes only when `isPlayMode` flips.
 */
export interface PlaybackContextValue {
  isPlayMode: boolean;
  startPlay: () => void;
  stopPlay: () => void;
  pausePlay: () => void;
}

export const PlaybackContext = createContext<PlaybackContextValue | null>(null);

/** Read the play-mode slice. Provided by EngineProvider. */
export function usePlayback(): PlaybackContextValue {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error('usePlayback must be used within an EngineProvider');
  return ctx;
}
