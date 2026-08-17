import { useEffect, useState } from 'react'
import {
  IK_DEFAULTS, humanoidRigOf, skeletonTopology, isAncestorJoint, nearestCommonAncestor, validateIkRig,
} from 'cleo'
import type { IkRig, IkFootChain, Skin } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'
import { jointLabel } from './skeleton'

// Foot-IK rig authoring, under the skeleton tree.
//
// Bones are assigned BY HAND: select a joint (in the tree or the viewport — both drive the same SELECT_JOINT
// event) and click the role it fills. That is deliberate rather than a limitation. A skeleton is not
// obliged to be humanoid, and a rig whose bones the engine guessed is a rig nobody has checked; the ⤓ button
// offers the guess for the rigs where it works, and nothing depends on it.
//
// Everything here writes through commitIkRig, which lands on the MODEL ASSET — so a character's legs are
// assigned once and every placement of it inherits them.

const input = 'bg-control text-white border border-control-hover rounded px-1 py-0.5 text-xs'
const ghost = 'px-1.5 py-0.5 rounded border border-control-hover hover:bg-control text-xs'
const danger = 'px-1.5 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white text-xs'

/** The roles one leg has, in the order they run down it. `toe` is optional — not every rig has one. */
type Role = 'thigh' | 'shin' | 'foot' | 'toe'
const LEG_ROLES: { key: Role; label: string; hint: string }[] = [
  { key: 'thigh', label: 'Thigh', hint: 'Upper leg — the joint at the hip. The IK chain starts here.' },
  { key: 'shin', label: 'Shin', hint: 'Lower leg — the knee joint. This is the one that bends.' },
  { key: 'foot', label: 'Foot', hint: 'The ankle. This is what gets placed on the ground.' },
  { key: 'toe', label: 'Toe', hint: 'Ball of the foot. Optional — leave empty if the rig has no toe bone.' },
]

/** The humanoid slots each role maps to, for the auto-fill guess. Index 0 is the left leg, 1 the right. */
const SLOTS: Record<Role, [string, string]> = {
  thigh: ['upLeg.L', 'upLeg.R'],
  shin: ['leg.L', 'leg.R'],
  foot: ['foot.L', 'foot.R'],
  toe: ['toe.L', 'toe.R'],
}

const emptyRig = (): IkRig => ({ feet: [] })

