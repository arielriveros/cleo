import type { AddonModule } from '../addons/types'
import AgentChatPanel, { AgentChatToggle } from './AgentChatPanel'
import { terminalActions, terminalStore } from './terminalStore'

// The Claude Code addon (Project ▸ Addons): the Claude panel and its top-bar toggle. It runs on the MCP server
// addon (registry.ts `requires`), which owns the agent link the panel's terminal goes through. Loaded only while
// the project has it on, so the panel's stores -- which ask for the agent host as they load when the panel was
// left open -- and xterm stay out of a project without it.

const addon: AddonModule = {
  activate: () => ({
    slots: {
      editorAside: AgentChatPanel,
      topbarRight: AgentChatToggle,
    },
  }),
  // Turned off while it runs: end the Claude session before the panel goes. The agent link stays up with the
  // MCP server addon.
  deactivate: () => {
    if (terminalStore.getSnapshot().term?.running) terminalActions.stop()
  },
}

export default addon
