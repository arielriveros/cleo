// The bridge between "open this script" (EngineContext.enterScriptEditor, which sits OUTSIDE the script
// workspace provider) and the workspace that can actually hand a file to VSCode (which sits inside the
// engine context). The workspace registers its opener here; the engine context asks through it.

type ExternalOpener = (scriptId: string) => Promise<boolean>;

let opener: ExternalOpener | null = null;

/** Registered by ScriptWorkspaceProvider; null while there is none (web, or not mounted yet). */
export function setExternalScriptOpener(fn: ExternalOpener | null): void {
  opener = fn;
}

/**
 * Open a script in the external editor. Resolves false when it could not — no desktop shell, the user
 * cancelled picking a workspace folder, or the launch failed — so the caller falls back to the built-in
 * editor rather than leaving the user with nothing opened.
 */
export async function openScriptExternally(scriptId: string): Promise<boolean> {
  if (!opener) return false;
  try { return await opener(scriptId); }
  catch { return false; }
}
