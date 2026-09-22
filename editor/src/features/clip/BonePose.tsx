import { useEffect, useState } from 'react'
import { mat4, quat, vec3 } from 'gl-matrix'
import { eulerFromQuatDeg } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useClip } from './ClipContext'
import { getAnimationTarget, jointLabel } from '../animation/skeleton'
import { withKey, withoutKey, channelOf, keyIndexAt, type TrackPath } from '../../utils/clipTracks'
import { promptDialog } from '../dialogs/dialogStore'
import { cryptoRandomId } from '../../utils/ids'
import Collapsable from '../../components/Collapsable'
import type { StoredPoseBone } from '../../utils/animationAssets'

// Posing one bone and writing it into the clip.
//
// The bone on screen is posed by `Animator.setBoneLocalOverride`, not by editing the clip: `playAnimation`
// re-transcodes every channel into fresh `Bone` objects, which is far too much work to do on each keystroke
// — and, more importantly, an override lets a bone be held still while the clip keeps playing on every
// OTHER bone, which is how you judge an arm pose against the walk cycle it is going into.
//
// So there are two distinct states, and the UI says which one you are in: a bone is either POSED (pinned,
// not yet in the clip) or not. "Key" commits the pose to the clip at the playhead and releases the pin.

const PATHS: TrackPath[] = ['translation', 'rotation', 'scale']

/** A local matrix split into the numbers a person edits: metres, degrees, and a scale factor. */
type Trs = { t: [number, number, number]; r: [number, number, number]; s: [number, number, number] }

function decompose(m: mat4): Trs {
  const t = mat4.getTranslation(vec3.create(), m)
  const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), m))
  const s = mat4.getScaling(vec3.create(), m)
  const e = eulerFromQuatDeg(vec3.create(), q)
  return { t: [t[0], t[1], t[2]], r: [e[0], e[1], e[2]], s: [s[0], s[1], s[2]] }
}

function compose(trs: Trs): mat4 {
  const q = quat.fromEuler(quat.create(), trs.r[0], trs.r[1], trs.r[2])
  return mat4.fromRotationTranslationScale(mat4.create(), q, trs.t as any, trs.s as any)
}

/** The raw channel values for a path, straight off a local matrix. What a keyframe actually stores. */
function channelValues(m: mat4, path: TrackPath): number[] {
  if (path === 'rotation') {
    const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), m))
    return [q[0], q[1], q[2], q[3]]
  }
  const v = path === 'translation' ? mat4.getTranslation(vec3.create(), m) : mat4.getScaling(vec3.create(), m)
  return [v[0], v[1], v[2]]
}

const EPS = 1e-5
const nearlyEqual = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < EPS)

