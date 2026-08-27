import { createContext, useContext } from 'react';
import type { useCleoEngine } from './EngineContext';

type EngineValue = ReturnType<typeof useCleoEngine>;

/**
 * The open-documents slice: editor tabs, save orchestration and unsaved (dirty) state — one concern, since
 * a tab is the unit that gets marked dirty and saved. `withoutDirty` is included for sub-editors and
 * propagation that must mutate the live scene without it reading as user work; `markTabDirty` /
 * `clearTabDirty` are what non-engine edits (script buffers, animation apply, model LODs) call directly.
 */
export type DocumentContextValue = Pick<EngineValue,
  | 'tabs' | 'activeTabId' | 'activeTab' | 'setActiveTab' | 'closeTab' | 'reorderTabs'
  | 'saveActiveTab' | 'saveAll' | 'savingState'
  | 'dirtyTabs' | 'mainDirty' | 'markTabDirty' | 'clearTabDirty' | 'withoutDirty'
>;

export const DocumentContext = createContext<DocumentContextValue | null>(null);

/** Read the tabs / save / dirty slice. Provided by EngineProvider. */
export function useDocument(): DocumentContextValue {
  const ctx = useContext(DocumentContext);
  if (!ctx) throw new Error('useDocument must be used within an EngineProvider');
  return ctx;
}
