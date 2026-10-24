import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';
import { placeAnchored } from './anchoredPosition';

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
  /** Classes for the wrapper around the trigger (e.g. `w-full` for a full-width trigger). */
  rootClassName?: string;
}

/**
 * Anchored, outside-click-dismiss floating panel. Foundation for the typed selects + texture picker.
 *
 * The panel must stay portalled to <body> and positioned `fixed` against the trigger's viewport rect:
 * an absolute panel is clipped by any ancestor overflow (the inspector's scroll container,
 * Collapsable's `overflow-hidden`), and z-index cannot lift it out of a clip.
 */
export function Popover({ trigger, children, align = 'left', disabled, title, triggerClassName, className, rootClassName }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    setPos(placeAnchored(trigger.getBoundingClientRect(), panel.getBoundingClientRect(), align));
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
    <div className={cn('relative inline-block', rootClassName)}>
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
