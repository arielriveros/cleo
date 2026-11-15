import type { AddonModule } from '../addons/types'
import AgentChatPanel, { AgentChatToggle } from './AgentChatPanel'
import AgentBridgeChip from '../agentBridge/AgentBridgeChip'
import AgentBridgeHost from '../agentBridge/AgentBridgeHost'
import { terminalActions, terminalStore } from './terminalStore'

// The Claude Code addon (Project ▸ Addons): the Claude panel, its top-bar toggle and link chip, and the agent
// bridge behind them. Loaded only while the project has it on, so the panel's stores -- which start the agent
// host as they load when the panel was left open -- and xterm stay out of a project without it.

const addon: AddonModule = {
  activate: () => ({
    slots: {
      editorAside: AgentChatPanel,
      topbarRight: AgentChatToggle,
      topbarChips: AgentBridgeChip,
      background: AgentBridgeHost,
    },
  }),
  // Turned off while it runs: end the Claude session before the panel goes. The bridge stops as its host
  // component unmounts (AgentBridgeHost).
  deactivate: () => {
    if (terminalStore.getSnapshot().term?.running) terminalActions.stop()
  },
}

export default addon
