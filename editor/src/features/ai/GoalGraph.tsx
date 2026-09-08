import { useMemo } from 'react'
import { AI_GOALS, parseGoalGraph } from 'cleo'
import type { GoalGraph as GoalGraphModel, GoalDefinition } from 'cleo'
import MachineGraph from '../../components/MachineGraph'
import type { GraphLinkModel, GraphNodeModel } from '../../components/MachineGraph'
import { useAiEditor } from './AiEditorContext'
import AiGraphToolbar, { AiEmptyState } from './AiGraphToolbar'

/**
 * The goal graph on a canvas: what an agent is trying to do, and what that breaks down into.
 *
 * A goal graph is a genuine tree — "attack" is "close the distance", then "strike" — and a tree is the
 * thing a list is worst at showing. The old inspector rendered `subgoals` as a field of names, which
 * meant reading a plan by cross-referencing rows.
 *
 * ## Edges are containment, not transitions
 *
 * A link here means "B is a subgoal of A", so every edge is one-way and its label is the position in
 * execution order. That order is authored order, and it is load-bearing rather than cosmetic: Yuka's
 * `addSubgoal` pushes to the FRONT of a stack popped from the BACK, so the first subgoal added runs
 * first. Drawing the index is what makes that visible instead of something you find out by testing.
 *
 * ## Why there is no entry node
 *
 * A machine starts somewhere; a goal graph does not. It ARBITRATES — every goal with an evaluator is
 * scored each interval and the best wins — so `allowEntry` is false and the right-click menu drops
 * the item rather than offering one that would do nothing.
 */

const AUTO_COLS = 4
const AUTO_DX = 210
const AUTO_DY = 120

export default function GoalGraph() {
  const { target: controller, selection, setSelection, version, commit } = useAiEditor()

  const graph = controller?.goals
  void version

  const selected = selection?.kind === 'goal' ? selection.name : null

  const apply = (next: GoalGraphModel) => {
    if (!controller) return
    // Through the tolerant reader, like every other AI write: it is what drops a subgoal naming a goal
    // that no longer exists, and what strips the subgoals of a goal that turns out to be cyclic.
    // Writing the object straight through would let the canvas author a plan that nests forever.
    controller.goals = parseGoalGraph(next)
    commit()
  }

  const posOf = (g: GoalDefinition, i: number) => (
    typeof g.x === 'number' && typeof g.y === 'number'
      ? { x: g.x, y: g.y }
      : { x: (i % AUTO_COLS) * AUTO_DX, y: Math.floor(i / AUTO_COLS) * AUTO_DY }
  )

  const nodes: GraphNodeModel[] = useMemo(() => (graph?.goals ?? []).map((g, i) => {
    const evaluator = graph?.evaluators.find(e => e.goalName === g.name)
    const composite = !!g.subgoals && g.subgoals.length > 0
    return {
      id: g.name,
      ...posOf(g, i),
      // A composite runs its children and drives no steering of its own, so showing its `goal` field
      // would advertise a verb that never fires.
      subtitle: composite ? `${g.subgoals!.length} subgoals` : g.goal,
      glyph: composite ? '▽' : undefined,
      glyphTitle: composite ? 'Composite: runs its subgoals in order' : undefined,
      kind: composite ? ('accent' as const) : ('default' as const),
      // Whether anything ever WANTS this goal. One with no evaluator can still run as somebody's
      // subgoal, but it can never be chosen on its own — very easy to author by accident, and
      // impossible to see in a list.
      badge: evaluator ? `×${evaluator.bias}` : 'no eval',
      badgeTitle: evaluator
        ? 'Desirability bias — this goal competes for selection'
        : 'No evaluator: this goal can only run as a subgoal, never be chosen',
      badgeTone: evaluator ? ('dim' as const) : ('warning' as const),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [graph, version])

  const links: GraphLinkModel[] = useMemo(() => {
    const out: GraphLinkModel[] = []
    for (const goal of graph?.goals ?? []) {
      goal.subgoals?.forEach((child, index) => {
        out.push({ a: goal.name, b: child, forward: true, backward: false, label: `${index + 1}` })
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, version])

  if (!controller || !graph) return <AiEmptyState what='goal graph' />

  const uniqueName = (base: string) => {
    const taken = graph.goals.map(g => g.name)
    if (!taken.includes(base)) return base
    for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`
  }

  const addGoal = (x: number, y: number) => apply({
    ...graph,
    goals: [...graph.goals, { name: uniqueName('goal'), goal: AI_GOALS[0], x, y }],
  })

  /** Drop a goal, every reference to it as a subgoal, and its evaluator. */
  const removeGoal = (name: string) => {
    setSelection(null)
    apply({
      ...graph,
      goals: graph.goals
        .filter(g => g.name !== name)
        .map(g => ({ ...g, subgoals: g.subgoals?.filter(s => s !== name) })),
      evaluators: graph.evaluators.filter(e => e.goalName !== name),
    })
  }

  return (
    <MachineGraph
      nodes={nodes}
      links={links}
      selectedNode={selected}
      allowEntry={false}
      nodeNoun='goal'
      onMoveNode={(id, x, y) => apply({
        ...graph,
        goals: graph.goals.map(g => (g.name === id ? { ...g, x, y } : g)),
      })}
      onConnect={(from, to) => {
        // A goal cannot contain itself, and a duplicate would be dropped by the reader anyway. Deeper
        // cycles (A contains B contains A) are caught by parseGoalGraph.
        if (from === to) return
        const parent = graph.goals.find(g => g.name === from)
        if (!parent || parent.subgoals?.includes(to)) return
        apply({
          ...graph,
          goals: graph.goals.map(g => (
            g.name === from ? { ...g, subgoals: [...(g.subgoals ?? []), to] } : g
          )),
        })
      }}
      onDelete={(ids, removed) => {
        setSelection(null)
        const gone = new Set(ids)
        apply({
          ...graph,
          goals: graph.goals
            .filter(g => !gone.has(g.name))
            .map(g => ({
              ...g,
              // Dropped when the child is gone, or when this exact containment was the edge deleted.
              subgoals: g.subgoals?.filter(s => (
                !gone.has(s) && !removed.some(([a, b]) => a === g.name && b === s)
              )),
            })),
          evaluators: graph.evaluators.filter(e => !gone.has(e.goalName)),
        })
      }}
      onSelectNode={(id) => setSelection(id ? { kind: 'goal', name: id } : null)}
      // A containment edge has nothing to inspect beyond its order, which the label already shows, so
      // clicking one selects the PARENT — where reordering actually happens.
      onSelectLink={(a) => setSelection({ kind: 'goal', name: a })}
      onAddNode={addGoal}
      onSetEntry={() => {}}
      onRemoveNode={removeGoal}
      hint='drag handle to handle to nest a subgoal · numbers are execution order · Del to remove · scores and conditions in the inspector'
      toolbar={
        <>
          <AiGraphToolbar />
          <button className='px-2 py-1 rounded bg-primary hover:bg-primary-hover text-white border border-primary-active text-xs'
            onClick={() => {
              const n = graph.goals.length
              addGoal((n % AUTO_COLS) * AUTO_DX + 40, Math.floor(n / AUTO_COLS) * AUTO_DY + 40)
            }}
            title='Add a new goal (or double-click the canvas)'>+ Goal</button>
        </>
      }
    />
  )
}
