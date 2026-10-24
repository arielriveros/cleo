import { useEffect, useState } from 'react'
import { AIM_SOURCES, AI_GOALS, CONTROL_SOURCES, CharacterNode, ControllerNode, Node } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import NodeRefInput from '../NodeRefInput'
import ActionSelect from '../../input/ActionSelect'
import { useCleoEngine } from '../../EngineContext'
import AxisInput from '../../../components/AxisInput'
import { Button, DocScope, SectionTitle, SegmentedControl, Select, Slider, TextInput, Toggle, cn, labelClass } from '../../../components/ui'
import { hintAffordance } from '../../../components/ui/Field'
import PerceptionEditor from './PerceptionEditor'
import FlockingEditor from './FlockingEditor'
import AiBrainSlot from './AiBrainSlot'
import { ControllerIcon } from '../sectionIcons'

const DRIVE_AIM_HINT = 'Push the look intent into that Camera Rig. Leave this on unless something else already drives the rig — two writers on one rig is a camera that moves at double speed.'

const TARGET_KEY_HINT = 'Which blackboard key holds the target node id. A key rather than a node field, so "chase whoever is called target" is authored once and works for every copy of an NPC — with no id to dangle.'

interface ControllerState {
  possessedId: string | null
  controlSource: string
  moveAction: string; lookAction: string; jumpAction: string; sprintAction: string; crouchAction: string
  aimSource: string; aimSourceId: string | null; driveAimTarget: boolean
  goal: string; targetKey: string; goalPoint: [number, number, number]
  maxSpeed: number; arriveRadius: number; slowRadius: number; standoff: number
  wanderRadius: number; wanderDistance: number; wanderJitter: number
  avoidDistance: number; avoidStrength: number
  whiskerCount: number; whiskerSpread: number
}

/** The steering fields live on a nested `steering` object; the UI flattens them for one patch path. */
const STEERING_KEYS = ['maxSpeed', 'arriveRadius', 'slowRadius', 'standoff', 'wanderRadius',
  'wanderDistance', 'wanderJitter', 'avoidDistance', 'avoidStrength'] as const

function readNode(node: ControllerNode): ControllerState {
  return {
    possessedId: node.possessedId,
    controlSource: node.controlSource,
    moveAction: node.moveAction, lookAction: node.lookAction, jumpAction: node.jumpAction,
    sprintAction: node.sprintAction, crouchAction: node.crouchAction,
    aimSource: node.aimSource, aimSourceId: node.aimSourceId, driveAimTarget: node.driveAimTarget,
    goal: node.goal, targetKey: node.targetKey,
    goalPoint: [node.goalPoint[0], node.goalPoint[1], node.goalPoint[2]],
    maxSpeed: node.steering.maxSpeed, arriveRadius: node.steering.arriveRadius,
    slowRadius: node.steering.slowRadius, standoff: node.steering.standoff,
    wanderRadius: node.steering.wanderRadius, wanderDistance: node.steering.wanderDistance,
    wanderJitter: node.steering.wanderJitter,
    avoidDistance: node.steering.avoidDistance, avoidStrength: node.steering.avoidStrength,
    whiskerCount: node.whiskerCount, whiskerSpread: node.whiskerSpread,
  }
}

