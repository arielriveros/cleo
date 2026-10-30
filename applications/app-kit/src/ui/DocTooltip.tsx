import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';
import { placeAnchored } from './anchoredPosition';
import { hintAffordance } from './typography';
import { getDocIndex } from '../docs/docIndex';
import { breadcrumb, plainText, type DocEntry } from '../docs/parseDocs';

// The hover card that shows a title's (or a field's) entry from the official docs: the term, its
// description with inline markup kept, any extra table columns, and where in the docs it lives. The text
// is never written here — it is whatever docs/**/*.md says today (features/docs).

const OPEN_DELAY_MS = 350;
const MAX_BODY_CHARS = 600;

/** Bold, italic, code spans and links (shown as accent text — the card is not interactive). */
export function renderInline(md: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const token = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]*\))|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let key = 0;
  const text = md.replace(/\\\|/g, '|');
  for (const m of text.matchAll(token)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [whole] = m;
    if (m[1]) out.push(<code key={key++} className='font-mono text-ui-xs px-0.5 rounded bg-surface-sunken text-fg'>{whole.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key++} className='font-semibold text-fg'>{renderInline(whole.slice(2, -2))}</strong>);
    else if (m[3]) out.push(<span key={key++} className='text-highlight'>{renderInline(whole.slice(1, whole.indexOf('](')))}</span>);
    else out.push(<em key={key++}>{renderInline(whole.slice(1, -1))}</em>);
    last = m.index! + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Whole sentences up to the cap, so a long section intro still reads as a summary, not a cut-off. */
export function capBody(md: string, max = MAX_BODY_CHARS): string {
  if (md.length <= max) return md;
  const sentences = md.split(/(?<=[.!?])\s+(?=[A-Z*`[(])/);
  let out = '';
  for (const s of sentences) {
    if (out && out.length + s.length + 1 > max) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out.length > max) {
    // One sentence longer than the cap: fall back to plain text so the cut cannot split a markup span.
    const plain = plainText(out);
    return plain.slice(0, plain.lastIndexOf(' ', max)) + ' …';
  }
  return out === md ? out : `${out} …`;
}

export interface DocTooltipHandle {
  /** Attach to the element the card anchors to. */
  ref: (el: HTMLElement | null) => void;
  /** Spread on the hovered element. */
  hoverProps: {
    onPointerEnter: (e: React.PointerEvent) => void;
    onPointerLeave: () => void;
    onPointerDown: () => void;
  };
  /** Open now (keyboard focus) / close now. */
  show: () => void;
  hide: () => void;
  /** The portalled card; render it anywhere beside the trigger. */
  card: React.ReactNode;
  describedBy?: string;
}

/** Hover / focus behaviour plus the card for one docs entry. With no entry every handler is inert. */
export function useDocTooltip(entry: DocEntry | null): DocTooltipHandle {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // A press closes the card; it stays closed until the pointer leaves, or a click would re-open it.
  const pressed = useRef(false);
  const id = useId();

  const clear = () => { if (timer.current !== undefined) { window.clearTimeout(timer.current); timer.current = undefined; } };
  const hide = useCallback(() => { clear(); setOpen(false); }, []);
  const show = useCallback(() => { clear(); if (entry) setOpen(true); }, [entry]);

  const hoverProps = {
    onPointerEnter: (e: React.PointerEvent) => {
      if (!entry || e.pointerType === 'touch' || pressed.current) return;
      clear();
      timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
    },
    onPointerLeave: () => { pressed.current = false; hide(); },
    onPointerDown: () => { pressed.current = true; hide(); },
  };

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (trigger && panel) setPos(placeAnchored(trigger.getBoundingClientRect(), panel.getBoundingClientRect()));
  }, [open, entry]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    // Any scroll moves the trigger out from under a card that does not follow it; closing is simpler.
    const onScroll = () => hide();
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', hide);
    };
  }, [open, hide]);

  useEffect(() => clear, []);
  useEffect(() => { if (!entry) setOpen(false); }, [entry]);

  const card = open && entry ? createPortal(
    <div
      ref={panelRef}
      id={id}
      role='tooltip'
      style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className='z-[1100] pointer-events-none w-max max-w-[320px] rounded-md border border-border bg-surface-raised shadow-lg px-2.5 py-2 text-ui-sm leading-snug text-muted whitespace-normal normal-case tracking-normal font-normal text-left'
    >
      <div className='text-ui font-semibold text-fg mb-1'>{entry.label}</div>
      <div>{renderInline(capBody(entry.body))}</div>
      {entry.meta.length > 0 && (
        <div className='mt-1.5 space-y-0.5'>
          {entry.meta.map(m => (
            <div key={m.label}><span className='text-dim'>{m.label}: </span>{renderInline(m.value)}</div>
          ))}
        </div>
      )}
      <div className='mt-1.5 pt-1 border-t border-border-subtle text-ui-xs text-dim'>{breadcrumb(getDocIndex(), entry)}</div>
    </div>,
    document.body,
  ) : null;

  return {
    ref: useCallback((el: HTMLElement | null) => { triggerRef.current = el; }, []),
    hoverProps,
    show,
    hide,
    card,
    describedBy: open && entry ? id : undefined,
  };
}

/** Every title has a card now, so its underline only appears under the pointer. */
export const docTitleAffordance = 'decoration-dotted underline-offset-2 hover:underline';

export interface DocHoverProps {
  entry: DocEntry | null;
  /** Native tooltip when the docs have no entry (a field's inline hint). */
  fallback?: string;
  /** `title`: underline on hover only. `field`: the dotted-underline hint affordance, always. */
  affordance?: 'title' | 'field';
  as?: 'span' | 'div' | 'td';
  className?: string;
  children: React.ReactNode;
}

/** An element that shows its docs card on hover, or its `fallback` as a native tooltip. */
export function DocHover({ entry, fallback, affordance = 'title', as = 'span', className, children }: DocHoverProps) {
  const tip = useDocTooltip(entry);
  const Tag = as as 'span';
  const mark = entry ? (affordance === 'title' ? docTitleAffordance : hintAffordance('docs')) : hintAffordance(fallback);
  return (
    <>
      <Tag
        ref={tip.ref}
        {...tip.hoverProps}
        title={entry ? undefined : fallback}
        aria-describedby={tip.describedBy}
        className={cn(className, mark)}
      >
        {children}
      </Tag>
      {tip.card}
    </>
  );
}

export default DocHover;
