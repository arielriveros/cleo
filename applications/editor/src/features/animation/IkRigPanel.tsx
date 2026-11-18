import { useEffect, useState } from 'react'
import { IK_DEFAULTS, FOOT_LOCK_CURVES } from 'cleo'
import type { IkRig, IkFootChain, Skin, FootLockCurve } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { jointLabel } from './skeleton'
import { Button, Select, cn, controlClass } from '@cleo/app-kit/ui'
import { guessFootPlacement } from '../../utils/footPlacementAuto'

// Foot-IK rig authoring: the Skeleton part's Foot Placement tab (rig/FootPlacementPanel), beside Skeleton while
// the bone tree stays up on the left. Bones are assigned by hand: select a joint (SELECT_JOINT, from the tree or
// the viewport) and click the role it fills; the ⤓ button offers a name-matched guess. Everything writes through
// commitIkRig, which lands on the SKELETON, so every character on it inherits it.

/** How each blend curve reads in the Curve picker. */
const CURVE_LABELS: Record<FootLockCurve, string> = { linear: 'Linear', smooth: 'Smooth (eases in and out)' }

/** The tuning inputs stay raw (uncontrolled, commit on blur, blank = default), in the library's control chrome. */
const input = cn(controlClass, 'px-1 py-0.5')

/** The roles one leg has, in the order they run down it. `toe` is optional — not every rig has one. */
type Role = 'thigh' | 'shin' | 'foot' | 'toe'
const LEG_ROLES: { key: Role; label: string; hint: string }[] = [
  { key: 'thigh', label: 'Thigh', hint: 'Upper leg — the joint at the hip. The IK chain starts here.' },
  { key: 'shin', label: 'Shin', hint: 'Lower leg — the knee joint. This is the one that bends.' },
  { key: 'foot', label: 'Foot', hint: 'The ankle. This is what gets placed on the ground.' },
  { key: 'toe', label: 'Toe', hint: 'Ball of the foot. Optional — leave empty if the skeleton has no toe bone.' },
]

const emptyRig = (): IkRig => ({ feet: [] })

