import type { AddonModule } from '../addons/types'
import AgentBridgeChip from './AgentBridgeChip'
import AgentBridgeHost from './AgentBridgeHost'

// The MCP server addon (Project ▸ Addons): the agent link -- the editor's end of the Cleo MCP server
// (applications/mcp) -- and its "Agent" chip in the top bar. While it is on, the editor starts the agent host
// and links to it, so an AI agent (the Claude Code addon's panel, or Claude Code in a terminal or an IDE) can read
// and edit the open project. The Claude Code addon requires it. Turned off, its host component unmounts and
// closes the link (AgentBridgeHost).

const addon: AddonModule = {
  activate: () => ({
    slots: {
      topbarChips: AgentBridgeChip,
      background: AgentBridgeHost,
    },
  }),
}

export default addon
