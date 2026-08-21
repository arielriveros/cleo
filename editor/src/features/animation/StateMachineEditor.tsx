import { useState, useEffect, useRef } from 'react'
import type { Animator, AnimationVariableBinding, AnimationParameterType, AnimationParameter } from 'cleo'
import { NODE_BUILTINS, isConditionGroup } from 'cleo'
import { AccessibleVariable, UNSIGNED_BUILTINS } from './skeleton'
import FieldDebugReadout from './FieldDebugReadout'
import type { AnimationFieldAsset } from '../../utils/animationFields'
import { useStateMachine } from './StateMachineContext'
import ConditionTree from './ConditionTree'
import AnimationAssetPicker from './AnimationAssetPicker'
import Collapsable from '../../components/Collapsable'
import { SegmentedControl, Toggle } from '../../components/ui'

// The Animation State Machine inspector, as three DOCK PANELS (Clips / Variables / State Machine) rather than
// one panel with tabs — see DockLayout. They all edit the same working copy from StateMachineContext, which
// wraps the whole dock, so nothing is plumbed between them.
//
// The graph (StateGraph) stays the only place to add / move / connect states, and now also the place to set
// the entry state (right-click a node).

const input = 'bg-control text-white border border-control-hover rounded px-1 py-0.5 text-xs'
const btn = 'px-2 py-1 rounded bg-primary hover:bg-primary-hover text-white border border-primary-active text-xs'
const ghost = 'px-1.5 py-0.5 rounded border border-control-hover hover:bg-control text-xs'
const danger = 'px-1.5 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white text-xs'

function NoModel() {
  return <div className='flex flex-col bg-surface-raised w-full h-full p-3 text-sm text-gray-400'>No skinned model selected.</div>
}

/**
 * Apply is machine-wide and every panel mutates the machine (Clips too — deleting a clip rewrites states and
 * events), so it sits on all three rather than on whichever one happens to own it. The graph toolbar has its
 * own copy, but that toolbar is gone in Animations view.
 */
function ApplyBar() {
  const { apply } = useStateMachine()
  return (
    <div className='p-2 border-b border-border'>
      <button className={btn + ' w-full'} onClick={apply}
        title='Save the machine onto the original model (used at runtime and by Simulate)'>
        Apply to Model
      </button>
    </div>
  )
}

