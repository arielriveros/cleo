import ScriptAttributesEditor from './ScriptAttributesEditor'
import ScriptSlot from './ScriptSlot'
import TemplateInstanceNotice from '../TemplateInstanceNotice'
import { useSelectedNode, isRootNode } from '../useSelectedNode'
import { getScriptIdOf } from '../../../utils/scripts'

// The Behaviors inspector panel: links a script to the selected node, then edits that node's values for the
// script's `@attribute` fields. The script SOURCE is edited in the dedicated Script editor tab, not here.
export default function ScriptEditor() {
  const { node, readOnly } = useSelectedNode()
  if (!node || isRootNode(node)) return null

  // Inside a placed template instance the script itself is the template's, but each attribute VALUE may be
  // overridden per placement, so the values stay editable while the slot locks.
  const locked = `${readOnly ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`
  return (
    <>
      {readOnly && <TemplateInstanceNotice />}
      <fieldset disabled={readOnly} className={locked}>
        <ScriptSlot node={node} onChanged={() => {}} />
      </fieldset>
      {getScriptIdOf(node) && <ScriptAttributesEditor node={node} overridable={readOnly} />}
    </>
  )
}
