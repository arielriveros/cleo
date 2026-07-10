import React, { useEffect } from 'react'
import { EditorView, basicSetup } from "codemirror"
import { javascript, javascriptLanguage, scopeCompletionSource } from '@codemirror/lang-javascript'
import { EditorState, Compartment } from "@codemirror/state"
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
//  - scene: the current Scene; findNode(name): first node with that name
//  - getData(node): read a node's custom Variables (returns { name: value, ... })
//  - setData(node, name, value): write a variable (works on ANY node)
//      const hp = getData(other).HealthPoints;
//      setData(other, 'HealthPoints', hp - 1);

function helperJump() {
  node.body && node.body.impulse([0, 8, 0]);
}

function onStart(node, global) {
  global.logger('Started: ' + node.name);
}

function onUpdate(node, delta, time, global) {
  if (global.input.isKeyPressed('Space')) helperJump();
  // Example: read/write a custom variable defined in the inspector
  // if (getData(node).HealthPoints <= 0) console.log('dead');
}

// Alternatively, using module.exports:
// module.exports = {
//   onStart(node, global) { /* ... */ },
//   onUpdate(node, delta, time, global) { /* ... */ }
// };
*/`;

export default function CodeEditor(props: { readOnly?: boolean }) {
  const {selectedNode, scripts, editorScene} = useCleoEngine()
  const editorRef = React.useRef<HTMLDivElement>(null)
  const editorViewRef = React.useRef<EditorView | null>(null)
  const readOnlyComp = React.useRef(new Compartment())
  const [editorText, setEditorText] = React.useState('')
  const [scriptText, setScriptText] = React.useState<string | null>(null)
  const [hasScript, setHasScript] = React.useState(false)

  const roExtension = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]

  useEffect(() => {
    if (!selectedNode || !scriptText) return
    if (props.readOnly) return // never write scripts for a read-only (template instance) node
    scripts.set(selectedNode, scriptText)

  }, [scriptText])

  // Toggle CodeMirror read-only reactively (a <fieldset disabled> does not stop contentEditable).
  useEffect(() => {
    editorViewRef.current?.dispatch({ effects: readOnlyComp.current.reconfigure(roExtension(!!props.readOnly)) })
  }, [props.readOnly])

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
              node: editorScene.getNodeById(selectedNode!)?.nodeType === 'model' ? ModelNode.prototype : Node.prototype,
              getData: (_node: Node) => ({}),
              setData: (_node: Node, _name: string, ..._params: any[]) => {},
              findNode: (_name: string) => Node.prototype,
              scene: editorScene
            }),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              setScriptText(update.state.doc.toString())
            }
          }),
          readOnlyComp.current.of(roExtension(!!props.readOnly)),
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
          disabled={props.readOnly}
          className='px-3 py-1 rounded bg-[#326acc] hover:bg-[#2a59a9] text-white border border-[#274b8f] disabled:opacity-50 disabled:cursor-not-allowed'
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
          disabled={props.readOnly}
          className='mt-2 px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white border border-red-700 disabled:opacity-50 disabled:cursor-not-allowed'
          onClick={handleDeleteScript}
        >
          Delete Script
        </button>
      )}
    </div>
  )
}
