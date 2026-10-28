import type { ExposureCurveKey } from 'cleo';
import { Button, DocHover, NumberInput, cn, labelClass, useDocEntry } from '../../components/ui';

export interface ExposureCurveEditorProps {
  value: ExposureCurveKey[];
  onChange: (value: ExposureCurveKey[]) => void;
  labelClassName?: string;
}

/**
 * The exposure compensation curve as a key list: one row per metered EV100 → stops pair, a ✕ per row
 * and an Add button. A list rather than a plot because the keys are few and their numbers are the point.
 */
export function ExposureCurveEditor({ value, onChange, labelClassName }: ExposureCurveEditorProps) {
  const entry = useDocEntry('Compensation curve', undefined, 'field');
  const set = (i: number, key: ExposureCurveKey) => onChange(value.map((k, j) => (j === i ? key : k)));
  const add = () => {
    const last = value[value.length - 1];
    onChange([...value, last ? [last[0] + 3, last[1]] : [4, 0]]);
  };
  return (
    <div className='flex flex-col gap-1 my-1'>
      <div className='flex items-center justify-between gap-2'>
        <DocHover entry={entry} affordance='field' className={cn(labelClass, 'shrink-0', labelClassName)}>
          Compensation curve
        </DocHover>
        <Button size='sm' onClick={add}>+ Key</Button>
      </div>
      {value.map(([ev, stops], i) => (
        <div key={i} className='flex items-center gap-1 text-ui'>
          <span className={cn(labelClass, 'shrink-0')}>EV</span>
          <NumberInput value={ev} step={0.5} title='Metered scene EV100'
            onChange={(v) => set(i, [v, stops])} />
          <span className={cn(labelClass, 'shrink-0')}>stops</span>
          <NumberInput value={stops} step={0.25} title='Compensation at that EV, in stops (positive is brighter)'
            onChange={(v) => set(i, [ev, v])} />
          <Button variant='remove' size='sm' className='px-1 py-0 shrink-0' title='Remove key'
            onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</Button>
        </div>
      ))}
    </div>
  );
}

export default ExposureCurveEditor;
