import type { AddonManifest } from './types'

// The addons the editor ships with. Each loads its module only when a project turns it on (Project ▸ Addons).
// An addon that `requires` another runs only while that one is on too (dependencies.ts).

export const BUILT_IN_ADDONS: readonly AddonManifest[] = [
  {
    id: 'mcp-server',
    name: 'MCP server',
    description: 'The Cleo MCP server and the agent link: an AI agent (Claude Code here, in a terminal or in an IDE) reads and edits the open project through it.',
    version: '1.0.0',
    author: 'Cleo',
    docPage: 'editor/ai-agent-link',
    defaultOn: true,
    confirmDisable: 'Turning the MCP server off closes the agent link: no agent can reach this project until it is back on.',
    load: () => import('../agentBridge/addon').then(m => m.default),
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'A Claude Code terminal beside the editor, working on the open project through the MCP server.',
    version: '1.0.0',
    author: 'Cleo',
    docPage: 'editor/ai-agent-link',
    defaultOn: true,
    experimental: true,
    confirmDisable: 'Turning Claude Code off ends its running session.',
    requires: ['mcp-server'],
    load: () => import('../agentChat/addon').then(m => m.default),
  },
]

/** A built-in addon by id. */
export function addonById(id: string): AddonManifest | undefined {
  return BUILT_IN_ADDONS.find(a => a.id === id)
}
