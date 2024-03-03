import React, { useEffect } from 'react'
import { EditorView, basicSetup } from "codemirror"
import { javascript, javascriptLanguage, scopeCompletionSource } from '@codemirror/lang-javascript'
import { EditorState } from "@codemirror/state"
import { useCleoEngine } from '../../EngineContext'
import { InputManager, Logger, ModelNode, Node } from 'cleo'
import './Styles.css'

const description = `/*
// This is a global object that contains all the functions and variables that can be used anywhere in the script.
global {
  logger(text: string) - Logs a message to the console
  input: {
    keys - An object containing the state of all keys
    mouse - An object containing the state of the mouse
  }
}

// This function will be executed when the node is spawned even before the scene starts.
function onSpawn() {}
// This function will be executed when the node is started, if the scene has already started this function will be executed immediately after the node is added to the scene.
function onStart() {}
// This function will be executed after rendering the frame.
function onUpdate(delta, time) {}

// This function will be executed when the node collides with another node.
function onCollision(other) {}
// This function will be executed when the node is triggered by another node.
function onTrigger(other) {}
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
