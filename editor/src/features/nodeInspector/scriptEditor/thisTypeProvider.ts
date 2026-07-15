// Wires thisType.ts into Monaco: keeps the per-node `this` declaration registered, mirrors each script
// into a hidden shadow model whose body is wrapped so `this` is typed, and maps the shadow's TypeScript
// diagnostics back onto the visible model. This is what gives node scripts real TS type-checking on
// `this` and typed handler-callback parameters — things scriptAnalysisCore's node resolver can't express.
//
// Diagnostics that another layer already shows (TypeScript's own on the visible model; node-Variable lint
// from scriptMarkers.ts) are deduped away, so a mis-typed Variable assignment is flagged once, not twice.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import type { Node } from 'cleo'
import { buildThisLib, wrapForThis, THIS_LIB_URI } from './thisType'

const MARKER_OWNER = 'cleo-this'

export interface ThisTypeController {
  /** Re-register the `this` declaration for a node. Call on node switch and on any Variables change. */
  update(node: Node | null): void
  /** Sync the shadow model and refresh markers. Call on content change and on node switch. */
  refresh(model: Monaco.editor.ITextModel, node: Node | null): void
  /** Quick-info (type + JSDoc) for a position on a visible script model, via the typed-`this` shadow. */
  hover(model: Monaco.editor.ITextModel, position: Monaco.Position): Promise<Monaco.languages.Hover | null>
  dispose(): void
}

export function createThisTypeController(monaco: typeof Monaco): ThisTypeController {
  const tsDefaults = monaco.languages.typescript.typescriptDefaults
  let lib: Monaco.IDisposable | null = null
  const shadows = new Map<string, Monaco.editor.ITextModel>()

  const shadowFor = (nodeId: string, text: string): Monaco.editor.ITextModel => {
    // file:/// (not inmemory://) so the wrapped body's `import ... from 'cleo'` resolves against the
    // engine types under file:///node_modules/cleo — same reason as the visible model in MonacoCodeEditor.
    const uri = monaco.Uri.parse(`file:///cleo/${nodeId}.__this.ts`)
    const existing = shadows.get(nodeId) ?? monaco.editor.getModel(uri)
    if (existing) {
      if (existing.getValue() !== text) existing.setValue(text)
      shadows.set(nodeId, existing)
      return existing
    }
    const model = monaco.editor.createModel(text, 'typescript', uri)
    shadows.set(nodeId, model)
    return model
  }

  const update = (node: Node | null): void => {
    lib?.dispose()
    lib = null
    if (node) lib = tsDefaults.addExtraLib(buildThisLib(node), THIS_LIB_URI)
  }

  const refresh = (model: Monaco.editor.ITextModel, node: Node | null): void => {
    if (!node) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
      return
    }
    const wrap = wrapForThis(model.getValue())
    if (!wrap.ok) {
      // Unusual layout (an import below body code): fall back to untyped `this` rather than bogus errors.
      monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
      return
    }
    const shadow = shadowFor(node.id, wrap.text)
    const openLine = wrap.headLines + 1
    const closeLine = shadow.getLineCount()
    const toVisible = (line: number) => (line <= wrap.headLines ? line : line - wrap.bodyLineShift)

    // Async: the worker settles a beat after the model changes. Last write wins (setModelMarkers replaces),
    // which is fine on fast typing.
    monaco.languages.typescript
      .getTypeScriptWorker()
      .then((getWorker) => getWorker(shadow.uri))
      .then((worker) =>
        Promise.all([
          worker.getSemanticDiagnostics(shadow.uri.toString()),
          worker.getSyntacticDiagnostics(shadow.uri.toString()),
        ]),
      )
      .then(([semantic, syntactic]) => {
        if (model.isDisposed()) return
        const existing = monaco.editor
          .getModelMarkers({ resource: model.uri })
          .filter((m) => m.owner !== MARKER_OWNER)

        const markers: Monaco.editor.IMarkerData[] = []
        for (const d of [...semantic, ...syntactic]) {
          if (d.category !== 1 || d.start == null || d.length == null) continue // errors only
          const s = shadow.getPositionAt(d.start)
          const e = shadow.getPositionAt(d.start + d.length)
          if (s.lineNumber === openLine || s.lineNumber === closeLine) continue // synthetic wrapper lines
          const startLineNumber = toVisible(s.lineNumber)
          const endLineNumber = toVisible(e.lineNumber)
          if (existing.some((m) => m.startLineNumber === startLineNumber && m.startColumn === s.column)) continue
          const text = typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText
          markers.push({
            severity: monaco.MarkerSeverity.Error,
            message: text,
            startLineNumber,
            startColumn: s.column,
            endLineNumber,
            endColumn: e.column,
          })
        }
        monaco.editor.setModelMarkers(model, MARKER_OWNER, markers)
      })
      .catch(() => {
        /* worker not ready / model swapped mid-flight: leave the previous markers in place */
      })
  }

  const hover = async (
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ): Promise<Monaco.languages.Hover | null> => {
    // Only the visible script models (file:///cleo/<id>.ts) — never the shadow itself or other TS models.
    const match = /^\/cleo\/([^/]+)\.ts$/.exec(model.uri.path)
    if (!match || model.uri.path.endsWith('.__this.ts')) return null

    const wrap = wrapForThis(model.getValue())
    if (!wrap.ok) return null
    const shadow = shadowFor(match[1], wrap.text)

    // Visible line -> shadow line: body lines sit one WRAP_OPEN line lower in the shadow; head is 1:1.
    const toShadow = (line: number) => (line <= wrap.headLines ? line : line + wrap.bodyLineShift)
    const toVisible = (line: number) => (line <= wrap.headLines ? line : line - wrap.bodyLineShift)
    const offset = shadow.getOffsetAt({ lineNumber: toShadow(position.lineNumber), column: position.column })

    try {
      const getWorker = await monaco.languages.typescript.getTypeScriptWorker()
      const worker = await getWorker(shadow.uri)
      const info = await worker.getQuickInfoAtPosition(shadow.uri.toString(), offset)
      if (!info || model.isDisposed()) return null

      const signature = (info.displayParts ?? []).map((p: { text: string }) => p.text).join('')
      if (!signature) return null
      const doc = (info.documentation ?? []).map((p: { text: string }) => p.text).join('')
      const tags = (info.tags ?? [])
        .map((t: { name: string; text?: Array<{ text: string }> | string }) => {
          const body = Array.isArray(t.text) ? t.text.map((p) => p.text).join('') : (t.text ?? '')
          return `*@${t.name}*${body ? ` — ${body}` : ''}`
        })
        .join('  \n')

      const contents: Monaco.IMarkdownString[] = [{ value: '```typescript\n' + signature + '\n```' }]
      if (doc) contents.push({ value: doc })
      if (tags) contents.push({ value: tags })

      let range: Monaco.IRange | undefined
      if (info.textSpan) {
        const s = shadow.getPositionAt(info.textSpan.start)
        const e = shadow.getPositionAt(info.textSpan.start + info.textSpan.length)
        range = {
          startLineNumber: toVisible(s.lineNumber),
          startColumn: s.column,
          endLineNumber: toVisible(e.lineNumber),
          endColumn: e.column,
        }
      }
      return { contents, range }
    } catch {
      return null
    }
  }

  const dispose = (): void => {
    lib?.dispose()
    lib = null
    for (const m of shadows.values()) m.dispose()
    shadows.clear()
  }

  return { update, refresh, hover, dispose }
}
