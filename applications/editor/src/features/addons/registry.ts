import type { AddonManifest } from './types'

// The addons the editor ships with. Each loads its module only when a project turns it on (Project ▸ Addons).

export const BUILT_IN_ADDONS: readonly AddonManifest[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'A Claude Code terminal beside the editor, with the agent link that lets Claude read and edit the open project.',
    version: '1.0.0',
    author: 'Cleo',
    docPage: 'editor/ai-agent-link',
    defaultOn: true,
    confirmDisable: 'Turning Claude Code off ends its running session and closes the agent link.',
    load: () => import('../agentChat/addon').then(m => m.default),
  },
]

/** A built-in addon by id. */
export function addonById(id: string): AddonManifest | undefined {
  return BUILT_IN_ADDONS.find(a => a.id === id)
}
