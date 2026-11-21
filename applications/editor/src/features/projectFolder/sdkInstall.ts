// The project's `cleo` package (.cleo/sdk/cleo), written each time a folder project opens in a build that has
// not written it yet: the engine's declarations (what VS Code and `npm run typecheck` type scripts against),
// the CLI behind `npm run play` / `npm run debug`, and — when this build ships it — the headless runtime that
// `npm test` runs scripts on. The main process copies what it has on disk; the declarations come from here,
// because the editor bundle already carries them (the in-editor code editor types scripts with the same set).

import { Logger } from 'cleo'
import { getProjectBridge } from './desktopProject'

const SDK = '.cleo/sdk/cleo/'

function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/** Write the SDK into `root` if it is not already current. Never throws: a project works without it. */
export async function installProjectSdk(root: string): Promise<void> {
  const bridge = getProjectBridge()
  if (!bridge) return
  try {
    const { workspaceTypeFiles } = await import('@cleo/app-kit/code/cleoTypes')
    const files = workspaceTypeFiles()
      // The package's own package.json is the main process's (it knows the version and what it shipped).
      .filter(f => f.rel !== 'node_modules/cleo/package.json')
      .map(f => ({ rel: f.rel.startsWith('node_modules/cleo/') ? SDK + f.rel.slice('node_modules/cleo/'.length) : f.rel, content: f.content }))
    const typesHash = fnv(files.map(f => `${f.rel}:${f.content.length}:${fnv(f.content)}`).join('|'))
    const res = await bridge.installSdk(root, typesHash)
    if (!res.ok) { Logger.warn(`Could not write the project's script tools (.cleo/sdk): ${res.error}`, 'Editor'); return }
    if (!res.needTypes) return
    for (let i = 0; i < files.length; i += 150) {
      const batch = await bridge.writeScaffold(root, files.slice(i, i + 150))
      if (!batch.ok) { Logger.warn(`Could not write the engine's declarations: ${batch.error}`, 'Editor'); return }
    }
    await bridge.writeScaffold(root, [{ rel: SDK + '.types', content: typesHash }])
  } catch (e) {
    Logger.warn(`Could not write the project's script tools: ${(e as Error)?.message ?? e}`, 'Editor')
  }
}
