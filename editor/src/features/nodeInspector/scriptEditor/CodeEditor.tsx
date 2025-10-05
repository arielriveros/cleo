import React, { useEffect } from 'react'
import { EditorView, basicSetup } from "codemirror"
import { javascript, javascriptLanguage, scopeCompletionSource } from '@codemirror/lang-javascript'
import { EditorState } from "@codemirror/state"
import { useCleoEngine } from '../../EngineContext'
import { InputManager, Logger, ModelNode, Node } from 'cleo'
import './Styles.css'

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
    <>
      {!hasScript && <button onClick={handleAddScript}>Add Script</button>}
      <div style={{display: hasScript ?  'block' : 'none'}}>
        <div ref={editorRef} style={{width: '100%', backgroundColor: 'white', color: 'black'}} />
      </div>
      {hasScript && <button onClick={handleDeleteScript}>Delete Script</button>}
    </>
  )
}
