import type { DecalNode } from 'cleo';
import Collapsable from '@cleo/app-kit/ui/Collapsable';
import { Hint } from '@cleo/app-kit/ui';
import { DecalIcon } from '../sectionIcons';
import DeclaredSections from '../../properties/DeclaredSections';

// The Decal inspector: the decal's declared properties (src/properties/decals.ts), its flipbook while it draws
// its material and its radial pattern instead, and the one limit that surprises people most.

export default function DecalEditor(props: { node: DecalNode }) {
  return (
    <Collapsable title='Decal' icon={<DecalIcon />} persistKey='decal'>
      <div className='w-full p-2'>
        <DeclaredSections node={props.node} />
        <Hint className='mt-2'>
          Surface decals do not show on Default (Blinn-Phong) or Cel materials, which are shaded forward — only emissive does.
        </Hint>
      </div>
    </Collapsable>
  );
}
