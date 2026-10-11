import { useEffect, useRef, useSyncExternalStore } from 'react'
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { ensureMonaco } from './monacoSetup'
import { useCodeTheme } from './codeThemeStore'
import CodeEditorHeader from './CodeEditorHeader'
import { subscribe, getRevision, externalSourceOf } from '../../scriptWorkspace/externalSourceStore'
import { syncScriptModels, scriptModelFor } from './scriptModels'
import type { ScriptAsset } from '../../../utils/scripts'

// The Monaco code editor for a Script asset (the dedicated Script tab). A class-based script is a normal TS
// module, so Monaco's TypeScript worker types it against the engine's real declarations (monacoSetup /
// cleoTypes). The parent owns the working buffer; edits go out via `onChange` and are committed by Save.
export default function MonacoScriptEditor(props: {
  scriptId: string
  initialSource: string
  onChange: (src: string) => void
  readOnly?: boolean
  /** The script library and each script's module id, so imports between scripts type-check. */
  assets?: readonly ScriptAsset[]
  pathOf?: (assetId: string) => string | undefined
  /** The saved source, restored into the shared model when this tab closes with unsaved edits. */
  savedSource?: string
}) {
  const theme = useCodeTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const readOnlyRef = useRef(!!props.readOnly)
  readOnlyRef.current = !!props.readOnly
  const savedSourceRef = useRef(props.savedSource)
  savedSourceRef.current = props.savedSource
  // Bumped when the script workspace (VSCode) reports an edit to this script from disk.
  const externalRevision = useSyncExternalStore(subscribe, getRevision, getRevision)
  // While an external edit is being written into the model the content listener must not report it back
  // out as a user edit, which would re-dirty the tab being reconciled.
  const applyingExternalRef = useRef(false)

  // Created once: ScriptTabView re-keys this component per script, so there is one editor+model per script.
  useEffect(() => {
    if (!containerRef.current) return
    const monaco = ensureMonaco()
    monacoRef.current = monaco
    // Every script gets a model at its project path (scriptModels.ts), so `import … from './Util'` or
    // '@/Shared/Math' resolves against the scripts it names. This tab BORROWS the one for its script. A
    // script the explorer has not indexed yet falls back to a private model; either way a file:/// URI
    // (not inmemory://), so `import … from 'cleo'` resolves against the engine types (cleoTypes.ts).
    if (props.assets && props.pathOf) syncScriptModels(monaco, props.assets, props.pathOf)
    const shared = scriptModelFor(monaco, props.scriptId)
    const uri = shared?.uri ?? monaco.Uri.parse(`file:///cleo/${props.scriptId}.ts`)
    const model = shared ?? monaco.editor.getModel(uri) ?? monaco.editor.createModel(props.initialSource, 'typescript', uri)
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

    return () => {
      sub.dispose()
      editor.dispose()
      editorRef.current = null
      // A shared model stays for the other scripts that import this one, holding the SAVED source.
      if (shared) { if (savedSourceRef.current !== undefined && model.getValue() !== savedSourceRef.current) model.setValue(savedSourceRef.current) }
      else model.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the other scripts' models current while this tab is open: a module saved elsewhere, or a
  // script moved in the explorer, changes what this one's imports resolve to.
  useEffect(() => {
    const monaco = monacoRef.current
    if (monaco && props.assets && props.pathOf) syncScriptModels(monaco, props.assets, props.pathOf)
  }, [props.assets, props.pathOf])

  // External-workspace edits are applied as an edit operation rather than setValue, so the undo stack
  // and (roughly) the cursor survive.
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
