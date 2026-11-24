import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useStateMachine, OP_LABEL, effectiveType, ANY_STATE, linkKey } from './StateMachineContext'
import {
  BoltIcon, Button, ChevronLeftIcon, cn, JOINED_DIVIDER_CLASS, JOINED_GROUP_CLASS, SegmentedControl,
} from '@cleo/app-kit/ui'
import MachineGraph from '../../components/MachineGraph'
import { LayerTabs } from './LayerPanels'
import type { GraphLinkModel, GraphMenuItem, GraphNodeModel } from '../../components/MachineGraph'
import { isConditionGroup } from 'cleo'
import type { AnimationTransition, AnimationCondition, AnimationConditionNode } from 'cleo'
import { graphPlan, inPort, outPort, realName, entryOf, PROXY_PREFIX, SELF_PREFIX, type PlanLink } from './stateGroups'
import { GroupIcon, IntoGroupIcon, OutOfGroupIcon, UngroupIcon, EntryIcon, ForkIcon, DissolveIcon } from './groupIcons'
import { rankOf, waysIn, waysOut } from './forks'

/**
 * The animation state machine on the shared node-graph canvas.
 *
 * All the interaction — dragging, connecting, the right-click menu, Delete — lives in `MachineGraph`,
 * which this feeds from `StateMachineContext`. What is left here is the part that is genuinely about
 * animation: what a state node SAYS, how a transition's gate reads as a label, and the toolbar.
 *
 * ## Groups
 *
 * A state group is drawn as ONE node standing for its states (`graphPlan`): a port on its left for each
 * outside state its transitions come from, one on its right for each place they go. A line from a port
 * stands for every transition between those ends, a dashed one for the group's own (from or to the group
 * itself, which fire from any of its states). Double-click a group to open it: its states, a stand-in for
 * each outside end, and "Any state in …" where the group's own transitions start.
 *
 * ## Forks
 *
 * A fork is drawn as a small diamond pill: transitions go in and come out, and the machine goes straight through
 * to the first way out that holds. Its ways out are labelled with their rank (1, 2, …), because that order is what
 * decides. A fork in a group is drawn inside it (a group's entry may be one), and stands for its group outside.
 */

const AUTO_COLS = 4
const AUTO_DX = 210
const AUTO_DY = 120
/** How far left and right of an opened group's states its stand-ins sit, and how far apart they stack. */
const PROXY_DX = 260
const PROXY_DY = 90

/**
 * Short human summary of a transition's gate for the edge label: the condition tree flattened to its
 * first couple of leaves.
 */
