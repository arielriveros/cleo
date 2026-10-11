import CustomVariablesEditor from './CustomVariablesEditor'
import ScriptVariablesEditor from './ScriptVariablesEditor'
import ScriptSlot from './ScriptSlot'
import TemplateInstanceNotice from '../TemplateInstanceNotice'
import { useSelectedNode, isRootNode } from '../useSelectedNode'
import { getScriptIdOf } from '../../../utils/scripts'

// The Scripts inspector panel: links a script to the selected node and edits that node's variable values.
// The script SOURCE is edited in the dedicated Script editor tab, not here.
export default function ScriptEditor() {
  const { node, readOnly } = useSelectedNode()
  if (!node || isRootNode(node)) return null

  // Inside a placed template instance the script itself is the template's, but each FIELD VALUE may be
  // overridden per placement, so the values stay editable while the slot and legacy variables lock.
  const locked = `${readOnly ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`
  return (
    <>
      {readOnly && <TemplateInstanceNotice />}
      <fieldset disabled={readOnly} className={locked}>
        <ScriptSlot node={node} onChanged={() => {}} />
      </fieldset>
      {/* Class-based scripts declare their variables as fields (schema view with per-node values); legacy
          inline-variable nodes keep the old add/remove editor until they're migrated. */}
      {getScriptIdOf(node)
        ? <ScriptVariablesEditor node={node} overridable={readOnly} />
        : <fieldset disabled={readOnly} className={locked}><CustomVariablesEditor node={node} /></fieldset>}
    </>
  )
}
