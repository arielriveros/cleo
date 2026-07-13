import React, { useEffect } from 'react'
import { EditorView } from "@codemirror/view"
import { javascript, javascriptLanguage, scopeCompletionSource } from '@codemirror/lang-javascript'
import { EditorState, Compartment } from "@codemirror/state"
import type { CompletionContext } from '@codemirror/autocomplete'
import { useCleoEngine } from '../../EngineContext'
import { InputManager, Logger, ModelNode, Node } from 'cleo'
import { Button, ButtonWithConfirm } from '../../../components/ui'
import { codeSetup, readOnlyExtension } from './codeSetup'
import { getCodeTheme } from './codeMirrorTheme'
import { useCodeTheme } from './codeThemeStore'
import CodeEditorHeader from './CodeEditorHeader'

const description = `/*
// You can write full JavaScript here. Define helpers and export handlers.
// Two ways to declare handlers:
// 1) Top-level functions named onSpawn/onStart/onUpdate/onCollision/onTrigger
// 2) Or export them using module.exports = { onStart, onUpdate, ... }
// A minimal runtime is available:
//  - node: the current Node instance (e.g., node.addX(1))
//  - global.input: InputManager singleton
//  - global.logger(text): log to the engine console
//  - console.log/info/debug/warn/error: forwarded to the editor console (objects stay inspectable)
//  - console.flush(...): rewrites its own row instead of adding one — for per-frame values
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
  const theme = useCodeTheme()
  const editorRef = React.useRef<HTMLDivElement>(null)
  const editorViewRef = React.useRef<EditorView | null>(null)
  const readOnlyComp = React.useRef(new Compartment())
  const themeComp = React.useRef(new Compartment())
  const [editorText, setEditorText] = React.useState('')
  const [scriptText, setScriptText] = React.useState<string | null>(null)
  const [hasScript, setHasScript] = React.useState(false)

  // The completion scope is rebuilt on every render and read through a ref, because the view is created
  // once: capturing it in the extension array would pin the completions to whichever node happened to be
  // selected at mount (and to the edit-time scene, which `editorScene` stops being during play).
  const scopeRef = React.useRef<Record<string, any>>({})
  scopeRef.current = {
    global: {
      input: InputManager.prototype,
      logger: (text: string) => Logger.log(text)
    },
    node: editorScene.getNodeById(selectedNode!)?.nodeType === 'model' ? ModelNode.prototype : Node.prototype,
    getData: (_node: Node) => ({}),
    setData: (_node: Node, _name: string, ..._params: any[]) => {},
    findNode: (_name: string) => Node.prototype,
    scene: editorScene
  }

  useEffect(() => {
    if (!selectedNode || !scriptText) return
    if (props.readOnly) return // never write scripts for a read-only (template instance) node
    scripts.set(selectedNode, scriptText)

  }, [scriptText])

  // Toggle CodeMirror read-only reactively (a <fieldset disabled> does not stop contentEditable).
  useEffect(() => {
    editorViewRef.current?.dispatch({ effects: readOnlyComp.current.reconfigure(readOnlyExtension(!!props.readOnly)) })
  }, [props.readOnly])

  // Swap the theme on the live view. Effects only, no `changes`: the doc is untouched, so this cannot
  // trip the updateListener into writing the script back, and the undo history survives.
  useEffect(() => {
    editorViewRef.current?.dispatch({ effects: themeComp.current.reconfigure(getCodeTheme(theme)) })
  }, [theme])

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
        extensions: codeSetup({
          language: [
            javascript(),
            javascriptLanguage.data.of({
              autocomplete: (context: CompletionContext) => scopeCompletionSource(scopeRef.current)(context),
            }),
          ],
          themeCompartment: themeComp.current,
          readOnlyCompartment: readOnlyComp.current,
          initialTheme: theme,
          initialReadOnly: !!props.readOnly,
          onDocChange: setScriptText,
        }),
      }),
      parent: editorRef.current
    });

    return () => { editorViewRef.current?.destroy(); editorViewRef.current = null }
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
        <Button variant='primary' disabled={props.readOnly} onClick={handleAddScript}>
          Add Script
        </Button>
      )}
      <div style={{display: hasScript ?  'block' : 'none'}} className='mt-2 border border-border rounded overflow-hidden'>
        <CodeEditorHeader />
        <div ref={editorRef} className='w-full min-h-[240px] max-h-[520px] overflow-auto' aria-label='Script editor' />
      </div>
      {hasScript && (
        <div className='mt-2'>
          <ButtonWithConfirm disabled={props.readOnly} onClick={handleDeleteScript}>Delete Script</ButtonWithConfirm>
        </div>
      )}
    </div>
  )
}
