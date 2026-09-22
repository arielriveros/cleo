import { useEffect, useState } from 'react';
import { Node, Vec } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import { PropertyTable, PropertyRow, VectorInput, Button } from '../../../components/ui';
import { TransformIcon } from '../sectionIcons';

export default function TransformEditor(props: {node: Node}) {

  const [position, setPosition] = useState(props.node.position);
  const [rotation, setRotation] = useState(props.node.rotation);
  const [scale, setScale] = useState(props.node.scale);

  useEffect(() => {
      setPosition(props.node.position);
      setRotation(props.node.rotation);
      setScale(props.node.scale);
  }, [props.node]);

  // The node is written from the change handlers, never from an effect. An effect runs on mount and on every
  // selection change, and each setter emits a `transform` change. That is how merely SELECTING a node used to
  // mark its tab unsaved. Writing the rotation back also round-trips a quaternion-authored orientation
  // through Euler angles.
  const changePosition = (v: Vec.vec3) => { setPosition(v); props.node.setPosition(v); };
  const changeRotation = (v: Vec.vec3) => { setRotation(v); props.node.setRotation(v); };
  const changeScale = (v: Vec.vec3) => { setScale(v); props.node.setScale(v); };

  const reset = () => {
    changePosition([0, 0, 0]);
    changeRotation([0, 0, 0]);
    changeScale([1, 1, 1]);
  }

  const readonlyVec = (v: ArrayLike<number>) => (
    <div className='inline-flex gap-2 text-muted tabular-nums'>
      {Array.from(v).map((value, index) => (<span key={index}>{value.toFixed(2)}</span>))}
    </div>
  );

  return (
    <Collapsable title='Transform' icon={<TransformIcon />} persistKey='transform'>
      <div className='w-full text-white p-2'>
        <PropertyTable columns={['28%', '72%']}>
          <PropertyRow label='Position'>
            <VectorInput step={0.01} reset={[0, 0, 0]} value={[position[0], position[1], position[2]]} onChange={(v) => changePosition(v as any)} />
          </PropertyRow>
          <PropertyRow label='Rotation'>
            <VectorInput step={0.1} min={-180} max={180} reset={[0, 0, 0]} value={[rotation[0], rotation[1], rotation[2]]} onChange={(v) => changeRotation(v as any)} />
          </PropertyRow>
          <PropertyRow label='Scale'>
            <VectorInput step={0.01} reset={[1, 1, 1]} value={[scale[0], scale[1], scale[2]]} onChange={(v) => changeScale(v as any)} />
          </PropertyRow>
          <PropertyRow label='World Position'>{readonlyVec(props.node.worldPosition)}</PropertyRow>
          <PropertyRow label='Quaternion'>{readonlyVec(props.node.quaternion)}</PropertyRow>
          <PropertyRow label='World Quaternion' divider={false}>{readonlyVec(props.node.worldQuaternion)}</PropertyRow>
        </PropertyTable>
        <Button className='mt-2' size='sm' onClick={reset}>Reset</Button>
      </div>
    </Collapsable>
  )
}
