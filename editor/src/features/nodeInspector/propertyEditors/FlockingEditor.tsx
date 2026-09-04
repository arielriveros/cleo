import { ControllerNode } from 'cleo'
import { Slider, cn, hintClass, sectionTitleClass } from '../../../components/ui'
import { hintAffordance } from '../../../components/ui/Field'

/**
 * The three urges that turn a crowd into a shoal.
 *
 * Only read by the `flock` goal, so the section says so rather than leaving an author to discover
 * that four sliders do nothing.
 */

const FLOCK_HINT = 'Separation, alignment and cohesion over the other Characters nearby. Read only by the flock goal — set Behaviour (or a goal, or a state) to "flock" for these to do anything.'
const RADIUS_HINT = 'How far this agent looks for flock-mates. 0 switches flocking off entirely and skips the neighbour scan, so a non-flocking agent pays nothing.'
const SEP_HINT = 'Push away from crowding, weighted by closeness. Usually the strongest of the three — a flock whose separation is too weak merges into a single point.'
const ALIGN_HINT = 'Match the group’s average heading. Averages measured VELOCITY, so an agent standing still or jammed against a wall does not get a vote on where everyone goes.'
const COH_HINT = 'Steer toward the group’s centre, unweighted. Usually the weakest — too much and the flock collapses inward and fights its own separation.'

interface Props {
  node: ControllerNode
  onChange: () => void
}

export default function FlockingEditor({ node, onChange }: Props) {
  const set = (key: 'flockRadius' | 'separationWeight' | 'alignmentWeight' | 'cohesionWeight', v: number) => {
    node[key] = v
    onChange()
  }

  return (
    <div>
      <div className={cn(sectionTitleClass, 'mt-3 mb-1', hintAffordance(FLOCK_HINT))} title={FLOCK_HINT}>
        Flocking
      </div>
      <p className={hintClass}>{FLOCK_HINT}</p>

      <Slider label='Neighbour radius' min={0} max={40} step={0.5} value={node.flockRadius}
        title={RADIUS_HINT} labelClassName='w-[104px]' readout={(v) => v.toFixed(1)}
        onChange={(v) => set('flockRadius', v)} />

      {node.flockRadius > 0 && (
        <>
          <Slider label='Separation' min={0} max={5} step={0.05} value={node.separationWeight}
            title={SEP_HINT} labelClassName='w-[104px]' readout={(v) => v.toFixed(2)}
            onChange={(v) => set('separationWeight', v)} />
          <Slider label='Alignment' min={0} max={5} step={0.05} value={node.alignmentWeight}
            title={ALIGN_HINT} labelClassName='w-[104px]' readout={(v) => v.toFixed(2)}
            onChange={(v) => set('alignmentWeight', v)} />
          <Slider label='Cohesion' min={0} max={5} step={0.05} value={node.cohesionWeight}
            title={COH_HINT} labelClassName='w-[104px]' readout={(v) => v.toFixed(2)}
            onChange={(v) => set('cohesionWeight', v)} />
        </>
      )}
    </div>
  )
}
