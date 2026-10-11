import { useCleoEngine } from '../EngineContext'
import { useSelectedNode } from './useSelectedNode'
import { templateInstanceRootOf } from '../../utils/templates'
import { overrideCount } from '../../utils/templateOverrides'

export default function TemplateInstanceNotice(props: { revert?: boolean }) {
  const { revertTemplateOverride } = useCleoEngine()
  const { node } = useSelectedNode()
  const root = templateInstanceRootOf(node)
  const count = root ? overrideCount(root) : 0
  return (
    <div className='text-[11px] text-warning bg-warning/15 px-2 py-1 flex items-center gap-2'>
      <span className='flex-1'>
        Template instance. Its Transform, its name and its script values are this placement's own; edit the
        template to change anything else.
        {count > 0 && ` ${count} override${count === 1 ? '' : 's'}.`}
      </span>
      {props.revert && root && count > 0 &&
        <button type='button' className='shrink-0 underline hover:no-underline'
          title="Drop every override on this instance and take the template's values"
          onClick={() => revertTemplateOverride(root, undefined, true)}>
          Revert all
        </button>}
    </div>
  )
}
