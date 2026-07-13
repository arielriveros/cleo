// Works out which node an expression in a script refers to, so the editor can offer that node's
// Variables and check them. Both the linter and the completion source resolve through here, so what you
// get completions for and what gets type-checked can never disagree.
//
// The script's `this` is the node, and node lookups return nodes, so an expression is walked back to the
// node(s) it denotes:
//
//   this                              -> the script's node
//   this.parent.parent                -> ancestors
//   this.children[2]                  -> a specific child
//   this.findNode('Player')           -> resolved against the live edit-time scene
//   this.getNodesByName('Enemy')[0]   -> ditto
//   const p = this.findNode('Player') -> p carries the resolution
//   (node, other) => ...              -> a handler's first argument IS the script's node
//
// A lookup whose argument is not a literal (`this.getNodesByName(name)[0]`) still evaluates to a *node*
// at runtime, it just cannot be pinned to which one at edit time — that is `unknown`, and it is the
// difference between "offer helpers, check nothing" and "offer helpers, check everything". Guessing there
// would mean errors on nodes that only exist at runtime.

import type { SyntaxNode } from '@lezer/common'
import type { Text } from '@codemirror/state'
import { Node, SCRIPT_HANDLERS } from 'cleo'

/** A node-valued expression: either a known set of candidates, or a node we cannot identify. */
export type Resolution =
  | { kind: 'nodes'; nodes: Node[] }        // resolved to concrete node(s) in the edit-time scene
  | { kind: 'list'; nodes: Node[] }         // resolved to a concrete list (children, getNodesByName)
  | { kind: 'unknown' }                     // definitely a node, but which one is only known at runtime
  | { kind: 'unknownList' }
  | { kind: 'scene' }
  | null                                    // not a node expression at all

/** Node lookups a script can call. The engine synthesizes these on the script proxy (core/scene/node.ts). */
const LOOKUPS = ['findNode', 'getNodeById', 'getNodesByName'] as const

export class NodeResolver {
  private readonly bindings = new Map<string, SyntaxNode>()          // const p = <node expr>
  private readonly params: Array<{ name: string; from: number; to: number; self: boolean }> = []
  private resolving = new Set<string>()                              // recursion guard for cyclic bindings

  constructor(private readonly self: Node, private readonly doc: Text) {}

  private text(node: SyntaxNode): string {
    return this.doc.sliceString(node.from, node.to)
  }

  /**
   * Pre-scan for the two things that make an identifier mean a node: a `const p = this.findNode(...)`
   * binding, and a handler's parameters — `this.onTrigger = (node, other) => ...` binds `node` to the
   * script's own node (the engine passes it exactly that) and `other` to a node it cannot know.
   */
  collect(tree: SyntaxNode): void {
    tree.cursor().iterate((ref) => {
      if (ref.name === 'VariableDeclaration') {
        const define = ref.node.getChild('VariableDefinition')
        const init = define?.nextSibling?.nextSibling      // skip the `=`
        if (define && init) this.bindings.set(this.text(define), init)
        return
      }

      if (ref.name !== 'AssignmentExpression') return

      const target = ref.node.firstChild
      if (target?.name !== 'MemberExpression' || target.firstChild?.name !== 'this') return

      const handler = target.lastChild
      if (!handler || handler.name !== 'PropertyName' || !SCRIPT_HANDLERS.includes(this.text(handler) as any)) return

      const fn = ref.node.lastChild
      if (!fn || (fn.name !== 'ArrowFunction' && fn.name !== 'FunctionExpression')) return

      const names = (fn.getChild('ParamList')?.getChildren('VariableDefinition') ?? []).map((p) => this.text(p))
      // (node, ...) is always this script's node; (node, other) — the second is whatever collided with it.
      if (names[0]) this.params.push({ name: names[0], from: fn.from, to: fn.to, self: true })
      if (names[1]) this.params.push({ name: names[1], from: fn.from, to: fn.to, self: false })
    })
  }

  private scene() {
    return this.self.scene
  }

