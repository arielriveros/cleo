import { useMemo } from 'react';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import { rgbToHex } from '@cleo/app-kit/params/ParamField';
import { RangeFalloffField } from '@cleo/app-kit/params/RangeFalloffField';
import { Button, Collapsable, ColorInput, Select, Slider, TextInput, Toggle } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { ListRow } from '../../app/workspace';
import { SURFACE_KINDS, surfaceKindInfo, type SurfaceKind } from '../../surfaces/kinds';
import {
  INPUT_INFO, MAX_SURFACES, newCondition, SURFACE_INPUTS,
  type FieldScale, type SurfaceCondition, type SurfaceInput, type SurfaceLayer,
} from '../surfaces/surfaceDoc';
import { BIOME_SETS, SURFACE_PRESETS, surfacePreset, type SurfacePresetId } from '../surfaces/presets';
import type { PreviewFields } from '../worldWorker';
import type { SurfaceAlphas } from '../surfaces/evaluate';

// The Surfaces: a section of the left dock listing the stack (top first, the base pinned at the bottom,
// as the editor's landscape Layers panel lists slots), and the selected surface's editor for the
// Parameters tab: its conditions over the terrain's values, the breakup and post steps, and how the
// Creator previews it.

const swatch = (s: SurfaceLayer) => rgbToHex(surfaceKindInfo(s.preview.kind).color.map((c, j) => Math.pow(Math.min(1, c * s.preview.tint[j]), 1 / 2.2)));

export function SurfacesSection({ surfaces, onChange, selected, select, coverage, row }: {
  surfaces: SurfaceLayer[];
  onChange: (next: SurfaceLayer[]) => void;
  selected: string | null;
  select: (id: string | null) => void;
  /** Each surface's share of the map (doc order), from the preview. */
  coverage: Map<string, number>;
  row?: never;
}) {
  void row;
  const add = (id: SurfacePresetId) => {
    if (surfaces.length >= MAX_SURFACES) { toast.error(`A landscape draws at most ${MAX_SURFACES} surfaces.`); return; }
    const s = surfacePreset(id);
    onChange([...surfaces, s]);
    select(s.id);
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (i === 0 || j < 1 || j >= surfaces.length) return;
    const out = [...surfaces];
    [out[i], out[j]] = [out[j], out[i]];
    onChange(out);
  };
  const order = surfaces.map((_, i) => i).reverse();
  return (
    <Collapsable title='Surfaces' persistKey='cleo_creator_world_layers_surfaces' right={
      <Select value='' className='w-[76px]' onChange={e => {
        const v = e.target.value;
        const b = BIOME_SETS.find(x => 'biome:' + x.id === v);
        if (b) { onChange(b.make()); select(null); toast.success(`Surfaces: ${b.label}.`); return; }
        if (v) add(v as SurfacePresetId);
      }}>
        <option value=''>+ Add</option>
        {SURFACE_PRESETS.map(p => <option key={p.id} value={p.id} title={p.description}>{p.label}</option>)}
        <optgroup label='Replace all with a biome'>
          {BIOME_SETS.map(b => <option key={b.id} value={'biome:' + b.id} title={b.description}>{b.label}</option>)}
        </optgroup>
      </Select>
    }>
      <div className='text-ui-xs text-dim mb-1'>Top covers bottom. What each one covers is exported; how it looks here is not.</div>
      {order.map(i => {
        const s = surfaces[i];
        const base = i === 0;
        const share = coverage.get(s.id);
        return (
          <ListRow key={s.id} selected={selected === s.id} onClick={() => select(s.id)}
                   caption={share !== undefined ? `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% of the map${base ? ' · base' : ''}` : base ? 'base' : undefined}
                   leading={base ? <span className='inline-block w-[26px]' /> : <Toggle checked={s.enabled} onChange={v => onChange(surfaces.map(x => (x.id === s.id ? { ...x, enabled: v } : x)))} />}
                   actions={base ? undefined : <>
                     <span className='hidden group-hover:flex'>
                       <Button size='icon' variant='ghost' title='Move up' onClick={() => move(i, 1)}>↑</Button>
                       <Button size='icon' variant='ghost' title='Move down' onClick={() => move(i, -1)}>↓</Button>
                     </span>
                     <Button size='icon' variant='remove' title='Remove' onClick={() => { onChange(surfaces.filter(x => x.id !== s.id)); if (selected === s.id) select(null); }}>✕</Button>
                   </>}>
            <span className='inline-flex items-center gap-1.5'>
              <span className='inline-block h-2.5 w-2.5 rounded-sm border border-border' style={{ background: swatch(s) }} />
              {s.name}
            </span>
          </ListRow>
        );
      })}
    </Collapsable>
  );
}

