import React, { Suspense } from 'react'
import { useCleoEngine } from '../../EngineContext'
import { BASE_TYPE_LABEL } from '../../../utils/scripts'

// Monaco (and monaco-editor itself) is heavy, so it downloads only when a Script tab is actually opened.
const MonacoScriptEditor = React.lazy(() => import('./MonacoScriptEditor'))

// The dedicated Script editor tab body: a full-height Monaco editor over the viewport for the active script
// tab. Edits go to the tab's working buffer (setScriptTabSource marks it dirty); the MenuBar's Save Script
// commits them to the asset. Rendered by ViewportPanel when editorMode === 'script'.
export default function ScriptTabView() {
  const { activeTab, scriptAssets, getScriptTabSource, setScriptTabSource } = useCleoEngine()
  if (activeTab.kind !== 'script' || !activeTab.scriptId) return null
  const scriptId = activeTab.scriptId
  const asset = scriptAssets.find(a => a.id === scriptId)

  return (
    <div className='absolute inset-0 flex flex-col bg-surface-raised text-white'>
      <div className='shrink-0 flex items-center gap-2 px-3 h-[30px] border-b border-border'>
        <span className='text-[12px] font-semibold truncate' title={asset?.name}>
          {asset?.name ?? 'Script'}
          {asset && <span className='ml-1 text-dim font-normal'>· extends {BASE_TYPE_LABEL[asset.baseType]}</span>}
        </span>
        <span className='ml-auto text-[11px] text-dim'>Save Script (top bar) applies changes to every node using it</span>
      </div>
      <div className='flex-1 min-h-0'>
        <Suspense fallback={<div className='p-3 text-dim text-[11px]'>Loading editor…</div>}>
          <MonacoScriptEditor
            key={scriptId}
            scriptId={scriptId}
            initialSource={getScriptTabSource(scriptId) ?? asset?.source ?? ''}
            onChange={(src) => setScriptTabSource(activeTab.id, scriptId, src)}
          />
        </Suspense>
      </div>
    </div>
  )
}
