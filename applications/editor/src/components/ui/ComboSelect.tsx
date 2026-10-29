import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from './cn';
import { Popover } from './Popover';
import { controlClass } from './inputs';

export interface ComboChoice {
  value: string;
  /** Header the choice is listed under (e.g. the rig a clip belongs to). Choices keep their given order. */
  group?: string;
}

export interface ComboSelectProps {
  value: string;
  choices: readonly ComboChoice[];
  onChange: (value: string) => void;
  /** What the list holds, for the filter placeholder and tooltips ("clip", "sound cue"). */
  noun?: string;
  /** Offer "(none)" to clear the value. */
  allowEmpty?: boolean;
  /** Accept a typed value that is not in the list (the list may not see everything valid at runtime). */
  allowCustom?: boolean;
  title?: string;
  className?: string;
}

type Row = { kind: 'header'; label: string } | { kind: 'item'; value: string; label: string; custom?: boolean };

/**
 * A searchable dropdown over a (possibly grouped) list of names. Collapsed it reads like a select; open, it
 * shows a filter box over the list, navigable with the arrow keys. A current value missing from the list is
 * kept and flagged rather than silently replaced.
 */
export function ComboSelect({
  value, choices, onChange, noun = 'value', allowEmpty = true, allowCustom = true, title, className,
}: ComboSelectProps) {
  const known = useMemo(() => new Set(choices.map(c => c.value)), [choices]);
  const missing = !!value && !known.has(value);
  return (
    <Popover
      rootClassName='w-full min-w-0'
      triggerClassName={cn(controlClass, 'w-full min-w-0 flex items-center gap-1 text-left hover:bg-control-hover', className)}
      title={missing ? `"${value}" is not a known ${noun} here` : title}
      className='p-0'
      trigger={
        <>
          <span className={cn('flex-1 min-w-0 truncate', !value && 'text-dim', missing && 'text-warning')}>
            {value || '(none)'}
          </span>
          {missing && <span className='text-warning text-ui-2xs shrink-0' aria-label='not in list'>⚠</span>}
          <span className='text-ui-2xs text-muted shrink-0'>▼</span>
        </>
      }
    >
      {close => (
        <ComboPanel value={value} choices={choices} noun={noun} allowEmpty={allowEmpty} allowCustom={allowCustom}
          onPick={v => { onChange(v); close(); }} />
      )}
    </Popover>
  );
}

function ComboPanel({ value, choices, noun, allowEmpty, allowCustom, onPick }: {
  value: string; choices: readonly ComboChoice[]; noun: string; allowEmpty: boolean; allowCustom: boolean;
  onPick: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Row[] = [];
    if (allowEmpty && !q) out.push({ kind: 'item', value: '', label: '(none)' });
    let lastGroup: string | undefined;
    for (const c of choices) {
      if (q && !c.value.toLowerCase().includes(q)) continue;
      if (c.group && c.group !== lastGroup) out.push({ kind: 'header', label: c.group });
      lastGroup = c.group;
      out.push({ kind: 'item', value: c.value, label: c.value });
    }
    const typed = query.trim();
    if (allowCustom && typed && !choices.some(c => c.value === typed))
      out.push({ kind: 'item', value: typed, label: `Use "${typed}"`, custom: true });
    return out;
  }, [query, choices, allowEmpty, allowCustom]);

  const items = rows.flatMap((r, i) => (r.kind === 'item' ? [i] : []));
  // Start on the current value; after typing, on the first match.
  useEffect(() => {
    const cur = rows.findIndex(r => r.kind === 'item' && r.value === value);
    setActive(query || cur < 0 ? 0 : items.indexOf(cur));
  }, [rows]);
  const activeRow = items[active];
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${activeRow}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeRow]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeRow];
      if (row?.kind === 'item') onPick(row.value);
    }
  };

  return (
    <div className='w-[260px] max-w-[80vw] flex flex-col'>
      <input
        ref={inputRef}
        type='text'
        value={query}
        placeholder={`Filter ${noun}s…`}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={onKey}
        className={cn(controlClass, 'm-1 mb-0')}
      />
      <div ref={listRef} className='max-h-[280px] overflow-y-auto p-1'>
        {rows.map((r, i) => r.kind === 'header'
          ? <div key={`h${i}`} className='px-2 pt-1.5 pb-0.5 text-ui-2xs uppercase tracking-wide text-dim truncate'>{r.label}</div>
          : (
            <button
              key={`i${i}`}
              type='button'
              data-row={i}
              onMouseEnter={() => setActive(items.indexOf(i))}
              onClick={() => onPick(r.value)}
              className={cn(
                'w-full flex items-center px-2 py-1 rounded text-ui text-left truncate transition-colors',
                i === activeRow && 'bg-control',
                r.value === value && !r.custom && 'text-primary',
                (r.custom || !r.value) && 'text-dim italic',
              )}
            >
              <span className='truncate'>{r.label}</span>
            </button>
          ))}
        {!rows.length && <div className='px-2 py-1 text-ui-sm text-dim'>No {noun}s here.</div>}
      </div>
    </div>
  );
}

export default ComboSelect;
