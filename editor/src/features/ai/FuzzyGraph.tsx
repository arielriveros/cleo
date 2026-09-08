import { useMemo } from 'react'
import { parseFuzzyModel } from 'cleo'
import type { FuzzyModel, FuzzyTermNode } from 'cleo'
import MachineGraph from '../../components/MachineGraph'
import type { GraphLinkModel, GraphNodeModel } from '../../components/MachineGraph'
import { useAiEditor } from './AiEditorContext'
import AiGraphToolbar, { AiEmptyState } from './AiGraphToolbar'

/**
 * The fuzzy model as a graph: variables feeding rules, rules feeding a variable.
 *
 * ## Rules are NODES, and that is the whole design decision here
 *
 * A fuzzy rule is a hyper-edge — "IF distance is close AND health is low THEN retreat is high" reads
 * several antecedent variables and writes one consequent. `MachineGraph` connects PAIRS, so a rule
 * cannot be an edge without either losing antecedents or drawing one rule as several unrelated lines.
 *
 * Promoting the rule to a node of its own makes every connection a pair again: each antecedent
 * variable links INTO the rule, and the rule links OUT to its consequent. It also happens to be how a
 * rule reads on paper, and it gives the rule somewhere to hang its own hedges.
 *
 * ## What the canvas can and cannot author
 *
 * Structure: add a variable, add a rule, wire an antecedent in, wire a consequent out, delete. The
 * SETS — seven shapes with left/mid/right breakpoints — stay in the inspector, because their shape is
 * a curve to be tuned rather than a connection to be drawn, and squeezing a curve editor into a node
 * would make both worse.
 *
 * A rule wired to a variable is given that variable's FIRST set. Which set it means is a choice with
 * no sensible default, and picking one is a click in the inspector rather than a modal on the canvas.
 */

const AUTO_DX = 240
const AUTO_DY = 110
const RULE_PREFIX = 'rule:'

/** Canvas id for a rule. Prefixed so it can never collide with a variable's name. */
const ruleId = (index: number) => `${RULE_PREFIX}${index}`
const ruleIndexOf = (id: string) => (
  id.startsWith(RULE_PREFIX) ? Number(id.slice(RULE_PREFIX.length)) : -1
)

/** Every `is` leaf under a term, however the tree is nested — the rule's antecedent variables. */
export function antecedentLeaves(term: FuzzyTermNode): { variable: string; set: string }[] {
  switch (term.op) {
    case 'is': return [{ variable: term.variable, set: term.set }]
    case 'and':
    case 'or': return term.children.flatMap(antecedentLeaves)
    default: return antecedentLeaves(term.child)
  }
}

/** A short readback of a rule's antecedent, for the node's subtitle. */
function antecedentLabel(term: FuzzyTermNode): string {
  const leaves = antecedentLeaves(term)
  if (leaves.length === 0) return 'no antecedent'
  const joiner = term.op === 'or' ? ' OR ' : ' AND '
  const shown = leaves.slice(0, 2).map(l => `${l.variable} is ${l.set}`).join(joiner)
  return leaves.length > 2 ? `${shown} +${leaves.length - 2}` : shown
}

/** Add `leaf` to a term as another AND branch, preserving whatever was already there. */
export function withLeaf(term: FuzzyTermNode, leaf: FuzzyTermNode): FuzzyTermNode {
  if (term.op === 'and') return { op: 'and', children: [...term.children, leaf] }
  return { op: 'and', children: [term, leaf] }
}

/** Drop every `is` leaf naming `variable`, collapsing a branch that empties out. */
export function withoutVariable(term: FuzzyTermNode, variable: string): FuzzyTermNode | null {
  switch (term.op) {
    case 'is':
      return term.variable === variable ? null : term
    case 'and':
    case 'or': {
      const kept = term.children
        .map(c => withoutVariable(c, variable))
        .filter((c): c is FuzzyTermNode => c !== null)
      if (kept.length === 0) return null
      // A one-child AND is just that child; leaving the wrapper would grow a tower of them.
      return kept.length === 1 ? kept[0] : { op: term.op, children: kept }
    }
    default: {
      const child = withoutVariable(term.child, variable)
      return child ? { op: term.op, child } : null
    }
  }
}

