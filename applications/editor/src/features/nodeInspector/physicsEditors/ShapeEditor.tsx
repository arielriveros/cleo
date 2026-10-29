import React, { useEffect, useRef } from 'react';
import type { HullQuality } from 'cleo';
import { ShapeDescription } from '../../EngineContext';
import { HULL_QUALITIES } from './hullQuality';
import { PRIMITIVE_SHAPE_TYPES, shapeTypeLabel, type PrimitiveShapeType } from './shapeListOps';
import { MIN_SHAPE_SIZE } from '../../gizmo/collisionGizmoMath';
import {
  PropertyTable, PropertyRow, OptionalNumberInput, Button, VectorInput, SegmentedControl, Hint, SectionTitle, Popover,
  MenuItem, cn,
} from '@cleo/app-kit/ui';

const CAPSULE_HEIGHT_HINT = 'Total height, spanning the caps too: the straight section is height − 2 × radius. At or below 2 × radius the shape is a sphere — raise the height to get a capsule.';

// Glyphs for the row header, in the inspector's section-icon style (15 px, stroke currentColor).
const S = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' {...props} />
);
const TYPE_ICONS: Record<ShapeDescription['type'], React.ReactNode> = {
  box: <S><path d='M12 3l8 4.5v9L12 21l-8-4.5v-9Z' /><path d='M4 7.5l8 4.5 8-4.5M12 12v9' /></S>,
  sphere: <S><circle cx='12' cy='12' r='8.5' /><ellipse cx='12' cy='12' rx='8.5' ry='3.2' /></S>,
  capsule: <S><rect x='7' y='2.5' width='10' height='19' rx='5' /><path d='M7 9.5c3 1.5 7 1.5 10 0' /></S>,
  cylinder: <S><ellipse cx='12' cy='5.5' rx='7' ry='2.5' /><path d='M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13' /></S>,
  plane: <S><path d='M3 16l6-6h12l-6 6Z' /><path d='M12 13V4M10 6l2-2 2 2' /></S>,
  convex: <S><path d='M12 2.5l7.5 5-1.5 9.5-6 4.5-6-4.5L4.5 7.5Z' /><path d='M4.5 7.5 12 11l7.5-3.5M12 11v10.5' /></S>,
};
const FrameIcon = () => <S><path d='M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5' /><circle cx='12' cy='12' r='2.5' /></S>;
const MoreIcon = () => <S><circle cx='5.5' cy='12' r='1.2' fill='currentColor' /><circle cx='12' cy='12' r='1.2' fill='currentColor' /><circle cx='18.5' cy='12' r='1.2' fill='currentColor' /></S>;
const Caret = ({ open }: { open: boolean }) => (
  <S width='11' height='11' className={cn('transition-transform', open ? 'rotate-90' : '')}><path d='M9 6l6 6-6 6' /></S>
);

/**
 * A size field. A draft while focused, so "0.5" can be typed through "0." without the minimum snapping
 * it to 0.001 mid-word; whatever parses is clamped to {@link MIN_SHAPE_SIZE} on the way out.
 */
const Size = ({ value, onChange, step = 0.01 }: { value: number; onChange: (v: number) => void; step?: number }) => (
  <OptionalNumberInput value={value} step={step} min={MIN_SHAPE_SIZE}
    onChange={(v) => { if (v !== undefined) onChange(Math.max(MIN_SHAPE_SIZE, v)); }} />
);
const Segments = ({ value, onChange }: { value: number; onChange: (v: number) => void }) => (
  <OptionalNumberInput value={value} step={1} min={3}
    onChange={(v) => { if (v !== undefined) onChange(Math.max(3, Math.round(v))); }} />
);

export interface ShapeRowActions {
  select: () => void;
  frame: () => void;
  duplicate: () => void;
  remove: () => void;
  /** Absent at the ends of the list. */
  moveUp?: () => void;
  moveDown?: () => void;
  convert: (type: PrimitiveShapeType) => void;
  /** Absent when the node has no mesh to fit to, or the shape cannot be fitted (a plane, a hull). */
  fit?: () => void;
  /** "Copy to trigger" / "Copy to rigid body"; absent when the other channel cannot take it. */
  copy?: { label: string; run: () => void };
  /** Rebuild a convex hull at a new definition, in place. Absent when the node has no usable mesh. */
  regenerateHull?: (quality: HullQuality) => boolean;
}

/**
 * One row of the shape list: a header that selects the shape (and with it the viewport's handles), and,
 * open, the shape's fields. `setShape` receives the patched descriptor and a key naming what changed, so
 * a scrub of one field coalesces into one undo step.
 */
