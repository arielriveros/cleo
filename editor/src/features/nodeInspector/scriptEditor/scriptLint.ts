// CodeMirror adapter over scriptAnalysisCore.ts's editor-agnostic checks and completions, run in the
// editor as CodeMirror diagnostics. Monaco (scriptMarkers.ts, nodeCompletionProvider.ts) is the other
// adapter over the same core, so what CodeMirror flags/completes and what Monaco flags/completes can
// never disagree — see scriptAnalysisCore.ts's module comment for why, and nodeExpressions.ts for how
// an expression is resolved to the node(s) it denotes in the first place.
//
// This file intentionally keeps using CodeMirror's own already-parsed, incrementally-updated tree
// (syntaxTree(view.state)) rather than scriptAnalysisCore's parseScript() — that helper exists for
// callers with no live CodeMirror state (Monaco, tests), and re-parsing from raw text here would throw
// away work CodeMirror already did on every keystroke.

import { syntaxTree } from '@codemirror/language'
import type { Diagnostic } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { Node } from 'cleo'
import { lintScriptCore, nodeCompletionCore, type CoreCompletion } from './scriptAnalysisCore'

export function lintScript(view: EditorView, self: Node | null): Diagnostic[] {
  if (!self) return []
  const tree = syntaxTree(view.state)
  return lintScriptCore(tree, view.state.doc, self).map((d) => ({ from: d.from, to: d.to, severity: 'error', message: d.message }))
}

const CM_TYPE: Record<CoreCompletion['kind'], string> = {
  variable: 'property',
  handler: 'method',
  lookup: 'method',
  member: 'property',
}

/**
 * Completions after a dot on any node-valued expression: `this.`, `this.parent.`, `other.`,
 * `this.findNode('Player').`, `this.getNodesByName(name)[0].` … Delegates to nodeCompletionCore for
 * everything except the CodeMirror-specific "where's the cursor" lookup and the result's shape.
 */
export function nodeCompletions(context: CompletionContext, self: Node | null): CompletionResult | null {
  if (!self) return null

  const tree = syntaxTree(context.state)
  const at = tree.resolveInner(context.pos, -1)

  const core = nodeCompletionCore(tree, context.state.doc, self, at)
  if (!core) return null

  const options: Completion[] = core.items.map((item) => ({
    label: item.label,
    type: CM_TYPE[item.kind],
    detail: item.detail,
    boost: item.boost,
  }))

  return { from: core.from, options, validFor: /^\w*$/ }
}
