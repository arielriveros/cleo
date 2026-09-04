import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useStateMachine, OP_LABEL, effectiveType } from './StateMachineContext'
import { SegmentedControl } from '../../components/ui'
import MachineGraph from '../../components/MachineGraph'
import type { GraphLinkModel, GraphNodeModel } from '../../components/MachineGraph'
import { isConditionGroup } from 'cleo'
import type { AnimationTransition, AnimationCondition, AnimationConditionNode } from 'cleo'

/**
 * The animation state machine on the shared node-graph canvas.
 *
 * All the interaction — dragging, connecting, the right-click menu, Delete — lives in `MachineGraph`,
 * which this feeds from `StateMachineContext`. What is left here is the part that is genuinely about
 * animation: what a state node SAYS, how a transition's gate reads as a label, and the toolbar.
 */

const AUTO_COLS = 4
const AUTO_DX = 210
const AUTO_DY = 120

/**
 * Short human summary of a transition's gate for the edge label: the condition tree flattened to its
 * first couple of leaves.
 */
function transitionLabel(t: AnimationTransition, paramOf: (n: string) => any): string {
  const leaves: AnimationCondition[] = []
  const walk = (n: AnimationConditionNode) => { isConditionGroup(n) ? n.children.forEach(walk) : leaves.push(n) }
  if (t.condition) walk(t.condition)
  else t.conditions.forEach(c => leaves.push(c))

  if (leaves.length === 0) return t.hasExitTime ? 'exit' : ''
  const parts = leaves.slice(0, 2).map(c => {
    const type = effectiveType(paramOf(c.param))
    if (type === 'float') return `${c.param} ${OP_LABEL[c.op]} ${c.value ?? 0}`
    if (type === 'bool') return `${c.param} ${OP_LABEL[c.op]}`
    return `${c.param}`
  })
  // The join is a hint only: an OR gate reads as ', ' here, same as an AND.
  const extra = leaves.length > 2 ? ` +${leaves.length - 2}` : ''
  return parts.join(', ') + extra
}

export default function StateGraph() {
  const { editorMode } = useCleoEngine()
  const {
    target, sm, links, selection, setSelection, graphView, setGraphView,
    addState, setState, addTransition, apply, stateIndex, commitLayout, deleteElements, paramOf,
    removeState, animationFields, fieldOf,
  } = useStateMachine()

  const [activeState, setActiveState] = useState<string | null>(null)

  // Position for a state: stored x/y, else a deterministic auto-grid by list order.
  const posOf = useCallback((idx: number): { x: number; y: number } => {
    const s = sm.states[idx]
    if (s && typeof s.x === 'number' && typeof s.y === 'number') return { x: s.x, y: s.y }
    return { x: (idx % AUTO_COLS) * AUTO_DX, y: Math.floor(idx / AUTO_COLS) * AUTO_DY }
  }, [sm.states])

  // Persist the auto-layout once, for legacy machines whose states have no coordinates.
  useEffect(() => {
    if (!graphView || sm.states.length === 0) return
    const missing = sm.states.filter(s => typeof s.x !== 'number' || typeof s.y !== 'number')
    if (missing.length === 0) return
    const coords: Record<string, { x: number; y: number }> = {}
    sm.states.forEach((s, i) => { coords[s.name] = posOf(i) })
    commitLayout(coords)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphView, sm.states.length])

  // Polls the animator's active state for the Simulate highlight, only while the graph is visible.
  useEffect(() => {
    if (!target || !graphView) { setActiveState(null); return }
    let raf = 0
    const tick = () => {
      const name = target.animator.currentStateName ?? null
      setActiveState(prev => (prev === name ? prev : name))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, graphView])

  const nodes: GraphNodeModel[] = useMemo(() => sm.states.map((s, i) => {
    const field = s.fieldId ? fieldOf(s.fieldId) : undefined
    const playsField = !!s.fieldId
    // The ⊞ badge is what distinguishes a blend state from a clip state; the name alone does not.
    const what = playsField ? (field?.name || '(missing field)') : (s.clipName || '(no clip)')
    return {
      id: s.name,
      ...posOf(i),
      isEntry: !!s.isEntry,
      subtitle: what,
      subtitleMissing: playsField && !field?.name,
      glyph: playsField ? '⊞' : undefined,
      glyphTitle: 'Animation field (blend space)',
      // A rate read from a parameter is shown by NAME. It is the single most common reason a state
      // looks right in a preview (which always runs at rate 1) and wrong in Play, so it has to be
      // legible without selecting the node. Highlighted on a field state, where it multiplies an
      // already speed-matched blend.
      badge: `${s.loop ? '↻' : '→'} ×${s.speedParam ?? s.speed}`,
      badgeTitle: s.speedParam
        ? `Playback rate read from the "${s.speedParam}" parameter`
        : 'Fixed playback rate',
      badgeTone: s.speedParam && playsField ? 'warning' : 'dim',
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sm.states, posOf, animationFields])

  const graphLinks: GraphLinkModel[] = useMemo(() => links.map(l => {
    const fwd = l.forward ? transitionLabel(l.forward, paramOf) : ''
    const bwd = l.backward ? transitionLabel(l.backward, paramOf) : ''
    const both = !!l.forward && !!l.backward
    return {
      a: l.a,
      b: l.b,
      forward: !!l.forward,
      backward: !!l.backward,
      label: both ? [fwd, bwd].filter(Boolean).join(' ⇄ ') || '⇄' : (fwd || bwd),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [links, sm.parameters])

  if (editorMode !== 'animation' || !graphView) return null

  const addAtCenter = () => {
    // Spread new states so they don't stack; offset by current count.
    const n = sm.states.length
    addState({ x: (n % AUTO_COLS) * AUTO_DX + 40, y: Math.floor(n / AUTO_COLS) * AUTO_DY + 40 })
  }

  return (
    <MachineGraph
      nodes={nodes}
      links={graphLinks}
      activeId={activeState}
      selectedNode={selection?.kind === 'state' ? selection.name : null}
      selectedLink={selection?.kind === 'transition' ? { a: selection.a, b: selection.b } : null}
      onMoveNode={(id, x, y) => {
        const i = stateIndex(id)
        if (i >= 0) setState(i, { x, y })
      }}
      onConnect={(from, to) => addTransition(from, to)}
      onDelete={(ids, removed) => deleteElements(ids, removed)}
      onSelectNode={(id) => setSelection(id ? { kind: 'state', name: id } : null)}
      onSelectLink={(a, b) => setSelection({ kind: 'transition', a, b })}
      onAddNode={(x, y) => addState({ x, y })}
      onSetEntry={(id) => {
        const i = stateIndex(id)
        if (i >= 0) setState(i, { isEntry: true })
      }}
      onRemoveNode={(id) => {
        const i = stateIndex(id)
        if (i >= 0) removeState(i)
      }}
      toolbar={
        <>
          <SegmentedControl<'3d' | 'graph'>
            options={[{ value: '3d', label: 'Animations' }, { value: 'graph', label: 'Graph' }]}
            value='graph'
            onChange={v => setGraphView(v === 'graph')} />
          <button className='px-2 py-1 rounded bg-primary hover:bg-primary-hover text-white border border-primary-active text-xs'
            onClick={addAtCenter} title='Add a new state (or double-click the canvas)'>+ State</button>
          <button className='px-2 py-1 rounded bg-success hover:bg-success-hover text-white text-xs'
            onClick={apply} title='Save the machine onto the model (used at runtime and by Simulate)'>Apply</button>
        </>
      }
    />
  )
}