export default function ControllerEditor(props: { node: ControllerNode }) {
  const { eventEmitter, editorScene, selectedNode } = useCleoEngine()
  const [state, setState] = useState<ControllerState>(() => readNode(props.node))

  useEffect(() => { setState(readNode(props.node)) }, [props.node])

  const apply = (patch: Partial<ControllerState>) => {
    for (const key in patch) {
      // The steering fields are flattened in this UI but nested on the node.
      if ((STEERING_KEYS as readonly string[]).includes(key))
        (props.node.steering as any)[key] = (patch as any)[key]
      else (props.node as any)[key] = (patch as any)[key]
    }
    setState({ ...state, ...patch })
    eventEmitter.emit('SCENE_CHANGED')
  }

  /** The sub-editors write straight to the node, so all they owe the inspector is a nudge — with the node, so it undoes. */
  const changed = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })

  const slider = (label: string, k: keyof ControllerState, min: number, max: number, step: number, fixed = 2, hint?: string) => (
    <Slider label={label} min={min} max={max} step={step} value={state[k] as number} title={hint}
      labelClassName='w-[104px]' readout={(v) => v.toFixed(fixed)}
      onChange={(v) => apply({ [k]: v } as Partial<ControllerState>)} />
  )

  const action = (label: string, k: keyof ControllerState) => (
    <div className='flex items-center justify-between mb-1.5'>
      <span className={labelClass}>{label}</span>
      <ActionSelect allowNone className='w-[132px]'
        value={state[k] as string}
        onChange={(name) => apply({ [k]: name } as Partial<ControllerState>)} />
    </div>
  )

  // A controller possesses a CHARACTER, and never itself.
  const characters = (node: Node) => node instanceof CharacterNode

  // "Possess selected" is the fast path: pick the character in the tree, then one click here.
  const selected = selectedNode ? editorScene.getNodeById(selectedNode) : null
  const canPossessSelected = selected instanceof CharacterNode && selected.id !== state.possessedId

  // Documented on the AI agents page, not with the other node-type editors.
  return (
    <DocScope page='editor/ai-agents'>
    <Collapsable title='Controller' doc='editor/ai-agents#the-controller-inspector' icon={<ControllerIcon />} persistKey='controller'>
      <div className='w-full p-2'>
        <SectionTitle title='Possession' className='mt-3 mb-1' />
        <NodeRefInput value={state.possessedId} scene={editorScene} filter={characters}
          placeholder='No character'
          onChange={(id) => apply({ possessedId: id })} />
        {canPossessSelected && (
          <Button size='sm' variant='ghost' className='mt-1'
            onClick={() => apply({ possessedId: selected!.id })}>
            Possess “{selected!.name}”
          </Button>
        )}
        {!state.possessedId && (
          <p className='text-ui-sm text-muted mt-1'>
            This controller drives nothing until it possesses a Character.
          </p>
        )}

        <SectionTitle title='Source' className='mt-3 mb-1' />
        <SegmentedControl
          value={state.controlSource}
          options={CONTROL_SOURCES.map(s => ({ value: s, label: s === 'ai' ? 'AI' : s[0].toUpperCase() + s.slice(1) }))}
          onChange={(v) => apply({ controlSource: v })}
        />

        {state.controlSource === 'player' && (
          <>
            <SectionTitle title='Actions' className='mt-3 mb-1' />
            {action('Move', 'moveAction')}
            {action('Look', 'lookAction')}
            {action('Jump', 'jumpAction')}
            {action('Sprint', 'sprintAction')}
            {action('Crouch', 'crouchAction')}
          </>
        )}

        <SectionTitle title='Aim' className='mt-3 mb-1' />
        <div className='flex items-center justify-between mb-2'>
          <span className={labelClass}>Basis</span>
          <Select value={state.aimSource} onChange={(e) => apply({ aimSource: e.target.value })}>
            {AIM_SOURCES.map(s => (
              <option key={s} value={s}>
                {s === 'possessed' ? 'Camera rig under the pawn' : s === 'node' ? 'A specific node' : 'World'}
              </option>
            ))}
          </Select>
        </div>
        {state.aimSource === 'node' && (
          <div className='mb-2'>
            <NodeRefInput value={state.aimSourceId} scene={editorScene}
              filter={(n) => n !== props.node}
              placeholder='No aim node'
              onChange={(id) => apply({ aimSourceId: id })} />
          </div>
        )}
        {state.aimSource !== 'world' && (
          <Toggle label='Drive the camera rig' checked={state.driveAimTarget} className='my-1'
            title={DRIVE_AIM_HINT}
            onChange={(c) => apply({ driveAimTarget: c })} />
        )}

        {state.controlSource === 'ai' && (
          <>
            <SectionTitle title='Goal' className='mt-3 mb-1' />
            <div className='flex items-center justify-between mb-2'>
              <span className={labelClass}>Behaviour</span>
              <Select value={state.goal} onChange={(e) => apply({ goal: e.target.value })}>
                {AI_GOALS.map(g => <option key={g} value={g}>{g}</option>)}
              </Select>
            </div>

            {state.goal !== 'idle' && state.goal !== 'wander' && state.goal !== 'script' && (
              <>
                <div className='flex items-center justify-between mb-2'>
                  <span className={cn(labelClass, hintAffordance(TARGET_KEY_HINT))} title={TARGET_KEY_HINT}>
                    Target key
                  </span>
                  <TextInput className='w-[132px]' value={state.targetKey}
                    onChange={(v) => apply({ targetKey: v })} />
                </div>
                <div className='mb-2'>
                  <label className={labelClass}>Fallback point</label>
                  <AxisInput step={0.1} value={state.goalPoint}
                    onChange={(v) => apply({ goalPoint: v as [number, number, number] })} />
                  <p className='text-ui-sm text-muted mt-1'>
                    Used when the target key is literally <code>point</code>. A goal that names a thing and
                    has none holds still rather than walking to the origin.
                  </p>
                </div>
              </>
            )}

            {state.goal === 'script' && (
              <p className='text-ui-sm text-muted mb-2'>
                This controller writes no intent. Add a script with an <code>onThink(delta)</code> handler
                and drive the pawn through <code>this.possessed.drive()</code> — possession, the aim basis
                and obstacle avoidance still work.
              </p>
            )}

            {state.goal !== 'script' && (
              <>
                <SectionTitle title='Steering' className='mt-3 mb-1' />
                {slider('Max speed', 'maxSpeed', 0, 20, 0.1)}
                {(state.goal === 'arrive' || state.goal === 'follow') && (
                  <>
                    {slider('Arrive radius', 'arriveRadius', 0, 10, 0.1)}
                    {slider('Slow radius', 'slowRadius', 0.1, 20, 0.1)}
                  </>
                )}
                {state.goal === 'follow' && slider('Standoff', 'standoff', 0, 20, 0.1)}
                {state.goal === 'wander' && (
                  <>
                    {slider('Wander radius', 'wanderRadius', 0.05, 10, 0.05)}
                    {slider('Wander distance', 'wanderDistance', 0, 20, 0.1)}
                    {slider('Wander jitter', 'wanderJitter', 0, 720, 5, 0)}
                  </>
                )}

                <SectionTitle title='Obstacle avoidance' className='mt-3 mb-1' />
                {slider('Look ahead', 'avoidDistance', 0, 20, 0.1)}
                {state.avoidDistance > 0 && (
                  <>
                    {slider('Strength', 'avoidStrength', 0, 5, 0.1)}
                    {slider('Whiskers', 'whiskerCount', 1, 9, 1, 0)}
                    {slider('Spread', 'whiskerSpread', 0, 180, 5, 0)}
                  </>
                )}
              </>
            )}

            <SectionTitle title='Perception' className='mt-3 mb-1' />
            <PerceptionEditor node={props.node} onChange={changed} />

            <FlockingEditor node={props.node} onChange={changed} />

            {/* The brain is an ASSET now: a named, reusable behaviour machine or goal graph, authored
                in its own tab and shared between agents. What used to be a Machine/Goal/None switch is
                the slot itself — a brain declares its own kind, and an empty slot is what "None" meant.
                Perception, flocking and steering stay here, because they describe the AGENT rather
                than what it decides with. */}
            <AiBrainSlot node={props.node} onChange={changed} />
          </>
        )}
      </div>
    </Collapsable>
    </DocScope>
  )
}
