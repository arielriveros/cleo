import { useState, useEffect, useRef } from 'react'
import { useEditorSessions } from '../EditorSessionsContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import type { Animator, AnimationVariableBinding, AnimationParameterType, AnimationParameter, AnimationStateTrigger, AnimationTransition, AnimationReactionEffects, AnimationRagdollStart, AnimationState } from 'cleo'
import { NODE_BUILTINS, isConditionGroup, parseReactionSets, pickReactionSet } from 'cleo'
import { FallIcon, GetUpIcon, KnockOutIcon, TripIcon } from '../rig/reactions/reactionIcons'
import { useReactionsSupported } from '../rig/reactions/reactionsSupport'
import { AccessibleVariable, UNSIGNED_BUILTINS } from './skeleton'
import FieldDebugReadout from './FieldDebugReadout'
import type { AnimationFieldAsset } from '../../utils/animationFields'
import { useStateMachine, ANY_STATE, linkKey } from './StateMachineContext'
import { entryOf, transitionsBetween } from './stateGroups'
import { transitionLabel } from './StateGraph'
import { HoldIcon, IntoGroupIcon, OutOfGroupIcon, UngroupIcon, EntryIcon, ForkIcon, DissolveIcon } from './groupIcons'
import { waysIn, waysOut } from './forks'
import { ForkGlyph } from '../../components/MachineGraph'
import ConditionTree from './ConditionTree'
import { AssetDropRow, LayerSection, SlotsSection } from './LayerPanels'
import { EventActionsSection } from './EventActionsPanel'
import AnimationAssetPicker from './AnimationAssetPicker'
import PoseLibrary from '../rig/PoseLibrary'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { BoltIcon, Button, ButtonWithConfirm, cn, ComboSelect, controlClass, FileButton, hintClass, JOINED_DIVIDER_CLASS, JOINED_GROUP_CLASS, NumberInput, OptionalNumberInput, SectionTitle, SegmentedControl, Select, TextInput, Toggle } from '@cleo/app-kit/ui'
import { clamp } from '@cleo/app-kit/utils/math';
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore'

// The Animation State Machine inspector, as three DOCK PANELS (Clips / Variables / State Machine) sharing
// one working copy from StateMachineContext, which wraps the whole dock. Adding, moving and connecting
// states, and setting the entry state, all belong to StateGraph.

/** Dense-row padding for the library controls (their default is px-2 py-1). */
const tight = 'px-1 py-0.5'
/** For the raw inputs that must keep uncontrolled semantics NumberInput/TextInput cannot express. */
const input = cn(controlClass, tight)

function NoModel() {
  return <div className='flex flex-col bg-surface-raised w-full h-full p-3 text-ui text-muted'>No skinned model selected.</div>
}

/**
 * Apply is machine-wide and every panel mutates the machine, Clips included, so it sits on all three.
 */
function ApplyBar() {
  const { apply, controller, fullSm, saveAsController, detachController } = useStateMachine()
  const saveAs = async () => {
    const name = await promptDialog({
      title: 'Share as an Animator',
      message: 'A shared animator can drive any number of characters. Each can swap clips with its own overrides.',
      defaultValue: 'Animator', validate: v => (v.trim() ? null : 'Give the animator a name.'),
    })
    if (name?.trim()) saveAsController(name.trim())
  }
  return (
    <div className='p-2 border-b border-border flex flex-col gap-1'>
      {/* Where Apply lands: the shared CONTROLLER asset, or this character's own machine. */}
      {controller ? (
        <div className='flex items-center gap-1 text-ui-sm'>
          <span className='flex-1 truncate text-highlight' title='Saving writes this shared animator; every character using it updates'>
            Shared animator: {controller.name}
          </span>
          <Button size='sm' variant='subtle' onClick={detachController}
            title='Stop following the shared animator — this character keeps a copy as its own'>Detach</Button>
        </div>
      ) : (
        <div className='flex items-center gap-1 text-ui-sm'>
          <span className='flex-1 truncate text-muted'>
            {fullSm.controllerId ? 'Its shared animator was deleted — using its own copy' : 'This character’s own animator'}
          </span>
          <Button size='sm' variant='subtle' onClick={() => void saveAs()}
            title='Turn this into a shared Animator other characters can use too'>Share…</Button>
        </div>
      )}
      {/* NOT "Apply to Model", which it was called and which is wrong twice over: it writes nothing to
          the model ASSET, and nothing about clips — those belong to the skeleton. What it commits is the
          state machine, onto the node's animator. That is genuinely node-owned data (ModelNode
          serializes `stateMachine`), and this is its only commit path: the working copy lives in
          per-tab React state and is lost on close without it. */}
      <Button size='sm' variant='primary' className=' w-full' onClick={apply}
        title={controller ? 'Save the shared animator (Ctrl+S)' : 'Save this character’s animator (Ctrl+S)'}>
        Save
      </Button>
    </div>
  )
}

