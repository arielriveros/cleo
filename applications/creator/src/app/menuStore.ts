import type { CreatorAssetState } from '../core/useCreatorAsset';
import type { PrimaryAction } from './workspace';

// What the open app offers the Creator's menu bar (App.tsx): its saved asset (File ▸ Save as / Rename /
// Close), its output action (File ▸ the export), Frame and Reset Layout (View). The workspace an app is
// built from (workspace.tsx) publishes them here every render and clears them when it closes; the home
// page offers none.

export interface CreatorMenuSource {
  /** The app's saved-asset state (core/useCreatorAsset), when it saves assets. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asset?: CreatorAssetState<any>;
  primaryAction?: PrimaryAction;
  onFrame?: () => void;
  resetLayout?: () => void;
}

let current: CreatorMenuSource | null = null;
const listeners = new Set<() => void>();

export const creatorMenu = {
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  getSnapshot(): CreatorMenuSource | null { return current; },
  set(source: CreatorMenuSource | null) {
    if (source === current) return;
    current = source;
    for (const cb of [...listeners]) cb();
  },
};
