// Static checks and contextual completions for node scripts, run in the editor as CodeMirror diagnostics.
//
// A script reaches a node's inspector Variables as plain properties — `this.HealthPoints`,
// `this.findNode('Player').Score`, `other.HealthPoints`. The engine resolves that at runtime with a Proxy
// (src/core/scene/node.ts), but Node.setVariable neither validates the value against the declared type nor
// rejects unknown names, so `this.Alive = 5.0` and a typo'd `this.helth = 3` would both pass silently, the
// latter quietly declaring a new variable. These are the checks that catch it at author time, against the
// same node.variables map the Variables panel renders from.
//
// Which node an expression refers to is worked out by NodeResolver (nodeExpressions.ts). Where it can pin
// the node — `this`, an ancestor, a literal lookup — everything is checked. Where the node only exists at
// runtime (`this.getNodesByName(name)[0]`, or a handler's `other`), we still know it IS a node, so
// completions are offered but nothing is reported: erroring there would flag nodes that are spawned later.

import { syntaxTree } from '@codemirror/language'
import type { Diagnostic } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import type { Text } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { canAccessVariable, SCRIPT_HANDLERS, Node } from 'cleo'
import type { NodeVariableType } from 'cleo'
import { NodeResolver } from './nodeExpressions'

/** Variables the engine owns (template/mesh ids). The Variables panel hides them; so do we. */
const RESERVED = '__'

const HANDLER_LIST = SCRIPT_HANDLERS.join(', ')

const isReserved = (name: string) => name.startsWith(RESERVED)

/** The type of a value, when it is knowable from syntax alone. Dynamic expressions -> null. */
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

function resolverFor(state: EditorView['state'], self: Node): NodeResolver {
  const resolver = new NodeResolver(self, state.doc)
  resolver.collect(syntaxTree(state).topNode)
  return resolver
}

