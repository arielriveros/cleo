import { useMemo, useState } from 'react'
import { AI_GOALS, ControllerNode, parseGoalGraph } from 'cleo'
import type { AiGoal, DesirabilityDefinition, GoalDefinition, GoalGraph } from 'cleo'
import ConditionTreeView, { emptyConditionGroup } from '../../../components/ConditionTreeView'
import type { ConditionParam } from '../../../components/ConditionTreeView'
import {
  Button, ButtonWithConfirm, NumberInput, Select, Slider, TextInput, cn, hintClass, labelClass,
  sectionTitleClass,
} from '../../../components/ui'
import { hintAffordance } from '../../../components/ui/Field'
import ParamSourcePicker from './ParamSourcePicker'
import { renameGoal } from '../../../utils/aiGraphEdits'

/**
 * The goal graph: what an agent is trying to achieve, and how badly.
 *
 * A LIST, like the behaviour machine's editor and for the same reason — a node canvas is its own
 * project, and these rows get the condition tree for free because it is already shared.
 *
 * Two things this editor has to make legible, because both are surprising:
 *
 *  - **An evaluator cannot abstain.** Yuka's arbitration starts at -1, so a goal scoring 0 still wins
 *    if it is the only one. That is why the empty state seeds a graph with a fallback rather than a
 *    single goal, and why the hint says so.
 *  - **A goal's conditions read the behaviour machine's parameters.** `until` and `failWhen` are
 *    condition trees over the same parameter table, so an author needs parameters declared over in
 *    the Behaviour section for them to compare anything. The editor says so instead of showing an
 *    empty dropdown.
 */

const GOALS_HINT = 'What the agent wants, scored. Whichever goal scores highest runs; a goal with subgoals runs them in order. Adding a graph changes nothing until Brain is switched to "goal".'
const DESIRE_HINT = 'Desirability maps one readable value onto 0..1, then multiplies by the bias. A range running BACKWARDS inverts it, which is how "nearer is better" reads: from 20 to 0 scores 1 when the distance is 0.'
const ABSTAIN_HINT = 'Nothing can abstain: the best score starts below zero, so a goal scoring 0 still wins if it is the only candidate. Author a low-scoring fallback rather than expecting nothing to run.'
const SUBGOAL_HINT = 'Names of goals to run in order, comma separated. A goal with subgoals drives none of its own — its children do. Self-reference and cycles are dropped when the graph is read.'
const UNTIL_HINT = 'The goal reports COMPLETED once this is met, which pops it and lets its parent move on. Compares the Behaviour section’s parameters, so declare one there first.'
const FAIL_HINT = 'The goal FAILS once this is met. Failure beats completion when both are true — "I am in reach" and "my target died" want the second answer.'
const INTERVAL_HINT = 'Seconds between reconsidering. A finished plan always re-plans immediately regardless; this is about ABANDONING one partway. Every frame makes an agent that flickers between two nearly-equal goals.'

interface Props {
  node: ControllerNode
  onChange: () => void
}

