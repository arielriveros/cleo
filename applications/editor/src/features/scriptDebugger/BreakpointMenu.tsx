import { useEffect, useRef, useState } from 'react';
import { ContextMenu } from '@cleo/app-kit/ui/ContextMenu';
import { MenuItem } from '@cleo/app-kit/ui/MenuItem';
import { TextInput } from '@cleo/app-kit/ui/inputs';
import { updateBreakpoints, upsertAt, useBreakpoints } from './breakpoints';

export interface BreakpointMenuTarget {
  moduleId: string;
  /** 1-based. */
  line: number;
  at: { x: number; y: number };
}

/**
 * The breakpoint margin's right-click menu: add a plain, conditional or log breakpoint on the line, or
 * edit, switch off and remove the one there. A condition or a log message is typed in place.
 */
export function BreakpointMenu({ target, onClose }: { target: BreakpointMenuTarget | null; onClose: () => void }) {
  const breakpoints = useBreakpoints();
  const [editing, setEditing] = useState<'condition' | 'log' | null>(null);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const existing = target ? breakpoints.find(b => b.moduleId === target.moduleId && b.line === target.line) : undefined;

  useEffect(() => { setEditing(null); }, [target]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (!target) return null;
  const { moduleId, line } = target;
  const close = () => { setEditing(null); onClose(); };
  const edit = (kind: 'condition' | 'log') => {
    setText(kind === 'condition' ? existing?.condition ?? '' : existing?.logMessage ?? '');
    setEditing(kind);
  };
  const commit = () => {
    const value = text.trim();
    updateBreakpoints(list => upsertAt(list, moduleId, line, editing === 'condition'
      ? { condition: value || undefined, logMessage: undefined, enabled: true }
      : { logMessage: value || undefined, condition: undefined, enabled: true }));
    close();
  };

  return (
    <ContextMenu at={target.at} onClose={close} className={editing ? 'w-[320px]' : undefined}>
      {editing ? (
        <div className='flex flex-col gap-1 p-1'>
          <span className='text-ui-sm text-dim'>
            {editing === 'condition'
              ? `Stop at line ${line} only when this is true:`
              : `Log at line ${line} (put an expression in {braces}); the game does not stop:`}
          </span>
          <TextInput
            ref={inputRef}
            value={text}
            onChange={setText}
            placeholder={editing === 'condition' ? 'hp <= 0' : 'hit {other.name} for {damage}'}
            className='font-mono'
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            }}
          />
        </div>
      ) : existing ? (
        <>
          <MenuItem onClick={() => { updateBreakpoints(list => list.filter(b => b.id !== existing.id)); close(); }}>
            Remove {existing.logMessage ? 'logpoint' : 'breakpoint'}
          </MenuItem>
          <MenuItem onClick={() => { updateBreakpoints(list => list.map(b => (b.id === existing.id ? { ...b, enabled: !b.enabled } : b))); close(); }}>
            {existing.enabled ? 'Disable' : 'Enable'} {existing.logMessage ? 'logpoint' : 'breakpoint'}
          </MenuItem>
          <MenuItem onClick={() => edit('condition')}>{existing.condition ? 'Edit condition…' : 'Add condition…'}</MenuItem>
          <MenuItem onClick={() => edit('log')}>{existing.logMessage ? 'Edit log message…' : 'Make it a logpoint…'}</MenuItem>
        </>
      ) : (
        <>
          <MenuItem onClick={() => { updateBreakpoints(list => upsertAt(list, moduleId, line, {})); close(); }}>Add breakpoint</MenuItem>
          <MenuItem onClick={() => edit('condition')} hint='Stops only when an expression is true'>Add conditional breakpoint…</MenuItem>
          <MenuItem onClick={() => edit('log')} hint='Logs a message and keeps playing'>Add logpoint…</MenuItem>
        </>
      )}
    </ContextMenu>
  );
}
