// Static checks for node scripts, run in the editor as CodeMirror diagnostics.
//
// A script reaches its node's inspector Variables through `this` (this.HealthPoints), and other nodes'
// through `this.parent.X` or the `other` handler argument. The engine resolves all of that at runtime
// with a Proxy (src/core/scene/node.ts) — but Node.setVariable neither validates the value against the
// declared type nor rejects unknown names, so `this.Alive = 5.0` and a typo'd `this.helth = 3` would both
// pass silently, the latter quietly declaring a new variable. These are the checks that catch that at
// author time, against the same node.variables map the Variables panel renders from.
//
// Only statically resolvable chains are checked: `this.X` and `this.parent(.parent)*.X`. Anything
// dynamic (a node from findNode, a computed key) is left alone rather than guessed at.

import { syntaxTree } from '@codemirror/language'
import type { Diagnostic } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import type { Text } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { canAccessVariable, SCRIPT_HANDLERS, Node } from 'cleo'
import type { NodeVariableType } from 'cleo'

/** Variables the engine owns (template/mesh ids). The Variables panel hides them; so do we. */
const RESERVED = '__'

const HANDLER_LIST = SCRIPT_HANDLERS.join(', ')

/** The declared type of a value, when it is knowable from syntax alone. Dynamic expressions -> null. */
function literalType(expr: SyntaxNode | null, doc: Text): NodeVariableType | null {
  if (!expr) return null
  switch (expr.name) {
    case 'Number': return 'number'
    case 'String':
    case 'TemplateString': return 'string'
    case 'BooleanLiteral': return 'boolean'
    case 'ArrayExpression': return 'vec3'
    case 'UnaryExpression': {
      const op = doc.sliceString(expr.from, expr.from + 1)
      if (op === '!') return 'boolean'
      if (op === '-' || op === '+') return expr.lastChild?.name === 'Number' ? 'number' : null
      return null
    }
    default: return null   // a call, an identifier, arithmetic: not our business
  }
}

/** Walks a `this`(.parent)* chain to the node it denotes. Anything else is not statically resolvable. */
function resolveTarget(expr: SyntaxNode | null, self: Node, doc: Text): Node | null {
  if (!expr) return null
  if (expr.name === 'this') return self
  if (expr.name !== 'MemberExpression') return null

  const base = resolveTarget(expr.firstChild, self, doc)
  const prop = expr.lastChild
  if (!base || !prop || prop.name !== 'PropertyName') return null

  return doc.sliceString(prop.from, prop.to) === 'parent' ? base.parent : null
}

export function lintScript(view: EditorView, self: Node | null): Diagnostic[] {
  if (!self) return []

  const doc = view.state.doc
  const text = (n: SyntaxNode) => doc.sliceString(n.from, n.to)
  const out: Diagnostic[] = []
  const error = (from: number, to: number, message: string) => out.push({ from, to, severity: 'error', message })

  syntaxTree(view.state).cursor().iterate((ref) => {
    if (ref.name !== 'MemberExpression') return

    const expr = ref.node
    const prop = expr.lastChild
    if (!prop || prop.name !== 'PropertyName') return   // this['x'] — computed, skip

    const target = resolveTarget(expr.firstChild, self, doc)
    if (!target) return

    const name = text(prop)
    if (name.startsWith(RESERVED)) return

    // A real Node member (position, addZ, parent, and the six handler slots) always wins over a
    // variable, exactly as the runtime proxy resolves it. Nothing to check.
    if (name in target) return

    const parent = expr.parent
    const assignment = parent?.name === 'AssignmentExpression' && parent.firstChild?.from === expr.from ? parent : null
    const operator = assignment?.getChild('Equals') ?? assignment?.getChild('UpdateOp') ?? null
    const value = assignment ? assignment.lastChild : null
    const increment = parent?.name === 'PostfixExpression' ? parent : null

    const variable = target.variables.get(name)

    if (!variable) {
      // `this.onUpdaet = (node) => {}` — a function assigned to a name that is not one of the handlers.
      if (value && (value.name === 'ArrowFunction' || value.name === 'FunctionExpression')) {
        error(prop.from, prop.to, `'${name}' is not a script handler. Handlers are: ${HANDLER_LIST}.`)
        return
      }
      const where = target === self ? 'this node' : `'${target.name}'`
      error(prop.from, prop.to, `No variable '${name}' on ${where}. Declare it in the Variables panel, or use a local 'let' for script state.`)
      return
    }

    if (!canAccessVariable(target, self, name)) {
      error(prop.from, prop.to, `'${name}' is ${variable.access ?? 'public'} on '${target.name}' and cannot be accessed from this script.`)
      return
    }

    const declared = variable.type

    if (increment && declared !== 'number') {
      error(increment.from, increment.to, `'${name}' is ${declared}; ${text(increment.lastChild!)} only applies to a number.`)
      return
    }

    if (!assignment || !operator || !value) return

    if (operator.name === 'UpdateOp') {
      const op = text(operator)
      // `+=` is also string concatenation; everything else is arithmetic.
      const ok = declared === 'number' || (declared === 'string' && op === '+=')
      if (!ok) error(operator.from, value.to, `'${name}' is ${declared}; '${op}' is not valid on it.`)
      return
    }

    if (value.name === 'ArrayExpression') {
      if (declared !== 'vec3') {
        error(value.from, value.to, `'${name}' is ${declared}, but this assigns a vec3.`)
        return
      }
      const components = value.getChildren('Number').length
      const dynamic = value.getChildren('VariableName').length + value.getChildren('MemberExpression').length
      if (!dynamic && components !== 3)
        error(value.from, value.to, `'${name}' is vec3 and needs 3 numbers — got ${components}.`)
      return
    }

    const assigned = literalType(value, doc)
    if (assigned && assigned !== declared)
      error(value.from, value.to, `'${name}' is ${declared}, but this assigns ${assigned}.`)
  })

  return out
}

/**
 * Completions for `this.` — the node's declared variables (typed), the handler names, and the engine
 * members. scopeCompletionSource cannot do this: it reflects over an object, and `this` is not in scope
 * at edit time.
 */
export function thisCompletions(context: CompletionContext, self: Node | null): CompletionResult | null {
  const before = context.matchBefore(/this\.\w*/)
  if (!before || !self) return null

  const options = [
    ...[...self.variables.entries()]
      .filter(([name]) => !name.startsWith(RESERVED))
      .map(([name, variable]) => ({ label: name, type: 'property', detail: variable.type, boost: 2 })),
    ...SCRIPT_HANDLERS.map((name) => ({ label: name, type: 'method', detail: 'handler', boost: 1 })),
    ...members(self).map((name) => ({ label: name, type: 'property' })),
  ]

  return { from: before.from + 'this.'.length, options, validFor: /^\w*$/ }
}

/** Public members of a node, walking the prototype chain (so ModelNode etc. contribute their own). */
function members(node: Node): string[] {
  const names = new Set<string>()
  for (let proto = Object.getPrototypeOf(node); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    for (const name of Object.getOwnPropertyNames(proto))
      if (!name.startsWith('_') && name !== 'constructor' && !SCRIPT_HANDLERS.includes(name as any)) names.add(name)
  return [...names]
}
