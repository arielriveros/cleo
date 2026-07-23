import { useRef } from 'react';

/**
 * Returns a referentially-stable object exposing the same callbacks, each delegating to the latest
 * render's version.
 *
 * Needed because the split-out slice contexts hold *actions* as well as state. Those actions are plain
 * closures re-created on every EngineProvider render, so putting them straight into a `useMemo` value
 * would change its identity every render and defeat the memo — every consumer of the slice would
 * re-render anyway. Wrapping them here keeps the memo dependent only on the actual state.
 *
 * The key set is captured on first render (our slices all have a fixed shape); keys added later are not
 * picked up.
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
