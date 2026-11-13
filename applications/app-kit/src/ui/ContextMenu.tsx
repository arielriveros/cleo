import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placeAnchored } from './anchoredPosition';
import { cn } from './cn';

export interface ContextMenuProps {
  /** Where the menu opens (the pointer, in client coordinates), or null when it is closed. */
  at: { x: number; y: number } | null;
  onClose: () => void;
  /** `MenuItem`s, or a function given `close` for entries that must close the menu themselves. */
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  className?: string;
}

/**
 * A right-click menu: a full-screen catcher that closes it on any click outside, and a panel at the pointer,
 * kept inside the viewport. The shape the editor's graph menus (MachineGraph's NodeMenu) were hand-rolled in,
 * made shared. Escape closes it too. Fill it with `MenuItem` rows.
 */
export function ContextMenu({ at, onClose, children, className }: ContextMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!at) { setPos(null); return; }
    const panel = panelRef.current;
    if (!panel) return;
    // A zero-size trigger at the pointer: the panel opens below-right of it, flipped and clamped to fit.
    const trigger = new DOMRect(at.x, at.y, 0, 0);
    setPos(placeAnchored(trigger, panel.getBoundingClientRect(), 'left', 'below'));
  }, [at]);

  useLayoutEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [at, onClose]);

  if (!at) return null;
  return createPortal(
    <>
      <div className='fixed inset-0 z-[60]' onPointerDown={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }} />
      <div ref={panelRef} role='menu'
        className={cn('fixed z-[61] min-w-[160px] rounded border border-border bg-surface-raised p-1 shadow-panel', className)}
        style={{ top: pos?.top ?? at.y, left: pos?.left ?? at.x, visibility: pos ? 'visible' : 'hidden' }}
        onContextMenu={e => e.preventDefault()}>
        {typeof children === 'function' ? children(onClose) : children}
      </div>
    </>,
    document.body,
  );
}
