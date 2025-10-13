import React, { useEffect } from 'react'
import { EditorView, basicSetup } from "codemirror"
import { javascript, javascriptLanguage, scopeCompletionSource } from '@codemirror/lang-javascript'
import { EditorState } from "@codemirror/state"
import { useCleoEngine } from '../../EngineContext'
import { InputManager, Logger, ModelNode, Node } from 'cleo'

const description = `/*
// You can write full JavaScript here. Define helpers and export handlers.
// Two ways to declare handlers:
// 1) Top-level functions named onSpawn/onStart/onUpdate/onCollision/onTrigger
// 2) Or export them using module.exports = { onStart, onUpdate, ... }
// A minimal runtime is available:
//  - node: the current Node instance (e.g., node.addX(1))
//  - global.input: InputManager singleton
//  - global.logger(text): log to the engine console
//  - console.log/warn/error: forwarded to engine logs

function helperJump() {
  node.body && node.body.impulse([0, 8, 0]);
}

function onStart(node, global) {
  global.logger('Started: ' + node.name);
}

function onUpdate(node, delta, time, global) {
  if (global.input.isKeyPressed('Space')) helperJump();
}

// Alternatively, using module.exports:
// module.exports = {
//   onStart(node, global) { /* ... */ },
//   onUpdate(node, delta, time, global) { /* ... */ }
// };
*/`;

export default function CodeEditor() {
  const {selectedNode, scripts, editorScene} = useCleoEngine()
  const editorRef = React.useRef<HTMLDivElement>(null)
  const editorViewRef = React.useRef<EditorView | null>(null)
  const [editorText, setEditorText] = React.useState('')
  const [scriptText, setScriptText] = React.useState<string | null>(null)
  const [hasScript, setHasScript] = React.useState(false)
  

  useEffect(() => {
    if (!selectedNode || !scriptText) return
    scripts.set(selectedNode, scriptText)

  }, [scriptText])

  useEffect(() => {
    if (editorViewRef.current) {
      editorViewRef.current.dispatch({ changes: { from: 0, to: editorViewRef.current.state.doc.length, insert: editorText }})
    }
  }, [editorText])

  useEffect(() => {
    if (!selectedNode) return

    setHasScript(scripts.has(selectedNode))

    const script = scripts.get(selectedNode);
    if(script) {
      setEditorText(script);
    }
  }, [selectedNode, hasScript])

  useEffect(() => {
    if (!editorRef.current) return;
    editorViewRef.current = new EditorView({
      state: EditorState.create({
        doc: editorText,
        extensions: [
          basicSetup,
          javascript(),
          javascriptLanguage.data.of({
            autocomplete: scopeCompletionSource({
              global: {
                input: InputManager.prototype,
                logger: (text: string) => Logger.log(text)
              },
              node: editorScene.getNodeById(selectedNode!)?.nodeType === 'model' ? ModelNode.prototype : Node.prototype
            }),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              setScriptText(update.state.doc.toString())
            }
          }),
        ],
      }),      
      parent: editorRef.current
    });

  }, [])

  const handleAddScript = () => {
    if (!selectedNode) return;
    scripts.set(selectedNode, description);
    setEditorText(description);
    setScriptText(description);
    setHasScript(true);
  }

  const handleDeleteScript = () => {
    if (!selectedNode) return;
    scripts.delete(selectedNode);
    setEditorText('');
    setScriptText(null);
    setHasScript(false);
  }

  return (
    <div className='p-2'>
      {!hasScript && (
        <button
          className='px-3 py-1 rounded bg-[#326acc] hover:bg-[#2a59a9] text-white border border-[#274b8f]'
          onClick={handleAddScript}
        >
          Add Script
        </button>
      )}
      <div style={{display: hasScript ?  'block' : 'none'}} className='mt-2 border border-[#2d2d77] rounded overflow-hidden'>
        <div ref={editorRef} className='w-full bg-white text-black min-h-[240px]' />
      </div>
      {hasScript && (
        <button
          className='mt-2 px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white border border-red-700'
          onClick={handleDeleteScript}
        >
          Delete Script
        </button>
      )}
    </div>
  )
}
