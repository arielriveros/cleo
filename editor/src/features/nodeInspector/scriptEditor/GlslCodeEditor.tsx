import { useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { codeSetup, readOnlyExtension } from './codeSetup'
import { getCodeTheme } from './codeMirrorTheme'
import { useCodeTheme } from './codeThemeStore'
import { glsl } from './glslLanguage'
import CodeEditorHeader from './CodeEditorHeader'

/**
 * A CodeMirror editor for GLSL fragment-shader source, parsed with the C grammar (see glslLanguage.ts).
 * The parent owns the value; edits are pushed out via `onChange`, and a compile-error banner is rendered
 * from the `error` prop.
 */
export default function GlslCodeEditor(props: { value: string, onChange: (src: string) => void, error?: string | null, readOnly?: boolean }) {
  const theme = useCodeTheme()
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const readOnlyComp = useRef(new Compartment())
  const themeComp = useRef(new Compartment())
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange

  // Create the editor once.
  useEffect(() => {
    if (!editorRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: props.value,
        extensions: codeSetup({
          language: glsl(),
          themeCompartment: themeComp.current,
          readOnlyCompartment: readOnlyComp.current,
          initialTheme: theme,
          initialReadOnly: !!props.readOnly,
          onDocChange: (doc) => onChangeRef.current(doc),
        }),
      }),
      parent: editorRef.current,
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, [])

  // Both of these reconfigure the live view rather than recreating it, so the undo history survives. They
  // dispatch effects with no `changes`, so they cannot feed back into onChange (and from there into the
  // parent's debounced shader recompile).
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(getCodeTheme(theme)) })
  }, [theme])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyComp.current.reconfigure(readOnlyExtension(!!props.readOnly)) })
  }, [props.readOnly])

  // Push external value changes (e.g. a reseed on base/mode change) into the editor. Guarded against the
  // feedback loop from our own onChange (which already made value === current doc).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== props.value)
      view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } })
  }, [props.value])

  return (
    <div className='p-1'>
      <div className='border border-border rounded overflow-hidden'>
        <CodeEditorHeader />
        <div ref={editorRef} className='w-full min-h-[260px] max-h-[440px] overflow-auto' aria-label='Shader source editor' />
      </div>
      {props.error && (
        <pre className='mt-1 whitespace-pre-wrap text-[11px] text-danger bg-danger/10 border border-danger-border rounded p-2 max-h-[160px] overflow-auto'>{props.error}</pre>
      )}
    </div>
  )
}
