import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

/** Distance between the trigger and the panel, and the closest the panel may sit to a viewport edge. */
const GAP = 4;
const MARGIN = 8;

/**
 * Anchored, outside-click-dismiss floating panel. Foundation for the typed selects + texture picker.
 *
 * The panel is portalled to <body> and positioned as `fixed` against the trigger's viewport rect, rather
 * than absolutely inside the trigger. It has to be: an absolute panel is clipped by any ancestor that
 * establishes an overflow — the inspector's scroll container, and Collapsable's `overflow-hidden` (which
 * that section needs for its collapse animation) — and no z-index can lift it out, because clipping is not
 * a stacking-order problem. Portalling escapes both.
 */
export function Popover({ trigger, children, align = 'left', disabled, title, triggerClassName, className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const t = trigger.getBoundingClientRect();
    const p = panel.getBoundingClientRect();

    // Open downwards, but flip above the trigger when the panel would run off the bottom of the viewport
    // and there is room above — the variables rows sit at the bottom of their section, so this is the
    // common case rather than the edge case.
    let top = t.bottom + GAP;
    if (top + p.height > window.innerHeight - MARGIN && t.top - GAP - p.height >= MARGIN)
      top = t.top - GAP - p.height;

    let left = align === 'right' ? t.right - p.width : t.left;
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, window.innerWidth - p.width - MARGIN));

    setPos({ top, left });
  }, [align]);

  // Measure after the panel is in the DOM but before paint, so it never shows at the wrong spot.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is portalled, so it is not a DOM descendant of the trigger: both need checking.
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Capture, so scrolling any ancestor container (not just the window) keeps the panel anchored.
    const onReflow = () => place();

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, place]);

  return (
    <div className='relative inline-block'>
      <button
        ref={triggerRef}
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
      {open && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            // Hidden for the one frame between mounting (so it can be measured) and being placed.
            visibility: pos ? 'visible' : 'hidden',
          }}
          className={cn(
            'z-[1000] rounded-md border border-border bg-surface-raised shadow-lg p-1',
            className
          )}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>,
        document.body
      )}
    </div>
  );
}

export default Popover;
