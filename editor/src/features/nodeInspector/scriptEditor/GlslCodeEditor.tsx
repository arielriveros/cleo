import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'

/**
 * A minimal CodeMirror text editor for GLSL fragment-shader source. No GLSL language mode is installed,
 * so it runs as plain text with `basicSetup` (line numbers, brackets, undo). The parent owns the value;
 * edits are pushed out via `onChange`, and a compile-error banner is rendered from the `error` prop.
 */
export default function GlslCodeEditor(props: { value: string, onChange: (src: string) => void, error?: string | null, readOnly?: boolean }) {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange

  // Create the editor once.
  useEffect(() => {
    if (!editorRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          EditorView.updateListener.of(u => { if (u.docChanged) onChangeRef.current(u.state.doc.toString()) }),
          EditorState.readOnly.of(!!props.readOnly),
        ],
      }),
      parent: editorRef.current,
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, [])

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
      <div ref={editorRef} className='w-full bg-white text-black text-xs min-h-[260px] max-h-[440px] overflow-auto border border-[#2d2d77] rounded' />
      {props.error && (
        <pre className='mt-1 whitespace-pre-wrap text-[11px] text-red-300 bg-[#3a1212] border border-red-800 rounded p-2 max-h-[160px] overflow-auto'>{props.error}</pre>
      )}
    </div>
  )
}