export default function ShapeEditor(props: {
  shape: ShapeDescription;
  title: string;
  selected: boolean;
  open: boolean;
  onToggleOpen: () => void;
  setShape: (shape: ShapeDescription, field: string) => void;
  actions: ShapeRowActions;
}) {
  const s = props.shape;
  const { actions } = props;
  const patch = (p: Partial<ShapeDescription>) => props.setShape({ ...s, ...p } as ShapeDescription, Object.keys(p).join(','));
  const rowRef = useRef<HTMLDivElement>(null);

  // A shape picked in the viewport brings its row into view.
  useEffect(() => { if (props.selected) rowRef.current?.scrollIntoView({ block: 'nearest' }); }, [props.selected]);

  return (
    <div ref={rowRef} className={cn('w-full rounded border mb-1.5', props.selected ? 'border-highlight bg-highlight/10' : 'border-border-subtle')}>
      <div className='flex items-center gap-1 px-1 py-0.5 cursor-pointer select-none' onClick={actions.select}
        title='Select this shape: the viewport shows its handles and the move/rotate gizmo drives its offset and rotation.'>
        <button type='button' className='p-0.5 text-muted hover:text-fg' aria-label={props.open ? 'Collapse' : 'Expand'}
          onClick={(e) => { e.stopPropagation(); props.onToggleOpen(); }}>
          <Caret open={props.open} />
        </button>
        <span className={cn('shrink-0', props.selected ? 'text-highlight' : 'text-muted')}>{TYPE_ICONS[s.type]}</span>
        {/* Every row shares the docs' one entry for a shape card; the title itself is dynamic. */}
        <SectionTitle title={props.title} doc='editor/physics#shapes::Shape' className='flex-1 min-w-0 truncate' />
        <Button variant='ghost' size='icon' title='Select and frame in the viewport'
          onClick={(e) => { e.stopPropagation(); actions.frame(); }}><FrameIcon /></Button>
        <span onClick={(e) => e.stopPropagation()}>
          <Popover align='right' title='Shape actions' className='p-1 w-[200px]'
            trigger={<span className='inline-flex p-1 text-muted hover:text-fg'><MoreIcon /></span>}>
            {close => (
              <div className='flex flex-col'>
                <MenuItem onClick={() => { actions.duplicate(); close(); }}>Duplicate</MenuItem>
                <MenuItem disabled={!actions.moveUp} onClick={() => { actions.moveUp?.(); close(); }}>Move up</MenuItem>
                <MenuItem disabled={!actions.moveDown} onClick={() => { actions.moveDown?.(); close(); }}>Move down</MenuItem>
                <MenuItem disabled={!actions.fit} hint='Re-size to the mesh, along the shape’s own axes'
                  onClick={() => { actions.fit?.(); close(); }}>Fit to mesh</MenuItem>
                {PRIMITIVE_SHAPE_TYPES.filter(t => t !== s.type).map(t => (
                  <MenuItem key={t} icon={TYPE_ICONS[t]} onClick={() => { actions.convert(t); close(); }}>
                    Convert to {shapeTypeLabel(t).toLowerCase()}
                  </MenuItem>
                ))}
                {actions.copy && <MenuItem onClick={() => { actions.copy!.run(); close(); }}>{actions.copy.label}</MenuItem>}
                <MenuItem danger onClick={() => { actions.remove(); close(); }}>Remove</MenuItem>
              </div>
            )}
          </Popover>
        </span>
        <Button variant='remove' size='icon' title='Remove this shape'
          onClick={(e) => { e.stopPropagation(); actions.remove(); }}>✕</Button>
      </div>

      {props.open && <div className='px-2 pb-2'>
        <PropertyTable columns={['30%', '70%']}>
          {s.type === 'box' && <>
            <PropertyRow label='Width'><Size value={s.width} onChange={(v) => patch({ width: v })} /></PropertyRow>
            <PropertyRow label='Height'><Size value={s.height} onChange={(v) => patch({ height: v })} /></PropertyRow>
            <PropertyRow label='Depth'><Size value={s.depth} onChange={(v) => patch({ depth: v })} /></PropertyRow>
          </>}
          {s.type === 'sphere' &&
            <PropertyRow label='Radius'><Size value={s.radius} onChange={(v) => patch({ radius: v })} /></PropertyRow>
          }
          {s.type === 'cylinder' && <>
            <PropertyRow label='Radius'><Size value={s.radius} onChange={(v) => patch({ radius: v })} /></PropertyRow>
            <PropertyRow label='Height'><Size value={s.height} onChange={(v) => patch({ height: v })} /></PropertyRow>
            <PropertyRow label='Segments'><Segments value={s.numSegments} onChange={(v) => patch({ numSegments: v })} /></PropertyRow>
          </>}
          {s.type === 'capsule' && <>
            <PropertyRow label='Radius'><Size value={s.radius} onChange={(v) => patch({ radius: v })} /></PropertyRow>
            {/* Labelled "Total" because it spans the caps too (as in Unity/Godot): the straight section is
                height - 2*radius, and there is no way to read that off a bare "Height". */}
            <PropertyRow label='Total Height' hint={CAPSULE_HEIGHT_HINT}><Size value={s.height} onChange={(v) => patch({ height: v })} /></PropertyRow>
            <PropertyRow label='Segments'><Segments value={s.numSegments} onChange={(v) => patch({ numSegments: v })} /></PropertyRow>
          </>}
          {s.type === 'convex' && <>
            <PropertyRow label='Definition'>
              { actions.regenerateHull
                ? <SegmentedControl
                    size='sm' grow options={HULL_QUALITIES} value={s.quality}
                    onChange={(v) => actions.regenerateHull!(v as HullQuality)}
                  />
                : <Hint>Source mesh unavailable.</Hint> }
            </PropertyRow>
            <PropertyRow label='Geometry'>
              <span className='text-ui text-muted tabular-nums'>{s.vertices.length} vertices · {s.faces.length} faces</span>
            </PropertyRow>
          </>}
          <PropertyRow label='Offset'>
            <VectorInput value={[s.offset[0], s.offset[1], s.offset[2]]} step={0.01} reset={[0, 0, 0]} onChange={(v) => patch({ offset: [v[0], v[1], v[2]] })} />
          </PropertyRow>
          <PropertyRow label='Rotation' divider={false}>
            <VectorInput value={[s.rotation[0], s.rotation[1], s.rotation[2]]} step={0.1} min={-180} max={180} reset={[0, 0, 0]} onChange={(v) => patch({ rotation: [v[0], v[1], v[2]] })} />
          </PropertyRow>
        </PropertyTable>
      </div>}
    </div>
  );
}
