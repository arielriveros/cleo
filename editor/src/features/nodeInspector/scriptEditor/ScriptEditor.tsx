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

  return (
    <fieldset disabled={readOnly} className={`${readOnly ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`}>
      {readOnly && <TemplateInstanceNotice />}
      <ScriptSlot node={node} onChanged={() => {}} />
      {/* Class-based scripts declare their variables as fields (schema view with per-node values); legacy
          inline-variable nodes keep the old add/remove editor until they're migrated. */}
      {getScriptIdOf(node)
        ? <ScriptVariablesEditor node={node} />
        : <CustomVariablesEditor node={node} />}
    </fieldset>
  )
}
