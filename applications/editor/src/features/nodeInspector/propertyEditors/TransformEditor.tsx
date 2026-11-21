import { Node } from 'cleo';
import Collapsable from '@cleo/app-kit/ui/Collapsable';
import { Button } from '@cleo/app-kit/ui';
import { TransformIcon } from '../sectionIcons';
import { useLiveTick } from '../useSelectedNode';
import { useEventBus } from '../../EventBusContext';
import { DeclaredSection } from '../../properties/DeclaredSections';

// The Transform card: every node's declared Transform (src/properties/transform.ts). The node is written from a
// row's edit only, never from an effect: selecting a node used to mark its tab unsaved that way.

export default function TransformEditor(props: { node: Node }) {
  const eventEmitter = useEventBus();
  // Ticks only while Simulating: the running game moves the node every frame without emitting anything.
  useLiveTick();

  const reset = () => {
    props.node.setPosition([0, 0, 0]);
    props.node.setRotation([0, 0, 0]);
    props.node.setScale([1, 1, 1]);
    eventEmitter.emit('SCENE_CHANGED', { kind: 'transform', node: props.node });
  };

  return (
    <Collapsable title='Transform' icon={<TransformIcon />} persistKey='transform'>
      <div className='w-full text-fg p-2'>
        <DeclaredSection node={props.node} of={Node} title='' columns={['28%', '72%']} />
        <Button className='mt-2' size='sm' onClick={reset}>Reset</Button>
      </div>
    </Collapsable>
  );
}
