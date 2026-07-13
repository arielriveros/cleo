import Collapsable from '../../../components/Collapsable'
import CodeEditor from './CodeEditor'
import CustomVariablesEditor from './CustomVariablesEditor'
import TemplateInstanceNotice from '../TemplateInstanceNotice'
import { useSelectedNode, isRootNode } from '../useSelectedNode'

export default function ScriptEditor() {
  const { node, readOnly } = useSelectedNode()

  return (
    <>
      {readOnly && <TemplateInstanceNotice />}
      {/* Variables sit above the code: they are the data the script reads through getData/setData.
          The fieldset covers them only — CodeEditor drives its own read-only compartment because
          contentEditable ignores `fieldset disabled`. */}
      {node && !isRootNode(node) &&
        <fieldset disabled={readOnly} className={`${readOnly ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`}>
          <CustomVariablesEditor node={node} />
        </fieldset>}
      <Collapsable title='Script Editor'>
        <CodeEditor readOnly={readOnly} />
      </Collapsable>
    </>
  )
}
