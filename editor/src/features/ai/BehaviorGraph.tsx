import { useEffect, useMemo, useState } from 'react'
import { AI_GOALS, ControllerNode, parseBehaviorMachine } from 'cleo'
import type { BehaviorMachine, BehaviorState, BehaviorTransition, ConditionGroup } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import MachineGraph from '../../components/MachineGraph'
import type { GraphLinkModel, GraphNodeModel } from '../../components/MachineGraph'
import { behaviorLinkKey, behaviorLinks, hasWildcardTransitions } from '../../utils/aiGraphEdits'
import { useAiEditor } from './AiEditorContext'
import AiGraphToolbar, { AiEmptyState } from './AiGraphToolbar'

/**
 * The AI behaviour machine on the same canvas the animation state machine uses.
 *
 * Opened from the Behaviour section of a Controller's inspector and drawn over the viewport. It edits
 * STRUCTURE — add a state, connect two, set the entry, move things, delete — while the inspector list
 * behind it keeps editing DETAIL. That split is deliberate rather than an omission: the list already
 * shows every state and transition at once, so there is nothing for a graph selection to reveal, and
 * duplicating the condition tree onto the canvas would mean two places to edit one gate.
 *
 * ## Why it reads a session rather than owning one
 *
 * Which controller is open lives in `AiEditorContext`, shared with the Goals and Fuzzy canvases. That
 * is also what closes this for free when the controller is deleted.
 *
 * ## Wildcard transitions
 *
 * `from: '*'` matches any state, so it has no source node to draw an edge from. Those are skipped
 * rather than given a phantom endpoint, and the toolbar says how many were skipped — silently
 * omitting a transition that really runs is exactly the kind of thing a graph gets blamed for.
 */

const AUTO_COLS = 4
const AUTO_DX = 210
const AUTO_DY = 120

/** Short summary of a transition's gate, for the edge label. */
function transitionLabel(t: BehaviorTransition): string {
  const leaves: { param: string; op: string; value?: number }[] = []
  const walk = (n: unknown) => {
    const node = n as { children?: unknown[]; param?: string; op?: string; value?: number }
    if (Array.isArray(node?.children)) node.children.forEach(walk)
    else if (node?.param) leaves.push({ param: node.param, op: node.op ?? '', value: node.value })
  }
  if (t.condition) walk(t.condition)

  const dwell = t.minDwell ? `⏱${t.minDwell}s` : ''
  if (leaves.length === 0) return dwell
  const OP: Record<string, string> = { gt: '>', lt: '<', eq: '=', neq: '≠', true: 'is', false: 'not', trigger: '!' }
  const parts = leaves.slice(0, 2).map(c => (
    c.op === 'gt' || c.op === 'lt' || c.op === 'eq' || c.op === 'neq'
      ? `${c.param} ${OP[c.op]} ${c.value ?? 0}`
      : `${OP[c.op] ?? ''} ${c.param}`.trim()
  ))
  const extra = leaves.length > 2 ? ` +${leaves.length - 2}` : ''
  return [parts.join(', ') + extra, dwell].filter(Boolean).join(' · ')
}