export default function IkRigPanel({ skin, selectedJoint }: { skin: Skin; selectedJoint: number | null }) {
  const { commitIkRig, currentIkRig, eventEmitter } = useCleoEngine()
  const [rig, setRig] = useState<IkRig | null>(null)
  /** What the last guess matched and skipped. Cleared on any manual edit, so it never describes a stale rig. */
  const [report, setReport] = useState<string | null>(null)
  const [, force] = useState(0)

  // Read the live rig once per model, then own it locally — every edit round-trips through commitIkRig, so
  // there is no second source of truth to drift.
  useEffect(() => { setRig(currentIkRig()) }, [skin])
  useEffect(() => {
    const refresh = () => force(x => x + 1)
    eventEmitter.on('ANIM_IK_CHANGED', refresh)
    return () => { eventEmitter.off('ANIM_IK_CHANGED', refresh) }
  }, [eventEmitter])

  const write = (next: IkRig | null) => {
    setRig(next)
    setReport(null)
    commitIkRig(next && (next.feet.length > 0 || next.hips !== undefined) ? next : null)
  }

  /** Node index of a joint, since a rig stores NODE indices while the tree selects by JOINT index. */
  const nodeOf = (jointIndex: number | null): number | null =>
    jointIndex === null || jointIndex >= skin.joints.length ? null : skin.joints[jointIndex].nodeIndex

  /** Label for a node index the rig refers to. Flags one that is no longer in the skeleton. */
  const nameOfNode = (nodeIndex: number | undefined): { text: string; missing: boolean } => {
    if (nodeIndex === undefined) return { text: '—', missing: false }
    const jointIndex = skin.joints.findIndex(j => j.nodeIndex === nodeIndex)
    if (jointIndex < 0) return { text: `node ${nodeIndex} — missing`, missing: true }
    return { text: jointLabel(skin, jointIndex), missing: false }
  }

  const selectNode = (nodeIndex: number | undefined) => {
    if (nodeIndex === undefined) return
    const jointIndex = skin.joints.findIndex(j => j.nodeIndex === nodeIndex)
    if (jointIndex >= 0) eventEmitter.emit('SELECT_JOINT', jointIndex)
  }

  const current = rig ?? emptyRig()
  const selectedNode = nodeOf(selectedJoint)

  const setLeg = (i: number, patch: Partial<IkFootChain>) => {
    const feet = current.feet.map((f, idx) => idx === i ? { ...f, ...patch } : f)
    write({ ...current, feet })
  }

  const addLeg = () => write({ ...current, feet: [...current.feet, { thigh: -1, shin: -1, foot: -1 }] })
  const removeLeg = (i: number) => write({ ...current, feet: current.feet.filter((_, idx) => idx !== i) })

  /**
   * Fill both legs from the bone names, where the rig uses recognizable ones.
   *
   * A convenience over the manual assignment, never a replacement for it. It reports what it did and refuses
   * to write a rig the skeleton cannot support — writing one silently is what once left a character thrashing
   * with a rig that looked perfectly reasonable in this panel.
   */
  const autoFill = () => {
    // The engine's own matcher, not a second copy of it: `humanoidRigOf` is public precisely so a private
    // re-implementation cannot drift away from what retargeting believes about the same skeleton.
    const bySlot = humanoidRigOf(skin)
    const topo = skeletonTopology(skin)

    const feet: IkFootChain[] = []
    const notes: string[] = []
    for (const [side, label] of [[0, 'left'], [1, 'right']] as const) {
      const thigh = bySlot.get(SLOTS.thigh[side])
      const shin = bySlot.get(SLOTS.shin[side])
      const foot = bySlot.get(SLOTS.foot[side])
      const missing = [['thigh', thigh], ['shin', shin], ['foot', foot]]
        .filter(([, v]) => v === undefined).map(([k]) => k)
      if (missing.length) { notes.push(`no ${label} ${missing.join('/')} found by name`); continue }
      const toe = bySlot.get(SLOTS.toe[side])
      feet.push(toe !== undefined ? { thigh: thigh!, shin: shin!, foot: foot!, toe } : { thigh: thigh!, shin: shin!, foot: foot! })
    }

    if (feet.length === 0) {
      setReport(`Could not identify a leg from the bone names. ${notes.join('; ')}. Assign them by hand.`)
      return
    }

    // The pelvis is the nearest common ancestor of the two thighs — by construction, on every rig. Asking
    // the hierarchy rather than the name matters: `root` and `cog` are both synonyms for `hips`, and a
    // root-motion bone is usually joint 0, so a name lookup hands back the bone at the character's FEET.
    // Lowering that sinks the whole character instead of dropping its pelvis.
    const thighJoints = feet.map(f => topo.jointOfNode.get(f.thigh) ?? -1).filter(j => j >= 0)
    const ncaJoint = thighJoints.length > 1 ? nearestCommonAncestor(topo, thighJoints) : -1
    const hips = ncaJoint >= 0 ? skin.joints[ncaJoint].nodeIndex : bySlot.get('hips') ?? current.hips

    const next: IkRig = { ...current, hips, feet }
    const check = validateIkRig(next, topo, isAncestorJoint, n => nameOfNode(n).text)
    if (check.feet.length === 0) {
      setReport(`The bones matched by name do not form a leg: ${check.problems.map(p => p.message).join('; ')}.`)
      return
    }

    write({ ...next, feet: check.feet, hips: check.hips })
    const named = (n: number | undefined) => n === undefined ? '—' : nameOfNode(n).text
    setReport(
      `Matched ${check.feet.length} leg${check.feet.length > 1 ? 's' : ''}, hips = ${named(check.hips)}.`
      + [...notes, ...check.problems.map(p => p.message)].map(m => ` Skipped: ${m}.`).join(''))
  }

  /**
   * A tuning number, committed on BLUR or Enter rather than on every keystroke.
   *
   * Not a nicety: `write` goes through `commitIkRig` → `updateModel`, and the model library persists itself
   * wholesale — vertex data and base64 textures for every model in the project. Typing "0.125" into an
   * uncontrolled `onChange` would queue five full-library writes to IndexedDB.
   */
  const num = (label: string, key: keyof IkRig, hint: string, step = 0.05) => {
    const commit = (raw: string) => {
      const v = parseFloat(raw)
      write({ ...current, [key]: Number.isFinite(v) && v >= 0 ? v : undefined })
    }
    return (
      <label className='flex items-center gap-1 text-[10px]' title={hint}>
        <span className='w-[74px] shrink-0 text-gray-400'>{label}</span>
        <input
          // Uncontrolled + keyed on the committed value: `key` remounts the input when the rig is replaced
          // from elsewhere (Clear, auto-fill), which a defaultValue alone would not pick up.
          key={`${key}:${(current[key] as number | undefined) ?? ''}`}
          className={input + ' w-[56px]'} type='number' step={step} min='0'
          defaultValue={(current[key] as number | undefined) ?? ''}
          placeholder={String((IK_DEFAULTS as any)[key])}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        <span className='text-dim'>{(current[key] as number | undefined) === undefined ? '(default)' : ''}</span>
      </label>
    )
  }

  const assignable = selectedNode !== null
  const hips = nameOfNode(current.hips)

  return (
    <Collapsable title='Foot IK' badge={current.feet.length || undefined}>
      <div className='flex flex-col gap-2 p-2'>
        <p className='text-[10px] text-gray-500'>
          Select a bone, then click the role it fills. Runs in Play only — the editor has no physics to stand on.
        </p>

        <div className='flex items-center gap-1'>
          <button className={ghost} onClick={autoFill}
            title='Fill both legs from the bone names, where they are recognizable. Whatever it cannot identify is left blank for you to assign.'>
            ⤓ Guess from bone names
          </button>
          {rig && (
            <button className={danger + ' ml-auto'} title='Remove the whole rig' onClick={() => write(null)}>
              Clear
            </button>
          )}
        </div>

        {/* What the guess did. Shown because a rig that reads perfectly in these rows can still be wrong in
            the skeleton — bones from the wrong tier of a control rig, or three bones that are not a connected
            leg. Saying so here is the difference between a wrong guess you can see and one you only meet in
            Play as a thrashing character. */}
        {report && <p className='text-[10px] text-muted'>{report}</p>}

        {/* Hips: optional, and the panel says so — without it the legs still solve, they just cannot be
            helped by lowering the pelvis when one is out of reach. */}
        <div className='flex items-center gap-1'>
          <span className='w-[52px] shrink-0 text-[10px] text-gray-400' title='Pelvis. Lowered when a foot cannot reach the ground.'>Hips</span>
          <span
            className={`min-w-0 flex-1 truncate text-[11px] ${hips.missing ? 'text-red-400' : current.hips === undefined ? 'text-dim' : 'cursor-pointer text-muted hover:text-white'}`}
            onClick={() => selectNode(current.hips)}>
            {hips.text}
          </span>
          <button className={ghost} disabled={!assignable}
            title={assignable ? 'Assign the selected bone as the hips' : 'Select a bone first'}
            onClick={() => write({ ...current, hips: selectedNode! })}>set</button>
          {current.hips !== undefined && (
            <button className={ghost} title='Unassign' onClick={() => write({ ...current, hips: undefined })}>✕</button>
          )}
        </div>

        {current.feet.map((leg, i) => (
          <div key={i} className='flex flex-col gap-1 rounded border border-control p-1.5'>
            <div className='flex items-center gap-1'>
              <span className='flex-1 text-[10px] uppercase tracking-wide text-highlight'>Leg {i + 1}</span>
              <button className={danger} title='Remove this leg' onClick={() => removeLeg(i)}>✕</button>
            </div>
            {LEG_ROLES.map(role => {
              const value = leg[role.key]
              const n = nameOfNode(value !== undefined && value >= 0 ? value : undefined)
              return (
                <div key={role.key} className='flex items-center gap-1' title={role.hint}>
                  <span className='w-[52px] shrink-0 text-[10px] text-gray-400'>{role.label}</span>
                  <span
                    className={`min-w-0 flex-1 truncate text-[11px] ${n.missing ? 'text-red-400' : n.text === '—' ? 'text-dim' : 'cursor-pointer text-muted hover:text-white'}`}
                    onClick={() => selectNode(value !== undefined && value >= 0 ? value : undefined)}>
                    {n.text}
                  </span>
                  <button className={ghost} disabled={!assignable}
                    title={assignable ? `Assign the selected bone as ${role.label}` : 'Select a bone first'}
                    onClick={() => setLeg(i, { [role.key]: selectedNode! } as Partial<IkFootChain>)}>set</button>
                </div>
              )
            })}
            {(leg.thigh < 0 || leg.shin < 0 || leg.foot < 0) && (
              <p className='text-[10px] text-warning'>Thigh, shin and foot are all needed — this leg is skipped until then.</p>
            )}
          </div>
        ))}

        <button className={ghost + ' self-start'} onClick={addLeg}>+ Leg</button>

        {current.feet.length > 0 && (
          <div className='mt-1 flex flex-col gap-1 border-t border-control pt-2'>
            {num('Foot height', 'footHeight', 'How far the ankle sits above the sole. Too small and the foot sinks into the ground; too large and it hovers.')}
            {num('Trace up', 'traceUp', 'How far above the animated foot the ground ray starts. Raise it if feet ignore ground they are standing inside.')}
            {num('Trace down', 'traceDown', 'How far below the foot the ray reaches. Past this the foot counts as airborne and IK fades out.')}
            {num('Swing release', 'swingRelease', 'How far a foot must lift above the other one before IK lets go of it, so a stride is not dragged back down to the ground. Raise it if planted feet float over uneven ground; lower it if lifted feet are still pulled down mid-step. 0 turns the release off.')}
            {num('Max hip drop', 'maxHipDrop', 'Furthest the pelvis may be lowered when a foot cannot reach. Stops a hole in the ground folding the character up.')}
            {num('Max slope', 'maxSlopeDeg', 'Steepest surface the foot will roll to match. Past it the foot keeps its animated angle, because matching starts to look like a broken ankle.', 1)}
            {num('Smoothing', 'smoothing', 'Seconds for a foot to fade in or out as it finds and loses ground. Too low and a foot snaps at the lip of a ledge.')}
          </div>
        )}
      </div>
    </Collapsable>
  )
}
