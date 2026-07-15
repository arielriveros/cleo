// The single hover source for the Monaco script editor, combining the two things that know about a
// script's world:
//   1. NodeResolver (scriptAnalysisCore.nodeVariableAt) — resolves a node-valued expression to the
//      concrete scene node(s) it denotes at edit time, so a Variable read off ANOTHER node —
//      `findNode('Enemy').HealthPoints`, `this.parent.Speed`, `getNodesByName('Coin')[0].value` — reports
//      that node's own declared type and owner. This is the cross-node ("dynamic") resolution.
//   2. The typed-`this` shadow model (thisTypeProvider) — for everything TypeScript itself types: node
//      methods (with the engine's JSDoc), the imported `cleo` API, locals, and the `this` keyword.
//
// Resolver first (it has the exact per-node Variable answer), shadow as the fallback. Monaco's own TS
// hover stays disabled (monacoSetup) so `this.<x>` never shows the bare `any` the visible model infers.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import type { Node } from 'cleo'
import { parseScript, nodeVariableAt } from './scriptAnalysisCore'
import type { ThisTypeController } from './thisTypeProvider'

export function registerScriptHoverProvider(
  monaco: typeof Monaco,
  getSelf: () => Node | null,
  controller: ThisTypeController,
): Monaco.IDisposable {
  return monaco.languages.registerHoverProvider('typescript', {
    provideHover(model, position) {
      // Only the visible script models (file:///cleo/<id>.ts) — never the shadow or other TS models.
      if (!/^\/cleo\/[^/]+\.ts$/.test(model.uri.path) || model.uri.path.endsWith('.__this.ts')) return null

      const self = getSelf()
      if (self) {
        const { tree, doc } = parseScript(model.getValue())
        const at = tree.resolveInner(model.getOffsetAt(position), -1)
        const nv = nodeVariableAt(tree, doc, self, at)
        if (nv) {
          const where = nv.ownerIsSelf ? 'this node' : `node '${nv.owner}'`
          const start = model.getPositionAt(at.from)
          const end = model.getPositionAt(at.to)
          return {
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            },
            contents: [
              { value: '```typescript\n(Script Variable) ' + nv.name + ': ' + nv.type + '\n```' },
              { value: `${nv.access} · declared on ${where} (Variables panel)` },
            ],
          }
        }
      }
      return controller.hover(model, position)
    },
  })
}
