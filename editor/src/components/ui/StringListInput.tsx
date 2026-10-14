import { Button } from './Button';
import { TextInput } from './inputs';
import { cn } from './cn';

export interface StringListInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  /** What a new row starts as. */
  newItem?: string;
  className?: string;
}

/** An editable list of strings: one text row per entry, a ✕ per row and an Add button. */
export function StringListInput({ value, onChange, newItem = '', className }: StringListInputProps) {
  const set = (i: number, s: string) => onChange(value.map((v, k) => (k === i ? s : v)));
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {value.map((item, i) => (
        <div key={i} className='flex items-center gap-1'>
          <TextInput value={item} onChange={s => set(i, s)} />
          <Button variant='remove' size='sm' className='px-1 py-0 shrink-0' title='Remove entry'
            onClick={() => onChange(value.filter((_, k) => k !== i))}>✕</Button>
        </div>
      ))}
      <Button size='sm' className='self-start' onClick={() => onChange([...value, newItem])}>+ Add</Button>
    </div>
  );
}
