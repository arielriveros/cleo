import type { HullQuality } from 'cleo';
import { ShapeDescription } from '../../EngineContext';
import { HULL_QUALITIES } from './hullQuality';
import { PropertyTable, PropertyRow, NumberInput, Section, Button, VectorInput, SegmentedControl, Hint } from '../../../components/ui';

export default function ShapeEditor(props: {
  shape: ShapeDescription;
  setShape: (shape: any) => void;
  removeShape: () => void;
  /** Rebuild a convex hull at a new definition, in place. Absent when the node has no usable mesh. */
  regenerateHull?: (quality: HullQuality) => boolean;
}) {
  const s = props.shape;
  const patch = (p: any) => props.setShape({ ...s, ...p });
  const title = s.type === 'convex' ? 'Convex Hull' : s.type.charAt(0).toUpperCase() + s.type.slice(1);

  return (
    <div className='w-full p-2'>
      <Section title={title}>
        <PropertyTable columns={['30%', '70%']}>
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
          {s.type === 'capsule' && <>
            <PropertyRow label='Radius'><NumberInput value={s.radius} step={0.01} onChange={(v) => patch({ radius: Math.max(0.001, v) })} /></PropertyRow>
            {/* Labelled "Total" because it spans the caps too (as in Unity/Godot): the straight section is
                height - 2*radius, and there is no way to read that off a bare "Height". */}
            <PropertyRow label='Total Height'><NumberInput value={s.height} step={0.01} onChange={(v) => patch({ height: Math.max(0, v) })} /></PropertyRow>
            <PropertyRow label='Segments'><NumberInput value={s.numSegments} step={1} onChange={(v) => patch({ numSegments: Math.max(3, Math.round(v)) })} /></PropertyRow>
            { s.height <= 2 * s.radius &&
              <PropertyRow label=''>
                <Hint>Total height is at or below 2 × radius, so this is a sphere. Raise the height to get a capsule.</Hint>
              </PropertyRow> }
          </>}
          {s.type === 'convex' && <>
            <PropertyRow label='Definition'>
              { props.regenerateHull
                ? <SegmentedControl
                    size='sm' grow options={HULL_QUALITIES} value={s.quality}
                    onChange={(v) => props.regenerateHull!(v as HullQuality)}
                  />
                : <Hint>Source mesh unavailable.</Hint> }
            </PropertyRow>
            <PropertyRow label='Geometry'>
              <span className='text-xs text-muted tabular-nums'>{s.vertices.length} vertices · {s.faces.length} faces</span>
            </PropertyRow>
          </>}
          <PropertyRow label='Offset'>
            <VectorInput value={[s.offset[0], s.offset[1], s.offset[2]]} step={0.01} reset={[0, 0, 0]} onChange={(v) => patch({ offset: [v[0], v[1], v[2]] })} />
          </PropertyRow>
          <PropertyRow label='Rotation' divider={false}>
            <VectorInput value={[s.rotation[0], s.rotation[1], s.rotation[2]]} step={0.1} min={-180} max={180} reset={[0, 0, 0]} onChange={(v) => patch({ rotation: [v[0], v[1], v[2]] })} />
          </PropertyRow>
        </PropertyTable>
      </Section>
      <Button size='sm' variant='danger' onClick={() => props.removeShape()}>Remove</Button>
    </div>
  );
}