export default function BehaviorGraph() {
  const { isPlayMode, instance } = useCleoEngine()
  const { target: controller, selection, setSelection, version, commit } = useAiEditor()
  const [activeState, setActiveState] = useState<string | null>(null)

  // The canvas selection IS the session selection, so the inspector on the right rail details whatever
  // is clicked here. Derived rather than duplicated: two copies would drift the moment either changed.
  const selected = selection?.kind === 'state' ? selection.name : null
  const selectedLink = selection?.kind === 'transition' ? { a: selection.a, b: selection.b } : null

  // Highlight the state the machine is actually in, but only while playing — the control pass does not
  // run a behaviour machine while authoring, so the readout would be a permanent blank otherwise.
  useEffect(() => {
    if (!controller || !isPlayMode) { setActiveState(null); return }
    let raf = 0
    const tick = () => {
      // The PLAY scene has its own copy of the node; the authoring one never advances.
      const live = instance?.scene?.getNodeById(controller.id)
      const name = live instanceof ControllerNode ? live.behaviorState : ''
      setActiveState(prev => (prev === (name || null) ? prev : (name || null)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [controller, isPlayMode, instance])

  const machine = controller?.behavior
  void version

  const apply = (next: BehaviorMachine) => {
    if (!controller) return
    controller.behavior = parseBehaviorMachine(next)
    commit()
  }

  const posOf = (s: BehaviorState, i: number) => (
    typeof s.x === 'number' && typeof s.y === 'number'
      ? { x: s.x, y: s.y }
      : { x: (i % AUTO_COLS) * AUTO_DX, y: Math.floor(i / AUTO_COLS) * AUTO_DY }
  )

  const nodes: GraphNodeModel[] = useMemo(() => (machine?.states ?? []).map((s, i) => ({
    id: s.name,
    ...posOf(s, i),
    isEntry: !!s.isEntry,
    // What the state DOES is its goal, which is the one thing a name may not convey.
    subtitle: s.goal,
    badge: s.targetKey ? `→${s.targetKey}` : (s.speedScale !== undefined ? `×${s.speedScale}` : undefined),
    badgeTitle: s.targetKey ? 'Blackboard key this state aims at' : 'Speed throttle for this state',
    badgeTone: 'dim' as const,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [machine, version])

  const links: GraphLinkModel[] = useMemo(() => (machine ? behaviorLinks(machine) : []).map(l => {
    const fwd = l.forward ? transitionLabel(l.forward) : ''
    const bwd = l.backward ? transitionLabel(l.backward) : ''
    const both = !!l.forward && !!l.backward
    return {
      a: l.a,
      b: l.b,
      forward: !!l.forward,
      backward: !!l.backward,
      label: both ? [fwd, bwd].filter(Boolean).join(' ⇄ ') || '⇄' : (fwd || bwd),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [machine, version])

  // No mode gate: `AiBrainTabView` mounts this only for a brain whose kind is 'behavior'.
  if (!controller || !machine) return <AiEmptyState what='behaviour machine' />

  const uniqueName = (base: string) => {
    const taken = machine.states.map(s => s.name)
    if (!taken.includes(base)) return base
    for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`
  }

  const addState = (x: number, y: number) => apply({
    ...machine,
    states: [...machine.states, {
      name: uniqueName('state'),
      goal: 'idle',
      // The first state authored is the entry, or a new machine has no way in.
      isEntry: machine.states.length === 0,
      x, y,
    }],
  })

  const skipped = hasWildcardTransitions(machine)
    ? machine.transitions.filter(t => t.from === '*').length
    : 0

  return (
    <MachineGraph
      nodes={nodes}
      links={links}
      activeId={activeState}
      selectedNode={selected}
      selectedLink={selectedLink}
      onMoveNode={(id, x, y) => apply({
        ...machine,
        states: machine.states.map(s => (s.name === id ? { ...s, x, y } : s)),
      })}
      onConnect={(from, to) => {
        // A duplicate would be dropped by the tolerant reader anyway; refusing here keeps the graph
        // from flashing an edge that will not survive.
        if (machine.transitions.some(t => t.from === from && t.to === to)) return
        apply({
          ...machine,
          transitions: [...machine.transitions, {
            from, to, condition: { op: 'and', children: [] } as ConditionGroup,
          }],
        })
      }}
      onDelete={(ids, removed) => {
        const gone = new Set(ids)
        // Clear first: an inspector still pointed at a deleted state would detail a ghost, and the
        // tolerant reader that re-parses the machine drops the state without telling anyone.
        setSelection(null)
        const pairs = removed.map(([a, b]) => behaviorLinkKey(a, b).join('|'))
        apply({
          ...machine,
          states: machine.states.filter(s => !gone.has(s.name)),
          transitions: machine.transitions.filter(t => {
            if (gone.has(t.from) || gone.has(t.to)) return false
            // Deleting an edge removes BOTH directions; the inspector list drops just one.
            return !pairs.includes(behaviorLinkKey(t.from, t.to).join('|'))
          }),
        })
      }}
      onSelectNode={(id) => setSelection(id ? { kind: 'state', name: id } : null)}
      onSelectLink={(a, b) => setSelection({ kind: 'transition', a, b })}
      onAddNode={addState}
      onSetEntry={(id) => apply({
        ...machine,
        // Exactly one entry: flagging a new one clears the old.
        states: machine.states.map(s => ({ ...s, isEntry: s.name === id })),
      })}
      onRemoveNode={(id) => {
        setSelection(null)
        apply({
          ...machine,
          states: machine.states.filter(s => s.name !== id),
          transitions: machine.transitions.filter(t => t.from !== id && t.to !== id),
        })
      }}
      hint={
        (skipped > 0 ? `${skipped} “any state” transition${skipped > 1 ? 's' : ''} not drawn · ` : '')
        + 'drag handle → handle to connect · right-click a state · Del to remove · edit details in the inspector'
      }
      toolbar={
        <>
          <AiGraphToolbar />
          <button className='px-2 py-1 rounded bg-primary hover:bg-primary-hover text-white border border-primary-active text-xs'
            onClick={() => {
              const n = machine.states.length
              addState((n % AUTO_COLS) * AUTO_DX + 40, Math.floor(n / AUTO_COLS) * AUTO_DY + 40)
            }}
            title='Add a new state (or double-click the canvas)'>+ State</button>
        </>
      }
    />
  )
}

/** The goals a state may pursue, for the inspector's dropdown. Re-exported so both stay in step. */
export const BEHAVIOR_GOALS = AI_GOALS
