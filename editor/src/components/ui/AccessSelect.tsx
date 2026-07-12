import React from 'react';
import { cn } from './cn';
import { Popover } from './Popover';

const LockIcon = () => (
  <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
    <rect x='4' y='11' width='16' height='9' rx='2' /><path d='M8 11V7a4 4 0 0 1 8 0v4' />
  </svg>
);
const GlobeIcon = () => (
  <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
    <circle cx='12' cy='12' r='9' /><path d='M3 12h18' /><path d='M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18' />
  </svg>
);
const ShieldIcon = () => (
  <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z' />
  </svg>
);

export interface AccessMeta { label: string; icon: React.ReactNode; color: string; }

export const ACCESS_META: Record<string, AccessMeta> = {
  public:    { label: 'Public',    icon: <GlobeIcon />,  color: 'rgb(var(--success))' },
  private:   { label: 'Private',   icon: <LockIcon />,   color: 'rgb(var(--axis-x))' },
  protected: { label: 'Protected', icon: <ShieldIcon />, color: 'rgb(var(--warning))' },
};

const accessMeta = (v: string): AccessMeta => ACCESS_META[v] ?? { label: v, icon: <GlobeIcon />, color: 'rgb(var(--muted))' };

export interface AccessSelectProps {
  value: string;
  onChange: (value: string) => void;
  options?: readonly string[];
  disabled?: boolean;
  className?: string;
}

/**
 * Access-level selector (public/private/protected) shown as icons. Collapsed it shows the current
 * access icon; open, it lists each level as icon + label. Mirrors TypeSelect's dot pattern.
 */
export function AccessSelect({ value, onChange, options = ['public', 'private', 'protected'], disabled, className }: AccessSelectProps) {
  const cur = accessMeta(value);
  return (
    <Popover
      disabled={disabled}
      title={`Access: ${cur.label}`}
      triggerClassName={cn(
        'inline-flex items-center gap-1 rounded border border-border bg-control px-1.5 py-1 hover:bg-control-hover disabled:opacity-60 transition-colors',
        className
      )}
      trigger={<><span style={{ color: cur.color }}>{cur.icon}</span><span className='text-[9px] text-muted'>▼</span></>}
    >
      {(close) => (
        <div className='min-w-[132px] flex flex-col'>
          {options.map((opt) => {
            const m = accessMeta(opt);
            return (
              <button
                key={opt}
                type='button'
                onClick={() => { onChange(opt); close(); }}
                className={cn('flex items-center gap-2 px-2 py-1 rounded text-xs text-left hover:bg-control transition-colors', opt === value && 'bg-control')}
              >
                <span style={{ color: m.color }}>{m.icon}</span>
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

export default AccessSelect;
