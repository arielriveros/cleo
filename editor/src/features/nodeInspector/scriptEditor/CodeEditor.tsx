import React, { useEffect } from 'react'
import { EditorView } from "@codemirror/view"
import { javascript, javascriptLanguage, scopeCompletionSource } from '@codemirror/lang-javascript'
import { EditorState, Compartment } from "@codemirror/state"
import { linter, lintGutter, forceLinting } from '@codemirror/lint'
import type { CompletionContext } from '@codemirror/autocomplete'
import { useCleoEngine } from '../../EngineContext'
import * as cleo from 'cleo'
import { ModelNode, Node } from 'cleo'
import { Button, ButtonWithConfirm } from '../../../components/ui'
import { codeSetup, readOnlyExtension } from './codeSetup'
import { lintScript, thisCompletions } from './scriptLint'
import { getCodeTheme } from './codeMirrorTheme'
import { useCodeTheme } from './codeThemeStore'
import CodeEditorHeader from './CodeEditorHeader'

// Inserted verbatim by "Add Script". It is live code rather than one big comment block, so a new script
// does something the moment it is created — and it doubles as the documentation for the contract.
const description = `// Import what you need from the engine. The whole public API is available:
// Logger, InputManager, Vec (gl-matrix), Geometry, Material, Body, Shape, Raycaster...
import { Logger, InputManager } from 'cleo';

// \`this\` IS the node: its methods (this.addZ), its properties (this.name), and the custom Variables
// you declare in the panel above (this.HealthPoints). Variables are type-checked as you type.
//
// Handlers are assigned to \`this\`, and always take their node as the first argument:
//   this.onStart / onSpawn / onDespawn = (node) => {}
//   this.onUpdate = (node, delta, time) => {}
//   this.onCollision / onTrigger = (node, other) => {}

// Top-level state is per-node: this body runs once for each node the script is attached to.
let jumpsUsed = 0;

this.onStart = (node) => {
  // Logger writes to the editor Console panel — a plain console.log only reaches the browser devtools.
  Logger.log('Started: ' + this.name, 'Script');

  InputManager.instance.registerKeyPress('Space', () => {
    if (this.body) { this.body.impulse([0, 8, 0]); jumpsUsed++; }
  });
};

this.onUpdate = (node, delta, time) => {
  if (InputManager.instance.isKeyPressed('KeyW')) this.addZ(2 * delta);

  // Declare a Variable in the panel above, then read and write it straight off \`this\`:
  // if (this.HealthPoints <= 0) this.remove();

  // Logger.log(this.position, 'Script', { flush: true }) rewrites its own row, for per-frame values.
};

this.onCollision = (node, other) => {
  // Other nodes are the same deal — their Variables are properties too, subject to access level:
  // other.HealthPoints -= 1;
  Logger.log(this.name + ' hit ' + other.name, 'Script');
};

// Reaching other nodes: this.parent, this.children, this.findNode('Player')
`;

export default function CodeEditor(props: { readOnly?: boolean }) {
  const {selectedNode, scripts, editorScene, eventEmitter} = useCleoEngine()
  const theme = useCodeTheme()
  const editorRef = React.useRef<HTMLDivElement>(null)
  const editorViewRef = React.useRef<EditorView | null>(null)
  const readOnlyComp = React.useRef(new Compartment())
  const themeComp = React.useRef(new Compartment())
  const lintComp = React.useRef(new Compartment())
  const [editorText, setEditorText] = React.useState('')
  const [scriptText, setScriptText] = React.useState<string | null>(null)
  const [hasScript, setHasScript] = React.useState(false)

  // The selected node, read through a ref for the same reason as the completion scope below: the linter
  // and completion sources are baked into the view once, so they must reach the *current* node
  // indirectly rather than close over whichever one was selected at mount.
  const nodeRef = React.useRef<Node | null>(null)
  nodeRef.current = selectedNode ? editorScene.getNodeById(selectedNode) ?? null : null

  // The completion scope is rebuilt on every render and read through a ref, because the view is created
  // once: capturing it in the extension array would pin the completions to whichever node happened to be
  // selected at mount (and to the edit-time scene, which `editorScene` stops being during play).
  //
  // scopeCompletionSource reflects over a live object, so spreading the engine's own namespace is what
  // makes every importable name (and its members) complete — there is no hand-maintained list to fall
  // out of date. `node`/`other` are the handler arguments, not imports, so they map to the prototype of
  // the selected node's class. `this` cannot be reflected this way (it is not in scope at edit time) —
  // thisCompletions handles it.
  const scopeRef = React.useRef<Record<string, any>>({})
  scopeRef.current = {
    ...cleo,
    node: nodeRef.current?.nodeType === 'model' ? ModelNode.prototype : Node.prototype,
    other: Node.prototype,
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

  // Diagnostics for `this.<variable>`: type, access level, and whether the variable exists at all. Read
  // through nodeRef so the linter always checks against the currently selected node.
  const lintExtension = () => [lintGutter(), linter((view) => lintScript(view, nodeRef.current))]

  useEffect(() => {
    if (!editorRef.current) return;
    editorViewRef.current = new EditorView({
      state: EditorState.create({
        doc: editorText,
        extensions: codeSetup({
          language: [
            javascript(),
            javascriptLanguage.data.of({
              autocomplete: (context: CompletionContext) =>
                thisCompletions(context, nodeRef.current) ?? scopeCompletionSource(scopeRef.current)(context),
            }),
          ],
          themeCompartment: themeComp.current,
          readOnlyCompartment: readOnlyComp.current,
          lintCompartment: lintComp.current,
          initialLint: lintExtension(),
          initialTheme: theme,
          initialReadOnly: !!props.readOnly,
          onDocChange: setScriptText,
        }),
      }),
      parent: editorRef.current
    });

    return () => { editorViewRef.current?.destroy(); editorViewRef.current = null }
  }, [])

  // Diagnostics only re-run when the *document* changes, but they depend on the node's variables — so
  // adding, retyping or re-scoping a variable in the panel above would otherwise leave stale errors on
  // screen until the script was touched. CustomVariablesEditor emits SCENE_CHANGED on every
  // add/remove/type/access change; on that we swap the linter in (keeping the undo history, which
  // recreating the view would drop) and force a run — reconfiguring alone installs the new source but
  // does not re-lint, which is exactly the stale-error case.
  useEffect(() => {
    const relint = () => {
      const view = editorViewRef.current
      if (!view) return
      view.dispatch({ effects: lintComp.current.reconfigure(lintExtension()) })
      forceLinting(view)
    }
    relint()   // also covers switching to a different node
    eventEmitter.on('SCENE_CHANGED', relint)
    return () => { eventEmitter.off('SCENE_CHANGED', relint) }
  }, [selectedNode])

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
