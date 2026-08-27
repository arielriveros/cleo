import { createContext, useContext } from 'react';
import type { useCleoEngine } from './EngineContext';

type EditorEventEmitter = ReturnType<typeof useCleoEngine>['eventEmitter'];

/**
 * The editor's UI event bus, on a context of its own. The emitter is a ref created once and never
 * replaced, so this context's value never changes identity: a consumer that reads only the bus never
 * re-renders from context.
 */
export const EventBusContext = createContext<EditorEventEmitter | null>(null);

/** Read the editor UI event bus. Provided by EngineProvider; stable for the whole session. */
export function useEventBus(): EditorEventEmitter {
  const ctx = useContext(EventBusContext);
  if (!ctx) throw new Error('useEventBus must be used within an EngineProvider');
  return ctx;
}
