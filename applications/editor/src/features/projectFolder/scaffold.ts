// The tooling a folder project carries around its data (the files themselves: scaffoldText.ts), written into a
// project folder through the desktop bridge (projectFolder.js writeScaffold, which allows tooling paths only).

import { getEditorPrefs } from '../options/editorPrefs'
import { requireProjectBridge } from './desktopProject'
import { DEFAULT_DEBUG_PORT, scaffoldFiles } from './scaffoldText'

export * from './scaffoldText'

/** Write the scaffold into a project folder: only the files it does not have yet. */
export async function writeProjectScaffold(root: string, name: string): Promise<void> {
  const port = getEditorPrefs().vscodeDebugPort ?? DEFAULT_DEBUG_PORT
  const res = await requireProjectBridge().writeScaffold(root, scaffoldFiles(name, port))
  if (!res.ok) throw new Error(res.error || 'Could not write the scaffold')
}
