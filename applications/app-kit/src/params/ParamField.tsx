import type { Curve, Gradient, ParamSpec } from 'cleo';
import { ColorInput, CurveInput, GradientInput, NumberInput, RangeInput, Select, Slider, Toggle, VectorInput } from '../ui';

/**
 * The parameter kinds any Cleo tool can draw with no knowledge of the app around it. The engine's
 * `ParamSpec` union also has kinds that reach into an application's own state (an asset picker, a
 * sibling emitter, custom shader code); those stay with the app, which draws them itself and hands
 * everything else here.
 */
export type GenericParamKind = 'float' | 'int' | 'bool' | 'vec3' | 'range' | 'color' | 'curve' | 'gradient' | 'enum';
export type GenericParamSpec = Extract<ParamSpec, { kind: GenericParamKind }>;

const GENERIC_KINDS: ReadonlySet<string> = new Set<GenericParamKind>(['float', 'int', 'bool', 'vec3', 'range', 'color', 'curve', 'gradient', 'enum']);

export function isGenericParam(spec: ParamSpec): spec is GenericParamSpec {
  return GENERIC_KINDS.has(spec.kind);
}

export interface GenericParamFieldProps {
  spec: GenericParamSpec;
  value: unknown;
  /** `coalesce` true for a continuous gesture (a slider drag) -- one undo step for the whole drag. */
  onChange: (value: unknown, coalesce?: boolean) => void;
}

const num = (x: unknown, fallback = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const arr = (x: unknown, n: number, fallback = 0): number[] =>
  Array.from({ length: n }, (_, i) => (Array.isArray(x) ? num(x[i], fallback) : fallback));

const hexByte = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');
/** Linear 0..1 rgb -> `#rrggbb`, which is what a colour input takes. */
export const rgbToHex = (rgb: readonly number[]) => `#${hexByte(rgb[0] ?? 0)}${hexByte(rgb[1] ?? 0)}${hexByte(rgb[2] ?? 0)}`;

/** One parameter, drawn from its spec. */
export function GenericParamField({ spec, value, onChange }: GenericParamFieldProps) {
  switch (spec.kind) {
    case 'float':
      if (spec.min !== undefined && spec.max !== undefined)
        return <Slider min={spec.min} max={spec.max} step={spec.step ?? 0.01} value={num(value)} onChange={v => onChange(v, true)} />;
      if (spec.readout) {
        return (
          <div className='flex flex-col gap-0.5'>
            <NumberInput value={num(value)} min={spec.min} max={spec.max} step={spec.step ?? 0.1} onChange={v => onChange(v, true)} />
            <span className='text-ui-xs text-dim tabular-nums'>{spec.readout(num(value))}</span>
          </div>
        );
      }
      return <NumberInput value={num(value)} min={spec.min} max={spec.max} step={spec.step ?? 0.1} onChange={v => onChange(v, true)} />;
    case 'int':
      return <NumberInput value={num(value)} min={spec.min} max={spec.max} step={1} onChange={v => onChange(Math.round(v), true)} />;
    case 'bool':
      return <Toggle checked={!!value} onChange={v => onChange(v)} />;
    case 'vec3': {
      // A vec3 spec may carry four components (custom code's u_custom); keep whatever length is there.
      const n = Array.isArray(value) ? Math.max(3, value.length) : 3;
      return <VectorInput value={arr(value, n)} step={0.1} onChange={v => onChange(v, true)} />;
    }
    case 'range':
      return <RangeInput value={arr(value, 2) as [number, number]} min={spec.min} max={spec.max} step={spec.step ?? 0.1}
                         onChange={v => onChange(v, true)} />;
    case 'color': {
      const c = arr(value, 4, 1);
      return (
        <div className='flex items-center gap-2'>
          <ColorInput color={rgbToHex(c)} onChange={rgb => onChange([rgb[0], rgb[1], rgb[2], c[3]])} />
          <Slider min={0} max={1} step={0.01} value={c[3]} label='A' onChange={a => onChange([c[0], c[1], c[2], a], true)} />
        </div>
      );
    }
    case 'curve':
      return <CurveInput value={value as Curve} onChange={v => onChange(v, true)} />;
    case 'gradient':
      return <GradientInput value={value as Gradient} onChange={v => onChange(v, true)} />;
    case 'enum':
      return (
        <Select value={String(value)} onChange={e => onChange(e.target.value)} className='w-full'>
          {spec.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      );
  }
}
