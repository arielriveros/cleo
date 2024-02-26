import React, { useEffect } from 'react'
import { EditorView, basicSetup } from "codemirror"
import { javascript } from '@codemirror/lang-javascript'
import { EditorState } from "@codemirror/state"
import { useCleoEngine } from '../../EngineContext'
import './Styles.css'

export default function CodeEditor() {
  const editorRef = React.useRef<HTMLDivElement>(null)
  const editorViewRef = React.useRef<EditorView | null>(null)
  const [scriptText, setScriptText] = React.useState('// Script Editor')
  const [editorScript, setEditorScript] = React.useState('' as string)
  const {selectedNode, selectedScript, scripts} = useCleoEngine()

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
      case 'OnCollision':
        if (scripts.get(selectedNode)) {
          scripts.get(selectedNode)!.collision = editorScript
        }
        break
    }

  }, [editorScript])

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
    if (selectedNode) {
      if (selectedScript && !scripts.get(selectedNode))
        scripts.set(selectedNode, {start: '', update: '', spawn: '', collision: ''})

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
        case 'OnCollision':
          setScriptText(scripts.get(selectedNode)?.collision || '')
          break
      }
    }
  }, [selectedNode, selectedScript])

  useEffect(() => {
    if (editorViewRef.current) {
      editorViewRef.current.dispatch({ changes: { from: 0, to: editorViewRef.current.state.doc.length, insert: scriptText }})
    }
  }, [selectedScript, scriptText, selectedNode])
  
  return (
    <div ref={editorRef} style={{width: '100%', backgroundColor: 'white', color: 'black'}} />
  )
}
