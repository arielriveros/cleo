import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';
import { placeAnchored } from './anchoredPosition';

// A desktop-style menu bar: File, Edit, View... titles that drop a menu each. The editor and Cleo Creator
// both draw theirs with it, so the two read the same. Click a title to open its menu; while one is open,
// pointing at another title switches to it, as a desktop menu bar does. Escape, a click outside or
// choosing an item closes it; the arrow keys walk the titles and the items, Enter or Space chooses.

/** One row of a menu. */
export type MenuEntry =
  | {
      kind: 'item';
      label: React.ReactNode;
      /** A 14-15 px glyph, drawn in the row's icon column. */
      icon?: React.ReactNode;
      /** The keys that do the same thing, shown right-aligned (display only: the app binds them itself). */
      shortcut?: string;
      disabled?: boolean;
      title?: string;
      /** A radio-style choice: checked rows show a dot in the icon column instead of the icon. */
      checked?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator' }
  | { kind: 'submenu'; label: React.ReactNode; icon?: React.ReactNode; disabled?: boolean; title?: string; items: MenuEntry[] };

export interface MenuSpec {
  id: string;
  label: string;
  items: MenuEntry[];
}

/** Whether a row can be pointed at and chosen (not a separator, not disabled). */
export function isSelectable(entry: MenuEntry | undefined): boolean {
  return !!entry && entry.kind !== 'separator' && !entry.disabled;
}

/**
 * The next selectable row from `from` in direction `dir` (1 down, -1 up), wrapping round the menu, or -1
 * when nothing in it can be chosen. `from` -1 with `dir` 1 finds the first, with `dir` -1 the last.
 */
export function nextSelectable(items: readonly MenuEntry[], from: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = from < 0 && step === 0 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n;
    if (isSelectable(items[i])) return i;
  }
  return -1;
}

const ROW = 'flex w-full items-center gap-2 rounded px-2 h-[24px] text-left text-ui whitespace-nowrap outline-none';

/** The icon column: the glyph, a radio dot, or nothing (the column keeps every label aligned). */
function IconCell({ entry }: { entry: Extract<MenuEntry, { kind: 'item' | 'submenu' }> }) {
  if (entry.kind === 'item' && entry.checked !== undefined) {
    return <span className='flex w-4 shrink-0 items-center justify-center'>
      {entry.checked && <span className='h-1.5 w-1.5 rounded-full bg-current' />}
    </span>;
  }
  return <span className='flex w-4 shrink-0 items-center justify-center [&>svg]:h-[14px] [&>svg]:w-[14px]'>{entry.icon}</span>;
}

interface PanelProps {
  items: MenuEntry[];
  anchor: DOMRect;
  /** 'below' a title, or 'right' of a submenu row. */
  placement: 'below' | 'right';
  active: number;
  onActive: (index: number) => void;
  onChoose: (entry: MenuEntry, index: number) => void;
  /** The submenu open under row `active`, if any. */
  sub: { items: MenuEntry[]; active: number; onActive: (i: number) => void; anchor: DOMRect | null } | null;
  onRowRect: (index: number, rect: DOMRect) => void;
  panelRef: (el: HTMLDivElement | null) => void;
  subPanelRef: (el: HTMLDivElement | null) => void;
  label: string;
}

function MenuPanel({ items, anchor, placement, active, onActive, onChoose, sub, onRowRect, panelRef, subPanelRef, label }: PanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (placement === 'below') {
      setPos(placeAnchored(anchor, rect, 'left', 'below'));
    } else {
      // Beside the row, flipped to its left when the screen ends first.
      const fitsRight = anchor.right + rect.width <= window.innerWidth - 8;
      const left = fitsRight ? anchor.right - 2 : Math.max(8, anchor.left - rect.width + 2);
      const top = Math.min(anchor.top - 4, Math.max(8, window.innerHeight - rect.height - 8));
      setPos({ top, left });
    }
  }, [anchor, placement, items.length]);

  return (
    <div
      ref={el => { ref.current = el; panelRef(el); }}
      role='menu'
      aria-label={label}
      data-cleo-overlay
      style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className='z-[1000] min-w-[220px] rounded-md border border-control-hover bg-surface-raised p-1 text-fg shadow-lg'
      onMouseDown={e => e.preventDefault()}
    >
      {items.map((entry, i) => {
        if (entry.kind === 'separator') return <div key={i} role='separator' className='my-1 h-px bg-border-subtle' />;
        const enabled = !entry.disabled;
        const isActive = i === active && enabled;
        return (
          <button
            key={i}
            type='button'
            role={entry.kind === 'item' && entry.checked !== undefined ? 'menuitemradio' : 'menuitem'}
            aria-checked={entry.kind === 'item' && entry.checked !== undefined ? entry.checked : undefined}
            aria-haspopup={entry.kind === 'submenu' ? 'menu' : undefined}
            aria-disabled={!enabled || undefined}
            disabled={!enabled}
            title={entry.title}
            ref={el => { if (el && entry.kind === 'submenu' && i === active) onRowRect(i, el.getBoundingClientRect()); }}
            onMouseEnter={e => { if (enabled) { onActive(i); if (entry.kind === 'submenu') onRowRect(i, e.currentTarget.getBoundingClientRect()); } }}
            onClick={() => { if (enabled) onChoose(entry, i); }}
            className={cn(ROW, enabled ? 'cursor-pointer' : 'cursor-default text-dim', isActive && 'bg-control')}
          >
            <IconCell entry={entry} />
            <span className='min-w-0 flex-1 truncate'>{entry.label}</span>
            {entry.kind === 'item' && entry.shortcut && <span className='pl-6 text-ui-xs text-muted'>{entry.shortcut}</span>}
            {entry.kind === 'submenu' && (
              <svg viewBox='0 0 24 24' className='h-3 w-3 text-muted' fill='none' stroke='currentColor' strokeWidth='2'
                   strokeLinecap='round' strokeLinejoin='round' aria-hidden><path d='m9 6 6 6-6 6' /></svg>
            )}
          </button>
        );
      })}
      {sub && sub.anchor && (
        <MenuPanel
          items={sub.items} anchor={sub.anchor} placement='right' active={sub.active} onActive={sub.onActive}
          onChoose={(entry, i) => onChoose(entry, i + 10000)} sub={null} onRowRect={() => {}}
          panelRef={subPanelRef} subPanelRef={() => {}} label={label}
        />
      )}
    </div>
  );
}

