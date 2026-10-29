import { useEffect, useState } from 'react'
import { quat, vec3 } from 'gl-matrix'
import { eulerFromQuatDeg, humanoidSlotOf, IMPLICIT_SOCKETS } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useRig } from './RigContext'
import { getAnimationTarget } from '../animation/skeleton'
import { Button, Hint, SectionTitle, Select, TextInput, VectorInput, cn, labelClass } from '@cleo/app-kit/ui'
import { cryptoRandomId } from '../../utils/ids'
import type { RigSocket } from '../../utils/rigAssets'

// The rig's sockets: named attach points on its bones, where a weapon, a torch or a hat is held.
//
// Authored on the rig because a socket is a property of the SKELETON — every character built on it gets
// the same RightHand — and edited on the working copy like everything else in this tab. Selecting a
// socket here parks the viewport gizmo on it (`SocketGizmo`); the numbers and the gizmo edit the same
// offset. A preview model is shown on the socket in every animation editor, never in a scene.

/** Socket selection, shared with the gizmo. Carries the socket id, or null. */
export const SELECT_SOCKET = 'SELECT_SOCKET'

const toEuler = (r?: number[]) => {
  const e = eulerFromQuatDeg(vec3.create(), r ? quat.fromValues(r[0], r[1], r[2], r[3]) : quat.create())
  return [e[0], e[1], e[2]]
}
const fromEuler = (e: number[]) => {
  const q = quat.fromEuler(quat.create(), e[0], e[1], e[2])
  return [q[0], q[1], q[2], q[3]]
}

/** The socket name scripts ask for, keyed by humanoid slot: the same names IMPLICIT_SOCKETS answers to. */
const STANDARD_SOCKET_OF_SLOT: Record<string, string> = Object.fromEntries(
  Object.entries(IMPLICIT_SOCKETS).map(([name, slot]) => [slot, name]))

/**
 * A socket name not yet taken on this rig, derived from the bone. A hand or head bone gets the STANDARD
 * name (`RightHand`, `LeftHand`, `Head`) — what weapon and cast scripts look up — so adding a socket there
 * to give a grip offset just works, instead of producing `hand_rSocket` that nothing asks for.
 */
function freshName(bone: string, taken: RigSocket[]): string {
  const standard = STANDARD_SOCKET_OF_SLOT[humanoidSlotOf(bone) ?? '']
  if (standard && !taken.some(s => s.name === standard)) return standard
  // Strip a namespace prefix (`mixamorig:RightHand`) so the socket reads as the bone does.
  const base = `${bone.split(':').pop() || 'Socket'}Socket`
  let name = base
  for (let i = 2; taken.some(s => s.name === name); i++) name = `${base}${i}`
  return name
}

