import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'
import { APP_VERSION } from '../../version'
import { agentBridge } from './bridgeClient'
import { CONCURRENT_METHODS, projectInfo, runCommand, type BridgeHost } from './commands'
import { attachAgentLogs } from './agentLogs'
import { panelStore } from '../agentChat/panelStore'

/**
 * Hands the agent bridge (bridgeClient.ts) the editor to act on. Renders nothing. Mounted once inside the
 * editor shell, below HistoryProvider, so a command reaches the engine context AND the undo stack.
 *
 * The host is a ref refreshed on every render, read at call time: a command must see the libraries and
 * the play state as they are when it runs, not as they were when the link opened.
 *
 * The link runs only while the Claude panel is open (agentChat/panelStore): until then the editor makes no
 * call to the agent host at all -- no discovery polls, no socket -- and closing the panel disconnects it.
 * An agent outside the editor (Claude Code in a terminal or an IDE) reaches the editor the same way, so it
 * needs the panel open too.
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
    return () => { agentBridge.setHost(null); agentBridge.stop() }
  }, [])

  const panelOpen = useSyncExternalStore(panelStore.subscribe, () => panelStore.getSnapshot().open)
  useEffect(() => {
    if (panelOpen) agentBridge.start()
    else agentBridge.stop()
  }, [panelOpen])

  return null
}
