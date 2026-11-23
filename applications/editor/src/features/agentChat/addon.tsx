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
  // Turned off: end the Claude session before the panel goes (the agent link stays up with the MCP server addon).
  // A project closing leaves it running: Claude Code lives in the agent host, not the page, so the next
  // project's panel shows the same session. A next project with this addon off has it stopped by the agent link
  // (agentBridge/AgentBridgeHost.tsx).
  deactivate: reason => {
    if (reason === 'off' && terminalStore.getSnapshot().term?.running) terminalActions.stop()
  },
}

export default addon