export default function SocketsPanel() {
  const { editorScene, skeletonTargetId, eventEmitter } = useCleoEngine()
  const { models } = useAssetLibrary()
  const { asset, patch } = useRig()
  const [selectedJoint, setSelectedJoint] = useState(-1)
  const [selectedSocket, setSelectedSocket] = useState<string | null>(null)

  useEffect(() => {
    const onJoint = (i: number) => setSelectedJoint(typeof i === 'number' ? i : -1)
    const onSocket = (id: string | null) => setSelectedSocket(id ?? null)
    eventEmitter.on('SELECT_JOINT', onJoint)
    eventEmitter.on(SELECT_SOCKET, onSocket)
    return () => { eventEmitter.off('SELECT_JOINT', onJoint); eventEmitter.off(SELECT_SOCKET, onSocket) }
  }, [eventEmitter])

  const target = getAnimationTarget(editorScene, skeletonTargetId)
  if (!asset) return null
  const sockets = asset.sockets ?? []

  // Bones by name: a socket stores the NAME, so a nameless joint cannot carry one.
  const boneNames = target
    ? target.skin.joints.map(j => target.skin.nodeNames?.get(j.nodeIndex)).filter((n): n is string => !!n)
    : []
  const selectedBone = target && selectedJoint >= 0 && selectedJoint < target.skin.joints.length
    ? target.skin.nodeNames?.get(target.skin.joints[selectedJoint].nodeIndex)
    : undefined

  const select = (id: string | null) => {
    setSelectedSocket(id)
    eventEmitter.emit(SELECT_SOCKET, id)
  }
  const setSockets = (next: RigSocket[]) => patch({ ...asset, sockets: next })
  const update = (id: string, change: Partial<RigSocket>) =>
    setSockets(sockets.map(s => (s.id === id ? { ...s, ...change } : s)))

  const add = () => {
    const bone = selectedBone ?? boneNames[0]
    if (!bone) return
    const socket: RigSocket = { id: cryptoRandomId(), name: freshName(bone, sockets), bone }
    setSockets([...sockets, socket])
    select(socket.id)
  }

  return (
    <div>
      <SectionTitle title='Sockets' className='mb-1' />

      <div className='flex flex-col gap-1'>
        {sockets.map(socket => {
          const open = socket.id === selectedSocket
          const missing = boneNames.length > 0 && !boneNames.includes(socket.bone)
          return (
            <div key={socket.id} className={cn('rounded border', open ? 'border-highlight' : 'border-control')}>
              <div className='flex items-center gap-1 p-1'>
                <button
                  className='text-ui-sm px-1 shrink-0 text-muted hover:text-fg'
                  title={open ? 'Collapse' : 'Edit this socket and park the gizmo on it'}
                  onClick={() => select(open ? null : socket.id)}
                >{open ? '▾' : '▸'}</button>
                <TextInput
                  className='flex-1'
                  value={socket.name}
                  title='The name nodes attach by. Renaming detaches anything already using the old name.'
                  onChange={v => update(socket.id, { name: v })}
                />
                <Button variant='remove' size='sm' className='px-1 py-0 shrink-0'
                  title='Delete this socket. Nodes attached to it stop following and stay where they were.'
                  onClick={() => { setSockets(sockets.filter(s => s.id !== socket.id)); if (open) select(null) }}
                >✕</Button>
              </div>

              {open && (
                <div className='flex flex-col gap-1 p-1 pt-0'>
                  <label className={labelClass}>Bone</label>
                  <Select value={socket.bone} onChange={e => update(socket.id, { bone: e.target.value })}>
                    {missing && <option value={socket.bone}>{socket.bone} (not on this skeleton)</option>}
                    {boneNames.map(n => <option key={n} value={n}>{n}</option>)}
                  </Select>

                  <label className={labelClass}>Position (m)</label>
                  <VectorInput
                    value={socket.offset?.t ?? [0, 0, 0]} step={0.01} precision={3} reset={[0, 0, 0]}
                    onChange={t => update(socket.id, { offset: { ...socket.offset, t } })}
                  />
                  <label className={labelClass}>Rotation (°)</label>
                  <VectorInput
                    value={toEuler(socket.offset?.r)} step={1} precision={1} reset={[0, 0, 0]}
                    onChange={e => update(socket.id, { offset: { ...socket.offset, r: fromEuler(e) } })}
                  />
                  <label className={labelClass}>Scale</label>
                  <VectorInput
                    value={socket.offset?.s ?? [1, 1, 1]} step={0.01} precision={3} reset={[1, 1, 1]} uniform
                    onChange={s => update(socket.id, { offset: { ...socket.offset, s } })}
                  />

                  <label className={labelClass}>Preview model</label>
                  <Select
                    value={socket.previewModelId ?? ''}
                    title='Shown on the socket in the animation editors only — never placed in a scene'
                    onChange={e => update(socket.id, { previewModelId: e.target.value || undefined })}
                  >
                    <option value=''>None</option>
                    {models.filter(m => m.rigId !== asset.id).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Select>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <Button
        variant='subtle' className='w-full py-1.5 mt-1'
        disabled={!boneNames.length}
        onClick={add}
        title={selectedBone ? `Add a socket on ${selectedBone}` : 'Pick a bone in the Skeleton panel first, or this adds one on the root'}
      >+ Add socket{selectedBone ? ` on ${selectedBone.split(':').pop()}` : ''}</Button>
      {!boneNames.length && <Hint className='mt-1'>This skeleton has no bone names, so sockets cannot refer to its bones.</Hint>}
    </div>
  )
}