export default function IkRigPanel({ skin, selectedJoint }: { skin: Skin; selectedJoint: number | null }) {
  const { commitIkRig, currentIkRig, eventEmitter } = useCleoEngine()
  const [rig, setRig] = useState<IkRig | null>(null)
  /** What the last guess matched and skipped. Cleared on any manual edit. */
  const [report, setReport] = useState<string | null>(null)
  const [, force] = useState(0)

  // Read the live rig once per model, then own it locally; every edit round-trips through commitIkRig.
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
   * Fill both legs from the bone names, where the rig uses recognizable ones. Reports what it matched and
   * skipped, and refuses to write a rig the skeleton cannot support.
   */
  const autoFill = () => {
    const { rig: guessed, notes } = guessFootPlacement(skin, current, n => nameOfNode(n).text)
    if (!guessed) {
      setReport(`Could not identify a leg from the bone names. ${notes.join('; ')}. Assign them by hand.`)
      return
    }
    write(guessed)
    const named = (n: number | undefined) => n === undefined ? '—' : nameOfNode(n).text
    setReport(
      `Matched ${guessed.feet.length} leg${guessed.feet.length > 1 ? 's' : ''}, hips = ${named(guessed.hips)}.`
      + notes.map(m => ` Skipped: ${m}.`).join(''))
  }

  /**
   * A tuning number. Must commit on BLUR or Enter, never per keystroke: `write` reaches `updateModel`, and
   * the model library persists itself wholesale (vertex data and base64 textures for every model).
   */
  const num = (label: string, key: keyof IkRig, hint: string, step = 0.05) => {
    const commit = (raw: string) => {
      const v = parseFloat(raw)
      write({ ...current, [key]: Number.isFinite(v) && v >= 0 ? v : undefined })
    }
    return (
      <label className='flex items-center gap-1 text-ui-xs' title={hint}>
        <span className='w-[74px] shrink-0 text-muted'>{label}</span>
        <input
          // Uncontrolled, so `key` on the committed value is what remounts the input when the rig is
          // replaced from elsewhere (Clear, auto-fill).
          key={`${key}:${(current[key] as number | undefined) ?? ''}`}
          className={cn(input, 'w-[56px]')} type='number' step={step} min='0'
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
    <div>
      <div className='flex flex-col gap-2 p-2'
        title='Select a bone, then click the role it fills. Runs in Play only — the editor has no physics to stand on.'>
        <div className='flex items-center gap-1'>
          <Button size='sm' variant='subtle' onClick={autoFill}
            title='Fill both legs from the bone names, where they are recognizable. Whatever it cannot identify is left blank for you to assign.'>
            ⤓ Guess from bone names
          </Button>
          {rig && (
            <Button size='sm' variant='danger' className='ml-auto' title='Remove foot placement from this skeleton' onClick={() => write(null)}>
              Clear
            </Button>
          )}
        </div>

        {/* What the guess did. Shown because a rig that reads perfectly in these rows can still be wrong in
            the skeleton — bones from the wrong tier of a control rig, or three bones that are not a connected
            leg. Saying so here is the difference between a wrong guess you can see and one you only meet in
            Play as a thrashing character. */}
        {report && <p className='text-ui-xs text-muted'>{report}</p>}

        {/* Hips: optional, and the panel says so — without it the legs still solve, they just cannot be
            helped by lowering the pelvis when one is out of reach. */}
        <div className='flex items-center gap-1'>
          <span className='w-[52px] shrink-0 text-ui-xs text-muted' title='Pelvis. Lowered when a foot cannot reach the ground.'>Hips</span>
          <span
            className={`min-w-0 flex-1 truncate text-ui-sm ${hips.missing ? 'text-danger-fg' : current.hips === undefined ? 'text-dim' : 'cursor-pointer text-muted hover:text-fg'}`}
            onClick={() => selectNode(current.hips)}>
            {hips.text}
          </span>
          <Button size='sm' variant='subtle' disabled={!assignable}
            title={assignable ? 'Assign the selected bone as the hips' : 'Select a bone first'}
            onClick={() => write({ ...current, hips: selectedNode! })}>set</Button>
          {current.hips !== undefined && (
            <Button variant='remove' size='sm' title='Unassign' onClick={() => write({ ...current, hips: undefined })}>✕</Button>
          )}
        </div>

        {current.feet.map((leg, i) => (
          <div key={i} className='flex flex-col gap-1 rounded border border-control p-1.5'>
            <div className='flex items-center gap-1'>
              <span className='flex-1 text-ui-xs uppercase tracking-wide text-highlight'>Leg {i + 1}</span>
              <Button variant='remove' size='sm' title='Remove this leg' onClick={() => removeLeg(i)}>✕</Button>
            </div>
            {LEG_ROLES.map(role => {
              const value = leg[role.key]
              const n = nameOfNode(value !== undefined && value >= 0 ? value : undefined)
              return (
                <div key={role.key} className='flex items-center gap-1' title={role.hint}>
                  <span className='w-[52px] shrink-0 text-ui-xs text-muted'>{role.label}</span>
                  <span
                    className={`min-w-0 flex-1 truncate text-ui-sm ${n.missing ? 'text-danger-fg' : n.text === '—' ? 'text-dim' : 'cursor-pointer text-muted hover:text-fg'}`}
                    onClick={() => selectNode(value !== undefined && value >= 0 ? value : undefined)}>
                    {n.text}
                  </span>
                  <Button size='sm' variant='subtle' disabled={!assignable}
                    title={assignable ? `Assign the selected bone as ${role.label}` : 'Select a bone first'}
                    onClick={() => setLeg(i, { [role.key]: selectedNode! } as Partial<IkFootChain>)}>set</Button>
                </div>
              )
            })}
            {(leg.thigh < 0 || leg.shin < 0 || leg.foot < 0) && (
              <p className='text-ui-xs text-warning'>Thigh, shin and foot are all needed — this leg is skipped until then.</p>
            )}
          </div>
        ))}

        <Button size='sm' variant='subtle' className='self-start' onClick={addLeg}>+ Leg</Button>

        {current.feet.length > 0 && (
          <div className='mt-1 flex flex-col gap-1 border-t border-control pt-2'>
            {num('Foot height', 'footHeight', 'How far the ankle sits above the sole. Too small and the foot sinks into the ground; too large and it hovers.')}
            {num('Trace up', 'traceUp', 'How far above the animated foot the ground ray starts. Raise it if feet ignore ground they are standing inside.')}
            {num('Trace down', 'traceDown', 'How far below the foot the ray reaches. Past this the foot counts as airborne and IK fades out.')}
            {num('Swing release', 'swingRelease', 'How far the animation must lift a foot above the other one before IK lets go of it, so a stride is not dragged back down to the ground. Measured in the clip, so a slope or a step under the feet never counts as a stride. Lower it if lifted feet are still pulled down mid-step; raise it if a foot the clip holds a little off the ground does not plant. 0 turns the release off.')}
            {num('Max hip drop', 'maxHipDrop', 'Furthest the pelvis may be lowered when a foot cannot reach. Stops a hole in the ground folding the character up.')}
            {num('Max slope', 'maxSlopeDeg', 'Steepest surface the foot will roll to match. Past it the foot keeps its animated angle, because matching starts to look like a broken ankle.', 1)}
            {num('Smoothing', 'smoothing', 'Seconds for a foot to fade in or out as it finds and loses ground. Too low and a foot snaps at the lip of a ledge.')}
          </div>
        )}

        {current.feet.length > 0 && (
          <div className='mt-1 flex flex-col gap-1 border-t border-control pt-2'>
            <span className='text-ui-xs text-muted'>Foot locking</span>
            {num('Lock', 'footLock', 'How firmly a foot the animation has planted keeps its spot and heading on the ground while the body moves or turns over it, 0 to 1. Stops a character that turns while it walks from gliding as if on ice. 0 turns locking off.')}
            {num('Plant speed', 'lockSpeed', 'A foot plants when the clip rises or lowers it slower than this (metres a second), and moves it over the ground slower than this plus 1.5 times the body’s own speed: a swing crosses the ground at about twice the body’s speed. The body turning is not counted, so a foot the turn would sweep round still plants.')}
            {num('Plant height', 'lockHeight', 'A foot plants only this close to the lowest foot. Lower it if a foot stays stuck as the heel lifts; raise it if feet never lock.', 0.01)}
            {num('Catch below', 'lockCatchSpeed', 'While the pose still blends in a clip with no foot-lock windows (setting off out of Idle), a foot sliding over the ground faster than this (metres a second) is not caught by the lock: it plants once it has slowed. Catching it stops it dead and leaves the leg stretched after it until the lock lets go. Blank or 0 catches any.', 0.1)}
            {num('Let go at', 'lockDistance', 'How far the body may leave a planted foot behind before it lets go and steps. A body that jumps further than this in one frame (a teleport) lets go at once. The heading is held up to 40 degrees, and turns with the clip past that.')}
          </div>
        )}

        {current.feet.length > 0 && (
          <div className='mt-1 flex flex-col gap-1 border-t border-control pt-2'>
            <span className='text-ui-xs text-muted'
              title='How a lock comes in and goes out. A foot that plants mid-slide is eased to a stop instead of stopping dead, and a lifted foot is eased back to the animation.'>
              Blending
            </span>
            {num('In', 'lockBlendIn', 'Seconds a planting foot takes to settle into its lock. While it does, the foot still slides a little, slower each frame. 0 locks it the frame it plants.', 0.01)}
            {num('Out', 'lockRelease', 'Seconds a lifted foot takes to blend from where it was planted back to the animation.', 0.01)}
            <label className='flex items-center gap-1 text-ui-xs'
              title='The shape of both blends. Smooth starts and ends gently, so neither the plant nor the release shows as a kink in the foot’s path; Linear moves at one rate throughout.'>
              <span className='w-[74px] shrink-0 text-muted'>Curve</span>
              <Select className='flex-1' value={current.lockBlendCurve ?? IK_DEFAULTS.lockBlendCurve}
                onChange={e => write({ ...current, lockBlendCurve: e.target.value === IK_DEFAULTS.lockBlendCurve ? undefined : e.target.value as FootLockCurve })}>
                {FOOT_LOCK_CURVES.map(c => <option key={c} value={c}>{CURVE_LABELS[c]}</option>)}
              </Select>
            </label>
          </div>
        )}
      </div>
    </div>
  )
}
