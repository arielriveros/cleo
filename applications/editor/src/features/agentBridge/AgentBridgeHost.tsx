import { useEffect, useRef } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'
import { APP_VERSION } from '../../version'
import { agentBridge } from './bridgeClient'
import { CONCURRENT_METHODS, projectInfo, runCommand, type BridgeHost } from './commands'
import { attachAgentLogs } from './agentLogs'
import { keepAgentHost } from './agentHost'
import { activeAddons } from '../addons/dependencies'

/** The Claude Code addon (addons/registry.ts), whose session this link stops in a project that has it off. */
const CLAUDE_CODE_ADDON = 'claude-code'

/**
 * Hands the agent bridge (bridgeClient.ts) the editor to act on. Renders nothing. Mounted by the MCP server
 * addon (./addon.tsx) in the editor's background slot, below HistoryProvider, so a command reaches the engine
 * context AND the undo stack.
 *
 * The host is a ref refreshed on every render, read at call time: a command must see the libraries and
 * the play state as they are when it runs, not as they were when the link opened.
 *
 * The link runs while the MCP server addon is on, Claude panel or not: it starts the agent host (agentHost.ts)
 * and links to it, so Claude Code in a terminal or an IDE reaches the open project as the panel's does. Turning
 * the addon off unmounts this and closes the link; the editor then makes no call to the agent host at all.
 */
export default function AgentBridgeHost() {
  const engine = useCleoEngine()
  const history = useHistory()
  const hostRef = useRef<BridgeHost>({ engine, history })
  hostRef.current = { engine, history }

  useEffect(() => {
    attachAgentLogs()
    agentBridge.setHost(
      (method, params, signal) => runCommand(method, params, () => hostRef.current, signal),
      async () => ({
        app: 'cleo-editor',
        version: APP_VERSION,
        origin: location.origin,
        desktop: typeof (window as any).cleoDesktop === 'object',
        project: await projectInfo(),
      }),
      CONCURRENT_METHODS,
    )
    agentBridge.start()
    const release = keepAgentHost()
    return () => { release(); agentBridge.setHost(null); agentBridge.stop() }
  }, [])

  // A Claude Code session outlives the project it was started in (the agent host runs it, and the Claude Code
  // addon leaves it running when a project closes, so the next one's panel carries on). A project with that
  // addon off must not have it working on it unseen: once linked, it is stopped. Its conversation stays saved.
  const { projectSettings, projectSettingsReady } = engine
  const claudeCodeOn = activeAddons(projectSettings.addons.enabled).some(a => a.id === CLAUDE_CODE_ADDON)
  useEffect(() => {
    if (!projectSettingsReady || claudeCodeOn) return
    let stoppedOn = -1
    const stopOnLink = () => {
      const b = agentBridge.getSnapshot()
      if (b.state !== 'connected' || b.link === stoppedOn || !b.capabilities.includes('terminal')) return
      stoppedOn = b.link
      agentBridge.sendTerm('stop')
    }
    stopOnLink()
    return agentBridge.subscribe(stopOnLink)
  }, [projectSettingsReady, claudeCodeOn])

  return null
}