export function lintScript(view: EditorView, self: Node | null): Diagnostic[] {
  if (!self) return []

  const doc = view.state.doc
  const text = (n: SyntaxNode) => doc.sliceString(n.from, n.to)
  const resolver = resolverFor(view.state, self)

  const out: Diagnostic[] = []
  const error = (from: number, to: number, message: string) => out.push({ from, to, severity: 'error', message })

  syntaxTree(view.state).cursor().iterate((ref) => {
    if (ref.name !== 'MemberExpression') return

    const expr = ref.node
    const property = expr.lastChild
    if (!property || property.name !== 'PropertyName') return   // an index, or a computed key

    const { nodes, isNode } = resolver.candidates(expr.firstChild)
    if (!isNode || nodes.length === 0) return   // not a node, or a node we cannot identify: say nothing

    const name = text(property)
    if (isReserved(name)) return

    // A real Node member (position, addZ, parent, the handler slots, the scene lookups) always wins over
    // a variable, exactly as the runtime proxy resolves it. Nothing to check.
    if (nodes.some((node) => name in node || LOOKUP_MEMBERS.includes(name))) return

    const parent = expr.parent
    const assignment = parent?.name === 'AssignmentExpression' && parent.firstChild?.from === expr.from ? parent : null
    const operator = assignment?.getChild('Equals') ?? assignment?.getChild('UpdateOp') ?? null
    const value = assignment ? assignment.lastChild : null
    const increment = parent?.name === 'PostfixExpression' ? parent : null

    const declaring = nodes.filter((node) => node.variables.has(name))

    if (declaring.length === 0) {
      // `this.onUpdaet = (node) => {}` — a function assigned to a name that is not one of the handlers.
      if (value && (value.name === 'ArrowFunction' || value.name === 'FunctionExpression')) {
        error(property.from, property.to, `'${name}' is not a script handler. Handlers are: ${HANDLER_LIST}.`)
        return
      }
      const where = nodes.length === 1 ? (nodes[0] === self ? 'this node' : `'${nodes[0].name}'`) : 'any matching node'
      error(property.from, property.to, `No variable '${name}' on ${where}. Declare it in the Variables panel, or use a local 'let' for script state.`)
      return
    }

    // With several candidates (a name matching more than one node) only report what holds for all of
    // them — one node allowing the access is enough to make the line legitimate.
    const readable = declaring.filter((node) => canAccessVariable(node, self, name))
    if (readable.length === 0) {
      const owner = declaring[0]
      error(property.from, property.to, `'${name}' is ${owner.variables.get(name)!.access ?? 'public'} on '${owner.name}' and cannot be accessed from this script.`)
      return
    }

    const types = new Set(readable.map((node) => node.variables.get(name)!.type))
    if (types.size !== 1) return   // candidates disagree on the type: no honest check to make
    const declared = [...types][0]

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

/** Synthesized on the script proxy rather than declared on Node, so `name in node` does not see them. */
const LOOKUP_MEMBERS = ['findNode', 'getNodeById', 'getNodesByName']

/**
 * Completions after a dot on any node-valued expression: `this.`, `this.parent.`, `other.`,
 * `this.findNode('Player').`, `this.getNodesByName(name)[0].` …
 *
 * When the node is identified, its own Variables are offered. When it is only known to BE a node, every
 * Variable in the scene is offered instead, tagged with the node it belongs to — a guess, but a labelled
 * one, and the alternative is offering nothing on the most common way to reach another node.
 */
export function nodeCompletions(context: CompletionContext, self: Node | null): CompletionResult | null {
  if (!self) return null

  const tree = syntaxTree(context.state)
  const at = tree.resolveInner(context.pos, -1)

  // Either mid-word (`this.He|`) or straight after the dot (`this.|`).
  const property = at.name === 'PropertyName' ? at : null
  const dot = at.name === '.' ? at : property?.prevSibling
  if (!dot || dot.name !== '.') return null

  const member = dot.parent
  if (!member || member.name !== 'MemberExpression') return null

  const resolver = resolverFor(context.state, self)
  const { nodes, isNode } = resolver.candidates(member.firstChild)
  if (!isNode) return null

  const known = nodes.length > 0
  const options: Completion[] = []

  if (known) {
    const seen = new Set<string>()
    for (const node of nodes)
      for (const [name, variable] of node.variables)
        if (!isReserved(name) && !seen.has(name)) {
          seen.add(name)
          options.push({ label: name, type: 'property', detail: variable.type, boost: 3 })
        }
  } else {
    // Unknown node: everything the scene declares, labelled with its owner so the guess is visible.
    const seen = new Set<string>()
    for (const node of self.scene?.nodes ?? [])
      for (const [name, variable] of node.variables)
        if (!isReserved(name) && !seen.has(name)) {
          seen.add(name)
          options.push({ label: name, type: 'property', detail: `${variable.type} · from '${node.name}'`, boost: 1 })
        }
  }

  // Handlers are only assignable on the script's own node.
  if (known && nodes.length === 1 && nodes[0] === self)
    options.push(...SCRIPT_HANDLERS.map((name) => ({ label: name, type: 'method', detail: 'handler', boost: 2 })))

  options.push(...LOOKUP_MEMBERS.map((name) => ({ label: name, type: 'method', detail: 'scene lookup' })))
  options.push(...members(known ? nodes[0] : self).map((name) => ({ label: name, type: 'property' })))

  return { from: dot.to, options, validFor: /^\w*$/ }
}

/** Public members of a node, walking the prototype chain (so ModelNode etc. contribute their own). */
function members(node: Node): string[] {
  const names = new Set<string>()
  for (let proto = Object.getPrototypeOf(node); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    for (const name of Object.getOwnPropertyNames(proto))
      if (!name.startsWith('_') && name !== 'constructor' && !SCRIPT_HANDLERS.includes(name as any)) names.add(name)
  return [...names]
}
