import { useAiEditor } from './AiEditorContext'
import BehaviorEditor from '../nodeInspector/propertyEditors/BehaviorEditor'
import { Button, NameInput, SectionTitle, Toggle, hintClass } from '@cleo/app-kit/ui'
import { behaviorNameProblem } from '../../utils/aiGraphEdits'
import GoalsEditor from '../nodeInspector/propertyEditors/GoalsEditor'
import FuzzyEditor from '../nodeInspector/propertyEditors/FuzzyEditor'

/**
 * The AI Brain tab's Properties rail: the DETAIL behind whatever the canvas lays out.
 *
 * The split the graph canvases have always documented — the graph edits STRUCTURE (add a node, connect
 * two, move things, delete) and this edits DETAIL (a transition's condition tree, a goal's
 * desirability curve, a fuzzy set's shape). Duplicating the condition tree onto the canvas would mean
 * two places to edit one gate.
 *
 * The three editors are the originals, re-hosted rather than rewritten: they route every rename through
 * `aiGraphEdits` so a dangling reference is never silently dropped, and they warn about a fuzzy variable
 * that matches no known input. All they ever needed was a `ControllerNode`, which is exactly what the
 * tab's working copy is.
 *
 * The list stays complete rather than showing only the canvas selection: a machine's PARAMETERS and a
 * fuzzy model's variables are not on the canvas at all, and a panel that went blank until you clicked a
 * node would hide them.
 */
/** The layer shown: its name, whether it runs, and a way to delete it. Nothing on the top level. */
function LayerRows() {
  const { asset, layer, renameLayer, removeLayer, setLayerEnabled, target } = useAiEditor()
  if (!asset || asset.kind === 'goals' || !layer) return null
  const data = asset.machine.layers?.find(l => l.name === layer)
  if (!data || !target) return null
  return (
    <div className='mb-2'>
      <SectionTitle title={`Layer — ${layer}`} className='mt-2 mb-1' />
      <div className='flex items-center gap-1'>
        <NameInput className='flex-1 min-w-0' value={layer} title='Layer name (a Layer time or Layer state source names it)'
          validate={v => behaviorNameProblem(v, (asset.machine.layers ?? []).map(l => l.name).filter(n => n !== layer), 'layer')}
          onCommit={v => renameLayer(layer, v)} />
        <span title='Off: the layer is kept but does not run'>
          <Toggle label='runs' checked={data.enabled !== false} onChange={on => setLayerEnabled(layer, on)} />
        </span>
        <Button variant='remove' size='sm' title='Delete this layer and its states' onClick={() => removeLayer(layer)}>✕</Button>
      </div>
      <p className={hintClass}>
        Runs beside the top level over the same parameters, from its own entry state: its states never steer, they set
        outputs (a field of the pawn while the state is held). Where two layers set one field, the lower one in the list wins.
      </p>
    </div>
  )
}

export default function AiBrainInspector() {
  const { asset, target, view, commit } = useAiEditor()

  if (!asset || !target) {
    return <div className='p-3 text-ui-sm text-muted'>No AI brain open.</div>
  }

  return (
    <div className='p-1'>
      {view === 'fuzzy'
        ? <FuzzyEditor node={target} onChange={commit} />
        : asset.kind === 'goals'
          ? <GoalsEditor node={target} onChange={commit} />
          : <><LayerRows /><BehaviorEditor node={target} onChange={commit} /></>}
    </div>
  )
}
