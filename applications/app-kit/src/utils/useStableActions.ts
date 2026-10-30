import { useRef } from 'react';

/**
 * A referentially-stable object exposing the same callbacks, each delegating to the latest render's
 * version. Slice-context actions are closures re-created every EngineProvider render, so passing them
 * into a `useMemo` value directly defeats the memo; wrapping them here keeps it dependent on state alone.
 *
 * The key set is captured on FIRST render — keys added later are not picked up.
 */
export function useStableActions<T extends Record<string, (...args: any[]) => any>>(actions: T): T {
  const latest = useRef(actions);
  latest.current = actions;

  const stable = useRef<T | null>(null);
  if (stable.current === null) {
    const out: Record<string, (...args: any[]) => any> = {};
    for (const key of Object.keys(actions))
      out[key] = (...args: any[]) => latest.current[key](...args);
    stable.current = out as T;
  }
  return stable.current;
}
