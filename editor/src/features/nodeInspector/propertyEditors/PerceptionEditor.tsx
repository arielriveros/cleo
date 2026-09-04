import { ControllerNode, perceptionTuning } from 'cleo'
import type { PerceptionTuning } from 'cleo'
import { Slider, Toggle, cn, sectionTitleClass } from '../../../components/ui'
import { hintAffordance } from '../../../components/ui/Field'

/**
 * What an agent can see, and what it remembers.
 *
 * Every field here is a reason an NPC stops being omniscient, so the hints say what each one costs
 * you if it is wrong rather than restating the label.
 */

const FOV_HINT = 'The FULL cone width, not the half-angle: 120 sees 60 degrees either side of where the pawn is facing. 360 sees everything within range, which is what a security camera or a "senses you" enemy wants.'
const RANGE_HINT = 'How far the agent can see. Range and the cone are both tested BEFORE any line-of-sight ray, so a big crowd outside the cone costs nothing.'
const MEMORY_HINT = 'How long a target stays remembered after it was last seen. This is what makes an agent walk to where you WERE instead of forgetting you the instant you break line of sight — the investigate goal has nothing to act on without it.'
const REACTION_HINT = 'Seconds of continuous visibility before a target counts as noticed. Without it an agent reacts on the exact frame a pixel of you clears a doorway, which reads as clairvoyance.'
const EYE_HINT = 'How far above the pawn’s origin the agent looks from. A pawn’s origin is at its feet, and a ray cast from there runs along the floor — which is an obstacle — so an agent with no eye height is blind exactly when it most needs to see.'
const ACQUIRE_HINT = 'Write the nearest noticed character into the target key automatically. On by default: without it perception fills in the senses but nobody ever becomes the target, and every chase has to be wired by a script. Turn it off for a brain that picks its own.'

interface Props {
  node: ControllerNode
  onChange: () => void
}

export default function PerceptionEditor({ node, onChange }: Props) {
  const apply = (patch: Partial<PerceptionTuning>) => {
    node.perception = perceptionTuning({ ...node.perception, ...patch })
    onChange()
  }

  const slider = (
    label: string, key: keyof PerceptionTuning, min: number, max: number, step: number,
    fixed: number, hint: string, unit = '',
  ) => (
    <Slider label={label} min={min} max={max} step={step} value={node.perception[key]} title={hint}
      labelClassName='w-[104px]' readout={(v) => v.toFixed(fixed) + unit}
      onChange={(v) => apply({ [key]: v } as Partial<PerceptionTuning>)} />
  )

  return (
    <div>
      <div className={cn(sectionTitleClass, 'mt-3 mb-1', hintAffordance(FOV_HINT))} title={FOV_HINT}>
        Sight
      </div>
      {slider('Field of view', 'fieldOfView', 0, 360, 5, 0, FOV_HINT, '°')}
      {slider('Range', 'range', 0, 100, 0.5, 1, RANGE_HINT)}
      <Slider label='Eye height' min={0} max={4} step={0.05} value={node.eyeHeight} title={EYE_HINT}
        labelClassName='w-[104px]' readout={(v) => v.toFixed(2)}
        onChange={(v) => { node.eyeHeight = v; onChange() }} />

      <div className={cn(sectionTitleClass, 'mt-3 mb-1', hintAffordance(MEMORY_HINT))} title={MEMORY_HINT}>
        Memory
      </div>
      {slider('Memory span', 'memorySpan', 0, 30, 0.5, 1, MEMORY_HINT, 's')}
      {slider('Reaction time', 'reactionTime', 0, 3, 0.05, 2, REACTION_HINT, 's')}

      <Toggle label='Acquire targets automatically' checked={node.autoAcquire} className='my-1'
        title={ACQUIRE_HINT}
        onChange={(on) => { node.autoAcquire = on; onChange() }} />
    </div>
  )
}
