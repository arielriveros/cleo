import { NumberInput } from './inputs';
import { cn } from './cn';

export interface RangeInputProps {
  /** [min, max]: each particle picks uniformly between them. */
  value: [number, number];
  onChange: (value: [number, number]) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}

/**
 * A random range: two numbers, picked between per particle. Equal ends mean a constant, which is why
 * there is no separate constant mode — typing the same number twice is that mode.
 */
export function RangeInput({ value, onChange, min, max, step = 0.1, className }: RangeInputProps) {
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <NumberInput value={value[0]} min={min} max={max} step={step} title='Minimum'
                   onChange={v => onChange([clamp(v), Math.max(clamp(v), value[1])])} />
      <span className='text-dim text-ui-sm'>–</span>
      <NumberInput value={value[1]} min={min} max={max} step={step} title='Maximum'
                   onChange={v => onChange([Math.min(value[0], clamp(v)), clamp(v)])} />
    </div>
  );
}

export default RangeInput;
