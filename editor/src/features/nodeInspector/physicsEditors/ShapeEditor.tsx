import { ShapeDescription } from '../../EngineContext';
import AxisInput from '../../../components/AxisInput';
import { PropertyTable, PropertyRow, NumberInput, Section, Button } from '../../../components/ui';

export default function ShapeEditor(props: {
  shape: ShapeDescription;
  setShape: (shape: any) => void;
  removeShape: () => void;
}) {
  const s = props.shape;
  const patch = (p: any) => props.setShape({ ...s, ...p });
  const title = s.type.charAt(0).toUpperCase() + s.type.slice(1);

  return (
    <div className='w-full p-2'>
      <Section title={title}>
        <PropertyTable columns={['45%', '55%']}>
          {s.type === 'box' && <>
            <PropertyRow label='Width'><NumberInput value={s.width} step={0.01} onChange={(v) => patch({ width: v })} /></PropertyRow>
            <PropertyRow label='Height'><NumberInput value={s.height} step={0.01} onChange={(v) => patch({ height: v })} /></PropertyRow>
            <PropertyRow label='Depth'><NumberInput value={s.depth} step={0.01} onChange={(v) => patch({ depth: v })} /></PropertyRow>
          </>}
          {s.type === 'sphere' &&
            <PropertyRow label='Radius'><NumberInput value={s.radius} step={0.01} onChange={(v) => patch({ radius: v })} /></PropertyRow>
          }
          {s.type === 'cylinder' && <>
            <PropertyRow label='Radius'><NumberInput value={s.radius} step={0.01} onChange={(v) => patch({ radius: v })} /></PropertyRow>
            <PropertyRow label='Height'><NumberInput value={s.height} step={0.01} onChange={(v) => patch({ height: v })} /></PropertyRow>
            <PropertyRow label='Segments'><NumberInput value={s.numSegments} step={1} onChange={(v) => patch({ numSegments: Math.round(v) })} /></PropertyRow>
          </>}
          <PropertyRow label='Offset'>
            <AxisInput value={[s.offset[0], s.offset[1], s.offset[2]]} step={0.01} onChange={(v) => patch({ offset: [v[0], v[1], v[2]] })} />
          </PropertyRow>
          <PropertyRow label='Rotation' divider={false}>
            <AxisInput value={[s.rotation[0], s.rotation[1], s.rotation[2]]} step={0.1} min={-180} max={180} onChange={(v) => patch({ rotation: [v[0], v[1], v[2]] })} />
          </PropertyRow>
        </PropertyTable>
      </Section>
      <Button size='sm' variant='danger' onClick={() => props.removeShape()}>Remove</Button>
    </div>
  );
}
