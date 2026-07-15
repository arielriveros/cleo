// Monaco marker adapter over scriptAnalysisCore's lintScriptCore — the same node-Variable existence/
// access/type checks CodeMirror's linter runs (scriptLint.ts), surfaced as Monaco error squiggles instead.
// This is what actually produces "real errors on this.HealthPoints": TypeScript itself has no idea what
// a node Variable is (see monacoSetup.ts's noImplicitThis note), so these checks are still the only
// source of truth for them under Monaco too.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import type { Node } from 'cleo'
import { parseScript, lintScriptCore } from './scriptAnalysisCore'

/** Owner tag for setModelMarkers, so clearing/replacing our markers never touches TS's own diagnostics. */
const MARKER_OWNER = 'cleo-node'

export function refreshMarkers(monaco: typeof Monaco, model: Monaco.editor.ITextModel, self: Node | null): void {
  if (!self) { monaco.editor.setModelMarkers(model, MARKER_OWNER, []); return }

  const { tree, doc } = parseScript(model.getValue())
  const diagnostics = lintScriptCore(tree, doc, self)

  const markers: Monaco.editor.IMarkerData[] = diagnostics.map((d) => {
    const start = model.getPositionAt(d.from)
    const end = model.getPositionAt(d.to)
    return {
      severity: d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
      message: d.message,
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    }
  })

  monaco.editor.setModelMarkers(model, MARKER_OWNER, markers)
}
