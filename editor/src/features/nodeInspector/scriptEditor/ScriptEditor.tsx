import Collapsable from '../../../components/Collapsable'
import CodeEditor from './CodeEditor'

export default function ScriptEditor(props: { readOnly?: boolean }) {

  return (
    <Collapsable title='Script Editor'>
      <CodeEditor readOnly={props.readOnly} />
    </Collapsable>
  )
}
