// Surfaces SCRIPT_SNIPPETS as always-available completions. Monaco merges suggestions from every
// registered provider for a given position, so these show up alongside the imported-API completions (TS
// itself) and the node-Variable ones (nodeCompletionProvider.ts) rather than replacing either — sunk to
// the bottom of the list (sortText) so they don't compete with real completions, but reachable by typing
// e.g. "Example" or "collision".
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { SCRIPT_SNIPPETS } from './scriptSnippets'

export function registerScriptSnippetsProvider(monaco: typeof Monaco): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider('typescript', {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      }

      return {
        suggestions: SCRIPT_SNIPPETS.map((snippet) => ({
          label: snippet.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: snippet.detail,
          insertText: snippet.body,
          range,
          sortText: 'zz',
          documentation: { value: '```ts\n' + snippet.body + '\n```' },
        })),
      }
    },
  })
}
