import { useEffect, useRef, useSyncExternalStore } from 'react'
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { ensureMonaco } from './monacoSetup'
import { useCodeTheme } from './codeThemeStore'
import CodeEditorHeader from './CodeEditorHeader'
import { subscribe, getRevision, externalSourceOf } from '../../scriptWorkspace/externalSourceStore'

// The Monaco code editor for a Script asset (the dedicated Script tab). A class-based script is a normal TS
// module — `class X extends Node { … }` — so Monaco's own TypeScript worker gives full IntelliSense against
// the engine's real types (registered by monacoSetup/cleoTypes): completions, signature help, hovers and
// error squiggles on `this.<member>`, imports, handler overrides, everything. The parent owns the working
// source (a per-tab buffer); edits are reported through `onChange` and committed by Save Script.
export default function MonacoScriptEditor(props: {
  scriptId: string
  initialSource: string
  onChange: (src: string) => void
  readOnly?: boolean
}) {
  const theme = useCodeTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const readOnlyRef = useRef(!!props.readOnly)
  readOnlyRef.current = !!props.readOnly
  // Bumped when the script workspace (VSCode) reports an edit to this script from disk.
  const externalRevision = useSyncExternalStore(subscribe, getRevision, getRevision)
  // While an external source is being written into the model, the content listener below must not report
  // it back out as a user edit — that would re-dirty the tab we are in the middle of reconciling.
  const applyingExternalRef = useRef(false)

  // Created once (the component is re-keyed per script by ScriptTabView, so one editor+model per script).
  useEffect(() => {
    if (!containerRef.current) return
    const monaco = ensureMonaco()
    monacoRef.current = monaco
    // A file:/// URI (not inmemory://) so `import … from 'cleo'` resolves against the engine types under
    // file:///node_modules/cleo (see cleoTypes.ts).
    const uri = monaco.Uri.parse(`file:///cleo/${props.scriptId}.ts`)
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(props.initialSource, 'typescript', uri)
    if (model.getValue() !== props.initialSource) model.setValue(props.initialSource)

    const editor = monaco.editor.create(containerRef.current, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      fixedOverflowWidgets: true,
      readOnly: readOnlyRef.current,
      theme: theme === 'light' ? 'cleo-light' : 'cleo-dark',
      fontSize: 13,
      scrollBeyondLastLine: false,
      tabSize: 2,
    })
    editorRef.current = editor

    const sub = model.onDidChangeContent(() => {
      if (!readOnlyRef.current && !applyingExternalRef.current) onChangeRef.current(model.getValue())
    })

    return () => { sub.dispose(); editor.dispose(); editorRef.current = null; model.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Take an edit made in the external script workspace. Applied as an edit operation rather than
  // setValue so the undo stack and (roughly) the cursor survive.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const incoming = externalSourceOf(props.scriptId)
    if (incoming === undefined || incoming === model.getValue()) return

    applyingExternalRef.current = true
    try {
      const selections = editor.getSelections()
      model.pushEditOperations(selections, [{ range: model.getFullModelRange(), text: incoming }], () => selections)
    } finally {
      applyingExternalRef.current = false
    }
  }, [externalRevision, props.scriptId])

  useEffect(() => { editorRef.current?.updateOptions({ readOnly: !!props.readOnly }) }, [props.readOnly])
  useEffect(() => { monacoRef.current?.editor.setTheme(theme === 'light' ? 'cleo-light' : 'cleo-dark') }, [theme])

  return (
    <div className='flex flex-col h-full'>
      <CodeEditorHeader />
      <div ref={containerRef} className='flex-1 min-h-0 w-full' aria-label='Script editor' />
    </div>
  )
}
