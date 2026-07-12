import { useEffect, useMemo, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import type {
  AnimationStateMachine, AnimationParameter, AnimationState,
  AnimationTransition, AnimationCondition, AnimationEventMarker,
  AnimationParameterType, AnimationConditionOp, AnimationVariableBinding,
} from 'cleo'
import { getAnimationTarget, accessibleNodeVariables, AccessibleVariable } from './skeleton'
import Collapsable from '../../components/Collapsable'

const EMPTY: AnimationStateMachine = { parameters: [], states: [], transitions: [], events: [] }
const clone = (sm: AnimationStateMachine): AnimationStateMachine => JSON.parse(JSON.stringify(sm))

// Condition operators keyed by a parameter's EFFECTIVE type. A 'variable' parameter behaves like a
// float (number-bound) or bool (boolean-bound) for the purposes of conditions.
type EffectiveType = 'float' | 'bool' | 'trigger'
const OPS_FOR: Record<EffectiveType, AnimationConditionOp[]> = {
  float: ['gt', 'lt', 'eq', 'neq'],
  bool: ['true', 'false'],
  trigger: ['trigger'],
}
const OP_LABEL: Record<AnimationConditionOp, string> = {
  gt: '>', lt: '<', eq: '==', neq: '!=', true: 'is true', false: 'is false', trigger: 'on',
}
const effectiveType = (p?: AnimationParameter): EffectiveType =>
  !p ? 'float'
    : p.type === 'variable' ? (p.variable?.varType === 'boolean' ? 'bool' : 'float')
    : p.type

const input = 'bg-[#3b3b3b] text-white border border-[#555] rounded px-1 py-0.5 text-xs'
const btn = 'px-2 py-1 rounded bg-[#326acc] hover:bg-[#2a59a9] text-white border border-[#274b8f] text-xs'
const ghost = 'px-1.5 py-0.5 rounded border border-[#555] hover:bg-[#3b3b3b] text-xs'
const danger = 'px-1.5 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white text-xs'

export default function StateMachineEditor() {
  const { editorScene, animationTargetId, animationSourceScene, animationSourceId, commitAnimationStateMachine, importAnimationFiles, importSkeletonNames, renameAnimationClip, removeAnimationClip, closeTab, activeTabId, eventEmitter } = useCleoEngine()
  const target = getAnimationTarget(editorScene, animationTargetId)
  const hasBoneNames = !!(target && target.skin.nodeNames && target.skin.nodeNames.size > 0)

  const [sm, setSm] = useState<AnimationStateMachine>(EMPTY)
  const [selectedState, setSelectedState] = useState<string | null>(null)
  const [, force] = useState(0)

  const clips = target ? target.model.animations.map(a => a.name) : []
  // Variables a Variable-parameter can bind to (from the SOURCE node's real scene, not the clone).
  const accessVars = useMemo<AccessibleVariable[]>(
    () => accessibleNodeVariables(animationSourceScene?.getNodeById(animationSourceId ?? '') ?? null, animationSourceScene),
    [animationSourceScene, animationSourceId, animationTargetId])

  // Load the machine from the target on entry.
  useEffect(() => {
    if (!target) { setSm(EMPTY); return }
    const existing = target.animator.getStateMachine()
    setSm(existing ? clone(existing) : clone(EMPTY))
    setSelectedState(existing?.states.find(s => s.isEntry)?.name ?? existing?.states[0]?.name ?? null)
  }, [animationTargetId])

  // Re-render when clips are imported so the new clips appear in the state/event clip pickers.
  useEffect(() => {
    const onClips = () => force(x => x + 1)
    eventEmitter.on('ANIM_CLIPS_CHANGED', onClips)
    return () => { eventEmitter.off('ANIM_CLIPS_CHANGED', onClips) }
  }, [eventEmitter])

  const update = (next: AnimationStateMachine) => setSm({ ...next })
  const apply = () => {
    if (!target) return
    target.animator.setStateMachine(clone(sm))   // the in-tab clone (drives Simulate preview)
    commitAnimationStateMachine(clone(sm))        // write back to the original node in the main scene
    eventEmitter.emit('ANIM_SM_CHANGED')
    force(x => x + 1)
  }

  // ---- Parameters ----
  const addParam = () => {
    const name = uniqueName('param', sm.parameters.map(p => p.name))
    update({ ...sm, parameters: [...sm.parameters, { name, type: 'float', default: 0 }] })
  }
  const setParam = (i: number, patch: Partial<AnimationParameter>) => {
    const oldName = sm.parameters[i].name
    const parameters = sm.parameters.map((p, idx) => idx === i ? normalizeParam({ ...p, ...patch }) : p)
    // Renaming a parameter must follow through to the conditions that reference it (else they break
    // silently and their transitions never fire).
    let transitions = sm.transitions
    if (patch.name && patch.name !== oldName) {
      transitions = sm.transitions.map(t => ({
        ...t,
        conditions: t.conditions.map(c => c.param === oldName ? { ...c, param: patch.name! } : c),
      }))
    }
    update({ ...sm, parameters, transitions })
  }
  const removeParam = (i: number) => update({ ...sm, parameters: sm.parameters.filter((_, idx) => idx !== i) })

  // ---- States ----
  const addState = () => {
    const name = uniqueName('State', sm.states.map(s => s.name))
    const isEntry = sm.states.length === 0
    update({ ...sm, states: [...sm.states, { name, clipName: clips[0] ?? '', loop: true, speed: 1, isEntry }] })
    if (isEntry) setSelectedState(name)
  }
  const setState = (i: number, patch: Partial<AnimationState>) => {
    let states = sm.states.map((s, idx) => idx === i ? { ...s, ...patch } : s)
    if (patch.isEntry) states = states.map((s, idx) => ({ ...s, isEntry: idx === i })) // single entry
    // Renaming a state should keep transitions consistent.
    if (patch.name && patch.name !== sm.states[i].name) {
      const oldName = sm.states[i].name
      const transitions = sm.transitions.map(t => ({
        ...t,
        from: t.from === oldName ? patch.name! : t.from,
        to: t.to === oldName ? patch.name! : t.to,
      }))
      update({ ...sm, states, transitions })
      if (selectedState === oldName) setSelectedState(patch.name!)
      return
    }
    update({ ...sm, states })
  }
  const removeState = (i: number) => {
    const name = sm.states[i].name
    update({
      ...sm,
      states: sm.states.filter((_, idx) => idx !== i),
      transitions: sm.transitions.filter(t => t.from !== name && t.to !== name),
    })
    if (selectedState === name) setSelectedState(null)
  }

  // ---- Transitions (for the selected state) ----
  const stateTransitions = useMemo(
    () => sm.transitions.map((t, i) => ({ t, i })).filter(({ t }) => t.from === selectedState),
    [sm.transitions, selectedState])

  const addTransition = () => {
    if (!selectedState) return
    const to = sm.states.find(s => s.name !== selectedState)?.name ?? selectedState
    update({ ...sm, transitions: [...sm.transitions, { from: selectedState, to, conditions: [], hasExitTime: false, exitTime: 1 }] })
  }
  const setTransition = (i: number, patch: Partial<AnimationTransition>) =>
    update({ ...sm, transitions: sm.transitions.map((t, idx) => idx === i ? { ...t, ...patch } : t) })
  const removeTransition = (i: number) => update({ ...sm, transitions: sm.transitions.filter((_, idx) => idx !== i) })

  const addCondition = (ti: number) => {
    const p = sm.parameters[0]
    if (!p) return
    const cond: AnimationCondition = { param: p.name, op: OPS_FOR[effectiveType(p)][0], value: 0 }
    setTransition(ti, { conditions: [...sm.transitions[ti].conditions, cond] })
  }
  const setCondition = (ti: number, ci: number, patch: Partial<AnimationCondition>) => {
    const conditions = sm.transitions[ti].conditions.map((c, idx) => idx === ci ? { ...c, ...patch } : c)
    setTransition(ti, { conditions })
  }
  const removeCondition = (ti: number, ci: number) =>
    setTransition(ti, { conditions: sm.transitions[ti].conditions.filter((_, idx) => idx !== ci) })

  // ---- Events ----
  const addEvent = () => update({ ...sm, events: [...sm.events, { clipName: clips[0] ?? '', time: 0, eventName: 'event' }] })
  const setEvent = (i: number, patch: Partial<AnimationEventMarker>) =>
    update({ ...sm, events: sm.events.map((e, idx) => idx === i ? { ...e, ...patch } : e) })
  const removeEvent = (i: number) => update({ ...sm, events: sm.events.filter((_, idx) => idx !== i) })

  // ---- Clips (rename / delete on the model, keeping state/event references in sync) ----
  const renameClip = (oldName: string, typed: string) => {
    const next = typed.trim()
    if (!next || next === oldName) return
    const finalName = renameAnimationClip(oldName, next)
    update({
      ...sm,
      states: sm.states.map(s => s.clipName === oldName ? { ...s, clipName: finalName } : s),
      events: sm.events.map(ev => ev.clipName === oldName ? { ...ev, clipName: finalName } : ev),
    })
  }
  const deleteClip = (name: string) => {
    removeAnimationClip(name)
    update({
      ...sm,
      states: sm.states.map(s => s.clipName === name ? { ...s, clipName: '' } : s),
      events: sm.events.filter(ev => ev.clipName !== name),
    })
  }

  if (!target) {
    return <div className='flex flex-col bg-[#202020] w-full h-full p-3 text-sm text-gray-400'>No skinned model selected.</div>
  }

  const paramOf = (name: string) => sm.parameters.find(p => p.name === name)

  return (
    <div className='flex flex-col text-white bg-[#202020] w-full h-full overflow-y-auto'>
      <div className='p-2 border-b border-[#2d2d77] flex items-center justify-between'>
        <div className='text-xs uppercase tracking-wide text-[#8f8fff]'>Animation State Machine</div>
        <button className={ghost} title='Close the Animation Editor tab' onClick={() => closeTab(activeTabId)}>Close</button>
      </div>

      <div className='p-2 flex flex-col gap-1'>
        <button className={btn + ' w-full'} onClick={apply} title='Save the machine onto the original model (used at runtime and by Simulate)'>
          Apply to Model
        </button>
        <label className={ghost + ' w-full text-center cursor-pointer'} title='Import animation clips (glTF / GLB / FBX) onto this skeleton'>
          Import Animation…
          <input type='file' multiple className='hidden' accept='.gltf,.glb,.fbx,.bin'
            onChange={e => { const fs = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; if (fs.length) importAnimationFiles(fs) }} />
        </label>
        {!hasBoneNames && (
          <label className={ghost + ' w-full text-center cursor-pointer border-[#ffd27a] text-[#ffd27a]'}
            title='This model has no bone names, so imported animations match by node index (wrong bones). Load the ORIGINAL file this character was imported from to add bone names.'>
            ⚠ Add bone names from file…
            <input type='file' multiple className='hidden' accept='.gltf,.glb,.fbx,.bin'
              onChange={e => { const fs = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; if (fs.length) importSkeletonNames(fs) }} />
          </label>
        )}
        <p className='text-[10px] text-gray-500 mt-0.5'>Writes back to the source node. Scripts drive it with <code>animator.setFloat/setBool/setTrigger()</code>.</p>
      </div>

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
          {sm.parameters.map((p, i) => (
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

      {/* States */}
      <Collapsable title='States'>
        <div className='p-2 flex flex-col gap-1'>
          {sm.states.map((s, i) => (
            <div key={i} className={`flex items-center gap-1 p-1.5 rounded border ${selectedState === s.name ? 'border-[#2c2cff] bg-[#26265a]' : 'border-[#3b3b3b]'}`}
              onClick={() => setSelectedState(s.name)}>
              <input title='Entry state' type='radio' checked={!!s.isEntry} onChange={() => setState(i, { isEntry: true })} onClick={e => e.stopPropagation()} />
              <input className={input + ' flex-1 min-w-0'} title='State name' value={s.name} onChange={e => setState(i, { name: e.target.value })} onClick={e => e.stopPropagation()} />
              <select className={input + ' flex-1 min-w-0'} title='Animation clip' value={s.clipName} onChange={e => setState(i, { clipName: e.target.value })} onClick={e => e.stopPropagation()}>
                <option value=''>(no clip)</option>
                {clips.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className='flex items-center gap-0.5 text-[10px] shrink-0' onClick={e => e.stopPropagation()} title='Loop'>
                <input type='checkbox' checked={s.loop} onChange={e => setState(i, { loop: e.target.checked })} />loop
              </label>
              <input className={input + ' w-[42px] shrink-0'} type='number' step='0.1' title='Speed' value={s.speed} onChange={e => setState(i, { speed: parseFloat(e.target.value) || 0 })} onClick={e => e.stopPropagation()} />
              <button className={danger + ' shrink-0'} title='Delete state' onClick={(e) => { e.stopPropagation(); removeState(i) }}>✕</button>
            </div>
          ))}
          <button className={ghost + ' self-start mt-1'} onClick={addState}>+ State</button>
        </div>
      </Collapsable>

      {/* Transitions for the selected state */}
      <Collapsable title={`Transitions${selectedState ? ` — ${selectedState}` : ''}`}>
        <div className='p-2 flex flex-col gap-2'>
          {!selectedState && <p className='text-[11px] text-gray-400'>Select a state to edit its transitions.</p>}
          {selectedState && stateTransitions.map(({ t, i }) => (
            <div key={i} className='border border-[#3b3b3b] rounded p-1.5 flex flex-col gap-1'>
              <div className='flex items-center gap-1'>
                <span className='text-[10px] text-gray-400 whitespace-nowrap'>{t.from} →</span>
                <select className={input + ' flex-1'} value={t.to} onChange={e => setTransition(i, { to: e.target.value })}>
                  {sm.states.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
                <button className={danger} onClick={() => removeTransition(i)}>✕</button>
              </div>
              <label className='flex items-center gap-1 text-[10px]'>
                <input type='checkbox' checked={!!t.hasExitTime} onChange={e => setTransition(i, { hasExitTime: e.target.checked })} />
                has exit time
                {t.hasExitTime && (
                  <input className={input + ' w-[52px] ml-1'} type='number' step='0.05' min='0' max='1' value={t.exitTime ?? 1}
                    onChange={e => setTransition(i, { exitTime: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)) })} />
                )}
              </label>
              {/* Conditions */}
              <div className='flex flex-col gap-1'>
                {t.conditions.map((c, ci) => {
                  const type = effectiveType(paramOf(c.param))
                  return (
                    <div key={ci} className='flex items-center gap-1'>
                      <select className={input + (paramOf(c.param) ? '' : ' border-red-500 text-red-300')} value={c.param} onChange={e => {
                        const np = paramOf(e.target.value)
                        setCondition(i, ci, { param: e.target.value, op: OPS_FOR[effectiveType(np)][0] })
                      }}>
                        {!paramOf(c.param) && <option value={c.param}>{c.param || '(none)'} — missing</option>}
                        {sm.parameters.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                      </select>
                      <select className={input} value={c.op} onChange={e => setCondition(i, ci, { op: e.target.value as AnimationConditionOp })}>
                        {OPS_FOR[type].map(op => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
                      </select>
                      {type === 'float' && <input className={input + ' w-[52px]'} type='number' step='0.1' value={c.value ?? 0} onChange={e => setCondition(i, ci, { value: parseFloat(e.target.value) || 0 })} />}
                      <button className={danger} onClick={() => removeCondition(i, ci)}>✕</button>
                    </div>
                  )
                })}
                <button className={ghost + ' self-start'} onClick={() => addCondition(i)} disabled={sm.parameters.length === 0}>+ Condition</button>
              </div>
            </div>
          ))}
          {selectedState && <button className={ghost + ' self-start'} onClick={addTransition}>+ Transition</button>}
        </div>
      </Collapsable>

      {/* Events */}
      <Collapsable title='Events'>
        <div className='p-2 flex flex-col gap-1'>
          {sm.events.map((e, i) => (
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
          {sm.parameters.map((p, i) => (
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
          {sm.parameters.length === 0 && <p className='text-[11px] text-gray-400'>No parameters.</p>}
        </div>
      </Collapsable>
    </div>
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

function uniqueName(base: string, existing: string[]): string {
  let n = existing.length + 1
  let name = `${base}${n}`
  while (existing.includes(name)) { n++; name = `${base}${n}` }
  return name
}

// Keep a parameter's default value + binding consistent when the type changes.
function normalizeParam(p: AnimationParameter): AnimationParameter {
  if (p.type !== 'variable' && p.variable) { const { variable, ...rest } = p; p = rest }
  if (p.type === 'float' && typeof p.default !== 'number') return { ...p, default: 0 }
  if ((p.type === 'bool' || p.type === 'trigger') && typeof p.default !== 'boolean') return { ...p, default: false }
  if (p.type === 'variable') {
    const wantNum = p.variable?.varType !== 'boolean'
    return { ...p, default: wantNum ? (typeof p.default === 'number' ? p.default : 0) : (typeof p.default === 'boolean' ? p.default : false) }
  }
  return p
}
