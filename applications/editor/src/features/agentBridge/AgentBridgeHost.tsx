import { useEffect, useRef } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'
import { APP_VERSION } from '../../version'
import { agentBridge } from './bridgeClient'
import { projectInfo, runCommand, type BridgeHost } from './commands'
import { attachAgentLogs } from './agentLogs'

/**
 * Hands the agent bridge (bridgeClient.ts) the editor to act on. Renders nothing. Mounted once inside the
 * editor shell, below HistoryProvider, so a command reaches the engine context AND the undo stack.
 *
 * The host is a ref refreshed on every render, read at call time: a command must see the libraries and
 * the play state as they are when it runs, not as they were when the link opened.
 */
export default function AgentBridgeHost() {
  const engine = useCleoEngine()
  const history = useHistory()
  const hostRef = useRef<BridgeHost>({ engine, history })
  hostRef.current = { engine, history }

  useEffect(() => {
    attachAgentLogs()
    agentBridge.setHost(
      (method, params) => runCommand(method, params, () => hostRef.current),
      async () => ({
        app: 'cleo-editor',
        version: APP_VERSION,
        origin: location.origin,
        desktop: typeof (window as any).cleoDesktop === 'object',
        project: await projectInfo(),
      }),
    )
    agentBridge.start()
    return () => { agentBridge.setHost(null); agentBridge.stop() }
  }, [])

  return null
}