export default function BonePose() {
  const { editorScene, skeletonTargetId, eventEmitter, rigs, updateRig } = useCleoEngine()
  const { asset, clip, clipName, patchClip } = useClip()

  const [jointIndex, setJointIndex] = useState<number>(-1)
  const [time, setTime] = useState(0)
  const [, force] = useState(0)

  const target = getAnimationTarget(editorScene, skeletonTargetId)

  useEffect(() => {
    const onJoint = (i: number) => setJointIndex(typeof i === 'number' ? i : -1)
    eventEmitter.on('SELECT_JOINT', onJoint)
    return () => { eventEmitter.off('SELECT_JOINT', onJoint) }
  }, [eventEmitter])

  // Follow the playhead: the numbers below describe the bone AT A MOMENT, so they have to be re-read as
  // the timeline moves or they silently describe a frame the user has already scrubbed away from.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const t = getAnimationTarget(editorScene, skeletonTargetId)
      if (t && Math.abs(t.animator.currentTime - time) > 1e-4) { setTime(t.animator.currentTime); force(x => x + 1) }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [editorScene, skeletonTargetId, time])

  // Release every pin when the tab or the character goes away. A pin outliving its editor would leave the
  // character stuck in a pose with nothing on screen explaining why.
  useEffect(() => () => { getAnimationTarget(editorScene, skeletonTargetId)?.animator.clearBoneLocalOverrides() },
    [editorScene, skeletonTargetId])

  const skin = target?.skin
  const joint = skin && jointIndex >= 0 ? skin.joints[jointIndex] : undefined
  const nodeIndex = joint?.nodeIndex

  // Read fresh on every render rather than memoised. The value changes for reasons no dependency array
  // can see — a pin written by the field below, the playhead moving, the clip being re-resolved after an
  // edit — and a memo keyed on any of those would show the artist a number the character is not in.
  // Both calls are a matrix clone; there is nothing here worth caching.
  const local = target && nodeIndex !== undefined ? target.animator.boneLocalTransform(nodeIndex) : null
  const rest = target && nodeIndex !== undefined ? target.animator.boneRestTransform(nodeIndex) : null

  if (!asset || !clip || !target || !skin) return null
  if (nodeIndex === undefined || !local) {
    return (
      <Collapsable title='Bone'>
        <div className='text-gray-400'>Pick a bone in the Skeleton panel or in the viewport to pose it.</div>
      </Collapsable>
    )
  }

  const animator = target.animator
  const posed = !!animator.boneLocalOverride(nodeIndex)
  const trs = decompose(local)
  const label = jointLabel(skin, jointIndex)

  /** Pin the bone to an edited transform. Live — the character moves as the number changes. */
  const setTrs = (next: Trs) => {
    animator.setBoneLocalOverride(nodeIndex, compose(next))
    force(x => x + 1)
  }
  const release = () => { animator.setBoneLocalOverride(nodeIndex, null); force(x => x + 1) }

  /**
   * Commit the posed bone into the clip at the playhead, then release the pin.
   *
   * Only the paths that actually changed are written. Keying all three would give a bone that was only
   * rotated a translation and scale curve as well — which then survives into every character the clip is
   * retargeted onto, except that `retargetAnimation` drops non-hips translation and all scale, so the
   * result would differ between the preview and everyone else.
   */
  const keyIt = () => {
    if (!clipName) return
    let next = clip
    for (const path of PATHS) {
      const value = channelValues(local, path)
      const restValue = rest ? channelValues(rest, path) : undefined
      const existing = channelOf(clip, nodeIndex, path)
      // A path the clip does not drive is only worth adding if the pose actually differs from rest.
      if (existing < 0 && restValue && nearlyEqual(value, restValue)) continue
      next = withKey(next, nodeIndex, path, time, value, restValue)
    }
    if (next !== clip) patchClip(clipName, next, 'Key bone')
    release()
  }

  /** Drop the key at the playhead on one path, if there is one there. */
  const deleteKeyOn = (path: TrackPath) => {
    if (!clipName) return
    const channel = channelOf(clip, nodeIndex, path)
    if (channel < 0) return
    const sampler = clip.samplers[clip.channels[channel].samplerIndex]
    const index = keyIndexAt(sampler.input, time)
    if (index < 0) return
    const next = withoutKey(clip, nodeIndex, path, index)
    if (next !== clip) patchClip(clipName, next, 'Delete key')
  }

  /**
   * Save every currently pinned bone as a named pose on the clip's SOURCE rig.
   *
   * Stored as a delta from each bone's rest, not an absolute local — an absolute would pin the bone and be
   * useless across clips, while a delta rides on top of whatever a clip is already doing. That is what
   * makes one "Torch grip" work on thirty different locomotion clips.
   *
   * On the rig rather than the clip, so editing it once updates every clip that references it.
   */
  const captureAsPose = async () => {
    const rig = asset.rigId ? rigs.find(r => r.id === asset.rigId) : undefined
    if (!rig) return
    const bones: StoredPoseBone[] = []
    for (const j of skin.joints) {
      const override = animator.boneLocalOverride(j.nodeIndex)
      if (!override) continue
      const restM = animator.boneRestTransform(j.nodeIndex) ?? mat4.create()
      // delta = local . rest^-1, in the PARENT frame — the same form `applyPoseOffset` re-applies.
      const restRot = quat.normalize(quat.create(), mat4.getRotation(quat.create(), restM))
      const rot = quat.normalize(quat.create(), mat4.getRotation(quat.create(), override))
      const delta = quat.normalize(quat.create(), quat.multiply(quat.create(), rot, quat.invert(quat.create(), restRot)))
      const dt = vec3.subtract(vec3.create(),
        mat4.getTranslation(vec3.create(), override), mat4.getTranslation(vec3.create(), restM))
      const name = skin.nodeNames?.get(j.nodeIndex)
      if (!name) continue // a pose is stored BY NAME; a nameless bone cannot be replayed on another rig
      const entry: StoredPoseBone = { name }
      if (Math.abs(quat.getAxisAngle(vec3.create(), delta)) > 1e-4) entry.rotation = [delta[0], delta[1], delta[2], delta[3]]
      if (vec3.length(dt) > 1e-5) entry.translation = [dt[0], dt[1], dt[2]]
      if (entry.rotation || entry.translation) bones.push(entry)
    }
    if (!bones.length) return

    const name = await promptDialog({
      title: 'Save as a shared pose',
      message: `${bones.length} posed bone${bones.length === 1 ? '' : 's'} will be stored on the rig "${rig.name}". Any clip can then reference it, and editing the pose updates all of them.`,
      defaultValue: 'Torch grip',
      validate: v => (v.trim() ? null : 'Give the pose a name.'),
    })
    if (!name?.trim()) return
    updateRig(rig.id, { ...rig, poses: [...(rig.poses ?? []), { id: cryptoRandomId(), name: name.trim(), bones }] })
    release()
  }

  const posedCount = skin.joints.filter(j => !!animator.boneLocalOverride(j.nodeIndex)).length
  const num = 'w-full bg-control text-white border border-control-hover rounded px-1 tabular-nums'
  const btn = 'px-2 py-0.5 rounded bg-control hover:bg-control-hover border border-control-hover text-white text-xs'

  const row = (title: string, key: 't' | 'r' | 's', step: number, path: TrackPath) => {
    const driven = channelOf(clip, nodeIndex, path) >= 0
    const atKey = driven && keyIndexAt(clip.samplers[clip.channels[channelOf(clip, nodeIndex, path)].samplerIndex].input, time) >= 0
    return (
      <div className='flex items-center gap-1'>
        <span className='w-[52px] text-gray-400' title={driven ? `${title} — driven by this clip` : `${title} — not driven by this clip`}>
          {title}{atKey && <span className='text-highlight' title='There is a key here'> ◆</span>}
        </span>
        {[0, 1, 2].map(i => (
          <input key={i} className={num} type='number' step={step} value={round(trs[key][i])}
            onChange={e => {
              const next: Trs = { t: [...trs.t], r: [...trs.r], s: [...trs.s] }
              next[key][i] = parseFloat(e.target.value) || 0
              setTrs(next)
            }} />
        ))}
        <button className='text-gray-500 hover:text-red-400 px-1' title='Delete the key at the playhead on this track'
          disabled={!atKey} onClick={() => deleteKeyOn(path)}>✕</button>
      </div>
    )
  }

  return (
    <Collapsable title={`Bone — ${label}`}>
      <div className='flex flex-col gap-1'>
        {row('position', 't', 0.01, 'translation')}
        {row('rotation', 'r', 1, 'rotation')}
        {row('scale', 's', 0.01, 'scale')}

        <div className='flex items-center gap-1 flex-wrap pt-1'>
          <button className={btn} onClick={keyIt} disabled={!posed}
            title={posed ? 'Write this pose into the clip at the playhead' : 'Change a value above first'}>
            Key at {time.toFixed(2)}s
          </button>
          <button className={btn} onClick={release} disabled={!posed} title='Discard the pose and let the clip drive this bone again'>
            Reset
          </button>
        </div>

        {posed && (
          <p className='text-highlight leading-snug'>
            Posed but not keyed — this bone is held in place over the clip. Key it, or reset it.
          </p>
        )}

        {posedCount > 0 && asset.rigId && (
          <button className={btn} onClick={() => void captureAsPose()}
            title='Store the posed bones on the rig as a named pose, so any clip can reference it'>
            Save {posedCount} posed bone{posedCount === 1 ? '' : 's'} as a shared pose…
          </button>
        )}
      </div>
    </Collapsable>
  )
}

const round = (n: number) => Math.round(n * 1e4) / 1e4