export interface AppMenuBarProps {
  menus: MenuSpec[];
  className?: string;
}

/** A row of menu titles, each dropping its menu. See the module comment. */
export function AppMenuBar({ menus, className }: AppMenuBarProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  const [subOpen, setSubOpen] = useState(false);
  const [subActive, setSubActive] = useState(-1);
  const [subAnchor, setSubAnchor] = useState<DOMRect | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const titleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelEl = useRef<HTMLDivElement | null>(null);
  const subPanelEl = useRef<HTMLDivElement | null>(null);

  const items = open !== null ? menus[open]?.items ?? [] : [];
  const activeEntry = items[active];
  const subItems = activeEntry?.kind === 'submenu' && !activeEntry.disabled ? activeEntry.items : null;

  const close = useCallback(() => { setOpen(null); setActive(-1); setSubOpen(false); setSubActive(-1); }, []);

  const openMenu = useCallback((index: number, focusFirst: boolean) => {
    const el = titleRefs.current[index];
    if (!el) return;
    setAnchor(el.getBoundingClientRect());
    setOpen(index);
    setSubOpen(false);
    setSubActive(-1);
    setActive(focusFirst ? nextSelectable(menus[index].items, -1, 1) : -1);
  }, [menus]);

  const choose = useCallback((entry: MenuEntry, index: number) => {
    if (entry.kind === 'submenu') {
      setActive(index);
      setSubOpen(true);
      setSubActive(nextSelectable(entry.items, -1, 1));
      return;
    }
    if (entry.kind !== 'item' || entry.disabled) return;
    close();
    // After closing, in the same event: a file picker opened from here still has the user's activation.
    entry.onSelect();
  }, [close]);

  // A click anywhere but the bar and its menus closes the open menu.
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (barRef.current?.contains(t) || panelEl.current?.contains(t) || subPanelEl.current?.contains(t)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onResize);
    };
  }, [open, close]);

  // The keyboard while a menu is open. Capture phase, so nothing under the menu acts on these keys too.
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      const inSub = subOpen && !!subItems;
      const list = inSub ? subItems! : items;
      const idx = inSub ? subActive : active;
      let handled = true;
      switch (e.key) {
        case 'Escape':
          if (inSub) setSubOpen(false); else close();
          break;
        case 'ArrowDown':
        case 'ArrowUp': {
          const next = nextSelectable(list, idx, e.key === 'ArrowDown' ? 1 : -1);
          if (inSub) setSubActive(next); else { setActive(next); setSubOpen(false); }
          break;
        }
        case 'ArrowRight':
          if (!inSub && activeEntry?.kind === 'submenu' && !activeEntry.disabled) choose(activeEntry, active);
          else openMenu((open + 1) % menus.length, true);
          break;
        case 'ArrowLeft':
          if (inSub) setSubOpen(false);
          else openMenu((open - 1 + menus.length) % menus.length, true);
          break;
        case 'Enter':
        case ' ': {
          const entry = list[idx];
          if (entry) choose(entry, idx);
          break;
        }
        default:
          handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, items, active, subOpen, subActive, subItems, activeEntry, menus.length, choose, close, openMenu]);

  const onChoose = (entry: MenuEntry, index: number) => {
    // Rows of the submenu arrive offset (see MenuPanel), so the two lists never share an index.
    if (index >= 10000) { choose(entry, index - 10000); return; }
    choose(entry, index);
  };

  return (
    <div ref={barRef} role='menubar' className={cn('flex h-full items-center', className)}>
      {menus.map((menu, i) => (
        <button
          key={menu.id}
          ref={el => { titleRefs.current[i] = el; }}
          type='button'
          role='menuitem'
          aria-haspopup='menu'
          aria-expanded={open === i}
          onMouseDown={e => { e.preventDefault(); if (open === i) close(); else openMenu(i, false); }}
          onMouseEnter={() => { if (open !== null && open !== i) openMenu(i, false); }}
          onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') && open === null) { e.preventDefault(); openMenu(i, true); } }}
          className={cn('h-[25px] rounded px-2 text-ui text-fg outline-none hover:bg-control/70 focus-visible:bg-control/70',
            open === i && 'bg-control')}
        >
          {menu.label}
        </button>
      ))}
      {open !== null && anchor && createPortal(
        <MenuPanel
          items={items} anchor={anchor} placement='below' active={active}
          onActive={i => { setActive(i); const e = items[i]; setSubOpen(e?.kind === 'submenu' && !e.disabled); setSubActive(-1); }}
          onChoose={onChoose}
          sub={subOpen && subItems ? { items: subItems, active: subActive, onActive: setSubActive, anchor: subAnchor } : null}
          onRowRect={(i, rect) => { if (i === active || items[i]?.kind === 'submenu') setSubAnchor(prev => (prev && prev.top === rect.top && prev.left === rect.left ? prev : rect)); }}
          panelRef={el => { panelEl.current = el; }}
          subPanelRef={el => { subPanelEl.current = el; }}
          label={menus[open].label}
        />,
        document.body,
      )}
    </div>
  );
}

export default AppMenuBar;