export default function FuzzyGraph() {
  const { target: controller, selection, setSelection, version, commit } = useAiEditor()

  const model = controller?.fuzzy
  void version

  const selected = selection?.kind === 'fuzzyVar'
    ? selection.name
    : selection?.kind === 'fuzzyRule' ? ruleId(selection.index) : null

  const apply = (next: FuzzyModel) => {
    if (!controller) return
    // Through the tolerant reader: it is what drops a rule naming a variable or set that no longer
    // exists, and what refuses a variable with no sets (whose range would be empty, so every fuzzify
    // against it falls out of range and silently returns the PREVIOUS answer).
    controller.fuzzy = parseFuzzyModel(next)
    commit()
  }

  const nodes: GraphNodeModel[] = useMemo(() => {
    if (!model) return []
    const out: GraphNodeModel[] = []

    // Variables in a left column, rules in a right one, so the default layout already reads as
    // "inputs feed rules" before anyone drags anything.
    model.variables.forEach((v, i) => {
      const range = v.sets.length > 0
        ? `${Math.min(...v.sets.map(s => s.left))}–${Math.max(...v.sets.map(s => s.right))}`
        : ''
      out.push({
        id: v.name,
        x: typeof v.x === 'number' && typeof v.y === 'number' ? v.x : 0,
        y: typeof v.x === 'number' && typeof v.y === 'number' ? v.y : i * AUTO_DY,
        subtitle: `${v.sets.length} set${v.sets.length === 1 ? '' : 's'}`,
        kind: 'default',
        badge: range,
        // The one trap worth surfacing on the canvas: Yuka's fuzzify neither throws nor clamps on an
        // input outside a variable's range — it returns the previous call's answer.
        badgeTitle: 'The union of this variable’s sets. Input outside it is clamped before use.',
        badgeTone: 'dim',
      })
    })

    model.rules.forEach((r, i) => {
      out.push({
        id: ruleId(i),
        x: typeof r.x === 'number' && typeof r.y === 'number' ? r.x : AUTO_DX * 2,
        y: typeof r.x === 'number' && typeof r.y === 'number' ? r.y : i * AUTO_DY,
        subtitle: antecedentLabel(r.antecedent),
        glyph: '⇒',
        glyphTitle: 'Rule: antecedent implies the consequent',
        kind: 'accent',
        badge: `${r.variable} is ${r.set}`,
        badgeTitle: 'The consequent this rule drives',
        badgeTone: 'primary',
      })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, version])

  const links: GraphLinkModel[] = useMemo(() => {
    const out: GraphLinkModel[] = []
    model?.rules.forEach((r, i) => {
      const id = ruleId(i)
      // Antecedent variables in. De-duplicated: one variable read twice in a rule is still one line.
      const seen = new Set<string>()
      for (const leaf of antecedentLeaves(r.antecedent)) {
        if (seen.has(leaf.variable)) continue
        seen.add(leaf.variable)
        out.push({ a: leaf.variable, b: id, forward: true, backward: false, label: leaf.set })
      }
      // Consequent out.
      out.push({ a: id, b: r.variable, forward: true, backward: false, label: r.set })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, version])

  if (!controller || !model) return <AiEmptyState what='fuzzy model' />

  const uniqueName = (base: string) => {
    const taken = model.variables.map(v => v.name)
    if (!taken.includes(base)) return base
    for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`
  }

  /**
   * Add a variable with one starter set.
   *
   * The set is not optional: `parseFuzzyModel` drops a variable that has none, so adding a bare one
   * would look like the canvas ignoring the click.
   */
  const addVariable = (x: number, y: number) => apply({
    ...model,
    variables: [...model.variables, {
      name: uniqueName('variable'),
      sets: [{ name: 'mid', shape: 'triangular', left: 0, mid: 50, right: 100 }],
      x, y,
    }],
  })

  const firstSetOf = (variable: string) => model.variables.find(v => v.name === variable)?.sets[0]?.name

  const addRule = (x: number, y: number) => {
    // A rule needs a consequent to exist at all, so there has to be a variable to point at.
    const target = model.variables[0]
    if (!target || target.sets.length === 0) return
    apply({
      ...model,
      rules: [...model.rules, {
        antecedent: { op: 'is', variable: target.name, set: target.sets[0].name },
        variable: target.name,
        set: target.sets[0].name,
        x, y,
      }],
    })
  }

  return (
    <MachineGraph
      nodes={nodes}
      links={links}
      selectedNode={selected}
      allowEntry={false}
      nodeNoun='node'
      onMoveNode={(id, x, y) => {
        const index = ruleIndexOf(id)
        if (index >= 0) {
          apply({ ...model, rules: model.rules.map((r, i) => (i === index ? { ...r, x, y } : r)) })
        } else {
          apply({ ...model, variables: model.variables.map(v => (v.name === id ? { ...v, x, y } : v)) })
        }
      }}
      onConnect={(from, to) => {
        const fromRule = ruleIndexOf(from)
        const toRule = ruleIndexOf(to)

        // variable -> rule: another antecedent. Given the variable's first set; which set it should
        // really be is a choice with no default, made in the inspector.
        if (fromRule < 0 && toRule >= 0) {
          const set = firstSetOf(from)
          if (!set) return
          apply({
            ...model,
            rules: model.rules.map((r, i) => (i === toRule
              ? { ...r, antecedent: withLeaf(r.antecedent, { op: 'is', variable: from, set }) }
              : r)),
          })
          return
        }

        // rule -> variable: the consequent. One per rule, so this REPLACES rather than adds — and the
        // old consequent's edge disappears, which is the honest drawing of what just happened.
        if (fromRule >= 0 && toRule < 0) {
          const set = firstSetOf(to)
          if (!set) return
          apply({
            ...model,
            rules: model.rules.map((r, i) => (i === fromRule ? { ...r, variable: to, set } : r)),
          })
        }
        // rule -> rule and variable -> variable mean nothing here, so both are dropped silently.
      }}
      onDelete={(ids, removed) => {
        setSelection(null)

        // Three removals, kept separate on purpose. Folding them into one keyed set was tried and the
        // rule indices stopped lining up the moment any rule was dropped, because the index was then
        // being looked up against the already-filtered array.
        const deletedRules = new Set(ids.map(ruleIndexOf).filter(i => i >= 0))
        const deletedVars = new Set(ids.filter(id => ruleIndexOf(id) < 0))
        // Antecedent edges: which VARIABLES to unwire from which rule, by the rule's ORIGINAL index.
        const unwired = new Map<number, Set<string>>()
        for (const [a, b] of removed) {
          // An edge is variable -> rule or rule -> variable, and only the first is an antecedent that
          // can be dropped on its own. Cutting a consequent edge would leave a rule driving nothing,
          // which the reader discards entirely, so those are ignored here.
          const rule = ruleIndexOf(b)
          if (rule < 0 || ruleIndexOf(a) >= 0) continue
          if (!unwired.has(rule)) unwired.set(rule, new Set())
          unwired.get(rule)!.add(a)
        }

        const rules = model.rules
          // Index captured BEFORE any filtering, so `unwired` and `deletedRules` still refer to the
          // rules the canvas was drawing.
          .map((rule, index) => ({ rule, index }))
          .filter(({ index }) => !deletedRules.has(index))
          // A rule whose consequent variable is gone cannot be rewritten into anything meaningful.
          .filter(({ rule }) => !deletedVars.has(rule.variable))
          .map(({ rule, index }) => {
            let term: FuzzyTermNode | null = rule.antecedent
            for (const variable of [...deletedVars, ...(unwired.get(index) ?? [])]) {
              if (!term) break
              term = withoutVariable(term, variable)
            }
            // No antecedent left is a rule that fires on nothing; the reader drops it anyway.
            return term ? { ...rule, antecedent: term } : null
          })
          .filter((r): r is typeof model.rules[number] => r !== null)

        apply({
          ...model,
          variables: model.variables.filter(v => !deletedVars.has(v.name)),
          rules,
        })
      }}
      onSelectNode={(id) => {
        if (!id) return setSelection(null)
        const index = ruleIndexOf(id)
        setSelection(index >= 0 ? { kind: 'fuzzyRule', index } : { kind: 'fuzzyVar', name: id })
      }}
      // An edge here has no data of its own — the set it names lives on the rule — so clicking one
      // selects the rule it belongs to, which is where that set is changed.
      onSelectLink={(a, b) => {
        const index = ruleIndexOf(a) >= 0 ? ruleIndexOf(a) : ruleIndexOf(b)
        setSelection(index >= 0 ? { kind: 'fuzzyRule', index } : null)
      }}
      onAddNode={addVariable}
      onSetEntry={() => {}}
      onRemoveNode={(id) => {
        setSelection(null)
        const index = ruleIndexOf(id)
        if (index >= 0) {
          apply({ ...model, rules: model.rules.filter((_, i) => i !== index) })
          return
        }
        apply({
          ...model,
          variables: model.variables.filter(v => v.name !== id),
          // Rules that read it lose the leaf; rules that WRITE it cannot survive at all.
          rules: model.rules
            .filter(r => r.variable !== id)
            .map(r => ({ ...r, antecedent: withoutVariable(r.antecedent, id) }))
            .filter((r): r is typeof model.rules[number] => r.antecedent !== null),
        })
      }}
      hint='variables feed rules, rules drive one variable · double-click for a variable · set shapes in the inspector'
      toolbar={
        <>
          <AiGraphToolbar />
          <button className='px-2 py-1 rounded bg-primary hover:bg-primary-hover text-white border border-primary-active text-xs'
            onClick={() => addVariable(0, model.variables.length * AUTO_DY + 40)}
            title='Add a new variable (or double-click the canvas)'>+ Variable</button>
          <button className='px-2 py-1 rounded bg-control hover:bg-control-hover text-white border border-border text-xs disabled:opacity-40'
            disabled={model.variables.length === 0}
            onClick={() => addRule(AUTO_DX * 2, model.rules.length * AUTO_DY + 40)}
            title={model.variables.length === 0
              ? 'Add a variable first — a rule needs something to read and something to drive'
              : 'Add a new rule'}>+ Rule</button>
        </>
      }
    />
  )
}
