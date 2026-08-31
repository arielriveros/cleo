import { useEffect, useState } from 'react'
import { CameraRigNode, Node } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import NodeRefInput from '../NodeRefInput'
import { useCleoEngine } from '../../EngineContext'
import { Button, Select, Slider, Toggle, cn, labelClass, sectionTitleClass } from '../../../components/ui'
import { hintAffordance } from '../../../components/ui/Field'
import { RigIcon } from '../sectionIcons'

const RIG_HINT = 'The rig drives its child camera’s position and rotation every frame — edit the boom here rather than moving the camera directly.'
const FOLLOW_TARGET_HINT = 'The node the rig follows. With no target, the rig’s own position is the pivot.'
const FOLLOW_DAMPING_HINT = 'Seconds of lag per axis. 0 seconds is rigid; higher values lag further behind.'
const AIM_MODE_HINT = 'Orbit is script-driven — feed it input with rig.addYaw(dx) / rig.addPitch(dy).'
const ARM_LENGTH_HINT = 'How far back along the boom the camera sits. Arm length 0 gives a first-person camera at the pivot.'
const COLLISION_HINT = 'Tests physics collider shapes — the same solids the character collides with — including terrain. A body only blocks the camera while its Camera Collision channel is on (Physics panel). Trigger volumes, the follow and look-at targets, and the rig’s own character are always ignored.'
const SHAKE_HINT = 'Shake is visible in Play mode. From a script: rig.shake(0.6).'

type Vec3 = [number, number, number]

interface RigState {
  followId: string | null; lookAtId: string | null
  followOffset: Vec3; followSpace: string; followDamping: Vec3; followDampingSpace: string
  aimMode: string; lookAtOffset: Vec3; aimDamping: number
  yaw: number; pitch: number
  yawSensitivity: number; pitchSensitivity: number; invertPitch: boolean
  yawLimited: boolean; yawMin: number; yawMax: number; pitchMin: number; pitchMax: number
  armLength: number; socketOffset: Vec3
  fovEnabled: boolean; fov: number; fovDamping: number
  collisionEnabled: boolean; collisionRadius: number; collisionMinRatio: number
  collisionPullTime: number; collisionReturnTime: number
  shakePositionAmplitude: Vec3; shakeRotationAmplitude: Vec3; shakeFrequency: number; shakeDecay: number
}

// ArrayLike, not `Float32Array | number[]`: gl-matrix's `vec3` is `[number, number, number] |
// IndexedCollection`, and IndexedCollection is assignable to neither of those.
const toVec3 = (v: ArrayLike<number>): Vec3 => [v[0], v[1], v[2]]

function readNode(node: CameraRigNode): RigState {
  return {
    followId: node.followId, lookAtId: node.lookAtId,
    followOffset: toVec3(node.followOffset), followSpace: node.followSpace,
    followDamping: toVec3(node.followDamping), followDampingSpace: node.followDampingSpace,
    aimMode: node.aimMode, lookAtOffset: toVec3(node.lookAtOffset), aimDamping: node.aimDamping,
    yaw: node.yaw, pitch: node.pitch,
    yawSensitivity: node.yawSensitivity, pitchSensitivity: node.pitchSensitivity, invertPitch: node.invertPitch,
    // Infinity is not a slider value; the UI models "unclamped" as a checkbox instead.
    yawLimited: isFinite(node.yawMin) || isFinite(node.yawMax),
    yawMin: isFinite(node.yawMin) ? node.yawMin : -180,
    yawMax: isFinite(node.yawMax) ? node.yawMax : 180,
    pitchMin: node.pitchMin, pitchMax: node.pitchMax,
    armLength: node.armLength, socketOffset: toVec3(node.socketOffset),
    fovEnabled: node.fovEnabled, fov: node.fov, fovDamping: node.fovDamping,
    collisionEnabled: node.collisionEnabled, collisionRadius: node.collisionRadius,
    collisionMinRatio: node.collisionMinRatio, collisionPullTime: node.collisionPullTime,
    collisionReturnTime: node.collisionReturnTime,
    shakePositionAmplitude: toVec3(node.shakePositionAmplitude),
    shakeRotationAmplitude: toVec3(node.shakeRotationAmplitude),
    shakeFrequency: node.shakeFrequency, shakeDecay: node.shakeDecay,
  }
}

