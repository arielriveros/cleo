import React, { Suspense } from 'react'
import Collapsable from '../../../components/Collapsable'
import CodeEditor from './CodeEditor'
import CustomVariablesEditor from './CustomVariablesEditor'
import TemplateInstanceNotice from '../TemplateInstanceNotice'
import { useSelectedNode, isRootNode } from '../useSelectedNode'
import { SegmentedControl } from '../../../components/ui'
import { useScriptEngine, scriptEngineStore, type ScriptEngine } from './scriptEngineStore'

// Monaco is lazy so it (and monaco-editor itself) only download once someone actually picks it — the
// default stays CodeMirror, the proven editor, until Monaco has seen more real-world use. See
// scriptEngineStore.ts for the rollback story.
const MonacoCodeEditor = React.lazy(() => import('./MonacoCodeEditor'))

const ENGINE_OPTIONS: { value: ScriptEngine; label: string }[] = [
  { value: 'codemirror', label: 'CodeMirror' },
  { value: 'monaco', label: 'Monaco (beta)' },
]

export default function ScriptEditor() {
  const { node, readOnly } = useSelectedNode()
  const engine = useScriptEngine()

  return (
    <>
      {readOnly && <TemplateInstanceNotice />}
      {/* Variables sit above the code: they are the data the script reads through getData/setData.
          The fieldset covers them only — the editor components drive their own read-only state because
          contentEditable ignores `fieldset disabled`. */}
      {node && !isRootNode(node) &&
        <fieldset disabled={readOnly} className={`${readOnly ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`}>
          <CustomVariablesEditor node={node} />
        </fieldset>}
      <Collapsable title='Script Editor'>
        <div className='flex justify-end px-2 pt-2'>
          <SegmentedControl<ScriptEngine> options={ENGINE_OPTIONS} value={engine} onChange={scriptEngineStore.set} size='sm' />
        </div>
        {engine === 'monaco'
          ? <Suspense fallback={<div className='p-2 text-dim text-[11px]'>Loading editor…</div>}>
              <MonacoCodeEditor readOnly={readOnly} />
            </Suspense>
          : <CodeEditor readOnly={readOnly} />}
      </Collapsable>
    </>
  )
}
