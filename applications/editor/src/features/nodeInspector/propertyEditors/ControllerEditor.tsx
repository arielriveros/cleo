import type { ReactNode } from 'react'
import { CharacterBody2DNode, CharacterNode, ControllerNode, FLOCKING_PRESETS, PERCEPTION_PRESETS, applyPreset, isVehicle, perceptionTuning } from 'cleo'
import type { FlockingPreset, Node, PerceptionPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import { Button, DocScope, PresetMenu } from '@cleo/app-kit/ui'
import AiBrainSlot from './AiBrainSlot'
import { ControllerIcon } from '../sectionIcons'
import { DeclaredSection, useNodeTick } from '../../properties/DeclaredSections'

// The Controller inspector: its declared properties (src/properties/gameplay.ts), documented on the AI agents
// page. Possessing the selected node in one click, the presets, the notes and the brain slot are the card's own.

/** A controller possesses a CHARACTER (3D), a CHARACTER BODY 2D or a VEHICLE, and never itself. */
const possessable = (node: Node | null | undefined): node is Node =>
  node instanceof CharacterNode || node instanceof CharacterBody2DNode || isVehicle(node)

export default function ControllerEditor(props: { node: ControllerNode }) {
  const { eventEmitter, editorScene, selectedNode } = useCleoEngine()
  const bump = useNodeTick(props.node)
  const node = props.node

  /** The card's own writes, announced with the node so they undo. */
  const changed = () => {
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node })
    bump()
  }

  // "Possess selected" is the fast path: pick the character in the tree, then one click here.
  const selected = selectedNode ? editorScene.getNodeById(selectedNode) : null
  const canPossessSelected = possessable(selected) && selected.id !== node.possessedId

  // Replaces the whole tuning (through the same clamp), leaving eye height and auto-acquire alone.
  const perceptionPreset = (p: PerceptionPreset) => {
    node.perception = perceptionTuning({ ...node.perception, ...p.options })
    changed()
  }
  const flockingPreset = (p: FlockingPreset) => {
    applyPreset(node, FLOCKING_PRESETS, p)
    changed()
  }

  const section = (title: string, extra?: { right?: ReactNode; children?: ReactNode }) => (
    <DeclaredSection node={node} title={title} right={extra?.right}>{extra?.children}</DeclaredSection>
  )

  // Documented on the AI agents page, not with the other node-type editors.
  return (
    <DocScope page='editor/ai-agents'>
    <Collapsable title='Controller' doc='editor/ai-agents#the-controller-inspector' icon={<ControllerIcon />} persistKey='controller'>
      <div className='w-full p-2'>
        {section('Possession', { children: <>
          {canPossessSelected && (
            <Button size='sm' variant='ghost' className='mt-1'
              onClick={() => { node.possessedId = selected!.id; changed() }}>
              Possess “{selected!.name}”
            </Button>
          )}
          {!node.possessedId && (
            <p className='text-ui-sm text-muted mt-1'>
              This controller drives nothing until it possesses a Character or a Vehicle.
            </p>
          )}
        </> })}
        {section('Source')}
        {section('Actions')}
        {section('Aim')}
        {section('Goal', { children: node.goal === 'script' && (
          <p className='text-ui-sm text-muted mb-2'>
            This controller writes no intent. Add a script with an <code>onThink(delta)</code> handler
            and drive the pawn through <code>this.possessed.drive()</code> — possession, the aim basis
            and obstacle avoidance still work.
          </p>
        ) })}
        {section('Steering')}
        {section('Obstacle avoidance')}
        {section('Perception', { right: <PresetMenu presets={PERCEPTION_PRESETS} onApply={perceptionPreset}
          title='Perception presets — cone, range, memory and reaction; eye height stays yours' /> })}
        {section('Flocking', { right: <PresetMenu presets={FLOCKING_PRESETS} onApply={flockingPreset} title='Flocking presets' /> })}

        {/* The brain is an ASSET: a named, reusable behaviour machine or goal graph, authored in its own tab
            and shared between agents; an empty slot is what "None" meant. Perception, flocking and steering
            stay here, because they describe the AGENT rather than what it decides with. */}
        {node.controlSource === 'ai' && <AiBrainSlot node={node} onChange={changed} />}
      </div>
    </Collapsable>
    </DocScope>
  )
}