  /** The one literal argument of a lookup call, or null if it is dynamic. */
  private literalArg(call: SyntaxNode): string | null {
    const arg = call.getChild('ArgList')?.firstChild?.nextSibling
    if (!arg || arg.name !== 'String') return null
    return this.text(arg).slice(1, -1)
  }

  resolve(expr: SyntaxNode | null): Resolution {
    if (!expr) return null

    if (expr.name === 'this') return { kind: 'nodes', nodes: [this.self] }

    if (expr.name === 'VariableName') {
      const name = this.text(expr)

      const param = this.params.find((p) => p.name === name && expr.from >= p.from && expr.to <= p.to)
      if (param) return param.self ? { kind: 'nodes', nodes: [this.self] } : { kind: 'unknown' }

      const bound = this.bindings.get(name)
      if (!bound || this.resolving.has(name)) return null
      this.resolving.add(name)
      const resolved = this.resolve(bound)
      this.resolving.delete(name)
      return resolved
    }

    if (expr.name === 'CallExpression') {
      const callee = expr.firstChild
      if (callee?.name !== 'MemberExpression') return null

      const method = callee.lastChild
      if (method?.name !== 'PropertyName') return null

      const name = this.text(method)
      if (!LOOKUPS.includes(name as any)) return null

      // The receiver only has to *be* a node or the scene — every node shares one scene.
      const receiver = this.resolve(callee.firstChild)
      if (!receiver || receiver.kind === 'list' || receiver.kind === 'unknownList') return null

      const list = name === 'getNodesByName'
      const argument = this.literalArg(expr)
      if (argument === null) return list ? { kind: 'unknownList' } : { kind: 'unknown' }

      const scene = this.scene()
      if (!scene) return list ? { kind: 'unknownList' } : { kind: 'unknown' }

      if (list) return { kind: 'list', nodes: scene.getNodesByName(argument) }

      const found = name === 'findNode' ? scene.findNode(argument) : scene.getNodeById(argument)
      // A name that matches nothing today may well be spawned at runtime — do not pretend to know it.
      return found ? { kind: 'nodes', nodes: [found] } : { kind: 'unknown' }
    }

    if (expr.name !== 'MemberExpression') return null

    const base = this.resolve(expr.firstChild)
    if (!base) return null

    const property = expr.lastChild

    // `xs[0]` — an index into a node list. Lezer gives the MemberExpression a `]` last child, not a name.
    if (property?.name === ']') {
      const index = expr.getChild('Number')
      if (base.kind === 'unknownList') return { kind: 'unknown' }
      if (base.kind !== 'list' || !index) return null

      const found = base.nodes[Number(this.text(index))]
      return found ? { kind: 'nodes', nodes: [found] } : { kind: 'unknown' }
    }

    if (property?.name !== 'PropertyName') return null
    const name = this.text(property)

    if (name === 'scene') return base.kind === 'unknown' || base.kind === 'nodes' ? { kind: 'scene' } : null

    if (name === 'parent') {
      if (base.kind === 'unknown') return { kind: 'unknown' }
      if (base.kind !== 'nodes') return null
      const parents = base.nodes.map((n) => n.parent).filter((n): n is Node => !!n)
      return parents.length ? { kind: 'nodes', nodes: parents } : { kind: 'unknown' }
    }

    if (name === 'children') {
      if (base.kind === 'unknown') return { kind: 'unknownList' }
      if (base.kind !== 'nodes') return null
      return { kind: 'list', nodes: base.nodes.flatMap((n) => n.children) }
    }

    return null   // any other property is a variable or an engine member, not a node
  }

  /** The node(s) an expression denotes, for checking. Empty when it is a node we cannot identify. */
  candidates(expr: SyntaxNode | null): { nodes: Node[]; isNode: boolean } {
    const resolved = this.resolve(expr)
    if (!resolved) return { nodes: [], isNode: false }
    if (resolved.kind === 'nodes') return { nodes: resolved.nodes, isNode: true }
    if (resolved.kind === 'unknown') return { nodes: [], isNode: true }
    return { nodes: [], isNode: false }
  }
}
