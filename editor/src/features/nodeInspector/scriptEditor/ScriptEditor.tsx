import Collapsable from '../../../components/Collapsable'
import ScriptSelector from './ScriptSelector'
import CodeEditor from './CodeEditor'
import ScriptDescription from './ScriptDescription'

export default function ScriptEditor() {

  return (
    <Collapsable title='Script Editor'>
      <ScriptSelector />
      <ScriptDescription />
      <CodeEditor />
    </Collapsable>
  )
}
