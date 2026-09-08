import { useAiEditor } from './AiEditorContext'
import BehaviorEditor from '../nodeInspector/propertyEditors/BehaviorEditor'
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
export default function AiBrainInspector() {
  const { asset, target, view, commit } = useAiEditor()

  if (!asset || !target) {
    return <div className='p-3 text-[11px] text-muted'>No AI brain open.</div>
  }

  return (
    <div className='p-1'>
      {view === 'fuzzy'
        ? <FuzzyEditor node={target} onChange={commit} />
        : asset.kind === 'goals'
          ? <GoalsEditor node={target} onChange={commit} />
          : <BehaviorEditor node={target} onChange={commit} />}
    </div>
  )
}