// ---- Clips panel ------------------------------------------------------------------------------------
export function ClipsPanel() {
  const {
    target, clips, clipAssetId, modelId, adoptModel, hasBoneNames,
    renameClip, deleteClip, rootMotionOf, toggleClipRootMotion, importAnimationFiles, importSkeletonNames,
  } = useStateMachine()
  if (!target) return <NoModel />

  // Where a clip lives decides what can be done to it here. A shared clip is one stored copy retargeted
  // onto this rig, so removing it is unlinking its ASSET (one level up, in the picker) — deleting it off
  // this model alone would be undone by the next resolve.
  const clipRow = (name: string) => {
    const sharedId = clipAssetId(name)
    return (
      <div key={name} className='flex items-center gap-1'>
        <input className={input + ' flex-1'} defaultValue={name}
          title={sharedId ? 'Rename this clip in its animation asset (Enter to apply) — every model using it follows' : 'Rename clip (Enter to apply)'}
          onBlur={e => renameClip(name, e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        <span className='shrink-0' title='Root motion — apply this clip&#39;s root bone translation/rotation to the character (body if it has one) instead of playing it in place'>
          <Toggle checked={rootMotionOf(name)} onChange={on => toggleClipRootMotion(name, on)} />
        </span>
        {sharedId
          ? <span className='text-[10px] text-muted shrink-0 w-[52px] text-center' title='From a linked animation asset — unlink it above to remove'>linked</span>
          : <button className={danger} title='Delete clip' onClick={() => deleteClip(name)}>✕</button>}
      </div>
    )
  }

  const shared = clips.filter(c => !!clipAssetId(c))
  const own = clips.filter(c => !clipAssetId(c))

  return (
    <div className='flex flex-col text-white bg-surface-raised w-full h-full overflow-y-auto'>
      <ApplyBar />
      <div className='p-2 flex flex-col gap-1'>
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

        {/* Clips already in the library, linked rather than re-imported — the same affordance a texture
            slot gives: pick one, or drag it in from Assets. */}
        <AnimationAssetPicker className='mt-1' modelId={modelId} onNeedModel={adoptModel} />

        <div className='mt-1 flex flex-col gap-1'>
          {clips.length === 0 && <p className='text-[11px] text-gray-400'>No clips. Import or link one above.</p>}
          {shared.length > 0 && <p className='text-[10px] uppercase tracking-wide text-muted mt-1'>From linked animations</p>}
          {shared.map(clipRow)}
          {own.length > 0 && shared.length > 0 && <p className='text-[10px] uppercase tracking-wide text-muted mt-1'>This model’s own clips</p>}
          {own.map(clipRow)}
        </div>
      </div>
    </div>
  )
}

// ---- Variables panel (parameters + events) ----------------------------------------------------------
export function VariablesPanel() {
  const { target, sm, accessVars, addParam, setParam, removeParam, removeEvent, setEvent } = useStateMachine()
  if (!target) return <NoModel />

  return (
    <div className='flex flex-col text-white bg-surface-raised w-full h-full overflow-y-auto'>
      <ApplyBar />
      <Collapsable title='Parameters' defaultOpen>
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
                  ? <Toggle checked={!!p.default} onChange={c => setParam(i, { default: c })} />
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

      <Collapsable title='Events' badge={sm.events.length || undefined} defaultOpen>
        <div className='p-2 flex flex-col gap-1'>
          {sm.events.length === 0 && (
            <p className='text-[11px] text-gray-400'>
              No events. Pick a clip on the transport, scrub to a moment, and press <b>+ Event</b>.
            </p>
          )}
          {sm.events.map((e, i) => (
            <div key={i} className='flex items-center gap-1'>
              <input className={input + ' flex-1 min-w-0'} value={e.eventName} title='Event name — what onAnimationEvent receives'
                onChange={ev => setEvent(i, { eventName: ev.target.value })} />
              {/* Clip and time are the timeline's to set: an event only means anything at a moment in a clip,
                  and you place that by dragging its marker, not by typing seconds. */}
              <span className='text-[10px] text-muted truncate w-[72px] shrink-0' title={e.clipName || '(no clip)'}>{e.clipName || '(no clip)'}</span>
              <span className='text-[10px] text-dim tabular-nums w-[38px] shrink-0 text-right' title='Drag the marker on the transport to change'>{e.time.toFixed(2)}s</span>
              <button className={danger + ' shrink-0'} title='Delete event' onClick={() => removeEvent(i)}>✕</button>
            </div>
          ))}
        </div>
      </Collapsable>
    </div>
  )
}

// ---- State machine panel (selected element + preview) -------------------------------------------------
export function StateMachinePanel() {
  const { target, selection } = useStateMachine()
  if (!target) return <NoModel />

  return (
    <div className='flex flex-col text-white bg-surface-raised w-full h-full overflow-y-auto'>
      <ApplyBar />
      <Collapsable title='Selected' defaultOpen>
        <div className='p-2 flex flex-col gap-2'>
          {!selection && <p className='text-[11px] text-gray-400'>Select a state or transition in the graph.</p>}
          {selection?.kind === 'state' && <SelectedState />}
          {selection?.kind === 'transition' && <SelectedTransition />}
        </div>
      </Collapsable>
      <PreviewSection />
    </div>
  )
}

// ---- Selected state details -----------------------------------------------------------------------
function SelectedState() {
  const { sm, selection, clips, setState, removeState, stateIndex, links, animationFields, fieldOf } = useStateMachine()
  if (selection?.kind !== 'state') return null
  const i = stateIndex(selection.name)
  if (i < 0) return null
  const s = sm.states[i]

  // Only a numeric parameter can be a rate; a trigger is momentary and has no meaningful value. The same
  // set is what a field's axes may be driven by, for the same reason — and it already includes
  // variable-bound parameters, which is how a field ends up driven by a node variable.
  const speedParams = sm.parameters.filter(p => p.type === 'float' || (p.type === 'variable' && p.variable?.varType !== 'boolean'))
  const byParam = !!s.speedParam
  const linked = links.filter(l => l.a === s.name || l.b === s.name)

  // A state plays either ONE clip or a whole blend space. `fieldId` is the discriminator, so switching to
  // Clip clears it (and the embedded copy that rides with it) rather than leaving a field the runtime would
  // still prefer over clipName.
  const playsField = !!s.fieldId
  const field = fieldOf(s.fieldId)
  const setPlays = (kind: 'clip' | 'field') => {
    if (kind === 'clip') setState(i, { fieldId: undefined, field: undefined, fieldInputs: undefined })
    // Switching to a field also drops any speed PARAMETER. On a clip, binding the rate to movement speed is
    // how you fake speed matching; a field does that properly through the blend, so carrying the binding
    // over would apply the speed twice — the run clip ends up playing at runSpeed×, i.e. wildly too fast.
    // The fixed `speed` is kept, so an intentional 0.5× or 2× survives the switch.
    else setState(i, { clipName: '', fieldId: animationFields[0]?.id ?? '', fieldInputs: {}, speedParam: undefined })
  }

  // A field already matches speed by CHOOSING clips, so a playback-rate parameter multiplies on top of a
  // blend that is already correct. Worth flagging for ANY parameter, not just an axis one: two parameters
  // can read the same value (one bound to planarSpeed, one to a script's moveSpeed) and produce exactly the
  // same double-apply without sharing a name. The axis case is called out harder because it is unambiguous.
  const speedByParamOnField = playsField && !!s.speedParam
  const speedFeedsAxis = speedByParamOnField
    && (s.speedParam === s.fieldInputs?.x || s.speedParam === s.fieldInputs?.y)

  // The mirror of the UNSIGNED_BUILTINS check on a field axis, and a nastier failure. There is no reverse
  // playback, so a Speed parameter that goes negative is clamped to exactly 0 — the clip FREEZES, and because
  // the blend keeps being recomputed from an unsmoothed probe while it holds, what you see is the whole pose
  // vibrating rather than an animation that stopped. Only on one side of the parameter's range, which is what
  // makes it so hard to read as a speed problem at all.
  //
  // Read off NODE_BUILTINS rather than a list kept here: the engine's getters are the authority on which
  // values are signed, and a second copy would drift the first time one is added.
  const speedBuiltin = sm.parameters.find(p => p.name === s.speedParam)?.variable
  const signedSpeed = speedBuiltin?.source === 'builtin' && !!NODE_BUILTINS[speedBuiltin.varName]?.signed
    ? speedBuiltin.varName
    : undefined

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-1'>
        <input className={input + ' flex-1 min-w-0'} title='State name' value={s.name} onChange={e => setState(i, { name: e.target.value })} />
        <button className={danger + ' shrink-0'} title='Delete state' onClick={() => removeState(i)}>✕</button>
      </div>
      {/* Entry is set by right-clicking the node in the graph, where it is also drawn (green border + ▶). */}
      {s.isEntry
        ? <p className='text-[10px] text-success'>▶ Entry state — the machine starts here.</p>
        : <p className='text-[10px] text-gray-500'>Right-click this state in the graph to make it the entry.</p>}

      <div className='flex items-center gap-1'>
        <span className='text-[10px] text-gray-400 w-[42px] shrink-0'>Plays</span>
        <SegmentedControl<'clip' | 'field'>
          size='sm' value={playsField ? 'field' : 'clip'} onChange={setPlays}
          options={[
            { value: 'clip', label: 'Clip', title: 'Play a single animation clip' },
            { value: 'field', label: 'Field', title: 'Blend several clips through an Animation Field' },
          ]} />
      </div>

      {!playsField && (
        <select className={input + ' flex-1 min-w-0'} title='Animation clip' value={s.clipName} onChange={e => setState(i, { clipName: e.target.value })}>
          <option value=''>(no clip)</option>
          {clips.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      )}

      {playsField && (animationFields.length === 0
        ? <p className='text-[10px] text-warning'>No animation fields yet — create one from a model in the Assets explorer.</p>
        : <>
          <select className={input + ' flex-1 min-w-0'} title='Animation field' value={s.fieldId ?? ''}
            onChange={e => setState(i, { fieldId: e.target.value })}>
            <option value=''>(no field)</option>
            {!field && s.fieldId && <option value={s.fieldId}>{s.fieldId} — missing</option>}
            {animationFields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>

          {/* One parameter per axis: this is where the machine's inputs become the field's inputs. */}
          {field && <>
            <FieldAxisBinding
              label={field.xAxis.name} params={speedParams} value={s.fieldInputs?.x}
              minSample={minSampleOn(field, 'x')}
              onPick={name => setState(i, { fieldInputs: { ...s.fieldInputs, x: name } })} />
            {field.mode === '2d' && (
              <FieldAxisBinding
                label={field.yAxis.name} params={speedParams} value={s.fieldInputs?.y}
                minSample={minSampleOn(field, 'y')}
                onPick={name => setState(i, { fieldInputs: { ...s.fieldInputs, y: name } })} />
            )}
            {/* An unbound axis holds whatever it was last set to, which reads as a blend that never
                responds — worth calling out, since nothing else in the UI would show it. */}
            {!s.fieldInputs?.x && <p className='text-[10px] text-warning'>Bind “{field.xAxis.name}” to a parameter or the blend will not move.</p>}
          </>}
          <p className='text-[10px] text-gray-500'>Fields are re-embedded on <b>Apply to Model</b>.</p>
        </>)}

      <div className='flex items-center gap-2'>
        <Toggle label='loop' checked={s.loop} onChange={c => setState(i, { loop: c })} className='text-[10px]' />
        {s.loop && (
          <label className='flex items-center gap-1 text-[10px]' title='How many times to play the clip. 0 = forever.'>
            <span className='text-gray-400'>times</span>
            <input className={input + ' w-[46px]'} type='number' step='1' min='0' value={s.loopCount ?? 0}
              onChange={e => setState(i, { loopCount: Math.max(0, Math.floor(parseFloat(e.target.value) || 0)) })} />
            <span className='text-dim'>{(s.loopCount ?? 0) === 0 ? '∞' : ''}</span>
          </label>
        )}
      </div>

      {/* Speed: a fixed rate, or read live from a parameter (e.g. run faster the faster you move).
          On a FIELD state this is a multiplier on top of the blend, not the blend's input — see below. */}
      <div className='flex items-center gap-1'>
        <span className='text-[10px] text-gray-400 w-[42px] shrink-0' title={playsField
          ? 'Playback rate MULTIPLIER on top of the blend. The field already matches speed by picking clips — leave it at 1 unless you want slow motion.'
          : 'Playback rate for this clip.'}>Speed</span>
        <SegmentedControl<'number' | 'param'>
          size='sm' value={byParam ? 'param' : 'number'}
          onChange={v => setState(i, v === 'param' ? { speedParam: speedParams[0]?.name ?? '' } : { speedParam: undefined })}
          options={[
            { value: 'number', label: '#', title: 'A fixed playback rate' },
            { value: 'param', label: 'P', title: 'Read the rate from a parameter, live' },
          ]} />
        {byParam
          ? (speedParams.length === 0
              ? <span className='text-[10px] text-warning flex-1'>No numeric parameter to bind.</span>
              : <select className={input + ' flex-1 min-w-0'} value={s.speedParam} onChange={e => setState(i, { speedParam: e.target.value })}>
                  {!speedParams.some(p => p.name === s.speedParam) && <option value={s.speedParam}>{s.speedParam} — missing</option>}
                  {speedParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>)
          : <input className={input + ' w-[56px]'} type='number' step='0.1' min='0' value={s.speed}
              onChange={e => setState(i, { speed: Math.max(0, parseFloat(e.target.value) || 0) })} />}
      </div>
      {byParam && !speedByParamOnField && !signedSpeed && <p className='text-[10px] text-gray-500 -mt-1'>Falls back to the fixed speed if the parameter goes missing.</p>}
      {byParam && signedSpeed && (
        <p className='text-[10px] text-warning -mt-1'>
          <b>“{signedSpeed}” goes negative</b> — and there is no reverse playback, so the rate is clamped to 0
          and the clip freezes for that whole half of its range. With a blend field still re-mixing underneath,
          that reads on screen as the pose vibrating rather than as an animation that stopped. Bind Speed to a
          magnitude (<b>planarSpeed</b>, <b>currentSpeed</b>) instead, or set it to <b>#</b> and let the field’s
          per-sample <b>Rate</b> column set the pace.
        </p>
      )}
      {speedByParamOnField && (
        <p className='text-[10px] text-warning -mt-1'>
          {speedFeedsAxis
            ? <><b>“{s.speedParam}” already drives this field’s axis.</b> Using it as the playback rate too applies it twice — at speed 4 the run clip plays 4× too fast.</>
            : <><b>This state plays a field, and its rate is read from “{s.speedParam}”.</b> If that parameter carries movement speed, it multiplies a blend that is already speed-matched — the same double-apply as binding it to the axis.</>}
          {' '}Set Speed to <b>#</b> 1 unless you specifically want slow motion; the field matches speed by
          choosing clips, not by playing them faster. <b>The field editor always previews at rate 1</b>, which
          is why this only shows up in Play.
        </p>
      )}

      {/* Foot IK weight. On by default and usually left alone — a foot whose ground ray finds nothing fades
          itself out, so mid-air already looks right with no authoring. This is for the exceptions: a state
          whose animation should be trusted verbatim, or one gated on a grounded/falling parameter. */}
      <div className='flex items-center gap-1 text-[10px]'
        title={'How strongly foot IK applies during this state. 1 is fully on, 0 leaves the animation exactly as '
          + 'authored. Feet with no ground under them fade out by themselves, so this is rarely needed.'}>
        <span className='text-gray-400'>foot IK</span>
        <SegmentedControl<'number' | 'param'>
          size='sm'
          value={s.ikWeightParam ? 'param' : 'number'}
          onChange={mode => setState(i, mode === 'param'
            ? { ikWeightParam: speedParams[0]?.name, ikWeight: undefined }
            : { ikWeightParam: undefined })}
          options={[
            { value: 'number', label: '#', title: 'A fixed weight' },
            { value: 'param', label: 'P', title: 'Read the weight from a parameter — bind isGrounded or isFalling to drop IK in mid-air' },
          ]} />
        {s.ikWeightParam
          ? (speedParams.length === 0
            ? <span className='text-warning'>no numeric parameters</span>
            : <select className={input + ' w-[110px]'} value={s.ikWeightParam}
                onChange={e => setState(i, { ikWeightParam: e.target.value })}>
                {!speedParams.some(p => p.name === s.ikWeightParam) && <option value={s.ikWeightParam}>{s.ikWeightParam} — missing</option>}
                {speedParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>)
          : <input className={input + ' w-[56px]'} type='number' step='0.1' min='0' max='1'
              value={s.ikWeight ?? 1}
              onChange={e => {
                const v = parseFloat(e.target.value)
                setState(i, { ikWeight: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined })
              }} />}
        <span className='text-dim'>{!s.ikWeightParam && s.ikWeight === undefined ? '(on)' : ''}</span>
      </div>
      {s.ikWeightParam && <p className='text-[10px] text-gray-500 -mt-1'>Falls back to fully on if the parameter goes missing.</p>}

      <div className='text-[10px] uppercase tracking-wide text-gray-400 mt-1'>Links</div>
      {linked.length === 0
        ? <p className='text-[11px] text-gray-500'>None. Drag from this node's right handle in the graph to connect it.</p>
        : linked.map(l => {
            const other = l.a === s.name ? l.b : l.a
            const out = l.forward?.from === s.name || l.backward?.from === s.name
            const inc = l.forward?.to === s.name || l.backward?.to === s.name
            return (
              <div key={`${l.a}|${l.b}`} className='flex items-center gap-1 text-[11px] text-muted'>
                <span className='text-dim w-[26px] text-center' title={out && inc ? 'Both ways' : out ? 'Outgoing' : 'Incoming'}>
                  {out && inc ? '⇄' : out ? '→' : '←'}
                </span>
                <span className='truncate flex-1' title={other}>{other}</span>
              </div>
            )
          })}
    </div>
  )
}

/**
 * Binds one of a field's axes to a machine parameter — the join between the animation system's inputs and
 * the blend space's. Only numeric parameters are offered (a trigger is momentary and has no axis value);
 * a 'variable' parameter is in that set too, which is what lets an axis read a node variable live.
 */
/** The lowest coordinate any sample occupies on one of a field's axes. 0 for a field with no samples. */
function minSampleOn(field: AnimationFieldAsset, axis: 'x' | 'y'): number {
  const vs = field.samples.map(s => (axis === 'x' ? s.x : s.y ?? 0)).filter(v => Number.isFinite(v))
  return vs.length ? Math.min(...vs) : 0
}

function FieldAxisBinding({ label, params, value, onPick, minSample }: {
  label: string
  params: AnimationParameter[]
  value?: string
  onPick: (name: string) => void
  /** Lowest coordinate any sample occupies on this axis, so a negative one can be checked against the source. */
  minSample: number
}) {
  const missing = !!value && !params.some(p => p.name === value)

  // The silent failure this catches: an axis with samples at negative coordinates driven by a parameter that
  // reads a MAGNITUDE. The probe can then never enter the half of the field those samples live in, so their
  // clips have weight exactly 0 forever — "the walk-backwards animation just never plays", with a field that
  // looks correct and a binding that looks correct. Only reachable statically, which is why it is checked here
  // rather than left to be discovered in Play.
  const bound = params.find(p => p.name === value)
  const builtin = bound?.variable?.source === 'builtin' ? bound.variable.varName : undefined
  const unsigned = builtin !== undefined && builtin in UNSIGNED_BUILTINS
  const suggestion = unsigned ? UNSIGNED_BUILTINS[builtin!] : undefined

  return (
    <>
      <label className='flex items-center gap-1'>
        <span className='text-[10px] text-gray-400 w-[42px] shrink-0 truncate' title={label}>{label}</span>
        {params.length === 0
          ? <span className='text-[10px] text-warning flex-1'>No numeric parameter to bind.</span>
          : <select className={input + ' flex-1 min-w-0'} value={value ?? ''} onChange={e => onPick(e.target.value)}>
              <option value=''>— pick parameter —</option>
              {missing && <option value={value}>{value} — missing</option>}
              {params.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>}
      </label>
      {unsigned && minSample < 0 && (
        <p className='text-[10px] text-warning'>
          ⚠ “{label}” has samples at negative values, but <b>{builtin}</b> is never negative — it is a magnitude.
          Those clips can never play.
          {suggestion
            ? <> Rebind this parameter to <b>{suggestion}</b>, or move the samples to positive coordinates.</>
            : <> Move those samples to positive coordinates.</>}
        </p>
      )}
    </>
  )
}

/** Every leaf condition of a transition, whether it uses the flat list or a gate tree. */
function leafConditions(t: any): any[] {
  if (!t) return []
  if (!t.condition) return t.conditions ?? []
  const out: any[] = []
  const walk = (n: any) => { if (isConditionGroup(n)) n.children.forEach(walk); else out.push(n) }
  walk(t.condition)
  return out
}

/**
 * A `>` and a `<` on the same parameter whose engage points do not actually separate.
 *
 * This is THE way a locomotion machine ends up vibrating, and it is invisible in the editor because each
 * transition looks perfectly reasonable on its own — you have to hold both directions in your head at once to
 * see it. `Speed > 0.1` leaving Idle and `Speed < 0.1` leaving Locomotion are each obviously right; together
 * they mean a speed hovering at 0.1 satisfies both on alternating frames and the machine flips every frame.
 *
 * The criterion is the real one rather than "thresholds are equal": a band of `h` moves an engage point by
 * `h/2`, so what matters is whether `(gt + hGt/2)` ends up above `(lt - hLt/2)`. A genuine gap authored by
 * separating the two thresholds counts just as much as one authored with hysteresis. A `minDwell` on either
 * direction also settles it — bluntly, but it settles it — so that is taken as answered too.
 */
function chatteringPair(fwd: any, bwd: any): { param: string; gap: number } | null {
  if ((fwd?.minDwell ?? 0) > 0 || (bwd?.minDwell ?? 0) > 0) return null
  for (const a of [...leafConditions(fwd), ...leafConditions(bwd)]) {
    if (a.op !== 'gt' || typeof a.value !== 'number') continue
    for (const b of [...leafConditions(fwd), ...leafConditions(bwd)]) {
      if (b.op !== 'lt' || b.param !== a.param || typeof b.value !== 'number') continue
      const gap = (a.value + (a.hysteresis ?? 0) / 2) - (b.value - (b.hysteresis ?? 0) / 2)
      if (gap <= 0) return { param: a.param, gap }
    }
  }
  return null
}

/**
 * A reciprocal pair whose two directions test entirely DIFFERENT parameters.
 *
 * Such a pair can never be mutually exclusive, because nothing links the two truths: `Idle -> Run` on
 * `Speed > 1` and `Run -> Idle` on `Direction < 1` are both satisfied the whole time a character walks
 * forward, so the machine bounces every frame for as long as that holds. It is almost always a mis-picked
 * parameter in one dropdown — the intended condition was the MIRROR of the other direction, on the same
 * signal — and the graph gives no hint, because each edge reads perfectly sensibly on its own.
 *
 * Worth a check of its own rather than folding into the threshold one: no hysteresis band can fix it, so the
 * advice is different. Skipped when either direction uses a trigger (momentary and consumed, so it cannot
 * sustain a bounce) or is gated by dwell/exit time.
 */
function disjointReciprocal(fwd: any, bwd: any): { fwd: string[]; bwd: string[] } | null {
  if (!fwd || !bwd) return null
  if ((fwd.minDwell ?? 0) > 0 || (bwd.minDwell ?? 0) > 0 || fwd.hasExitTime || bwd.hasExitTime) return null
  const fc = leafConditions(fwd)
  const bc = leafConditions(bwd)
  if (fc.length === 0 || bc.length === 0) return null            // the empty case is reported on its own
  if ([...fc, ...bc].some(c => c.op === 'trigger')) return null
  const fp = [...new Set(fc.map(c => c.param))]
  const bp = [...new Set(bc.map(c => c.param))]
  if (fp.some(p => bp.includes(p))) return null
  return { fwd: fp, bwd: bp }
}

// ---- Selected transition (a LINK: up to one transition each way) -------------------------------------
function SelectedTransition() {
  const { selection, linkOf, addTransition, setTransition, removeTransition } = useStateMachine()
  if (selection?.kind !== 'transition') return null
  const link = linkOf(selection.a, selection.b)
  if (!link) return null

  const dirs: { from: string; to: string; t: typeof link.forward }[] = [
    { from: link.a, to: link.b, t: link.forward },
    { from: link.b, to: link.a, t: link.backward },
  ]

  const chatter = chatteringPair(link.forward, link.backward)
  const disjoint = disjointReciprocal(link.forward, link.backward)
  const unconditional = [
    { t: link.forward, from: link.a, to: link.b },
    { t: link.backward, from: link.b, to: link.a },
  ].filter(d => d.t && leafConditions(d.t).length === 0)

  return (
    <div className='flex flex-col gap-2'>
      {unconditional.length > 0 && (
        <p className='text-[10px] text-warning border border-warning/40 rounded p-1'>
          <b>{unconditional.map(d => `${d.from} → ${d.to}`).join(' and ')} has no conditions</b>, so it fires
          the instant the machine enters {unconditional.length > 1 ? 'those states' : 'that state'}.
          {link.forward && link.backward && ' With a transition both ways that is an unbreakable loop — the pose restarts every frame, which reads as the character vibrating.'}
        </p>
      )}
      {disjoint && (
        <p className='text-[10px] text-warning border border-warning/40 rounded p-1'>
          <b>These two transitions test different parameters</b> — <code>{disjoint.fwd.join(', ')}</code> one
          way and <code>{disjoint.bwd.join(', ')}</code> the other — so nothing stops both being true at once,
          and while they are, the machine flips every frame. A hysteresis band cannot help here: it separates
          two comparisons of the <i>same</i> signal.
          {' '}The way back is usually meant to be the <b>mirror</b> of the way out, on the same parameter.
        </p>
      )}
      {chatter && (
        <p className='text-[10px] text-warning border border-warning/40 rounded p-1'>
          <b>These two transitions will flip every frame.</b> “{chatter.param}” crosses <code>&gt;</code> and{' '}
          <code>&lt;</code> with no gap between them, so a value sitting on the threshold satisfies both on
          alternating frames — which shows up as the character vibrating, not as a state problem.
          {' '}Give each condition a <b>±</b> hysteresis band (0.1 is plenty for a speed), separate the two
          thresholds, or set a <b>min dwell</b> below.
        </p>
      )}
      {dirs.map(({ from, to, t }) => (
        <div key={`${from}->${to}`} className='border border-control rounded p-1.5 flex flex-col gap-1'>
          <div className='flex items-center gap-1'>
            {/* Both ends are text: rewiring is the graph's job now. */}
            <span className='text-[11px] flex-1 truncate' title={`${from} → ${to}`}>
              <span className='text-muted'>{from}</span> <span className='text-dim'>→</span> <span className='text-muted'>{to}</span>
            </span>
            {t
              ? <button className={danger} title={`Remove ${from} → ${to}`} onClick={() => removeTransition(from, to)}>✕</button>
              : <button className={ghost} title={`Also transition ${from} → ${to}`} onClick={() => addTransition(from, to)}>+ {from} → {to}</button>}
          </div>

          {t && <>
            <div className='flex items-center gap-1'>
              <Toggle label='has exit time' checked={!!t.hasExitTime} onChange={c => setTransition(from, to, { hasExitTime: c })} className='text-[10px]' />
              {t.hasExitTime && (
                <input className={input + ' w-[52px]'} type='number' step='0.05' min='0' max='1' value={t.exitTime ?? 1}
                  onChange={e => setTransition(from, to, { exitTime: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)) })} />
              )}
            </div>
            {/* Per-edge cross-fade. Empty falls back to the animator-wide default, so a landing can snap
                while a gait change stays lazy. */}
            <label className='flex items-center gap-1 text-[10px]' title='Cross-fade seconds for this transition. Leave empty to use the animator default.'>
              blend
              <input className={input + ' w-[52px]'} type='number' step='0.05' min='0' placeholder='0.3'
                value={t.blendTime ?? ''}
                onChange={e => {
                  const raw = e.target.value.trim()
                  setTransition(from, to, { blendTime: raw === '' ? undefined : Math.max(0, parseFloat(raw) || 0) })
                }} />
              <span className='text-dim'>s {t.blendTime === undefined && '(default)'}</span>
            </label>
            {/* The blunt fix for a state pair that ping-pongs. A blend covers a change visually, but the
                machine can still change its mind mid-blend and re-arm from a pose that barely moved — which
                reads as a spasm. This stops it changing its mind at all for a while. */}
            <label className='flex items-center gap-1 text-[10px]'
              title={'Seconds the machine must already have spent in the source state before this transition may '
                + 'fire. Use it when two states flip back and forth every frame. Unlike exit time this is real '
                + 'seconds, so it works for a looping state with no natural end.'}>
              min dwell
              <input className={input + ' w-[52px]'} type='number' step='0.05' min='0' placeholder='0'
                value={t.minDwell ?? ''}
                onChange={e => {
                  const raw = e.target.value.trim()
                  setTransition(from, to, { minDwell: raw === '' ? undefined : Math.max(0, parseFloat(raw) || 0) })
                }} />
              <span className='text-dim'>s {t.minDwell === undefined && '(off)'}</span>
            </label>
            <ConditionTree from={from} to={to} />
          </>}
        </div>
      ))}
    </div>
  )
}

// ---- Live preview ------------------------------------------------------------------------------------
// `simulate` runs the machine (checkTriggers each frame) instead of the raw clip. It lives here rather than
// on the transport because everything it feeds — the parameter drivers below and the graph's active-state
// highlight — is here.
function PreviewSection() {
  const { target, sm, simulate, setSimulate } = useStateMachine()
  if (!target) return null
  const hasMachine = target.animator.hasStateMachine

  return (
    <Collapsable title='Preview' defaultOpen>
      <div className='p-2 flex flex-col gap-1'>
        <div className='flex items-center gap-2'>
          <Toggle label='simulate' checked={simulate} disabled={!hasMachine} onChange={setSimulate}
            className='text-xs' />
          {simulate && hasMachine && <span className='text-highlight text-xs'>state: {target.animator.currentStateName ?? '—'}</span>}
        </div>
        {!hasMachine && <p className='text-[10px] text-gray-500'>Press <b>Apply to Model</b> first.</p>}

        {sm.parameters.map((p, i) => (
          <div key={i} className='flex items-center gap-2 text-xs'>
            <span className='flex-1 truncate' title={p.name}>{p.name}</span>
            {p.type === 'float' && <input className={input + ' w-[64px]'} type='number' step='0.1' defaultValue={Number(p.default)} onChange={e => target.animator.setFloat(p.name, parseFloat(e.target.value) || 0)} />}
            {p.type === 'bool' && <BoolDriver name={p.name} initial={!!p.default} onSet={(v) => target.animator.setBool(p.name, v)} />}
            {p.type === 'trigger' && <button className={ghost} onClick={() => target.animator.setTrigger(p.name)}>fire</button>}
            {p.type === 'variable' && (
              <span className='text-[10px] text-gray-500 truncate' title={p.variable ? `${p.variable.nodeRef}.${p.variable.varName}` : 'unbound'}>
                {p.variable ? `= ${String(target.animator.getParam(p.name))} (from ${p.variable.nodeRef}.${p.variable.varName})` : 'unbound'}
              </span>
            )}
          </div>
        ))}
        {sm.parameters.length === 0 && <p className='text-[11px] text-gray-400'>No parameters.</p>}
        {/* Built-in parameters read MEASURED motion, and the editor has no physics — so in here they are all
            0 and this can only show a hand-driven blend. The same readout is on the viewport's Animation
            blend debug toggle, which does run in Play, where those inputs are real. */}
        {simulate && hasMachine && (
          <div className='mt-1 rounded border border-control p-1.5'>
            <FieldDebugReadout animator={target.animator} />
          </div>
        )}
      </div>
    </Collapsable>
  )
}

/**
 * A bool parameter driver. The live value lives on the animator, not in `sm`, and Toggle is controlled — so it
 * keeps its own state rather than reading back a value nothing re-renders on.
 */
function BoolDriver({ name, initial, onSet }: { name: string; initial: boolean; onSet: (v: boolean) => void }) {
  const [v, setV] = useState(initial)
  return <Toggle checked={v} onChange={c => { setV(c); onSet(c) }} />
}

/**
 * Grouped dropdown of the values a Variable parameter can bind to: the engine's own measured Built-ins
 * first, then node variables by access group (Self / Parent / Scene).
 *
 * The option key includes `source` deliberately. A built-in `currentSpeed` and a script field of the same
 * name are two different bindings, and keying on nodeRef+varName alone would make each select the other.
 */
function VariablePicker({ vars, value, onPick }: {
  vars: AccessibleVariable[]
  value?: AnimationVariableBinding
  onPick: (b: AnimationVariableBinding | undefined) => void
}) {
  const key = (source: string, nodeRef: string, varName: string) => `${source}|${nodeRef}|${varName}`
  const current = value ? key(value.source ?? 'variable', value.nodeRef, value.varName) : ''
  const groups: Record<AccessibleVariable['group'], AccessibleVariable[]> = { 'Built-in': [], Self: [], Parent: [], Scene: [] }
  for (const v of vars) groups[v.group].push(v)
  return (
    <select className={input + ' w-[160px]'} value={current}
      title='Bind to a Built-in (engine-measured, e.g. how fast the node is really moving) or to a node variable — Self (own), Parent (protected/public), Scene (public)'
      onChange={e => {
        const found = vars.find(v => key(v.source, v.nodeRef, v.varName) === e.target.value)
        onPick(found
          ? { nodeRef: found.nodeRef, varName: found.varName, varType: found.varType, source: found.source }
          : undefined)
      }}>
      <option value=''>{value ? `${value.nodeRef} · ${value.varName} (missing)` : '— pick variable —'}</option>
      {/* Built-ins get one optgroup PER NODE. There are twenty of them per bodied node, and a single flat
          group would run to sixty rows with the node buried in each label — the heading has to carry it. */}
      {[...new Set(groups['Built-in'].map(v => v.nodeLabel))].map(label => (
        <optgroup key={`builtin:${label}`} label={`Built-in · ${label}`}>
          {groups['Built-in'].filter(v => v.nodeLabel === label).map(v => (
            <option key={key(v.source, v.nodeRef, v.varName)} value={key(v.source, v.nodeRef, v.varName)} title={v.hint}>
              {v.varName} ({v.varType})
            </option>
          ))}
        </optgroup>
      ))}
      {(['Self', 'Parent', 'Scene'] as const).map(g => groups[g].length > 0 && (
        <optgroup key={g} label={g}>
          {groups[g].map(v => (
            <option key={key(v.source, v.nodeRef, v.varName)} value={key(v.source, v.nodeRef, v.varName)} title={v.hint}>
              {v.nodeLabel} · {v.varName} ({v.varType})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
