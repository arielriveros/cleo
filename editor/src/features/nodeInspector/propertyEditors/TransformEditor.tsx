import { useEffect, useState } from 'react';
import { Node } from 'cleo';
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

  useEffect(() => {
    props.node.setPosition(position);
    props.node.setRotation(rotation);
    props.node.setScale(scale);

  }, [position, rotation, scale]);

  const reset = () => {
    setPosition([0, 0, 0]);
    setRotation([0, 0, 0]);
    setScale([1, 1, 1]);
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
            <VectorInput step={0.01} reset={[0, 0, 0]} value={[position[0], position[1], position[2]]} onChange={(v) => setPosition(v as any)} />
          </PropertyRow>
          <PropertyRow label='Rotation'>
            <VectorInput step={0.1} min={-180} max={180} reset={[0, 0, 0]} value={[rotation[0], rotation[1], rotation[2]]} onChange={(v) => setRotation(v as any)} />
          </PropertyRow>
          <PropertyRow label='Scale'>
            <VectorInput step={0.01} reset={[1, 1, 1]} value={[scale[0], scale[1], scale[2]]} onChange={(v) => setScale(v as any)} />
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
