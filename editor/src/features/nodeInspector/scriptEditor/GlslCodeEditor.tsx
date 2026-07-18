import { useEffect, useRef } from 'react'
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { ensureMonaco } from './monacoSetup'
import { useCodeTheme } from './codeThemeStore'
import CodeEditorHeader from './CodeEditorHeader'

// A Monaco editor for GLSL fragment-shader source (language registered in glslMonaco.ts via ensureMonaco).
// The parent owns the value; edits are pushed out via `onChange`, and a compile-error banner is rendered
// from the `error` prop.
//
// `onSubmit` is bound to Ctrl/Cmd+Enter — the parent uses it to compile, which is a deliberate user action
// rather than something that happens while typing (see CustomMaterialEditor). `headerRight` puts controls
// in the header strip alongside the theme picker.
export default function GlslCodeEditor(props: {
  value: string,
  onChange: (src: string) => void,
  error?: string | null,
  readOnly?: boolean,
  onSubmit?: () => void,
  headerRight?: React.ReactNode,
}) {
  const theme = useCodeTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const readOnlyRef = useRef(!!props.readOnly)
  readOnlyRef.current = !!props.readOnly
  // Same ref indirection as onChange: the editor is created once, so the command handler installed below
  // must read the current prop rather than close over the one from first render.
  const onSubmitRef = useRef(props.onSubmit)
  onSubmitRef.current = props.onSubmit

  useEffect(() => {
    if (!containerRef.current) return
    const monaco = ensureMonaco()
    monacoRef.current = monaco
    // A unique in-memory model per editor instance — GLSL needs no cross-file/type resolution.
    const uri = monaco.Uri.parse(`inmemory://glsl/${Math.random().toString(36).slice(2)}.glsl`)
    const model = monaco.editor.createModel(props.value, 'glsl', uri)
    modelRef.current = model
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
    // Ctrl/Cmd+Enter compiles. Monaco swallows the keystroke itself, so this does not also insert a
    // newline. Registered unconditionally — the handler no-ops when the parent passes no onSubmit.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { onSubmitRef.current?.() })
    const sub = model.onDidChangeContent(() => {
      if (!readOnlyRef.current) onChangeRef.current(model.getValue())
    })
    return () => { sub.dispose(); editor.dispose(); model.dispose(); editorRef.current = null; modelRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { editorRef.current?.updateOptions({ readOnly: !!props.readOnly }) }, [props.readOnly])
  useEffect(() => { monacoRef.current?.editor.setTheme(theme === 'light' ? 'cleo-light' : 'cleo-dark') }, [theme])

  // Push external value changes (a reseed on base/mode change) into the model, guarded against the feedback
  // loop from our own onChange (which already made value === current text).
  useEffect(() => {
    const model = modelRef.current
    if (model && model.getValue() !== props.value) model.setValue(props.value)
  }, [props.value])

  return (
    <div className='p-1'>
      <div className='border border-border rounded overflow-hidden'>
        <CodeEditorHeader right={props.headerRight} />
        <div ref={containerRef} className='w-full h-[320px]' aria-label='Shader source editor' />
      </div>
      {props.error && (
        <pre className='mt-1 whitespace-pre-wrap text-[11px] text-danger bg-danger/10 border border-danger-border rounded p-2 max-h-[160px] overflow-auto'>{props.error}</pre>
      )}
    </div>
  )
}
