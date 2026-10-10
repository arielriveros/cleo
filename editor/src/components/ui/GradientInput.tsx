import React, { useMemo, useRef, useState } from 'react';
import { evaluateGradient, type Gradient } from 'cleo';
import { Popover } from './Popover';
import { NumberInput } from './inputs';
import { Button } from './Button';
import { ColorInput } from './ColorInput';
import { Slider } from './Slider';
import { cn } from './cn';

export interface GradientInputProps {
  value: Gradient;
  onChange: (value: Gradient) => void;
  className?: string;
  title?: string;
}

const to255 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
const hex = (c: readonly number[]) => '#' + c.slice(0, 3).map(x => to255(x).toString(16).padStart(2, '0')).join('');

/** CSS `linear-gradient` stops for the gradient, sampled rather than keyed so it matches the bake. */
function cssOf(g: Gradient, withAlpha: boolean): string {
  const stops: string[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const c = evaluateGradient(g, t);
    stops.push(`rgba(${to255(c[0])},${to255(c[1])},${to255(c[2])},${withAlpha ? c[3].toFixed(3) : 1}) ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

const CHECKER = 'repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 10px 10px';

const PRESETS: { label: string; gradient: Gradient }[] = [
  { label: 'Fade', gradient: { color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }], alpha: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 0.7, a: 1 }, { t: 1, a: 0 }] } },
  { label: 'Fire', gradient: { color: [{ t: 0, c: [1, 0.95, 0.6] }, { t: 0.35, c: [1, 0.45, 0.1] }, { t: 0.7, c: [0.5, 0.08, 0.02] }, { t: 1, c: [0.1, 0.1, 0.1] }], alpha: [{ t: 0, a: 0 }, { t: 0.08, a: 1 }, { t: 0.6, a: 0.8 }, { t: 1, a: 0 }] } },
  { label: 'Smoke', gradient: { color: [{ t: 0, c: [0.6, 0.6, 0.6] }, { t: 1, c: [0.35, 0.35, 0.38] }], alpha: [{ t: 0, a: 0 }, { t: 0.2, a: 0.6 }, { t: 1, a: 0 }] } },
  { label: 'Magic', gradient: { color: [{ t: 0, c: [0.6, 0.9, 1] }, { t: 0.5, c: [0.5, 0.3, 1] }, { t: 1, c: [1, 0.3, 0.8] }], alpha: [{ t: 0, a: 1 }, { t: 0.8, a: 1 }, { t: 1, a: 0 }] } },
];

/**
 * A colour + alpha gradient over 0..1 — an inline bar that opens a stop editor. Colour stops sit under
 * the bar and alpha stops over it, keyed separately as in every DCC: click empty track to add, drag to
 * move, double-click to remove.
 */
export function GradientInput({ value, onChange, className, title }: GradientInputProps) {
  const bar = useMemo(() => cssOf(value, true), [value]);
  return (
    <Popover
      title={title ?? 'Edit gradient'}
      triggerClassName={cn('w-full', className)}
      className='p-2 w-[320px]'
      trigger={
        <span className='block h-7 w-full overflow-hidden rounded border border-border' style={{ background: CHECKER }}>
          <span className='block h-full w-full' style={{ background: bar }} />
        </span>
      }>
      <GradientEditor value={value} onChange={onChange} />
    </Popover>
  );
}

type Track = 'color' | 'alpha';

function GradientEditor({ value, onChange }: { value: Gradient; onChange: (g: Gradient) => void }) {
  const [selected, setSelected] = useState<{ track: Track; index: number } | null>(null);
  const colorRef = useRef<HTMLDivElement>(null);
  const alphaRef = useRef<HTMLDivElement>(null);

  const sorted = (g: Gradient): Gradient => ({
    color: [...g.color].sort((a, b) => a.t - b.t),
    alpha: [...g.alpha].sort((a, b) => a.t - b.t),
  });

  const tAt = (el: HTMLElement | null, clientX: number) => {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const add = (track: Track, e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const t = +tAt(e.currentTarget as HTMLElement, e.clientX).toFixed(3);
    const c = evaluateGradient(value, t);
    const next = track === 'color'
      ? { ...value, color: [...value.color, { t, c: [c[0], c[1], c[2]] as [number, number, number] }] }
      : { ...value, alpha: [...value.alpha, { t, a: c[3] }] };
    const s = sorted(next);
    onChange(s);
    const list = track === 'color' ? s.color : s.alpha;
    setSelected({ track, index: list.findIndex(k => k.t === t) });
  };

  const drag = (track: Track, index: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected({ track, index });
    const el = track === 'color' ? colorRef.current : alphaRef.current;
    const working: Gradient = { color: value.color.map(k => ({ ...k })), alpha: value.alpha.map(k => ({ ...k })) };
    const keysOf = (g: Gradient): { t: number }[] => (track === 'color' ? g.color : g.alpha);
    const key = keysOf(working)[index];
    const move = (ev: PointerEvent) => {
      key.t = +tAt(el, ev.clientX).toFixed(3);
      const s = sorted(working);
      setSelected({ track, index: keysOf(s).indexOf(key) });
      onChange(s);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const remove = (track: Track, index: number) => {
    const list = track === 'color' ? value.color : value.alpha;
    if (list.length <= 1) return;
    onChange(track === 'color'
      ? { ...value, color: value.color.filter((_, i) => i !== index) }
      : { ...value, alpha: value.alpha.filter((_, i) => i !== index) });
    setSelected(null);
  };

  const selColor = selected?.track === 'color' ? value.color[selected.index] : undefined;
  const selAlpha = selected?.track === 'alpha' ? value.alpha[selected.index] : undefined;

  const marker = (track: Track, t: number, index: number, fill: string) => (
    <div key={`${track}${index}`}
         className={cn('absolute -translate-x-1/2 h-4 w-3 cursor-grab rounded-sm border',
                       selected?.track === track && selected.index === index ? 'border-white' : 'border-black/60')}
         style={{ left: `${t * 100}%`, background: fill, top: 1 }}
         onPointerDown={e => drag(track, index, e)}
         onDoubleClick={() => remove(track, index)} />
  );

  return (
    <div className='flex flex-col gap-1'>
      <div ref={alphaRef} className='relative h-[18px] cursor-copy rounded bg-surface-raised' title='Alpha stops — click to add'
           onClick={e => add('alpha', e)}>
        {value.alpha.map((k, i) => marker('alpha', k.t, i, `rgb(${to255(k.a)},${to255(k.a)},${to255(k.a)})`))}
      </div>
      <div className='h-6 overflow-hidden rounded border border-border' style={{ background: CHECKER }}>
        <div className='h-full w-full' style={{ background: cssOf(value, true) }} />
      </div>
      <div ref={colorRef} className='relative h-[18px] cursor-copy rounded bg-surface-raised' title='Colour stops — click to add'
           onClick={e => add('color', e)}>
        {value.color.map((k, i) => marker('color', k.t, i, hex(k.c)))}
      </div>
      <div className='text-[10px] text-dim'>Click a track to add a stop · drag to move · double-click to remove</div>

      {selColor && (
        <div className='flex items-center gap-1 text-[11px] text-muted'>
          <ColorInput color={hex(selColor.c)} onChange={c => onChange({
            ...value, color: value.color.map((k, i) => (i === selected!.index ? { ...k, c } : k)),
          })} />
          <span>at</span>
          <NumberInput value={selColor.t} min={0} max={1} step={0.01}
                       onChange={t => onChange(sorted({ ...value, color: value.color.map((k, i) => (i === selected!.index ? { ...k, t: Math.min(1, Math.max(0, t)) } : k)) }))} />
        </div>
      )}
      {selAlpha && (
        <div className='flex items-center gap-1 text-[11px] text-muted'>
          <Slider min={0} max={1} step={0.01} value={selAlpha.a} label='Alpha'
                  onChange={a => onChange({ ...value, alpha: value.alpha.map((k, i) => (i === selected!.index ? { ...k, a } : k)) })} />
          <span>at</span>
          <div className='w-16'>
            <NumberInput value={selAlpha.t} min={0} max={1} step={0.01}
                         onChange={t => onChange(sorted({ ...value, alpha: value.alpha.map((k, i) => (i === selected!.index ? { ...k, t: Math.min(1, Math.max(0, t)) } : k)) }))} />
          </div>
        </div>
      )}
      <div className='mt-1 flex flex-wrap gap-1'>
        {PRESETS.map(p => (
          <Button key={p.label} size='sm' variant='subtle' onClick={() => { onChange(JSON.parse(JSON.stringify(p.gradient))); setSelected(null); }}>
            {p.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export default GradientInput;
