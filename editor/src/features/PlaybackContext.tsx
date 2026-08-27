import { createContext, useContext } from 'react';

/**
 * The play-mode lifecycle slice. `isPlayMode` and the play controls are read by the toolbar, viewport and
 * gizmo; the state lives in EngineProvider, where starting/stopping Play swaps the live scene. The action
 * wrappers are referentially stable, so this value changes only when `isPlayMode` flips.
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