export default function CameraRigEditor(props: { node: CameraRigNode }) {
  const { eventEmitter, editorScene } = useCleoEngine()
  const [state, setState] = useState<RigState>(() => readNode(props.node))

  useEffect(() => { setState(readNode(props.node)) }, [props.node])

  // Keys map straight onto the node except the yaw-limit checkbox, which stands in for +/-Infinity bounds.
  const apply = (patch: Partial<RigState>) => {
    const next = { ...state, ...patch }
    for (const key in patch) {
      if (key === 'yawLimited' || key === 'yawMin' || key === 'yawMax') continue
      ;(props.node as any)[key] = (patch as any)[key]
    }
    if ('yawLimited' in patch || 'yawMin' in patch || 'yawMax' in patch) {
      props.node.yawMin = next.yawLimited ? next.yawMin : -Infinity
      props.node.yawMax = next.yawLimited ? next.yawMax : Infinity
    }
    setState(next)
    eventEmitter.emit('SCENE_CHANGED')
  }

  // Invoked as functions, not components, so the inputs keep identity across re-renders.
  const slider = (label: string, k: keyof RigState, min: number, max: number, step: number, fixed = 2, hint?: string) => (
    <Slider label={label} min={min} max={max} step={step} value={state[k] as number} title={hint}
      labelClassName='w-[104px]' readout={(v) => v.toFixed(fixed)}
      onChange={(v) => apply({ [k]: v } as Partial<RigState>)} />
  )

  const check = (label: string, k: keyof RigState) => (
    <Toggle label={label} checked={state[k] as boolean} className='my-1'
      onChange={(c) => apply({ [k]: c } as Partial<RigState>)} />
  )

  const axis = (label: string, k: keyof RigState, step = 0.05, hint?: string) => (
    <div className='mb-2'>
      <label className={cn(labelClass, hintAffordance(hint))} title={hint}>{label}</label>
      <AxisInput step={step} value={state[k] as Vec3}
        onChange={(v) => apply({ [k]: v } as Partial<RigState>)} />
    </div>
  )

  const dropdown = (label: string, k: keyof RigState, options: { value: string, label: string }[], hint?: string) => (
    <div className='flex items-center justify-between mb-2'>
      <span className={cn(labelClass, hintAffordance(hint))} title={hint}>{label}</span>
      <Select value={state[k] as string} onChange={(e) => apply({ [k]: e.target.value } as Partial<RigState>)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </div>
  )

  const header = (label: string, hint?: string) => (
    <div className={cn(sectionTitleClass, 'mt-3 mb-1', hintAffordance(hint))} title={hint}>{label}</div>
  )

  // Referencing the rig itself (or anything under it, including its own camera) would be circular.
  const notSelfOrDescendant = (node: Node) => node !== props.node && !node.isDescendantOf(props.node)

  return (
    <Collapsable title='Camera Rig' icon={<RigIcon />} persistKey='cameraRig' hint={RIG_HINT}>
      <div className='w-full p-2'>
        {header('Follow (drives position)')}
        <div className='mb-2'>
          <label className={cn(labelClass, hintAffordance(FOLLOW_TARGET_HINT))} title={FOLLOW_TARGET_HINT}>Follow Target</label>
          <NodeRefInput value={state.followId} scene={editorScene} filter={notSelfOrDescendant}
            onChange={(id) => apply({ followId: id })} />
        </div>
        {axis('Offset (Y = Height)', 'followOffset')}
        {dropdown('Offset Space', 'followSpace', [
          { value: 'world', label: 'World' },
          { value: 'targetYaw', label: "Target's heading" },
          { value: 'targetFull', label: "Target's full rotation" },
        ])}
        {axis('Damping (seconds)', 'followDamping', 0.01, FOLLOW_DAMPING_HINT)}
        {dropdown('Damping Axes', 'followDampingSpace', [
          { value: 'world', label: 'World' },
          { value: 'rig', label: "Rig (behind / side / up)" },
        ])}

        {header('Aim (drives rotation)')}
        {dropdown('Aim Mode', 'aimMode', [
          { value: 'orbit', label: 'Orbit (script-driven)' },
          { value: 'lookAt', label: 'Look At target' },
          { value: 'none', label: 'None (authored rotation)' },
        ], AIM_MODE_HINT)}
        {state.aimMode === 'lookAt' && <>
          <div className='mb-2'>
            <label className={labelClass}>Look At Target</label>
            <NodeRefInput value={state.lookAtId} scene={editorScene} filter={notSelfOrDescendant}
              onChange={(id) => apply({ lookAtId: id })} />
          </div>
          {axis('Look At Offset', 'lookAtOffset')}
        </>}
        {state.aimMode !== 'none' && <>
          {slider('Aim Damping', 'aimDamping', 0, 2, 0.01)}
          {slider('Yaw', 'yaw', -180, 180, 0.5, 1)}
          {slider('Pitch', 'pitch', state.pitchMin, state.pitchMax, 0.5, 1)}
        </>}
        {state.aimMode === 'orbit' && <>
          {slider('Yaw Sensitivity', 'yawSensitivity', 0.01, 2, 0.01)}
          {slider('Pitch Sensitivity', 'pitchSensitivity', 0.01, 2, 0.01)}
          {check('Invert Pitch', 'invertPitch')}
        </>}
        {slider('Pitch Min', 'pitchMin', -89, 0, 1, 0)}
        {slider('Pitch Max', 'pitchMax', 0, 89, 1, 0)}
        {check('Limit Yaw', 'yawLimited')}
        {state.yawLimited && <>
          {slider('Yaw Min', 'yawMin', -180, 0, 1, 0)}
          {slider('Yaw Max', 'yawMax', 0, 180, 1, 0)}
        </>}

        {header('Spring Arm')}
        {slider('Arm Length', 'armLength', 0, 30, 0.1, 2, ARM_LENGTH_HINT)}
        {axis('Socket Offset', 'socketOffset')}

        {header('Field of View')}
        {check('Rig Controls FOV', 'fovEnabled')}
        {state.fovEnabled && <>
          {slider('FOV', 'fov', 20, 120, 0.5, 1)}
          {slider('FOV Damping', 'fovDamping', 0, 2, 0.01)}
        </>}

        {header('Collision', COLLISION_HINT)}
        {check('Pull In On Obstruction', 'collisionEnabled')}
        {state.collisionEnabled && <>
          {slider('Probe Radius', 'collisionRadius', 0, 2, 0.01)}
          {slider('Min Arm Ratio', 'collisionMinRatio', 0, 0.9, 0.01)}
          {slider('Pull In Time', 'collisionPullTime', 0, 1, 0.01)}
          {slider('Return Time', 'collisionReturnTime', 0, 2, 0.01)}
        </>}

        {header('Shake', SHAKE_HINT)}
        {axis('Position Amplitude', 'shakePositionAmplitude', 0.01)}
        {axis('Rotation Amplitude (deg)', 'shakeRotationAmplitude', 0.1)}
        {slider('Frequency (Hz)', 'shakeFrequency', 1, 60, 0.5, 1)}
        {slider('Decay (per second)', 'shakeDecay', 0.1, 5, 0.05)}
        <Button className='mt-1' onClick={() => props.node.shake(0.6)}>Test Shake</Button>
      </div>
    </Collapsable>
  )
}
