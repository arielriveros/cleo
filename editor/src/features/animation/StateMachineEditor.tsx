import type {
  AnimationParameter, AnimationConditionOp, AnimationVariableBinding, AnimationParameterType,
} from 'cleo'
import { AccessibleVariable } from './skeleton'
import { useStateMachine, OPS_FOR, OP_LABEL, effectiveType } from './StateMachineContext'
import Collapsable from '../../components/Collapsable'

// Right-sidebar inspector for the Animation State Machine. The graph (StateGraph) is the primary way to
// add / move / connect states; this panel keeps the machine-wide tools (Apply, Import, Clips,
// Parameters, Events, Test) and shows a details panel for whatever the graph has selected.

const input = 'bg-control text-white border border-control-hover rounded px-1 py-0.5 text-xs'
const btn = 'px-2 py-1 rounded bg-primary hover:bg-primary-hover text-white border border-primary-active text-xs'
const ghost = 'px-1.5 py-0.5 rounded border border-control-hover hover:bg-control text-xs'
const danger = 'px-1.5 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white text-xs'

export default function StateMachineEditor() {
  const sm = useStateMachine()
  const {
    target, hasBoneNames, clips, accessVars, selection, graphView, setGraphView,
    apply, addParam, setParam, removeParam, addEvent, setEvent, removeEvent,
    renameClip, deleteClip, importAnimationFiles, importSkeletonNames, closeTab, activeTabId,
  } = sm

  if (!target) {
    return <div className='flex flex-col bg-surface-raised w-full h-full p-3 text-sm text-gray-400'>No skinned model selected.</div>
  }
  const machine = sm.sm

  return (
    <div className='flex flex-col text-white bg-surface-raised w-full h-full overflow-y-auto'>
      <div className='p-2 border-b border-border flex items-center justify-between'>
        <div className='text-xs uppercase tracking-wide text-highlight'>Animation State Machine</div>
        <button className={ghost} title='Close the Animation Editor tab' onClick={() => closeTab(activeTabId)}>Close</button>
      </div>

      <div className='p-2 flex flex-col gap-1'>
        <div className='flex gap-1'>
          <button className={btn + ' flex-1'} onClick={apply} title='Save the machine onto the original model (used at runtime and by Simulate)'>
            Apply to Model
          </button>
          <button className={ghost + (graphView ? ' bg-selected border-white' : '')} onClick={() => setGraphView(!graphView)}
            title='Toggle the node-graph view over the 3D preview'>
            {graphView ? 'Graph ✓' : 'Graph'}
          </button>
        </div>
        <label className={ghost + ' w-full text-center cursor-pointer'} title='Import animation clips (glTF / GLB / FBX) onto this skeleton'>
          Import Animation…
          <input type='file' multiple className='hidden' accept='.gltf,.glb,.fbx,.bin'
            onChange={e => { const fs = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; if (fs.length) importAnimationFiles(fs) }} />
        </label>
        {!hasBoneNames && (
          <label className={ghost + ' w-full text-center cursor-pointer border-warning text-warning'}
            title='This model has no bone names, so imported animations match by node index (wrong bones). Load the ORIGINAL file this character was imported from to add bone names.'>
            ⚠ Add bone names from file…
            <input type='file' multiple className='hidden' accept='.gltf,.glb,.fbx,.bin'
              onChange={e => { const fs = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; if (fs.length) importSkeletonNames(fs) }} />
          </label>
        )}
        <p className='text-[10px] text-gray-500 mt-0.5'>Edit states visually in the graph. Scripts drive it with <code>animator.setFloat/setBool/setTrigger()</code>.</p>
      </div>

      {/* Selected element details */}
      <Collapsable title='Selected'>
        <div className='p-2 flex flex-col gap-2'>
          {!selection && <p className='text-[11px] text-gray-400'>Select a state or transition in the graph.</p>}
          {selection?.kind === 'state' && <SelectedState />}
          {selection?.kind === 'transition' && <SelectedTransition />}
        </div>
      </Collapsable>

      {/* Clips */}
      <Collapsable title='Clips'>
        <div className='p-2 flex flex-col gap-1'>
          {clips.length === 0 && <p className='text-[11px] text-gray-400'>No clips. Import one above.</p>}
          {clips.map(name => (
            <div key={name} className='flex items-center gap-1'>
              <input className={input + ' flex-1'} defaultValue={name} title='Rename clip (Enter to apply)'
                onBlur={e => renameClip(name, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
              <button className={danger} title='Delete clip' onClick={() => deleteClip(name)}>✕</button>
            </div>
          ))}
        </div>
      </Collapsable>

      {/* Parameters */}
      <Collapsable title='Parameters'>
        <div className='p-2 flex flex-col gap-1'>
          {machine.parameters.map((p, i) => (
            <div key={i} className='flex items-center gap-1'>
              <input className={input + ' flex-1'} value={p.name} onChange={e => setParam(i, { name: e.target.value })} />
              <select className={input} value={p.type} onChange={e => setParam(i, { type: e.target.value as AnimationParameterType })}>
                <option value='float'>float</option>
                <option value='bool'>bool</option>
                <option value='trigger'>trigger</option>
                <option value='variable'>variable</option>
              </select>
              {p.type === 'float'
                ? <input className={input + ' w-[56px]'} type='number' step='0.1' value={Number(p.default)} onChange={e => setParam(i, { default: parseFloat(e.target.value) || 0 })} />
                : p.type === 'bool'
                  ? <input type='checkbox' checked={!!p.default} onChange={e => setParam(i, { default: e.target.checked })} />
                  : p.type === 'trigger'
                    ? <span className='text-[10px] text-gray-500 w-[56px] text-center'>—</span>
                    : <VariablePicker vars={accessVars} value={p.variable}
                        onPick={b => setParam(i, { variable: b, default: b?.varType === 'boolean' ? false : 0 })} />}
              <button className={danger} onClick={() => removeParam(i)}>✕</button>
            </div>
          ))}
          <button className={ghost + ' self-start mt-1'} onClick={addParam}>+ Parameter</button>
        </div>
      </Collapsable>

      {/* Events */}
      <Collapsable title='Events'>
        <div className='p-2 flex flex-col gap-1'>
          {machine.events.map((e, i) => (
            <div key={i} className='flex items-center gap-1'>
              <select className={input} value={e.clipName} onChange={ev => setEvent(i, { clipName: ev.target.value })} title='clip'>
                {clips.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <input className={input + ' w-[52px]'} type='number' step='0.05' min='0' title='time (s)' value={e.time} onChange={ev => setEvent(i, { time: parseFloat(ev.target.value) || 0 })} />
              <input className={input + ' flex-1'} value={e.eventName} onChange={ev => setEvent(i, { eventName: ev.target.value })} title='event name' />
              <button className={danger} onClick={() => removeEvent(i)}>✕</button>
            </div>
          ))}
          <button className={ghost + ' self-start mt-1'} onClick={addEvent}>+ Event</button>
        </div>
      </Collapsable>

      {/* Live test */}
      <Collapsable title='Test'>
        <div className='p-2 flex flex-col gap-1'>
          <p className='text-[10px] text-gray-500'>Apply first, then enable <b>simulate</b> on the transport and drive parameters here.</p>
          {machine.parameters.map((p, i) => (
            <div key={i} className='flex items-center gap-2 text-xs'>
              <span className='flex-1 truncate' title={p.name}>{p.name}</span>
              {p.type === 'float' && <input className={input + ' w-[64px]'} type='number' step='0.1' defaultValue={Number(p.default)} onChange={e => target.animator.setFloat(p.name, parseFloat(e.target.value) || 0)} />}
              {p.type === 'bool' && <input type='checkbox' defaultChecked={!!p.default} onChange={e => target.animator.setBool(p.name, e.target.checked)} />}
              {p.type === 'trigger' && <button className={ghost} onClick={() => target.animator.setTrigger(p.name)}>fire</button>}
              {p.type === 'variable' && (
                <span className='text-[10px] text-gray-500 truncate' title={p.variable ? `${p.variable.nodeRef}.${p.variable.varName}` : 'unbound'}>
                  {p.variable ? `= ${String(target.animator.getParam(p.name))} (from ${p.variable.nodeRef}.${p.variable.varName})` : 'unbound'}
                </span>
              )}
            </div>
          ))}
          {machine.parameters.length === 0 && <p className='text-[11px] text-gray-400'>No parameters.</p>}
        </div>
      </Collapsable>
    </div>
  )
}

// ---- Selected state details -----------------------------------------------------------------------
function SelectedState() {
  const {
    sm: machine, selection, clips, paramOf, setState, removeState, stateIndex,
    addTransition, setTransition, removeTransition, addCondition, setCondition, removeCondition,
  } = useStateMachine()
  if (selection?.kind !== 'state') return null
  const i = stateIndex(selection.name)
  if (i < 0) return null
  const s = machine.states[i]
  const outgoing = machine.transitions.map((t, ti) => ({ t, ti })).filter(({ t }) => t.from === s.name)

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-1'>
        <input title='Entry state' type='radio' checked={!!s.isEntry} onChange={() => setState(i, { isEntry: true })} />
        <input className={input + ' flex-1 min-w-0'} title='State name' value={s.name} onChange={e => setState(i, { name: e.target.value })} />
        <button className={danger + ' shrink-0'} title='Delete state' onClick={() => removeState(i)}>✕</button>
      </div>
      <div className='flex items-center gap-1'>
        <select className={input + ' flex-1 min-w-0'} title='Animation clip' value={s.clipName} onChange={e => setState(i, { clipName: e.target.value })}>
          <option value=''>(no clip)</option>
          {clips.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className='flex items-center gap-0.5 text-[10px] shrink-0' title='Loop'>
          <input type='checkbox' checked={s.loop} onChange={e => setState(i, { loop: e.target.checked })} />loop
        </label>
        <input className={input + ' w-[42px] shrink-0'} type='number' step='0.1' title='Speed' value={s.speed} onChange={e => setState(i, { speed: parseFloat(e.target.value) || 0 })} />
      </div>

      <div className='text-[10px] uppercase tracking-wide text-gray-400 mt-1'>Transitions from {s.name}</div>
      {outgoing.length === 0 && <p className='text-[11px] text-gray-500'>None. Drag from this node's right handle in the graph, or add below.</p>}
      {outgoing.map(({ t, ti }) => (
        <div key={ti} className='border border-control rounded p-1.5 flex flex-col gap-1'>
          <div className='flex items-center gap-1'>
            <span className='text-[10px] text-gray-400 whitespace-nowrap'>{t.from} →</span>
            <select className={input + ' flex-1'} value={t.to} onChange={e => setTransition(ti, { to: e.target.value })}>
              {machine.states.map(st => <option key={st.name} value={st.name}>{st.name}</option>)}
            </select>
            <button className={danger} onClick={() => removeTransition(ti)}>✕</button>
          </div>
          <TransitionBody ti={ti} paramOf={paramOf} setTransition={setTransition}
            addCondition={addCondition} setCondition={setCondition} removeCondition={removeCondition} />
        </div>
      ))}
      <button className={ghost + ' self-start'} onClick={() => addTransition(s.name)}>+ Transition</button>
    </div>
  )
}

// ---- Selected transition details ------------------------------------------------------------------
function SelectedTransition() {
  const {
    sm: machine, selection, paramOf, setTransition, removeTransition,
    addCondition, setCondition, removeCondition, setSelection,
  } = useStateMachine()
  if (selection?.kind !== 'transition') return null
  const ti = selection.index
  const t = machine.transitions[ti]
  if (!t) return null

  return (
    <div className='border border-control rounded p-1.5 flex flex-col gap-1'>
      <div className='flex items-center gap-1'>
        <span className='text-[10px] text-gray-400 whitespace-nowrap'>{t.from} →</span>
        <select className={input + ' flex-1'} value={t.to} onChange={e => setTransition(ti, { to: e.target.value })}>
          {machine.states.map(st => <option key={st.name} value={st.name}>{st.name}</option>)}
        </select>
        <button className={danger} onClick={() => { removeTransition(ti); setSelection(null) }}>✕</button>
      </div>
      <TransitionBody ti={ti} paramOf={paramOf} setTransition={setTransition}
        addCondition={addCondition} setCondition={setCondition} removeCondition={removeCondition} />
    </div>
  )
}

// Exit-time + conditions editor, shared by the state and transition detail panels.
function TransitionBody({ ti, paramOf, setTransition, addCondition, setCondition, removeCondition }: {
  ti: number
  paramOf: (n: string) => AnimationParameter | undefined
  setTransition: (i: number, patch: any) => void
  addCondition: (ti: number) => void
  setCondition: (ti: number, ci: number, patch: any) => void
  removeCondition: (ti: number, ci: number) => void
}) {
  const { sm: machine } = useStateMachine()
  const t = machine.transitions[ti]
  if (!t) return null
  return (
    <>
      <label className='flex items-center gap-1 text-[10px]'>
        <input type='checkbox' checked={!!t.hasExitTime} onChange={e => setTransition(ti, { hasExitTime: e.target.checked })} />
        has exit time
        {t.hasExitTime && (
          <input className={input + ' w-[52px] ml-1'} type='number' step='0.05' min='0' max='1' value={t.exitTime ?? 1}
            onChange={e => setTransition(ti, { exitTime: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)) })} />
        )}
      </label>
      <div className='flex flex-col gap-1'>
        {t.conditions.map((c, ci) => {
          const type = effectiveType(paramOf(c.param))
          return (
            <div key={ci} className='flex items-center gap-1'>
              <select className={input + (paramOf(c.param) ? '' : ' border-red-500 text-red-300')} value={c.param} onChange={e => {
                const np = paramOf(e.target.value)
                setCondition(ti, ci, { param: e.target.value, op: OPS_FOR[effectiveType(np)][0] })
              }}>
                {!paramOf(c.param) && <option value={c.param}>{c.param || '(none)'} — missing</option>}
                {machine.parameters.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
              <select className={input} value={c.op} onChange={e => setCondition(ti, ci, { op: e.target.value as AnimationConditionOp })}>
                {OPS_FOR[type].map(op => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
              </select>
              {type === 'float' && <input className={input + ' w-[52px]'} type='number' step='0.1' value={c.value ?? 0} onChange={e => setCondition(ti, ci, { value: parseFloat(e.target.value) || 0 })} />}
              <button className={danger} onClick={() => removeCondition(ti, ci)}>✕</button>
            </div>
          )
        })}
        <button className={ghost + ' self-start'} onClick={() => addCondition(ti)} disabled={machine.parameters.length === 0}>+ Condition</button>
      </div>
    </>
  )
}

// Grouped dropdown of the node variables a Variable parameter can bind to (Self / Parent / Scene).
function VariablePicker({ vars, value, onPick }: {
  vars: AccessibleVariable[]
  value?: AnimationVariableBinding
  onPick: (b: AnimationVariableBinding | undefined) => void
}) {
  const key = (nodeRef: string, varName: string) => `${nodeRef}|${varName}`
  const current = value ? key(value.nodeRef, value.varName) : ''
  const groups: Record<AccessibleVariable['group'], AccessibleVariable[]> = { Self: [], Parent: [], Scene: [] }
  for (const v of vars) groups[v.group].push(v)
  return (
    <select className={input + ' w-[160px]'} value={current}
      title='Bind to a node variable — Self (own), Parent (protected/public), Scene (public)'
      onChange={e => {
        const found = vars.find(v => key(v.nodeRef, v.varName) === e.target.value)
        onPick(found ? { nodeRef: found.nodeRef, varName: found.varName, varType: found.varType } : undefined)
      }}>
      <option value=''>{value ? `${value.nodeRef} · ${value.varName} (missing)` : '— pick variable —'}</option>
      {(['Self', 'Parent', 'Scene'] as const).map(g => groups[g].length > 0 && (
        <optgroup key={g} label={g}>
          {groups[g].map(v => (
            <option key={key(v.nodeRef, v.varName)} value={key(v.nodeRef, v.varName)}>
              {v.nodeLabel} · {v.varName} ({v.varType})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
