import { useCleoEngine } from '../EngineContext'
import { useAiEditor } from './AiEditorContext'
import BehaviorGraph from './BehaviorGraph'
import GoalGraph from './GoalGraph'
import FuzzyGraph from './FuzzyGraph'
import { SegmentedControl } from '../../components/ui'

/**
 * The AI Brain tab's work surface: the brain's own graph, or the fuzzy model it reads.
 *
 * Which graph is not a choice — it is the asset's `kind`, fixed when the brain was created. What IS a
 * choice is graph-versus-fuzzy, because both kinds of brain can read a fuzzy output through a
 * `{ kind: 'fuzzy' }` parameter, so every brain has one whether or not it uses it.
 *
 * Fills the panel, like the script and tileset editors: `MODE_RENDERS_VIEWPORT` is false for this mode.
 */
export default function AiBrainTabView() {
  const { editorMode } = useCleoEngine()
  const { asset, target, view, setView } = useAiEditor()

  if (editorMode !== 'aiBrain') return null

  if (!asset || !target) {
    return (
      <div className='absolute inset-0 z-10 flex items-center justify-center bg-surface'>
        <p className='text-ui text-muted'>This AI brain is no longer in the library.</p>
      </div>
    )
  }

  return (
    <div className='absolute inset-0 z-10 bg-surface'>
      {/* The view switch sits above the canvases, which each render their own toolbar beside it. */}
      <div data-cleo-overlay className='absolute top-2 right-2 z-30'>
        <SegmentedControl<'graph' | 'fuzzy'>
          value={view}
          onChange={setView}
          rounded={false}
          className='gap-0 flex rounded overflow-hidden border border-control-hover'
          itemClassName='h-[25px] border-0 border-r border-control-hover last:border-r-0'
          options={[
            {
              value: 'graph',
              label: asset.kind === 'goals' ? 'Goals' : 'Behaviour',
              title: asset.kind === 'goals' ? 'The goal graph this brain arbitrates' : 'The state machine this brain runs',
            },
            { value: 'fuzzy', label: 'Fuzzy', title: 'Fuzzy variables and rules, which either kind of brain can read through a parameter' },
          ]}
        />
      </div>

      {view === 'fuzzy' ? <FuzzyGraph /> : asset.kind === 'goals' ? <GoalGraph /> : <BehaviorGraph />}
    </div>
  )
}
