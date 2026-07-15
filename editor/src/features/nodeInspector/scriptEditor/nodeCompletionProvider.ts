// Monaco completion adapter over scriptAnalysisCore. Node-valued expressions (this., other.,
// findNode('x')., …) are answered here from the real node; everything else — the imported `cleo` API,
// locals, gl-matrix's Vec — is answered natively by TypeScript's own completions, which is why this
// provider returns no suggestions at all for a non-node expression rather than falling back to anything.
//
// Also covers a capability CodeMirror's nodeCompletions never had: completing scene node NAMES inside
// findNode('…')/getNodesByName('…') (or ids inside getNodeById('…')) — see nodeNameCompletionCore.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import type { Node } from 'cleo'
import { parseScript, nodeCompletionCore, nodeNameCompletionCore, type CoreCompletion } from './scriptAnalysisCore'

/**
 * Registers the provider once. `getSelf` is read on every completion request (not captured), so it
 * always answers for whichever node is currently selected — the same reason CodeEditor.tsx reads the
 * node through a ref rather than a value closed over at mount.
 */
export function registerNodeCompletionProvider(monaco: typeof Monaco, getSelf: () => Node | null): Monaco.IDisposable {
  const Kind = monaco.languages.CompletionItemKind
  const MONACO_KIND: Record<CoreCompletion['kind'], number> = {
    variable: Kind.Property,
    handler: Kind.Method,
    lookup: Kind.Method,
    member: Kind.Property,
  }

  return monaco.languages.registerCompletionItemProvider('typescript', {
    triggerCharacters: ['.', "'", '"'],

    provideCompletionItems(model, position) {
      const self = getSelf()
      if (!self) return { suggestions: [] }

      const { tree, doc } = parseScript(model.getValue())
      const offset = model.getOffsetAt(position)
      const at = tree.resolveInner(offset, -1)

      const names = nodeNameCompletionCore(self, at, doc)
      if (names) {
        const from = model.getPositionAt(names.replaceFrom)
        const to = model.getPositionAt(names.replaceTo)
        const range: Monaco.IRange = { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }
        return {
          suggestions: names.items.map((item) => ({
            label: item.label,
            kind: Kind.Value,
            detail: item.detail,
            insertText: item.label,
            range,
          })),
        }
      }

      const core = nodeCompletionCore(tree, doc, self, at)
      if (!core) return { suggestions: [] }

      // Standard Monaco idiom: replace the partial word already typed, whether mid-word (`this.He|`) or
      // right after the dot (`this.|`, an empty word at the cursor).
      const word = model.getWordUntilPosition(position)
      const range: Monaco.IRange = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn }

      return {
        suggestions: core.items.map((item) => ({
          label: item.label,
          kind: MONACO_KIND[item.kind],
          detail: item.detail,
          insertText: item.label,
          range,
          // Monaco sorts by sortText; higher boost must sort earlier (lower string).
          sortText: String(9 - item.boost).padStart(2, '0'),
        })),
      }
    },
  })
}
