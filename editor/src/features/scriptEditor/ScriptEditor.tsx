import React, { useEffect } from 'react'
import { useCleoEngine } from '../EngineContext'
import { basicSetup } from "codemirror"
import { javascript } from '@codemirror/lang-javascript'
import { EditorView } from "@codemirror/view"
import { EditorState } from "@codemirror/state"

export default function ScriptEditor() {
  const editorRef = React.useRef<HTMLDivElement>(null)
  const {editorScene, selectedNode, selectedScript, scripts} = useCleoEngine()
  const [scriptText, setScriptText] = React.useState('// Script Editor')
  const [editorScript, setEditorScript] = React.useState('' as string)
  const editorViewRef = React.useRef<EditorView | null>(null)

  useEffect(() => {
    if (!editorRef.current) return;
    editorViewRef.current = new EditorView({
      state: EditorState.create({
        doc: scriptText,
        extensions: [
          basicSetup,
          javascript(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              setEditorScript(update.state.doc.toString())
            }
          }),
        ],
      }),      
      parent: editorRef.current
    });

  }, [])

  useEffect(() => {
    if (editorScene && selectedNode) {

      if (selectedScript) {
        if (!scripts.get(selectedNode))
          scripts.set(selectedNode, {start: '// Start script', update: '// Update Script', spawn: '// Spawn Script'})
      }

      switch (selectedScript) {
        case 'OnSpawn':
          setScriptText(scripts.get(selectedNode)?.spawn || '')
          break
        case 'OnStart':
          setScriptText(scripts.get(selectedNode)?.start || '')
          break
        case 'OnUpdate':
          setScriptText(scripts.get(selectedNode)?.update || '')
          break
      }
    }
  }, [selectedNode, selectedScript])

  useEffect(() => {
    if (editorViewRef.current) {
      editorViewRef.current.dispatch({ changes: { from: 0, to: editorViewRef.current.state.doc.length, insert: scriptText }})
    }
  }, [selectedScript, scriptText])

  useEffect(() => {
    if (!selectedNode || !selectedScript) return
    switch (selectedScript) {
      case 'OnSpawn':
        if (scripts.get(selectedNode)) {
          scripts.get(selectedNode)!.spawn = editorScript
        }
        break
      case 'OnStart':
        if (scripts.get(selectedNode)) {
          scripts.get(selectedNode)!.start = editorScript
        }
        break
      case 'OnUpdate':
        if (scripts.get(selectedNode)) {
          scripts.get(selectedNode)!.update = editorScript
        }
        break
    }

}, [editorScript])

  return (
    <div ref={editorRef} style={{width: '100%', height: '100%'}} />
  )
}