const BREAKUP_SCHEMA: GenericParamSpec[] = [
  { key: 'amount', label: 'Amount', kind: 'float', min: 0, max: 1, step: 0.01, hint: 'How far noise moves the soft edges. Solid coverage stays solid.' },
  { key: 'scale', label: 'Scale', kind: 'float', min: 1, max: 500, step: 1, unit: 'm', hint: 'Size of the noise features.' },
  { key: 'octaves', label: 'Octaves', kind: 'int', min: 1, max: 8 },
  { key: 'warp', label: 'Warp', kind: 'float', min: 0, max: 2, step: 0.01, hint: 'Bends the noise into folds.' },
  { key: 'seed', label: 'Seed', kind: 'int', min: 0, max: 9999 },
];

const POST_SCHEMA: GenericParamSpec[] = [
  { key: 'expand', label: 'Expand', kind: 'float', min: -50, max: 50, step: 0.5, unit: 'm', hint: 'Grow (positive) or shrink (negative) the coverage.' },
  { key: 'blur', label: 'Blur', kind: 'float', min: 0, max: 50, step: 0.5, unit: 'm', hint: 'Soften the coverage.' },
  { key: 'contrast', label: 'Contrast', kind: 'float', min: 0, max: 1, step: 0.01, hint: 'Sharpen soft edges toward a hard line.' },
  { key: 'opacity', label: 'Opacity', kind: 'float', min: 0, max: 1, step: 0.01, hint: 'The surface\'s overall strength.' },
];

const COMBINES: { value: SurfaceCondition['combine']; label: string }[] = [
  { value: 'multiply', label: 'and (multiply)' }, { value: 'max', label: 'or (max)' }, { value: 'add', label: 'add' },
  { value: 'subtract', label: 'subtract' }, { value: 'min', label: 'min' },
];

const SCALES: { value: FieldScale; label: string }[] = [{ value: 'fine', label: 'Fine' }, { value: 'medium', label: 'Medium' }, { value: 'broad', label: 'Broad' }];

const BINS = 48;

/** A field's values in the preview, for a condition's histogram and a sensible graph span. */
function fieldOf(c: SurfaceCondition, f: PreviewFields | null, surfaces: SurfaceAlphas | null, layerIndex: Map<string, number>): ArrayLike<number> | null {
  if (!f) return null;
  switch (c.input) {
    case 'height': return f.heightM;
    case 'heightAboveWater': return f.heightAboveWater;
    case 'relativeHeight': return f.relative;
    case 'slope': return f.slope;
    case 'curvature': return f.curvature[c.scale ?? 'medium'] ?? null;
    case 'cavity': return f.cavity[c.scale ?? 'medium'] ?? null;
    case 'flowArea': return f.flowArea ?? null;
    case 'wetness': return f.wetness;
    case 'waterDepth': return f.waterDepth;
    case 'shoreDistance': return f.shoreDistance;
    case 'deposits': return f.deposits;
    case 'wear': return f.wear;
    case 'talus': return f.talus;
    case 'layer': {
      const i = c.layerId ? layerIndex.get(c.layerId) : undefined;
      const a = i !== undefined ? surfaces?.alphas[i] : null;
      return a ? Array.from(a, v => v / 255) : null;
    }
    default: return null;
  }
}

