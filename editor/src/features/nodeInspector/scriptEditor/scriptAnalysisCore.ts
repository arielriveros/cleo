// The editor-agnostic core of script analysis: given a parsed tree + doc, what are the diagnostics
// (lint) and what completes after a dot (nodeCompletions)? Both CodeMirror (scriptLint.ts) and Monaco
// (scriptMarkers.ts, nodeCompletionProvider.ts, nodeHoverProvider.ts) are thin adapters over this file,
// so "what gets flagged" and "what completes" can never disagree between the two editors, the same
// reason NodeResolver itself is shared (see nodeExpressions.ts).
//
// Parsing needs only @lezer's Tree/SyntaxNode and @codemirror/state's Text (a rope, not a UI object) plus
// @codemirror/lang-javascript's bare parser -- none of that pulls in an EditorView, so this file has no
// dependency on which editor widget is mounted, or whether one is mounted at all.
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { Text } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { canAccessVariable, SCRIPT_HANDLERS, Node } from 'cleo'
import type { NodeVariableType } from 'cleo'
import { NodeResolver } from './nodeExpressions'

/** Variables the engine owns (template/mesh ids). The Variables panel hides them; so do we. */
const RESERVED = '__'
const isReserved = (name: string) => name.startsWith(RESERVED)

const HANDLER_LIST = SCRIPT_HANDLERS.join(', ')

/** Synthesized on the script proxy rather than declared on Node, so `name in node` does not see them. */
export const LOOKUP_MEMBERS = ['findNode', 'getNodeById', 'getNodesByName']

/** A parsed script, ready for lintCore/completionCore/hoverCore. Cheap enough to redo on every keystroke
 *  (it is exactly what CodeMirror's own linter already re-parses on every change). */
export interface ParsedScript {
  tree: Tree
  doc: Text
}

export function parseScript(source: string): ParsedScript {
  return { tree: javascriptLanguage.parser.parse(source), doc: Text.of(source.split('\n')) }
}

/** Editor-agnostic diagnostic: a character range (Lezer/CodeMirror offsets, UTF-16 code units) + message. */
export interface CoreDiagnostic {
  from: number
  to: number
  message: string
}

function resolverFor(tree: Tree, doc: Text, self: Node): NodeResolver {
  const resolver = new NodeResolver(self, doc)
  resolver.collect(tree.topNode)
  return resolver
}

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

/**
 * Checks `this.<variable>` (and other.*, this.parent.*, ...) against the node(s) NodeResolver can pin an
 * expression to: existence, access level, and literal-assignment type. Silent wherever the node can only
 * be proven to BE a node, not which one -- see nodeExpressions.ts's module comment.
 */
