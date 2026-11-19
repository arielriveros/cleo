import { useEffect } from 'react';
import { Logger } from "cleo";
import { ModelAsset } from "../utils/models";
import { writeModelLibrary } from "../utils/modelStore";
import { saveToStorage } from "../workers/workerClient";
import { scheduleProjectWrite } from "../utils/projectLifecycle";

/**
 * Persist an asset library to IndexedDB whenever it changes. A write rewrites the WHOLE array, so it is
 * debounced and goes through the project worker (saveToStorage) to keep the transaction off-thread.
 */
export function usePersistedLibrary<T>(key: string, value: T, loaded: React.MutableRefObject<boolean>): void {
  useEffect(() => {
    if (!loaded.current) return; // don't write back before the initial read lands (would clobber it)
    // Scheduled through the project's writes: switching to another project runs it at once, under this `key`
    // (computed for the project it was edited in), instead of losing it (utils/projectLifecycle.ts).
    return scheduleProjectWrite(400, () =>
      // Logger, not console.warn: a library that silently stops persisting is the worst outcome here —
      // the user keeps working and loses everything on reload with nothing on screen having said so.
      saveToStorage(key, value).catch(e => Logger.error(`Failed to save ${key}: ${e}`, 'Editor')));
  }, [key, value, loaded]);
}

/**
 * The models library, persisted one record per asset (utils/modelStore).
 *
 * It cannot use {@link usePersistedLibrary}: that writes the whole value under one key, and a model
 * library is large enough that doing so on every edit is what broke persistence in the first place.
 * `persisted` is what storage already holds, so each pass writes only the assets that actually changed.
 *
 * That ref is SEEDED by the load with the assets it read, and that seeding is load-bearing: starting it
 * empty would make the first debounce after every boot diff the whole library against nothing and rewrite
 * every asset — the exact write this hook exists to avoid, just moved to startup.
 */
export function usePersistedModelLibrary(
  models: ModelAsset[],
  loaded: React.MutableRefObject<boolean>,
  persisted: React.MutableRefObject<ModelAsset[]>,
): void {
  useEffect(() => {
    if (!loaded.current) return;
    return scheduleProjectWrite(400, () => {
      const prev = persisted.current;
      // Claim the write BEFORE awaiting: a second edit landing mid-write must diff against what this pass
      // is persisting, not against the state before it, or its changes are never written at all.
      persisted.current = models;
      return writeModelLibrary(models, prev).catch(e => {
        persisted.current = prev; // failed — the next pass must retry these assets
        Logger.error(`Failed to save the model library: ${e}`, 'Editor');
      });
    });
  }, [models, loaded, persisted]);
}
