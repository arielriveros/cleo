import React, { useEffect } from 'react'
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { useCleoEngine } from '../../EngineContext'
import type { Node } from 'cleo'
import { Button, ButtonWithConfirm } from '../../../components/ui'
import { ensureMonaco } from './monacoSetup'
import { refreshMarkers } from './scriptMarkers'
import { registerNodeCompletionProvider } from './nodeCompletionProvider'
import { registerScriptHoverProvider } from './scriptHoverProvider'
import { registerScriptSnippetsProvider } from './scriptSnippetsProvider'
import { createThisTypeController, type ThisTypeController } from './thisTypeProvider'
import { useCodeTheme } from './codeThemeStore'
import CodeEditorHeader from './CodeEditorHeader'
import { DEFAULT_SCRIPT_TEMPLATE as description } from './scriptTemplate'

// Monaco counterpart to CodeEditor.tsx, behind the flag in ScriptEditor.tsx. Same external contract
// (props, the `scripts` Map, Add/Delete, the starter template, read-only, theme) so switching the flag
// is invisible to everything outside this pair of components.
//
// Differs from CodeEditor.tsx in one structural way: each node gets its OWN Monaco *model*, keyed by node
// id, instead of one document whose text gets swapped on selection change. The editor instance is still
// created once and only ever has its model swapped (editor.setModel) — the standard multi-document Monaco
// pattern, and it gives per-node undo history for free, which the single-document CodeMirror version does
// not have.
export default function MonacoCodeEditor(props: { readOnly?: boolean }) {
  const { selectedNode, scripts, editorScene, eventEmitter } = useCleoEngine()
  const theme = useCodeTheme()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const monacoRef = React.useRef<typeof Monaco | null>(null)
  const editorRef = React.useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = React.useRef<Map<string, Monaco.editor.ITextModel>>(new Map())
  const thisTypeRef = React.useRef<ThisTypeController | null>(null)
  const [hasScript, setHasScript] = React.useState(false)

  // Read through refs (not closed-over values) for the same reason as CodeEditor.tsx: the editor instance
  // and the two providers are created once, so they must reach whichever node/readOnly is *current*.
  const nodeRef = React.useRef<Node | null>(null)
  nodeRef.current = selectedNode ? editorScene.getNodeById(selectedNode) ?? null : null
  const readOnlyRef = React.useRef(!!props.readOnly)
  readOnlyRef.current = !!props.readOnly

  const getOrCreateModel = (monaco: typeof Monaco, nodeId: string, initialText: string): Monaco.editor.ITextModel => {
    const cached = modelsRef.current.get(nodeId)
    if (cached) return cached

    // Must be a file:/// URI, not inmemory://: TypeScript resolves `import ... from 'cleo'` by walking
    // node_modules within the model's OWN URI scheme, and the engine's types are registered under
    // file:///node_modules/cleo (cleoTypes.ts). An inmemory:// model can never reach them, so every cleo
    // import would resolve to nothing — no completions, a red "cannot find module 'cleo'" on line 1.
    const uri = monaco.Uri.parse(`file:///cleo/${nodeId}.ts`)
    // getModel first: a stale model can outlive this map across a fast-refresh/remount, and createModel
    // throws if a model already exists at the URI.
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(initialText, 'typescript', uri)
    modelsRef.current.set(nodeId, model)

    model.onDidChangeContent(() => {
      if (readOnlyRef.current) return // never write scripts for a read-only (template instance) node
      const id = nodeRef.current?.id
      if (!id) return
      scripts.set(id, model.getValue())
      const m = monacoRef.current
      if (m) refreshMarkers(m, model, nodeRef.current)
      // Node/Variables are unchanged on a keystroke, so the `this` lib is already current — only re-map
      // the typed-`this` diagnostics against the new text.
      thisTypeRef.current?.refresh(model, nodeRef.current)
    })

    return model
  }

  // Create the editor once. Providers are registered here too (not per node): both read the *current*
  // node through nodeRef, so one registration answers correctly for every node the panel ever shows.
  useEffect(() => {
    if (!containerRef.current) return
    const monaco = ensureMonaco()
    monacoRef.current = monaco

    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: true,
      minimap: { enabled: false },
      fixedOverflowWidgets: true,
      readOnly: readOnlyRef.current,
      theme: theme === 'light' ? 'cleo-light' : 'cleo-dark',
    })
    editorRef.current = editor

    const completionDisposable = registerNodeCompletionProvider(monaco, () => nodeRef.current)
    const snippetsDisposable = registerScriptSnippetsProvider(monaco)
    thisTypeRef.current = createThisTypeController(monaco)
    // Hover: cross-node Variable types from NodeResolver, everything else from the typed-`this` shadow.
    // Monaco's own TS hover stays disabled (monacoSetup) — the visible model types `this` as undefined.
    const hoverDisposable = registerScriptHoverProvider(monaco, () => nodeRef.current, thisTypeRef.current)

    return () => {
      completionDisposable.dispose()
      hoverDisposable.dispose()
      snippetsDisposable.dispose()
      thisTypeRef.current?.dispose()
      thisTypeRef.current = null
      editor.dispose()
      editorRef.current = null
      // Models outlive a single editor instance by design (undo history, SCENE_CHANGED re-lint while
      // unmounted), but not the component itself.
      for (const model of modelsRef.current.values()) model.dispose()
      modelsRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Bind whichever node is selected to the editor's model, creating it from the persisted script (or the
  // template, on "Add Script") the first time this node is seen. Also covers switching to a different node.
  useEffect(() => {
    if (!selectedNode) return
    const has = scripts.has(selectedNode)
    setHasScript(has)
    if (!has) return

    const monaco = monacoRef.current
    const editor = editorRef.current
    if (!monaco || !editor) return

    const model = getOrCreateModel(monaco, selectedNode, scripts.get(selectedNode) ?? '')
    editor.setModel(model)
    refreshMarkers(monaco, model, nodeRef.current)
    // Switching nodes changes the concrete `this` type: re-register the lib, then re-map diagnostics.
    thisTypeRef.current?.update(nodeRef.current)
    thisTypeRef.current?.refresh(model, nodeRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode, hasScript])

  // Re-lint on every Variables-panel change (add/remove/retype/re-scope), not just on typing — otherwise a
  // stale error/pass sits on screen until the script is next edited. CustomVariablesEditor emits this.
  useEffect(() => {
    const relint = () => {
      const monaco = monacoRef.current
      const model = editorRef.current?.getModel()
      if (!monaco || !model) return
      refreshMarkers(monaco, model, nodeRef.current)
      // A Variables edit changes the `this` interface (a Variable added/removed/retyped), so rebuild it.
      thisTypeRef.current?.update(nodeRef.current)
      thisTypeRef.current?.refresh(model, nodeRef.current)
    }
    eventEmitter.on('SCENE_CHANGED', relint)
    return () => { eventEmitter.off('SCENE_CHANGED', relint) }
  }, [eventEmitter])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !!props.readOnly })
  }, [props.readOnly])

  useEffect(() => {
    monacoRef.current?.editor.setTheme(theme === 'light' ? 'cleo-light' : 'cleo-dark')
  }, [theme])

  // Monaco's automaticLayout watches the container via ResizeObserver, which can miss the transition out
  // of `display: none` (no size change is observed while hidden). Force one layout pass right after the
  // container becomes visible.
  useEffect(() => {
    if (hasScript) editorRef.current?.layout()
  }, [hasScript])

  const handleAddScript = () => {
    if (!selectedNode) return
    scripts.set(selectedNode, description)
    setHasScript(true)
  }

  const handleDeleteScript = () => {
    if (!selectedNode) return
    scripts.delete(selectedNode)
    const model = modelsRef.current.get(selectedNode)
    if (model) { model.dispose(); modelsRef.current.delete(selectedNode) }
    setHasScript(false)
  }

  return (
    <div className='p-2'>
      {!hasScript && (
        <Button variant='primary' disabled={props.readOnly} onClick={handleAddScript}>
          Add Script
        </Button>
      )}
      <div style={{ display: hasScript ? 'block' : 'none' }} className='mt-2 border border-border rounded overflow-hidden'>
        <CodeEditorHeader />
        <div ref={containerRef} className='w-full min-h-[240px] max-h-[520px]' aria-label='Script editor' />
      </div>
      {hasScript && (
        <div className='mt-2'>
          <ButtonWithConfirm disabled={props.readOnly} onClick={handleDeleteScript}>Delete Script</ButtonWithConfirm>
        </div>
      )}
    </div>
  )
}
