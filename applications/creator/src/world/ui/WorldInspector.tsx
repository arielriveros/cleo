// The selected graph node's parameters: its name, its presets (the erosion filter's looks), the main
// parameters and an Advanced section, and for a Paint Mask node the mask it reads and the brush. Edits
// go back as parameter patches; `coalesce` marks a slider drag (one undo step, a realtime frame each).

import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import { Button, Collapsable, SegmentedControl, Select, Slider, TextInput, Toggle } from '@cleo/app-kit/ui';
import type { GraphNode } from '../graph/graphDoc';
import { nodeType } from '../graph/nodeRegistry';
import type { PaintMaskMeta } from '../paint';
import type { Brush, BrushMode } from './paint/paintBrush';
import { NodeGlyph } from './graph/nodeIcons';
import { HAS_CENTER, HAS_POINTS } from './worldSchemas';

export interface PaintTools {
  masks: readonly PaintMaskMeta[];
  /** The brush is on: the Map and the landscape paint the selected node's mask. */
  active: boolean;
  setActive: (on: boolean) => void;
  brush: Brush;
  setBrush: (b: Brush) => void;
  /** A new blank mask (signed: -1..1 for raise / lower), assigned to the node; returns its id. */
  newMask: (signed: boolean) => void;
  fill: (maskId: string, value: number) => void;
}

const MODES: { value: BrushMode; label: string; title: string }[] = [
  { value: 'add', label: 'Add', title: 'Paint toward full' },
  { value: 'subtract', label: 'Erase', title: 'Paint toward empty (or -1 on a signed mask)' },
  { value: 'smooth', label: 'Smooth', title: 'Soften what is there' },
  { value: 'set', label: 'Set', title: 'Paint toward a value' },
];

export function WorldInspector({ node, onParams, onRename, paint, info }: {
  node: GraphNode | null;
  onParams: (patch: Record<string, unknown>, coalesce?: boolean) => void;
  onRename: (name: string) => void;
  paint: PaintTools;
  /** One line about the node's last run (time, pending). */
  info?: string;
}) {
  if (!node) return <div className='text-dim text-ui-sm'>Select a node on the Graph to edit it. Right-click the Graph to add one.</div>;
  const t = nodeType(node.type);
  if (!t) return <div className='text-dim text-ui-sm'>Unknown node type "{node.type}": it passes its input through.</div>;
  const values = { ...t.defaults(), ...node.params };
  const advanced = new Set(t.advanced ?? []);
  const main = t.schema.filter(s => !advanced.has(s.key));
  const adv = t.schema.filter(s => advanced.has(s.key));
  const maskId = typeof node.params.mask === 'string' ? node.params.mask : '';
  const mask = paint.masks.find(m => m.id === maskId) ?? null;
  return (
    <div className='flex flex-col gap-1'>
      <div className='flex items-center gap-2 pb-1'>
        <span className='text-primary'><NodeGlyph icon={t.icon} className='w-4 h-4' /></span>
        <TextInput value={node.name} onChange={onRename} className='flex-1' title='Name (layout only: renaming re-runs nothing)' />
      </div>
      <div className='text-ui-xs text-dim pb-1'>{t.label}: {t.description}</div>
      {info && <div className='text-ui-xs text-muted pb-1 tabular-nums'>{info}</div>}
      {t.presets && (
        <div className='flex items-center gap-2 pb-1'>
          <span className='text-ui-sm text-muted w-[42%]'>Look</span>
          <Select value='' className='flex-1' onChange={e => {
            const p = t.presets!.find(x => x.id === e.target.value);
            if (p) onParams({ ...p.params, seed: values.seed });
          }}>
            <option value=''>Apply a preset…</option>
            {t.presets.map(p => <option key={p.id} value={p.id} title={p.description}>{p.label}</option>)}
          </Select>
        </div>
      )}
      {main.length > 0 && <ParamForm schema={main} values={values} onChange={(patch, c) => onParams(patch, c)} />}
      {adv.length > 0 && (
        <Collapsable title='Advanced' defaultOpen={false} persistKey={`cleo_creator_world_adv_${node.type}`}>
          <ParamForm schema={adv} values={values} onChange={(patch, c) => onParams(patch, c)} />
        </Collapsable>
      )}
      {(HAS_CENTER.has(node.type) || HAS_POINTS.has(node.type)) && (
        <div className='text-ui-xs text-dim mt-1'>
          {HAS_POINTS.has(node.type) ? 'Edit its spline on the Map: drag a point, double-click to add one, Alt+click to remove one.' : 'Drag its centre on the Map.'}
        </div>
      )}
      {node.type === 'paint' && (
        <Collapsable title='Mask and brush' persistKey='cleo_creator_world_paint'>
          <div className='flex items-center gap-2 py-1'>
            <Select value={maskId} className='flex-1' onChange={e => onParams({ mask: e.target.value })}>
              <option value=''>No mask</option>
              {paint.masks.map(m => <option key={m.id} value={m.id}>{m.name}{m.signed ? ' (signed)' : ''} · {m.resolution}²</option>)}
            </Select>
            <Button size='sm' title='A new blank mask (0..1): where erosion bites, where a layer shows' onClick={() => paint.newMask(false)}>New</Button>
            <Button size='sm' title='A new signed mask (-1..1): raise and lower the ground through the Height output' onClick={() => paint.newMask(true)}>Signed</Button>
          </div>
          {mask && (
            <>
              <div className='flex items-center justify-between py-1'>
                <span className='text-ui-sm'>Paint</span>
                <Toggle checked={paint.active} onChange={paint.setActive} />
              </div>
              <div className='text-ui-xs text-dim pb-1'>Brush on the Map or on the landscape. [ and ] change the size.</div>
              <SegmentedControl<BrushMode> size='sm' grow joined value={paint.brush.mode}
                                           options={MODES.map(m => ({ value: m.value, label: m.label, title: m.title }))}
                                           onChange={mode => paint.setBrush({ ...paint.brush, mode })} />
              <Slider label='Radius (m)' min={2} max={2000} step={1} value={paint.brush.radius} onChange={v => paint.setBrush({ ...paint.brush, radius: v })} />
              <Slider label='Strength' min={0.01} max={1} step={0.01} value={paint.brush.strength} onChange={v => paint.setBrush({ ...paint.brush, strength: v })} />
              <Slider label='Falloff' min={0} max={1} step={0.01} value={paint.brush.falloff} onChange={v => paint.setBrush({ ...paint.brush, falloff: v })} />
              {paint.brush.mode === 'set' && (
                <Slider label='Value' min={mask.signed ? -1 : 0} max={1} step={0.01} value={paint.brush.value} onChange={v => paint.setBrush({ ...paint.brush, value: v })} />
              )}
              <div className='flex gap-1 pt-1'>
                <Button size='sm' title='Empty the whole mask' onClick={() => paint.fill(mask.id, 0)}>Clear</Button>
                <Button size='sm' title='Fill the whole mask' onClick={() => paint.fill(mask.id, 1)}>Fill</Button>
                {mask.signed && <Button size='sm' title='Fill the whole mask with -1' onClick={() => paint.fill(mask.id, -1)}>Fill -1</Button>}
              </div>
            </>
          )}
        </Collapsable>
      )}
    </div>
  );
}
