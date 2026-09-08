import { useCleoEngine } from '../EngineContext'
import { useAiEditor } from './AiEditorContext'
import BehaviorGraph from './BehaviorGraph'
import GoalGraph from './GoalGraph'
import FuzzyGraph from './FuzzyGraph'

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
        <p className='text-xs text-muted'>This AI brain is no longer in the library.</p>
      </div>
    )
  }

  return (
    <div className='absolute inset-0 z-10 bg-surface'>
      {/* The view switch sits above the canvases, which each render their own toolbar beside it. */}
      <div data-cleo-overlay className='absolute top-2 right-2 z-30 flex items-center rounded overflow-hidden border border-control-hover'>
        {(['graph', 'fuzzy'] as const).map(v => (
          <button key={v}
            className={`px-2 h-[25px] text-xs border-r border-control-hover last:border-r-0 transition-colors ${
              view === v ? 'bg-selected text-white' : 'bg-control text-muted hover:bg-control-hover'}`}
            title={v === 'graph'
              ? (asset.kind === 'goals' ? 'The goal graph this brain arbitrates' : 'The state machine this brain runs')
              : 'Fuzzy variables and rules, which either kind of brain can read through a parameter'}
            onClick={() => setView(v)}>
            {v === 'graph' ? (asset.kind === 'goals' ? 'Goals' : 'Behaviour') : 'Fuzzy'}
          </button>
        ))}
      </div>

      {view === 'fuzzy' ? <FuzzyGraph /> : asset.kind === 'goals' ? <GoalGraph /> : <BehaviorGraph />}
    </div>
  )
}
