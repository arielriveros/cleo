import React, { useEffect, useRef, useState } from 'react';
import { cn } from './cn';

export interface PopoverProps {
  /** Visual content of the trigger (wrapped in a button by this component). */
  trigger: React.ReactNode;
  /** Panel content, or a render-fn receiving a `close()` callback. */
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  align?: 'left' | 'right';
  disabled?: boolean;
  title?: string;
  triggerClassName?: string;
  /** Classes for the floating panel. */
  className?: string;
}

/** Anchored, outside-click-dismiss floating panel. Foundation for the typed selects + texture picker. */
export function Popover({ trigger, children, align = 'left', disabled, title, triggerClassName, className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} className='relative inline-block'>
      <button
        type='button'
        disabled={disabled}
        title={title}
        aria-haspopup='true'
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          className={cn(
            'absolute top-full mt-1 z-50 rounded-md border border-border bg-surface-raised shadow-lg p-1',
            align === 'right' ? 'right-0' : 'left-0',
            className
          )}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

export default Popover;
