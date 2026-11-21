import React, { Suspense, useMemo } from 'react'
import { useCleoEngine } from '../../EngineContext'
import { BASE_TYPE_LABEL, scriptKindOfAsset } from '../../../utils/scripts'
import { buildScriptGraphCtx, importSpecifierOf, scriptRoleLabel } from '../../../utils/scriptGraph'
import { useScriptWorkspace } from '../../scriptWorkspace/ScriptWorkspaceContext'
const NOT_DESKTOP_REASON = 'Opening a script in VS Code works in the Cleo desktop app, where a project is a folder.'
import { Button } from '@cleo/app-kit/ui/Button'
import { useBreakpoints } from '../../scriptDebugger/breakpoints'
import { canDebugScripts, useScriptDebugger } from '../../scriptDebugger/debugSession'
import { useEditorPrefs } from '../../options/editorPrefs'
import { desktopDebugPort } from '../../playWindow/desktopPlay'
import { usePlayTarget, writePlayTarget } from '../../playWindow/playTarget'

// Monaco (and monaco-editor itself) is heavy, so it downloads only when a Script tab is actually opened.
const MonacoScriptEditor = React.lazy(() => import('./MonacoScriptEditor'))

/**
 * What the script debugger has to say about this script, in the tab's header: that its breakpoints will
 * not stop a game playing in the editor (with the switch to Play in window), or that the game running now
 * was built before this script's latest edits.
 */
function DebugHint({ moduleId }: { moduleId: string }) {
  const breakpoints = useBreakpoints()
  const target = usePlayTarget()
  const debug = useScriptDebugger()
  const prefs = useEditorPrefs()
  const hasBreakpoints = breakpoints.some(b => b.moduleId === moduleId && b.enabled)
  // In the browser Cleo cannot drive the game's debugger: point at the one that can, prominently.
  if (!canDebugScripts() && hasBreakpoints) {
    return (
      <span className='shrink-0 rounded px-1.5 text-ui-sm text-warning bg-warning/10'
        title="A web page cannot drive another page's debugger. In the browser, Play in window, press F12 in the game window, and set breakpoints under Sources ▸ cleo-script://.">
        Breakpoints here work in the desktop app. In the browser, press F12 in the game window
      </span>
    )
  }
  if (prefs.scriptDebugWith === 'vscode' && desktopDebugPort() && hasBreakpoints) {
    return (
      <span className='shrink-0 rounded px-1.5 text-ui-sm text-highlight bg-highlight/10'
        title="Debug scripts with is set to VS Code (Options ▸ Editor ▸ Scripts), so Cleo's own debugger is off and these breakpoints wait for it.">
        Debugging with VS Code: set breakpoints there
      </span>
    )
  }
  if (debug.phase !== 'off' && debug.staleModules.includes(moduleId)) {
    return (
      <span className='shrink-0 rounded px-1.5 text-ui-sm text-warning bg-warning/10'
        title='The game running now was built from this script as it was before. Breakpoints you add or move here apply after you save and Restart.'>
        Changed since the game started: save and Restart to debug it
      </span>
    )
  }
  if (target !== 'editor' || debug.phase !== 'off' || !hasBreakpoints) return null
  return (
    <span className='shrink-0 flex items-center gap-1 text-ui-sm text-dim'>
      Breakpoints stop the game only when it plays in a window
      <Button size='sm' variant='subtle' className='h-[18px] px-1.5' onClick={() => writePlayTarget('window')}>Play in window</Button>
    </span>
  )
}

// The dedicated Script editor tab body. Edits go to the tab's working buffer (setScriptTabSource marks it
// dirty); the MenuBar's Save Script commits them to the asset. Rendered when editorMode === 'script'.
export default function ScriptTabView() {
  const { activeTab, scriptAssets, scriptPaths, getScriptTabSource, setScriptTabSource } = useCleoEngine()
  const workspace = useScriptWorkspace()
  const ctx = useMemo(() => buildScriptGraphCtx(scriptPaths, scriptAssets), [scriptPaths, scriptAssets])
  if (activeTab.kind !== 'script' || !activeTab.scriptId) return null
  const scriptId = activeTab.scriptId
  const asset = scriptAssets.find(a => a.id === scriptId)
  const moduleId = ctx.pathOf(scriptId)
  const role = asset ? scriptRoleLabel(asset, ctx) : null
  // How another script imports this one — shown so the project-path syntax is discoverable.
  const importAs = moduleId ? importSpecifierOf(moduleId) : null
  // Neither revealing a file nor setting the workspace up is possible in the browser, which has no
  // filesystem to mirror into.
  const connected = workspace.status !== 'off'

  return (
    <div className='absolute inset-0 flex flex-col bg-surface-raised text-fg'>
      <div className='shrink-0 flex items-center gap-2 px-3 h-[30px] border-b border-border'>
        <span className='text-ui font-semibold truncate' title={asset?.name}>
          {asset?.name ?? 'Script'}
          {asset && scriptKindOfAsset(asset) === 'module'
            ? <span className='ml-1 text-dim font-normal'>· Module</span>
            : asset && <span className='ml-1 text-dim font-normal'>· {role ?? `extends ${BASE_TYPE_LABEL[asset.baseType]}`}</span>}
        </span>
        {importAs && (
          <Button
            variant='ghost' size='sm'
            className='h-[20px] px-1 font-normal text-ui-sm text-dim hover:text-fg font-mono min-w-0 justify-start'
            title={`Other scripts import this one with: import … from '${importAs}' — click to copy`}
            onClick={() => void navigator.clipboard?.writeText(`'${importAs}'`)}
          >
            <span className='truncate'>import from '{importAs}'</span>
          </Button>
        )}
        {moduleId && <DebugHint moduleId={moduleId} />}
        <span className='ml-auto text-ui-sm text-dim truncate'>
          {asset && scriptKindOfAsset(asset) === 'module'
            ? 'Save Script (top bar) applies changes to every script importing it'
            : 'Save Script (top bar) applies changes to every node using it'}
        </span>
        <Button
          size='sm' variant='ghost' className='h-[20px] shrink-0'
          disabled={!workspace.available}
          title={workspace.available
            ? (connected ? 'Open this script in your external code editor' : 'Set up a folder you can open in VSCode')
            : NOT_DESKTOP_REASON}
          onClick={() => void (connected ? workspace.openInEditor(scriptId) : workspace.setup())}
        >
          {connected ? 'Open in VSCode' : 'Edit in VSCode…'}
        </Button>
      </div>
      <div className='flex-1 min-h-0'>
        <Suspense fallback={<div className='p-3 text-dim text-ui-sm'>Loading editor…</div>}>
          <MonacoScriptEditor
            key={scriptId}
            scriptId={scriptId}
            initialSource={getScriptTabSource(scriptId) ?? asset?.source ?? ''}
            onChange={(src) => setScriptTabSource(activeTab.id, scriptId, src)}
            assets={scriptAssets}
            pathOf={ctx.pathOf}
            savedSource={asset?.source}
          />
        </Suspense>
      </div>
    </div>
  )
}
