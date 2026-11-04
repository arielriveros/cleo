import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useStateMachine, OP_LABEL, effectiveType, ANY_STATE } from './StateMachineContext'
import { BoltIcon, Button, SegmentedControl } from '@cleo/app-kit/ui'
import MachineGraph from '../../components/MachineGraph'
import { LayerTabs } from './LayerPanels'
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
    removeState, animationFields, fieldOf, fullSm, activeLayer,
  } = useStateMachine()
  // The highlighted state is the ACTIVE layer's: the base reads `currentStateName`, a layer its own.
  const layerName = activeLayer > 0 ? fullSm.layers?.[activeLayer - 1]?.name ?? null : null

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
      const name = (layerName ? target.animator.layerStateName(layerName) : target.animator.currentStateName) ?? null
      setActiveState(prev => (prev === name ? prev : name))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, graphView, layerName])

  // "Any State": where `from: '*'` transitions start — they can fire whichever state the layer is in (an
  // Actions layer's one-shots). Not a state, so it has no stored position: it sits left of the graph
  // until dragged, and the drag lasts while the canvas is open.
  const [anyMoved, setAnyMoved] = useState<{ layer: number; x: number; y: number } | null>(null)
  const anyPos = useMemo(() => {
    if (anyMoved && anyMoved.layer === activeLayer) return { x: anyMoved.x, y: anyMoved.y }
    const placed = sm.states.map((_, i) => posOf(i))
    const minX = placed.length ? Math.min(...placed.map(p => p.x)) : 0
    const minY = placed.length ? Math.min(...placed.map(p => p.y)) : 0
    return { x: minX - AUTO_DX, y: minY }
  }, [anyMoved, activeLayer, sm.states, posOf])
  const anyCount = sm.transitions.filter(t => t.from === ANY_STATE).length

  const stateNodes: GraphNodeModel[] = useMemo(() => sm.states.map((s, i) => {
    const field = s.fieldId ? fieldOf(s.fieldId) : undefined
    const playsField = !!s.fieldId
    const playsPose = !playsField && !!(s.poseRef || s.pose)
    // The ⊞ badge is what distinguishes a blend state from a clip state; the name alone does not.
    const what = playsField ? (field?.name || '(missing field)')
      : playsPose ? `pose: ${s.pose?.name ?? 'pose'}`
      : s.clipName ? `${s.clipName}${s.startTime ? ` @${s.startTime}s` : ''}`
      : (activeLayer > 0 ? '(empty — adds nothing)' : '(no clip)')
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
      badge: `${s.loop ? '↻' : '→'} ×${s.speedParam ?? s.speed}${s.speedScaleParam ? `·${s.speedScaleParam}` : ''}`,
      badgeTitle: (s.speedParam
        ? `Playback rate read from the "${s.speedParam}" parameter`
        : 'Fixed playback rate')
        + (s.speedScaleParam ? `, times the "${s.speedScaleParam}" parameter` : ''),
      badgeTone: s.speedParam && playsField ? 'warning' : 'dim',
      // The triggers that enter it directly — a state a script plays by name needs no edge.
      chips: (s.triggers ?? []).filter(e => e.trigger).map(e => e.trigger),
      chipIcon: <BoltIcon className='w-2.5 h-2.5 shrink-0' />,
      chipsTitle: 'Entered directly by these triggers, from whatever state the layer is in',
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sm.states, posOf, animationFields])

  const nodes: GraphNodeModel[] = useMemo(() => [{
    id: ANY_STATE,
    label: 'Any State',
    ...anyPos,
    sourceOnly: true,
    deletable: false,
    kind: 'accent' as const,
    subtitle: anyCount ? `${anyCount} transition${anyCount > 1 ? 's' : ''} from any state` : 'drag out to fire from any state',
  }, ...stateNodes], [stateNodes, anyPos, anyCount])

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

  if (editorMode !== 'stateMachine' || !graphView) return null

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
        if (id === ANY_STATE) { setAnyMoved({ layer: activeLayer, x, y }); return }
        const i = stateIndex(id)
        if (i >= 0) setState(i, { x, y })
      }}
      // Nothing transitions INTO "any state".
      onConnect={(from, to) => { if (to !== ANY_STATE) addTransition(from, to) }}
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
            options={[
              { value: '3d', label: 'Animations', doc: 'editor/animation#the-animator::Animations' },
              { value: 'graph', label: 'Graph', doc: 'editor/animation#the-animator::Graph' },
            ]}
            value='graph'
            onChange={v => setGraphView(v === 'graph')} />
          <LayerTabs />
          <Button variant='primary'
            onClick={addAtCenter} title='Add a new state (or double-click the canvas)'>+ State</Button>
          <Button variant='success'
            onClick={apply} title='Save this animator (Ctrl+S)'>Save</Button>
        </>
      }
    />
  )
}
