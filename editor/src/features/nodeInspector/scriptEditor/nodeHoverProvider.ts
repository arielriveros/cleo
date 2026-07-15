// Monaco hover adapter over scriptAnalysisCore's nodeVariableAt: hovering `this.<var>`/`other.<var>`
// shows its name, declared type and access level — the same information the Variables panel and the
// lint errors (scriptMarkers.ts) already use, just surfaced on demand instead of only on a mistake.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import type { Node } from 'cleo'
import { parseScript, nodeVariableAt } from './scriptAnalysisCore'

export function registerNodeHoverProvider(monaco: typeof Monaco, getSelf: () => Node | null): Monaco.IDisposable {
  return monaco.languages.registerHoverProvider('typescript', {
    provideHover(model, position) {
      const self = getSelf()
      if (!self) return null

      const { tree, doc } = parseScript(model.getValue())
      const offset = model.getOffsetAt(position)
      const at = tree.resolveInner(offset, -1)

      const found = nodeVariableAt(tree, doc, self, at)
      if (!found) return null

      const from = model.getPositionAt(at.from)
      const to = model.getPositionAt(at.to)

      return {
        range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column },
        contents: [
          { value: `**${found.name}**: \`${found.type}\`` },
          { value: `${found.access} · declared on '${found.owner}'` },
        ],
      }
    },
  })
}
