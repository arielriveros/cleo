import ScriptAttributesEditor from './ScriptAttributesEditor'
import ScriptSlot from './ScriptSlot'
import TemplateInstanceNotice from '../TemplateInstanceNotice'
import { useSelectedNode, isRootNode } from '../useSelectedNode'
import { useCleoEngine } from '../../EngineContext'
import { getScriptIdOf } from '../../../utils/scripts'
import { TEMPLATE_ID_VAR } from '../../../utils/templates'
import { innerAttributeSections } from '../../../utils/instanceAttributes'

// The Behaviors inspector panel: links a script to the selected node, then edits that node's values for the
// script's `@attribute` fields. The script SOURCE is edited in the dedicated Script editor tab, not here.
export default function ScriptEditor() {
  const { node, readOnly, simulating } = useSelectedNode()
  const { scriptAssetOf } = useCleoEngine()
  if (!node || isRootNode(node)) return null

  // Inside a placed template instance the script itself is the template's, but the values of its PUBLIC
  // attributes are each placement's own (overridden per placement), so those stay editable while the slot
  // and the private attributes lock. While Simulating, readOnly means something else: nothing locks there.
  const instance = readOnly && !simulating
  const locked = `${readOnly ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`
  // On the instance ROOT: every behavior inside it with public attributes, after the root's own.
  const templateId = instance ? node.getVariable(TEMPLATE_ID_VAR) : undefined
  const inner = templateId ? innerAttributeSections(node, n => scriptAssetOf(n)) : []
  return (
    <>
      {readOnly && <TemplateInstanceNotice />}
      <fieldset disabled={readOnly} className={locked}>
        <ScriptSlot node={node} onChanged={() => {}} />
      </fieldset>
      {getScriptIdOf(node) && <ScriptAttributesEditor node={node} overridable={readOnly} lockPrivate={instance} />}
      {inner.map(s => (
        <ScriptAttributesEditor key={s.node.id} node={s.node} overridable lockPrivate
          section={`${s.path} · ${s.asset.name}`} persistScope={`${templateId}:${s.path}`} />
      ))}
    </>
  )
}
