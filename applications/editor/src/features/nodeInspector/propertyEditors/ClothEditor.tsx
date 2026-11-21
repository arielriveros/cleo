import { ClothNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { ClothIcon } from '../sectionIcons'
import DeclaredSections from '../../properties/DeclaredSections'

// The Cloth inspector: the cloth's declared options (src/properties/effects.ts). The panel hangs in the node's
// local XY plane, so where it hangs and which way it faces are the node's transform — the gizmo places it, and
// there is no vector here.

export default function ClothEditor(props: { node: ClothNode }) {
  return (
    <Collapsable title='Cloth' icon={<ClothIcon />} persistKey='clothEditor'>
      <div className='w-full p-2'>
        <DeclaredSections node={props.node} of={ClothNode} />
      </div>
    </Collapsable>
  )
}