export function lintScriptCore(tree: Tree, doc: Text, self: Node): CoreDiagnostic[] {
  const text = (n: SyntaxNode) => doc.sliceString(n.from, n.to)
  const resolver = resolverFor(tree, doc, self)

  const out: CoreDiagnostic[] = []
  const error = (from: number, to: number, message: string) => out.push({ from, to, message })

  tree.cursor().iterate((ref) => {
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

/** One completion after a dot on a node-valued expression. `detail` is a type ('number'), an owner note
 *  ("number · from 'Enemy'"), or a role ('handler' / 'scene lookup') depending on `kind`. */
export interface CoreCompletion {
  label: string
  kind: 'variable' | 'handler' | 'lookup' | 'member'
  detail?: string
  /** Higher sorts first: an own Variable beats a handler beats a scene-lookup helper. */
  boost: number
}

export interface CoreCompletionResult {
  /** Offset completions replace from (the position right after the dot) through the cursor. */
  from: number
  items: CoreCompletion[]
}

/** Public members of a node, walking the prototype chain (so ModelNode etc. contribute their own). */
function members(node: Node): string[] {
  const names = new Set<string>()
  for (let proto = Object.getPrototypeOf(node); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    for (const name of Object.getOwnPropertyNames(proto))
      if (!name.startsWith('_') && name !== 'constructor' && !SCRIPT_HANDLERS.includes(name as any)) names.add(name)
  return [...names]
}

/**
 * Completions after a dot on any node-valued expression: `this.`, `this.parent.`, `other.`,
 * `this.findNode('Player').`, `this.getNodesByName(name)[0].` … `at` is the tree node the cursor
 * resolved into (`tree.resolveInner(offset, -1)` in the caller) — mid-word or straight after the dot.
 */
export function nodeCompletionCore(tree: Tree, doc: Text, self: Node, at: SyntaxNode): CoreCompletionResult | null {
  const property = at.name === 'PropertyName' ? at : null
  const dot = at.name === '.' ? at : property?.prevSibling
  if (!dot || dot.name !== '.') return null

  const member = dot.parent
  if (!member || member.name !== 'MemberExpression') return null

  const resolver = resolverFor(tree, doc, self)
  const { nodes, isNode } = resolver.candidates(member.firstChild)
  if (!isNode) return null

  const known = nodes.length > 0
  const items: CoreCompletion[] = []

  if (known) {
    const seen = new Set<string>()
    for (const node of nodes)
      for (const [name, variable] of node.variables)
        if (!isReserved(name) && !seen.has(name)) {
          seen.add(name)
          items.push({ label: name, kind: 'variable', detail: variable.type, boost: 3 })
        }
  } else {
    // Unknown node: everything the scene declares, labelled with its owner so the guess is visible.
    const seen = new Set<string>()
    for (const node of self.scene?.nodes ?? [])
      for (const [name, variable] of node.variables)
        if (!isReserved(name) && !seen.has(name)) {
          seen.add(name)
          items.push({ label: name, kind: 'variable', detail: `${variable.type} · from '${node.name}'`, boost: 1 })
        }
  }

  // Handlers are only assignable on the script's own node.
  if (known && nodes.length === 1 && nodes[0] === self)
    items.push(...SCRIPT_HANDLERS.map((name) => ({ label: name, kind: 'handler' as const, detail: 'handler', boost: 2 })))

  items.push(...LOOKUP_MEMBERS.map((name) => ({ label: name, kind: 'lookup' as const, detail: 'scene lookup', boost: 0 })))
  items.push(...members(known ? nodes[0] : self).map((name) => ({ label: name, kind: 'member' as const, boost: 0 })))

  return { from: dot.to, items }
}

/** A node-name (or id) completion inside a lookup call's string literal: `[replaceFrom, replaceTo)` is
 *  the quoted content only (the quotes themselves are left alone). */
export interface CoreNameCompletionResult {
  replaceFrom: number
  replaceTo: number
  items: CoreCompletion[]
}

/**
 * Cursor is inside the string-literal argument of `findNode('…')` / `getNodeById('…')` /
 * `getNodesByName('…')`: offer every node name (or id, for getNodeById) in the scene. These are always
 * global scene lookups regardless of which node/scene expression they're called through — see
 * nodeExpressions.ts's LOOKUPS — so the receiver does not need to resolve to anything for this to apply.
 */
export function nodeNameCompletionCore(self: Node, at: SyntaxNode, doc: Text): CoreNameCompletionResult | null {
  if (at.name !== 'String') return null
  const call = at.parent?.parent   // String -> ArgList -> CallExpression
  if (!call || call.name !== 'CallExpression') return null
  const callee = call.firstChild
  if (!callee || callee.name !== 'MemberExpression') return null
  const method = callee.lastChild
  if (!method || method.name !== 'PropertyName') return null
  if (!LOOKUP_MEMBERS.includes(doc.sliceString(method.from, method.to))) return null

  const byId = doc.sliceString(method.from, method.to) === 'getNodeById'
  const items: CoreCompletion[] = []
  const seen = new Set<string>()
  for (const node of self.scene?.nodes ?? []) {
    const label = byId ? node.id : node.name
    if (seen.has(label)) continue
    seen.add(label)
    items.push({ label, kind: 'lookup', detail: byId ? `id of '${node.name}'` : undefined, boost: 0 })
  }

  return { replaceFrom: at.from + 1, replaceTo: at.to - 1, items }
}

/** The Variable (name, type, access) that `this.<name>`/`other.<name>` at `at` refers to, for hover. */
export function nodeVariableAt(tree: Tree, doc: Text, self: Node, at: SyntaxNode): { name: string; type: NodeVariableType; access: string; owner: string } | null {
  if (at.name !== 'PropertyName') return null
  const member = at.parent
  if (!member || member.name !== 'MemberExpression' || member.lastChild !== at) return null

  const resolver = resolverFor(tree, doc, self)
  const { nodes, isNode } = resolver.candidates(member.firstChild)
  if (!isNode) return null

  const name = doc.sliceString(at.from, at.to)
  const owner = nodes.find((node) => node.variables.has(name))
  if (!owner) return null

  const v = owner.variables.get(name)!
  return { name, type: v.type, access: v.access ?? 'public', owner: owner.name }
}