export default function GoalsEditor({ node, onChange }: Props) {
  const [version, setVersion] = useState(0)
  const graph = node.goals

  const apply = (next: GoalGraph) => {
    node.goals = parseGoalGraph(next)
    setVersion(v => v + 1)
    onChange()
  }
  void version

  // `until` / `failWhen` compare the BEHAVIOUR machine's parameter table -- the engine refreshes it
  // before stepping the goal brain precisely so these can read it.
  const params: ConditionParam[] = useMemo(() => node.behavior.parameters.map(p => ({
    name: p.name,
    type: p.type === 'boolean' ? 'bool' : p.type === 'trigger' ? 'trigger' : 'float',
  })), [node.behavior])

  const fuzzyOutputs = useMemo(
    () => Array.from(new Set(node.fuzzy.rules.map(r => r.variable))), [node.fuzzy])

  const goalNames = graph.goals.map(g => g.name)

  const uniqueName = (base: string, taken: string[]) => {
    if (!taken.includes(base)) return base
    for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`
  }

  const patchGoal = (name: string, patch: Partial<GoalDefinition>) =>
    apply({ ...graph, goals: graph.goals.map(g => (g.name === name ? { ...g, ...patch } : g)) })

  const patchEvaluator = (index: number, patch: Partial<DesirabilityDefinition>) =>
    apply({ ...graph, evaluators: graph.evaluators.map((e, i) => (i === index ? { ...e, ...patch } : e)) })

  const header = (label: string, hint?: string) => (
    <div className={cn(sectionTitleClass, 'mt-3 mb-1', hintAffordance(hint))} title={hint}>{label}</div>
  )

  if (graph.goals.length === 0) {
    return (
      <div className='mt-2'>
        <p className={hintClass}>{GOALS_HINT}</p>
        <Button size='sm' className='mt-1'
          onClick={() => apply({
            // Seeded with a fallback as well as a goal: nothing can abstain, so a lone goal always
            // wins and an author would never see arbitration do anything.
            goals: [{ name: 'Idle', goal: 'idle' }, { name: 'Chase', goal: 'seek', targetKey: 'target' }],
            evaluators: [
              { goalName: 'Idle', source: { kind: 'const', value: 1 }, from: 0, to: 10, bias: 1 },
              { goalName: 'Chase', source: { kind: 'sense', name: 'targetInSight' }, from: 0, to: 1, bias: 1 },
            ],
            arbitrationInterval: 0.5,
          })}>
          Add a goal graph
        </Button>
      </div>
    )
  }

  return (
    <div>
      <p className={hintClass}>{ABSTAIN_HINT}</p>

      {header('Goals', SUBGOAL_HINT)}
      <div className='flex flex-col gap-1'>
        {graph.goals.map(g => (
          <div key={g.name} className='rounded border border-border bg-control/30 p-1.5 flex flex-col gap-1'>
            <div className='flex items-center gap-1'>
              <TextInput className='flex-1 min-w-0' value={g.name}
                onChange={(raw) => {
                  const trimmed = raw.trim()
                  if (!trimmed || trimmed === g.name) return
                  const unique = uniqueName(trimmed, goalNames.filter(n => n !== g.name))
                  // Evaluators and subgoal lists address goals BY NAME, so a rename has to carry both
                  // or the tolerant reader silently drops every reference to the old name.
                  apply(renameGoal(graph, g.name, unique))
                }} />
              <Select className='w-[92px]' value={g.goal}
                title={g.subgoals?.length ? 'Ignored: this goal runs its subgoals instead.' : undefined}
                onChange={(e) => patchGoal(g.name, { goal: e.target.value as AiGoal })}>
                {AI_GOALS.map(v => <option key={v} value={v}>{v}</option>)}
              </Select>
              <ButtonWithConfirm
                onClick={() => apply({
                  ...graph,
                  goals: graph.goals
                    .filter(x => x.name !== g.name)
                    .map(x => ({ ...x, subgoals: x.subgoals?.filter(s => s !== g.name) })),
                  evaluators: graph.evaluators.filter(e => e.goalName !== g.name),
                })}>
                ✕
              </ButtonWithConfirm>
            </div>

            <div className='flex items-center gap-1'>
              <span className={labelClass}>Target</span>
              <TextInput className='flex-1 min-w-0' value={g.targetKey ?? ''}
                title='Blackboard key for this goal’s target. Empty uses the controller’s own.'
                onChange={(targetKey) => patchGoal(g.name, { targetKey: targetKey || undefined })} />
              <Slider label='' min={0} max={1} step={0.05} value={g.speedScale ?? 1}
                labelClassName='w-0' readout={(v) => `×${v.toFixed(2)}`}
                onChange={(v) => patchGoal(g.name, { speedScale: v })} />
            </div>

            <div className='flex items-center gap-1'>
              <span className={cn(labelClass, hintAffordance(SUBGOAL_HINT))} title={SUBGOAL_HINT}>Subgoals</span>
              <TextInput className='flex-1 min-w-0' value={(g.subgoals ?? []).join(', ')}
                placeholder='none'
                onChange={(raw) => {
                  const names = raw.split(',').map(s => s.trim()).filter(Boolean)
                  patchGoal(g.name, { subgoals: names.length > 0 ? names : undefined })
                }} />
            </div>

            <ConditionSlot label='Until' hint={UNTIL_HINT} params={params}
              value={g.until} onChange={(until) => patchGoal(g.name, { until })} />
            <ConditionSlot label='Fail when' hint={FAIL_HINT} params={params}
              value={g.failWhen} onChange={(failWhen) => patchGoal(g.name, { failWhen })} />
          </div>
        ))}
        <Button size='sm' variant='ghost'
          onClick={() => apply({
            ...graph,
            goals: [...graph.goals, { name: uniqueName('goal', goalNames), goal: 'idle' }],
          })}>
          + Goal
        </Button>
      </div>

      {header('Desirability', DESIRE_HINT)}
      <div className='flex flex-col gap-1'>
        {graph.evaluators.map((e, i) => (
          <div key={i} className='rounded border border-border bg-control/30 p-1.5 flex flex-col gap-1'>
            <div className='flex items-center gap-1'>
              <Select className='flex-1 min-w-0' value={e.goalName}
                onChange={(ev) => patchEvaluator(i, { goalName: ev.target.value })}>
                {goalNames.map(n => <option key={n} value={n}>{n}</option>)}
              </Select>
              <ButtonWithConfirm
                onClick={() => apply({ ...graph, evaluators: graph.evaluators.filter((_, x) => x !== i) })}>
                ✕
              </ButtonWithConfirm>
            </div>
            <ParamSourcePicker source={e.source} fuzzyOutputs={fuzzyOutputs}
              onChange={(source) => patchEvaluator(i, { source })} />
            <div className='flex items-center gap-1'>
              <span className={labelClass}>0 at</span>
              <NumberInput className='w-[64px]' value={e.from}
                onChange={(from) => patchEvaluator(i, { from })} />
              <span className={labelClass}>1 at</span>
              <NumberInput className='w-[64px]' value={e.to}
                onChange={(to) => patchEvaluator(i, { to })} />
              <span className={labelClass}>×</span>
              <NumberInput className='w-[56px]' value={e.bias}
                onChange={(bias) => patchEvaluator(i, { bias })} />
            </div>
          </div>
        ))}
        <Button size='sm' variant='ghost'
          onClick={() => apply({
            ...graph,
            evaluators: [...graph.evaluators, {
              goalName: goalNames[0],
              source: { kind: 'sense', name: 'distanceToTarget' },
              from: 20, to: 0, bias: 1,
            }],
          })}>
          + Desirability
        </Button>
      </div>

      {header('Arbitration', INTERVAL_HINT)}
      <Slider label='Interval' min={0} max={5} step={0.05} value={graph.arbitrationInterval}
        title={INTERVAL_HINT} labelClassName='w-[104px]'
        readout={(v) => (v === 0 ? 'every frame' : `${v.toFixed(2)}s`)}
        onChange={(arbitrationInterval) => apply({ ...graph, arbitrationInterval })} />
    </div>
  )
}

/** An optional condition tree: a button while absent, the tree plus a clear once added. */
function ConditionSlot(
  { label, hint, params, value, onChange }: {
    label: string
    hint: string
    params: ConditionParam[]
    value: GoalDefinition['until']
    onChange(v: GoalDefinition['until']): void
  },
) {
  if (!value) {
    return (
      <Button size='sm' variant='ghost' title={hint}
        onClick={() => onChange(emptyConditionGroup())}>
        + {label}
      </Button>
    )
  }
  return (
    <div className='rounded border border-border/60 p-1'>
      <div className='flex items-center justify-between mb-1'>
        <span className={cn(labelClass, hintAffordance(hint))} title={hint}>{label}</span>
        <ButtonWithConfirm onClick={() => onChange(undefined)}>✕</ButtonWithConfirm>
      </div>
      {params.length === 0 && (
        <p className={hintClass}>
          No parameters to compare. Declare one in the Behaviour section — goal conditions read the
          same table.
        </p>
      )}
      <ConditionTreeView node={value} params={params} onChange={onChange} />
    </div>
  )
}