// ---- Clips panel ------------------------------------------------------------------------------------
export function ClipsPanel() {
  const {
    target, clips, clipAssetId, modelId, adoptModel, hasBoneNames,
    renameClip, deleteClip, importAnimationFiles, importSkeletonNames,
  } = useStateMachine()
  // Above the early return: every hook must run on every render (see hookOrder.test.ts).
  const { ensureRigForModel } = useEditorSessions()
  const { models } = useAssetLibrary()
  const rigOfModel = modelId ? models.find(m => m.id === modelId)?.rigId : undefined
  if (!target) return <NoModel />

  // A shared clip is one stored copy retargeted onto this rig, so removing it means unlinking its ASSET;
  // deleting it off this model alone is undone by the next resolve.
  //
  // Root motion used to be a toggle on this row. It moved to the CLIP PLAYER: this panel is about which
  // clips a machine can name, not what they contain.
  const clipRow = (name: string) => {
    const sharedId = clipAssetId(name)
    return (
      <div key={name} className='flex items-center gap-1'>
        <input className={cn(input, 'flex-1')} defaultValue={name}
          title={sharedId ? 'Rename this clip in its animation asset (Enter to apply) — every model using it follows' : 'Rename clip (Enter to apply)'}
          onBlur={e => renameClip(name, e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        {sharedId
          ? <span className='text-ui-xs text-muted shrink-0 w-[52px] text-center' title='From a linked animation asset — unlink it above to remove'>linked</span>
          : <Button variant='remove' size='sm' title='Delete clip' onClick={() => deleteClip(name)}>✕</Button>}
      </div>
    )
  }

  const shared = clips.filter(c => !!clipAssetId(c))
  const own = clips.filter(c => !clipAssetId(c))

  return (
    <div className='flex flex-col text-fg bg-surface-raised w-full h-full overflow-y-auto'>
      <ApplyBar />
      <div className='p-2 flex flex-col gap-1'>
        <FileButton variant='subtle' className='w-full' multiple accept='.gltf,.glb,.fbx,.bin'
          title='Import animation clips (glTF / GLB / FBX) onto this skeleton'
          onFiles={importAnimationFiles}>
          Import Animation…
        </FileButton>
        {!hasBoneNames && (
          <FileButton variant='subtle' className='w-full border-warning text-warning' multiple accept='.gltf,.glb,.fbx,.bin'
            title='This model has no bone names, so imported animations match by node index (wrong bones). Load the ORIGINAL file this character was imported from to add bone names.'
            onFiles={importSkeletonNames}>
            ⚠ Add bone names from file…
          </FileButton>
        )}

        {/* Clips already in the library, linked rather than re-imported — the same affordance a texture
            slot gives: pick one, or drag it in from Assets. */}
        {/* Read-only here; minting happens in onNeedRig — see CharacterRows. */}
        <AnimationAssetPicker
          className='mt-1'
          rigId={rigOfModel ?? null}
          onNeedRig={async () => {
            const id = modelId ?? await adoptModel()
            return id ? ensureRigForModel(id) : null
          }}
        />

        <div className='mt-1 flex flex-col gap-1'>
          {clips.length === 0 && <p className='text-ui-sm text-muted'>No clips. Import or link one above.</p>}
          {shared.length > 0 && <SectionTitle title='From linked animations' className='mt-1' />}
          {shared.map(clipRow)}
          {own.length > 0 && shared.length > 0 && <SectionTitle title='This model’s own clips' className='mt-1' />}
          {own.map(clipRow)}
        </div>
      </div>
    </div>
  )
}

// ---- Variables panel (parameters + action slots) ----------------------------------------------------
export function VariablesPanel() {
  const { target, sm, accessVars, addParam, setParam, removeParam } = useStateMachine()
  if (!target) return <NoModel />

  return (
    <div className='flex flex-col text-fg bg-surface-raised w-full h-full overflow-y-auto'>
      <ApplyBar />
      <Collapsable title='Parameters' defaultOpen>
        <div className='p-2 flex flex-col gap-1'>
          {sm.parameters.map((p, i) => (
            <div key={i} className='flex items-center gap-1'>
              <TextInput className={cn(tight, 'flex-1')} value={p.name} onChange={v => setParam(i, { name: v })} />
              <Select className={tight} value={p.type} onChange={e => setParam(i, { type: e.target.value as AnimationParameterType })}>
                <option value='float' title='A number you set from a script'>Number</option>
                <option value='bool' title='On or off, set from a script'>Toggle</option>
                <option value='trigger' title='Fires once, then resets — for jump, attack, hit'>Trigger</option>
                <option value='variable' title='Follows a value automatically: the character’s speed, whether it is grounded, or any node variable'>Linked</option>
              </Select>
              {p.type === 'float'
                ? <NumberInput className={cn(tight, 'w-[56px]')} step='0.1' value={Number(p.default)} onChange={v => setParam(i, { default: v })} />
                : p.type === 'bool'
                  ? <Toggle checked={!!p.default} onChange={c => setParam(i, { default: c })} />
                  : p.type === 'trigger'
                    ? <CounterPicker value={p.variable} onPick={b => setParam(i, { variable: b })} />
                    : <VariablePicker vars={accessVars} value={p.variable}
                        onPick={b => setParam(i, { variable: b, default: builtinDefault(b) })} />}
              <Button variant='remove' size='sm' onClick={() => removeParam(i)}>✕</Button>
            </div>
          ))}
          <Button size='sm' variant='subtle' className='self-start mt-1' onClick={addParam}>+ Parameter</Button>
        </div>
      </Collapsable>

      <SlotsSection />
      <EventActionsSection />
    </div>
  )
}

// ---- State machine panel (selected element + preview) -------------------------------------------------
export function StateMachinePanel() {
  const { target, selection } = useStateMachine()
  if (!target) return <NoModel />

  return (
    <div className='flex flex-col text-fg bg-surface-raised w-full h-full overflow-y-auto'>
      <ApplyBar />
      <LayerSection />
      <Collapsable title='Selected' defaultOpen>
        <div className='p-2 flex flex-col gap-2'>
          {!selection && <p className='text-ui-sm text-muted'>Select a state, a group, a fork or a transition in the graph.</p>}
          {selection?.kind === 'state' && selection.name === ANY_STATE && (
            <p className='text-ui-sm text-muted'>
              <b>Any State</b> — a transition from here fires whichever state this layer is in, the moment its
              conditions hold. Drag from it to a state. To start a state on a trigger alone, give the state an
              <b> Enter on trigger</b> instead — no transition needed.
            </p>
          )}
          {selection?.kind === 'state' && <SelectedState />}
          {selection?.kind === 'group' && <SelectedGroup />}
          {selection?.kind === 'fork' && <SelectedFork />}
          {selection?.kind === 'summary' && <SelectedSummary />}
          {selection?.kind === 'transition' && <SelectedTransition />}
        </div>
      </Collapsable>
      <PreviewSection />
      <PoseSection />
    </div>
  )
}

// ---- Poses -------------------------------------------------------------------------------------------
// The pose mode on the preview character with its machine running (Layered): a weapon hold edited under its
// aim, Steady and hand IK, every blend space holding the pose following the drag. See rig/PoseLibrary.
function PoseSection() {
  const { target, modelId, simulate } = useStateMachine()
  const { models, rigs } = useAssetLibrary()
  const { stateMachineTargetId } = useEditorSessions()
  const rigId = modelId ? models.find(m => m.id === modelId)?.rigId : undefined
  const rig = rigId ? rigs.find(r => r.id === rigId) : undefined
  if (!target || !rig) return null
  return (
    <Collapsable title='Poses'>
      <div className='p-2 flex flex-col gap-1'>
        {!simulate && <p className={cn(hintClass, 'text-ui-xs')}>Turn on <b>simulate</b> above to edit a pose with the layers on.</p>}
        <PoseLibrary rigId={rig.id} rigName={rig.name} targetId={stateMachineTargetId} layered />
      </div>
    </Collapsable>
  )
}

// ---- Selected state details -----------------------------------------------------------------------
function SelectedState() {
  const {
    sm, selection, setSelection, clips, setState, removeState, stateIndex, links, animationFields, fieldOf, poseAssets,
    activeLayer, addTriggerParam, groups, groupOf, moveToGroup, fullSm, target,
  } = useStateMachine()
  if (selection?.kind !== 'state') return null
  const i = stateIndex(selection.name)
  if (i < 0) return null
  const s = sm.states[i]

  // Only a numeric parameter can be a rate; a trigger is momentary. The same set drives a field's axes,
  // variable-bound parameters included.
  const speedParams = sm.parameters.filter(p => p.type === 'float' || (p.type === 'variable' && p.variable?.varType !== 'boolean'))
  const byParam = !!s.speedParam
  const linked = links.filter(l => l.a === s.name || l.b === s.name)

  // A Ragdoll or Get Up state (base layer only) plays the body, not a clip: it outranks the rest. `fieldId` is the
  // clip-vs-blend-space discriminator and the runtime prefers it over clipName, so switching to Clip must clear it
  // and the embedded copy riding with it.
  const onBase = activeLayer === 0
  const playsRagdoll = onBase && !!s.ragdoll
  const playsGetUp = onBase && !playsRagdoll && !!s.getUp
  const reactionKind = playsRagdoll || playsGetUp
  const playsField = !reactionKind && !!s.fieldId
  const playsPose = !reactionKind && !playsField && !!(s.poseRef || s.pose)
  const field = fieldOf(s.fieldId)
  const allPoses = poseAssets.flatMap(a => a.poses.map(p => ({ asset: a, pose: p })))
  const noKind = { ragdoll: undefined, getUp: undefined }
  const setPlays = (kind: 'clip' | 'field' | 'pose' | 'ragdoll' | 'getUp') => {
    if (kind === 'clip') setState(i, { ...noKind, fieldId: undefined, field: undefined, fieldInputs: undefined, poseRef: undefined, pose: undefined })
    // Switching to a field drops any speed PARAMETER: the blend already matches speed, so keeping the
    // binding applies it twice. The fixed `speed` is kept.
    else if (kind === 'field') setState(i, { ...noKind, clipName: '', fieldId: animationFields[0]?.id ?? '', fieldInputs: {}, speedParam: undefined, poseRef: undefined, pose: undefined })
    // The body: no clip of its own (a Ragdoll holds the pose it is entered with), no blend space, no pose.
    else if (kind === 'ragdoll') setState(i, {
      ragdoll: { start: 'fall' }, getUp: undefined, clipName: '', fieldId: undefined, field: undefined, fieldInputs: undefined,
      speedParam: undefined, poseRef: undefined, pose: undefined,
    })
    else if (kind === 'getUp') setState(i, {
      getUp: {}, ragdoll: undefined, clipName: '', loop: false, fieldId: undefined, field: undefined, fieldInputs: undefined,
      speedParam: undefined, poseRef: undefined, pose: undefined,
    })
    // A pose is held, not played: no clip, no field. It is embedded from its asset on Apply.
    else {
      const first = allPoses[0]
      setState(i, {
        ...noKind, clipName: '', fieldId: undefined, field: undefined, fieldInputs: undefined, speedParam: undefined,
        poseRef: first ? { assetId: first.asset.id, poseId: first.pose.id } : undefined, pose: undefined,
      })
    }
  }

  // A field matches speed by choosing clips, so a playback-rate parameter multiplies on top of a correct
  // blend. Flagged for ANY parameter: two differently-named parameters can read the same value.
  const speedByParamOnField = playsField && !!s.speedParam
  const speedFeedsAxis = speedByParamOnField
    && (s.speedParam === s.fieldInputs?.x || s.speedParam === s.fieldInputs?.y)

  // There is no reverse playback, so a Speed parameter going negative is clamped to exactly 0 and the clip
  // freezes. Read the signedness off NODE_BUILTINS, never a list kept here: the engine's getters are the
  // authority and a second copy drifts.
  const speedBuiltin = sm.parameters.find(p => p.name === s.speedParam)?.variable
  const signedSpeed = speedBuiltin?.source === 'builtin' && !!NODE_BUILTINS[speedBuiltin.varName]?.signed
    ? speedBuiltin.varName
    : undefined

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-1'>
        <TextInput className={cn(tight, 'flex-1 min-w-0')} title='State name' value={s.name} onChange={v => setState(i, { name: v })} />
        <Button variant='remove' size='sm' className='shrink-0' title='Delete state' onClick={() => removeState(i)}>✕</Button>
      </div>
      {/* Entry is drawn in the graph (green border + ▶); it can be set here or by right-clicking the node. */}
      {s.isEntry
        ? <p className='text-ui-xs text-success'>▶ Entry state — the character starts here.</p>
        : <Button size='sm' variant='subtle' className='self-start' title='Start the character in this state'
            onClick={() => setState(i, { isEntry: true })}>▶ Make this the entry state</Button>}

      {/* Which group it is in: a group's own transitions leave from each of its states. */}
      {groups.length > 0 && (() => {
        const home = groupOf(s.name)
        return (
          <>
            <div className='flex items-center gap-1'>
              <span className='text-ui-xs text-muted w-[42px] shrink-0'
                title='The state group this state is in. A transition from a group fires from any of its states, after the state’s own.'>Group</span>
              <Select className={cn(tight, 'flex-1 min-w-0')} value={home?.name ?? ''}
                onChange={e => moveToGroup(s.name, e.target.value || null)}>
                <option value=''>(none)</option>
                {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
              </Select>
              {home && (
                <Button variant='ghost' size='sm' className='shrink-0' title={`Select ${home.name}`}
                  onClick={() => setSelection({ kind: 'group', name: home.name })}>
                  <span className='inline-block w-3.5 h-3.5'><IntoGroupIcon /></span>
                </Button>
              )}
            </div>
            {home && (
              <p className={hintClass}>
                {home.name}’s own transitions leave from here too, after this state’s own.
                {entryOf(home) === s.name && ' A transition into the group enters here.'}
              </p>
            )}
          </>
        )
      })()}

      <EnterOnTrigger triggers={s.triggers ?? []} params={sm.parameters.filter(p => p.type === 'trigger')}
        onChange={triggers => setState(i, { triggers: triggers.length ? triggers : undefined })}
        onNewTrigger={addTriggerParam} />

      {/* Dropping a pose asset here makes the state hold that asset's first pose. */}
      <AssetDropRow mime='text/cleo-pose' title='Drop a Pose asset here to hold its first pose'
        onDrop={id => {
          const asset = poseAssets.find(a => a.id === id)
          if (!asset?.poses.length) return
          setState(i, {
            clipName: '', fieldId: undefined, field: undefined, fieldInputs: undefined, speedParam: undefined,
            poseRef: { assetId: asset.id, poseId: asset.poses[0].id }, pose: undefined,
          })
        }}>
        <span className='text-ui-xs text-muted w-[42px] shrink-0'>Plays</span>
        <SegmentedControl<'clip' | 'field' | 'pose' | 'ragdoll' | 'getUp'>
          size='sm' value={playsRagdoll ? 'ragdoll' : playsGetUp ? 'getUp' : playsField ? 'field' : playsPose ? 'pose' : 'clip'} onChange={setPlays}
          options={[
            { value: 'clip', label: 'Clip', title: 'Play a single animation clip' },
            { value: 'field', label: 'Blend Space', title: 'Blend several clips by speed, direction or any parameter' },
            { value: 'pose', label: 'Pose', title: 'Hold a static pose from a Pose asset — on a masked layer, a hand grip over locomotion' },
            // The body's own states: base layer only.
            ...(onBase ? [
              { value: 'ragdoll' as const, label: <span className='inline-block w-3.5 h-3.5 align-[-2px]'><FallIcon /></span>,
                title: 'Ragdoll: while the graph is here the body is the physics’ (the character’s reactions). Entered on its feet it falls; entered when a hit has already knocked it down it holds the body, which never gets up by itself.' },
              { value: 'getUp' as const, label: <span className='inline-block w-3.5 h-3.5 align-[-2px]'><GetUpIcon /></span>,
                title: 'Get up: the body rises on a clip (face up or face down, picked as it is entered), lined up with where it lies and blended from it.' },
            ] : []),
          ]} />
      </AssetDropRow>

      {playsRagdoll && <RagdollRows state={s} clips={clips} onChange={patch => setState(i, patch)} />}
      {playsGetUp && <GetUpRows state={s} clips={clips} rigClips={rigGetUpClips(target)} onChange={patch => setState(i, patch)} />}
      {reactionKind && <ReactionStateLints state={s} />}

      {playsPose && (allPoses.length === 0
        ? <p className='text-ui-xs text-warning'>No poses yet — make one in Cleo Creator ▸ Motion.</p>
        : <Select className={cn(tight, 'flex-1 min-w-0')} title='The pose this state holds.'
            value={s.poseRef ? `${s.poseRef.assetId}/${s.poseRef.poseId}` : ''}
            onChange={e => {
              const [assetId, poseId] = e.target.value.split('/')
              setState(i, { poseRef: assetId && poseId ? { assetId, poseId } : undefined, pose: undefined })
            }}>
            <option value=''>(no pose)</option>
            {allPoses.map(({ asset, pose }) => (
              <option key={`${asset.id}/${pose.id}`} value={`${asset.id}/${pose.id}`}>{asset.name} / {pose.name}</option>
            ))}
          </Select>)}

      {activeLayer > 0 && !playsField && !playsPose && !s.clipName && (
        <p className={hintClass}>No clip on a layer means this state adds nothing — the layer fades out while it is here.</p>
      )}

      {!playsField && !playsPose && !reactionKind && (
        <Select className={cn(tight, 'flex-1 min-w-0')} title='Animation clip' value={s.clipName} onChange={e => setState(i, { clipName: e.target.value })}>
          <option value=''>(no clip)</option>
          {clips.map(c => <option key={c} value={c}>{c}</option>)}
        </Select>
      )}

      {playsField && (animationFields.length === 0
        ? <p className='text-ui-xs text-warning'>No blend spaces yet — create one from <b>Blend Spaces</b> in the bar at the top.</p>
        : <>
          <Select className={cn(tight, 'flex-1 min-w-0')} value={s.fieldId ?? ''}
            title='The blend space this state plays'
            onChange={e => setState(i, { fieldId: e.target.value })}>
            <option value=''>(no blend space)</option>
            {!field && s.fieldId && <option value={s.fieldId}>{s.fieldId} — missing</option>}
            {animationFields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>

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
            {!s.fieldInputs?.x && <p className='text-ui-xs text-warning'>Bind “{field.xAxis.name}” to a parameter or the blend will not move.</p>}
          </>}
        </>)}

      {!reactionKind && <div className='flex items-center gap-2'>
        <Toggle label='loop' checked={s.loop} onChange={c => setState(i, { loop: c })} className='text-ui-xs' />
        {s.loop && (
          <label className='flex items-center gap-1 text-ui-xs' title='How many times to play the clip. 0 = forever.'>
            <span className='text-muted'>times</span>
            <NumberInput className={cn(tight, 'w-[46px]')} step='1' min='0' value={s.loopCount ?? 0}
              onChange={v => setState(i, { loopCount: Math.max(0, Math.floor(v)) })} />
            <span className='text-dim'>{(s.loopCount ?? 0) === 0 ? '∞' : ''}</span>
          </label>
        )}
      </div>}

      {/* Speed: a fixed rate, or read live from a parameter (e.g. run faster the faster you move).
          On a FIELD state this is a multiplier on top of the blend, not the blend's input — see below. */}
      <div className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted w-[42px] shrink-0' title={playsField
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
              ? <span className='text-ui-xs text-warning flex-1'>No numeric parameter to bind.</span>
              : <Select className={cn(tight, 'flex-1 min-w-0')} value={s.speedParam}
                  title='Falls back to the fixed speed if the parameter goes missing.'
                  onChange={e => setState(i, { speedParam: e.target.value })}>
                  {!speedParams.some(p => p.name === s.speedParam) && <option value={s.speedParam}>{s.speedParam} — missing</option>}
                  {speedParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </Select>)
          : <NumberInput className={cn(tight, 'w-[56px]')} step='0.1' min='0' value={s.speed}
              onChange={v => setState(i, { speed: Math.max(0, v) })} />}
      </div>
      {/* Speed × a parameter: one number speeds up every state that names it (a boss's second phase). */}
      <div className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted w-[42px] shrink-0'
          title='Multiply the playback rate by a parameter, live. A missing parameter multiplies by 1.'>× param</span>
        <Select className={cn(tight, 'flex-1 min-w-0')} value={s.speedScaleParam ?? ''}
          onChange={e => setState(i, { speedScaleParam: e.target.value || undefined })}>
          <option value=''>(none)</option>
          {s.speedScaleParam && !speedParams.some(p => p.name === s.speedScaleParam)
            && <option value={s.speedScaleParam}>{s.speedScaleParam} — missing</option>}
          {speedParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
        </Select>
      </div>
      {!playsField && !playsPose && !reactionKind && (
        <div className='flex items-center gap-1'>
          <span className='text-ui-xs text-muted w-[42px] shrink-0'
            title='Clip seconds to start from: one segment of a longer clip, such as the second attack of a combo authored as one animation.'>Start at</span>
          <NumberInput className={cn(tight, 'w-[56px]')} step='0.05' min='0' value={s.startTime ?? 0}
            onChange={v => setState(i, { startTime: v > 0 ? v : undefined })} />
          <span className='text-ui-xs text-dim'>s</span>
        </div>
      )}
      {/* Stop motion: the state's clips held at this many poses a second. Empty plays smooth. */}
      {!playsPose && !reactionKind && (
        <div className='flex items-center gap-1'>
          <span className='text-ui-xs text-muted w-[42px] shrink-0'
            title={'Stop motion: show this state’s clip (every clip of a blend space, together) as this many held poses a '
              + 'second of game time, whatever its speed. Empty plays smooth. Only the poses step: the clip’s events, exit '
              + 'time and root motion, cross-fades, blend weights, layers and foot placement stay smooth, so the character '
              + 'still travels smoothly.'}>Frames</span>
          <OptionalNumberInput className={cn(tight, 'w-[56px]')} step='1' min='1' max='60' placeholder='smooth'
            value={s.fps}
            onChange={v => setState(i, { fps: v === undefined || !(v > 0) ? undefined : Math.min(60, Math.max(1, Math.round(v))) })} />
          <span className='text-ui-xs text-dim'>fps</span>
        </div>
      )}
      {activeLayer > 0 && !playsField && !playsPose && (
        <Toggle label='extract root travel' checked={!!s.extractRootMotion} className='text-ui-xs'
          onChange={c => setState(i, { extractRootMotion: c || undefined })} />
      )}
      {byParam && signedSpeed && (
        <p className='text-ui-xs text-warning -mt-1'>
          <b>“{signedSpeed}” goes negative</b> — and there is no reverse playback, so the rate is clamped to 0
          and the clip freezes for that whole half of its range. With a blend field still re-mixing underneath,
          that reads on screen as the pose vibrating rather than as an animation that stopped. Bind Speed to a
          magnitude (<b>planarSpeed</b>, <b>currentSpeed</b>) instead, or set it to <b>#</b> and let the field’s
          per-sample <b>Rate</b> column set the pace.
        </p>
      )}
      {speedByParamOnField && (
        <p className='text-ui-xs text-warning -mt-1'>
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
      {!reactionKind && <div className='flex items-center gap-1 text-ui-xs'
        title={'How strongly foot placement applies during this state. 1 is fully on, 0 leaves the animation exactly as '
          + 'authored. Feet with no ground under them fade out by themselves, so this is rarely needed.'}>
        <span className='text-muted'>feet</span>
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
            : <Select className={cn(tight, 'w-[110px]')} value={s.ikWeightParam}
                title='Falls back to fully on if the parameter goes missing.'
                onChange={e => setState(i, { ikWeightParam: e.target.value })}>
                {!speedParams.some(p => p.name === s.ikWeightParam) && <option value={s.ikWeightParam}>{s.ikWeightParam} — missing</option>}
                {speedParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </Select>)
          : <OptionalNumberInput className={cn(tight, 'w-[56px]')}
              value={s.ikWeight ?? 1}
              onChange={v => setState(i, { ikWeight: v === undefined ? undefined : clamp(v, 0, 1) })} />}
        <span className='text-dim'>{!s.ikWeightParam && s.ikWeight === undefined ? '(on)' : ''}</span>
        <span title={'Foot locking in this state, when the skeleton has it on: a planted foot keeps its spot while the body '
          + 'moves or turns over it. Turn it off for a standing state whose small weight shifts should not be pinned; a foot '
          + 'locked when the state is entered then fades back to the animation.'}>
          <Toggle label='lock' checked={s.footLock !== false}
            onChange={c => setState(i, { footLock: c ? undefined : false })} className='text-ui-xs' />
        </span>
        <span title={'Plant the feet by the clips’ foot-lock windows, at any height: a foot inside one keeps its ground '
          + 'correction however far above the other foot the clip holds it. For a stair climb, whose upper foot stands a '
          + 'riser above the lower one and would otherwise float over its tread. Off, a raised foot reads as swinging.'}>
          <Toggle label='windows' checked={!!s.plantInWindows}
            onChange={c => setState(i, { plantInWindows: c || undefined })} className='text-ui-xs' />
        </span>
        {/* Base layer only: a layer's state does not move the character. */}
        {activeLayer === 0 && (
          <span title={'Hold the character still while this state plays: the Character it animates stops steering (no '
            + 'speed, no turning; gravity kept), so only the clip’s root motion moves it. For a clip that must not travel '
            + 'with the speed it came in with or the stick, a hard landing say.'}>
            <Toggle doc={false} checked={!!s.holdMovement} className='text-ui-xs'
              label={<span className='inline-block w-3.5 h-3.5 align-[-2px]'><HoldIcon /></span>}
              onChange={c => setState(i, { holdMovement: c || undefined })} />
          </span>
        )}
      </div>}

      {/* Sync group: a hand-over between two states of one carries the stride (AnimationState.syncGroup). */}
      {!reactionKind && <div className='flex items-center gap-1 text-ui-xs'
        title={'States in one sync group hand over in step: the state entered starts at the phase of the cycle the one '
          + 'left was at, and through the cross-fade the two move as one. For blend spaces whose phase 0 is the same '
          + 'foot’s plant (a walk and a stair climb, say). On a layer, a state in the group the base layer’s state is '
          + 'in follows the base’s phase every frame (an upper body keeping step with the legs); never put a held '
          + 'state (speed 0) in one. Not the same as the state groups above, which share transitions.'}>
        <span className='text-muted w-[42px] shrink-0'>Sync</span>
        <div className='flex-1 min-w-0'>
          <ComboSelect value={s.syncGroup ?? ''} noun='sync group' allowEmpty allowCustom
            choices={[...new Set([...sm.states, ...(activeLayer > 0 ? fullSm.states : [])]
              .map(x => x.syncGroup).filter((g): g is string => !!g))].map(value => ({ value }))}
            onChange={v => setState(i, { syncGroup: v.trim() || undefined })} />
        </div>
      </div>}

      {/* Steady (AnimationState.meshSpace), on an override layer: the pose keeps its own model-space turn at the
          top of the layer's mask, so one held pose sits still over every gait. */}
      {activeLayer > 0 && (fullSm.layers?.[activeLayer - 1]?.blend ?? 'override') !== 'additive' && (
        <div className='flex items-center gap-1 text-ui-xs'
          title={'Steady: how much this state’s pose keeps its own turn in model space at the top of the layer’s mask (the '
            + 'spine of an upper-body mask), whatever the hips beneath do. 0 rides the hips and sways with the walk; 1 holds '
            + 'still, so one held pose (a rifle hold) works over every gait and on stairs. Everything below the top of the '
            + 'mask rides with it, so both hands stay on what they hold; layers above (a lean) still tilt it. A layer with '
            + 'no mask has no top, and this does nothing there.'}>
          <span className='text-muted w-[42px] shrink-0'>Steady</span>
          <OptionalNumberInput className={cn(tight, 'w-[56px]')} value={s.meshSpace ?? 0}
            onChange={v => setState(i, { meshSpace: v === undefined || v <= 0 ? undefined : clamp(v, 0, 1) })} />
          <span className='text-dim'>0 rides the hips, 1 holds still</span>
        </div>
      )}

      <ReactionEffectsRows value={s.reactions} onChange={reactions => setState(i, { reactions })} />

      <SectionTitle title='Links' className='mt-1' />
      {linked.length === 0
        ? <p className={cn(hintClass, 'text-ui-sm')}>None. Drag from this node's right handle in the graph to connect it.</p>
        : linked.map(l => {
            const other = l.a === s.name ? l.b : l.a
            const out = l.forward?.from === s.name || l.backward?.from === s.name
            const inc = l.forward?.to === s.name || l.backward?.to === s.name
            return (
              <div key={`${l.a}|${l.b}`} className='flex items-center gap-1 text-ui-sm text-muted'>
                <span className='text-dim w-[26px] text-center' title={out && inc ? 'Both ways' : out ? 'Outgoing' : 'Incoming'}>
                  {out && inc ? '⇄' : out ? '→' : '←'}
                </span>
                <span className='truncate flex-1' title={other}>{other === ANY_STATE ? 'Any State' : other}</span>
              </div>
            )
          })}
    </div>
  )
}

/**
 * The triggers that enter a state directly, by name: a script's `setTrigger('Roll')` plays the state listing
 * Roll from wherever its layer is, with no transition drawn. A name not yet a parameter becomes a trigger.
 */
function EnterOnTrigger({ triggers, params, onChange, onNewTrigger }: {
  triggers: AnimationStateTrigger[]
  params: AnimationParameter[]
  onChange: (next: AnimationStateTrigger[]) => void
  onNewTrigger: (name: string) => void
}) {
  const set = (k: number, patch: Partial<AnimationStateTrigger>) => onChange(triggers.map((e, j) => (j === k ? { ...e, ...patch } : e)))
  const choices = params.map(p => ({ value: p.name }))
  return (
    <div className='flex flex-col gap-1'>
      <div className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted flex-1'
          title='Triggers that start this state directly, from whatever state its layer is in — no transition needed. Checked after Any State and before this state’s own transitions.'>
          Enter on trigger
        </span>
        <Button size='sm' variant='subtle' title='Start this state when a trigger fires'
          onClick={() => onChange([...triggers, { trigger: params.find(p => !triggers.some(e => e.trigger === p.name))?.name ?? '' }])}>+ trigger</Button>
      </div>
      {triggers.map((e, k) => (
        <div key={k} className='flex items-center gap-1 text-ui-xs'>
          <BoltIcon className='w-3.5 h-3.5 shrink-0 text-primary' />
          <div className='flex-1 min-w-0'>
            <ComboSelect value={e.trigger} choices={choices} noun='trigger' allowEmpty={false}
              title='The trigger, by name. A new name becomes a trigger parameter.'
              onChange={v => { if (!params.some(p => p.name === v)) onNewTrigger(v); set(k, { trigger: v }) }} />
          </div>
          <span title='Seconds to blend in. Empty uses the animator default.'>
            <OptionalNumberInput className={cn(tight, 'w-[44px]')} placeholder='0.3' value={e.blendTime}
              onChange={v => set(k, { blendTime: v === undefined ? undefined : Math.max(0, v) })} />
          </span>
          <span title='Restart the state when the trigger fires while it already plays. Off, the trigger waits until it can.'>
            <Toggle label='restart' checked={e.restart !== false} className='text-ui-xs'
              onChange={c => set(k, { restart: c ? undefined : false })} />
          </span>
          <Button variant='remove' size='sm' title='Remove this trigger' onClick={() => onChange(triggers.filter((_, j) => j !== k))}>✕</Button>
        </div>
      ))}
    </div>
  )
}

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

  // Catches an axis with samples at negative coordinates driven by a parameter that reads a MAGNITUDE: the
  // probe can never enter that half of the field, so those clips hold weight 0 forever.
  const bound = params.find(p => p.name === value)
  const builtin = bound?.variable?.source === 'builtin' ? bound.variable.varName : undefined
  const unsigned = builtin !== undefined && builtin in UNSIGNED_BUILTINS
  const suggestion = unsigned ? UNSIGNED_BUILTINS[builtin!] : undefined

  return (
    <>
      <label className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted w-[42px] shrink-0 truncate' title={label}>{label}</span>
        {params.length === 0
          ? <span className='text-ui-xs text-warning flex-1'>No numeric parameter to bind.</span>
          : <Select className={cn(tight, 'flex-1 min-w-0')} value={value ?? ''} onChange={e => onPick(e.target.value)}>
              <option value=''>— pick parameter —</option>
              {missing && <option value={value}>{value} — missing</option>}
              {params.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </Select>}
      </label>
      {unsigned && minSample < 0 && (
        <p className='text-ui-xs text-warning'>
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
 * A `>` and a `<` on the same parameter whose engage points do not actually separate, which makes the pair
 * flip every frame. A hysteresis band of `h` moves an engage point by `h/2`, so the criterion is whether
 * `(gt + hGt/2)` exceeds `(lt - hLt/2)`. A `minDwell` on either direction counts as answered.
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
 * A reciprocal pair whose two directions test entirely DIFFERENT parameters, which can never be mutually
 * exclusive and so bounces every frame. No hysteresis band fixes it. Skipped when either direction uses a
 * trigger (momentary and consumed) or is gated by dwell/exit time.
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

// ---- Selected group ------------------------------------------------------------------------------------
function SelectedGroup() {
  const {
    sm, selection, setSelection, groups, groupOf, setGroup, removeGroup, moveToGroup, openGroup, setOpenGroup, paramOf,
    forks, isFork,
  } = useStateMachine()
  if (selection?.kind !== 'group') return null
  const g = groups.find(x => x.name === selection.name)
  if (!g) return null
  const entry = entryOf(g)
  const own = sm.transitions.filter(t => t.from === g.name || t.to === g.name)
  const free = [...sm.states, ...forks].filter(st => !groupOf(st.name))
  const icon = (C: (p: React.SVGProps<SVGSVGElement>) => JSX.Element) => <span className='inline-block w-4 h-4'><C /></span>
  const strip = 'flex items-center justify-center px-1.5 py-1 text-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:pointer-events-none'
  const pickTransition = (from: string, to: string) => { const [a, b] = linkKey(from, to); setSelection({ kind: 'transition', a, b }) }

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-1'>
        <TextInput className={cn(tight, 'flex-1 min-w-0')} title='Group name: no state or other group may have it' value={g.name}
          onChange={v => setGroup(g.name, { name: v })} />
        <div className={JOINED_GROUP_CLASS}>
          <button type='button' className={strip} disabled={openGroup === g.name} title='Open it in the graph'
            onClick={() => setOpenGroup(g.name)}>{icon(IntoGroupIcon)}</button>
          <button type='button' className={cn(strip, JOINED_DIVIDER_CLASS)}
            title='Ungroup: its states back on the graph, each keeping the group’s transitions as its own'
            onClick={() => removeGroup(g.name, 'ungroup')}>{icon(UngroupIcon)}</button>
        </div>
        <ButtonWithConfirm variant='remove' size='sm' title='Delete the group AND its states' onClick={() => removeGroup(g.name, 'delete')}>✕</ButtonWithConfirm>
      </div>
      <p className={hintClass}>
        A transition from the group fires from any of its states, after that state’s own ways out; one into the
        group enters its entry state (or goes on through its entry fork).
      </p>

      <div className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted w-[42px] shrink-0' title='The state a transition into the group enters, or the fork it goes on through'>Entry</span>
        <Select className={cn(tight, 'flex-1 min-w-0')} value={entry ?? ''} disabled={!g.states.length}
          onChange={e => setGroup(g.name, { entry: e.target.value || undefined })}>
          {g.states.map(m => <option key={m} value={m}>{m}{!g.entry && m === g.states[0] ? ' (first)' : ''}</option>)}
        </Select>
      </div>

      <SectionTitle title='States' className='mt-1' />
      {g.states.length === 0 && <p className={hintClass}>No states: nothing to enter, nothing to leave from.</p>}
      {g.states.map(m => (
        <div key={m} className='flex items-center gap-1 text-ui-sm'>
          <button type='button' className='flex-1 truncate text-left text-muted hover:text-fg flex items-center gap-1' title={`Select ${m}`}
            onClick={() => setSelection(isFork(m) ? { kind: 'fork', name: m } : { kind: 'state', name: m })}>
            {isFork(m) && <ForkGlyph />}<span className='truncate'>{m}</span>
          </button>
          {m === entry
            ? <span className='w-5 h-5 p-0.5 text-success' title='The entry'><EntryIcon /></span>
            : <Button variant='ghost' size='sm' title='Make it the group’s entry' onClick={() => setGroup(g.name, { entry: m })}>
                <span className='inline-block w-3.5 h-3.5'><EntryIcon /></span>
              </Button>}
          <Button variant='ghost' size='sm' title='Take it out of the group' onClick={() => moveToGroup(m, null)}>
            <span className='inline-block w-3.5 h-3.5'><OutOfGroupIcon /></span>
          </Button>
        </div>
      ))}
      {free.length > 0 && (
        <Select className={cn(tight, 'self-start')} value='' title='Put another state (or a fork) in this group'
          onChange={e => { if (e.target.value) moveToGroup(e.target.value, g.name) }}>
          <option value=''>+ state…</option>
          {free.map(st => <option key={st.name} value={st.name}>{st.name}{isFork(st.name) ? ' (fork)' : ''}</option>)}
        </Select>
      )}

      <SectionTitle title='Its own transitions' className='mt-1' />
      {own.length === 0
        ? <p className={cn(hintClass, 'text-ui-sm')}>None. Drag from the group’s top-right handle in the graph (or, opened, from “Any state in {g.name}”) to add one.</p>
        : own.map(t => (
            <button type='button' key={`${t.from}>${t.to}`} className='flex items-center gap-1 text-ui-sm text-muted hover:text-fg text-left'
              title='Edit this transition' onClick={() => pickTransition(t.from, t.to)}>
              <span className='text-dim w-[26px] text-center'>{t.from === g.name ? '→' : '←'}</span>
              <span className='truncate flex-1'>{t.from === g.name ? (t.to === ANY_STATE ? 'Any State' : t.to) : (t.from === ANY_STATE ? 'Any State' : t.from)}</span>
              <span className='text-ui-xs text-dim truncate max-w-[50%]'>{transitionLabel(t, paramOf)}</span>
            </button>
          ))}
    </div>
  )
}

// ---- Selected fork ------------------------------------------------------------------------------------
function SelectedFork() {
  const {
    sm, selection, setSelection, groups, groupOf, setGroup, moveToGroup, forks, setFork, removeFork, dissolveFork,
    moveTransition, addTransition, paramOf,
  } = useStateMachine()
  if (selection?.kind !== 'fork') return null
  const f = forks.find(x => x.name === selection.name)
  if (!f) return null
  const ins = waysIn(sm, f.name)
  const outs = waysOut(sm, f.name)
  const home = groupOf(f.name)
  const name = (n: string) => (n === ANY_STATE ? 'Any State' : n)
  const pick = (t: AnimationTransition) => { const [a, b] = linkKey(t.from, t.to); setSelection({ kind: 'transition', a, b }) }
  const icon = (C: (p: React.SVGProps<SVGSVGElement>) => JSX.Element) => <span className='inline-block w-4 h-4'><C /></span>
  const strip = 'flex items-center justify-center px-1.5 py-1 text-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:pointer-events-none'
  // Where a new way out can go: anything but the fork itself and the places it already goes.
  const targets = [...sm.states.map(s => s.name), ...groups.map(g => g.name), ...forks.map(x => x.name)]
    .filter(n => n !== f.name && !outs.some(t => t.to === n))
  const row = 'flex items-center gap-1 text-ui-sm text-muted'

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-1'>
        <span className='w-4 h-4 text-warning shrink-0'><ForkIcon /></span>
        <TextInput className={cn(tight, 'flex-1 min-w-0')} title='Fork name: no state, group or other fork may have it' value={f.name}
          onChange={v => setFork(f.name, { name: v })} />
        <div className={JOINED_GROUP_CLASS}>
          <button type='button' className={strip} disabled={!ins.length || !outs.length}
            title='Dissolve: take the fork away and keep what it did, each way in joined to each way out'
            onClick={() => dissolveFork(f.name)}>{icon(DissolveIcon)}</button>
        </div>
        <ButtonWithConfirm variant='remove' size='sm' title='Delete the fork and every transition into or out of it' onClick={() => removeFork(f.name)}>✕</ButtonWithConfirm>
      </div>
      <p className={hintClass}>
        Not a state: the machine goes straight through. A way in fires only when a way out holds, and then goes on to
        the first that does, in this order. Every gate is tested on the state being left.
      </p>

      {groups.length > 0 && (
        <div className='flex items-center gap-1'>
          <span className='text-ui-xs text-muted w-[42px] shrink-0' title='The state group this fork is in'>Group</span>
          <Select className={cn(tight, 'flex-1 min-w-0')} value={home?.name ?? ''}
            onChange={e => moveToGroup(f.name, e.target.value || null)}>
            <option value=''>(none)</option>
            {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
          </Select>
          {home && (entryOf(home) === f.name
            ? <span className='w-5 h-5 p-0.5 text-success shrink-0' title={`The entry of ${home.name}: a transition into it goes on through this fork`}><EntryIcon /></span>
            : <Button variant='ghost' size='sm' className='shrink-0' title={`Make it ${home.name}’s entry: a transition into the group goes on through it`}
                onClick={() => setGroup(home.name, { entry: f.name })}>
                <span className='inline-block w-3.5 h-3.5'><EntryIcon /></span>
              </Button>)}
        </div>
      )}

      <SectionTitle title='Ways in' className='mt-1' />
      {ins.length === 0
        ? <p className={cn(hintClass, 'text-ui-sm')}>None. Drag from a state onto the fork in the graph.</p>
        : ins.map(t => (
            <button type='button' key={`${t.from}>${t.to}`} className={cn(row, 'hover:text-fg text-left')} title='Edit this transition' onClick={() => pick(t)}>
              <span className='truncate flex-1'>{name(t.from)}{t.to !== f.name && <span className='text-dim'> → {t.to}</span>}</span>
              <span className='text-ui-xs text-dim truncate max-w-[50%]'>{transitionLabel(t, paramOf) || 'always'}</span>
            </button>
          ))}

      <SectionTitle title='Ways out' className='mt-1' />
      {outs.length === 0 && <p className={cn(hintClass, 'text-ui-sm')}>None: nothing goes through it. Drag from the fork to a state.</p>}
      {outs.map((t, k) => (
        <div key={`${t.from}>${t.to}`} className={row}>
          <span className='text-dim w-4 text-right shrink-0' title='Tried in this order: the first that holds is taken'>{k + 1}</span>
          <button type='button' className='flex-1 min-w-0 flex items-center gap-1 hover:text-fg text-left' title='Edit this transition' onClick={() => pick(t)}>
            <span className='truncate'>{t.to}</span>
            <span className='ml-auto text-ui-xs text-dim truncate max-w-[55%]'>{transitionLabel(t, paramOf) || 'always'}</span>
          </button>
          <Button variant='ghost' size='sm' className='shrink-0 px-1' disabled={k === 0} title='Try it earlier' onClick={() => moveTransition(t.from, t.to, -1)}>↑</Button>
          <Button variant='ghost' size='sm' className='shrink-0 px-1' disabled={k === outs.length - 1} title='Try it later' onClick={() => moveTransition(t.from, t.to, 1)}>↓</Button>
        </div>
      ))}
      {targets.length > 0 && (
        <Select className={cn(tight, 'self-start')} value='' title='Add a way out of the fork (tried after the others)'
          onChange={e => { if (e.target.value) addTransition(f.name, e.target.value) }}>
          <option value=''>+ way out…</option>
          {targets.map(n => <option key={n} value={n}>{n}</option>)}
        </Select>
      )}
    </div>
  )
}

/** A line in the graph that stands for several transitions: each, one click from its inspector. */
function SelectedSummary() {
  const { sm, selection, setSelection, paramOf } = useStateMachine()
  if (selection?.kind !== 'summary') return null
  const list = transitionsBetween(sm, selection.from, selection.to)
  const name = (n: string) => (n === ANY_STATE ? 'Any State' : n)
  return (
    <div className='flex flex-col gap-1'>
      <p className='text-ui-sm text-muted'>
        <b>{name(selection.from)}</b> <span className='text-dim'>→</span> <b>{name(selection.to)}</b>: this line stands
        for {list.length === 1 ? 'one transition' : `${list.length} transitions`}. Pick one to edit it.
      </p>
      {list.map(t => (
        <button type='button' key={`${t.from}>${t.to}`} className='flex items-center gap-1 text-ui-sm text-muted hover:text-fg text-left border border-control rounded px-1.5 py-1'
          title='Edit this transition'
          onClick={() => { const [a, b] = linkKey(t.from, t.to); setSelection({ kind: 'transition', a, b }) }}>
          <span className='truncate flex-1'>{name(t.from)} <span className='text-dim'>→</span> {name(t.to)}</span>
          <span className='text-ui-xs text-dim truncate max-w-[50%]'>{transitionLabel(t, paramOf) || 'always'}</span>
        </button>
      ))}
    </div>
  )
}

// ---- Selected transition (a LINK: up to one transition each way) -------------------------------------
function SelectedTransition() {
  const { selection, linkOf, addTransition, setTransition, removeTransition, groups, isFork, sm, activeLayer } = useStateMachine()
  if (selection?.kind !== 'transition') return null
  const link = linkOf(selection.a, selection.b)
  if (!link) return null
  // A transition into a fork (or into a group entered through one) only fires on through one of its ways out.
  const entryName = (n: string) => { const g = groups.find(x => x.name === n); return g ? entryOf(g) ?? n : n }
  const intoFork = (t: AnimationTransition | null) => !!t && isFork(entryName(t.to))
  const intoGetUp = (to: string) => !!sm.states.find(x => x.name === entryName(to))?.getUp && activeLayer === 0

  // Nothing transitions INTO "any state", so a link to it has one direction only.
  const dirs: { from: string; to: string; t: typeof link.forward }[] = [
    { from: link.a, to: link.b, t: link.forward },
    { from: link.b, to: link.a, t: link.backward },
  ].filter(d => d.to !== ANY_STATE)

  const chatter = chatteringPair(link.forward, link.backward)
  const disjoint = disjointReciprocal(link.forward, link.backward)
  const unconditional = [
    { t: link.forward, from: link.a, to: link.b },
    { t: link.backward, from: link.b, to: link.a },
  ].filter(d => d.t && leafConditions(d.t).length === 0 && !intoFork(d.t))

  return (
    <div className='flex flex-col gap-2'>
      {unconditional.length > 0 && (
        <p className='text-ui-xs text-warning border border-warning/40 rounded p-1'>
          <b>{unconditional.map(d => `${d.from} → ${d.to}`).join(' and ')} has no conditions</b>, so it fires
          the instant the machine enters {unconditional.length > 1 ? 'those states' : 'that state'}.
          {link.forward && link.backward && ' With a transition both ways that is an unbreakable loop — the pose restarts every frame, which reads as the character vibrating.'}
        </p>
      )}
      {disjoint && (
        <p className='text-ui-xs text-warning border border-warning/40 rounded p-1'>
          <b>These two transitions test different parameters</b> — <code>{disjoint.fwd.join(', ')}</code> one
          way and <code>{disjoint.bwd.join(', ')}</code> the other — so nothing stops both being true at once,
          and while they are, the machine flips every frame. A tolerance cannot help here: it separates
          two comparisons of the <i>same</i> signal.
          {' '}The way back is usually meant to be the <b>mirror</b> of the way out, on the same parameter.
        </p>
      )}
      {chatter && (
        <p className='text-ui-xs text-warning border border-warning/40 rounded p-1'>
          <b>These two transitions will flip every frame.</b> “{chatter.param}” crosses <code>&gt;</code> and{' '}
          <code>&lt;</code> with no gap between them, so a value sitting on the threshold satisfies both on
          alternating frames — which shows up as the character vibrating, not as a state problem.
          {' '}Give each condition a <b>tolerance</b> (0.1 is plenty for a speed), separate the two
          thresholds, or set <b>stay at least</b> below.
        </p>
      )}
      {[link.a, link.b].some(isFork) && (
        <p className={hintClass}>
          {[link.a, link.b].filter(isFork).map(n => <b key={n}>{n} </b>)}
          is a fork: a transition into it fires only when one of its ways out holds, and goes straight on; each way
          out is tried in its order. Gates on either side are tested on the state being left, and the way out’s blend
          wins. Put a trigger on a way out, not on the way in: a way in that waits on its ways out keeps its trigger raised.
        </p>
      )}
      {groups.some(g => g.name === link.a || g.name === link.b) && (
        <p className={hintClass}>
          {[link.a, link.b].filter(n => groups.some(g => g.name === n)).map(n => <b key={n}>{n} </b>)}
          is a group: from it, a transition fires from any of its states (after that state’s own); into it, it enters
          its entry state.
        </p>
      )}
      {dirs.map(({ from, to, t }) => (
        <div key={`${from}->${to}`} className='border border-control rounded p-1.5 flex flex-col gap-1'>
          <div className='flex items-center gap-1'>
            {/* Both ends are text: rewiring is the graph's job now. */}
            <span className='text-ui-sm flex-1 truncate' title={`${from} → ${to}`}>
              <span className='text-muted'>{from === ANY_STATE ? 'Any State' : from}</span> <span className='text-dim'>→</span> <span className='text-muted'>{to}</span>
            </span>
            {t
              ? <Button variant='remove' size='sm' title={`Remove ${from} → ${to}`} onClick={() => removeTransition(from, to)}>✕</Button>
              : <Button size='sm' variant='subtle' title={`Also transition ${from} → ${to}`} onClick={() => addTransition(from, to)}>+ {from} → {to}</Button>}
          </div>

          {t && <>
            <div className='flex items-center gap-1'>
              <span title='Only leave once the clip has played this far: 1 is its end, 0.5 halfway'>
                <Toggle label='wait for clip end' checked={!!t.hasExitTime} onChange={c => setTransition(from, to, { hasExitTime: c })} className='text-ui-xs' />
              </span>
              {t.hasExitTime && (
                <NumberInput className={cn(tight, 'w-[52px]')} step='0.05' min='0' max='1' value={t.exitTime ?? 1}
                  title='How far through the clip, 0 to 1'
                  onChange={v => setTransition(from, to, { exitTime: clamp(v, 0, 1) })} />
              )}
            </div>
            {/* Per-edge cross-fade. Empty falls back to the animator-wide default, so a landing can snap
                while a gait change stays lazy. */}
            <label className='flex items-center gap-1 text-ui-xs' title='Cross-fade seconds for this transition. Leave empty to use the animator default.'>
              blend
              <OptionalNumberInput className={cn(tight, 'w-[52px]')} placeholder='0.3'
                value={t.blendTime}
                onChange={v => setTransition(from, to, { blendTime: v === undefined ? undefined : Math.max(0, v) })} />
              <span className='text-dim'>s {t.blendTime === undefined ? (intoFork(t) ? '(the way out’s)' : '(default)') : intoFork(t) ? '(when the way out sets none)' : ''}</span>
            </label>
            {intoGetUp(to) && (
              <p className={hintClass}>Into a Get Up state the skin blends from the body, over the rig’s get-up blend: this blend is not used.</p>
            )}
            {/* The blunt fix for a state pair that ping-pongs. A blend covers a change visually, but the
                machine can still change its mind mid-blend and re-arm from a pose that barely moved — which
                reads as a spasm. This stops it changing its mind at all for a while. */}
            <label className='flex items-center gap-1 text-ui-xs'
              title={'Seconds the machine must already have spent in the source state before this transition may '
                + 'fire. Use it when two states flip back and forth every frame. Unlike waiting for the clip end '
                + 'this is real seconds, so it works for a looping state with no natural end.'}>
              stay at least
              <OptionalNumberInput className={cn(tight, 'w-[52px]')} placeholder='0'
                value={t.minDwell}
                onChange={v => setTransition(from, to, { minDwell: v === undefined ? undefined : Math.max(0, v) })} />
              <span className='text-dim'>s {t.minDwell === undefined && '(off)'}</span>
            </label>
            {from === ANY_STATE && (
              <span title={'Fire even while already in the target state, restarting it from its start — a second '
                + 'hit replays the flinch. Off, a transition into the state the machine is in never fires.'}>
                <Toggle label='can restart itself' checked={!!t.canTransitionToSelf} className='text-ui-xs'
                  onChange={c => setTransition(from, to, { canTransitionToSelf: c || undefined })} />
              </span>
            )}
            <ConditionTree from={from} to={to} />
          </>}
        </div>
      ))}
    </div>
  )
}

// ---- Live preview ------------------------------------------------------------------------------------
// `simulate` runs the machine (checkTriggers each frame) instead of the raw clip, feeding the parameter
// drivers below and the graph's active-state highlight.
function PreviewSection() {
  const { target, sm, simulate, setSimulate } = useStateMachine()
  if (!target) return null
  // Simulate runs the working copy (see previewWorkingCopy), so all it needs is something to run.
  const hasMachine = sm.states.length > 0

  return (
    <Collapsable title='Preview' defaultOpen>
      <div className='p-2 flex flex-col gap-1'>
        <div className='flex items-center gap-2'>
          <Toggle label='simulate' checked={simulate} disabled={!hasMachine} onChange={setSimulate} />
          {simulate && hasMachine && <span className='text-highlight'>state: {target.animator.currentStateName ?? '—'}</span>}
        </div>
        {!hasMachine && <p className={hintClass}>Add a state to preview it.</p>}

        {sm.parameters.map((p, i) => (
          <div key={i} className='flex items-center gap-2 text-ui'>
            <span className='flex-1 truncate' title={p.name}>{p.name}</span>
            {p.type === 'float' && <input className={cn(input, 'w-[64px]')} type='number' step='0.1' defaultValue={Number(p.default)} onChange={e => target.animator.setFloat(p.name, parseFloat(e.target.value) || 0)} />}
            {p.type === 'bool' && <BoolDriver name={p.name} initial={!!p.default} onSet={(v) => target.animator.setBool(p.name, v)} />}
            {p.type === 'trigger' && <Button size='sm' variant='subtle' onClick={() => target.animator.setTrigger(p.name)}>fire</Button>}
            {p.type === 'variable' && <LinkedDriver name={p.name} animator={target.animator}
              isBool={p.variable?.varType === 'boolean'}
              source={p.variable ? `${p.variable.nodeRef}.${p.variable.varName}` : 'unbound'} />}
          </div>
        ))}
        {sm.parameters.length === 0 && <p className='text-ui-sm text-muted'>No parameters.</p>}
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
 * A LINKED parameter in the preview. Nothing moves in the editor, so a parameter linked to the character's
 * speed reads 0 forever and every state or layer gated on it is unreachable. This pins it to a hand-set
 * value (the animator's preview override) until cleared, when it follows its link again.
 */
function LinkedDriver({ name, animator, isBool, source }: {
  name: string; animator: import('cleo').Animator; isBool: boolean; source: string
}) {
  const [pinned, setPinned] = useState<number | boolean | undefined>(() => animator.getParamOverride(name))
  const pin = (v: number | boolean | null) => { animator.setParamOverride(name, v); setPinned(v ?? undefined) }
  return (
    <span className='flex items-center gap-1 min-w-0' title={`Linked to ${source}. Set a value to try it here; ↺ follows the link again.`}>
      {isBool
        ? <Toggle checked={!!pinned} onChange={c => pin(c)} />
        : <input className={cn(input, 'w-[64px]')} type='number' step='0.1' placeholder='0'
            value={typeof pinned === 'number' ? pinned : ''}
            onChange={e => pin(e.target.value === '' ? null : parseFloat(e.target.value) || 0)} />}
      {pinned !== undefined
        ? <Button size='sm' variant='ghost' title='Follow the link again' onClick={() => pin(null)}>↺</Button>
        : <span className='text-ui-xs text-dim truncate'>{source}</span>}
    </span>
  )
}

/**
 * A bool parameter driver. The live value lives on the animator, not in `sm`, and nothing re-renders on it,
 * so this holds its own state for the controlled Toggle.
 */
function BoolDriver({ name, initial, onSet }: { name: string; initial: boolean; onSet: (v: boolean) => void }) {
  const [v, setV] = useState(initial)
  return <Toggle checked={v} onChange={c => { setV(c); onSet(c) }} />
}

/**
 * Grouped dropdown of the values a Variable parameter can bind to: measured built-ins first, then node
 * variables by access group. The option key must include `source` — a built-in and a script field can
 * share a name and nodeRef.
 */
/** A Linked parameter's starting value: the built-in's own where it has no reactions (HasControl: true), else 0/off. */
function builtinDefault(b: AnimationVariableBinding | undefined): number | boolean {
  const none = b?.source === 'builtin' ? NODE_BUILTINS[b.varName]?.none : undefined
  if (none !== undefined) return none
  return b?.varType === 'boolean' ? false : 0
}

/**
 * A trigger's source: fired by a script (none), or by a counter the engine keeps, each time it rises — Each hit (the
 * character's reactions' hit count) fires the trigger on every hit it takes.
 */
function CounterPicker({ value, onPick }: { value?: AnimationVariableBinding; onPick: (b: AnimationVariableBinding | undefined) => void }) {
  const counters = Object.entries(NODE_BUILTINS).filter(([, d]) => d.counter).map(([name]) => name)
  const label: Record<string, string> = { hitCount: 'Each hit' }
  return (
    <Select className={cn(tight, 'w-[96px]')} value={value?.varName ?? ''}
      title='What fires this trigger: a script (by name), or each time a count the engine keeps rises — Each hit fires it on every hit the character takes (its reactions)'
      onChange={e => onPick(e.target.value ? { nodeRef: 'parent', varName: e.target.value, varType: 'number', source: 'builtin' } : undefined)}>
      <option value=''>(script)</option>
      {value?.varName && !counters.includes(value.varName) && <option value={value.varName}>{value.varName} (missing)</option>}
      {counters.map(c => <option key={c} value={c}>{label[c] ?? c}</option>)}
    </Select>
  )
}

/** The rig's own get-up clips (its reaction set's), what a Get Up state naming none plays. */
function rigGetUpClips(target: { node?: unknown } | null | undefined): { faceUp?: string; faceDown?: string } {
  const skin = (target?.node as { model?: { skin?: { reactionSets?: unknown } } } | undefined)?.model?.skin
  return pickReactionSet(parseReactionSets(skin?.reactionSets)).behaviours.getUp.clips ?? {}
}

/** A Ragdoll state's own rows: how it starts on a character on its feet, and the clip it plays without a body. */
function RagdollRows({ state, clips, onChange }: { state: AnimationState; clips: string[]; onChange: (patch: Partial<AnimationState>) => void }) {
  const start = state.ragdoll?.start ?? 'fall'
  return (
    <>
      <div className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted w-[42px] shrink-0'
          title='What entering this state does to a character on its feet. Entered when a hit has already knocked it down, it adds nothing: it only holds the body.'>Starts</span>
        <SegmentedControl<AnimationRagdollStart> size='sm' value={start}
          onChange={v => onChange({ ragdoll: { ...state.ragdoll, start: v } })}
          options={[
            { value: 'fall', label: <span className='inline-block w-3.5 h-3.5 align-[-2px]'><FallIcon /></span>, title: 'Fall: it falls the way it was moving, catching itself, protecting its head' },
            { value: 'trip', label: <span className='inline-block w-3.5 h-3.5 align-[-2px]'><TripIcon /></span>, title: 'Trip: its feet are taken from under it and it falls forward' },
            { value: 'limp', label: <span className='inline-block w-3.5 h-3.5 align-[-2px]'><KnockOutIcon /></span>, title: 'Limp: it drops out cold, no hands out, no head tucked (a knockout, a death)' },
          ]} />
      </div>
      <Select className={cn(tight, 'flex-1 min-w-0')} value={state.clipName}
        title='The pose under the body: none holds the pose it was entered with. Also what shows where no body can be made (no reactions on this backend).'
        onChange={e => onChange({ clipName: e.target.value })}>
        <option value=''>(holds the pose it is entered with)</option>
        {clips.map(c => <option key={c} value={c}>{c}</option>)}
      </Select>
      <p className={hintClass}>
        The graph stays here as long as it likes: the body never gets up by itself. Take it to a <b>Get Up</b> state on
        <b> CanGetUp</b> (a Linked reaction built-in), and in from <b>Any State</b> on <b>Ragdolled</b> to follow a hit’s fall.
      </p>
    </>
  )
}

/** A Get Up state's own rows: its clip for each side the body can lie on. */
function GetUpRows({ state, clips, rigClips, onChange }: {
  state: AnimationState; clips: string[]; rigClips: { faceUp?: string; faceDown?: string }; onChange: (patch: Partial<AnimationState>) => void
}) {
  const row = (side: 'faceUp' | 'faceDown', label: string, title: string) => (
    <div className='flex items-center gap-1'>
      <span className='text-ui-xs text-muted w-[42px] shrink-0' title={title}>{label}</span>
      <Select className={cn(tight, 'flex-1 min-w-0')} value={state.getUp?.[side] ?? ''}
        onChange={e => onChange({ getUp: { ...state.getUp, [side]: e.target.value || undefined } })}>
        <option value=''>{rigClips[side] ? `(the rig’s: ${rigClips[side]})` : '(the rig’s: none)'}</option>
        {clips.map(c => <option key={c} value={c}>{c}</option>)}
      </Select>
    </div>
  )
  return (
    <>
      {row('faceUp', 'On back', 'The clip it rises on lying on its back')}
      {row('faceDown', 'On front', 'The clip it rises on lying on its front')}
      <span title={'Play the clip from its first frame. Off, it joins the clip where the body in it starts to rise: a '
        + 'motion-capture get-up often lies still a second or more first, and the character would lie there as though '
        + 'nothing were happening.'}>
        <Toggle label='from first frame' checked={!!state.getUp?.fromFirstFrame} className='text-ui-xs'
          onChange={c => onChange({ getUp: { ...state.getUp, fromFirstFrame: c || undefined } })} />
      </span>
      <p className={hintClass}>
        Picked as it is entered, from where the body lies, and lined up with it; joined where the body in it starts to
        rise. Entered before the body lies still it waits on that frame. No root motion, no foot placement; the
        character is held until it leaves.
      </p>
    </>
  )
}

/** What a Ragdoll or Get Up state is missing to work: a clip to rise on, a way out, a way to rise. */
function ReactionStateLints({ state }: { state: AnimationState }) {
  const { sm, target } = useStateMachine()
  const out = sm.transitions.filter(t => t.from === state.name)
  const lints: string[] = []
  if (state.getUp) {
    const rig = rigGetUpClips(target)
    if (!state.getUp.faceUp && !state.getUp.faceDown && !rig.faceUp && !rig.faceDown) lints.push('No clip to rise on: pick one above, or the rig’s get-up clips in its Reactions tab.')
  }
  if (state.ragdoll && !out.some(t => sm.states.find(x => x.name === t.to)?.getUp)) lints.push('No way into a Get Up state: the body lies here until the graph leaves.')
  if (!out.length) lints.push('No way out of this state.')
  return <>{lints.map(l => <p key={l} className='text-ui-xs text-warning'>{l}</p>)}</>
}

/**
 * How the body takes hits while this state plays (AnimationState.reactions), merged with the layers' states: the
 * strictest React, every busy hand, the forces multiplied. Reactions run on Jolt: on another backend the rows say so.
 */
function ReactionEffectsRows({ value, onChange }: { value?: AnimationReactionEffects; onChange: (next: AnimationReactionEffects | undefined) => void }) {
  const { supported, backendName } = useReactionsSupported()
  const v = value ?? {}
  const set = (patch: Partial<AnimationReactionEffects>) => {
    const next: AnimationReactionEffects = { ...v, ...patch }
    if (!next.react || next.react === 'full') delete next.react
    if (!next.busyHands || next.busyHands === 'auto') delete next.busyHands
    if (next.force === undefined || next.force === 1) delete next.force
    if (next.shove === undefined || next.shove === 1) delete next.shove
    onChange(Object.keys(next).length ? next : undefined)
  }
  return (
    <>
      <SectionTitle title='Reactions' className='mt-1' doc='editor/animation#reaction-effects' />
      {!supported && (
        <p className='text-ui-xs text-warning'>Reactions run only on the Jolt physics backend; this project runs on {backendName}, so these do nothing.</p>
      )}
      <div className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted w-[42px] shrink-0' title='How the body takes hits, shoves and impacts while this state plays'>React</span>
        <SegmentedControl<'full' | 'flinch' | 'none'> size='sm' value={v.react ?? 'full'} onChange={react => set({ react })}
          options={[
            { value: 'full', label: 'Full', title: 'As the rig’s reaction set says: flinches, staggers, falls' },
            { value: 'flinch', label: 'Flinch', title: 'Flinches only: never staggered or knocked down' },
            { value: 'none', label: 'None', title: 'The body does not react. The hit still counts: its Hit event, and the hit parameters' },
          ]} />
      </div>
      <div className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted w-[42px] shrink-0' title='Hands that stay on what they hold (a weapon, a wheel) rather than reach for a wound'>Hands</span>
        <Select className={cn(tight, 'flex-1 min-w-0')} value={v.busyHands ?? 'auto'}
          onChange={e => set({ busyHands: e.target.value as AnimationReactionEffects['busyHands'] })}>
          <option value='auto' title='Both busy while a support-hand IK holds a weapon, else free'>Auto</option>
          <option value='both'>Both busy</option>
          <option value='right'>Right busy</option>
          <option value='left'>Left busy</option>
          <option value='none'>Both free</option>
        </Select>
      </div>
      <div className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted w-[42px] shrink-0' title='Hits land this many times as hard: a braced crouch 0.6, a weak spot 1.5'>Force ×</span>
        <OptionalNumberInput className={cn(tight, 'w-[56px]')} step='0.1' min='0' placeholder='1' value={v.force}
          onChange={force => set({ force: force === undefined ? undefined : clamp(force, 0, 10) })} />
        <span className='text-ui-xs text-muted w-[42px] shrink-0 ml-1' title='Shoves carry it this many times as far'>Shove ×</span>
        <OptionalNumberInput className={cn(tight, 'w-[56px]')} step='0.1' min='0' placeholder='1' value={v.shove}
          onChange={shove => set({ shove: shove === undefined ? undefined : clamp(shove, 0, 10) })} />
      </div>
    </>
  )
}

function VariablePicker({ vars, value, onPick }: {
  vars: AccessibleVariable[]
  value?: AnimationVariableBinding
  onPick: (b: AnimationVariableBinding | undefined) => void
}) {
  // A reaction built-in reads the character's reactions whatever node it names: one entry, keyed by its name alone.
  const key = (source: string, nodeRef: string, varName: string) =>
    `${source}|${source === 'builtin' && NODE_BUILTINS[varName]?.reactions ? 'reactions' : nodeRef}|${varName}`
  const current = value ? key(value.source ?? 'variable', value.nodeRef, value.varName) : ''
  const groups: Record<AccessibleVariable['group'], AccessibleVariable[]> = { 'Built-in': [], Self: [], Parent: [], Scene: [] }
  for (const v of vars) groups[v.group].push(v)
  return (
    <Select className={cn(tight, 'w-[160px]')} value={current}
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
    </Select>
  )
}