/** The graph's span: the input's own for bounded ones, the data's (padded) for metres. */
function domainOf(c: SurfaceCondition, values: ArrayLike<number> | null): [number, number] {
  const d = INPUT_INFO[c.input].domain;
  if (!values || !['height', 'heightAboveWater', 'waterDepth', 'shoreDistance', 'flowArea'].includes(c.input)) return d;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i += 3) { const v = values[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return d;
  if (c.input === 'shoreDistance') { lo = Math.max(lo, -300); hi = Math.min(hi, 600); }
  const pad = (hi - lo) * 0.05;
  return [Math.floor(lo - pad), Math.ceil(hi + pad)];
}

function histogram(values: ArrayLike<number>, [lo, hi]: [number, number]): Float32Array {
  const out = new Float32Array(BINS);
  const span = hi - lo || 1;
  const stride = Math.max(1, Math.floor(values.length / 40000));
  for (let i = 0; i < values.length; i += stride) {
    const b = Math.floor(((values[i] - lo) / span) * BINS);
    if (b >= 0 && b < BINS) out[b]++;
  }
  return out;
}

function ConditionCard({ c, first, surfaces, index, fields, alphas, onChange, onRemove }: {
  c: SurfaceCondition; first: boolean; surfaces: SurfaceLayer[]; index: number;
  fields: PreviewFields | null; alphas: SurfaceAlphas | null;
  onChange: (patch: Partial<SurfaceCondition>) => void; onRemove: () => void;
}) {
  const info = INPUT_INFO[c.input];
  const layerIndex = useMemo(() => new Map(surfaces.map((s, i) => [s.id, i])), [surfaces]);
  const values = fieldOf(c, fields, alphas, layerIndex);
  const domain = domainOf(c, values);
  const hist = useMemo(() => (values ? histogram(values, domain) : null), [values, domain[0], domain[1]]);
  return (
    <div className='flex flex-col gap-1 rounded border border-border p-1.5'>
      <div className='flex items-center gap-1'>
        <Toggle checked={c.enabled} onChange={v => onChange({ enabled: v })} />
        <span className='flex-1 truncate text-ui-sm text-fg' title={info.hint}>{info.label}</span>
        {info.scaled && (
          <Select value={c.scale ?? 'medium'} title='The neighbourhood the input is measured over' onChange={e => onChange({ scale: e.target.value as FieldScale })}>
            {SCALES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        )}
        {!first && (
          <Select value={c.combine} title='How this condition joins the ones above it' onChange={e => onChange({ combine: e.target.value as SurfaceCondition['combine'] })}>
            {COMBINES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        )}
        <Button size='sm' variant={c.invert ? 'primary' : 'ghost'} title='Invert: pass where the condition does not' onClick={() => onChange({ invert: !c.invert })}>Not</Button>
        <Button size='icon' variant='remove' title='Remove the condition' onClick={onRemove}>✕</Button>
      </div>
      {c.input === 'layer' && (
        <Select value={c.layerId ?? ''} onChange={e => onChange({ layerId: e.target.value || undefined })}>
          <option value=''>Pick a surface below…</option>
          {surfaces.slice(0, index).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      )}
      {c.input === 'noise' && c.noise && (
        <div className='grid grid-cols-2 gap-x-2'>
          <Slider label='Scale (m)' min={2} max={1000} step={1} value={c.noise.scale} onChange={v => onChange({ noise: { ...c.noise!, scale: v } })} />
          <Slider label='Warp' min={0} max={2} step={0.01} value={c.noise.warp} onChange={v => onChange({ noise: { ...c.noise!, warp: v } })} />
          <Slider label='Octaves' min={1} max={8} step={1} value={c.noise.octaves} onChange={v => onChange({ noise: { ...c.noise!, octaves: Math.round(v) } })} />
          <Slider label='Seed' min={0} max={999} step={1} value={c.noise.seed} onChange={v => onChange({ noise: { ...c.noise!, seed: Math.round(v) } })} />
        </div>
      )}
      {c.input === 'aspect' ? (
        <div className='flex flex-col'>
          <Slider label='Facing (°)' min={0} max={360} step={1} value={c.goal ?? 0} onChange={v => onChange({ goal: v })}
                  readout={v => `${v.toFixed(0)}° ${compass(v)}`} />
          <Slider label='Spread (°)' min={0} max={180} step={1} value={c.spread ?? 45} onChange={v => onChange({ spread: v })} />
          <Slider label='Fade (°)' min={0} max={180} step={1} value={c.falloffHigh} onChange={v => onChange({ falloffHigh: v })} />
        </div>
      ) : (
        <RangeFalloffField min={c.min} max={c.max} falloffLow={c.falloffLow} falloffHigh={c.falloffHigh} domain={domain}
                           step={info.step} unit={info.unit} histogram={hist} invert={c.invert}
                           onChange={patch => onChange(patch)} />
      )}
    </div>
  );
}

const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** The selected surface's editor (the Parameters tab). */
export function SurfaceEditor({ surface, index, surfaces, onChange, fields, alphas }: {
  surface: SurfaceLayer; index: number; surfaces: SurfaceLayer[];
  onChange: (patch: Partial<SurfaceLayer>) => void;
  fields: PreviewFields | null; alphas: SurfaceAlphas | null;
}) {
  const base = index === 0;
  const setCondition = (id: string, patch: Partial<SurfaceCondition>) =>
    onChange({ conditions: surface.conditions.map(c => (c.id === id ? { ...c, ...patch } : c)) });
  const enabledFirst = surface.conditions.find(c => c.enabled)?.id;
  return (<>
    <Collapsable title='Surface' persistKey='cleo_creator_world_surface'>
      <label className='flex items-center gap-2 text-ui-sm text-muted'>Name
        <TextInput className='flex-1' value={surface.name} onChange={v => onChange({ name: v })} />
      </label>
      {base && <div className='text-ui-xs text-dim mt-1'>The base: it covers everywhere the surfaces above leave uncovered, so it has no conditions.</div>}
    </Collapsable>
    {!base && (
      <Collapsable title='Conditions' persistKey='cleo_creator_world_conditions' right={
        <Select value='' onChange={e => { const k = e.target.value as SurfaceInput; if (k) onChange({ conditions: [...surface.conditions, newCondition(k)] }); }}>
          <option value=''>+ Condition</option>
          {SURFACE_INPUTS.map(k => <option key={k} value={k} title={INPUT_INFO[k].hint}>{INPUT_INFO[k].label}</option>)}
        </Select>
      }>
        {!surface.conditions.length && <div className='text-ui-xs text-dim'>No conditions: the surface covers the whole map. Add one to place it.</div>}
        <div className='flex flex-col gap-1'>
          {surface.conditions.map(c => (
            <ConditionCard key={c.id} c={c} first={c.id === enabledFirst} surfaces={surfaces} index={index} fields={fields} alphas={alphas}
                           onChange={patch => setCondition(c.id, patch)}
                           onRemove={() => onChange({ conditions: surface.conditions.filter(x => x.id !== c.id) })} />
          ))}
        </div>
      </Collapsable>
    )}
    {!base && (
      <Collapsable title='Breakup' persistKey='cleo_creator_world_breakup'>
        <ParamForm schema={BREAKUP_SCHEMA} values={surface.breakup as unknown as Record<string, unknown>}
                   onChange={patch => onChange({ breakup: { ...surface.breakup, ...patch } })} />
      </Collapsable>
    )}
    {!base && (
      <Collapsable title='Post' persistKey='cleo_creator_world_post'>
        <ParamForm schema={POST_SCHEMA} values={surface.post as unknown as Record<string, unknown>}
                   onChange={patch => onChange({ post: { ...surface.post, ...patch } })} />
      </Collapsable>
    )}
    <Collapsable title='Preview only' persistKey='cleo_creator_world_preview_look'>
      <div className='text-ui-xs text-dim mb-1'>How the Creator shows this surface. Never exported: in the editor or any engine, you choose the material that stands for it.</div>
      <label className='flex items-center gap-2 text-ui-sm text-muted'>Material
        <Select className='flex-1' value={surface.preview.kind} onChange={e => {
          const kind = e.target.value as SurfaceKind;
          const k = surfaceKindInfo(kind);
          onChange({ preview: { ...surface.preview, kind, tiling: k.tiling, heightBlend: k.heightBlend } });
        }}>
          {SURFACE_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
        </Select>
      </label>
      <label className='flex items-center gap-2 text-ui-sm text-muted mt-1'>Tint
        <ColorInput color={rgbToHex(surface.preview.tint)} onChange={rgb => onChange({ preview: { ...surface.preview, tint: [rgb[0], rgb[1], rgb[2]] } })} />
      </label>
      <Slider label='Tiling (m)' min={0.5} max={40} step={0.5} value={surface.preview.tiling} onChange={v => onChange({ preview: { ...surface.preview, tiling: v } })} />
      <Slider label='Height blend' min={0} max={1} step={0.01} value={surface.preview.heightBlend} onChange={v => onChange({ preview: { ...surface.preview, heightBlend: v } })} />
    </Collapsable>
  </>);
}
