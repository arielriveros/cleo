// How the engine reports an error out of a user script: the same one-line text it always logged, plus
// where in the script it happened, so the Console can link to the line and the script editor can mark it.
//
// Every guarded call into a script (handlers, timers, perception, collision listeners, …) catches what the
// script throws so one bad script cannot take the frame down. Those catches used to log `${e}`, a string,
// and the stack — the only thing that says which line — went with it.
import { Logger } from "../logger";
import { scriptLocationOf } from "./scriptUrls";

/**
 * Log `${prefix}: ${error}` as an error in `scope`, with the error's script location (scriptUrls.ts
 * scriptLocationOf) attached as the entry's `source` when it has one.
 */
export function logScriptError(prefix: string, error: unknown, scope: string = 'Script'): void {
    const source = scriptLocationOf(error);
    Logger.error(`${prefix}: ${error}`, scope, source ? { source } : undefined);
}