export function transitionLabel(t: AnimationTransition, paramOf: (n: string) => any): string {
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

/**
 * What a drawn line says: the gate of the one transition each way, or how many it stands for. A fork's way out leads
 * with its rank (`rank` is 0 for any other transition), since the first that holds is the one taken.
 */
function linkLabel(l: PlanLink, paramOf: (n: string) => any, rank: (t: AnimationTransition) => number): string {
  if (l.summary) {
    const all = [...l.forward, ...l.backward]
    return all.length === 1 ? `${all[0].from}: ${transitionLabel(all[0], paramOf) || 'always'}` : `${all.length} transitions`
  }
  const one = (t: AnimationTransition | undefined) => {
    if (!t) return ''
    const r = rank(t), gate = transitionLabel(t, paramOf)
    return r ? `${r} · ${gate || 'always'}` : gate
  }
  const fwd = one(l.forward[0])
  const bwd = one(l.backward[0])
  return l.forward.length && l.backward.length ? [fwd, bwd].filter(Boolean).join(' ⇄ ') || '⇄' : (fwd || bwd)
}

const nameOf = (n: string) => (n === ANY_STATE ? 'Any State' : n)

export default function StateGraph() {
  const { editorMode } = useCleoEngine()
  const {
    target, sm, selection, setSelection, graphView, setGraphView,
    addState, setState, addTransition, apply, stateIndex, commitLayout, deleteElements, paramOf,
    removeState, animationFields, fieldOf, fullSm, activeLayer,
    groups, groupOf, createGroup, setGroup, removeGroup, moveToGroup, openGroup, setOpenGroup,
    forks, isFork, addFork, setFork, removeFork, dissolveFork,
  } = useStateMachine()
  // The highlighted state is the ACTIVE layer's: the base reads `currentStateName`, a layer its own.
  const layerName = activeLayer > 0 ? fullSm.layers?.[activeLayer - 1]?.name ?? null : null

  const [activeState, setActiveState] = useState<string | null>(null)
  // Every node selected on the canvas, for Group: Ctrl+click or Shift+drag a box picks several.
  const [picked, setPicked] = useState<string[]>([])

  // Position for a state: stored x/y, else a deterministic auto-grid by list order.
  const posOf = useCallback((idx: number): { x: number; y: number } => {
    const s = sm.states[idx]
    if (s && typeof s.x === 'number' && typeof s.y === 'number') return { x: s.x, y: s.y }
    return { x: (idx % AUTO_COLS) * AUTO_DX, y: Math.floor(idx / AUTO_COLS) * AUTO_DY }
  }, [sm.states])
  // A fork without coordinates sits below the auto-grid, one slot per fork.
  const forkPos = useCallback((name: string): { x: number; y: number } => {
    const i = Math.max(0, forks.findIndex(f => f.name === name))
    const f = forks[i]
    if (f && typeof f.x === 'number' && typeof f.y === 'number') return { x: f.x, y: f.y }
    const rows = Math.ceil(sm.states.length / AUTO_COLS) + 1
    return { x: (i % AUTO_COLS) * AUTO_DX + 30, y: (rows + Math.floor(i / AUTO_COLS)) * AUTO_DY }
  }, [forks, sm.states.length])
  const posOfName = useCallback((name: string) => (isFork(name) ? forkPos(name) : posOf(Math.max(0, sm.states.findIndex(s => s.name === name)))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [posOf, sm.states, forkPos])
  // A group without coordinates sits where its states are.
  const groupPos = useCallback((name: string): { x: number; y: number } => {
    const g = groups.find(x => x.name === name)
    if (g && typeof g.x === 'number' && typeof g.y === 'number') return { x: g.x, y: g.y }
    const ps = (g?.states ?? []).map(posOfName)
    if (!ps.length) return { x: 0, y: 0 }
    return { x: Math.round(ps.reduce((s, p) => s + p.x, 0) / ps.length), y: Math.round(ps.reduce((s, p) => s + p.y, 0) / ps.length) }
  }, [groups, posOfName])

  // Persist the auto-layout once, for legacy machines whose states (or groups) have no coordinates.
  useEffect(() => {
    if (!graphView || sm.states.length === 0) return
    const missing = sm.states.some(s => typeof s.x !== 'number' || typeof s.y !== 'number')
      || groups.some(g => typeof g.x !== 'number' || typeof g.y !== 'number')
      || forks.some(f => typeof f.x !== 'number' || typeof f.y !== 'number')
    if (!missing) return
    const coords: Record<string, { x: number; y: number }> = {}
    sm.states.forEach((s, i) => { coords[s.name] = posOf(i) })
    for (const f of forks) coords[f.name] = forkPos(f.name)
    for (const g of groups) coords[g.name] = groupPos(g.name)
    commitLayout(coords)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphView, sm.states.length, groups.length, forks.length])

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

  // Nodes that are not states (Any State, an opened group's stand-ins) have no stored position: each sits
  // where it is laid out until dragged, and the drag lasts while the canvas is open.
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  const movedKey = (id: string) => `${activeLayer}|${openGroup ?? ''}|${id}`
  const placedAt = (id: string, fallback: { x: number; y: number }) => moved[movedKey(id)] ?? fallback

  const plan = useMemo(() => graphPlan(sm, openGroup), [sm, openGroup])

  const anyPos = useMemo(() => {
    const placed = plan.states.map(posOfName).concat(plan.groups.map(g => groupPos(g.name)), plan.forks.map(forkPos))
    const minX = placed.length ? Math.min(...placed.map(p => p.x)) : 0
    const minY = placed.length ? Math.min(...placed.map(p => p.y)) : 0
    return { x: minX - AUTO_DX, y: minY }
  }, [plan, posOfName, groupPos, forkPos])
  const anyCount = sm.transitions.filter(t => t.from === ANY_STATE).length

  const stateNode = useCallback((name: string): GraphNodeModel | null => {
    const i = stateIndex(name)
    const s = sm.states[i]
    if (!s) return null
    const field = s.fieldId ? fieldOf(s.fieldId) : undefined
    const playsField = !!s.fieldId
    const playsPose = !playsField && !!(s.poseRef || s.pose)
    // Stop motion (AnimationState.fps); a pose has no clock to step.
    const stepped = !playsPose && typeof s.fps === 'number' && s.fps > 0
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
      badge: `${s.loop ? '↻' : '→'} ×${s.speedParam ?? s.speed}${s.speedScaleParam ? `·${s.speedScaleParam}` : ''}`
        + (stepped ? ` · ${s.fps} fps` : ''),
      badgeTitle: (s.speedParam
        ? `Playback rate read from the "${s.speedParam}" parameter`
        : 'Fixed playback rate')
        + (s.speedScaleParam ? `, times the "${s.speedScaleParam}" parameter` : '')
        + (stepped ? `; stop motion at ${s.fps} poses a second` : ''),
      badgeTone: s.speedParam && playsField ? 'warning' : 'dim',
      // The triggers that enter it directly — a state a script plays by name needs no edge.
      chips: (s.triggers ?? []).filter(e => e.trigger).map(e => e.trigger),
      chipIcon: <BoltIcon className='w-2.5 h-2.5 shrink-0' />,
      chipsTitle: 'Entered directly by these triggers, from whatever state the layer is in',
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sm.states, posOf, animationFields])

  const nodes: GraphNodeModel[] = useMemo(() => {
    const out: GraphNodeModel[] = []
    if (!openGroup) {
      out.push({
        id: ANY_STATE,
        label: 'Any State',
        ...placedAt(ANY_STATE, anyPos),
        sourceOnly: true,
        deletable: false,
        entryable: false,
        kind: 'accent' as const,
        subtitle: anyCount ? `${anyCount} transition${anyCount > 1 ? 's' : ''} from any state` : 'drag out to fire from any state',
      })
    }
    for (const name of plan.states) { const n = stateNode(name); if (n) out.push(n) }
    for (const name of plan.forks) {
      const ins = waysIn(sm, name).length, outs = waysOut(sm, name).length
      const home = groupOf(name)
      out.push({
        id: name,
        ...forkPos(name),
        shape: 'fork',
        isEntry: !!home && entryOf(home) === name,
        entryable: false,
        noun: 'fork and its transitions',
        subtitle: `${ins} in · ${outs} out`,
      })
    }
    for (const g of plan.groups) {
      const peer = (p: string) => ({ label: nameOf(p), title: `${nameOf(p)}` })
      const stateCount = g.members.length - g.forks.length
      const counts = `${stateCount} state${stateCount === 1 ? '' : 's'}${g.forks.length ? `, ${g.forks.length} fork${g.forks.length === 1 ? '' : 's'}` : ''}`
      out.push({
        id: g.name,
        ...groupPos(g.name),
        entryable: false,
        noun: 'group and its states',
        badge: `${stateCount}`,
        subtitle: `${counts}: ${g.members.join(', ')}`,
        ports: {
          inputs: g.inputs.map(p => ({ id: inPort(p), ...peer(p), title: `From ${nameOf(p)}` })),
          outputs: g.outputs.map(p => ({ id: outPort(p), ...peer(p), title: `To ${nameOf(p)}` })),
        },
      })
    }
    if (openGroup && plan.self) {
      // The stand-ins: what comes in on the left, what it goes to on the right, stacked from the top of its states.
      const ps = plan.states.map(posOfName).concat(plan.forks.map(forkPos))
      const minX = ps.length ? Math.min(...ps.map(p => p.x)) : 0
      const maxX = ps.length ? Math.max(...ps.map(p => p.x)) : 0
      const minY = ps.length ? Math.min(...ps.map(p => p.y)) : 0
      const group = groups.find(g => g.name === openGroup)
      const entry = group ? entryOf(group) : undefined
      out.push({
        id: plan.self,
        label: `Any state in ${openGroup}`,
        ...placedAt(plan.self, { x: minX, y: minY - AUTO_DY }),
        sourceOnly: true, deletable: false, entryable: false, kind: 'accent',
        subtitle: entry ? `its own transitions · entered at ${entry}` : 'its own transitions start here',
        badgeTitle: 'A transition from here fires from any of the group’s states, after that state’s own',
      })
      let left = 0, right = 0
      for (const p of plan.proxies) {
        const other = p.name !== ANY_STATE ? groupOf(p.name) : undefined
        const at = p.side === 'in'
          ? { x: minX - PROXY_DX, y: minY + PROXY_DY * left++ }
          : { x: maxX + PROXY_DX, y: minY + PROXY_DY * right++ }
        out.push({
          id: p.id,
          label: nameOf(p.name),
          ...placedAt(p.id, at),
          kind: 'proxy',
          sourceOnly: p.name === ANY_STATE,
          deletable: false,
          entryable: false,
          subtitle: other ? `in ${other.name}` : groups.some(g => g.name === p.name) ? 'group' : isFork(p.name) ? 'fork' : 'outside this group',
        })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, stateNode, groupPos, forkPos, anyPos, anyCount, moved, openGroup, groups, activeLayer, sm.transitions])

  const graphLinks: GraphLinkModel[] = useMemo(() => plan.links.map(l => ({
    a: l.a,
    b: l.b,
    key: l.key,
    nodeA: l.nodeA,
    nodeB: l.nodeB,
    forward: l.forward.length > 0,
    backward: l.backward.length > 0,
    label: linkLabel(l, paramOf, t => rankOf(sm, t)),
    sourceHandle: l.sourceHandle,
    targetHandle: l.targetHandle,
    dashed: l.dashed,
    // A summary stands for transitions it does not name: those are removed from the inspector, one by one.
    deletable: !l.summary,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [plan, sm.parameters, sm.transitions])

  // The highlighted line: the selected link's (either order), or the summary's.
  const selectedLinkKey = useMemo(() => {
    if (selection?.kind === 'summary') return `${selection.from}>${selection.to}`
    if (selection?.kind !== 'transition') return null
    const [a, b] = linkKey(selection.a, selection.b)
    return plan.links.find(l => !l.summary && linkKey(l.a, l.b).join('|') === `${a}|${b}`)?.key ?? null
  }, [selection, plan])

  // A group's states are drawn as the group, so the state the machine is in lights up its group.
  const activeId = activeState && !openGroup ? (groupOf(activeState)?.name ?? activeState) : activeState

  if (editorMode !== 'stateMachine' || !graphView) return null

  const addAtCenter = () => {
    // Spread new states so they don't stack; offset by current count.
    const n = sm.states.length
    addState({ x: (n % AUTO_COLS) * AUTO_DX + 40, y: Math.floor(n / AUTO_COLS) * AUTO_DY + 40 })
  }

  const isGroupNode = (id: string) => !openGroup && groups.some(g => g.name === id)
  const isState = (id: string) => stateIndex(id) >= 0
  // What Group would take: the picked states and forks drawn on their own (not in a group), else the selected one.
  const single = selection?.kind === 'state' || selection?.kind === 'fork' ? [selection.name] : []
  const groupable = (picked.length ? picked : single)
    .filter(n => (isState(n) || isFork(n)) && !groupOf(n))
  const selectedGroup = selection?.kind === 'group' ? selection.name : null

  const select = (id: string | null) => {
    if (!id) { setSelection(null); return }
    const name = realName(id)
    if (id.startsWith(SELF_PREFIX) || groups.some(g => g.name === name)) setSelection({ kind: 'group', name })
    else if (isFork(name)) setSelection({ kind: 'fork', name })
    else setSelection({ kind: 'state', name })
  }

  /** Double-click: open a group; from a stand-in, go to what it stands for. */
  const dive = (id: string) => {
    const name = realName(id)
    // The opened group's own node goes back out to the whole layer.
    if (id.startsWith(SELF_PREFIX)) {
      setOpenGroup(null)
      setSelection({ kind: 'group', name })
      return
    }
    if (groups.some(g => g.name === name)) {
      setOpenGroup(name)
      setSelection({ kind: 'group', name })
      return
    }
    if (id.startsWith(PROXY_PREFIX)) {
      setOpenGroup(groupOf(name)?.name ?? null)
      setSelection(isFork(name) ? { kind: 'fork', name } : { kind: 'state', name })
    }
  }

  /** Moves from one drag: states and groups for good, stand-ins for this session. */
  const moveNodes = (moves: { id: string; x: number; y: number }[]) => {
    const session: Record<string, { x: number; y: number }> = {}
    for (const { id, x, y } of moves) {
      if (id === ANY_STATE || id.startsWith(PROXY_PREFIX) || id.startsWith(SELF_PREFIX)) { session[movedKey(id)] = { x, y }; continue }
      if (isGroupNode(id)) { setGroup(id, { x, y }); continue }
      if (isFork(id)) { setFork(id, { x, y }); continue }
      const i = stateIndex(id)
      if (i >= 0) setState(i, { x, y })
    }
    if (Object.keys(session).length) setMoved(prev => ({ ...prev, ...session }))
  }

  const menuItems = (id: string): GraphMenuItem[] => {
    const name = realName(id)
    const icon = (C: (p: React.SVGProps<SVGSVGElement>) => JSX.Element) => <span className='inline-block w-3.5 h-3.5 align-[-2px]'><C /></span>
    if (isGroupNode(id)) {
      return [
        { label: 'Open', icon: icon(IntoGroupIcon), title: 'Show its states (or double-click it)', onClick: () => dive(id) },
        { label: 'Ungroup', icon: icon(UngroupIcon), title: 'Its states back on the graph; each keeps the group’s transitions as its own', onClick: () => removeGroup(name, 'ungroup') },
      ]
    }
    if ((!isState(name) && !isFork(name)) || id.startsWith(PROXY_PREFIX)) return []
    const items: GraphMenuItem[] = []
    const home = groupOf(name)
    if (!home) {
      const members = picked.includes(name) ? groupable : [name]
      items.push({
        label: members.length > 1 ? `Group ${members.length}` : 'Group',
        icon: icon(GroupIcon),
        title: 'Put the selected states in a new group (Ctrl+click or Shift+drag to select several)',
        onClick: () => { createGroup(members); setPicked([]) },
      })
    } else {
      if (entryOf(home) !== name) {
        items.push({ label: 'Make group entry', icon: icon(EntryIcon), title: `A transition into ${home.name} enters ${isFork(name) ? 'through this fork' : 'this state'}`, onClick: () => setGroup(home.name, { entry: name }) })
      }
      items.push({ label: 'Take out of group', icon: icon(OutOfGroupIcon), title: `Out of ${home.name}, back on the whole graph`, onClick: () => moveToGroup(name, null) })
    }
    for (const g of groups) {
      if (g.name === home?.name) continue
      items.push({ label: `Move to ${g.name}`, icon: icon(IntoGroupIcon), title: `Make it one of ${g.name}’s ${isFork(name) ? 'forks' : 'states'}`, onClick: () => moveToGroup(name, g.name) })
    }
    if (isFork(name)) {
      items.push({
        label: 'Dissolve', icon: icon(DissolveIcon),
        title: 'Take the fork away and keep what it did: each way in joined to each way out',
        onClick: () => dissolveFork(name),
      })
    }
    return items
  }

  const iconButton = 'flex items-center justify-center px-1.5 py-1 text-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:pointer-events-none'

  return (
    <MachineGraph
      nodes={nodes}
      links={graphLinks}
      activeId={activeId}
      viewKey={`${activeLayer}|${openGroup ?? ''}`}
      selectedNode={selection?.kind === 'state' || selection?.kind === 'fork' ? selection.name : selection?.kind === 'group' ? (openGroup === selection.name ? null : selection.name) : null}
      selectedLink={null}
      selectedLinkKey={selectedLinkKey}
      onMoveNode={(id, x, y) => { moveNodes([{ id, x, y }]) }}
      onMoveNodes={moves => moveNodes(moves)}
      // Nothing transitions INTO "any state"; a stand-in or the group's own node stands for its name.
      onConnect={(from, to) => {
        const f = realName(from), t = realName(to)
        if (t !== ANY_STATE && f !== t) addTransition(f, t)
      }}
      onDelete={(ids, removed, keys) => {
        const exact: [string, string][] = []
        for (const k of keys ?? []) {
          const l = plan.links.find(x => x.key === k)
          if (l && !l.summary) for (const t of [...l.forward, ...l.backward]) exact.push([t.from, t.to])
        }
        deleteElements(ids.filter(id => !id.startsWith(PROXY_PREFIX) && !id.startsWith(SELF_PREFIX)), removed, exact)
      }}
      onSelectNode={select}
      onSelectLink={(a, b, key) => {
        const l = key ? plan.links.find(x => x.key === key) : undefined
        if (l?.summary) { setSelection({ kind: 'summary', from: l.a, to: l.b }); return }
        const [x, y] = linkKey(l?.a ?? a, l?.b ?? b)
        setSelection({ kind: 'transition', a: x, b: y })
      }}
      onNodeDoubleClick={dive}
      onSelectionChange={ids => setPicked(prev => {
        const next = ids.map(realName)
        return prev.length === next.length && prev.every((v, k) => v === next[k]) ? prev : next
      })}
      menuItems={menuItems}
      onAddNode={(x, y) => addState({ x, y })}
      onSetEntry={(id) => {
        const i = stateIndex(id)
        if (i >= 0) setState(i, { isEntry: true })
      }}
      onRemoveNode={(id) => {
        if (isGroupNode(id)) { removeGroup(id, 'delete'); return }
        if (isFork(id)) { removeFork(id); return }
        const i = stateIndex(id)
        if (i >= 0) removeState(i)
      }}
      hint={openGroup
        ? 'double-click a stand-in to go to it · drag from “Any state in …” for a group transition'
        : 'drag handle → handle to connect · double-click a group to open it · Ctrl+click several, then group them'}
      toolbar={
        <>
          <SegmentedControl<'3d' | 'graph'>
            className='shrink-0'
            options={[
              { value: '3d', label: 'Animations', doc: 'editor/animation#the-animator::Animations' },
              { value: 'graph', label: 'Graph', doc: 'editor/animation#the-animator::Graph' },
            ]}
            value='graph'
            onChange={v => setGraphView(v === 'graph')} />
          <LayerTabs />
          <Button variant='primary' className='shrink-0 whitespace-nowrap'
            onClick={addAtCenter} title='Add a new state (or double-click the canvas)'>+ State</Button>
          {/* Never squeezed: a long row of layer tabs would crush the strip down to its first button. */}
          <div className={cn(JOINED_GROUP_CLASS, 'shrink-0')}>
            <button type='button' className={iconButton}
              title={openGroup ? `Add a fork to ${openGroup}: transitions go in, and on to the first of its ways out that holds` : 'Add a fork: transitions go in, and on to the first of its ways out that holds'}
              onClick={() => { const n = forks.length; addFork({ x: (n % AUTO_COLS) * AUTO_DX + 60, y: Math.floor(n / AUTO_COLS) * AUTO_DY + 60 }) }}>
              <span className='w-4 h-4'><ForkIcon /></span>
            </button>
            <button type='button' className={cn(iconButton, JOINED_DIVIDER_CLASS)} disabled={!groupable.length || !!openGroup}
              title={groupable.length > 1 ? `Group the ${groupable.length} selected states` : 'Group the selected states (Ctrl+click or Shift+drag to select several)'}
              onClick={() => { createGroup(groupable); setPicked([]) }}>
              <span className='w-4 h-4'><GroupIcon /></span>
            </button>
            <button type='button' className={cn(iconButton, JOINED_DIVIDER_CLASS)} disabled={!selectedGroup}
              title='Ungroup: its states back on the graph, each keeping the group’s transitions as its own'
              onClick={() => selectedGroup && removeGroup(selectedGroup, 'ungroup')}>
              <span className='w-4 h-4'><UngroupIcon /></span>
            </button>
            <button type='button' className={cn(iconButton, JOINED_DIVIDER_CLASS)} disabled={!selectedGroup || openGroup === selectedGroup}
              title='Open the selected group (or double-click it)'
              onClick={() => selectedGroup && dive(selectedGroup)}>
              <span className='w-4 h-4'><IntoGroupIcon /></span>
            </button>
          </div>
          {openGroup && (
            <div className={cn(JOINED_GROUP_CLASS, 'items-center text-ui-xs shrink-0 whitespace-nowrap')}>
              <button type='button' className={iconButton} title='Back to the whole layer'
                onClick={() => { setOpenGroup(null); setSelection({ kind: 'group', name: openGroup }) }}>
                <span className='w-4 h-4'><ChevronLeftIcon /></span>
              </button>
              <span className={cn(JOINED_DIVIDER_CLASS, 'px-2 py-1 text-muted')}>
                {layerName ?? 'Base'} <span className='text-dim'>›</span> <span className='text-fg'>{openGroup}</span>
              </span>
            </div>
          )}
          <Button variant='success' className='shrink-0'
            onClick={apply} title='Save this animator (Ctrl+S)'>Save</Button>
        </>
      }
    />
  )
}
