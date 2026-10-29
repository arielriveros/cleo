import { useCleoEngine } from '../EngineContext'
import { useSelectedNode } from './useSelectedNode'
import { templateInstanceRootOf } from '../../utils/templates'
import { overrideCount } from '../../utils/templateOverrides'
import { Button } from '@cleo/app-kit/ui'

export default function TemplateInstanceNotice(props: { revert?: boolean }) {
  const { revertTemplateOverride, createVariantFromInstance } = useCleoEngine()
  const { node } = useSelectedNode()
  const root = templateInstanceRootOf(node)
  const count = root ? overrideCount(root) : 0
  return (
    <div className='text-ui-sm text-warning bg-warning/15 px-2 py-1 flex items-center gap-2'>
      <span className='flex-1'>
        Template instance. Its Transform, its name and its script values are this placement's own; edit the
        template to change anything else.
        {count > 0 && ` ${count} override${count === 1 ? '' : 's'}.`}
      </span>
      {props.revert && root && count > 0 &&
        <Button variant='link' size='sm' className='shrink-0 text-warning'
          title="Drop every override on this instance and take the template's values"
          onClick={() => revertTemplateOverride(root, undefined, true)}>
          Revert all
        </Button>}
      {props.revert && root &&
        <Button variant='link' size='sm' className='shrink-0 text-warning'
          title="Save this copy, with its overrides, as a new variant of its template — and link the copy to it"
          onClick={() => void createVariantFromInstance(root)}>
          Make variant
        </Button>}
    </div>
  )
}
